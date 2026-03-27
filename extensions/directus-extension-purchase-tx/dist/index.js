const SOURCE = 'directus-extension-purchase-tx';

const toNumber = (value, fallback = NaN) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toPositiveNumber = (value, fallback = NaN) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeOrderItems = (items) => {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => ({
      product_id: toPositiveNumber(item?.product_id),
      qty_requested: toPositiveNumber(item?.qty_requested),
      unit_cost: item?.unit_cost == null ? null : toNumber(item.unit_cost, 0),
      line_notes: item?.line_notes ?? null,
      set_as_default_supplier: Boolean(item?.set_as_default_supplier),
    }))
    .filter((item) => Number.isFinite(item.product_id) && Number.isFinite(item.qty_requested));
};

const normalizeReceipts = (receipts) => {
  if (!Array.isArray(receipts)) return [];

  return receipts
    .map((row) => ({
      purchase_order_item_id: row?.purchase_order_item_id == null ? null : toPositiveNumber(row.purchase_order_item_id),
      product_id: row?.product_id == null ? null : toPositiveNumber(row.product_id),
      qty_received: toPositiveNumber(row?.qty_received),
      notes: row?.notes ?? null,
    }))
    .filter((row) => Number.isFinite(row.qty_received));
};

const ensureAuthenticated = (req, res, route) => {
  const userId = req.accountability?.user;
  if (!userId) {
    res.status(401).json({
      ok: false,
      source: SOURCE,
      route,
      error: 'Unauthorized',
    });
    return null;
  }

  return userId;
};

const setDefaultSupplierForProduct = async (trx, productId, supplierId, nowValue) => {
  await trx('product_suppliers')
    .where({ product_id: productId })
    .update({ is_default: false, date_updated: nowValue });

  await trx('product_suppliers')
    .insert({
      product_id: productId,
      supplier_id: supplierId,
      is_default: true,
      last_ordered_at: nowValue,
      date_created: nowValue,
      date_updated: nowValue,
    })
    .onConflict(['product_id', 'supplier_id'])
    .merge({
      is_default: true,
      last_ordered_at: nowValue,
      date_updated: nowValue,
    });
};

export default {
  id: 'purchase-tx',
  handler: (router, { database }) => {
    router.post('/create-order', async (req, res, next) => {
      const route = '/purchase-tx/create-order';
      const userId = ensureAuthenticated(req, res, route);
      if (!userId) return;

      const payload = req.body ?? {};
      const branchId = payload.branch_id == null ? null : toNumber(payload.branch_id, NaN);
      const supplierId = toPositiveNumber(payload.supplier_id);
      const expectedAt = payload.expected_at ?? null;
      const notes = payload.notes ?? null;
      const normalizedItems = normalizeOrderItems(payload.items);

      if (!Number.isFinite(supplierId)) {
        return res.status(400).json({
          ok: false,
          source: SOURCE,
          route,
          error: 'supplier_id is required.',
        });
      }

      if (branchId != null && !Number.isFinite(branchId)) {
        return res.status(400).json({
          ok: false,
          source: SOURCE,
          route,
          error: 'branch_id is invalid.',
        });
      }

      if (normalizedItems.length === 0) {
        return res.status(400).json({
          ok: false,
          source: SOURCE,
          route,
          error: 'items is required and must contain valid rows.',
        });
      }

      try {
        const result = await database.transaction(async (trx) => {
          const nowValue = trx.fn.now();

          const [createdOrder] = await trx('purchase_orders')
            .insert({
              branch_id: branchId,
              supplier_id: supplierId,
              status: 'draft',
              requested_at: nowValue,
              expected_at: expectedAt,
              notes,
              requested_by: userId,
              date_created: nowValue,
              date_updated: nowValue,
            })
            .returning('*');

          const insertItemsPayload = normalizedItems.map((item) => ({
            purchase_order_id: createdOrder.id,
            product_id: item.product_id,
            qty_requested: item.qty_requested,
            qty_received: 0,
            unit_cost: item.unit_cost,
            line_notes: item.line_notes,
            date_created: nowValue,
            date_updated: nowValue,
          }));

          const createdItems = await trx('purchase_order_items').insert(insertItemsPayload).returning('*');

          const byProduct = new Map();
          for (const item of normalizedItems) {
            const previous = byProduct.get(item.product_id);
            if (!previous) {
              byProduct.set(item.product_id, item);
              continue;
            }

            byProduct.set(item.product_id, {
              ...previous,
              set_as_default_supplier: previous.set_as_default_supplier || item.set_as_default_supplier,
            });
          }

          for (const [productId, item] of byProduct.entries()) {
            if (item.set_as_default_supplier) {
              await setDefaultSupplierForProduct(trx, productId, supplierId, nowValue);
            } else {
              await trx('product_suppliers')
                .insert({
                  product_id: productId,
                  supplier_id: supplierId,
                  is_default: false,
                  last_ordered_at: nowValue,
                  date_created: nowValue,
                  date_updated: nowValue,
                })
                .onConflict(['product_id', 'supplier_id'])
                .merge({
                  last_ordered_at: nowValue,
                  date_updated: nowValue,
                });
            }

            await trx('products')
              .where({ id: productId })
              .update({
                last_order_date: trx.raw('CURRENT_DATE'),
                updated_at: nowValue,
              });
          }

          return {
            ...createdOrder,
            items: createdItems,
          };
        });

        return res.status(200).json({
          ok: true,
          source: SOURCE,
          route,
          data: result,
        });
      } catch (error) {
        return next(error);
      }
    });

    router.post('/receive', async (req, res, next) => {
      const route = '/purchase-tx/receive';
      const userId = ensureAuthenticated(req, res, route);
      if (!userId) return;

      const payload = req.body ?? {};
      const purchaseOrderId = toPositiveNumber(payload.purchase_order_id);
      const inputBranchId = payload.branch_id == null ? null : toNumber(payload.branch_id, NaN);
      const receiptNotes = payload.notes ?? null;
      const normalizedReceipts = normalizeReceipts(payload.receipts);

      if (!Number.isFinite(purchaseOrderId)) {
        return res.status(400).json({
          ok: false,
          source: SOURCE,
          route,
          error: 'purchase_order_id is required.',
        });
      }

      if (inputBranchId != null && !Number.isFinite(inputBranchId)) {
        return res.status(400).json({
          ok: false,
          source: SOURCE,
          route,
          error: 'branch_id is invalid.',
        });
      }

      if (normalizedReceipts.length === 0) {
        return res.status(400).json({
          ok: false,
          source: SOURCE,
          route,
          error: 'receipts is required and must contain valid rows.',
        });
      }

      try {
        const result = await database.transaction(async (trx) => {
          const nowValue = trx.fn.now();

          const order = await trx('purchase_orders')
            .where({ id: purchaseOrderId })
            .first()
            .forUpdate();

          if (!order) {
            throw new Error(`Purchase order ${purchaseOrderId} not found.`);
          }

          const branchId = inputBranchId ?? toNumber(order.branch_id, NaN);
          if (!Number.isFinite(branchId)) {
            throw new Error('A valid branch_id is required to receive stock.');
          }

          const touchedProducts = new Set();
          const updatedLines = [];

          for (const row of normalizedReceipts) {
            let lineQuery = trx('purchase_order_items')
              .where({ purchase_order_id: purchaseOrderId })
              .forUpdate();

            if (Number.isFinite(row.purchase_order_item_id)) {
              lineQuery = lineQuery.andWhere({ id: row.purchase_order_item_id });
            } else if (Number.isFinite(row.product_id)) {
              lineQuery = lineQuery.andWhere({ product_id: row.product_id });
            } else {
              throw new Error('Each receipt row must include purchase_order_item_id or product_id.');
            }

            const line = await lineQuery.first();
            if (!line) {
              throw new Error('Purchase order item not found for receipt row.');
            }

            const qtyRequested = toNumber(line.qty_requested, 0);
            const qtyReceivedCurrent = toNumber(line.qty_received, 0);
            const qtyRemaining = qtyRequested - qtyReceivedCurrent;
            const qtyIncoming = row.qty_received;

            if (qtyIncoming > qtyRemaining + 1e-9) {
              throw new Error(
                `Received quantity exceeds requested for product ${line.product_id}. remaining=${qtyRemaining}, incoming=${qtyIncoming}`
              );
            }

            await trx('purchase_receipts').insert({
              purchase_order_item_id: line.id,
              qty_received: qtyIncoming,
              received_at: nowValue,
              received_by: userId,
              notes: row.notes ?? receiptNotes,
            });

            const nextQtyReceived = qtyReceivedCurrent + qtyIncoming;

            const [updatedLine] = await trx('purchase_order_items')
              .where({ id: line.id })
              .update({
                qty_received: nextQtyReceived,
                date_updated: nowValue,
              })
              .returning('*');

            updatedLines.push(updatedLine);

            const existingStockRow = await trx('product_stock')
              .where({ branch_id: branchId, product_id: line.product_id })
              .first()
              .forUpdate();

            if (existingStockRow) {
              const currentQty = toNumber(existingStockRow.quantity, 0);
              await trx('product_stock')
                .where({ id: existingStockRow.id })
                .update({
                  quantity: currentQty + qtyIncoming,
                  last_updated_at: nowValue,
                });
            } else {
              await trx('product_stock').insert({
                branch_id: branchId,
                product_id: line.product_id,
                quantity: qtyIncoming,
                minimum_stock: 0,
                last_updated_at: nowValue,
              });
            }

            await trx('stock_movements').insert({
              product_id: line.product_id,
              branch_id: branchId,
              type: 'compra',
              quantity: qtyIncoming,
              notes: `Recepcion OC ${purchaseOrderId}`,
            });

            touchedProducts.add(toNumber(line.product_id));
          }

          const totals = await trx('purchase_order_items')
            .where({ purchase_order_id: purchaseOrderId })
            .sum({ requested: 'qty_requested', received: 'qty_received' })
            .first();

          const totalRequested = toNumber(totals?.requested, 0);
          const totalReceived = toNumber(totals?.received, 0);

          let nextStatus = order.status;
          let closedAt = order.closed_at;

          if (totalReceived > 0 && totalReceived + 1e-9 < totalRequested) {
            nextStatus = 'partial_received';
          }

          if (totalRequested > 0 && totalReceived + 1e-9 >= totalRequested) {
            nextStatus = 'received';
            closedAt = nowValue;
          }

          const [updatedOrder] = await trx('purchase_orders')
            .where({ id: purchaseOrderId })
            .update({
              status: nextStatus,
              closed_at: closedAt,
              date_updated: nowValue,
            })
            .returning('*');

          for (const productId of touchedProducts) {
            if (!Number.isFinite(productId)) continue;

            await trx('product_suppliers')
              .insert({
                product_id: productId,
                supplier_id: order.supplier_id,
                is_default: false,
                last_ordered_at: nowValue,
                date_created: nowValue,
                date_updated: nowValue,
              })
              .onConflict(['product_id', 'supplier_id'])
              .merge({
                last_ordered_at: nowValue,
                date_updated: nowValue,
              });

            await trx('products')
              .where({ id: productId })
              .update({
                last_order_date: trx.raw('CURRENT_DATE'),
                updated_at: nowValue,
              });
          }

          return {
            order: updatedOrder,
            items: updatedLines,
            totals: {
              requested: totalRequested,
              received: totalReceived,
            },
          };
        });

        return res.status(200).json({
          ok: true,
          source: SOURCE,
          route,
          data: result,
        });
      } catch (error) {
        return next(error);
      }
    });

    router.post('/set-default-supplier-bulk', async (req, res, next) => {
      const route = '/purchase-tx/set-default-supplier-bulk';
      const userId = ensureAuthenticated(req, res, route);
      if (!userId) return;

      const payload = req.body ?? {};
      const supplierId = toPositiveNumber(payload.supplier_id);
      const productIds = Array.isArray(payload.product_ids)
        ? payload.product_ids.map((value) => toPositiveNumber(value)).filter((value) => Number.isFinite(value))
        : [];

      if (!Number.isFinite(supplierId) || productIds.length === 0) {
        return res.status(400).json({
          ok: false,
          source: SOURCE,
          route,
          error: 'supplier_id and product_ids are required.',
        });
      }

      try {
        const result = await database.transaction(async (trx) => {
          const nowValue = trx.fn.now();

          for (const productId of productIds) {
            await setDefaultSupplierForProduct(trx, productId, supplierId, nowValue);

            await trx('products')
              .where({ id: productId })
              .update({
                updated_at: nowValue,
              });
          }

          return {
            supplier_id: supplierId,
            product_ids: productIds,
            updated_by: userId,
          };
        });

        return res.status(200).json({
          ok: true,
          source: SOURCE,
          route,
          data: result,
        });
      } catch (error) {
        return next(error);
      }
    });
  },
};

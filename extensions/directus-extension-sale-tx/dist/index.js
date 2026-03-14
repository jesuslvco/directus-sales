const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeItems = (items) => {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => ({
      product_id: toNumber(item?.product_id, NaN),
      quantity: toNumber(item?.quantity, NaN),
      unit_price: toNumber(item?.unit_price, 0),
      discount: toNumber(item?.discount, 0),
      total_price: toNumber(item?.total_price, 0),
    }))
    .filter((item) => Number.isFinite(item.product_id) && Number.isFinite(item.quantity) && item.quantity > 0);
};

const sumRequestedByProduct = (items) => {
  const map = new Map();
  for (const item of items) {
    const previous = map.get(item.product_id) || 0;
    map.set(item.product_id, previous + item.quantity);
  }
  return map;
};

export default {
  id: 'sale-tx',
  handler: (router, { database }) => {
    router.post('/finalize', async (req, res, next) => {
      const payload = req.body ?? {};
      const authenticatedUserId = req.accountability?.user;

      if (!authenticatedUserId) {
        return res.status(401).json({
          ok: false,
          source: 'directus-extension-sale-tx',
          route: '/sale-tx/finalize',
          error: 'Unauthorized',
        });
      }

      const normalizedItems = normalizeItems(payload.sale_items);
      if (normalizedItems.length === 0) {
        return res.status(400).json({
          ok: false,
          source: 'directus-extension-sale-tx',
          route: '/sale-tx/finalize',
          error: 'sale_items is required and must contain valid items.',
        });
      }

      const branchId = toNumber(payload.branch_id, NaN);
      const terminalId = payload.terminal_id ?? null;
      const customerId = toNumber(payload.customer_id, NaN);
      const total = toNumber(payload.total, NaN);
      const paidAmount = toNumber(payload.paid_amount, NaN);
      const changeAmount = toNumber(payload.change_amount, 0);
      const paymentMethod = payload.payment_method ?? 'cash';
      const status = payload.status ?? 'completed';
      const userId = payload.user_id ?? authenticatedUserId;

      if (!Number.isFinite(branchId) || !Number.isFinite(customerId) || !Number.isFinite(total) || !Number.isFinite(paidAmount)) {
        return res.status(400).json({
          ok: false,
          source: 'directus-extension-sale-tx',
          route: '/sale-tx/finalize',
          error: 'branch_id, customer_id, total and paid_amount are required.',
        });
      }

      try {
        const sale = await database.transaction(async (trx) => {
          const requestedByProduct = sumRequestedByProduct(normalizedItems);
          const productIds = Array.from(requestedByProduct.keys());

          const stockRows = await trx('product_stock')
            .where('branch_id', branchId)
            .whereIn('product_id', productIds)
            .forUpdate();

          const stockByProduct = new Map(stockRows.map((row) => [toNumber(row.product_id), row]));

          for (const productId of productIds) {
            const stockRow = stockByProduct.get(productId);
            const requestedQty = requestedByProduct.get(productId) || 0;
            const availableQty = stockRow ? toNumber(stockRow.quantity, 0) : 0;

            if (!stockRow || availableQty < requestedQty) {
              throw new Error(
                `Insufficient stock for product ${productId}. requested=${requestedQty}, available=${availableQty}`
              );
            }
          }

          const [createdSale] = await trx('sales')
            .insert({
              user_id: userId,
              branch_id: branchId,
              terminal_id: terminalId,
              customer_id: customerId,
              total: total,
              status: status,
              payment_method: paymentMethod,
              paid_amount: paidAmount,
              change_amount: changeAmount,
            })
            .returning('*');

          const saleItemsPayload = normalizedItems.map((item) => ({
            sale_id: createdSale.id,
            product_id: item.product_id,
            quantity: item.quantity,
            unit_price: item.unit_price,
            discount: item.discount,
            total_price: item.total_price,
          }));

          const createdSaleItems = await trx('sale_items').insert(saleItemsPayload).returning('*');

          for (const [productId, requestedQty] of requestedByProduct.entries()) {
            const stockRow = stockByProduct.get(productId);
            const newQty = toNumber(stockRow.quantity, 0) - requestedQty;

            await trx('product_stock')
              .where('id', stockRow.id)
              .update({
                quantity: newQty,
                last_updated_at: trx.fn.now(),
              });

            await trx('stock_movements').insert({
              product_id: productId,
              branch_id: branchId,
              type: 'venta',
              quantity: requestedQty,
              notes: `Venta ${createdSale.id}`,
            });
          }

          return {
            ...createdSale,
            sale_items: createdSaleItems,
          };
        });

        return res.status(200).json({
          ok: true,
          source: 'directus-extension-sale-tx',
          route: '/sale-tx/finalize',
          data: sale,
        });
      } catch (error) {
        return next(error);
      }
    });
  },
};

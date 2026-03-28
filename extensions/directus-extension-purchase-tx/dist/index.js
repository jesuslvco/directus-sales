const SOURCE = 'directus-extension-purchase-tx';

const toNumber = (value, fallback = NaN) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toPositiveNumber = (value, fallback = NaN) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
    // Deprecated in the new workflow: Abastecimiento list is now source of truth.
    router.post('/create-order', async (req, res) => {
      const route = '/purchase-tx/create-order';
      const userId = ensureAuthenticated(req, res, route);
      if (!userId) return;

      return res.status(410).json({
        ok: false,
        source: SOURCE,
        route,
        error: 'create-order is deprecated. Use Abastecimiento list and reception flow directly.',
      });
    });

    // Deprecated in the new workflow: reception updates should be handled in dedicated flow.
    router.post('/receive', async (req, res) => {
      const route = '/purchase-tx/receive';
      const userId = ensureAuthenticated(req, res, route);
      if (!userId) return;

      return res.status(410).json({
        ok: false,
        source: SOURCE,
        route,
        error: 'receive is deprecated. Use dedicated reception capture workflow.',
      });
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

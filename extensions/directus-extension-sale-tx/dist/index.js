export default {
  id: 'sale-tx',
  handler: (router, { database }) => {
    router.post('/finalize', async (req, res, next) => {
      const payload = req.body ?? {};

      try {
        const result = await database.transaction(async (trx) => {
          // Lightweight transactional probe; business writes can be added here.
          await trx.raw('SELECT 1');

          return {
            status: 'finalized',
            processedAt: new Date().toISOString(),
            received: payload
          };
        });

        res.status(200).json({
          ok: true,
          source: 'directus-extension-sale-tx',
          route: '/sale-tx/finalize',
          data: result
        });
      } catch (error) {
        next(error);
      }
    });
  }
};

const getClientName = (database) => database?.client?.config?.client || '';

const extractRows = (rawResult) => {
  if (!rawResult) return [];
  if (Array.isArray(rawResult)) {
    if (Array.isArray(rawResult[0])) return rawResult[0];
    return rawResult;
  }
  if (Array.isArray(rawResult.rows)) return rawResult.rows;
  return [];
};

export default {
  id: 'health',
  handler: (router, { database }) => {
    router.get('/custom', (_req, res) => {
      res.json({
        ok: true,
        source: 'directus-extension-health-custom',
        route: '/health/custom'
      });
    });

    router.get('/ready', async (_req, res) => {
      const startedAt = Date.now();
      try {
        const clientName = getClientName(database);
        const isPostgres = clientName.includes('pg') || clientName.includes('postgres');

        await database.raw('SELECT 1 AS ok');

        let postgisEnabled = false;
        if (isPostgres) {
          const extensionCheck = await database.raw(
            `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS enabled`
          );
          const extensionRows = extractRows(extensionCheck);
          postgisEnabled = Boolean(extensionRows[0]?.enabled);
        }

        return res.status(200).json({
          ok: true,
          source: 'directus-extension-health-custom',
          route: '/health/ready',
          data: {
            databaseClient: clientName || 'unknown',
            isPostgres,
            postgisEnabled,
            latencyMs: Date.now() - startedAt,
          },
        });
      } catch (error) {
        return res.status(503).json({
          ok: false,
          source: 'directus-extension-health-custom',
          route: '/health/ready',
          error: error?.message || 'readiness check failed',
        });
      }
    });
  }
};

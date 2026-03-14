export default {
  id: 'health',
  handler: (router) => {
    router.get('/custom', (_req, res) => {
      res.json({
        ok: true,
        source: 'directus-extension-health-custom',
        route: '/health/custom'
      });
    });
  }
};

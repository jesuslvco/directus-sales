const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ensureAuth = (req, res) => {
  if (!req.accountability?.user) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return false;
  }
  return true;
};

const isSafeIdentifier = (value) => typeof value === 'string' && IDENTIFIER_PATTERN.test(value);

const parseLimit = (value, fallback = 50) => {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 500);
  return fallback;
};

const parseOffset = (value, fallback = 0) => {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return fallback;
};

const toNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const getClientName = (database) => {
  return database?.client?.config?.client || '';
};

const extractRows = (rawResult) => {
  if (!rawResult) return [];
  if (Array.isArray(rawResult)) {
    if (Array.isArray(rawResult[0])) return rawResult[0];
    return rawResult;
  }
  if (Array.isArray(rawResult.rows)) return rawResult.rows;
  return [];
};

const ensurePostgres = (database, res) => {
  const clientName = getClientName(database);
  const isPostgres = clientName.includes('pg') || clientName.includes('postgres');
  if (!isPostgres) {
    res.status(400).json({
      ok: false,
      error: 'geo-query requires PostgreSQL + PostGIS',
      client: clientName || 'unknown',
    });
    return false;
  }
  return true;
};

export default {
  id: 'geo-query',
  handler: (router, { database }) => {
    router.get('/capabilities', async (req, res, next) => {
      if (!ensureAuth(req, res)) return;

      const clientName = getClientName(database);
      const isPostgres = clientName.includes('pg') || clientName.includes('postgres');

      if (!isPostgres) {
        return res.status(200).json({
          ok: true,
          source: 'directus-extension-geo-query',
          route: '/geo-query/capabilities',
          data: {
            databaseClient: clientName || 'unknown',
            isPostgres: false,
            postgisEnabled: false,
            postgisVersion: null,
          },
        });
      }

      try {
        const extensionCheck = await database.raw(
          `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS enabled`
        );
        const extensionRows = extractRows(extensionCheck);
        const postgisEnabled = Boolean(extensionRows[0]?.enabled);

        let postgisVersion = null;
        if (postgisEnabled) {
          const versionResult = await database.raw('SELECT PostGIS_Full_Version() AS version');
          const versionRows = extractRows(versionResult);
          postgisVersion = versionRows[0]?.version ?? null;
        }

        return res.status(200).json({
          ok: true,
          source: 'directus-extension-geo-query',
          route: '/geo-query/capabilities',
          data: {
            databaseClient: clientName,
            isPostgres: true,
            postgisEnabled,
            postgisVersion,
          },
        });
      } catch (error) {
        return next(error);
      }
    });

    router.post('/nearby', async (req, res, next) => {
      if (!ensureAuth(req, res)) return;
      if (!ensurePostgres(database, res)) return;

      const {
        collection,
        geometryField = 'location',
        latitude,
        longitude,
        radiusMeters,
        limit = 50,
      } = req.body ?? {};

      if (!isSafeIdentifier(collection) || !isSafeIdentifier(geometryField)) {
        return res.status(400).json({ ok: false, error: 'Invalid collection or geometryField' });
      }

      const lat = toNumber(latitude);
      const lon = toNumber(longitude);
      const radius = toNumber(radiusMeters);
      const safeLimit = parseLimit(limit);

      if (lat == null || lon == null || radius == null || radius <= 0) {
        return res.status(400).json({ ok: false, error: 'latitude, longitude and radiusMeters are required' });
      }

      try {
        const result = await database.raw(
          `
          SELECT
            *,
            ST_DistanceSphere(??, ST_SetSRID(ST_MakePoint(?, ?), 4326)) AS distance_meters
          FROM ??
          WHERE ST_DWithin(
            ??::geography,
            ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography,
            ?
          )
          ORDER BY distance_meters ASC
          LIMIT ?
          `,
          [geometryField, lon, lat, collection, geometryField, lon, lat, radius, safeLimit]
        );

        const rows = extractRows(result);
        return res.status(200).json({
          ok: true,
          source: 'directus-extension-geo-query',
          route: '/geo-query/nearby',
          data: rows,
          meta: { count: rows.length },
        });
      } catch (error) {
        return next(error);
      }
    });

    router.post('/search-nearby-estabs', async (req, res, next) => {
      if (!ensureAuth(req, res)) return;
      if (!ensurePostgres(database, res)) return;

      const {
        q,
        lat,
        lng,
        radiusMeters = 20000,
        limit = 15,
        offset = 0,
      } = req.body ?? {};

      const term = String(q || '').trim();
      const latitude = toNumber(lat);
      const longitude = toNumber(lng);
      const radius = toNumber(radiusMeters);
      const safeLimit = parseLimit(limit, 15);
      const safeOffset = parseOffset(offset, 0);

      if (!term) {
        return res.status(400).json({ ok: false, error: 'q is required' });
      }

      if (latitude == null || longitude == null) {
        return res.status(400).json({ ok: false, error: 'lat and lng are required' });
      }

      if (radius == null || radius <= 0) {
        return res.status(400).json({ ok: false, error: 'radiusMeters must be > 0' });
      }

      try {
        const likeTerm = `%${term}%`;
        const result = await database.raw(
          `
          SELECT
            e.id,
            e.name,
            e.type,
            e.slogan,
            e.active,
            MIN(ST_DistanceSphere(b.location, ST_SetSRID(ST_MakePoint(?, ?), 4326))) AS distance_meters
          FROM estabs e
          INNER JOIN branches b ON b.estab_id = e.id
          WHERE
            e.active = 1
            AND b.location IS NOT NULL
            AND ST_DWithin(
              b.location::geography,
              ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography,
              ?
            )
            AND (
              e.name ILIKE ?
              OR COALESCE(e.keywords, '') ILIKE ?
              OR COALESCE(e.search_keywords, '') ILIKE ?
            )
          GROUP BY e.id, e.name, e.type, e.slogan, e.active
          ORDER BY distance_meters ASC
          LIMIT ? OFFSET ?
          `,
          [longitude, latitude, longitude, latitude, radius, likeTerm, likeTerm, likeTerm, safeLimit, safeOffset]
        );

        const rows = extractRows(result);
        return res.status(200).json({
          ok: true,
          source: 'directus-extension-geo-query',
          route: '/geo-query/search-nearby-estabs',
          data: rows,
          meta: {
            count: rows.length,
            limit: safeLimit,
            offset: safeOffset,
          },
        });
      } catch (error) {
        return next(error);
      }
    });

    router.post('/intersects-bbox', async (req, res, next) => {
      if (!ensureAuth(req, res)) return;
      if (!ensurePostgres(database, res)) return;

      const { collection, geometryField = 'location', bbox, limit = 100 } = req.body ?? {};

      if (!isSafeIdentifier(collection) || !isSafeIdentifier(geometryField)) {
        return res.status(400).json({ ok: false, error: 'Invalid collection or geometryField' });
      }

      if (!Array.isArray(bbox) || bbox.length !== 4) {
        return res.status(400).json({ ok: false, error: 'bbox must be [minLon, minLat, maxLon, maxLat]' });
      }

      const [minLon, minLat, maxLon, maxLat] = bbox.map(toNumber);
      if ([minLon, minLat, maxLon, maxLat].some((value) => value == null)) {
        return res.status(400).json({ ok: false, error: 'bbox values must be numeric' });
      }

      const safeLimit = parseLimit(limit, 100);

      try {
        const result = await database.raw(
          `
          SELECT *
          FROM ??
          WHERE ST_Intersects(
            ??,
            ST_MakeEnvelope(?, ?, ?, ?, 4326)
          )
          LIMIT ?
          `,
          [collection, geometryField, minLon, minLat, maxLon, maxLat, safeLimit]
        );

        const rows = extractRows(result);
        return res.status(200).json({
          ok: true,
          source: 'directus-extension-geo-query',
          route: '/geo-query/intersects-bbox',
          data: rows,
          meta: { count: rows.length },
        });
      } catch (error) {
        return next(error);
      }
    });

    router.post('/intersects-geojson', async (req, res, next) => {
      if (!ensureAuth(req, res)) return;
      if (!ensurePostgres(database, res)) return;

      const { collection, geometryField = 'location', geometry, limit = 100 } = req.body ?? {};

      if (!isSafeIdentifier(collection) || !isSafeIdentifier(geometryField)) {
        return res.status(400).json({ ok: false, error: 'Invalid collection or geometryField' });
      }

      if (!geometry || typeof geometry !== 'object' || !geometry.type) {
        return res.status(400).json({ ok: false, error: 'geometry (GeoJSON) is required' });
      }

      const safeLimit = parseLimit(limit, 100);

      try {
        const result = await database.raw(
          `
          SELECT *
          FROM ??
          WHERE ST_Intersects(
            ??,
            ST_SetSRID(ST_GeomFromGeoJSON(?), 4326)
          )
          LIMIT ?
          `,
          [collection, geometryField, JSON.stringify(geometry), safeLimit]
        );

        const rows = extractRows(result);
        return res.status(200).json({
          ok: true,
          source: 'directus-extension-geo-query',
          route: '/geo-query/intersects-geojson',
          data: rows,
          meta: { count: rows.length },
        });
      } catch (error) {
        return next(error);
      }
    });
  },
};

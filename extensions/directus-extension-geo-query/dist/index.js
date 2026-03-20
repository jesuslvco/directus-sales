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

const EVENT_TO_COLUMN = {
  search_impression: 'search_impressions',
  search_click: 'search_clicks',
  detail_view: 'detail_views',
  call_click: 'call_clicks',
  whatsapp_click: 'whatsapp_clicks',
  map_click: 'map_clicks',
};

const normalizeMetricDate = (value) => {
  if (!value) return new Date().toISOString().slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
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

    router.post('/metrics/ingest', async (req, res, next) => {
      if (!ensureAuth(req, res)) return;
      if (!ensurePostgres(database, res)) return;

      const rawEvents = Array.isArray(req.body?.events) ? req.body.events : [];
      if (rawEvents.length === 0) {
        return res.status(400).json({ ok: false, error: 'events[] is required' });
      }

      const safeEvents = rawEvents
        .slice(0, 200)
        .map((event) => {
          const eventType = String(event?.eventType || '').trim().toLowerCase();
          const metricColumn = EVENT_TO_COLUMN[eventType];
          const estabId = toNumber(event?.estabId);
          const regionId = toNumber(event?.regionId);
          const count = Math.max(1, Math.min(parseLimit(event?.count, 1), 50));
          const metricDate = normalizeMetricDate(event?.metricDate);

          if (!metricColumn || estabId == null || !metricDate) return null;

          return {
            metricColumn,
            estabId,
            regionId: regionId == null ? null : regionId,
            count,
            metricDate,
          };
        })
        .filter(Boolean);

      if (safeEvents.length === 0) {
        return res.status(400).json({ ok: false, error: 'No valid events to ingest' });
      }

      try {
        await database.transaction(async (trx) => {
          for (const event of safeEvents) {
            const increments = {
              search_impressions: 0,
              search_clicks: 0,
              detail_views: 0,
              call_clicks: 0,
              whatsapp_clicks: 0,
              map_clicks: 0,
            };
            increments[event.metricColumn] = event.count;

            if (event.regionId == null) {
              const updateResult = await trx.raw(
                `
                UPDATE estab_metrics_daily
                SET
                  search_impressions = search_impressions + ?,
                  search_clicks = search_clicks + ?,
                  detail_views = detail_views + ?,
                  call_clicks = call_clicks + ?,
                  whatsapp_clicks = whatsapp_clicks + ?,
                  map_clicks = map_clicks + ?,
                  updated_at = NOW()
                WHERE metric_date = ?
                  AND estab_id = ?
                  AND region_id IS NULL
                `,
                [
                  increments.search_impressions,
                  increments.search_clicks,
                  increments.detail_views,
                  increments.call_clicks,
                  increments.whatsapp_clicks,
                  increments.map_clicks,
                  event.metricDate,
                  event.estabId,
                ]
              );

              const updatedRows = updateResult?.rowCount ?? updateResult?.[1] ?? 0;
              if (updatedRows > 0) continue;

              await trx.raw(
                `
                INSERT INTO estab_metrics_daily (
                  metric_date,
                  estab_id,
                  region_id,
                  search_impressions,
                  search_clicks,
                  detail_views,
                  call_clicks,
                  whatsapp_clicks,
                  map_clicks
                ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
                `,
                [
                  event.metricDate,
                  event.estabId,
                  increments.search_impressions,
                  increments.search_clicks,
                  increments.detail_views,
                  increments.call_clicks,
                  increments.whatsapp_clicks,
                  increments.map_clicks,
                ]
              );
              continue;
            }

            await trx.raw(
              `
              INSERT INTO estab_metrics_daily (
                metric_date,
                estab_id,
                region_id,
                search_impressions,
                search_clicks,
                detail_views,
                call_clicks,
                whatsapp_clicks,
                map_clicks
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (metric_date, estab_id, region_id)
              DO UPDATE SET
                search_impressions = estab_metrics_daily.search_impressions + EXCLUDED.search_impressions,
                search_clicks = estab_metrics_daily.search_clicks + EXCLUDED.search_clicks,
                detail_views = estab_metrics_daily.detail_views + EXCLUDED.detail_views,
                call_clicks = estab_metrics_daily.call_clicks + EXCLUDED.call_clicks,
                whatsapp_clicks = estab_metrics_daily.whatsapp_clicks + EXCLUDED.whatsapp_clicks,
                map_clicks = estab_metrics_daily.map_clicks + EXCLUDED.map_clicks,
                updated_at = NOW()
              `,
              [
                event.metricDate,
                event.estabId,
                event.regionId,
                increments.search_impressions,
                increments.search_clicks,
                increments.detail_views,
                increments.call_clicks,
                increments.whatsapp_clicks,
                increments.map_clicks,
              ]
            );
          }
        });

        return res.status(200).json({
          ok: true,
          source: 'directus-extension-geo-query',
          route: '/geo-query/metrics/ingest',
          data: {
            received: rawEvents.length,
            processed: safeEvents.length,
          },
        });
      } catch (error) {
        return next(error);
      }
    });

    router.get('/popular/estabs', async (req, res, next) => {
      if (!ensureAuth(req, res)) return;
      if (!ensurePostgres(database, res)) return;

      const regionId = toNumber(req.query?.regionId);
      const days = Math.max(1, Math.min(parseLimit(req.query?.days, 7), 30));
      const limit = parseLimit(req.query?.limit, 15);
      const offset = parseOffset(req.query?.offset, 0);

      const whereRegion = regionId == null ? '' : 'AND m.region_id = ?';

      try {
        const raw = await database.raw(
          `
          SELECT
            e.id,
            e.name,
            e.type,
            e.slogan,
            e.active,
            (
              SUM(m.search_impressions) * 0.5 +
              SUM(m.search_clicks) * 3.0 +
              SUM(m.detail_views) * 2.0 +
              SUM(m.call_clicks) * 4.0 +
              SUM(m.whatsapp_clicks) * 3.5 +
              SUM(m.map_clicks) * 2.5
            )::numeric(14,2) AS popularity_score
          FROM estab_metrics_daily m
          INNER JOIN estabs e ON e.id = m.estab_id
          WHERE
            e.active = 1
            AND m.metric_date >= (CURRENT_DATE - (?::int - 1) * INTERVAL '1 day')
            ${whereRegion}
          GROUP BY e.id, e.name, e.type, e.slogan, e.active
          ORDER BY popularity_score DESC
          LIMIT ? OFFSET ?
          `,
          regionId == null
            ? [days, limit, offset]
            : [days, regionId, limit, offset]
        );

        const rows = extractRows(raw);
        return res.status(200).json({
          ok: true,
          source: 'directus-extension-geo-query',
          route: '/geo-query/popular/estabs',
          data: rows,
          meta: {
            count: rows.length,
            regionId: regionId == null ? null : regionId,
            days,
            limit,
            offset,
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

# directus-sales

Base de Directus en Docker, preparada para Railway, con extensiones locales en `/extensions`.

## Estructura

```text
.
├── Dockerfile
├── .dockerignore
├── .gitignore
├── README.md
└── extensions/
    ├── directus-extension-health-custom/
    │   ├── package.json
    │   └── dist/
    │       └── index.js
    ├── directus-extension-geo-query/
    │   ├── package.json
    │   └── dist/
    │       └── index.js
    └── directus-extension-sale-tx/
        ├── package.json
        └── dist/
            └── index.js
```

## Endpoints custom

La extensión `directus-extension-health-custom` registra:

- `GET /health/custom`

Respuesta esperada:

```json
{
  "ok": true,
  "source": "directus-extension-health-custom",
  "route": "/health/custom"
}
```

La extensión `directus-extension-sale-tx` registra:

- `POST /sale-tx/finalize`

Respuesta esperada:

```json
{
  "ok": true,
  "source": "directus-extension-sale-tx",
  "route": "/sale-tx/finalize",
  "data": {
    "status": "finalized",
    "processedAt": "2026-03-14T00:00:00.000Z",
    "received": {
      "saleId": "123"
    }
  }
}
```

La extensión `directus-extension-geo-query` registra:

- `GET /geo-query/capabilities`
- `POST /geo-query/nearby`
- `POST /geo-query/search-nearby-estabs`
- `POST /geo-query/metrics/ingest`
- `GET /geo-query/popular/estabs`
- `POST /geo-query/intersects-bbox`
- `POST /geo-query/intersects-geojson`

Notas:

- Requiere PostgreSQL + PostGIS.
- Los endpoints esperan autenticación (token/session válida).

## Build local

```bash
docker build -t directus-sales .
```

## Run local (mínimo)

> Para producción en Railway se recomienda PostgreSQL. Este ejemplo local usa SQLite para validar arranque y extensiones.

```bash
docker run --rm -p 8055:8055 \
  -e KEY=replace-with-long-random-key \
  -e SECRET=replace-with-long-random-secret \
  -e DB_CLIENT=sqlite3 \
  -e DB_FILENAME=/directus/database/data.db \
  -e ADMIN_EMAIL=admin@example.com \
  -e ADMIN_PASSWORD=Admin1234! \
  directus-sales
```

Validar endpoints:

```bash
curl http://localhost:8055/health/custom
```

```bash
curl -X POST http://localhost:8055/sale-tx/finalize \
  -H 'Content-Type: application/json' \
  -d '{"saleId":"123"}'
```

```bash
curl -X POST http://localhost:8055/geo-query/nearby \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "collection": "branches",
    "geometryField": "location",
    "latitude": 19.4326,
    "longitude": -99.1332,
    "radiusMeters": 5000,
    "limit": 25
  }'
```

```bash
curl http://localhost:8055/geo-query/capabilities \
  -H 'Authorization: Bearer <TOKEN>'
```

```bash
curl -X POST http://localhost:8055/geo-query/metrics/ingest \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "events": [
      { "eventType": "search_impression", "estabId": 4, "regionId": 1, "count": 1 },
      { "eventType": "search_click", "estabId": 4, "regionId": 1, "count": 1 }
    ]
  }'
```

```bash
curl "http://localhost:8055/geo-query/popular/estabs?regionId=1&days=7&limit=15&maxGold=2&maxSilver=2" \
  -H 'Authorization: Bearer <TOKEN>'
```

## Deploy en Railway

1. Crear un nuevo proyecto en Railway desde este repositorio.
2. Railway detectará `Dockerfile` y hará build automáticamente.
3. Definir variables de entorno en Railway:
   - `KEY`
   - `SECRET`
   - `ADMIN_EMAIL`
   - `ADMIN_PASSWORD`
   - `DB_CLIENT=pg`
   - `DB_HOST`
   - `DB_PORT`
   - `DB_DATABASE`
   - `DB_USER`
   - `DB_PASSWORD`
4. Deploy.
5. Verificar en la URL pública:

```bash
curl https://<tu-app>.up.railway.app/health/custom
```

```bash
curl -X POST https://<tu-app>.up.railway.app/sale-tx/finalize \
  -H 'Content-Type: application/json' \
  -d '{"saleId":"123"}'
```

```bash
curl -X POST https://<tu-app>.up.railway.app/geo-query/intersects-bbox \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "collection": "branches",
    "geometryField": "location",
    "bbox": [-99.30, 19.20, -98.90, 19.60],
    "limit": 100
  }'
```

```bash
curl https://<tu-app>.up.railway.app/geo-query/capabilities \
  -H 'Authorization: Bearer <TOKEN>'
```

## Notas

- `EXTENSIONS_PATH` está definido en el `Dockerfile` como `/directus/extensions`.
- El contenedor usa `HOST=0.0.0.0` para aceptar conexiones externas (requisito típico en Railway).
- `sale-tx` ejecuta una transacción real: valida inventario, crea `sales`, crea `sale_items`, descuenta `product_stock` y registra `stock_movements`.
- `geo-query` está orientado a colecciones con campos geográficos (`geometry`) y pensado para PostgreSQL + PostGIS.

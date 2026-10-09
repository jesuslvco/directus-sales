const PRODUCT_COLLECTION = 'products';
const STOCK_COLLECTION = 'product_stock';
const SALE_ITEM_COLLECTION = 'sale_items';
const PRICE_FIELD = 'price';
const LAST_PRICE_DATE_FIELD = 'last_price_date';
const LAST_SALE_DATE_FIELD = 'last_sale_date';
const LAST_ORDER_DATE_FIELD = 'last_order_date';
const STOCK_QUANTITY_FIELD = 'quantity';
const BUSINESS_TIME_ZONE = 'America/Mexico_City';

const isObject = (value) => value !== null && typeof value === 'object';

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const todayInBusinessTimeZone = () => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const getUpdateKeys = (meta) => {
  if (Array.isArray(meta?.keys)) return meta.keys;
  if (meta?.key != null) return [meta.key];
  return [];
};

const hasPriceField = (payload) =>
  isObject(payload) && Object.prototype.hasOwnProperty.call(payload, PRICE_FIELD);

const hasField = (payload, field) =>
  isObject(payload) && Object.prototype.hasOwnProperty.call(payload, field);

const getFiniteId = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const updateProductDate = async (database, productIds, field) => {
  const validProductIds = Array.from(new Set(productIds.map(getFiniteId).filter((id) => id !== null)));
  if (validProductIds.length === 0) return;

  await database(PRODUCT_COLLECTION)
    .whereIn('id', validProductIds)
    .update({ [field]: todayInBusinessTimeZone() });
};

export default ({ filter }, { database, logger }) => {
  filter(`${PRODUCT_COLLECTION}.items.update`, async (payload, meta) => {
    if (!hasPriceField(payload)) return payload;

    const keys = getUpdateKeys(meta);
    if (keys.length === 0) {
      logger.warn('[product-audit] No se recibieron IDs para validar el cambio de precio.');
      return payload;
    }

    const currentProducts = await database(PRODUCT_COLLECTION)
      .select('id', PRICE_FIELD)
      .whereIn('id', keys);

    const currentPriceById = new Map(
      currentProducts.map((product) => [String(product.id), toNumber(product[PRICE_FIELD])])
    );
    const nextPrice = toNumber(payload[PRICE_FIELD]);
    const priceChanged = keys.some((key) => {
      const currentPrice = currentPriceById.get(String(key));
      return currentPrice !== null && nextPrice !== null && currentPrice !== nextPrice;
    });

    if (!priceChanged) return payload;

    return {
      ...payload,
      [LAST_PRICE_DATE_FIELD]: todayInBusinessTimeZone(),
    };
  });

  filter(`${SALE_ITEM_COLLECTION}.items.create`, async (payload) => {
    if (!hasField(payload, 'product_id')) return payload;

    const productId = getFiniteId(payload.product_id);
    const quantity = toNumber(payload.quantity, 0);
    if (productId === null || quantity <= 0) return payload;

    await updateProductDate(database, [productId], LAST_SALE_DATE_FIELD);
    return payload;
  });

  filter(`${STOCK_COLLECTION}.items.create`, async (payload) => {
    const receivedQuantity = toNumber(payload?.[STOCK_QUANTITY_FIELD], 0);
    if (receivedQuantity <= 0) return payload;

    // Una existencia inicial positiva representa recepción de piezas.
    await updateProductDate(database, [payload?.product_id], LAST_ORDER_DATE_FIELD);
    return payload;
  });

  filter(`${STOCK_COLLECTION}.items.update`, async (payload, meta) => {
    if (!hasField(payload, STOCK_QUANTITY_FIELD)) return payload;

    const keys = getUpdateKeys(meta);
    if (keys.length === 0) {
      logger.warn('[product-audit] No se recibieron IDs de stock para validar la recepción.');
      return payload;
    }

    const currentRows = await database(STOCK_COLLECTION)
      .select('id', 'product_id', STOCK_QUANTITY_FIELD)
      .whereIn('id', keys);

    const nextStockQuantity = toNumber(payload[STOCK_QUANTITY_FIELD], 0);
    const receivedProductIds = currentRows
      .filter((row) => {
        const previousStockQuantity = toNumber(row[STOCK_QUANTITY_FIELD], 0);
        return nextStockQuantity > previousStockQuantity;
      })
      .map((row) => row.product_id);

    await updateProductDate(database, receivedProductIds, LAST_ORDER_DATE_FIELD);
    return payload;
  });
};

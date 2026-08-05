// utils/customerPriceList.js
//
// פתירת המחיר של לקוח מסוים למוצר מסוים.
//
// כלל אחד, במקום אחד: **אם המק"ט מופיע במחירון הלקוח — המחיר שלו קובע. אחרת
// המחיר של הקטלוג.** לקוח בלי מחירון משלם את מחירי הקטלוג במלואם.
//
// כל מסלול שמתמחר הזמנה ללקוח מסוים חייב לעבור מכאן ולא לקרוא prices.price
// ישירות, אחרת שני מסלולים יתמחרו את אותה הזמנה בשני מחירים שונים.

const CustomerPriceList = require("../models/CustomerPriceList");

const normalizeSku = (value) => String(value ?? "").trim();

// ── מפתח משני למק"ט מספרי ──
//
// אותו מק"ט מגיע בשתי צורות: באקסל הוא נקרא כמספר ("0123" -> 123), ובקטלוג הוא
// נשמר פעם כמחרוזת ופעם כמספר (ראה importSkuQuery ב-productController, שסובל
// את שתיהן). בלי המפתח הזה מחירון שנקרא מאקסל לא היה מתאים למוצר שהמק"ט שלו
// נשמר כמחרוזת עם אפס מוביל, והלקוח היה מקבל את מחיר הקטלוג בשקט.
//
// ההתאמה המדויקת קודמת תמיד — המפתח המספרי הוא נפילה בלבד.
const numericSkuKey = (sku) => {
  if (!/^\d+$/.test(sku)) return null;
  const num = Number(sku);
  return Number.isSafeInteger(num) ? String(num) : null;
};

/**
 * בניית מפת מק"ט → מחיר משורות המחירון.
 * שורה בלי מק"ט או בלי מחיר חיובי אינה נכנסת: מחיר 0 היה מייצר שורת הזמנה
 * בסך 0 ש"ח בלי שאיש ישים לב, ולכן הוא נחשב "אין מחיר" ולא "חינם".
 */
const buildPriceMap = (items = []) => {
  const map = new Map();
  const numericAliases = new Map();

  for (const item of items) {
    const sku = normalizeSku(item?.sku);
    const price = Number(item?.price);
    if (!sku || !Number.isFinite(price) || price <= 0) continue;

    map.set(sku, price);

    const alias = numericSkuKey(sku);
    if (alias && alias !== sku) numericAliases.set(alias, price);
  }

  // נפילות מספריות נוספות רק אם אין התאמה מדויקת באותו מפתח
  for (const [key, price] of numericAliases) {
    if (!map.has(key)) map.set(key, price);
  }

  return map;
};

/**
 * שליפת מחירון הלקוח כמפת מק"ט → מחיר.
 * @returns {Promise<Map<string, number>|null>} null כשללקוח אין מחירון
 */
const getCustomerPriceMap = async (customerId) => {
  if (!customerId) return null;

  const doc = await CustomerPriceList.findOne({ customer: customerId })
    .select("+items")
    .lean();

  if (!doc?.items?.length) return null;

  const map = buildPriceMap(doc.items);
  return map.size > 0 ? map : null;
};

/**
 * המחיר של הלקוח למוצר.
 * @returns {number|null} null כשהמוצר אינו במחירון הלקוח (כלומר: מחיר הקטלוג)
 */
const priceForProduct = (priceMap, product) => {
  if (!priceMap || !product) return null;

  const sku = normalizeSku(product.sku);
  if (!sku) return null;

  if (priceMap.has(sku)) return priceMap.get(sku);

  const alias = numericSkuKey(sku);
  return alias && priceMap.has(alias) ? priceMap.get(alias) : null;
};

/**
 * המחיר שבו המוצר יימכר ללקוח הזה בפועל — מחירון אם יש, קטלוג אם אין.
 */
const effectivePrice = (priceMap, product) => {
  const custom = priceForProduct(priceMap, product);
  if (custom !== null) return custom;
  const catalog = Number(product?.prices?.price);
  return Number.isFinite(catalog) ? catalog : 0;
};

module.exports = {
  normalizeSku,
  numericSkuKey,
  buildPriceMap,
  getCustomerPriceMap,
  priceForProduct,
  effectivePrice,
};

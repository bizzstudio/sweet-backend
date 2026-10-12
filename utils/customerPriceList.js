// utils/customerPriceList.js
//
// פתירת המחיר של לקוח מסוים למוצר מסוים.
//
// כלל אחד, במקום אחד, לפי סדר העדיפויות:
//
//   1. המחירון הקבוצתי שהלקוח משויך אליו (GroupPriceList) — גובר על הכל
//   2. המחירון הפרטי של הלקוח (CustomerPriceList)
//   3. מחיר הקטלוג
//
// ההכרעה היא **לכל מק"ט בנפרד**: מק"ט שאינו במחירון הקבוצתי ממשיך למחירון
// הפרטי, ורק אחריו לקטלוג. לקוח בלי אף מחירון משלם את מחירי הקטלוג במלואם.
//
// כל מסלול שמתמחר הזמנה ללקוח מסוים חייב לעבור מכאן ולא לקרוא prices.price
// ישירות, אחרת שני מסלולים יתמחרו את אותה הזמנה בשני מחירים שונים.

const CustomerPriceList = require("../models/CustomerPriceList");
const GroupPriceList = require("../models/GroupPriceList");

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
 * המחירון הקבוצתי שהלקוח משויך אליו, או null.
 * @param {boolean} [withItems] לטעון גם את השורות (ברירת המחדל: מטא-נתונים)
 */
const findGroupPriceList = async (customerId, { withItems = false } = {}) => {
  if (!customerId) return null;
  const query = GroupPriceList.findOne({ customers: customerId }).select(
    withItems ? "name itemsCount +items" : "name itemsCount"
  );
  return query.lean();
};

// שני מק"טים הם "אותו מק"ט" אם הם זהים, או זהים בצורתם המספרית ("0123"/"123")
const skuIdentity = (sku) => numericSkuKey(sku) || sku;

/**
 * איחוד שורות המחירון הפרטי והקבוצתי לרשימה אחת שבה הקבוצתי גובר.
 *
 * שורה פרטית מוסרת כשבקבוצתי יש אותו מק"ט — כולל בצורתו המספרית. בלי זה
 * "0123" במחירון הפרטי היה ממשיך לנצח את "123" במחירון הקבוצתי (ההתאמה
 * המדויקת קודמת לנפילה המספרית), כלומר הקבוצתי לא היה גובר דווקא במקרה
 * שהכי קשה לראות בעין.
 */
const mergePriceListItems = (ownItems = [], groupItems = []) => {
  if (!groupItems.length) return ownItems;

  const groupSkus = new Set();
  for (const item of groupItems) {
    const sku = normalizeSku(item?.sku);
    // שורה בלי מחיר חיובי אינה תופסת (ראה buildPriceMap), ולכן גם אינה דורסת
    if (sku && Number(item?.price) > 0) groupSkus.add(skuIdentity(sku));
  }

  const kept = ownItems.filter(
    (item) => !groupSkus.has(skuIdentity(normalizeSku(item?.sku)))
  );
  return [...kept, ...groupItems];
};

/**
 * שורות המחירון של הלקוח לפי המקור שלהן — לפני האיחוד.
 * @returns {Promise<{ownItems: Array, groupItems: Array, group: object|null}>}
 */
const loadCustomerPriceLayers = async (customerId) => {
  if (!customerId) return { ownItems: [], groupItems: [], group: null };

  const [own, group] = await Promise.all([
    CustomerPriceList.findOne({ customer: customerId }).select("+items").lean(),
    findGroupPriceList(customerId, { withItems: true }),
  ]);

  return {
    ownItems: own?.items || [],
    groupItems: group?.items || [],
    group: group ? { _id: group._id, name: group.name, itemsCount: group.itemsCount || 0 } : null,
  };
};

/**
 * שליפת המחירים של הלקוח כמפת מק"ט → מחיר — המחירון הקבוצתי מעל הפרטי.
 * @returns {Promise<Map<string, number>|null>} null כשללקוח אין אף מחירון
 */
const getCustomerPriceMap = async (customerId) => {
  if (!customerId) return null;

  const { ownItems, groupItems } = await loadCustomerPriceLayers(customerId);
  if (!ownItems.length && !groupItems.length) return null;

  const map = buildPriceMap(mergePriceListItems(ownItems, groupItems));
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
  findGroupPriceList,
  mergePriceListItems,
  loadCustomerPriceLayers,
  getCustomerPriceMap,
  priceForProduct,
  effectivePrice,
};

// lib/billing/deposits.js
//
// פיקדון על מכלי משקה — שורה שמתווספת לתעודה לפי כמות המשקאות בה.
//
// ── איך זה עובד ──
//
// מוצר משקה נושא product.deposit = { product, perUnit }: איזה מוצר פיקדון
// (פיקדון פחיות / פיקדון ליטר וחצי — מוצרים רגילים בקטלוג) וכמה פיקדונות
// יש ביחידה אחת שלו (1 לבקבוק בודד, 6 לשישייה, 24 לקרטון).
//
// כל בניית שורות של תעודה — אוטומטית מהזמנה, ידנית, ועריכה — עוברת כאן,
// ולכן הפיקדון מופיע בכל מסלול שההזמנה הגיעה ממנו (חנות, מייל, ווצאפ,
// הקלדה) ומשם בחשבונית החודשית.
//
// ── שורות הפיקדון מחושבות, לא נערכות ──
//
// שורת פיקדון שכבר קיימת בשורות שנכנסו (מהעריכה הקודמת, או מוקלדת ביד
// כמו שעשו עד היום) מוחלפת בחישוב — אחרת כל שמירה של תעודה הייתה מוסיפה
// פיקדון על הפיקדון, ותעודה שהפיקדון הוקלד בה ביד הייתה מחויבת פעמיים.
// היוצא מן הכלל: שורת פיקדון בתעודה שאין בה אף משקה המחייב *אותו* פיקדון
// נשארת כמו שהוקלדה — זו החלטה מפורשת של מי שהקליד, ואין חישוב שיחליף אותה.
//
// ── הנחה ──
//
// פיקדון אינו הכנסה של העסק אלא סכום שמועבר הלאה, ולכן אינו נכנס לבסיס
// ההנחה הקבועה של הלקוח. goodsTotal() הוא הסכום שעליו מחשבים הנחה.

const Product = require("../../models/Product");
const { priceItemsForCustomer } = require("./pricing");

const CACHE_TTL_MS = 60 * 1000;
let depositIdsCache = { ids: null, at: 0 };

/** מזהי כל מוצרי הפיקדון שמוצר כלשהו מפנה אליהם. */
const depositProductIds = async ({ force = false } = {}) => {
  if (!force && depositIdsCache.ids && Date.now() - depositIdsCache.at < CACHE_TTL_MS) {
    return depositIdsCache.ids;
  }
  const ids = await Product.distinct("deposit.product", { "deposit.product": { $ne: null } });
  depositIdsCache = { ids: new Set(ids.map(String)), at: Date.now() };
  return depositIdsCache.ids;
};

/** לקרוא אחרי שינוי שיוך פיקדון, כדי שהשינוי ייכנס לתוקף מיד. */
const clearDepositCache = () => {
  depositIdsCache = { ids: null, at: 0 };
};

const keyOf = (item) => (item.productId ? `id:${item.productId}` : item.sku ? `sku:${item.sku}` : null);

/**
 * החישוב עצמו, בלי מסד — כדי שאפשר יהיה לבדוק אותו.
 *
 * @param {Array} items - שורות התעודה (productId / sku / quantity / category / categoryName)
 * @param {Map<string, {depositId: string, perUnit: number}>} rules - לפי keyOf של שורת המשקה
 * @param {Map<string, {sku: string}>} depositProducts - מוצרי הפיקדון לפי _id
 * @returns {{kept: Array, needed: Array<{depositId, sku, quantity, category, categoryName}>}}
 */
const planDeposits = (items, rules, depositProducts) => {
  const depositKeys = new Map(); // keyOf(שורה) → depositId, לזיהוי שורת פיקדון קיימת
  for (const [id, p] of depositProducts) {
    depositKeys.set(`id:${id}`, id);
    if (p.sku) depositKeys.set(`sku:${p.sku}`, id);
  }
  const depositIdOfLine = (item) =>
    (item.productId && depositKeys.get(`id:${item.productId}`)) ||
    (item.sku && depositKeys.get(`sku:${item.sku}`)) ||
    null;

  // סכימה לפי (מוצר פיקדון, קטגוריית המשקה). הקטגוריה עוברת מהמשקה כדי
  // שהפיקדון ייכנס לאותה חשבונית כמו המשקה כשהחשבונית מפוצלת לפי קטגוריה.
  const groups = new Map();
  const totalByDeposit = new Map();
  for (const item of items) {
    if (item.isDeposit || depositIdOfLine(item)) continue;
    const rule =
      (item.productId && rules.get(`id:${item.productId}`)) ||
      (item.sku && rules.get(`sku:${item.sku}`));
    if (!rule) continue;
    const deposit = depositProducts.get(rule.depositId);
    if (!deposit?.sku) continue;

    const quantity = Number(item.quantity) * (Number(rule.perUnit) || 1);
    if (!(quantity > 0)) continue;

    const groupKey = `${rule.depositId}|${item.category || ""}`;
    const group = groups.get(groupKey) || {
      depositId: rule.depositId,
      sku: deposit.sku,
      quantity: 0,
      category: item.category,
      categoryName: item.categoryName,
    };
    group.quantity += quantity;
    groups.set(groupKey, group);
    totalByDeposit.set(rule.depositId, (totalByDeposit.get(rule.depositId) || 0) + quantity);
  }

  const kept = items.filter((item) => {
    if (item.isDeposit) return false;
    const depositId = depositIdOfLine(item);
    // שורת פיקדון שהחישוב מחליף יורדת; שורה שאין לה תחליף נשארת
    return !(depositId && totalByDeposit.get(depositId) > 0);
  });

  const needed = [...groups.values()].map((g) => ({
    ...g,
    // כמות שבורה (0.5 קרטון) מעוגלת לשלוש ספרות כדי לא להדפיס 11.999999
    quantity: Number(g.quantity.toFixed(3)),
  }));

  return { kept, needed };
};

/**
 * מחזיר את שורות התעודה עם שורות הפיקדון המחושבות בסופן.
 *
 * @param {Array} items - שורות תעודה בנויות (אחרי תמחור)
 * @param {string|ObjectId} customerId - לתמחור הפיקדון לפי המחירונים של הלקוח
 */
const withDeposits = async (items, customerId) => {
  if (!items?.length) return items || [];

  const depositIds = await depositProductIds();
  if (!depositIds.size) return items;

  const productIds = items.map((i) => i.productId).filter(Boolean).map(String);
  const skus = items.map((i) => i.sku).filter(Boolean).map(String);

  const [drinks, depositDocs] = await Promise.all([
    Product.find({
      $or: [{ _id: { $in: productIds } }, { sku: { $in: skus } }],
      "deposit.product": { $ne: null },
    })
      .select("_id sku deposit")
      .lean(),
    Product.find({ _id: { $in: [...depositIds] } })
      .select("_id sku")
      .lean(),
  ]);

  const rules = new Map();
  for (const p of drinks) {
    const rule = { depositId: String(p.deposit.product), perUnit: p.deposit.perUnit || 1 };
    rules.set(`id:${p._id}`, rule);
    if (p.sku) rules.set(`sku:${p.sku}`, rule);
  }
  const depositProducts = new Map(depositDocs.map((d) => [String(d._id), { sku: d.sku }]));

  const { kept, needed } = planDeposits(items, rules, depositProducts);
  if (!needed.length) return kept;

  const priced = await priceItemsForCustomer(
    customerId,
    needed.map((n) => ({ sku: n.sku, quantity: n.quantity }))
  );

  const lines = needed.map((n, i) => {
    const row = priced[i];
    return {
      productId: row.productId,
      sku: row.sku,
      barcode: row.barcode,
      name: row.name,
      quantity: n.quantity,
      unitPrice: row.unitPrice,
      lineTotal: Number((row.unitPrice * n.quantity).toFixed(2)),
      isVatFree: row.isVatFree,
      category: n.category,
      categoryName: n.categoryName,
      isDeposit: true,
    };
  });

  const missingPrice = lines.filter((l) => !(l.unitPrice > 0));
  if (missingPrice.length) {
    console.warn(
      `[deposits] אין מחיר למוצר פיקדון: ${missingPrice.map((l) => l.sku).join(", ")} — השורה נכנסת ב-0`
    );
  }

  return [...kept, ...lines];
};

/** סכום השורות שאינן פיקדון — הבסיס להנחה. */
const goodsTotal = (items) =>
  Number(
    (items || [])
      .filter((i) => !i.isDeposit)
      .reduce((s, i) => s + (Number(i.lineTotal) || 0), 0)
      .toFixed(2)
  );

module.exports = {
  withDeposits,
  planDeposits,
  goodsTotal,
  depositProductIds,
  clearDepositCache,
};

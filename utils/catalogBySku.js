// utils/catalogBySku.js
//
// שליפת מוצרים לפי מק"ט, עם הצורה המספרית כנפילה.
//
// ── למה זה לא טריוויאלי ──
//
// המק"ט בקטלוג נשמר פעם כמחרוזת ופעם כמספר (ראה importSkuQuery ב-
// productController), ואקסל קורא "0123" כ-123. כלומר אותו מק"ט מגיע בשתי
// צורות, ושאילתה על אחת מהן מפספסת את השנייה **בשקט** — הקובץ נשמר, לא נזרקת
// שגיאה, והשורה פשוט לא תופסת באף הזמנה.
//
// הכלל בכל המודול: **התאמה מדויקת קודמת תמיד, והצורה המספרית היא נפילה בלבד.**

const Product = require("../models/Product");
const { normalizeSku, numericSkuKey } = require("./customerPriceList");

// כמה מק"טים בשאילתה אחת. $in ענק הוא מסמך שאילתה ענק, ומונגו מגביל אותו.
const CHUNK_SIZE = 1000;

const skuQuery = (chunk) => {
  const numeric = chunk.map(Number).filter((num) => Number.isFinite(num));
  return numeric.length > 0
    ? { $or: [{ sku: { $in: chunk } }, { sku: { $in: numeric } }] }
    : { sku: { $in: chunk } };
};

/**
 * מק"ט → מסמך המוצר. מחזירה מסמכים מלאים ולכן מיועדת לקבוצה מוגבלת.
 * @param {string[]} skus
 * @param {string} [select]
 */
const fetchCatalogBySku = async (skus, select = "_id sku title status prices.price") => {
  const bySku = new Map();
  const numericAliases = new Map();

  const unique = [...new Set(skus.map(normalizeSku).filter(Boolean))];

  for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
    const found = await Product.find(skuQuery(unique.slice(i, i + CHUNK_SIZE)))
      .select(select)
      .lean();

    found.forEach((product) => {
      const sku = normalizeSku(product.sku);
      if (!sku) return;
      // ── מק"ט כפול בקטלוג ──
      //
      // הקטלוג מכיל קבוצות כפילויות, ולכן שני מסמכים יכולים לשאת אותו מק"ט.
      // הראשון שנשלף מנצח, במקום שהאחרון ידרוס אותו: כך התוצאה יציבה בין
      // הרצות ואינה תלויה בסדר השליפה מהמסד.
      if (!bySku.has(sku)) bySku.set(sku, product);
      const alias = numericSkuKey(sku);
      if (alias && alias !== sku && !numericAliases.has(alias)) {
        numericAliases.set(alias, product);
      }
    });
  }

  for (const [key, product] of numericAliases) {
    if (!bySku.has(key)) bySku.set(key, product);
  }

  return bySku;
};

/**
 * "אילו מק"טים בכלל קיימים" — בלי המסמכים.
 *
 * מופרד מ-fetchCatalogBySku כי הספירה "כמה מהקובץ קיים בקטלוג" נמדדת על **כל**
 * השורות (יכולות להיות אלפים), ואילו הפרטים נדרשים רק לעמוד המוצג.
 */
const fetchExistingSkus = async (skus) => {
  const set = new Set();
  const unique = [...new Set(skus.map(normalizeSku).filter(Boolean))];

  for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
    const values = await Product.distinct("sku", skuQuery(unique.slice(i, i + CHUNK_SIZE)));
    values.forEach((value) => {
      const sku = normalizeSku(value);
      if (!sku) return;
      set.add(sku);
      const alias = numericSkuKey(sku);
      if (alias) set.add(alias);
    });
  }

  return set;
};

const lookupCatalog = (catalogBySku, sku) => {
  const key = normalizeSku(sku);
  if (catalogBySku.has(key)) return catalogBySku.get(key);
  const alias = numericSkuKey(key);
  return alias ? catalogBySku.get(alias) || null : null;
};

const existsInCatalog = (existingSkus, sku) => {
  const key = normalizeSku(sku);
  if (existingSkus.has(key)) return true;
  const alias = numericSkuKey(key);
  return Boolean(alias && existingSkus.has(alias));
};

module.exports = {
  CHUNK_SIZE,
  skuQuery,
  fetchCatalogBySku,
  fetchExistingSkus,
  lookupCatalog,
  existsInCatalog,
};

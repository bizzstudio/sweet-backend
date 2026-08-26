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

// ── למה זה אינו משמש גם את המחירון ──
//
// ‏controller/customerPriceListController מחזיק פונקציות דומות משלו, ואיחודן
// לכאן נראה מתבקש — אבל השתיים **אינן זהות**: כשהקטלוג מכיל שני מוצרים באותו
// מק"ט (יש כ-108 קבוצות כפילויות), שם מנצח האחרון שנשלף וכאן מנצח הראשון.
// ההבדל הזה קובע לאיזה מוצר שורת מחירון נצמדת, כלומר כמה הלקוח משלם.
// מיזוגן הוא שינוי תמחור שדורש אימות משלו, ולא ניקוי צד.

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

const lookupCatalog = (catalogBySku, sku) => {
  const key = normalizeSku(sku);
  if (catalogBySku.has(key)) return catalogBySku.get(key);
  const alias = numericSkuKey(key);
  return alias ? catalogBySku.get(alias) || null : null;
};

module.exports = { fetchCatalogBySku, lookupCatalog };

// utils/barcode.js
//
// הברקוד של המוצר — מקור אמת אחד.
//
// למוצר יש שני שדות שנקראים "ברקוד", והם לא אותו דבר:
//
//   product.barcode      — שדה של תבנית החנות, משמש לסדר הופעה. ריק בכל
//                          4,320 המוצרים במסד (נבדק 30/08/26).
//   product.erp.barcode  — הברקוד שהגיע מהאקסל של מנוע. מלא בכל המוצרים,
//                          3-4 ספרות, וזה מה שהלקוחה קוראת לו "הברקוד שלנו".
//
// כל מקום שמדפיס או מחפש ברקוד עובר דרך כאן, כדי שלא ייווצר מסך אחד
// שמחפש לפי השדה הריק ומסך אחר שמחפש לפי המלא.
//
// ⚠️ הברקוד אינו מפתח ייחודי. במסד יש 7 קבוצות של ברקוד כפול (17 מוצרים)
//    ומספר ערכי זבל ("0", "1", "2", "ללא מעמ"). לכן החיפוש לפי ברקוד
//    מחזיר *רשימה* ולא מוצר בודד, והמסך מבקש הכרעה כשיש יותר מאחד.
//    לאיתור: scripts/barcode-audit.js

const Product = require("../models/Product");

/**
 * ברקוד שהוא באמת ברקוד.
 *
 * בקטלוג יש 13 ערכים שאינם ברקוד אלא רעש מהייבוא — "0", "1", "2", "3",
 * ואחד עם הטקסט "ללא מעמ" (ראה scripts/barcode-audit.js). כלל אחד קובע
 * מה נחשב ברקוד, והוא חל גם על החיפוש וגם על ההדפסה:
 *
 *   חיפוש  — "2" היה מחזיר ארבעה מוצרים שאין ביניהם קשר.
 *   הדפסה  — "2" בעמודת הברקוד על תעודת משלוח גרוע מעמודה ריקה: הלקוחה
 *            מנסה להצליב מולו ולא מוצאת דבר, ובחשבונית הוא נשלח ל-iCount
 *            כמזהה המוצר.
 *
 * שני מקומות עם שני כללים היו מייצרים בדיוק את הפער הזה — ברקוד שמודפס
 * על המסמך ואי אפשר לחפש לפיו.
 */
const MIN_SEARCHABLE_LENGTH = 2;

const isSearchableBarcode = (value) => {
  const text = String(value ?? "").trim();
  return text.length >= MIN_SEARCHABLE_LENGTH && /^\d+$/.test(text);
};

/**
 * הברקוד של מסמך מוצר, או undefined כשאין לו ברקוד שמיש.
 *
 * ערך שאינו עובר את isSearchableBarcode חוזר כ-undefined ולא כמות שהוא:
 * המסמכים נופלים אז חזרה למק"ט, וזה עדיף על הדפסת "2" כברקוד. הערך הגולמי
 * עדיין נגיש ב-product.erp.barcode למי שצריך אותו (הביקורת קוראת משם).
 */
const barcodeOf = (product) => {
  const raw = product?.erp?.barcode;
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  return isSearchableBarcode(text) ? text : undefined;
};

/**
 * מוצרים שהברקוד שלהם תואם.
 *
 * מחזיר מערך במכוון: הברקוד אינו ייחודי במסד, ותשובה של מוצר יחיד הייתה
 * בוחרת בשקט אחד מתוך כמה — כלומר מחייבת את הלקוח על המוצר הלא נכון.
 *
 * @param {string} code
 * @returns {Promise<Array>} מוצרים רזים: sku, barcode, name, price
 */
const findByBarcode = async (code) => {
  const text = String(code ?? "").trim();
  if (!isSearchableBarcode(text)) return [];

  // המרה למספר ובחזרה מנרמלת אפסים מובילים ("0412" -> "412"), כי הערך
  // במסד נשמר כמחרוזת בדיוק כפי שהגיע מהאקסל ולא בפורמט אחיד.
  const variants = new Set([text, String(Number(text))]);

  const products = await Product.find({
    "erp.barcode": { $in: [...variants] },
    sku: { $exists: true, $nin: [null, ""] },
  })
    .select("sku title prices.price erp.barcode")
    .lean();

  return products.map((p) => ({
    sku: String(p.sku),
    barcode: barcodeOf(p),
    name: p.title?.he || p.title?.en || String(p.sku),
    price: Number(p.prices?.price) || 0,
  }));
};

/**
 * טוען ברקודים לפי מק"ט, פעם אחת לכל אצווה.
 *
 * קיים כדי שבניית תעודה עם 40 שורות לא תפנה למסד 40 פעם. המפה מוחזרת
 * ולא נשמרת בזיכרון בין קריאות — ברקוד שהשתנה בייבוא חייב להופיע במסמך
 * הבא, ולא אחרי הפעלה מחדש של השרת.
 *
 * @param {Array<string>} skus
 * @returns {Promise<Map<string, string>>} מק"ט -> ברקוד
 */
const barcodesBySku = async (skus) => {
  const clean = [...new Set((skus || []).map((s) => String(s || "").trim()).filter(Boolean))];
  if (!clean.length) return new Map();

  const products = await Product.find({ sku: { $in: clean } })
    .select("sku erp.barcode")
    .lean();

  const map = new Map();
  for (const p of products) {
    const code = barcodeOf(p);
    if (code) map.set(String(p.sku), code);
  }
  return map;
};

module.exports = {
  barcodeOf,
  findByBarcode,
  barcodesBySku,
  isSearchableBarcode,
  MIN_SEARCHABLE_LENGTH,
};

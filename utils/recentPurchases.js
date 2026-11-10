// utils/recentPurchases.js
//
// "מה הלקוח קנה בחודשים האחרונים" — לכל מוצר, כל קנייה בתאריך שלה.
//
// ── למה לא CustomerPurchaseHistory ──
//
// ההיסטוריה שמיובאת מההנהח"ש היא סיכום: שורה אחת למוצר עם התאריך האחרון
// בלבד, והיא אינה מתעדכנת מתעודות שהופקו במערכת. כאן נאספות הקניות עצמן,
// משני מקורות שלכל שורה בהם יש תאריך:
//
//   1. תעודות משלוח שהופקו במערכת (פרט לתעודות שבוטלו)
//   2. הזמנות ארכיון — המסמכים מקובץ ההנהח"ש, אחד לכל תעודה/חשבונית שם
//
// שני המקורות מוצגים יחד, וכל קנייה מסומנת במקור שלה. אין ניסיון לזהות
// "אותה קנייה בשני המקורות": מספרי המסמכים שונים ואין ביניהם מפתח משותף,
// וניחוש לפי תאריך+כמות היה מעלים קנייה אמיתית שחזרה באותו יום.
//
// הפונקציה כאן טהורה (בלי מסד נתונים) כדי שאפשר יהיה לבדוק אותה לבד —
// השליפה עצמה ב-controller/customerHistoryController.

const PERIOD_MONTHS = [1, 3, 6, 12];
const DEFAULT_MONTHS = 3;

const toText = (value) =>
  typeof value === "string" || typeof value === "number" ? String(value).trim() : "";

// ‏null ו-"" אינם 0: מחיר חסר בקובץ אינו מחיר אפס (Number(null) === 0)
const toNum = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

// תקופה שאינה ברשימה חוזרת לברירת המחדל ולא נזרקת כשגיאה: זו בחירת תצוגה
const normalizeMonths = (value) => {
  const num = Number(value);
  return PERIOD_MONTHS.includes(num) ? num : DEFAULT_MONTHS;
};

// תחילת התקופה: היום לפני N חודשים, מחצות (UTC). חצות ולא "עכשיו פחות N
// חודשים": אחרת קנייה מאותו יום לפני שלושה חודשים הייתה נכנסת או נעלמת לפי
// השעה שבה נפתח החלון
//
// היום נחתך לאורך החודש: 31/03 פחות חודש הוא 28/02, ולא 03/03 (setUTCMonth
// לבדו גולש קדימה לחודש הבא)
const periodStart = (months, now = new Date()) => {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(now.getUTCDate(), lastDay)));
};

// היום שבו הקנייה קרתה, כ-YYYY-MM-DD.
// תעודה במערכת היא רגע בזמן, ולכן היום נקבע לפי שעון ישראל. תאריך מקובץ
// ההנהח"ש הוא שעון-קיר שנשמר כ-UTC (ראה formatFileDate בפאנל), ולכן היום
// שלו הוא בדיוק מה שכתוב בו — תרגום לשעון ישראל היה מזיז אותו
const dayOf = (date, source) => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  if (source === "archive") return d.toISOString().slice(0, 10);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
};

const titleOf = (title) =>
  title && typeof title === "object" ? toText(title.he) || toText(title.en) : toText(title);

/**
 * @param {object}   input
 * @param {object[]} input.notes     תעודות: { number, issuedAt, items: [{ productId, sku, name, quantity, unitPrice }] }
 * @param {object[]} input.archives  הזמנות ארכיון: { archive: { docNumber, docType, docDate, unmatchedItems }, cart: [...] }
 * @param {function} input.lookup    מק"ט → מוצר בקטלוג ({ _id, sku, title }) או null
 * @returns {object[]} מוצר אחד לכל פריט, הקנייה האחרונה ראשונה
 */
const buildRecentPurchases = ({ notes = [], archives = [], lookup = () => null }) => {
  const byKey = new Map();

  const add = ({ sku, name, productId, date, source, doc, quantity, unitPrice }) => {
    const rawSku = toText(sku);
    const day = dayOf(date, source);
    if (!day) return;

    // המוצר בקטלוג נקבע לפי המק"ט, כדי שהכפתור "הוסף" יקבל את המק"ט
    // הנוכחי. מוצר שאינו בקטלוג עדיין מוצג — זו קנייה אמיתית — אבל אי אפשר
    // להוסיף אותו לתעודה
    const product = rawSku ? lookup(rawSku) : null;
    const key = product?._id
      ? `p:${product._id}`
      : productId
        ? `p:${productId}`
        : rawSku
          ? `s:${rawSku}`
          : `n:${toText(name)}`;
    if (key === "n:") return;

    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        key,
        sku: product ? toText(product.sku) : rawSku,
        name: titleOf(product?.title) || toText(name),
        inCatalog: Boolean(product),
        purchases: [],
      };
      byKey.set(key, entry);
    } else if (product && !entry.inCatalog) {
      // השורה הראשונה של המוצר נשאה מק"ט ישן שאינו בקטלוג, וזו מצאה אותו
      // (אותו productId). בלי העדכון המוצר היה נשאר "אינו בקטלוג" וחסום
      // להוספה, רק בגלל סדר השורות
      entry.sku = toText(product.sku);
      entry.name = titleOf(product.title) || entry.name;
      entry.inCatalog = true;
    }

    entry.purchases.push({
      day,
      at: (date instanceof Date ? date : new Date(date)).toISOString(),
      source,
      doc,
      quantity: toNum(quantity),
      unitPrice: toNum(unitPrice),
    });
  };

  for (const note of notes) {
    const doc = note.number ? `תעודה ${note.number}` : "תעודה";
    for (const item of note.items || []) {
      add({
        sku: item.sku,
        name: item.name,
        productId: item.productId,
        date: note.issuedAt,
        source: "note",
        doc,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      });
    }
  }

  for (const order of archives) {
    const meta = order.archive || {};
    const docNumber = toText(meta.docNumber);
    const doc = [toText(meta.docType) || "מסמך", docNumber].filter(Boolean).join(" ");
    const lines = [
      ...(order.cart || []).map((item) => ({
        sku: item.sku,
        name: titleOf(item.title),
        productId: item._id,
        quantity: item.quantity,
        unitPrice: item.price,
      })),
      // שורות שהמק"ט שלהן לא היה בקטלוג ביבוא אינן בעגלה. הן עדיין קנייה
      ...(meta.unmatchedItems || []).map((item) => ({
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
        unitPrice: item.price,
      })),
    ];
    for (const line of lines) {
      add({ ...line, date: meta.docDate, source: "archive", doc });
    }
  }

  const products = [...byKey.values()].map((entry) => {
    entry.purchases.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const last = entry.purchases[0];
    const totalQty = entry.purchases.reduce((sum, p) => sum + (p.quantity || 0), 0);
    return {
      ...entry,
      count: entry.purchases.length,
      totalQty: Math.round(totalQty * 1000) / 1000,
      lastDay: last.day,
      lastAt: last.at,
      lastQty: last.quantity,
      lastPrice: last.unitPrice,
    };
  });

  // הקנייה האחרונה ראשונה; באותו יום — מה שנקנה יותר פעמים
  products.sort((a, b) =>
    a.lastAt !== b.lastAt ? (a.lastAt < b.lastAt ? 1 : -1) : b.count - a.count
  );
  return products;
};

module.exports = {
  PERIOD_MONTHS,
  DEFAULT_MONTHS,
  normalizeMonths,
  periodStart,
  dayOf,
  buildRecentPurchases,
};

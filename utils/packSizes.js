// utils/packSizes.js
//
// כמה יחידות יש בקרטון של מוצר — נגזר ממה שהלקוחות הזמינו בפועל.
//
// ── למה זה קיים ──
//
// לקוח כותב "2 קרטון מים" והמוצר בקטלוג הוא בקבוק בודד. בקטלוג אין שדה
// "יחידות בקרטון", ולכן שורה כזו נעצרה תמיד. הנתון קיים בעקיפין: בארכיון
// ההזמנות (כ-130 אלף) מים מינרלים הוזמנו 24, 48, 72, 96 — כמעט תמיד כפולה
// של 24. מוצר שמוזמן כך נמכר בקרטון של 24.
//
// רוב המוצרים אינם מראים כפולה ברורה (בייגלה, נס קפה). להם אין כאן תשובה,
// והשורה נשארת לאדם — גודל קרטון אינו דבר שמנחשים.

const Order = require("../models/Order");

// פחות מזה אין מספיק הזמנות כדי להבחין בין הרגל של לקוח אחד לבין אריזה
const MIN_LINES = 30;
// קרטון של פחות מ-5 אינו נבדל מ"כמה יחידות"
const MIN_SIZE = 5;
// כמות נחשבת מועמדת לגודל קרטון רק כשהיא עצמה מוזמנת לעתים קרובות
const MIN_CANDIDATE_SHARE = 0.1;
// איזה חלק מהשורות חייב להיות כפולה של הגודל
const MIN_SHARE = 0.7;
// 5 הוא גם "חמש יחידות" סתם, ולכן נדרשת שם התפלגות חד-משמעית. נמדד על
// הארכיון: נייר צילום A4 (קרטון של 5 חבילות) עומד על 96%, כפיות חד-פעמי
// שמוזמנות 5/10/20 מתוך הרגל עומדות על 73%.
const SMALL_SIZE = 6;
const MIN_SHARE_SMALL = 0.9;
const CACHE_MS = 24 * 60 * 60 * 1000;

/**
 * גודל הקרטון העולה מהתפלגות הכמויות, או null כשאין כזה.
 *
 * עוברים על הכמויות מהנפוצה ביותר, והראשונה ש-70% מהשורות הן כפולה שלה היא
 * הקרטון. למה לא פשוט הנפוצה ביותר: בקבוקי קולה זירו מוזמנים 48 קצת יותר
 * מ-24, אבל רק 40% מהשורות הן כפולה של 48 — הקרטון הוא 24. ולמה לא המחלק
 * המשותף: פחיות מוזמנות גם בשישיות (16%), אבל "קרטון פחיות" הוא 24.
 *
 * @param {Array<[number, number]>} quantities - זוגות [כמות, מספר השורות]
 * @returns {number|null}
 */
const packSizeFrom = (quantities) => {
  const rows = (quantities || []).filter(([q, n]) => Number.isInteger(q) && q > 0 && n > 0);
  const total = rows.reduce((sum, [, n]) => sum + n, 0);
  if (total < MIN_LINES) return null;

  const candidates = rows
    .filter(([q, n]) => q >= MIN_SIZE && n / total >= MIN_CANDIDATE_SHARE)
    .sort((a, b) => b[1] - a[1]);
  for (const [size] of candidates) {
    const multiples = rows.filter(([q]) => q % size === 0).reduce((sum, [, n]) => sum + n, 0);
    const needed = size < SMALL_SIZE ? MIN_SHARE_SMALL : MIN_SHARE;
    if (multiples / total >= needed) return size;
  }
  return null;
};

let cache = null;

/**
 * גודלי הקרטון של כל המוצרים שיש להם כזה, לפי מק"ט ולפי שם.
 *
 * מחושב פעם ביום מהארכיון וממוטמן: הארכיון אינו משתנה בין הזמנה להזמנה.
 *
 * @returns {Promise<{bySku: Map<string, number>, byTitle: Map<string, number>}>}
 */
const getPackSizes = async () => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.promise;

  const promise = Order.aggregate([
    { $match: { "archive.sourceKey": { $exists: true } } },
    { $unwind: "$cart" },
    {
      $group: {
        _id: { sku: "$cart.sku", title: "$cart.title.he", quantity: "$cart.quantity" },
        n: { $sum: 1 },
      },
    },
  ])
    .allowDiskUse(true)
    .then((groups) => {
      const perSku = new Map();
      const perTitle = new Map();
      const add = (map, key, quantity, n) => {
        if (!key) return;
        const list = map.get(key) || [];
        const found = list.find((row) => row[0] === quantity);
        if (found) found[1] += n;
        else list.push([quantity, n]);
        map.set(key, list);
      };
      for (const { _id, n } of groups) {
        const quantity = Number(_id.quantity);
        add(perSku, _id.sku ? String(_id.sku).trim() : "", quantity, n);
        add(perTitle, _id.title ? String(_id.title).trim() : "", quantity, n);
      }

      const sizes = (map) => {
        const out = new Map();
        for (const [key, rows] of map) {
          const size = packSizeFrom(rows);
          if (size) out.set(key, size);
        }
        return out;
      };
      return { bySku: sizes(perSku), byTitle: sizes(perTitle) };
    });

  cache = { at: Date.now(), promise };
  // חישוב שנכשל אינו נשאר במטמון ליממה
  promise.catch(() => {
    cache = null;
  });
  return promise;
};

/** גודל הקרטון של מוצר ({ sku, title: { he } }), או null */
const packSizeOf = (sizes, product) => {
  if (!sizes || !product) return null;
  const sku = product.sku ? String(product.sku).trim() : "";
  const title = String(product.title?.he || "").trim();
  return sizes.bySku.get(sku) || sizes.byTitle.get(title) || null;
};

module.exports = { getPackSizes, packSizeOf, packSizeFrom };

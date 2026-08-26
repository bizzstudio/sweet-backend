// utils/catalogVocabulary.js
//
// "כמה מוצרים בקטלוג נושאים את המילה הזו".
//
// ── מה זה פותר ──
//
// שורה בלי כמות נכנסת להזמנה רק אם כל מילה בה נמצאת בשם מוצר (coversAllWords).
// הכלל מדויק, אבל הוא בינארי — ולקוח שכותב מוצר אמיתי במילים שלו נופל בו:
//
//     "חלב 3 אחוז"   →  בקטלוג "חלב טרי 3%"   ("אחוז" אינו בשם)
//     "עוגיות בקופסא" →  בקטלוג "בקופסה"       (כתיב)
//
// עד כה שורות כאלה ירדו להערת ההזמנה, וההזמנה נכנסה כ"נקראה במלואה" — כלומר
// **נשלחה בלי הפריט, ואיש לא ידע**. זה הכשל השקט הגרוע ביותר בצינור.
//
// אבל אי אפשר פשוט להשאיר אותן: "מה המצב" ו-"סבבה גמור" מקבלות ביטחון 0.6 —
// גבוה משם מוצר אמיתי — ואם הן נשארות, כל אחת מהן מפילה הזמנה שלמה.
//
// ── האות שמפריד ──
//
// **תדירות המילה בקטלוג.** מילה שמופיעה בעשרות שמות מוצר היא מילה מתחום
// המוצרים; מילה שמופיעה באחד היא צירוף מקרים. נמדד על הקטלוג הזה (4,320
// מוצרים), 16 מוצרים בניסוח חופשי מול 30 ביטויי שיחה:
//
//     מוצרים:  חלב 41 · קלסר 61 · עוגיות 50 · נייר 156 · לכוסות 5   (מינימום 5)
//     שיחה:    מה 1 · סבבה 1 · טוב 1 · על 8 · והשאר 0               (מקסימום 8)
//
// הסף הוא 3, כלומר נמוך משני הקצוות. בטווח החפיפה הכיוון הבטוח הוא **לאדם**:
// שורת שיחה שנשלחת בטעות לבדיקה עולה מבט אחד, ופריט אמיתי שיורד להערה נשלח
// חסר. במדידה: 1 מתוך 30 ביטויי שיחה מגיע לאדם, ו-0 מתוך 16 מוצרים אובד.
//
// ── למה מטמון ולא שאילתה לכל שורה ──
//
// אותו שיקול כמו ב-senderWhitelist: הקטלוג משתנה לאט, השורות רבות, ושליפה
// לכל שורה הייתה סריקה מלאה בכל פעם.

const Product = require("../models/Product");
const { canonicalWords } = require("./orderWording");

// מילה שמופיעה בפחות משמות מוצר מזה אינה מילה מתחום המוצרים
const MIN_PRODUCT_WORD_STRENGTH =
  Number(process.env.INGESTION_MIN_PRODUCT_WORD_STRENGTH) || 3;

const TTL_MS = Number(process.env.INGESTION_CATALOG_VOCAB_TTL_MS) || 10 * 60 * 1000;

// ── השהיה אחרי כשל ──
//
// בלעדיה `loadedAt` נשאר 0 אחרי כישלון, וכל הזמנה הבאה מנסה לבנות מחדש —
// כלומר מסד שנפל גורר סריקת קטלוג לכל הזמנה במקום אחת לדקה.
const RETRY_AFTER_FAILURE_MS = 60 * 1000;

let cache = null;
let loadedAt = 0;
let failedAt = 0;
let inFlight = null;

const build = async () => {
  // ‏title בלבד: 4,320 מסמכים מלאים היו מאות KB לרענון, וכל מה שנדרש כאן
  // הוא המילים
  const products = await Product.find({}).select("title").lean();

  const counts = new Map();
  for (const product of products) {
    const text = `${product.title?.he || ""} ${product.title?.en || ""}`;
    // ‏Set: מילה שחוזרת פעמיים באותו שם נספרת פעם אחת. אחרת "נייר טואלט
    // נייר" היה מנפח את המילה בלי שיהיה מוצר נוסף שנושא אותה.
    // אותה צורה קנונית שבה נשאלת השאילתה, אחרת "קילו" לעולם לא היה נמצא
    // בקטלוג שכתוב 'ק"ג'
    for (const word of new Set(canonicalWords(text))) {
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  return counts;
};

/**
 * מפת מילה → בכמה שמות מוצר היא מופיעה.
 *
 * @returns {Promise<Map<string, number>|null>} null כשהשליפה נכשלה — הקורא
 *          ממשיך בלי האות הזה במקום להפיל את הקליטה.
 */
const getCatalogVocabulary = async () => {
  const fresh = cache && Date.now() - loadedAt < TTL_MS;
  if (fresh) return cache;

  // אחרי כשל אחרון — לא מנסים שוב מיד. מחזירים את מה שיש (גם null).
  if (failedAt && Date.now() - failedAt < RETRY_AFTER_FAILURE_MS) return cache;

  // ── בקשה אחת בלבד בטיסה ──
  //
  // הקליטה מעבדת הזמנות במקביל, ובלי זה כמה מהן היו בונות את המפה בו-זמנית —
  // כלומר כמה סריקות קטלוג במקום אחת.
  if (!inFlight) {
    inFlight = build()
      .then((counts) => {
        cache = counts;
        loadedAt = Date.now();
        failedAt = 0;
        return counts;
      })
      .catch((err) => {
        failedAt = Date.now();
        console.log(`[vocab] בניית אוצר המילים נכשלה: ${err.message}`);
        return cache; // מפה ישנה עדיפה על כלום
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
};

// ── שיעור, לא שיא ──
//
// הניסוח הראשון בדק את המילה החזקה בשורה. זה נשבר על מספרים: "12" מופיע ב-28
// שמות מוצר, "50" ב-104 ו-"100" ב-148 — ולכן `קומה 3 דירה 12` קיבלה חוזק 28
// ונשלחה לאדם במקום לרדת להערה. שורת כתובת מלאה במספרים.
//
// מספרים מוחרגים לגמרי מהאות הזה. הם משמעותיים לזיהוי **איזה** מוצר
// (‏coversAllWords כן סופר אותם), אבל אינם מעידים שהשורה היא מתחום המוצרים.
//
// מה שנשאר הוא השיעור: כמה ממילות התוכן בשורה הן מילים שהקטלוג משתמש בהן.
// נמדד על הקטלוג המלא, 17 מוצרים בניסוח חופשי מול 17 ביטויי שיחה:
//
//     מוצרים:  50%–100%   (הנמוך ביותר: "מכסים לכוסות")
//     שיחה:     0%–33%    (הגבוה ביותר: "סליחה על ההפרעה")
//
// הסף 50% יושב בדיוק בקצה התחתון של המוצרים, עם מרווח של 17 נקודות מהשיחה.
const MIN_PRODUCT_WORD_FRACTION =
  Number(process.env.INGESTION_MIN_PRODUCT_WORD_FRACTION) || 0.5;

const isNumber = (word) => /^\d+([.,]\d+)?$/.test(word);

/**
 * השיעור מבין מילות התוכן בשורה שהקטלוג משתמש בהן.
 * @returns {number} 0..1, ו-0 כשאין אוצר מילים או אין מילות תוכן
 */
const productWordFraction = (text, vocabulary) => {
  if (!vocabulary) return 0;
  const words = canonicalWords(text).filter((word) => !isNumber(word));
  if (!words.length) return 0;
  const strong = words.filter(
    (word) => (vocabulary.get(word) || 0) >= MIN_PRODUCT_WORD_STRENGTH
  );
  return strong.length / words.length;
};

/**
 * האם השורה נראית כניסיון להזמין מוצר — גם אם לא כל מילה בה נמצאת בקטלוג.
 */
const looksLikeProductAttempt = (text, vocabulary) =>
  productWordFraction(text, vocabulary) >= MIN_PRODUCT_WORD_FRACTION;

module.exports = {
  getCatalogVocabulary,
  productWordFraction,
  looksLikeProductAttempt,
  MIN_PRODUCT_WORD_STRENGTH,
  MIN_PRODUCT_WORD_FRACTION,
};

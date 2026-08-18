// lib/billing/ledger.js
//
// לאיזה "כיס" של תעודת המשלוח נרשם החיוב.
//
// במצב רגיל החיוב נרשם ב-billing.* — status, icountDocNum, paidAt וכן
// הלאה. במצב דמו הוא נרשם ב-billing.demo.*, כיס נפרד לגמרי שהזרימה
// האמיתית לא קוראת ולא כותבת אליו לעולם.
//
// למה כיס ולא בידוד מוחלט:
//
//   כדי שמסך החשבוניות, דוח הגבייה, רישום התשלום ומסך הקבלות יעבדו
//   בדמו, חייב להיות להם מה לקרוא. הם כולם נבנים משדות התעודה — אין
//   אצלנו ישות "חשבונית" — ולכן דמו בלי מצב משלו הוא דמו שבו אפשר
//   להפיק חשבונית אבל אי אפשר לראות אותה.
//
// המחיר: מצב דמו כן כותב למסד. הוא כותב *רק* לתוך billing.demo, שדה
// שאף שאילתה של הזרימה האמיתית אינה מזכירה. ניקוי: scripts/billing-demo-reset.js
//
// שלושה כלים, ואין רביעי:
//   f(name)      — נתיב השדה לשאילתות ול-$set
//   of(note)     — הכיס לקריאה מתוך תעודה שנשלפה
//   normalize()  — מיזוג הכיס אל billing, למי שרק מציג
//
// billingMonth נשאר משותף בכוונה: חודש החיוב הוא עובדה על התעודה
// (מתי הסחורה נמסרה), ולא החלטת חיוב. גם ביטול תעודה נשאר משותף —
// תעודה מבוטלת מבוטלת בשני המצבים, ולכן openQuery בודק את שניהם.

const { isDemoMode } = require("../icount/mode");

const DEMO_PREFIX = "billing.demo";

/** נתיב השדה לשאילתה או ל-$set/$unset. */
const f = (name) => (isDemoMode() ? `${DEMO_PREFIX}.${name}` : `billing.${name}`);

/** הכיס הרלוונטי לקריאה. תמיד אובייקט, גם כשאין עדיין מצב דמו. */
const of = (note) => (isDemoMode() ? note?.billing?.demo || {} : note?.billing || {});

/**
 * תעודות שממתינות לחיוב.
 *
 * בדמו נדרשים שני תנאים: התעודה פתוחה באמת (כלומר לא בוטלה ולא חויבה
 * בחשבון האמיתי), ועדיין לא הופקה לה חשבונית דמו. בלי התנאי הראשון
 * ההדגמה הייתה מציגה תעודות מבוטלות כאילו יש מה לחייב בהן.
 *
 * $in: [null, "open"] תופס גם תעודות שהשדה חסר בהן — כלומר כל התעודות
 * שקיימות מלפני שמצב הדמו הופעל.
 */
const openQuery = () =>
  isDemoMode()
    ? { "billing.status": "open", [`${DEMO_PREFIX}.status`]: { $in: [null, "open"] } }
    : { "billing.status": "open" };

/** תעודות שכבר הופקה להן חשבונית — בכיס הרלוונטי. */
const billedQuery = () => ({ [f("status")]: "billed" });

/**
 * תעודה שנשלפה, כשהכיס של הדמו ממוזג אל billing.
 *
 * זה מה שמאפשר לכל מסכי התצוגה לעבוד בלי לדעת דבר על מצב דמו: הם
 * ממשיכים לקרוא note.billing.icountDocNum, והערך שמגיע אליהם הוא של
 * המצב הפעיל. השדות המשותפים נשמרים במיזוג.
 */
const SHARED_FIELDS = ["billingMonth", "cancelReason", "cancelledAt", "cancelledBySync"];

/**
 * האם לתעודה יש בכלל היסטוריית דמו.
 *
 * mongoose עלול להחזיר billing.demo כאובייקט ריק, ולכן הבדיקה היא על תוכן
 * ולא על קיום השדה.
 */
const hasDemoState = (note) => {
  const d = note?.billing?.demo;
  return Boolean(d && (d.status || d.icountDocNum || d.receiptDocNum || d.credits?.length));
};

const normalize = (note) => {
  if (!isDemoMode() || !note) return note;

  // תעודה שהדמו מעולם לא נגע בה מוצגת כפי שהיא באמת.
  //
  // הכלל הזה נבחר אחרי שהחלופה נכשלה: כשהכיס הריק תורגם ל-status "open",
  // תעודה שחויבה בחשבון האמיתי הופיעה במסך כפתוחה — בזמן ש-openQuery
  // בכלל לא מאפשר לחייב אותה בדמו. שורה שמראה סטטוס אחד ומספר מסמך של
  // סטטוס אחר היא גרועה משורה שאומרת את האמת.
  if (!hasDemoState(note)) return note;

  const billing = { ...note.billing.demo };
  // שדה משותף ממלא רק חור. cancelReason, למשל, יכול להיווצר משני מקורות —
  // ביטול אמיתי של התעודה או זיכוי בדמו — ומה שקרה בדמו הוא מה שרלוונטי
  // למסך שמציג את הדמו.
  for (const key of SHARED_FIELDS) {
    if (billing[key] === undefined && note.billing?.[key] !== undefined) {
      billing[key] = note.billing[key];
    }
  }
  // תעודה שבוטלה מבוטלת בשני המצבים — אחרת היא הייתה נראית פתוחה בדמו
  if (note.billing?.status === "cancelled") billing.status = "cancelled";
  else if (!billing.status) billing.status = "open";

  return { ...note, billing };
};

const normalizeAll = (notes) => (isDemoMode() ? notes.map(normalize) : notes);

module.exports = { f, of, openQuery, billedQuery, normalize, normalizeAll, DEMO_PREFIX };

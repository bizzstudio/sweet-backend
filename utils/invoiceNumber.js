// utils/invoiceNumber.js
//
// הקצאת מספר הזמנה. מקור אמת אחד לכל מסלולי היצירה — צ'קאאוט מהאתר
// (customerOrderController) וקליטה ממייל/ווצאפ (lib/order-ingestion).
//
// למה מונה ולא "המקסימום + 1":
//
//   1. מחיקה שחררה מספר. `max(invoice) + 1` מסתמך על ההזמנה הגבוהה ביותר
//      *הקיימת*; ברגע שהיא נמחקה (מחיקה ידנית ממסך ההזמנות, מחיקת הזמנת שגיאה
//      בהרצה חוזרת, סימון הודעה כלא רלוונטית) המספר שלה חולק שוב להזמנה הבאה.
//      כך יצאו שני מיילים "התקבלה הזמנה חדשה" עם אותו מספר.
//   2. מרוץ בין כותבים מקבילים. שתי יצירות בו-זמנית קראו את אותו max וקיבלו
//      אותו מספר, ובלי אינדקס ייחודי מונגו לא התלונן. $inc אטומי פותר את זה
//      גם בין תהליכים (כמה אינסטנסים של השרת, cron + webhook, צ'קאאוט במקביל).
//
// המונה מתמיד: מספר שהוקצה לא חוזר גם אם ההזמנה נמחקה. זו ההתנהגות הנכונה
// למספר הזמנה/חשבונית — עדיף חור בסדרה על פני מספר כפול.

const Counter = require("../models/Counter");
const Order = require("../models/Order");

const COUNTER_ID = "order_invoice";
// המספר הראשון שיוקצה במסד ריק. seq מחזיק את האחרון שהוקצה, ולכן מאותחל ל-1 פחות.
const FIRST_INVOICE = 10000;
// כמה מספרים תפוסים ברצף מותר לדלג לפני שמוותרים. מגן מלולאה אינסופית אם
// המונה פיגר הרבה מאחורי הנתונים (ייבוא גדול ישירות למונגו).
const MAX_SKIPS = 50;

// האתחול נעשה פעם אחת לכל תהליך. שומרים את ה-Promise ולא דגל בוליאני, כדי
// שהקצאות מקבילות בעלייה יחכו לאותו אתחול במקום להריץ אותו כל אחת בנפרד.
// הנכונות אינה תלויה בזה — האתחול עצמו אטומי וחוזר על עצמו בלי נזק.
let seeding = null;

/**
 * אתחול המונה במסד קיים: מרימים אותו למספר הגבוה ביותר שכבר בשימוש, אחרת
 * ההקצאה הראשונה הייתה מתנגשת בהזמנות ותיקות.
 *
 * $setOnInsert + upsert הוא אטומי: אם שני תהליכים עולים יחד, רק אחד כותב
 * והשני הוא no-op. שגיאת מפתח כפול (שני upsert-ים בדיוק באותו רגע) נבלעת —
 * המשמעות היא שמישהו אחר כבר אתחל.
 */
const ensureSeeded = () => {
  if (seeding) return seeding;

  seeding = (async () => {
    const existing = await Counter.findById(COUNTER_ID).select("_id").lean();
    if (existing) return;

    // $ne: null מוציא גם מסמכים שהשדה חסר בהם. עם האינדקס invoice_1 המיון
    // הזה נקרא מהאינדקס ולא סורק את הקולקציה.
    const highest = await Order.findOne({ invoice: { $ne: null } })
      .sort({ invoice: -1 })
      .select("invoice")
      .lean();

    const seq = Math.max(highest?.invoice || 0, FIRST_INVOICE - 1);

    try {
      await Counter.updateOne(
        { _id: COUNTER_ID },
        { $setOnInsert: { seq } },
        { upsert: true }
      );
      console.log(`[invoice] מונה מספרי ההזמנות אותחל ל-${seq}`);
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  })();

  // כשלון אתחול לא "נתקע" לתמיד — הניסיון הבא יאתחל מחדש
  seeding.catch(() => {
    seeding = null;
  });

  return seeding;
};

/**
 * מקצה את מספר ההזמנה הבא. אטומי — שתי קריאות בו-זמנית לעולם לא יקבלו
 * את אותו מספר, גם מתהליכים שונים.
 *
 * @returns {Promise<number>}
 */
const nextInvoice = async () => {
  // שתי איטרציות: אם מסמך המונה נמחק בין האתחול ל-$inc (תחזוקה ידנית),
  // מאתחלים אותו מחדש ומנסים פעם אחת נוספת.
  for (let attempt = 1; attempt <= 2; attempt++) {
    await ensureSeeded();

    const counter = await Counter.findByIdAndUpdate(
      COUNTER_ID,
      { $inc: { seq: 1 } },
      { new: true }
    );
    if (counter) return counter.seq;

    seeding = null;
  }

  throw new Error("הקצאת מספר הזמנה נכשלה — מסמך המונה אינו זמין");
};

/**
 * דילוג על מספרים תפוסים. רשת ביטחון למקרה שהמונה פיגר אחרי המסד (למשל אחרי
 * ייבוא הזמנות ישירות למונגו): מרים את המונה עד שהמספר שהתקבל פנוי.
 *
 * @returns {Promise<number>}
 */
const nextFreeInvoice = async () => {
  for (let attempt = 1; attempt <= MAX_SKIPS; attempt++) {
    const candidate = await nextInvoice();
    // בדיקה על האינדקס invoice_1 — שאילתה מכוסה, בלי גישה למסמכים.
    const taken = await Order.exists({ invoice: candidate });
    if (!taken) return candidate;
    console.warn(`[invoice] מספר ${candidate} כבר תפוס — מדלג`);
  }

  throw new Error(
    `הקצאת מספר הזמנה נכשלה — ${MAX_SKIPS} מספרים רצופים תפוסים`
  );
};

// nextInvoice נשאר פנימי: מסלולי היצירה צריכים תמיד מספר *פנוי*, ואין סיבה
// לחשוף את הפרימיטיב שמדלג על הבדיקה.
module.exports = { nextFreeInvoice };

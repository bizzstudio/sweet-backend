// lib/billing/autoDeliveryNote.js
//
// יצירה אוטומטית של תעודת משלוח כשהזמנה נכנסת למערכת.
//
// המפרט הוא "על כל הזמנה יוצאת תעודת משלוח", והטריגר הוא המעבר לסטטוס
// "טופלה" — הסטטוס היחיד שהזמנה נכנסת אליו, בכל מסלול: קליטה ממייל,
// קליטה מווצאפ, ואישור ידני של הזמנה שנכנסה ב"שגיאה בקריאה".
//
// עד 17/08/26 הטריגר היה המעבר ל"נמסרה", מהנימוק שהזמנה שנקלטה עדיין
// משתנה — פריט חסר במלאי יורד, כמות מתוקנת — ותעודה שהופקה בקליטה הייתה
// מתארת משלוח שלא קרה. הנימוק נכון, והמענה שלו הוא deliveryNotes.syncFromOrder:
// כל שינוי בהזמנה מרענן את התעודה כל עוד היא לא חויבה. במקום תעודה שמחכה
// לפעולה ידנית שאיש לא זוכר לבצע, יש תעודה שקיימת מהרגע הראשון ועוקבת
// אחרי ההזמנה.
//
// שקיפות: הפונקציה לעולם לא זורקת. כשלון ביצירת תעודה אסור שיפיל את
// קליטת ההזמנה או את עדכון הסטטוס — ההזמנה נקלטה וזו עובדה, גם אם התעודה
// נכשלה. הכשלון נרשם ללוג, והתעודה ניתנת להפקה ידנית מהמסך.

const { createFromOrder } = require("./deliveryNotes");
const { NO_PAYMENT_METHOD } = require("../../utils/paymentDisabled");

// שמות הסטטוס שמשמעותו "ההזמנה נקלטה וטופלה". "Processing" הוא השם
// הפנימי שכל הקוד מחפש לפיו (Status.findOne({ name: "Processing" }));
// "טופלה" הוא השם שמוצג בפאנל, ו"בטיפול" הוא השם שהוצג עד השינוי.
// מוחזק כרשימה כי logStatusChange מקבל לפעמים את השם העברי.
const HANDLED_STATUS_NAMES = ["Processing", "טופלה", "בטיפול"];

// שמות הסטטוסים שמשמעותם "ההזמנה נמסרה ללקוח". הסטטוס כובה בפאנל, אבל
// הזיהוי נשאר: הזמנה היסטורית שתסומן כך ידנית עדיין צריכה לקבל תעודה,
// והיא לא תקבל אותה משום מקום אחר.
const DELIVERED_STATUS_NAMES = ["Delivered", "נמסר", "נמסרה", "סופק"];

const matchesAny = (statusName, names) =>
  names.some(
    (name) => String(statusName || "").trim().toLowerCase() === name.toLowerCase()
  );

const isHandledStatus = (statusName) => matchesAny(statusName, HANDLED_STATUS_NAMES);
const isDeliveredStatus = (statusName) => matchesAny(statusName, DELIVERED_STATUS_NAMES);

/** האם הסטטוס הזה אמור להפיק תעודה. */
const isNoteTriggerStatus = (statusName) =>
  isHandledStatus(statusName) || isDeliveredStatus(statusName);

/*
 * הזמנה שנשמרה בחנות ללא סליקה (paymentMethod === "noPayment") אינה מחויבת
 * אוטומטית.
 *
 * מה **כן** קורה לה: התעודה נוצרת ונכנסת לתור ההדפסה כרגיל. התעודה אינה
 * חשבונית — היא הנייר שיוצא עם הסחורה, וגם סוג המסמך היחיד שהמערכת מדפיסה
 * (models/PrintJob.js). חסימת היצירה הייתה משאירה כל הזמנת אתר בלי נייר.
 *
 * מה **לא** קורה לה: החיוב המיידי (billNoteImmediately) — הנתיב היחיד שמפיק
 * חשבונית מס בלי שאדם ביקש. הזמנה שאיש לא חויב עליה לא תהפוך לחשבונית
 * מעצמה. החשבונית החודשית ממילא אינה אוטומטית: closeMonth מופעל ידנית
 * ללקוח מסוים, וההחלטה נשארת של הצוות.
 *
 * הבדיקה היא על **ההזמנה** ולא על נקודת הקריאה בכוונה: הסינון היה דולף אילו
 * היה תלוי בקוראים. ההזמנה נכנסת ל-Processing ברגע השמירה, אבל אחר כך הצוות
 * מזיז אותה בפאנל, וכל מעבר חוזר דרך "טופלה"/"נמסרה" מגיע שוב לכאן.
 */
const isNoPaymentOrder = (order) => order?.paymentMethod === NO_PAYMENT_METHOD;

/**
 * נקרא אחרי שינוי סטטוס הזמנה. יוצר תעודה אם הסטטוס החדש הוא "טופלה".
 *
 * @param {object} p
 * @param {string} p.orderId
 * @param {string} p.toStatusName - שם הסטטוס החדש
 * @param {string} [p.changedBy]
 * @returns {Promise<object|null>} התעודה, או null אם לא נוצרה
 */
const onOrderStatusChange = async ({ orderId, toStatusName, changedBy }) => {
  if (!isNoteTriggerStatus(toStatusName)) return null;

  try {
    const { note, created, pendingManual } = await createFromOrder(orderId, {
      issuedBy: changedBy || "אוטומטי — קליטת ההזמנה",
    });

    // סחורה נשקלת (פירות וירקות) לא נכנסת לתעודה האוטומטית — היא ממתינה
    // להקלדה ידנית עם המשקל שנשקל. נרשם ללוג כדי שסחורה שנמסרה ולא הוקלדה
    // לא תישאר בלתי מחויבת בשקט; המסך מציג את אותו מידע ליד ההזמנה.
    if (pendingManual?.length) {
      console.log(
        `[delivery-note] הזמנה ${orderId}: ${pendingManual.length} שורות נשקלות ` +
          `ממתינות לתעודה ידנית (${pendingManual.map((i) => i.name).join(", ")})`
      );
    }

    if (created) {
      console.log(
        `[delivery-note] תעודה ${note.number} נוצרה אוטומטית להזמנה ${note.orderNumber}`
      );

      // לקוח במסלול perDelivery מקבל חשבונית מס מיד ולא ממתין לסוף החודש.
      // הפונקציה בודקת בעצמה את מצב הלקוח ואינה זורקת — לקוח רגיל פשוט
      // לא יחויב, ולכן אין כאן תנאי על מסלול החיוב של הלקוח.
      //
      // ⚠️ מאז שהטריגר עבר לקליטת ההזמנה, "מיד" פירושו **ברגע שההזמנה
      // נקלטת** ולא ברגע שהסחורה יוצאת. אצל לקוח perDelivery זה אומר
      // חשבונית מס ב-iCount לפני שמישהו ליקט או שקל, ומרגע זה התעודה
      // נעולה והסנכרון כבר לא יתקן אותה. נכון ל-17/08/26 אין אף לקוח
      // במסלול הזה (נבדק: 0 מתוך 769), ולכן זו אינה התנהגות פעילה — אבל
      // לפני שמסמנים לקוח ראשון כ-perDelivery יש להכריע בזה.
      //
      // רק על תעודה שנוצרה עכשיו: תעודה קיימת כבר עברה את המסלול הזה,
      // וקריאה חוזרת על תעודה שכבר חויבה לא תעשה כלום ממילא (הסטטוס
      // אינו "open") — אבל אין סיבה לשלם על הבדיקה.
      //
      // התנאי היחיד כאן הוא על **ההזמנה**: הזמנה שנשמרה ללא סליקה מדלגת
      // על השלב הזה (ראה isNoPaymentOrder). זהו הנתיב היחיד שמפיק חשבונית
      // מס בלי בקשה אנושית, והזמנה שאיש לא חויב עליה לא תהפוך לחשבונית
      // מעצמה. השליפה כאן ולא לפני createFromOrder בכוונה: כך תקלת מסד
      // בשליפה אינה יכולה למנוע את יצירת התעודה (הנייר שיוצא עם הסחורה),
      // והיא גם רצה רק כשבאמת נוצרה תעודה חדשה ולא בכל מעבר סטטוס.
      //
      // try נפרד: כשל כאן אינו "יצירת התעודה נכשלה", וההודעה של ה-catch
      // החיצוני הייתה מטעה. הכיוון הוא fail-closed בכוונה — אם אי אפשר
      // לדעת אם ההזמנה שולמה, לא מחייבים. חשבונית מס שהופקה בטעות נרשמת
      // בספרים ואפשר לתקן אותה רק בזיכוי; חיוב שלא קרה מתקנים בלחיצה.
      try {
        const Order = require("../../models/Order");
        const order = await Order.findById(orderId).select("paymentMethod").lean();

        if (isNoPaymentOrder(order)) {
          console.log(
            `[billing] תעודה ${note.number} — ההזמנה נשמרה ללא תשלום, אין חיוב אוטומטי ` +
              `(חיוב נעשה ידנית ממסך ההזמנה)`
          );
        } else {
          // catch גם כאן ולא רק בתוך הפונקציה: הקריאה אינה ב-await, ודחייה
          // שאינה נתפסת מפילה את התהליך ב-Node 24. שכבת הגנה שנייה — זולה
          // ומונעת קריסת שרת מתקלה בזרימת משנה.
          require("./monthlyBilling")
            .billNoteImmediately(note._id)
            .catch((err) =>
              console.error(`[billing] חיוב מיידי נכשל בזרימה האוטומטית: ${err.message}`)
            );
        }
      } catch (billingGateError) {
        console.error(
          `[billing] לא ניתן היה לקבוע אם הזמנה ${orderId} שולמה — ` +
            `החיוב המיידי דולג לבטיחות: ${billingGateError.message}`
        );
      }
    }
    return note;
  } catch (err) {
    // הזמנה ריקה, לקוח חסר, או כשלון מסד. לא מפיל את עדכון הסטטוס.
    console.error(
      `[delivery-note] יצירה אוטומטית להזמנה ${orderId} נכשלה: ${err.message}\n` +
        `                ניתן להפיק ידנית ממסך ההזמנה.`
    );
    return null;
  }
};

/**
 * השלמה רטרואקטיבית: הזמנות שכבר בסטטוס מפיק־תעודה ואין להן תעודה.
 *
 * מכסה את שתי הקבוצות — הזמנות ב"טופלה" שנקלטו לפני שהטריגר עבר לכאן,
 * והזמנות היסטוריות ב"נמסרה". שתיהן סחורה שיצאה ללקוח בלי תעודה, כלומר
 * בלי חיוב.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @returns {Promise<{created: number, skipped: number, failed: number}>}
 */
const backfill = async ({ dryRun = false } = {}) => {
  const Order = require("../../models/Order");
  const DeliveryNote = require("../../models/DeliveryNote");
  const mongoose = require("mongoose");

  const statuses = await mongoose.connection
    .collection("status")
    .find({ name: { $in: [...HANDLED_STATUS_NAMES, ...DELIVERED_STATUS_NAMES] } })
    .toArray();

  if (!statuses.length) {
    console.warn("[delivery-note] לא נמצא סטטוס 'טופלה' — אין מה להשלים");
    return { created: 0, skipped: 0, failed: 0 };
  }

  // אין כאן סינון של הזמנות ללא תשלום: backfill קורא ל-createFromOrder ישירות
  // ואינו נוגע ב-billNoteImmediately, כלומר הוא משלים נייר חסר ולא מחייב איש.
  const delivered = await Order.find({ status: { $in: statuses.map((s) => s._id) } })
    .select("_id invoice")
    .lean();

  const withNotes = new Set(
    (await DeliveryNote.find({ order: { $in: delivered.map((o) => o._id) } })
      .select("order")
      .lean()).map((n) => String(n.order))
  );

  const missing = delivered.filter((o) => !withNotes.has(String(o._id)));
  console.log(
    `[delivery-note] ${delivered.length} הזמנות טופלו · ${withNotes.size} עם תעודה · ${missing.length} חסרות`
  );

  if (dryRun) return { created: 0, skipped: missing.length, failed: 0 };

  // manualOnly נספר בנפרד ולא כ-skipped: הזמנה שכולה סחורה נשקלת לא
  // "דולגה" — היא ממתינה להקלדה ידנית, וערבוב שלה עם הזמנות שכבר יש להן
  // תעודה היה מסתיר בדיוק את הרשימה שצריך לטפל בה
  const stats = { created: 0, skipped: 0, manualOnly: 0, failed: 0 };
  const pendingOrders = [];

  for (const order of missing) {
    try {
      const { created, reason } = await createFromOrder(order._id, {
        issuedBy: "השלמה רטרואקטיבית",
      });

      if (created) stats.created++;
      else if (reason === "manualOnly") {
        stats.manualOnly++;
        pendingOrders.push(order.invoice);
      } else stats.skipped++;
    } catch (err) {
      stats.failed++;
      console.error(`  הזמנה ${order.invoice}: ${err.message}`);
    }
  }

  if (pendingOrders.length) {
    console.log(
      `[delivery-note] ${pendingOrders.length} הזמנות כולן סחורה נשקלת וממתינות ` +
        `לתעודה ידנית: ${pendingOrders.join(", ")}`
    );
  }

  return stats;
};

// isHandledStatus / isDeliveredStatus והרשימות עצמן נשארים פנימיים:
// ההבחנה ביניהם היא פרט מימוש, ומי שמחוץ למודול צריך לדעת רק אם הסטטוס
// מפיק תעודה.
module.exports = { onOrderStatusChange, backfill, isNoteTriggerStatus };

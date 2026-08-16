// lib/billing/autoDeliveryNote.js
//
// יצירה אוטומטית של תעודת משלוח כשהזמנה נמסרת.
//
// המפרט הוא "על כל הזמנה יוצאת תעודת משלוח". השאלה היא *מתי* — והתשובה
// אינה "כשההזמנה נוצרת":
//
//   הזמנה שנקלטה עדיין משתנה. פריט חסר במלאי יורד, כמות מתוקנת, ומחיר
//   מתעדכן. תעודה שהופקה ברגע הקליטה הייתה מתארת משלוח שלא קרה, ומכיוון
//   שהיא צילום מצב היא לא הייתה מתעדכנת אחריה. החשבונית החודשית נבנית
//   מהתעודות, ולכן טעות כאן הופכת לטעות בחיוב.
//
// לכן הטריגר הוא מעבר לסטטוס "Delivered" — הרגע שבו ידוע מה נמסר בפועל.
//
// שקיפות: הפונקציה לעולם לא זורקת. כשלון ביצירת תעודה אסור שיפיל עדכון
// סטטוס הזמנה — העובד סימן "נמסר" וזו עובדה, גם אם התעודה נכשלה. הכשלון
// נרשם ללוג, והתעודה ניתנת להפקה ידנית מהמסך.

const { createFromOrder } = require("./deliveryNotes");

// שמות הסטטוסים שמשמעותם "ההזמנה נמסרה ללקוח". מוחזק כרשימה ולא כערך
// יחיד כי שמות הסטטוסים נערכים מהפאנל, ורשימה קלה להרחבה בלי לגעת בלוגיקה.
const DELIVERED_STATUS_NAMES = ["Delivered", "נמסר", "נמסרה", "סופק"];

const isDeliveredStatus = (statusName) =>
  DELIVERED_STATUS_NAMES.some(
    (name) => String(statusName || "").trim().toLowerCase() === name.toLowerCase()
  );

/**
 * נקרא אחרי שינוי סטטוס הזמנה. יוצר תעודה אם הסטטוס החדש הוא "נמסר".
 *
 * @param {object} p
 * @param {string} p.orderId
 * @param {string} p.toStatusName - שם הסטטוס החדש
 * @param {string} [p.changedBy]
 * @returns {Promise<object|null>} התעודה, או null אם לא נוצרה
 */
const onOrderStatusChange = async ({ orderId, toStatusName, changedBy }) => {
  if (!isDeliveredStatus(toStatusName)) return null;

  try {
    const { note, created, pendingManual } = await createFromOrder(orderId, {
      issuedBy: changedBy || "אוטומטי — מעבר לנמסר",
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
      // הפונקציה בודקת בעצמה את מצב הלקוח ואינה זורקת, ולכן אין כאן תנאי
      // ואין try — לקוח רגיל פשוט לא יחויב.
      //
      // רק על תעודה שנוצרה עכשיו: תעודה קיימת כבר עברה את המסלול הזה,
      // וקריאה חוזרת על תעודה שכבר חויבה לא תעשה כלום ממילא (הסטטוס
      // אינו "open") — אבל אין סיבה לשלם על הבדיקה.
      // catch גם כאן ולא רק בתוך הפונקציה: הקריאה אינה ב-await, ודחייה
      // שאינה נתפסת מפילה את התהליך ב-Node 24. שכבת הגנה שנייה — זולה
      // ומונעת קריסת שרת מתקלה בזרימת משנה.
      require("./monthlyBilling")
        .billNoteImmediately(note._id)
        .catch((err) =>
          console.error(`[billing] חיוב מיידי נכשל בזרימה האוטומטית: ${err.message}`)
        );
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
 * השלמה רטרואקטיבית: הזמנות שכבר נמסרו לפני שההפעלה האוטומטית קיימת,
 * ואין להן תעודה.
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
    .find({ name: { $in: DELIVERED_STATUS_NAMES } })
    .toArray();

  if (!statuses.length) {
    console.warn("[delivery-note] לא נמצא סטטוס 'נמסר' — אין מה להשלים");
    return { created: 0, skipped: 0, failed: 0 };
  }

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
    `[delivery-note] ${delivered.length} הזמנות נמסרו · ${withNotes.size} עם תעודה · ${missing.length} חסרות`
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

module.exports = { onOrderStatusChange, backfill, isDeliveredStatus, DELIVERED_STATUS_NAMES };

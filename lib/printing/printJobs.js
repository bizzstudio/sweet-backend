// lib/printing/printJobs.js
//
// הוספת מסמך לתור ההדפסה, והוצאה ממנו.
//
// כל מי שיוצר תעודת משלוח קורא ל-queueDeliveryNote. בזרימה האוטומטית היא
// **אינה נקראת ב-await ואינה זורקת**: תקלה בהדפסה אסור שתפיל יצירת תעודה,
// ובוודאי לא את קליטת ההזמנה שמעליה. התעודה היא המסמך שממנו מחייבים;
// הנייר הוא נוחות.
//
// ⚠️ הפונקציה מחזירה תוצאה ולא void, ומי שקורא לה בעקבות פעולה מפורשת של
//    משתמש ("שלח שוב למדפסת") **חייב לבדוק אותה**. פעולה שנכשלה בשקט
//    והוצגה כהצלחה גרועה מפעולה שלא הייתה — המשתמש הולך לחפש את הנייר.
//
// הכיבוי הוא PRINTING_ENABLED=false ב-.env. קיים כדי שסביבת פיתוח לא
// תמלא את התור במשימות שאף סוכן לא ימשוך, ושאפשר יהיה לעצור הדפסות
// בלי לפרוס קוד.

const PrintJob = require("../../models/PrintJob");

const isEnabled = () => String(process.env.PRINTING_ENABLED || "true").toLowerCase() !== "false";

/**
 * מוסיף תעודת משלוח לתור ההדפסה.
 *
 * חוזר על עצמו בבטחה: מסמך שכבר בתור לא מקבל רשומה שנייה (אינדקס ייחודי
 * על docType+docId), ולכן שתי זרימות שמנסות להדפיס את אותה תעודה מייצרות
 * נייר אחד.
 *
 * @param {object} note - מסמך התעודה (או לפחות _id ו-number)
 * @param {object} [opts]
 * @param {string} [opts.requestedBy] - "אוטומטי" או מייל המשתמש
 * @param {boolean} [opts.reprint] - הדפסה חוזרת מכוונת: מאפסת משימה קיימת
 *        שכבר הודפסה, נכשלה או בוטלה, כדי שתצא שוב
 * @returns {Promise<{queued: boolean, reason: string}>} לעולם אינו נדחה.
 *          reason: queued | alreadyQueued | disabled | noNote | error
 */
const queueDeliveryNote = async (note, { requestedBy = "אוטומטי", reprint = false } = {}) => {
  if (!note?._id) return { queued: false, reason: "noNote" };
  if (!isEnabled()) return { queued: false, reason: "disabled" };

  const key = { docType: "deliveryNote", docId: note._id };

  try {
    if (reprint) {
      // הדפסה חוזרת מאפסת את הרשומה במקום ליצור שנייה. attempts מתאפס כדי
      // שמשימה שנכשלה 3 פעמים (למשל המדפסת הייתה כבויה) תקבל סבב מלא חדש.
      //
      // ⚠️ זה כולל משימה שנמצאת כרגע ב-printing. הסוכן שמחזיק בה ידווח
      //    בסיום, אבל הדיווח מותנה ב-status:"printing" (ראו
      //    printJobController.markPrinted) ולכן לא ידרוס את האיפוס הזה.
      await PrintJob.findOneAndUpdate(
        key,
        {
          $set: {
            ...key,
            docNumber: note.number,
            status: "pending",
            attempts: 0,
            lockedAt: null,
            printedAt: null,
            lastError: null,
            requestedBy,
          },
        },
        { upsert: true }
      );
      return { queued: true, reason: "queued" };
    }

    const existing = await PrintJob.findOneAndUpdate(
      key,
      {
        $setOnInsert: {
          ...key,
          docNumber: note.number,
          status: "pending",
          attempts: 0,
          requestedBy,
        },
      },
      { upsert: true, new: false }
    );

    // new:false מחזיר null כשהמסמך נוצר עכשיו, ואת הישן כשהוא כבר היה.
    // זו ההבחנה בין "נכנס לתור" ל"כבר היה בתור".
    return existing
      ? { queued: false, reason: "alreadyQueued" }
      : { queued: true, reason: "queued" };
  } catch (err) {
    // E11000 = שתי קריאות מקבילות על אותה תעודה. זו בדיוק ההגנה שרצינו,
    // ולא תקלה — הראשונה נכנסה לתור, וזה מספיק.
    if (err.code === 11000) return { queued: false, reason: "alreadyQueued" };
    console.error(
      `[print] הוספת תעודה ${note.number || note._id} לתור ההדפסה נכשלה: ${err.message}`
    );
    return { queued: false, reason: "error" };
  }
};

/**
 * מוציא מהתור תעודה שבוטלה, אם הנייר עוד לא יצא.
 *
 * בלי זה תעודה שבוטלה שניות אחרי שנוצרה — וזה קורה, `syncFromOrder` מבטל
 * תעודה של הזמנה שרוקנה מפריטים — עדיין יוצאת מהמדפסת. נייר של מסמך
 * מבוטל שמגיע ללקוח הוא בדיוק סוג הטעות שאיש לא מגלה עד שהוא מתקשר.
 *
 * רק משימה שעדיין `pending` מבוטלת. משימה שכבר הודפסה (או שהסוכן מחזיק
 * בה כרגע) נשארת כמו שהיא — הנייר כבר קיים במציאות, ושכתוב הרישום לא
 * יחזיר אותו.
 *
 * @returns {Promise<boolean>} האם משימה ממתינה אכן בוטלה
 */
const cancelDeliveryNotePrint = async (noteId, reason) => {
  if (!noteId) return false;

  try {
    const res = await PrintJob.updateOne(
      { docType: "deliveryNote", docId: noteId, status: "pending" },
      { $set: { status: "cancelled", lockedAt: null, lastError: reason || "התעודה בוטלה" } }
    );
    return res.modifiedCount > 0;
  } catch (err) {
    console.error(`[print] ביטול משימת ההדפסה של תעודה ${noteId} נכשל: ${err.message}`);
    return false;
  }
};

/**
 * גרסה לזרימה האוטומטית: לא מחזירה כלום ולא צריך לעטוף אותה ב-catch.
 *
 * הקורא אינו ממתין לה בכוונה — הסוכן מושך את התור ב-polling, ואין שום
 * סיבה שיצירת התעודה תמתין לסבב DB נוסף.
 */
const queueDeliveryNoteSafe = (note, opts) => {
  queueDeliveryNote(note, opts).catch((err) =>
    console.error(`[print] שגיאה לא צפויה בהוספה לתור: ${err.message}`)
  );
};

module.exports = {
  queueDeliveryNote,
  queueDeliveryNoteSafe,
  cancelDeliveryNotePrint,
  isEnabled,
};

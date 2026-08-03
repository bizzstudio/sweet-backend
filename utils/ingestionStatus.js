// utils/ingestionStatus.js
//
// הסטטוס "שגיאה בקריאה" — הזמנות שנקלטו מהמייל/ווצאפ אבל לא נקראו במלואן.
// ההזמנה נוצרת עם מה שכן נקרא, ומחכה שאדם ישלים אותה ויעביר אותה ל"בטיפול".
//
// המודול הזה עומד בפני עצמו (בלי תלות ב-lib/order-ingestion) כדי ש-orderController
// יוכל להחריג את הסטטוס מרשימות בלי לגרור את כל צינור הקליטה.
//
// ── שתי נקודות עדינות בסכמת Status ──
//
// 1. הרשומה נוצרת *בלי* השדה phone.
//    הדשבורד מזהה מלקטים ב-`Status.find({ phone: { $exists: true } })`, וחמשת
//    הסטטוסים הבסיסיים נזרעים עם `phone: ""` — כלומר הם *כן* נתפסים בשאילתה
//    הזו ונכללים בסכימת ההכנסות. סטטוס בלי השדה בכלל נשאר מחוץ לחישוב, וזה
//    בדיוק מה שצריך: להזמנה שבורה יש סכום חלקי שאסור להיכנס לדוחות.
//
// 2. הרשומה נוצרת ב-updateOne+upsert ולא ב-new Status().save().
//    בסכמה `phone` מוגדר required, ו-save היה נכשל. upsert לא מפעיל ולידטורים —
//    אותה דרך שבה script/init-db.js זורע את הסטטוסים.

const Status = require("../models/Status");

// שם פנימי (באנגלית, כמו שאר הסטטוסים) ושם תצוגה בעברית
const INGESTION_ERROR_STATUS = "IngestionError";
const INGESTION_ERROR_STATUS_HE = "שגיאה בקריאה";
const INGESTION_ERROR_STATUS_COLOR = "#dc2626";

let cachedId = null;

/**
 * מחזיר את מסמך הסטטוס, ויוצר אותו אם אינו קיים.
 * נקרא בזמן ריצה כדי שלא תהיה תלות בהרצת init-db בשרת קיים.
 */
const ensureIngestionErrorStatus = async () => {
  await Status.updateOne(
    { name: INGESTION_ERROR_STATUS },
    {
      $setOnInsert: {
        name: INGESTION_ERROR_STATUS,
        heName: INGESTION_ERROR_STATUS_HE,
        color: INGESTION_ERROR_STATUS_COLOR,
        isActive: true,
        // בכוונה בלי phone — ראה ההסבר בראש הקובץ
      },
    },
    { upsert: true }
  );

  const status = await Status.findOne({ name: INGESTION_ERROR_STATUS });
  cachedId = status?._id || null;
  return status;
};

/**
 * מזהה הסטטוס לצורך החרגה משאילתות, או null אם הוא לא קיים עדיין.
 * לא יוצר את הסטטוס — קורא בלבד, כדי שרשימות לא ייצרו נתונים כתופעת לוואי.
 */
const getIngestionErrorStatusId = async () => {
  if (cachedId) return cachedId;
  const status = await Status.findOne({ name: INGESTION_ERROR_STATUS }).select("_id");
  cachedId = status?._id || null;
  return cachedId;
};

module.exports = {
  INGESTION_ERROR_STATUS,
  INGESTION_ERROR_STATUS_HE,
  INGESTION_ERROR_STATUS_COLOR,
  ensureIngestionErrorStatus,
  getIngestionErrorStatusId,
};

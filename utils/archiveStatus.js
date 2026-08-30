// utils/archiveStatus.js
//
// הסטטוס "הזמנת ארכיון" — הזמנות שנוצרו מייבוא היסטוריה מההנהח"ש, ולא נקלטו
// מהחנות, מהמייל או מהווצאפ. הן תיעוד של מה שכבר קרה: הסחורה יצאה, החשבונית
// הופקה בהנהח"ש, ואין בהן שום דבר לעשות.
//
// ── למה סטטוס נפרד ולא "סופקה" ──
//
// המערכת נשענת על הסטטוס כדי לדעת מה לעשות עם הזמנה: להוריד מלאי, לשלוח
// למלקטים, להפיק תעודת משלוח, לספור בהכנסות. הזמנת ארכיון לא צריכה אף אחד
// מאלה — הכל כבר נעשה, מחוץ למערכת. שימוש ב"סופקה" היה מכפיל את ההכנסות
// בדשבורד מול מה שההנהח"ש כבר מדווחת.
//
// ── שתי נקודות עדינות בסכמת Status, זהות ל-ingestionStatus ──
//
// 1. הרשומה נוצרת *בלי* השדה phone.
//    הדשבורד מזהה מלקטים ב-`Status.find({ phone: { $exists: true } })`, וכל
//    השאילתות של ההכנסות בנויות על הרשימה ההיא. סטטוס בלי השדה בכלל נשאר
//    מחוץ לחישוב — וזה בדיוק מה שצריך כאן.
//
// 2. הרשומה נוצרת ב-updateOne+upsert ולא ב-new Status().save().
//    בסכמה `phone` מוגדר required, ו-save היה נכשל. upsert לא מפעיל ולידטורים.

const Status = require("../models/Status");

const ARCHIVE_STATUS = "Archive";
const ARCHIVE_STATUS_HE = "הזמנת ארכיון";
const ARCHIVE_STATUS_COLOR = "#6b7280";

let cachedId = null;

/**
 * מחזיר את מסמך הסטטוס, ויוצר אותו אם אינו קיים.
 * נקרא בזמן ריצה כדי שלא תהיה תלות בהרצת init-db בשרת קיים.
 */
const ensureArchiveStatus = async () => {
  await Status.updateOne(
    { name: ARCHIVE_STATUS },
    {
      $setOnInsert: {
        name: ARCHIVE_STATUS,
        heName: ARCHIVE_STATUS_HE,
        color: ARCHIVE_STATUS_COLOR,
        isActive: true,
        // בכוונה בלי phone — ראה ההסבר בראש הקובץ
      },
    },
    { upsert: true }
  );

  const status = await Status.findOne({ name: ARCHIVE_STATUS });
  cachedId = status?._id || null;
  return status;
};

/**
 * מזהה הסטטוס לצורך החרגה משאילתות, או null אם הוא לא קיים עדיין.
 * לא יוצר את הסטטוס — קורא בלבד, כדי שרשימות ודוחות לא ייצרו נתונים
 * כתופעת לוואי.
 */
const getArchiveStatusId = async () => {
  if (cachedId) return cachedId;
  const status = await Status.findOne({ name: ARCHIVE_STATUS }).select("_id");
  cachedId = status?._id || null;
  return cachedId;
};

/**
 * תנאי החרגה מוכן לשילוב בשאילתה, או null כשהסטטוס אינו קיים.
 *
 * מוחזר כתנאי ולא כמזהה כדי שכל קורא יכתוב את אותו הדבר: השכחה של אחד
 * מהדוחות היא בדיוק סוג הכשל השקט שהסטטוס הזה נועד למנוע.
 */
const archiveExclusionFilter = async () => {
  const id = await getArchiveStatusId();
  return id ? { status: { $ne: id } } : {};
};

module.exports = {
  ARCHIVE_STATUS,
  ARCHIVE_STATUS_HE,
  ARCHIVE_STATUS_COLOR,
  ensureArchiveStatus,
  getArchiveStatusId,
  archiveExclusionFilter,
};

const Status = require("../models/Status");

// שמות הסטטוסים שהמערכת מחפשת לפי name: הזמנה חדשה נפתחת ב-
// Status.findOne({ name: "Pending" }), הקליטה מעבירה ל-"Processing",
// והדוחות מחפשים "Likut"/"Delivered"/"Cancel"/"IngestionError".
//
// רשומת מלקט נוצרת עם name ששווה לשם המשתמש, ולכן מלקט בשם "Pending"
// היה יכול לחזור מהחיפושים האלה במקום הסטטוס האמיתי — הזמנות חדשות היו
// מקבלות סטטוס שגוי. השמות האלה חסומים לשימוש כשם משתמש.
const RESERVED_STATUS_NAMES = [
  "Pending",
  "Processing",
  "Likut",
  "Delivered",
  "Cancel",
  "IngestionError",
];

const isReservedName = (value) =>
  RESERVED_STATUS_NAMES.some(
    (reserved) => reserved.toLowerCase() === String(value || "").toLowerCase()
  );

// שם המשתמש הוא מפתח ההתחברות לאפליקציית הליקוט, ולכן חייב להיות ייחודי.
// הבדיקה נעשית כאן ולא באינדקס unique — ראה ההסבר ב-models/Status.js.
// excludeId מאפשר לרשומה בעריכה לשמור על שם המשתמש הקיים שלה.
const isUsernameTaken = async (username, excludeId) => {
  if (!username) return false;
  const query = { username };
  if (excludeId) query._id = { $ne: excludeId };
  return Boolean(await Status.findOne(query));
};

// שתי בקשות מקבילות יכולות לעבור את isUsernameTaken ולהיכשל רק באינדקס
// הייחודי. E11000 הוא אותה שגיאה מבחינת המשתמש — שם המשתמש תפוס.
const isDuplicateKeyError = (err) => err?.code === 11000;

const createStatus = async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();

    if (isReservedName(username)) {
      return res.status(409).send({ message: "שם המשתמש שמור למערכת, יש לבחור אחר" });
    }

    if (await isUsernameTaken(username)) {
      return res.status(409).send({ message: "שם המשתמש כבר תפוס" });
    }

    const status = new Status({
      ...req.body,
      // מחרוזת ריקה לא נשמרת: שתי רשומות עם username ריק היו נחשבות
      // כפילות, ומזהה ריק בהתחברות לא אמור להתאים לאף אחד.
      username: username || undefined,
    });
    await status.save();
    res.status(201).send({ data: status, message: "Status created successfully!" });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      return res.status(409).send({ message: "שם המשתמש כבר תפוס" });
    }
    res.status(400).send(err);
  }
};

const getAllStatuses = async (req, res) => {
  try {
    const filter = req.query.getAll === 'true' ? {} : { isActive: true };
    const statuses = await Status.find(filter).sort({ isActive: -1 });
    res.send(statuses);
  } catch (err) {
    res.status(500).send(err);
  }
};

// רשימת המלקטים לדף הניהול, כולל הסיסמאות — הן מוצגות שם מאחורי כפתור עין.
//
// נתיב נפרד, ולא דגל על getAllStatuses: אותו handler מוגש גם תחת
// /api/app/orders/status/getAll מאחורי isApp, כלומר לכל מלקט מחובר. דגל
// כזה היה מאפשר למלקט אחד לשלוף את הסיסמאות של כל השאר. הנתיב הזה רשום
// רק ב-statusRoutes, שכולו מאחורי isAdmin.
const getAllMelaketim = async (req, res) => {
  try {
    const melaketim = await Status.find({
      $or: [
        { isMelaket: true },
        // מלקטים ותיקים, מלפני שהדגל נוסף. סטטוסי ההזמנות נזרעים עם
        // phone: "" ולכן נשארים מחוץ לרשימה, ו-IngestionError נוצר בלי
        // השדה בכלל.
        { phone: { $exists: true, $nin: ["", null] } },
      ],
    })
      .select('+password')
      .sort({ isActive: -1, heName: 1 });

    res.send(melaketim);
  } catch (err) {
    res.status(500).send(err);
  }
};

const getStatusById = async (req, res) => {
  try {
    const status = await Status.findById(req.params.id).select('+password');
    if (!status) {
      return res.status(404).send();
    }
    res.send(status);
  } catch (err) {
    res.status(500).send(err);
  }
};

const getStatusByName = async (req, res) => {
  try {
    const status = await Status.findOne({ name: req.params.name });
    if (!status) {
      return res.status(404).send();
    }
    res.send(status);
  } catch (err) {
    res.status(500).send(err);
  }
};

const updateStatus = async (req, res) => {
  try {
    const status = await Status.findById(req.params.id).select('+password');

    if (!status) {
      return res.status(404).send();
    }

    if (req.body.username !== undefined) {
      const username = String(req.body.username || "").trim();
      if (isReservedName(username)) {
        return res.status(409).send({ message: "שם המשתמש שמור למערכת, יש לבחור אחר" });
      }
      if (await isUsernameTaken(username, status._id)) {
        return res.status(409).send({ message: "שם המשתמש כבר תפוס" });
      }
      status.username = username || undefined;
    }

    status.name = req.body.name || status.name;
    status.heName = req.body.heName || status.heName;
    // בדיקת undefined ולא falsy: מאז שהטלפון אינו חובה למלקט, שליחת
    // מחרוזת ריקה היא בקשה מפורשת לנקות אותו. עם `||` הניקוי היה נבלע
    // בשקט והשדה הישן היה נשאר. קריאות ששולחות רק isActive לא נוגעות בו.
    status.phone = req.body.phone !== undefined ? req.body.phone : status.phone;
    status.color = req.body.color || status.color;
    status.isActive = req.body.isActive !== undefined ? req.body.isActive : status.isActive;
    status.password = req.body.password !== undefined ? req.body.password : status.password;
    status.isMelaket = req.body.isMelaket !== undefined ? req.body.isMelaket : status.isMelaket;
    await status.save();
    res.send({ data: status, message: "Status updated successfully!" });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      return res.status(409).send({ message: "שם המשתמש כבר תפוס" });
    }
    res.status(400).send(err);
  }
};

const deleteStatus = async (req, res) => {
  try {
    const status = await Status.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: false } },
      { new: true }
    );

    if (!status) {
      return res.status(404).send();
    }

    res.status(200).send({
      message: "Status Updated to Inactive Successfully!",
    });
  } catch (err) {
    res.status(500).send(err);
  }
};


const deleteManyStatuses = async (req, res) => {
  try {
    await Status.updateMany(
      { _id: { $in: req.body.ids } },
      { $set: { isActive: false } }
    );
    res.status(200).send({
      message: "Statuses Updated to Inactive Successfully!",
    });
  } catch (err) {
    console.log('deleteManyStatuses error: ', err);
    res.status(500).send(err);
  }
};


module.exports = {
  createStatus,
  getAllStatuses,
  getAllMelaketim,
  getStatusById,
  getStatusByName,
  updateStatus,
  deleteStatus,
  deleteManyStatuses,
};

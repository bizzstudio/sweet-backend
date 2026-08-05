const Status = require("../models/Status");

// שם המשתמש הוא מפתח ההתחברות לאפליקציית הליקוט, ולכן חייב להיות ייחודי.
// הבדיקה נעשית כאן ולא באינדקס unique — ראה ההסבר ב-models/Status.js.
// excludeId מאפשר לרשומה בעריכה לשמור על שם המשתמש הקיים שלה.
const isUsernameTaken = async (username, excludeId) => {
  if (!username) return false;
  const query = { username };
  if (excludeId) query._id = { $ne: excludeId };
  return Boolean(await Status.findOne(query));
};

const createStatus = async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();

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
    res.status(400).send(err);
  }
};

const getAllStatuses = async (req, res) => {
  try {
    const filter = req.query.getAll === 'true' ? {} : { isActive: true };
    const query = Status.find(filter).sort({ isActive: -1 });

    // דף המלקטים באדמין מציג את הסיסמה מאחורי כפתור עין, ולכן צריך אותה
    // ברשימה. הנתיב כולו יושב מאחורי isAdmin, ולקוחות אחרים לא מבקשים
    // את הדגל ולכן ממשיכים לקבל תשובה בלי סיסמאות.
    if (req.query.withPassword === 'true') {
      query.select('+password');
    }

    const statuses = await query;
    res.send(statuses);
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
      if (await isUsernameTaken(username, status._id)) {
        return res.status(409).send({ message: "שם המשתמש כבר תפוס" });
      }
      status.username = username || undefined;
    }

    status.name = req.body.name || status.name;
    status.heName = req.body.heName || status.heName;
    status.phone = req.body.phone || status.phone;
    status.color = req.body.color || status.color;
    status.isActive = req.body.isActive !== undefined ? req.body.isActive : status.isActive;
    status.password = req.body.password !== undefined ? req.body.password : status.password;
    status.isMelaket = req.body.isMelaket !== undefined ? req.body.isMelaket : status.isMelaket;
    await status.save();
    res.send({ data: status, message: "Status updated successfully!" });
  } catch (err) {
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
  getStatusById,
  getStatusByName,
  updateStatus,
  deleteStatus,
  deleteManyStatuses,
};

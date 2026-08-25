// routes/customerHistoryRoutes.js
// היסטוריית הרכישות של לקוח.
//
// ── שתי רמות הרשאה, לא אחת ──
//
// קריאה: `isAdmin` — כל איש צוות פעיל, כמו כרטיס הלקוח עצמו.
//
// כתיבה ומחיקה: גם `isCustomerManager`. היסטוריה אינה תצוגה — היא קובעת אילו
// שורות הזמנה יאושרו **אוטומטית** בעתיד, כלומר איזה מוצר נשלח ללקוח בלי שאיש
// יאשר. ‏isAdmin לבדו מאשר כל תפקיד במודל האדמין, כולל Cashier, Driver ו-
// Security Guard; בלי השער הזה נהג היה יכול לשנות מה נשלח ללקוחות.
//
// זה אותו שער בדיוק שמגן על עריכת לקוח ועל המחירון (`CUSTOMER_MANAGER_ROLES`) —
// הרחבתו היא החלטה עסקית ונעשית שם, במקום אחד.
const express = require("express");
const router = express.Router();
const {
  getHistorySummary,
  getCustomerHistory,
  checkImportCustomerHistory,
  importCustomerHistory,
  deleteCustomerHistory,
} = require("../controller/customerHistoryController");
const { isCustomerManager } = require("../controller/customerController");
const { isAdmin } = require("../config/auth");

// התפקיד נבדק מול טבלת האדמינים בכל בקשה ולא נלקח מהטוקן: הטוקן תקף 21 יום,
// ובלי הבדיקה איש צוות שהושבת או הורד בדרגה היה ממשיך לשנות היסטוריות עד
// לפקיעתו. ‏isAdmin רץ לפניו וכבר אימת שהמשתמש קיים ופעיל.
const isHistoryManager = async (req, res, next) => {
  try {
    if (await isCustomerManager(req.user)) return next();
    return res.status(403).send({
      message: "אין לך הרשאה לשנות היסטוריית רכישות של לקוחות.",
    });
  } catch (err) {
    console.log("isHistoryManager error: ", err);
    return res.status(500).send({ message: err.message });
  }
};

// סיכום לכל הלקוחות (למי יש היסטוריה וכמה מוצרים) — לרשימת הלקוחות
router.get("/", isAdmin, getHistorySummary);

// בדיקה מקדימה לפני יבוא — חייב להירשם לפני "/:customerId"
router.post("/:customerId/check", isAdmin, isHistoryManager, checkImportCustomerHistory);

// ההיסטוריה של לקוח מסוים
router.get("/:customerId", isAdmin, getCustomerHistory);

// יבוא (דריסה מלאה של הקודם)
router.post("/:customerId", isAdmin, isHistoryManager, importCustomerHistory);

// הסרה — הלקוח חוזר להכרעה לפי שם בלבד
router.delete("/:customerId", isAdmin, isHistoryManager, deleteCustomerHistory);

module.exports = router;

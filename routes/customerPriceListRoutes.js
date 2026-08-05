// routes/customerPriceListRoutes.js
// המחירון הפרטי של לקוח.
//
// ── שתי רמות הרשאה, לא אחת ──
//
// קריאה: `isAdmin` — כל איש צוות פעיל, בדיוק כמו כרטיס הלקוח עצמו שמציג
// יתרות ותנאי מסחר (`GET /customer/:id/details`).
//
// כתיבה ומחיקה: גם `isCustomerManager` — מחירון קובע כמה הלקוח משלם, ו-`isAdmin`
// לבדו מאשר **כל** תפקיד במודל האדמין, כולל Cashier, Driver ו-Security Guard.
// כלומר בלעדיו נהג היה יכול להוריד ללקוח את המחירים. השער הוא אותו שער בדיוק
// שמגן על עריכת לקוח (`CUSTOMER_MANAGER_ROLES`) — הרחבתו היא החלטה עסקית
// ונעשית שם, במקום אחד.
const express = require("express");
const router = express.Router();
const {
  getPriceListSummary,
  getCustomerPriceList,
  checkImportCustomerPriceList,
  importCustomerPriceList,
  deleteCustomerPriceList,
} = require("../controller/customerPriceListController");
const { isCustomerManager } = require("../controller/customerController");
const { isAdmin } = require("../config/auth");

// התפקיד נבדק מול טבלת האדמינים בכל בקשה ולא נלקח מהטוקן: הטוקן תקף 21 יום,
// ובלי הבדיקה איש צוות שהושבת או הורד בדרגה היה ממשיך לשנות מחירים עד לפקיעתו.
// ‏isAdmin רץ לפניו וכבר אימת שהמשתמש קיים ופעיל.
const isPriceListManager = async (req, res, next) => {
  try {
    if (await isCustomerManager(req.user)) return next();
    return res.status(403).send({
      message: "אין לך הרשאה לשנות מחירונים של לקוחות.",
    });
  } catch (err) {
    console.log("isPriceListManager error: ", err);
    return res.status(500).send({ message: err.message });
  }
};

// סיכום לכל הלקוחות (למי יש מחירון וכמה שורות) — לרשימת הלקוחות
router.get("/", isAdmin, getPriceListSummary);

// בדיקה מקדימה לפני יבוא — חייב להירשם לפני "/:customerId"
router.post("/:customerId/check", isAdmin, isPriceListManager, checkImportCustomerPriceList);

// המחירון של לקוח מסוים
router.get("/:customerId", isAdmin, getCustomerPriceList);

// יבוא מחירון (דריסה מלאה של הקודם)
router.post("/:customerId", isAdmin, isPriceListManager, importCustomerPriceList);

// הסרת המחירון — הלקוח חוזר למחירי הקטלוג
router.delete("/:customerId", isAdmin, isPriceListManager, deleteCustomerPriceList);

module.exports = router;

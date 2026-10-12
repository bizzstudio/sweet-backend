// routes/groupPriceListRoutes.js
// מחירונים קבוצתיים — מחירון אחד לכמה לקוחות.
//
// אותן שתי רמות הרשאה כמו במחירון הפרטי (ראה customerPriceListRoutes.js):
// קריאה לכל איש צוות פעיל, כתיבה רק למי שמורשה לנהל לקוחות — מחירון קבוצתי
// קובע כמה משלמים כמה לקוחות בבת אחת.
const express = require("express");
const router = express.Router();
const {
  getGroupPriceLists,
  getGroupPriceList,
  checkImportGroupPriceList,
  createGroupPriceList,
  updateGroupPriceList,
  deleteGroupPriceList,
  setCustomerGroup,
} = require("../controller/groupPriceListController");
const { isCustomerManager } = require("../controller/customerController");
const { isAdmin } = require("../config/auth");

// התפקיד נבדק מול טבלת האדמינים בכל בקשה ולא נלקח מהטוקן — אותו שיקול כמו
// ב-customerPriceListRoutes
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

router.get("/", isAdmin, getGroupPriceLists);
router.post("/", isAdmin, isPriceListManager, createGroupPriceList);

// הנתיבים הקבועים נרשמים לפני "/:id", אחרת "check" ו-"customer" היו נבלעים בו
router.post("/check", isAdmin, isPriceListManager, checkImportGroupPriceList);
router.put("/customer/:customerId", isAdmin, isPriceListManager, setCustomerGroup);

router.get("/:id", isAdmin, getGroupPriceList);
router.put("/:id", isAdmin, isPriceListManager, updateGroupPriceList);
router.delete("/:id", isAdmin, isPriceListManager, deleteGroupPriceList);

module.exports = router;

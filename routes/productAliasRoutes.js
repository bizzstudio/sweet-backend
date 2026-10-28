// routes/productAliasRoutes.js
// "איך הלקוח הזה קורא למוצרים" — ההכרעות שנשמרו מתוך מסך ההזמנה, לצפייה
// ועריכה בכרטיס הלקוח. ראה controller/productAliasController.
//
// ההרשאה היא `isAdmin`, כמו resolve-item שיוצר את ההכרעות האלה: מי שרשאי
// להכריע מתוך הזמנה רשאי גם לתקן את מה שהכריע. שער מחמיר יותר כאן היה משאיר
// את מי שיוצר אליאסים בלי דרך לתקן אותם.
const express = require("express");
const router = express.Router();
const {
  getCustomerAliases,
  updateAlias,
  deleteAlias,
} = require("../controller/productAliasController");
const { isAdmin } = require("../config/auth");

// ההכרעות של לקוח מסוים
router.get("/customer/:customerId", isAdmin, getCustomerAliases);

// החלפת רשימת המוצרים של הכרעה
router.put("/:id", isAdmin, updateAlias);

// מחיקת הכרעה — השורה תוכרע מחדש בפעם הבאה
router.delete("/:id", isAdmin, deleteAlias);

module.exports = router;

// routes/cashierOrderRoutes.js
const express = require("express");
const router = express.Router();
const {
  addCashierOrder,
  getAllCashierOrders,
  getCashierOrderById,
  deleteCashierOrder,
  getCashierDashboardCount,
  getCashierDashboardAmount,
} = require("../controller/cashierOrderController");
const { isCashier, isAdmin } = require("../config/auth");

// יצירת הזמנת קופה חדשה
router.post("/", isCashier, addCashierOrder);

// קבלת כל הזמנות הקופה (עם פילטרים)
router.get("/", isAdmin, getAllCashierOrders);

// נתוני דשבורד - ספירות
router.get("/dashboard-count", isAdmin, getCashierDashboardCount);

// נתוני דשבורד - סכומים
router.get("/dashboard-amount", isAdmin, getCashierDashboardAmount);

// קבלת הזמנה ספציפית לפי ID או invoice
router.get("/:id", isAdmin, getCashierOrderById);

// מחיקת הזמנת קופה
router.delete("/:id", isAdmin, deleteCashierOrder);

module.exports = router; 
const express = require("express");
const router = express.Router();
const {
  getAllOrders,
  getOrderById,
  getOrderCustomer,
  updateOrder,
  updateOrderItems,
  deleteOrder,
  bestSellerProductChart,
  getDashboardOrders,
  getDashboardRecentOrder,
  getDashboardCount,
  getDashboardAmount,
  updateOrderWebHook,
  getSurveyOrders,
  updateSurveyResponse,
  handleWhatsappMessageFailure,
} = require("../controller/orderController");
const { isAdmin, isWhatsappServer } = require("../config/auth");

// get all orders
router.get("/", isAdmin, getAllOrders);

// get daily completed orders for the survey
router.get("/survey-orders", isWhatsappServer, getSurveyOrders);

// send email when whatsapp message failure
router.post("/handle-whatsapp-message-failure/send-email", isWhatsappServer, handleWhatsappMessageFailure);

router.put("/survey-response/:invoice", isWhatsappServer, updateSurveyResponse);

// get dashboard orders data
router.get("/dashboard", isAdmin, getDashboardOrders);

// dashboard recent-order
router.get("/dashboard-recent-order", isAdmin, getDashboardRecentOrder);

// dashboard order count
router.get("/dashboard-count", isAdmin, getDashboardCount);

// dashboard order amount
router.get("/dashboard-amount", isAdmin, getDashboardAmount);

// chart data for product
router.get("/best-seller/chart", isAdmin, bestSellerProductChart);

// get all order by a user
router.get("/customer/:id", isAdmin, getOrderCustomer);

// get a order by id
router.get("/:id", isAdmin, getOrderById);

// עריכת שורות ההזמנה — לפני "/:id" אינו נדרש (נתיב באורך אחר), אבל
// נשמר לידו כדי ששני מסלולי העדכון יישבו במקום אחד
router.put("/:id/items", isAdmin, updateOrderItems);

// update a order
router.put("/:id", isAdmin, updateOrder);

// delete a order
router.delete("/:id", isAdmin, deleteOrder);

module.exports = router;

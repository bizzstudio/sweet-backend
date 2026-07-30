// routes/appOrderRoutes.js
const express = require("express");
const router = express.Router();
const {
  getOrderById,
  getProcessingAndLikutOrders,
  updateOrderStatusApp,
  getCompletedOrders,
  sendOrderAndUpdateStatus,
} = require("../controller/orderController");
const { getAllStatuses } = require("../controller/statusController");

// get orders with collector status
router.get("/all/completed", getCompletedOrders);

// get Processing And Likut orders
router.get("/", getProcessingAndLikutOrders);

// get a order by id
router.get("/:id", getOrderById);

// update a order status
router.put("/:id", updateOrderStatusApp);

// send order to Lionwheel and update the order
router.post("/send-and-update/:id", sendOrderAndUpdateStatus);

// get all statuses
router.get("/status/getAll", getAllStatuses);

module.exports = router;

// routes/customerOrderRoutes.js
const express = require("express");
const router = express.Router();
const {
  addOrder,
  getOrderById,
  getOrderCustomer,
} = require("../controller/customerOrderController");
const { createGuestCustomer } = require("../controller/customerController");
const { isAuth, isOrderTokenValid, extractUserDetails } = require("../config/auth");

// add an order (for registered customers - requires authentication)
router.post("/add", isAuth, addOrder);

// add an order as guest (for non-registered customers - no authentication required)
router.post("/add-guest", createGuestCustomer, addOrder);

// get an order by id (requires authentication OR valid order token)
router.get("/:id", extractUserDetails, isOrderTokenValid, getOrderById);

// get all orders by a user (requires authentication)
router.get("/", isAuth, getOrderCustomer);

module.exports = router;
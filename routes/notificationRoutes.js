const express = require("express");
const router = express.Router();
const {
  getAllNotification,
  addNotification,
  updateStatusNotification,
  deleteNotificationById,
  deleteNotificationByProductId,
  deleteManyNotification,
  updateManyStatusNotification,
} = require("../controller/notificationController");
const { isAdmin } = require("../config/auth");

// add a notification on database
router.post("/add", isAdmin, addNotification);

// get all notification
router.get("/", getAllNotification);

// update notification status
router.put("/:id", isAdmin, updateStatusNotification);

// update many
router.patch("/update/many", isAdmin, updateManyStatusNotification);

// delete notification by id
router.delete("/:id", isAdmin, deleteNotificationById);

// delete notification by product id
router.delete("/product-id/:id", isAdmin, deleteNotificationByProductId);

// delete many
router.patch("/delete/many", isAdmin, deleteManyNotification);

module.exports = router;

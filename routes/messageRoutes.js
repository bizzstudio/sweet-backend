const router = require("express").Router();

const { isAdmin, isWhatsappServer } = require("../config/auth");
const {
  createMessage,
  getAllMessages,
  getMessageById,
  updateMessage,
  deleteMessage,
  deleteManyMessages,
  getMessageByRole,
  getSurveyData,
} = require("../controller/messageController");

// Create a new message
router.post("/add", isAdmin, createMessage);

// Get all messages
router.get("/all", isWhatsappServer, getAllMessages);

// Get message by ID
router.get("/:id", isWhatsappServer, getMessageById);

// Get Survey data
router.get("/getSurvey/data", isAdmin, getSurveyData);

// Get message by role
router.get("/role/:role", isWhatsappServer, getMessageByRole);

// Update a message
router.put("/:id", isAdmin, updateMessage);

// Delete a message by ID
router.delete("/:id", isAdmin, deleteMessage);

// Delete multiple messages by IDs
router.post("/delete-many", isAdmin, deleteManyMessages);

module.exports = router;

const router = require("express").Router();

const { isAdmin } = require("../config/auth");
const {
  createPopup,
  getAllPopups,
  getPopupById,
  updatePopup,
  deletePopup,
  deleteManyPopups,
} = require("../controller/popupController");

// Create a new popup
router.post("/add", isAdmin, createPopup);

// Get all popups
router.get("/all", getAllPopups);

// Get popup by ID
router.get("/:id", getPopupById);

// Update a popup
router.put("/:id", isAdmin, updatePopup);

// Delete a popup by ID
router.delete("/:id", isAdmin, deletePopup);

// Delete multiple popups by IDs
router.post("/delete-many", isAdmin, deleteManyPopups);

module.exports = router;

const express = require("express");
const router = express.Router();
const {
  createStatus,
  getAllStatuses,
  getAllMelaketim,
  getStatusById,
  updateStatus,
  deleteStatus,
  getStatusByName,
  deleteManyStatuses,
} = require("../controller/statusController");

// ניתובים עבור Status
router.post("/", createStatus);
router.get("/", getAllStatuses);
// חייב להירשם לפני "/:id", אחרת "melaketim" נתפס כמזהה ו-findById נופל.
router.get("/melaketim", getAllMelaketim);
router.get("/:id", getStatusById);
router.get("/name/:name", getStatusByName);
router.put("/:id", updateStatus);
router.delete("/:id", deleteStatus);
router.patch("/delete-many", deleteManyStatuses)

module.exports = router;

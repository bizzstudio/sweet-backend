const express = require("express");
const router = express.Router();
const {
  createLottery,
  getLotteries,
  getLotteryById,
  getLotteryParticipantOrders,
  refreshLotteryParticipants,
  drawLotteryWinner,
  deleteLottery,
} = require("../controller/lotteryController");

router.post("/", createLottery);
router.get("/", getLotteries);
/* נתיבים ספציפיים לפני /:id כדי למנוע התאמות שגויות בגרסאות שונות של Express */
router.post("/:id/refresh-participants", refreshLotteryParticipants);
router.post("/:id/draw", drawLotteryWinner);
router.get("/:id/participants", getLotteryParticipantOrders);
router.delete("/:id", deleteLottery);
router.get("/:id", getLotteryById);

module.exports = router;

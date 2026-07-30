const crypto = require("crypto");
const mongoose = require("mongoose");
const Lottery = require("../models/Lottery");
const Order = require("../models/Order");
const Status = require("../models/Status");

function parseDayBoundary(isoDateStr, endOfDay) {
  if (!isoDateStr || typeof isoDateStr !== "string") return null;
  const d = new Date(isoDateStr);
  if (Number.isNaN(d.getTime())) return null;
  const x = new Date(d);
  if (endOfDay) {
    x.setHours(23, 59, 59, 999);
  } else {
    x.setHours(0, 0, 0, 0);
  }
  return x;
}

async function resolvePaidEligibleStatusFilter() {
  const [pending, cancel] = await Promise.all([
    Status.findOne({ name: "Pending" }).select("_id").lean(),
    Status.findOne({ name: "Cancel" }).select("_id").lean(),
  ]);
  if (!pending || !cancel) {
    const err = new Error("MISSING_STATUS");
    err.code = "MISSING_STATUS";
    throw err;
  }
  return { $nin: [pending._id, cancel._id] };
}

/**
 * הזמנות “שולמו” במערכת הנוכחית: כל סטטוס שאינו Pending ואינו Cancel.
 * טווח תאריכים לפי createdAt של ההזמנה (כולל יום התחלה וסיום).
 */
async function findEligibleOrders(startDate, endDate) {
  const statusFilter = await resolvePaidEligibleStatusFilter();
  return Order.find({
    createdAt: { $gte: startDate, $lte: endDate },
    status: statusFilter,
  })
    .select("_id invoice createdAt")
    .sort({ createdAt: 1 })
    .lean();
}

const createLottery = async (req, res) => {
  try {
    const { title, startDate: startRaw, endDate: endRaw } = req.body || {};
    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).send({ message: "חובה למלא כותרת להגרלה" });
    }
    const startDate = parseDayBoundary(startRaw, false);
    const endDate = parseDayBoundary(endRaw, true);
    if (!startDate || !endDate) {
      return res.status(400).send({ message: "תאריכים לא תקינים" });
    }
    if (endDate < startDate) {
      return res.status(400).send({ message: "תאריך הסיום חייב להיות אחרי תאריך ההתחלה" });
    }

    const lottery = await Lottery.create({
      title: title.trim(),
      startDate,
      endDate,
      participantOrderIds: [],
    });
    res.status(201).send(lottery);
  } catch (err) {
    console.error("createLottery error:", err);
    res.status(500).send({ message: err.message || "שגיאת שרת" });
  }
};

const getLotteries = async (req, res) => {
  try {
    const statusFilter = await resolvePaidEligibleStatusFilter();
    const list = await Lottery.find({})
      .sort({ createdAt: -1 })
      .populate({
        path: "winningOrderId",
        select: "invoice user_info total status refund",
        populate: { path: "status", select: "name heName" },
      })
      .lean();

    const shaped = await Promise.all(
      list.map(async (row) => {
        const liveEligibleCount = await Order.countDocuments({
          createdAt: { $gte: row.startDate, $lte: row.endDate },
          status: statusFilter,
        });
        return {
          ...row,
          participantSnapshotCount: Array.isArray(row.participantOrderIds)
            ? row.participantOrderIds.length
            : 0,
          liveEligibleCount,
        };
      })
    );

    res.send(shaped);
  } catch (err) {
    if (err.code === "MISSING_STATUS") {
      return res.status(500).send({
        message: "חסרים סטטוסים Pending או Cancel במערכת — לא ניתן לחשב משתתפים",
      });
    }
    console.error("getLotteries error:", err);
    res.status(500).send({ message: err.message });
  }
};

const getLotteryById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).send({ message: "מזהה לא תקין" });
    }

    const lottery = await Lottery.findById(id)
      .populate({
        path: "winningOrderId",
        select: "invoice user_info total status createdAt",
        populate: { path: "status", select: "name heName" },
      })
      .lean();

    if (!lottery) {
      return res.status(404).send({ message: "הגרלה לא נמצאה" });
    }

    const eligible = await findEligibleOrders(lottery.startDate, lottery.endDate);

    res.send({
      lottery,
      liveEligibleCount: eligible.length,
      snapshotCount: Array.isArray(lottery.participantOrderIds)
        ? lottery.participantOrderIds.length
        : 0,
    });
  } catch (err) {
    if (err.code === "MISSING_STATUS") {
      return res.status(500).send({
        message: "חסרים סטטוסים Pending או Cancel במערכת — לא ניתן לחשב זכאות",
      });
    }
    console.error("getLotteryById error:", err);
    res.status(500).send({ message: err.message });
  }
};

const refreshLotteryParticipants = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).send({ message: "מזהה לא תקין" });
    }

    const lottery = await Lottery.findById(id);
    if (!lottery) {
      return res.status(404).send({ message: "הגרלה לא נמצאה" });
    }
    if (lottery.winningOrderId) {
      return res.status(400).send({ message: "הגרלה כבר בוצעה — לא ניתן לעדכן רשימה" });
    }

    const eligible = await findEligibleOrders(lottery.startDate, lottery.endDate);
    lottery.participantOrderIds = eligible.map((o) => o._id);
    await lottery.save();

    const updated = await Lottery.findById(id).lean();
    res.send({
      lottery: updated,
      savedCount: lottery.participantOrderIds.length,
    });
  } catch (err) {
    if (err.code === "MISSING_STATUS") {
      return res.status(500).send({
        message: "חסרים סטטוסים Pending או Cancel במערכת — לא ניתן לחשב זכאות",
      });
    }
    console.error("refreshLotteryParticipants error:", err);
    res.status(500).send({ message: err.message });
  }
};

/**
 * רשימת משתתפים להצגה באדמין: לפי snapshot אם קיים, אחרת רשימה חיה באותם כללי זכאות.
 */
const getLotteryParticipantOrders = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).send({ message: "מזהה לא תקין" });
    }

    const lottery = await Lottery.findById(id).select("startDate endDate participantOrderIds").lean();
    if (!lottery) {
      return res.status(404).send({ message: "הגרלה לא נמצאה" });
    }

    let ids = Array.isArray(lottery.participantOrderIds) ? [...lottery.participantOrderIds] : [];
    let source = "snapshot";

    if (ids.length === 0) {
      const eligible = await findEligibleOrders(lottery.startDate, lottery.endDate);
      ids = eligible.map((o) => o._id);
      source = "live";
    }

    if (!ids.length) {
      return res.send({ source, orders: [] });
    }

    const orders = await Order.find({ _id: { $in: ids } })
      .select("invoice user_info createdAt status")
      .populate({ path: "status", select: "name heName" })
      .lean();

    const byId = new Map(orders.map((o) => [o._id.toString(), o]));
    const ordered = ids.map((oid) => byId.get(oid.toString())).filter(Boolean);

    res.send({ source, orders: ordered });
  } catch (err) {
    if (err.code === "MISSING_STATUS") {
      return res.status(500).send({
        message: "חסרים סטטוסים Pending או Cancel במערכת — לא ניתן לטעון משתתפים",
      });
    }
    console.error("getLotteryParticipantOrders error:", err);
    res.status(500).send({ message: err.message });
  }
};

const drawLotteryWinner = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).send({ message: "מזהה לא תקין" });
    }

    const lottery = await Lottery.findById(id);
    if (!lottery) {
      return res.status(404).send({ message: "הגרלה לא נמצאה" });
    }
    if (lottery.winningOrderId) {
      return res.status(400).send({ message: "הגרלה כבר בוצעה" });
    }

    const endMs = new Date(lottery.endDate).getTime();
    if (!Number.isFinite(endMs) || Date.now() <= endMs) {
      return res.status(400).send({
        message:
          "תאריך סיום ההגרלה עדיין לא הגיע — ניתן לבצע הגרלה רק לאחר סיום טווח התאריכים.",
      });
    }

    const eligible = await findEligibleOrders(lottery.startDate, lottery.endDate);
    if (!eligible.length) {
      return res.status(400).send({
        message: "אין הזמנות זכאיות בטווח התאריכים (שולם ולא מבוטל)",
      });
    }

    const idx = crypto.randomInt(0, eligible.length);
    const winner = eligible[idx];

    lottery.participantOrderIds = eligible.map((o) => o._id);
    lottery.winningOrderId = winner._id;
    lottery.drawnAt = new Date();
    await lottery.save();

    // ניסיון החזר כספי לזוכה דרך Cardcom
    try {
      const winnerOrder = await Order.findById(winner._id).select("total cardInfo refund invoice").lean();

      if (winnerOrder?.refund?.requested) {
        console.log(
          `[Lottery Refund] הגרלה ${id} — החזר כבר בוצע להזמנה ${winnerOrder.invoice}, מדלג`
        );
      } else {
        const internalDealNumber = winnerOrder?.cardInfo?.InternalDealNumber;

        if (!internalDealNumber) {
          console.warn(
            `[Lottery Refund] הגרלה ${id} — להזמנה ${winnerOrder?.invoice} אין InternalDealNumber, לא ניתן לבצע החזר`
          );
          await Order.findByIdAndUpdate(winner._id, {
            "refund.requested": true,
            "refund.success": false,
            "refund.refundedAt": new Date(),
            "refund.errorMessage": "InternalDealNumber לא נמצא בנתוני ההזמנה",
          });
        } else {
          console.log(
            `[Lottery Refund] מתחיל החזר כספי להזמנה ${winnerOrder.invoice} | InternalDealNumber: ${internalDealNumber} | סכום: ${winnerOrder.total}`
          );

          const refundPayload = {
            TerminalNumber: process.env.CARDCOM_TERMINAL_NUMBER,
            ApiName: process.env.CARDCOM_API_NAME,
            InternalDealNumber: internalDealNumber,
            Amount: winnerOrder.total,
          };

          const refundRes = await fetch(
            "https://secure.cardcom.solutions/api/v11/Transactions/Refund",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(refundPayload),
            }
          );

          const refundData = await refundRes.json();
          const succeeded = refundData?.ResponseCode === 0;

          console.log(
            `[Lottery Refund] תשובת Cardcom להזמנה ${winnerOrder.invoice}: ResponseCode=${refundData?.ResponseCode} | ${succeeded ? "✓ הצלחה" : "✗ כשלון"}`
          );

          await Order.findByIdAndUpdate(winner._id, {
            "refund.requested": true,
            "refund.success": succeeded,
            "refund.refundedAt": new Date(),
            "refund.responseCode": refundData?.ResponseCode ?? null,
            "refund.rawResponse": refundData,
            "refund.errorMessage": succeeded ? null : (refundData?.Description || "החזר נכשל"),
          });
        }
      }
    } catch (refundErr) {
      console.error(`[Lottery Refund] שגיאה בביצוע החזר לזוכה בהגרלה ${id}:`, refundErr.message);
      try {
        await Order.findByIdAndUpdate(winner._id, {
          "refund.requested": true,
          "refund.success": false,
          "refund.refundedAt": new Date(),
          "refund.errorMessage": refundErr.message,
        });
      } catch (saveErr) {
        console.error(`[Lottery Refund] שגיאה בשמירת סטטוס כשלון:`, saveErr.message);
      }
    }

    const populated = await Lottery.findById(id)
      .populate({
        path: "winningOrderId",
        select: "invoice user_info total status createdAt",
        populate: { path: "status", select: "name heName" },
      })
      .lean();

    res.send({
      lottery: populated,
      winnerOrderId: winner._id,
      participantsTotal: eligible.length,
    });
  } catch (err) {
    if (err.code === "MISSING_STATUS") {
      return res.status(500).send({
        message: "חסרים סטטוסים Pending או Cancel במערכת — לא ניתן לבצע הגרלה",
      });
    }
    console.error("drawLotteryWinner error:", err);
    res.status(500).send({ message: err.message });
  }
};

/**
 * מחזיר מידע לפופאפ הגרלה בחנות.
 * ציבורי — ללא אימות.
 *
 * מחזיר אחד מהמצבים:
 *  { popupType: "winner", title, startDate, endDate, winnerName }
 *      — כאשר ההגרלה הוגרלה היום (drawnAt הוא היום)
 *  { popupType: "active", title, startDate, endDate }
 *      — כאשר היום בין startDate ל-endDate ואין עדיין זוכה
 *  null — אין כלום להציג
 */
const getActiveLottery = async (req, res) => {
  try {
    const now = new Date();

    // תחילת היום ← סוף היום (לטיפול בתאריך "היום")
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    // עדיפות ראשונה: הגרלה שהוגרלה היום — פופאפ זוכה
    const winnerLottery = await Lottery.findOne({
      drawnAt: { $gte: todayStart, $lte: todayEnd },
      winningOrderId: { $ne: null },
    })
      .select("title startDate endDate drawnAt winningOrderId")
      .populate({ path: "winningOrderId", select: "user_info invoice" })
      .sort({ drawnAt: -1 })
      .lean();

    if (winnerLottery) {
      const winnerName =
        winnerLottery.winningOrderId?.user_info?.name || null;
      return res.send({
        popupType: "winner",
        _id: winnerLottery._id,
        title: winnerLottery.title,
        startDate: winnerLottery.startDate,
        endDate: winnerLottery.endDate,
        drawnAt: winnerLottery.drawnAt,
        winnerName,
        winnerInvoice: winnerLottery.winningOrderId?.invoice || null,
      });
    }

    // עדיפות שניה: הגרלה פעילה (היום בטווח, עדיין אין זוכה)
    const activeLottery = await Lottery.findOne({
      startDate: { $lte: now },
      endDate: { $gte: now },
      winningOrderId: null,
    })
      .select("title startDate endDate")
      .sort({ startDate: -1 })
      .lean();

    if (activeLottery) {
      return res.send({
        popupType: "active",
        _id: activeLottery._id,
        title: activeLottery.title,
        startDate: activeLottery.startDate,
        endDate: activeLottery.endDate,
      });
    }

    return res.status(200).send(null);
  } catch (err) {
    console.error("getActiveLottery error:", err);
    res.status(500).send({ message: err.message || "שגיאת שרת" });
  }
};

const deleteLottery = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).send({ message: "מזהה לא תקין" });
    }
    const result = await Lottery.deleteOne({ _id: id });
    if (result.deletedCount === 0) {
      return res.status(404).send({ message: "הגרלה לא נמצאה" });
    }
    res.status(200).send({ message: "ההגרלה נמחקה" });
  } catch (err) {
    console.error("deleteLottery error:", err);
    res.status(500).send({ message: err.message });
  }
};

module.exports = {
  createLottery,
  getLotteries,
  getLotteryById,
  getLotteryParticipantOrders,
  refreshLotteryParticipants,
  drawLotteryWinner,
  deleteLottery,
  getActiveLottery,
};

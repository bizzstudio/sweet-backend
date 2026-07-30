// controller/messageController.js
const Message = require('../models/Message');
const Order = require('../models/Order');
const axios = require("axios");
require("dotenv").config();

const createMessage = async (req, res) => {
  try {
    const message = new Message(req.body);
    await message.save();

    // יידוע שרת WhatsApp
    await notifyWhatsappServer();
    res.status(201).send({ data: message, message: "Message Template created successfully!" });
  } catch (err) {
    res.status(400).send(err);
  }
};

const getAllMessages = async (req, res) => {
  try {
    const messages = await Message.find().sort({ createdAt: -1 });
    res.send(messages);
  } catch (err) {
    res.status(500).send(err);
  }
};

const getMessageById = async (req, res) => {
  try {
    const message = await Message.findById(req.params.id);
    if (!message) {
      return res.status(404).send();
    }
    res.send(message);
  } catch (err) {
    res.status(500).send(err);
  }
};

const getMessageByRole = async (req, res) => {
  try {
    const message = await Message.findOne({ role: req.params.role });
    if (!message) {
      return res.status(404).send();
    }
    res.send(message);
  } catch (err) {
    res.status(500).send(err);
  }
};

const updateMessage = async (req, res) => {
  try {
    const message = await Message.findById(req.params.id);

    if (!message) {
      return res.status(404).send();
    }

    message.message = req.body.message || message.message;
    // message.role = req.body.role || message.role;

    await message.save();

    // יידוע שרת WhatsApp
    await notifyWhatsappServer();

    res.send({ data: message, message: "תבנית ההודעה עודכנה בהצלחה" });
  } catch (err) {
    res.status(400).send(err);
  }
};

const deleteMessage = async (req, res) => {
  try {
    const message = await Message.findByIdAndDelete(req.params.id);

    if (!message) {
      return res.status(404).send();
    }

    // יידוע שרת WhatsApp
    await notifyWhatsappServer();

    res.status(200).send({
      message: "Message Template deleted successfully!",
    });
  } catch (err) {
    res.status(500).send(err);
  }
};

const deleteManyMessages = async (req, res) => {
  try {
    await Message.deleteMany({ _id: { $in: req.body.ids } });

    // יידוע שרת WhatsApp
    await notifyWhatsappServer();

    res.status(200).send({
      message: "Message Templates deleted successfully!",
    });
  } catch (err) {
    console.log('deleteManyMessages error: ', err);
    res.status(500).send(err);
  }
};

// פונקציה לחישוב נתוני הסקרים
const getSurveyData = async (req, res) => {
  try {
    const today = new Date();
    const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const nextMonthStart = new Date(today.getFullYear(), today.getMonth() + 1, 1);

    // נתוני כל הזמנים
    const allTimeData = await Order.aggregate([
      {
        $match: {
          customerSatisfaction: { $ne: null }, // מסנן מסמכים עם null ב-customerSatisfaction
        },
      },
      {
        $group: {
          _id: "$customerSatisfaction", // שדה דירוג שביעות רצון
          count: { $sum: 1 },
          totalBonus: { $sum: "$bonus" }, // סך הבונוסים לכל דירוג
        },
      },
    ]);

    // נתוני החודש הנוכחי
    const currentMonthData = await Order.aggregate([
      {
        $match: {
          customerSatisfaction: { $ne: null }, // מסנן מסמכים עם null ב-customerSatisfaction
          createdAt: {
            $gte: currentMonthStart,
            $lt: nextMonthStart,
          },
        },
      },
      {
        $group: {
          _id: "$customerSatisfaction", // שדה דירוג שביעות רצון
          count: { $sum: 1 },
          totalBonus: { $sum: "$bonus" }, // סך הבונוסים לכל דירוג
        },
      },
    ]);

    // בניית האובייקטים עבור כל הזמנים והחודש הנוכחי
    const allTime = { 1: { count: 0, totalBonus: 0 }, 2: { count: 0, totalBonus: 0 }, 3: { count: 0, totalBonus: 0 } };
    const thisMonth = { 1: { count: 0, totalBonus: 0 }, 2: { count: 0, totalBonus: 0 }, 3: { count: 0, totalBonus: 0 } };

    allTimeData.forEach((item) => {
      allTime[item._id] = {
        count: item.count,
        totalBonus: item.totalBonus || 0,
      };
    });

    currentMonthData.forEach((item) => {
      thisMonth[item._id] = {
        count: item.count,
        totalBonus: item.totalBonus || 0,
      };
    });

    const response = {
      allTime,
      thisMonth,
    };

    res.send(response);
  } catch (err) {
    res.status(500).send({ message: "Error calculating survey data", error: err.message });
  }
};

// פונקציה כללית ליידוע השרת WhatsApp שיש עדכון
const notifyWhatsappServer = async () => {
  try {
    const response = await axios.post(
      `${process.env.KIRSHNER_WHATSAPP_URL}/refresh-templates`,
      {},
      {
        headers: {
          "x-api-key": process.env.KIRSHNER_WHATSAPP_API_KEY,
        },
      }
    );
    console.log("WhatsApp server notified successfully:", response.data.message);
  } catch (error) {
    console.error("Failed to notify WhatsApp server:", error.message);
  }
};

module.exports = {
  createMessage,
  getAllMessages,
  getMessageById,
  updateMessage,
  deleteMessage,
  deleteManyMessages,
  getMessageByRole,
  getSurveyData,
};

// controller/orderController.js
require("dotenv").config();
const crypto = require("crypto");
const mongoose = require('mongoose');
const Coupon = require("../models/Coupon");
const Order = require("../models/Order");
const Status = require("../models/Status");
const Delivery = require('../models/Delivery');
const Customer = require("../models/Customer");
const DeliveryNote = require("../models/DeliveryNote");
const { default: axios } = require('axios');
const logStatusChange = require('../utils/logStatusChange');
const cron = require('node-cron');

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { sendEmail, sendOrderNotificationEmail } = require('../lib/email-sender/sender');
const { whatsappErrorEmailBody } = require('../lib/email-sender/templates/whatsapp-error');
const { handleProductQuantity } = require('../lib/stock-controller/others');
const { getIngestionErrorStatusId } = require('../utils/ingestionStatus');
// ── החרגת הזמנות הארכיון ──
//
// הזמנת ארכיון היא תיעוד של מסמך הנהח"ש שכבר חויב (ראה
// lib/archive-orders/buildArchiveOrders.js). היא אינה הכנסה חדשה, ולכן כל
// שאילתה שסוכמת כסף או סופרת הזמנות חייבת להוציא אותה — אחרת הדשבורד מציג
// את אותה מכירה פעמיים, פעם מהמערכת ופעם מההיסטוריה שיובאה.
//
// רוב הדוחות כאן בנויים על $in של סטטוסים מוכרים, ולכן הם מחריגים אותה
// מעצמם. ‏excludeArchive נועד לשאילתות שאינן מסננות לפי סטטוס בכלל — ובהן
// דווקא ההשמטה שקטה לגמרי.
const {
  getArchiveStatusId,
  archiveExclusionFilter: excludeArchive,
} = require('../utils/archiveStatus');
const Offer = require("../models/Offer");
const { editOrderItems, OrderEditError } = require("../lib/orders/editItems");
dayjs.extend(utc);
dayjs.extend(timezone);

// אזור הזמן לחישובי "היום/אתמול/החודש" בדשבורד.
// השרת (Vercel) רץ ב-UTC, ולכן חייבים לחתוך לפי חצות שעון ישראל ולא חצות UTC.
const ISRAEL_TZ = "Asia/Jerusalem";

// כלל ההבחנה בין הזמנת משלוח לאיסוף עצמי.
// עד היום השתמשנו ב-shippingCost>0 כקיצור ל"משלוח" (כי משלוח תמיד עלה כסף),
// אבל משלוח חינם (עלות 0) שובר את זה. לכן מזהים משלוח לפי סוג המשלוח שהלקוח בחר
// (shippingOption "2"), ובנוסף גם shippingCost>0 — לתאימות לאחור עם הזמנות ישנות
// שאולי חסר להן shippingOption. shippingOption נשמר כמחרוזת ("1"=איסוף, "2"=משלוח).
const DELIVERY_MATCH = {
  $or: [{ shippingOption: "2" }, { shippingCost: { $gt: 0 } }],
};
const PICKUP_MATCH = {
  shippingOption: { $ne: "2" },
  shippingCost: { $eq: 0 },
};

const getAllOrders = async (req, res) => {
  const {
    day,
    statuses,
    page,
    limit,
    method,
    endDate,
    // download,
    // sellFrom,
    startDate,
    customerName,
    cities,
  } = req.query;

  //  day count
  let date = new Date();
  const today = date.toString();
  date.setDate(date.getDate() - Number(day));
  const dateTime = date.toString();

  const beforeToday = new Date();
  beforeToday.setDate(beforeToday.getDate() - 1);
  // const before_today = beforeToday.toString();

  const queryObject = {};

  if (customerName) {
    // לבדוק אם ה-customerName הוא מספר תקין
    const orderNumber = Number(customerName);
    if (!isNaN(orderNumber)) {
      queryObject.$or = [
        { "user_info.name": { $regex: `${customerName}`, $options: "i" } },
        { "user_info.email": { $regex: `${customerName}`, $options: "i" } },
        { "user_info.contact": { $regex: `${customerName}`, $options: "i" } },
        { "total": customerName },
        { "invoice": orderNumber }
      ];
    } else {
      queryObject.$or = [
        { "user_info.name": { $regex: `${customerName}`, $options: "i" } },
        { "user_info.email": { $regex: `${customerName}`, $options: "i" } },
        { "user_info.contact": { $regex: `${customerName}`, $options: "i" } },
        {
          $expr: {
            $regexMatch: {
              input: {
                $concat: [
                  {
                    $trim: { input: "$user_info.name" }
                  }, " ", {
                    $trim: { input: "$user_info.lastName" }
                  }
                ]
              },
              regex: customerName,
              options: "i"
            }
          }
        }
      ];
    }
  }

  if (day) {
    queryObject.createdAt = { $gte: dateTime, $lte: today };
  }

  if (statuses) {
    const statusIds = await Status.find({ name: { $in: statuses.split(",") } }).select('_id');
    queryObject.status = { $in: statusIds };
  }

  if (startDate && endDate) {
    // אם נשלח ISO מלא (כולל T) – משתמשים בו כמו שהוא (תחילת/סוף יום ב-timezone של המשתמש)
    // אחרת YYYY-MM-DD – מפרשים כיום ב-UTC
    const isIso = String(startDate).indexOf("T") !== -1;
    const startDateData = isIso ? new Date(startDate) : new Date(String(startDate).split("T")[0] + "T00:00:00.000Z");
    const endDateData = isIso ? new Date(endDate) : new Date(String(endDate).split("T")[0] + "T23:59:59.999Z");

    queryObject.createdAt = {
      $gte: startDateData,
      $lte: endDateData,
    };
  }

  if (method) {
    queryObject.paymentMethod = { $regex: `${method}`, $options: "i" };
  }

  if (cities) {
    queryObject["user_info.address.city._id"] = { $in: cities.split(",") };
    // רק הזמנות משלוח (כולל משלוח חינם) — מסונן לפי כלל ההבחנה, לא לפי עלות בלבד.
    // עטוף ב-$and כדי לא לדרוס $or קיים (חיפוש לפי שם לקוח).
    queryObject.$and = [...(queryObject.$and || []), DELIVERY_MATCH];
  }

  const pages = Number(page) || 1;
  const limits = Number(limit);
  const skip = (pages - 1) * limits;

  try {
    // ── הזמנות ארכיון: מוחרגות, אלא אם ביקשו אותן במפורש ──
    //
    // המסך הזה משרת שני דברים — רשימת ההזמנות וגם "מכירות לפי מוצר לפי יום"
    // כשנשלח טווח תאריכים. ארכיון שנכלל בו היה מכפיל מכירות היסטוריות בדוח.
    // מנגד, סינון לפי הסטטוס "הזמנת ארכיון" חייב להחזיר אותן — אחרת אין שום
    // מסך שבו אפשר לראות מה יובא.
    if (!queryObject.status) {
      Object.assign(queryObject, await excludeArchive());
    }

    // total orders count
    const totalDoc = await Order.countDocuments(queryObject);
    // כשמסננים לפי תאריך – מחזירים מסמך מלא (כולל cart) כדי שהדשבורד "מכירות לפי מוצר לפי יום" יציג מוצרים
    const orderSelect = startDate && endDate
      ? undefined
      : "_id invoice paymentMethod subTotal total user_info discount shippingCost shippingOption status createdAt updatedAt bonus customerSatisfaction";
    const ordersQuery = Order.find(queryObject);
    if (orderSelect) ordersQuery.select(orderSelect);
    const orders = await ordersQuery
      .populate({ path: "status" })
      .populate({ path: "actualMelaket" })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limits);

    let methodTotals = [];
    if (startDate && endDate) {
      const filteredOrders = await Order.find(queryObject, {
        _id: 1,
        total: 1,
        paymentMethod: 1,
        updatedAt: 1,
      }).populate({ path: "status" }).sort({ createdAt: -1 });
      for (const order of filteredOrders) {
        const { paymentMethod, total } = order;
        const existPayment = methodTotals.find(
          (item) => item.method === paymentMethod
        );

        if (existPayment) {
          existPayment.total += total;
        } else {
          methodTotals.push({
            method: paymentMethod,
            total: total,
          });
        }
      }
    }

    // Calculate totalShippingOrders and totalPickupOrders
    // הבחנה לפי כלל המשלוח/איסוף (כדי שמשלוח חינם ייספר כמשלוח).
    // עוטפים את queryObject כולו ב-$and כדי לא לדרוס $or/$and קיימים.
    const totalShippingOrders = await Order.countDocuments({
      $and: [queryObject, DELIVERY_MATCH],
    });
    const totalPickupOrders = await Order.countDocuments({
      $and: [queryObject, PICKUP_MATCH],
    });

    // Calculate total bonuses
    const totalBonuses = await Order.aggregate([
      { $match: queryObject },
      { $group: { _id: null, totalBonus: { $sum: "$bonus" } } },
    ]);

    // console.log('orders :>> ', orders);
    res.send({
      orders,
      limits,
      pages,
      totalDoc,
      methodTotals,
      totalShippingOrders,
      totalPickupOrders,
      totalBonuses: totalBonuses[0]?.totalBonus || 0, // ברירת מחדל 0 אם אין תוצאות
    });
  } catch (err) {
    console.log('getAllOrders error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

// קבלת כל ההזמנות שצריך לשלוח להם סקר
const getSurveyOrders = async (req, res) => {
  try {
    // 1. חישוב הטווח: מאתמול ב-20:00 עד עכשיו
    const now = new Date();
    const yesterday8pmLocal = new Date(now);
    const daysBack = parseInt(process.env.SURVEY_DAYS_BACK || "1");
    console.log('daysBack: ', daysBack);
    yesterday8pmLocal.setDate(yesterday8pmLocal.getDate() - daysBack);
    yesterday8pmLocal.setHours(20, 0, 0, 0); // 20:00 אתמול

    // המרה ל-UTC
    const yesterday8pmUTC = new Date(
      yesterday8pmLocal.getTime() - yesterday8pmLocal.getTimezoneOffset() * 60000
    );

    // 2. שליפת כל הסטטוסים שיש בהם phone (לא null ולא ריק)
    const statusesWithPhone = await Status.find({
      phone: { $exists: true, $nin: ["", null] },
    }).select("_id");

    // 3. בניית queryObject
    const queryObject = {
      updatedAt: {
        $gte: yesterday8pmUTC,
        $lte: now,
      },
      status: { $in: statusesWithPhone }, // רק סטטוסים עם phone
      customerSatisfaction: { $exists: false }, // רק הזמנות שאין להן דירוג
    };

    // 4. שליפת ההזמנות
    let orders = await Order.find(queryObject)
      .populate({
        path: "user",
        select: "inBlackList",
        match: { inBlackList: { $ne: true } }, // ✅ רק לא true
      })
      .select("_id invoice user_info createdAt updatedAt status total shippingCost shippingOption")
      .populate("status")
      .sort({ createdAt: -1 })
      .lean(); // lean() להחזרת JS Objects במקום Document

    orders = orders.filter((order) => order.user !== null);

    res.json({ orders });
  } catch (err) {
    console.error("Error in getSurveyOrders:", err);
    res.status(500).json({ message: err.message });
  }
};

// פונקציית עדכון דירוג ההזמנה מאת הלקוח
const updateSurveyResponse = async (req, res) => {
  try {
    // 1. שליפת הפרמטרים מ-req
    const { invoice } = req.params;
    const { phone, rating } = req.body;

    console.log({ phone, rating, invoice })

    // 2. בדיקות בסיסיות
    if (!invoice) {
      return res.status(400).json({
        success: false,
        message: "Missing invoice in params",
      });
    };
    if (!rating || typeof rating !== "number") {
      return res.status(400).json({
        success: false,
        message: "Missing or invalid rating (must be a number)",
      });
    };
    if (rating < 1 || rating > 3) {
      return res.status(400).json({
        success: false,
        message: "Rating must be between 1 and 3",
      });
    };

    // 3. שליפת ההזמנה ממסד הנתונים
    const order = await Order.findOne({ invoice });
    if (!order) {
      return res.status(404).json({
        success: false,
        message: `Order with invoice ${invoice} not found`,
      });
    }

    // 4. עדכון שביעות הרצון
    order.customerSatisfaction = rating;

    // שמירה - ה-pre-save hook יחושב את bonus אם rating=1
    await order.save();

    // 5. החזרת תגובה
    res.json({
      success: true,
      message: "Survey updated successfully",
      data: {
        invoice: order.invoice,
        customerSatisfaction: order.customerSatisfaction,
        bonus: order.bonus,
        phone,
      },
    });
  } catch (err) {
    console.error("Error in updateSurveyResponse:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

const getProcessingAndLikutOrders = async (req, res) => {
  try {
    // מציאת המזהה של הסטטוס במקום המילה עצמה
    const processingStatus = await Status.findOne({ name: "Processing" });
    const likutStatus = await Status.findOne({ name: "Likut" });

    if (!processingStatus) return res.status(404).send("Processing status not found");
    if (!likutStatus) return res.status(404).send("Likut status not found");

    const statusIds = [processingStatus._id, likutStatus._id];

    // שאילתת המסמכים עם אחד מהסטטוסים
    const totalDoc = await Order.countDocuments({ status: { $in: statusIds } });
    const orders = await Order.find({ status: { $in: statusIds } })
      .populate({ path: "status" })
      .populate({ path: "actualMelaket" })
      .sort({ createdAt: -1 });

    // שליפת כל יעדי המשלוח מראש
    const allDeliveries = await Delivery.find({});
    const deliveryMap = new Map(); // Map<cityId, days[]>

    for (const delivery of allDeliveries) {
      const cityId = delivery.city?.city_code;
      if (cityId !== undefined) {
        deliveryMap.set(cityId, delivery.days.map(d => d.name)); // ['Tuesday', 'Wednesday']
      }
    };

    const now = dayjs().tz("Asia/Jerusalem");
    const tomorrow = now.add(1, "day");
    const isAfter14 = now.hour() >= 14;

    const todayName = now.format("dddd");
    const tomorrowName = tomorrow.format("dddd");

    const filteredOrders = orders.filter(order => {
      // איסוף עצמי עובר תמיד; הזמנת משלוח (כולל משלוח חינם, shippingOption "2")
      // ממשיכה לבדיקת ימי החלוקה ולא עוברת אוטומטית.
      if (order.shippingOption != 2 && order.shippingCost === 0) return true;

      const cityId = order?.user_info?.address?.city?.city_code;
      if (!cityId) return true;

      const deliveryDays = deliveryMap.get(cityId);
      if (!deliveryDays) return true;

      // האם המשלוח מיועד להיום או מחר (אם כבר אחרי 14:00)
      const isTodayDelivery = deliveryDays.includes(todayName);
      const isTomorrowDelivery = deliveryDays.includes(tomorrowName);

      return isTodayDelivery || (isTomorrowDelivery && isAfter14);
    });

    res.send({
      orders: filteredOrders,
      totalDoc: filteredOrders.length,
      waitingOrders: totalDoc - filteredOrders.length || 0,
    });
  } catch (err) {
    console.log('getProcessingAndLikutOrders error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

// קבלת 50 ההזמנות האחרונות שהושלמו
const getCompletedOrders = async (req, res) => {
  try {
    // מציאת המזהה של הסטטוס במקום המילה עצמה
    const cancelStatus = await Status.findOne({ name: "Cancel" });
    const pendingStatus = await Status.findOne({ name: "Pending" });
    const processingStatus = await Status.findOne({ name: "Processing" });
    const deliveredStatus = await Status.findOne({ name: "Delivered" });
    const likutStatus = await Status.findOne({ name: "Likut" });

    // הזמנה שנקלטה מהמייל/ווצאפ ולא נקראה במלואה יושבת ב"שגיאה בקריאה" ועדיין
    // לא אושרה ע"י אדם. השאילתה כאן היא $nin, ולכן בלי החרגה מפורשת הזמנה כזו
    // הייתה נחשבת "הושלמה" ומופיעה למלקטים.
    const ingestionErrorStatusId = await getIngestionErrorStatusId();

    // הזמנת ארכיון היא מסמך היסטורי ולא הזמנה שהושלמה עכשיו. אותו נימוק
    // בדיוק כמו ב"שגיאה בקריאה": השאילתה היא $nin, וסטטוס שלא הוחרג בה
    // מפורשות נספר כ"הושלמה" ומופיע למלקטים.
    const archiveStatusId = await getArchiveStatusId();

    const statusIds = [
      cancelStatus._id,
      pendingStatus._id,
      processingStatus._id,
      deliveredStatus._id,
      likutStatus._id,
      ...(ingestionErrorStatusId ? [ingestionErrorStatusId] : []),
      ...(archiveStatusId ? [archiveStatusId] : []),
    ];

    // שאילתה של ההזמנות שלא כוללות את אחד מהסטטוסים הרשמיים
    const totalDoc = await Order.countDocuments({ status: { $nin: statusIds } });
    const orders = await Order.find({ status: { $nin: statusIds } })
      .populate({ path: "status" })
      .sort({ createdAt: -1 })
      .limit(50); // הגבלת מספר התוצאות ל-50

    res.send({
      orders,
      totalDoc,
    });
  } catch (err) {
    console.log('getCompletedOrders error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

// עדכון סטטוס ההזמנה מהאפליקציה
const updateOrderStatusApp = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    /* ---------- קלט מה‑query ---------- */
    const resFromPickup = req?.query?.resFromPickup;
    try {
      if (resFromPickup) console.log("resFromPickup:", JSON.parse(resFromPickup));
    } catch (err) {
      console.log("Unusual resFromPickup:", resFromPickup);
      console.error(err);
    }
    const newStatus = req?.query?.status;

    /* ---------- מציאת הסטטוס המבוקש ---------- */
    let status;
    if (newStatus === "done" && req?.user?.name) {
      console.log('status: ', req?.user?._id);
      status = await Status.findOne({ name: req?.user?.name });
    } else {
      status = await Status.findOne({ name: newStatus });
    }
    if (!status) {
      return res.status(400).send({
        message: { he: "סטטוס לא חוקי", en: "Invalid status" },
      });
    }

    /* ---------- מציאת ההזמנה ---------- */
    const orderToUpdate = await Order.findById(req.params.id)
      .populate({ path: "status" })
      .session(session);

    if (!orderToUpdate) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).send({
        message: { he: "ההזמנה לא נמצאה", en: "Order not found" },
      });
    }

    /* ---------- חסימות לוגיות ---------- */
    // 1. הזמנות שממתינות לתשלום אי‑אפשר לגעת בהן
    if (orderToUpdate.status.name === "Pending") {
      await session.abortTransaction();
      session.endSession();
      return res.status(401).send({
        message: { he: "לא מורשה", en: "Unauthorized" },
      });
    }

    // 2. הזמנה שהסתיימה (Delivered / Cancel / שם‑מלקט) – אסור לשנות
    const finalStatuses = await Status.find({
      $or: [
        { phone: { $exists: true } }, // כל המלקטים
        { name: { $in: ["Delivered", "Cancel"] } },
      ],
    }).select("_id name");
    const finalStatusIds = finalStatuses.map((s) => s._id.toString());

    if (finalStatusIds.includes(orderToUpdate.status._id.toString())) {
      await session.abortTransaction();
      session.endSession();
      return res.status(409).send({
        message: {
          hebrew: "ההזמנה כבר הושלמה",
          en: "Order already completed",
          india: "आदेश पूरा हो गया है",
        },
      });
    }

    // 3. אם ההזמנה בליקוט והאפליקציה מנסה לשנות אותה שוב לליקוט מתקבלת דחייה
    if (orderToUpdate.status.name === "Likut" && newStatus === "Likut") {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).send({
        message: { he: "ההזמנה כבר בסטטוס ליקוט", en: "Order already in Likut status" },
      });
    }

    /* ---------- בניית אובייקט העדכון ---------- */
    const updateData = { status: status._id };
    if (newStatus === "Likut") {
      updateData.actualMelaket = req.user._id;
    } else if (newStatus === "Processing") {
      updateData.actualMelaket = null;
    }

    /* ---------- עדכון במסד הנתונים ---------- */
    await Order.updateOne(
      { _id: req.params.id },
      { $set: updateData },
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    /* ---------- טעינה מחדש ללוג ---------- */
    const updatedOrder = await Order.findById(req.params.id).populate({ path: "status" });

    // הדפסת שינוי סטטוס ההזמנה
    logStatusChange({
      from: orderToUpdate?.status?.name || "Unknown",
      to: status?.name || "Unknown",
      functionName: "updateOrderStatusApp",
      order: updatedOrder, // המסמך המעודכן
    });

    return res.status(200).send({ message: "Order Updated Successfully!" });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.log('updateOrderStatusApp error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

// lionwheel-פונקציה חדשה במיוחד ל
const sendOrderAndUpdateStatus = async (req, res) => {
  try {
    // מציאת הסטטוס שמבקשים לעדכן אליו
    let status;
    if (req?.user?.name) {
      status = await Status.findOne({ name: req?.user?.name });
    }

    if (!status) {
      return res.status(400).send({
        message: { he: "סטטוס לא חוקי", en: "Invalid status" },
      });
    }

    // מציאת הסטטוס "Delivered"
    const deliveredStatus = await Status.findOne({ name: "Delivered" });

    // מציאת הסטטוסים של המלקטים (סטטוסים שיש להם שדה phone)
    const melaketStatuses = await Status.find({ phone: { $exists: true } });

    // אוסף מזהי הסטטוסים של המלקטים
    const melaketStatusIds = melaketStatuses.map(status => status._id.toString());

    // מציאת ההזמנה
    const orderToUpdate = await Order.findById(req.params.id).populate({ path: "status" });

    if (!orderToUpdate) {
      return res.status(404).send({ message: "Order not found" });
    }

    // בדיקת הסטטוס הנוכחי של ההזמנה
    const currentStatusId = orderToUpdate.status?._id.toString();

    // בדיקה אם ההזמנה כבר בסטטוס "Delivered" או בסטטוס של מלקט אחר
    if (
      (deliveredStatus && currentStatusId === deliveredStatus._id.toString()) ||
      melaketStatusIds.includes(currentStatusId)
    ) {
      return res.status(400).send({
        message: { he: "ההזמנה כבר הושלמה", en: "Order has already been completed" },
      });
    }

    // בדיקת אם ההזמנה כבר נשלחה ל-LionWheel
    // const checkExistingOrder = await axios.get(
    //   `https://members.lionwheel.com/api/v1/tasks/show/${orderToUpdate.original_order_id}?key=${process.env.LIONWHEEL_KEY}`
    // );

    // if (checkExistingOrder.data && checkExistingOrder.data.original_order_id === orderToUpdate.invoice) {
    //   return res.status(400).send({
    //     message: { he: "ההזמנה כבר נשלחה ל-LionWheel", en: "Order has already been sent to LionWheel" },
    //   });
    // }

    let lionwheelResponse = {};
    try {
      // המשך הפעולה: שליחת ההזמנה ל-LionWheel
      console.log('lionwheel order object :>> ', req.body);
      lionwheelResponse = await axios.post(
        `https://members.lionwheel.com/api/v1/tasks/create?key=${process.env.LIONWHEEL_KEY}`,
        req.body,
        { headers: { 'Content-Type': 'application/json' } }
      );
      console.log('lionwheelResponse.data: ', lionwheelResponse.data);
    } catch (error) {
      console.error('Error sending order to LionWheel:', error);
    }

    // התחלת העסקה
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // בניית האובייקט לעדכון בצורה דינמית
      const updateFields = {
        status: status._id
      };

      if (lionwheelResponse?.data) {
        updateFields.resFromLion = lionwheelResponse.data;
      }

      // עדכון ההזמנה במסד הנתונים
      await Order.updateOne(
        { _id: req.params.id },
        { $set: updateFields },
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      // טוענים מחדש את ההזמנה על מנת לוודא שכולל את העדכונים האחרונים
      const updatedOrder = await Order.findById(req.params.id).populate({ path: "status" });

      // הדפסת שינוי סטטוס ההזמנה
      logStatusChange({
        from: orderToUpdate?.status?.name || "Unknown",
        to: status?.name || "Unknown",
        functionName: "sendOrderAndUpdateStatus",
        order: updatedOrder,
      });

      res.status(200).send({
        message: "Order updated and sent to LionWheel successfully!",
        lionwheelResponse: lionwheelResponse.data
      });
    } catch (innerError) {
      await session.abortTransaction();
      session.endSession();
      console.error('Error during transaction:', innerError);
      res.status(500).send({ message: 'Failed to update order in the database' });
    }

  } catch (error) {
    console.error('Error in sendOrderAndUpdateStatus:', error);
    res.status(500).send({ message: 'Failed to process the request' });
  }
};

const getOrderCustomer = async (req, res) => {
  try {
    // ── מיון לפי createdAt ולא לפי _id ──
    //
    // השניים זהים לכל הזמנה שנוצרה בזמן אמת (חותמת הזמן טבועה ב-ObjectId),
    // אבל **לא** להזמנת ארכיון: היא נוצרת היום ונושאת את תאריך המסמך
    // מלפני שנתיים. מיון לפי _id היה מקפיץ ייבוא היסטוריה לראש רשימת
    // ההזמנות של הלקוח, מעל ההזמנות האחרונות שלו.
    const orders = await Order.find({ user: req.params.id })
      .populate({ path: "status" })
      .sort({ createdAt: -1 });
    res.send(orders);
  } catch (err) {
    console.log('getOrderCustomer error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    let order;

    // בדיקה אם ה-ID הוא ObjectId תקף
    if (mongoose.Types.ObjectId.isValid(id)) {
      // אם כן, נחפש לפי _id
      order = await Order.findById(id).populate({ path: "status" });
    } else {
      // אחרת נחפש לפי invoice
      order = await Order.findOne({ invoice: id })
        .populate({ path: "status" })
        .populate({ path: "actualMelaket" });
    }

    if (!order) {
      return res.status(404).send({ message: "Order not found" });
    }

    res.send(order);
  } catch (err) {
    console.log('getOrderById error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const updateOrder = async (req, res) => {
  const newStatus = req.body.status;
  const providedPassword = req.body.password;
  const PASSWORD = process.env.UPDATE_ORDER_PASSWORD;

  // בדיקת סיסמה
  if (providedPassword !== PASSWORD) {
    return res.status(403).send({ message: "Invalid password" });
  };

  try {
    // חיפוש הסטטוס החדש
    const status = await Status.findOne({ name: newStatus });
    if (!status) {
      return res.status(400).send({ message: "Invalid status" });
    }

    // חיפוש ההזמנה והסטטוס הנוכחי שלה
    const orderToUpdate = await Order.findById(req.params.id).populate("status");
    if (!orderToUpdate) {
      return res.status(404).send({ message: "Order not found" });
    }

    const previousStatus = orderToUpdate.status?.name || "Unknown";

    // עדכון הסטטוס במסד הנתונים והחזרת ההזמנה המעודכנת
    const updatedOrder = await Order.findByIdAndUpdate(
      req.params.id,
      { $set: { status: status._id } },
      { new: true } // מחזיר את המסמך המעודכן
    ).populate("status");

    // הדפסת שינוי סטטוס ההזמנה
    logStatusChange({
      from: previousStatus,
      to: status.name || "Unknown",
      functionName: "updateOrder",
      order: updatedOrder,
    });

    res.status(200).send({
      message: "Order Updated Successfully!",
    });
  } catch (err) {
    console.error("updateOrder error: ", err);
    res.status(500).send({
      message: err.message,
    });
  }
};

// יצירת קוד קופון ייחודי לקנייה הבאה (מנסה עד 10 פעמים למקרה של התנגשות).
// ללא מקף בכוונה: בתצוגה עם ריווח אותיות מקף נקרא כרווח, ולקוחות הקלידו את הקוד בלעדיו.
// 10 תווים אקראיים (32^10 ≈ 10^15 צירופים) עם crypto — הקוד הוא "טוקן למוכ"ז" בעל ערך כספי,
// והקידומת ידועה בפומבי, ולכן נדרשת אנטרופיה שמונעת ניחוש בכוח גס.
const REWARD_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ללא תווים מבלבלים (O/0, I/1)
const REWARD_CODE_LENGTH = 10;

const generateUniqueCouponCode = async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = "TOMER25";
    for (let i = 0; i < REWARD_CODE_LENGTH; i++) {
      code += REWARD_CODE_CHARS[crypto.randomInt(REWARD_CODE_CHARS.length)];
    }
    const exists = await Coupon.findOne({ couponCode: code });
    if (!exists) return code;
  }
  return null;
};

const updateOrderWebHook = async (req, res) => {
  console.log('req.body: ', req.body);
  console.log('req.params: ', req.params);

  if (!req.query || req?.query?.key != process.env.CARDCOM_KEY || req?.query?.secret != process.env.CARDCOM_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  const processingStatus = await Status.findOne({ name: "Processing" });

  if (req.body.ResponseCode === 0) {
    try {
      const order = await Order.findById(req.params.id).populate('coupon').populate('status');

      if (!order) {
        return res.status(404).send({ message: "Order not found!" });
      };

      const previousStatus = order.status?.name || "Unknown"; // שמירת הסטטוס הקודם

      // עדכון סטטוס ההזמנה ל-"Processing"
      order.status = processingStatus._id;

      // הורדת מלאי מהמוצרים שבהזמנה
      try {
        console.log('Starting to decrease product quantities for order:', order.invoice);
        await handleProductQuantity(order.cart);
        console.log('Successfully decreased product quantities for order:', order.invoice);
      } catch (stockError) {
        console.error('Error decreasing product quantities for order', order.invoice, ':', stockError.message);
        // ממשיכים הלאה גם אם יש שגיאה במלאי
      }

      // אם יש קופון שמקושר להזמנה
      if (order.coupon) {
        const coupon = await Coupon.findById(order.coupon._id);

        if (coupon) {
          if (coupon.discountType.type === "percentage") {
            coupon.timesIsUsed += 1;
          } else if (coupon.discountType.type === "fixed") {
            coupon.timesIsUsed += 1;
            coupon.isUsed = true; // סימון קופון כמשומש אם הוא מסוג "fixed"
          }

          // אכיפת "פעם אחת לכל לקוח" — רישום הלקוח שמימש את הקופון
          if (coupon.oncePerCustomer && order.user) {
            const alreadyRecorded = Array.isArray(coupon.usedBy) &&
              coupon.usedBy.some((id) => id.toString() === order.user.toString());
            if (!alreadyRecorded) {
              coupon.usedBy.push(order.user);
            }
          }

          await coupon.save();
        }
      }

      // סימון מבצעים שנוצלו (רק מבצעים עם oncePerCustomer: true)
      try {
        const customer = await Customer.findById(order.user);
        if (
          customer
          && order.usedOfferIds
          && Array.isArray(order.usedOfferIds)
          && order.usedOfferIds.length > 0
        ) {
          // שליפת המבצעים שנוצלו כדי לבדוק אם הם oncePerCustomer
          const usedOffers = await Offer.find({
            _id: { $in: order.usedOfferIds },
            oncePerCustomer: true
          });

          if (usedOffers.length > 0) {
            // הוספת המבצעים לרשימת המבצעים שנוצלו של הלקוח
            const offerIdsToAdd = usedOffers
              .map(offer => offer._id.toString())
              .filter(offerId => !customer.redeemedOffers.some(id => id.toString() === offerId));

            if (offerIdsToAdd.length > 0) {
              customer.redeemedOffers.push(...offerIdsToAdd);
              await customer.save();
              console.log(`Marked ${offerIdsToAdd.length} offers as redeemed for customer ${customer.email}`);
            }
          }
        }
      } catch (offerRedemptionError) {
        console.error('Error marking offers as redeemed:', offerRedemptionError);
        // ממשיכים הלאה גם אם יש שגיאה בעדכון המבצעים
      }

      // סימון מתנת ברוכים הבאים כמנוצלת
      try {
        const hasWelcomeGiftInOrder = Array.isArray(order.cart)
          && order.cart.some((item) => item.isWelcomeGift);
        if (hasWelcomeGiftInOrder) {
          const customer = await Customer.findById(order.user);
          if (customer?.welcomeGift && customer.welcomeGift.isUsed === false) {
            customer.welcomeGift.isUsed = true;
            await customer.save();
            console.log(`Marked welcome gift as used for customer ${customer.email}`);
          }
        }
      } catch (welcomeGiftError) {
        console.error('Error marking welcome gift as used:', welcomeGiftError);
      }

      // שמירת נתוני עסקת Cardcom (כולל InternalDealNumber) לצורך החזר עתידי
      if (req.body && typeof req.body === "object") {
        order.cardInfo = req.body;
        console.log(
          `[Cardcom Webhook] שמירת cardInfo להזמנה ${order.invoice} | InternalDealNumber: ${req.body.InternalDealNumber ?? "לא נמצא"}`
        );
      }

      // הנפקת קופון "לקנייה הבאה" — ללקוח ששילם דמי משלוח ולא הגיע לסף המשלוח החינם.
      // נוצר רק לאחר תשלום מוצלח (כאן), פעם אחת להזמנה. קופון fixed מסומן isUsed=true אוטומטית
      // אחרי מימוש → שימוש חד-פעמי. status:"show" נדרש כדי שיהיה בר-מימוש (useCoupon דוחה "hide"),
      // ו-productType:"shippingReward" מסתיר אותו מרשימת הקופונים הציבורית.
      //
      // ההטבה היא חד-פעמית לכל לקוח (לכל החיים), ולכן "תופסים" את הלקוח אטומית עם
      // findOneAndUpdate מותנה ב-shippingRewardIssued שאינו true. רק קריאה אחת תצליח לתפוס —
      // מה שמונע גם קופון שני ללקוח חוזר וגם כפילות במירוץ webhook מקביל של אותה הזמנה.
      if (order.shippingRewardEligible && !order.rewardCouponCode && order.user) {
        let claimedCustomer = null;
        try {
          // מחזיר את המסמך שלפני העדכון (ברירת מחדל) — משמש רק כבדיקה בוליאנית
          // "האם אני זה שתפס". אין צורך ב-{ new: true }.
          claimedCustomer = await Customer.findOneAndUpdate(
            { _id: order.user, shippingRewardIssued: { $ne: true } },
            { $set: { shippingRewardIssued: true } }
          ).select("_id").lean();

          if (!claimedCustomer) {
            // הלקוח כבר קיבל קופון בעבר. ייתכן גם שקריאה מקבילה הנפיקה לאותה הזמנה —
            // נסנכרן את הקוד הקיים לזיכרון כדי ש-order.save() הסופי לא ידרוס אותו ל-null.
            const fresh = await Order.findById(order._id).select("rewardCouponCode");
            if (fresh && fresh.rewardCouponCode) {
              order.rewardCouponCode = fresh.rewardCouponCode;
            }
            console.log(`[Reward Coupon] דילוג — הלקוח כבר קיבל קופון הטבה (הזמנה ${order.invoice})`);
          } else {
            const code = await generateUniqueCouponCode();
            if (!code) throw new Error("failed to generate a unique coupon code");

            await new Coupon({
              couponCode: code,
              title: { he: "קופון לקנייה הבאה", en: "Next purchase coupon" },
              discountType: { type: "fixed", value: 25 },
              minimumAmount: 150,
              productType: "shippingReward",
              status: "show",
              endTime: new Date("2500-01-01T00:00:00Z"), // ללא תפוגה בפועל
            }).save();

            // שמירה אטומית ומיידית על ההזמנה — לא מסתמכים על order.save() שבהמשך.
            // אחרת, אם השמירה הכללית תיכשל, הדגל אצל הלקוח כבר "נשרף" והקוד היה אובד לתמיד.
            await Order.updateOne({ _id: order._id }, { $set: { rewardCouponCode: code } });

            order.rewardCouponCode = code;
            console.log(`[Reward Coupon] הונפק קופון ${code} להזמנה ${order.invoice}`);
          }
        } catch (rewardError) {
          console.error("Error creating next-purchase reward coupon:", rewardError);
          // אם תפסנו את הלקוח אך ההנפקה נכשלה — משחררים את הדגל כדי שלא יאבד את ההטבה
          if (claimedCustomer) {
            try {
              await Customer.updateOne(
                { _id: order.user },
                { $set: { shippingRewardIssued: false } }
              );
            } catch (rollbackError) {
              console.error("Failed to roll back shippingRewardIssued:", rollbackError);
            }
          }
          // לא מכשילים את סיום ההזמנה אם הנפקת הקופון נכשלה
        }
      }

      await order.save();

      // הדפסת שינוי סטטוס ההזמנה
      logStatusChange({
        from: previousStatus,
        to: "Processing",
        functionName: "updateOrderWebHook",
        order: order,
      });

      // שליחת הודעת אימייל על הזמנה חדשה (ללקוח ולמנהלים)
      sendOrderNotificationEmail(order, order.user_info);

      res.status(200).send({
        message: "Order and coupon updated successfully!",
      });

    } catch (err) {
      console.log('updateOrderWebHook error: ', err);
      res.status(500).send({
        message: err.message,
      });
    }
  } else {
    res.status(500).send({
      message: "Payment failed!",
    });
  }
};

// מחיקת הזמנה, עם שמירה על שרשרת החיוב.
//
// מאז שתעודת המשלוח נוצרת בקליטת ההזמנה יש תעודה ל**כל** הזמנה, ולא רק
// לזו שנמסרה. מחיקה בלי בדיקה הייתה משאירה תעודה שמצביעה על הזמנה שאינה
// קיימת — ואם התעודה כבר חויבה, גם חשבונית מס ב-iCount שאי אפשר להסביר.
//
// לכן: תעודה שחויבה או שנתפסה לחיוב חוסמת את המחיקה, ותעודה ידנית חוסמת
// גם היא — היא נושאת שקילות שהוקלדו ביד ואין מהיכן לשחזר אותן. תעודה
// אוטומטית שטרם חויבה נמחקת יחד עם ההזמנה, כי בלעדיה אין לה משמעות.
const deleteOrder = async (req, res) => {
  try {
    const notes = await DeliveryNote.find({ order: req.params.id })
      .select("number kind billing.status")
      .lean();

    const blocking = notes.filter(
      (n) => ["billed", "billing"].includes(n.billing?.status) || n.kind === "manual"
    );

    if (blocking.length) {
      return res.status(409).send({
        message: {
          he:
            `לא ניתן למחוק — להזמנה יש תעודות משלוח: ` +
            `${blocking.map((n) => n.number).join(", ")}. ` +
            `תעודה שחויבה מתוקנת בחשבונית זיכוי, ותעודה ידנית יש לבטל תחילה.`,
          en: "Order has delivery notes that were billed or entered manually",
        },
      });
    }

    // התעודות לפני ההזמנה: אם המחיקה תיפול באמצע, תעודה יתומה גרועה
    // פחות מהזמנה בלי התעודה שמתארת אותה
    if (notes.length) {
      await DeliveryNote.deleteMany({ _id: { $in: notes.map((n) => n._id) } });
    }

    const result = await Order.deleteOne({ _id: req.params.id });
    if (!result.deletedCount) {
      return res.status(404).send({ message: "Order not found" });
    }

    res.status(200).send({
      message: "Order Deleted Successfully!",
    });
  } catch (err) {
    console.log('deleteOrder error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

// get dashboard recent order
const getDashboardRecentOrder = async (req, res) => {
  try {
    const { page, limit } = req.query;

    const pages = Number(page) || 1;
    const limits = Number(limit) || 8;
    const skip = (pages - 1) * limits;

    // "ההזמנות האחרונות" בדשבורד — ארכיון שיובא היום היה מציף אותן במסמכים
    // בני שנתיים, כי המיון הוא לפי createdAt וההזמנה נושאת את תאריך המסמך.
    const queryObject = { ...(await excludeArchive()) };

    // queryObject.$or = [
    //   { status: { $regex: `Pending`, $options: "i" } },
    //   { status: { $regex: `Processing`, $options: "i" } },
    //   { status: { $regex: `Delivered`, $options: "i" } },
    //   { status: { $regex: `Cancel`, $options: "i" } },
    // ];

    const totalDoc = await Order.countDocuments(queryObject);

    // query for orders
    const orders = await Order.find(queryObject)
      .populate({ path: "status" })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limits);

    // console.log('order------------<', orders);

    res.send({
      orders: orders,
      page: page,
      limit: limit,
      totalOrder: totalDoc,
    });
  } catch (err) {
    console.log('getDashboardRecentOrder error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

// get dashboard count
const getDashboardCount = async (req, res) => {
  // כל הגבולות מחושבים לפי חצות שעון ישראל (Asia/Jerusalem), לא לפי שעון השרת (UTC).
  const nowIL = dayjs().tz(ISRAEL_TZ);

  const today = nowIL.startOf("day").toDate(); // חצות היום (שעון ישראל)
  const yesterday = nowIL.startOf("day").subtract(1, "day").toDate(); // חצות אתמול
  const tomorrow = nowIL.startOf("day").add(1, "day").toDate(); // חצות מחר

  const thisMonthStartDate = nowIL.startOf("month").toDate(); // תחילת החודש הנוכחי
  const thisMonthEndDate = tomorrow;

  const lastMonthStartDate = nowIL.startOf("month").subtract(1, "month").toDate(); // תחילת החודש שעבר
  const lastMonthEndDate = thisMonthStartDate; // תחילת החודש הנוכחי = חסם עליון בלעדי ($lt)

  try {
    // מציאת המזהים של הסטטוסים במקום המילה עצמה
    const pendingStatus = await Status.findOne({ name: "Pending" });
    const processingStatus = await Status.findOne({ name: "Processing" });
    const deliveredStatus = await Status.findOne({ name: "Delivered" });
    const likutStatus = await Status.findOne({ name: "Likut" });

    // מציאת סטטוסי מלקטים (סטטוסים עם מספר טלפון)
    const melaketStatuses = await Status.find({ phone: { $exists: true } });

    // המזהים של הסטטוסי מלקטים
    const melaketStatusIds = melaketStatuses.map(status => status._id);

    const statusFilter = { status: { $in: [...melaketStatusIds, deliveredStatus._id, processingStatus._id, likutStatus._id] } };

    // פונקציית אגירה גנרית
    const aggregateOrders = async (additionalFilter) => {
      return await Order.aggregate([
        { $match: { ...statusFilter, ...additionalFilter } },
        {
          $group: {
            _id: null,
            total: { $sum: "$total" },
            count: { $sum: 1 },
          }
        },
      ]);
    };

    // כל ההזמנות מהיום
    const totalOrdersToday = await aggregateOrders({ updatedAt: { $gte: today, $lt: tomorrow } });

    // כל ההזמנות מהחודש הנוכחי
    const totalOrdersThisMonth = await aggregateOrders({ updatedAt: { $gte: thisMonthStartDate, $lt: thisMonthEndDate } });

    // כל ההזמנות מאז ומתמיד
    const totalOrders = await aggregateOrders();


    // הזמנות עם משלוח מהיום
    const totalShippingOrdersToday = await aggregateOrders({
      ...DELIVERY_MATCH,
      updatedAt: { $gte: today, $lt: tomorrow }
    });

    // הזמנות עם משלוח מהחודש הנוכחי
    const totalShippingOrdersThisMonth = await aggregateOrders({
      ...DELIVERY_MATCH,
      updatedAt: { $gte: thisMonthStartDate, $lt: thisMonthEndDate }
    });

    // הזמנות עם משלוח מאז ומתמיד
    const totalShippingOrders = await aggregateOrders({ ...DELIVERY_MATCH });


    // הזמנות עם איסוף עצמי מהיום
    const totalPickupOrdersToday = await aggregateOrders({
      ...PICKUP_MATCH,
      updatedAt: { $gte: today, $lt: tomorrow }
    });

    // הזמנות עם איסוף עצמי מהחודש הנוכחי
    const totalPickupOrdersThisMonth = await aggregateOrders({
      ...PICKUP_MATCH,
      updatedAt: { $gte: thisMonthStartDate, $lt: thisMonthEndDate }
    });

    // הזמנות עם איסוף עצמי מאז ומתמיד
    const totalPickupOrders = await aggregateOrders({ ...PICKUP_MATCH });


    // הזמנות שממתינות לתשלום מהיום
    const totalPendingOrdersToday = await aggregateOrders({
      status: pendingStatus._id,
      updatedAt: { $gte: today, $lt: tomorrow }
    });

    // הזמנות שממתינות לתשלום מהחודש הנוכחי
    const totalPendingOrdersThisMonth = await aggregateOrders({
      status: pendingStatus._id,
      updatedAt: { $gte: thisMonthStartDate, $lt: thisMonthEndDate }
    });

    // הזמנות שממתינות לתשלום מאז ומתמיד
    const totalPendingOrders = await aggregateOrders({ status: pendingStatus._id });

    res.send({
      allTime: {
        totalOrders: totalOrders[0] || { _id: null, total: 0, count: 0 },
        totalShippingOrders: totalShippingOrders[0] || { _id: null, total: 0, count: 0 },
        totalPickupOrders: totalPickupOrders[0] || { _id: null, total: 0, count: 0 },
        totalPendingOrders: totalPendingOrders[0] || { _id: null, total: 0, count: 0 },
      },
      today: {
        totalOrders: totalOrdersToday[0] || { _id: null, total: 0, count: 0 },
        totalShippingOrders: totalShippingOrdersToday[0] || { _id: null, total: 0, count: 0 },
        totalPickupOrders: totalPickupOrdersToday[0] || { _id: null, total: 0, count: 0 },
        totalPendingOrders: totalPendingOrdersToday[0] || { _id: null, total: 0, count: 0 },
      },
      thisMonth: {
        totalOrders: totalOrdersThisMonth[0] || { _id: null, total: 0, count: 0 },
        totalShippingOrders: totalShippingOrdersThisMonth[0] || { _id: null, total: 0, count: 0 },
        totalPickupOrders: totalPickupOrdersThisMonth[0] || { _id: null, total: 0, count: 0 },
        totalPendingOrders: totalPendingOrdersThisMonth[0] || { _id: null, total: 0, count: 0 },
      },
    });
  } catch (err) {
    console.log('getDashboardCount error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const getDashboardAmount = async (req, res) => {
  // כל הגבולות מחושבים לפי חצות שעון ישראל (Asia/Jerusalem), לא לפי שעון השרת (UTC).
  const nowIL = dayjs().tz(ISRAEL_TZ);

  const today = nowIL.startOf("day").toDate(); // חצות היום (שעון ישראל)
  const yesterday = nowIL.startOf("day").subtract(1, "day").toDate(); // חצות אתמול
  const tomorrow = nowIL.startOf("day").add(1, "day").toDate(); // חצות מחר

  const week = nowIL.startOf("day").subtract(7, "day").toDate(); // 7 ימים אחורה

  const thisMonthStartDate = nowIL.startOf("month").toDate(); // תחילת החודש הנוכחי
  const thisMonthEndDate = tomorrow;

  const lastMonthStartDate = nowIL.startOf("month").subtract(1, "month").toDate(); // תחילת החודש שעבר
  const lastMonthEndDate = thisMonthStartDate; // תחילת החודש הנוכחי = חסם עליון בלעדי ($lt)

  // console.log('thisMonthStartDate: ', thisMonthStartDate)
  // console.log('thisMonthEndDate: ', thisMonthEndDate)
  // console.log('lastMonthStartDate: ', lastMonthStartDate)
  // console.log('lastMonthEndDate: ', lastMonthEndDate)

  try {
    const deliveredStatus = await Status.findOne({ name: "Delivered" });
    const processingStatus = await Status.findOne({ name: "Processing" });
    const likutStatus = await Status.findOne({ name: "Likut" });

    // מציאת הסטטוסים שבליקוט כרגע (סטטוסים עם מספר טלפון)
    const melaketStatuses = await Status.find({ phone: { $exists: true } });
    const melaketStatusIds = melaketStatuses.map(status => status._id);

    // total order amount
    const totalAmount = await Order.aggregate([
      {
        $match: {
          $or: [
            { status: { $in: [...melaketStatusIds, deliveredStatus._id, processingStatus._id, likutStatus._id] } }
          ],
        },
      },
      {
        $group: {
          _id: null,
          tAmount: {
            $sum: "$total",
          },
        },
      },
    ]);

    // today's order amount
    const todayAmount = await Order.aggregate([
      {
        $project: {
          year: { $year: "$updatedAt" },
          month: { $month: "$updatedAt" },
          total: 1,
          subTotal: 1,
          discount: 1,
          updatedAt: 1,
          createdAt: 1,
          status: 1,
        },
      },
      {
        $match: {
          $or: [
            { status: { $in: [...melaketStatusIds, deliveredStatus._id, processingStatus._id, likutStatus._id] } }
          ],
          updatedAt: { $gte: today, $lt: tomorrow },
        },
      },
      {
        $group: {
          // _id: null — החלון כבר מצומצם ב-$match לפי שעון ישראל, מסכמים הכל לדלי אחד.
          // (קיבוץ לפי $dayOfMonth ב-UTC היה מפצל יום-ישראלי לשני ימי-UTC ומאבד חלק עם $limit:1)
          _id: null,
          total: {
            $sum: "$total",
          },
          subTotal: {
            $sum: "$subTotal",
          },
          discount: {
            $sum: "$discount",
          },
        },
      },
      {
        $sort: { _id: -1 },
      },
      {
        $limit: 1,
      },
    ]);

    // yesterday's order amount
    const yesterdayAmount = await Order.aggregate([
      {
        $project: {
          year: { $year: "$updatedAt" },
          month: { $month: "$updatedAt" },
          total: 1,
          subTotal: 1,
          discount: 1,
          updatedAt: 1,
          createdAt: 1,
          status: 1,
        },
      },
      {
        $match: {
          $or: [
            { status: { $in: [...melaketStatusIds, deliveredStatus._id, processingStatus._id, likutStatus._id] } }
          ],
          updatedAt: { $gte: yesterday, $lt: today },
        },
      },
      {
        $group: {
          // _id: null — החלון כבר מצומצם ב-$match לפי שעון ישראל, מסכמים הכל לדלי אחד.
          // (קיבוץ לפי $dayOfMonth ב-UTC היה מפצל יום-ישראלי לשני ימי-UTC ומאבד חלק עם $limit:1)
          _id: null,
          total: {
            $sum: "$total",
          },
          subTotal: {
            $sum: "$subTotal",
          },
          discount: {
            $sum: "$discount",
          },
        },
      },
      {
        $sort: { _id: -1 },
      },
      {
        $limit: 1,
      },
    ]);

    // this month's order amount
    const thisMonthOrderAmount = await Order.aggregate([
      {
        $project: {
          year: { $year: "$updatedAt" },
          month: { $month: "$updatedAt" },
          total: 1,
          subTotal: 1,
          discount: 1,
          updatedAt: 1,
          createdAt: 1,
          status: 1,
        },
      },
      {
        $match: {
          $or: [
            { status: { $in: [...melaketStatusIds, deliveredStatus._id, processingStatus._id, likutStatus._id] } }
          ],
          updatedAt: { $gte: thisMonthStartDate, $lt: thisMonthEndDate },
        },
      },
      {
        $group: {
          // _id: null — החלון כבר מצומצם ב-$match לפי שעון ישראל, מסכמים הכל לדלי אחד.
          _id: null,
          total: {
            $sum: "$total",
          },
          subTotal: {
            $sum: "$subTotal",
          },
          discount: {
            $sum: "$discount",
          },
        },
      },
      {
        $sort: { _id: -1 },
      },
      {
        $limit: 1,
      },
    ]);

    // last month's order amount
    const lastMonthOrderAmount = await Order.aggregate([
      {
        $project: {
          year: { $year: "$updatedAt" },
          month: { $month: "$updatedAt" },
          total: 1,
          subTotal: 1,
          discount: 1,
          updatedAt: 1,
          createdAt: 1,
          status: 1,
        },
      },
      {
        $match: {
          $or: [
            { status: { $in: [...melaketStatusIds, deliveredStatus._id, processingStatus._id, likutStatus._id] } }
          ],
          updatedAt: { $gte: lastMonthStartDate, $lt: lastMonthEndDate },
        },
      },
      {
        $group: {
          // _id: null — החלון כבר מצומצם ב-$match לפי שעון ישראל, מסכמים הכל לדלי אחד.
          _id: null,
          total: {
            $sum: "$total",
          },
          subTotal: {
            $sum: "$subTotal",
          },
          discount: {
            $sum: "$discount",
          },
        },
      },
      {
        $sort: { _id: -1 },
      },
      {
        $limit: 1,
      },
    ]);

    // order list last 10 days
    const orderFilteringData = await Order.find(
      {
        status: { $in: [...melaketStatusIds, deliveredStatus._id, processingStatus._id, likutStatus._id] },
        updatedAt: {
          $gte: week,
        },
      },
      {
        paymentMethod: 1,
        paymentDetails: 1,
        total: 1,
        createdAt: 1,
        updatedAt: 1,
      }
    );

    res.send({
      totalAmount:
        totalAmount.length === 0
          ? 0
          : parseFloat(totalAmount[0].tAmount).toFixed(2),
      todayAmount: todayAmount[0]?.total || 0,
      yesterdayAmount: yesterdayAmount[0]?.total || 0,
      thisMonthlyOrderAmount: thisMonthOrderAmount[0]?.total,
      lastMonthOrderAmount: lastMonthOrderAmount[0]?.total,
      ordersData: orderFilteringData,
    });
  } catch (err) {
    console.log('getDashboardAmount error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const bestSellerProductChart = async (req, res) => {
  try {
    const notArchive = await excludeArchive();
    const totalDoc = await Order.countDocuments(notArchive);
    const bestSellingProduct = await Order.aggregate([
      {
        $match: notArchive,
      },
      {
        $unwind: "$cart",
      },
      {
        $group: {
          _id: "$cart.title",

          count: {
            $sum: "$cart.quantity",
          },
        },
      },
      {
        $sort: {
          count: -1,
        },
      },
      {
        $limit: 4,
      },
    ]);

    res.send({
      totalDoc,
      bestSellingProduct,
    });
  } catch (err) {
    console.log('bestSellerProductChart error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const getDashboardOrders = async (req, res) => {
  const { page, limit } = req.query;

  const pages = Number(page) || 1;
  const limits = Number(limit) || 8;
  const skip = (pages - 1) * limits;

  let week = new Date();
  week.setDate(week.getDate() - 10);

  const start = new Date().toDateString();

  // (startDate = '12:00'),
  //   (endDate = '23:59'),
  // console.log("page, limit", page, limit);

  try {
    // מציאת המזהים של הסטטוסים במקום המילה עצמה
    const pendingStatus = await Status.findOne({ name: "Pending" });
    const processingStatus = await Status.findOne({ name: "Processing" });
    const deliveredStatus = await Status.findOne({ name: "Delivered" });
    const cancelStatus = await Status.findOne({ name: "Cancel" });

    // מציאת הסטטוסים שבליקוט כרגע (סטטוסים עם מספר טלפון)
    const melaketStatuses = await Status.find({ phone: { $exists: true } });

    // המזהים של הסטטוסים שבליקוט כרגע
    const melaketStatusIds = melaketStatuses.map(status => status._id);

    // ארבע השאילתות הבאות אינן מסננות לפי סטטוס כלל, ולכן הן היחידות כאן
    // שהזמנת ארכיון הייתה נכנסת אליהן — וסכום ההכנסות הכולל היה גדל בכל
    // ייבוא היסטוריה.
    const notArchive = await excludeArchive();

    const totalDoc = await Order.countDocuments(notArchive);

    // query for orders
    const orders = await Order.find(notArchive)
      .populate({ path: "status" })
      .sort({ _id: -1 })
      .skip(skip)
      .limit(limits);

    const totalAmount = await Order.aggregate([
      {
        $match: notArchive,
      },
      {
        $group: {
          _id: null,
          tAmount: {
            $sum: "$total",
          },
        },
      },
    ]);

    // total order amount
    const todayOrder = await Order.find({ ...notArchive, createdAt: { $gte: start } }).populate({ path: "status" });

    // this month order amount
    const totalAmountOfThisMonth = await Order.aggregate([
      {
        $match: notArchive,
      },
      {
        $group: {
          _id: {
            year: {
              $year: "$createdAt",
            },
            month: {
              $month: "$createdAt",
            },
          },
          total: {
            $sum: "$total",
          },
        },
      },
      {
        $sort: { _id: -1 },
      },
      {
        $limit: 1,
      },
    ]);

    // total padding order count
    const totalPendingOrder = await Order.aggregate([
      {
        $match: {
          status: pendingStatus._id,
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$total" },
          count: {
            $sum: 1,
          },
        },
      },
    ]);

    // total delivered order count
    const totalProcessingOrder = await Order.aggregate([
      {
        $match: {
          status: processingStatus._id,
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$total" },
          count: {
            $sum: 1,
          },
        },
      },
    ]);

    // total delivered order count
    const totalDeliveredOrder = await Order.aggregate([
      {
        $match: {
          $or: [
            { status: deliveredStatus._id },
            { status: { $in: melaketStatusIds } },
          ],
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$total" },
          count: {
            $sum: 1,
          },
        },
      },
    ]);

    //weekly sale report
    // filter order data
    const weeklySaleReport = await Order.find({
      $or: [
        { status: deliveredStatus._id },
        { status: { $in: melaketStatusIds } }
      ],
      createdAt: {
        $gte: week,
      },
    });

    res.send({
      totalOrder: totalDoc,
      totalAmount:
        totalAmount.length === 0
          ? 0
          : parseFloat(totalAmount[0].tAmount).toFixed(2),
      todayOrder: todayOrder,
      totalAmountOfThisMonth:
        totalAmountOfThisMonth.length === 0
          ? 0
          : parseFloat(totalAmountOfThisMonth[0].total).toFixed(2),
      totalPendingOrder:
        totalPendingOrder.length === 0 ? 0 : totalPendingOrder[0],
      totalProcessingOrder:
        totalProcessingOrder.length === 0 ? 0 : totalProcessingOrder[0].count,
      totalDeliveredOrder:
        totalDeliveredOrder.length === 0 ? 0 : totalDeliveredOrder[0].count,
      orders,
      weeklySaleReport,
    });
  } catch (err) {
    console.log('getDashboardOrders error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

// פונקציה לטיפול בדיווח על שגיאות שליחת WhatsApp
const handleWhatsappMessageFailure = async (req, res) => {
  try {
    const { failedMessages } = req.body;

    if (!failedMessages || !Array.isArray(failedMessages) || failedMessages.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No failed messages provided",
      });
    }

    // הכנת המידע עבור המייל
    const emailData = {
      failedMessages,
      timestamp: new Date().toISOString(),
      serverInfo: {
        environment: process.env.NODE_ENV || 'development',
        serverName: 'Kirshner WhatsApp Server',
      },
    };

    // שליחת מייל עם דיווח השגיאות
    const emailBody = {
      from: `"${process.env.COMPANY_NAME}" <${process.env.EMAIL_USER}>`,
      to: process.env.OUR_EMAIL, // האימייל שלנו
      subject: `🚨 שגיאות שליחת הודעת וואטסאפ - ${failedMessages.length} הודעות נכשלו`,
      html: whatsappErrorEmailBody(emailData),
    };

    // שליחת המייל באמצעות הפונקציה הקיימת
    sendEmail(emailBody, res, `WhatsApp error report sent successfully. ${failedMessages.length} failed messages reported to email ${process.env.OUR_EMAIL}`);

    // לוג מפורט בשרת
    console.error('WhatsApp Message Failures Report:', {
      timestamp: emailData.timestamp,
      totalFailed: failedMessages.length,
      messageTypes: [...new Set(failedMessages.map(m => m.messageType))],
      affectedPhones: [...new Set(failedMessages.map(m => m.userPhone))],
      errors: failedMessages.map(m => ({
        invoice: m.orderInvoice,
        phone: m.userPhone,
        error: m.errorMessage,
        type: m.messageType,
      })),
    });

  } catch (error) {
    console.error('Error in handleWhatsappMessageFailure:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send WhatsApp error report',
      error: error.message,
    });
  }
};

// פונקציה לבדיקת הזמנות בליקוט יותר משעה וחצי והחזרתן לבטיפול
const checkStuckLikutOrders = async () => {
  try {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - (2 * 60 * 60 * 1000)); // שעתיים אחורה

    // מציאת סטטוס ליקוט ובטיפול
    const likutStatus = await Status.findOne({ name: "Likut" });
    const processingStatus = await Status.findOne({ name: "Processing" });

    if (!likutStatus || !processingStatus) {
      console.log("Could not find required statuses for stuck orders check");
      return;
    }

    // מציאת כל ההזמנות בסטטוס ליקוט שהתעדכנו לפני שעה וחצי
    const stuckOrders = await Order.find({
      status: likutStatus._id,
      updatedAt: { $lte: twoHoursAgo }
    }).populate('status').populate('actualMelaket');

    if (stuckOrders.length === 0) {
      console.log("🕺 No stuck orders found in Likut status");
      return;
    }

    console.log(`⚠️ Found ${stuckOrders.length} stuck orders in Likut status`);

    // מערך לשמירת פרטי המלקטים שצריך לשלוח להם הודעות
    const abandonedOrderNotices = [];

    // עדכון כל ההזמנות התקועות
    for (const order of stuckOrders) {
      // שמירת פרטי המלקט לפני עדכון ההזמנה
      if (order.actualMelaket && order.actualMelaket.phone) {
        const captureTime = dayjs(order.updatedAt).tz("Asia/Jerusalem").format("DD/MM/YYYY HH:mm");
        const releaseTime = dayjs().tz("Asia/Jerusalem").format("DD/MM/YYYY HH:mm");

        abandonedOrderNotices.push({
          melaketNameHe: order.actualMelaket.heName || order.actualMelaket.name,
          melaketNameEn: order.actualMelaket.name,
          melaketPhone: order.actualMelaket.phone,
          orderInvoice: order.invoice,
          captureTime,
          releaseTime,
        });
      }

      // עדכון הסטטוס והסרת המלקט
      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            status: processingStatus._id,
            actualMelaket: null
          }
        }
      );

      // טעינה מחדש של ההזמנה המעודכנת עבור הלוג
      const updatedOrder = await Order.findById(order._id).populate('status');

      // הדפסת שינוי סטטוס ההזמנה
      logStatusChange({
        from: "Likut",
        to: "Processing",
        functionName: "checkStuckLikutOrders (cron)",
        order: updatedOrder,
      });

      console.log(`✅ Order ${order.invoice} moved from Likut to Processing (stuck for more than 2 hours)`);
    }

    console.log(`✅ Successfully processed ${stuckOrders.length} stuck orders`);

    // שליחת הודעות למלקטים על הזמנות שננטשו
    if (abandonedOrderNotices.length > 0) {
      console.log(`🥏 Starting to send abandoned order notices to ${abandonedOrderNotices.length} workers...`);

      for (let i = 0; i < abandonedOrderNotices.length; i++) {
        const notice = abandonedOrderNotices[i];

        try {
          console.log(`📤 [${i + 1}/${abandonedOrderNotices.length}] Sending abandoned order notice to ${notice.melaketNameEn} (${notice.melaketPhone}) for order ${notice.orderInvoice}`);

          // שליחת הבקשה לשרת WhatsApp
          const response = await axios.post(
            `${process.env.KIRSHNER_WHATSAPP_URL}/send-abandoned-order-notice`,
            notice,
            {
              headers: {
                "x-api-key": process.env.KIRSHNER_WHATSAPP_API_KEY,
                "Content-Type": "application/json",
              },
              timeout: 10000, // 10 seconds timeout
            }
          );

          if (response.data.success) {
            console.log(`✅ [${i + 1}/${abandonedOrderNotices.length}] Successfully sent abandoned order notice to ${notice.melaketNameEn} for order ${notice.orderInvoice}`);
          } else {
            console.log(`⚠️ [${i + 1}/${abandonedOrderNotices.length}] WhatsApp server responded with error for ${notice.melaketNameEn}: ${response.data.message}`);
          }

        } catch (notificationError) {
          console.error(`❌ [${i + 1}/${abandonedOrderNotices.length}] Failed to send abandoned order notice to ${notice.melaketNameEn} (${notice.melaketPhone}) for order ${notice.orderInvoice}:`, notificationError.message);

          // הדפסת פרטים נוספים של השגיאה
          if (notificationError.response) {
            console.error(`   Response status: ${notificationError.response.status}`);
            console.error(`   Response data:`, notificationError.response.data);
          } else if (notificationError.request) {
            console.error(`   No response received from WhatsApp server`);
          }
        }

        // המתנה של 5 שניות בין הודעות (חוץ מההודעה האחרונה)
        if (i < abandonedOrderNotices.length - 1) {
          console.log(`⏳ Waiting 5 seconds before sending next notice...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }

      console.log(`📱 Finished sending abandoned order notices. Total processed: ${abandonedOrderNotices.length}`);
    } else {
      console.log(`📱 No abandoned order notices to send (no melaket info found for stuck orders)`);
    }

  } catch (error) {
    console.error("❌ Error in checkStuckLikutOrders:", error);
  }
};

checkStuckLikutOrders();

// הפעלה כל 10 דקות
cron.schedule('*/10 * * * *', () => {
  console.log('🔁 Running stuck orders check every 10 minutes...');
  checkStuckLikutOrders();
});

const rateOrdersOneTime = async (ordersInvoices = [{ invoice: Number, rate: Number }]) => {
  try {
    console.log(`🎯 Starting to rate ${ordersInvoices.length} orders...`);

    const results = {
      success: [],
      failed: [],
      notFound: []
    };

    for (let i = 0; i < ordersInvoices.length; i++) {
      const { invoice, rate } = ordersInvoices[i];

      try {
        console.log(`📝 [${i + 1}/${ordersInvoices.length}] Processing order ${invoice} with rating ${rate}`);

        // בדיקת תקינות הנתונים
        if (!invoice || !rate || rate < 1 || rate > 3) {
          console.log(`❌ Invalid data for order ${invoice}: rate must be between 1-3`);
          results.failed.push({ invoice, rate, error: 'Invalid rating (must be 1-3)' });
          continue;
        }

        // מציאת ההזמנה לפי invoice
        const order = await Order.findOne({ invoice: invoice });

        if (!order) {
          console.log(`❌ Order ${invoice} not found`);
          results.notFound.push({ invoice, rate });
          continue;
        }

        // עדכון הדירוג
        order.customerSatisfaction = rate;

        // שמירה - ה-hooks יחשבו את הבונוס אוטומטיט
        await order.save();

        console.log(`✅ [${i + 1}/${ordersInvoices.length}] Order ${invoice} rated successfully with ${rate} stars. Bonus: ${order.bonus || 0}`);
        results.success.push({
          invoice,
          rate,
          bonus: order.bonus,
          previousRating: order.customerSatisfaction
        });

      } catch (orderError) {
        console.error(`❌ Error processing order ${invoice}:`, orderError.message);
        results.failed.push({ invoice, rate, error: orderError.message });
      }

      // המתנה קטנה בין הזמנות כדי לא לעמוס על המסד
      if (i < ordersInvoices.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // סיכום התוצאות
    console.log(`\n📊 Rating process completed:`);
    console.log(`✅ Successfully rated: ${results.success.length} orders`);
    console.log(`❌ Failed to rate: ${results.failed.length} orders`);
    console.log(`🔍 Orders not found: ${results.notFound.length} orders`);

    if (results.success.length > 0) {
      console.log(`💰 Total bonus generated: ${results.success.reduce((sum, order) => sum + (order.bonus || 0), 0).toFixed(2)}`);
    }

    return results;

  } catch (error) {
    console.error('❌ Error in rateOrdersOneTime:', error);
    throw error;
  }
};

// setTimeout(() => {
//   rateOrdersOneTime([
//     { invoice: 33591, rate: 1 },
//     { invoice: 35774, rate: 1 },
//     { invoice: 34758, rate: 1 },
//     { invoice: 34564, rate: 1 },
//     { invoice: 32567, rate: 1 },
//     { invoice: 33815, rate: 1 },
//     { invoice: 33780, rate: 1 },
//     { invoice: 32728, rate: 1 },
//     { invoice: 33634, rate: 1 },
//     { invoice: 32579, rate: 1 },
//     { invoice: 34857, rate: 1 }
//   ]);
// }, 5000);

// PUT /api/orders/:id/items — עריכת שורות ההזמנה מהפאנל.
//
// נפרד מ-updateOrder בכוונה: זה מסלול הסטטוס, והוא מוגן בסיסמה משותפת
// שאין לה קשר לתוכן ההזמנה. הלוגיקה עצמה יושבת ב-lib/orders/editItems כדי
// שסקריפט תיקון יוכל לקרוא לה בלי לעבור דרך HTTP.
const updateOrderItems = async (req, res) => {
  try {
    const result = await editOrderItems(req.params.id, {
      items: req.body?.items,
      shippingCost: req.body?.shippingCost,
      discount: req.body?.discount,
      allowLockedNote: req.body?.allowLockedNote === true,
      expectedUpdatedAt: req.body?.expectedUpdatedAt,
      // req.user נקבע ב-isAdmin, ולא נלקח מגוף הבקשה: שורת התיעוד ב-systemNote
      // צריכה לומר מי באמת ביצע. המייל ולא השם, כי שם המנהל הוא לעיתים
      // אובייקט רב-לשוני
      changedBy: req.user?.email || undefined,
    });

    res.status(200).send({
      message: "שורות ההזמנה עודכנו",
      order: result.order,
      changes: result.changes,
      totals: result.totals,
      note: result.note,
    });
  } catch (err) {
    if (err instanceof OrderEditError) {
      // code ו-noteNumber נשלחים כדי שהפאנל יוכל להציג אישור ממוקד
      // ("התעודה כבר חויבה — לעדכן בכל זאת?") ולא רק הודעת שגיאה
      return res.status(err.status).send({
        message: err.message,
        code: err.code,
        noteNumber: err.noteNumber,
        noteStatus: err.noteStatus,
      });
    }
    console.error("updateOrderItems error: ", err);
    res.status(500).send({ message: err.message });
  }
};

module.exports = {
  getAllOrders,
  getOrderById,
  getOrderCustomer,
  updateOrder,
  updateOrderItems,
  updateOrderWebHook,
  deleteOrder,
  bestSellerProductChart,
  getDashboardOrders,
  getDashboardRecentOrder,
  getDashboardCount,
  getDashboardAmount,
  getProcessingAndLikutOrders,
  updateOrderStatusApp,
  getCompletedOrders,
  sendOrderAndUpdateStatus,
  getSurveyOrders,
  updateSurveyResponse,
  handleWhatsappMessageFailure,
  checkStuckLikutOrders,
};

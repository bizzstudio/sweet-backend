// controller/cashierOrderController.js
require("dotenv").config();
const mongoose = require('mongoose');
const Coupon = require("../models/Coupon");
const Order = require("../models/Order");
const Offer = require("../models/Offer");
const Product = require("../models/Product");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const CashierOrder = require("../models/CashierOrder");
const { handleProductQuantity } = require("../lib/stock-controller/others");
const { findOptimalOfferCombination } = require("../utils/offerCalculations");
const { findServerItemForClientLine } = require("../utils/cartOfferSync");

dayjs.extend(utc);
dayjs.extend(timezone);

const addCashierOrder = async (req, res) => {
  try {

    // שלב 1: אחזור פרטי העגלה
    const cartItems = req.body.cart;
    let serverCalculatedTotal = 0;
    let serverSubTotal = 0
    let totalDiscount = 0;
    let missingProducts = []; // מערך לשמירת המוצרים החסרים
    let priceConflicts = []; // מערך לשמירת מוצרים שהשתנה להם המחיר

    // שלב 2: בדיקת זמינות המוצרים
    const productIds = cartItems.map(item => item._id);
    const products = await Product.find({ _id: { $in: productIds } })
      .populate({ path: "category", select: "_id name" })
      .populate({ path: "categories", select: "_id name" });
    const productMap = new Map(products.map(product => [product._id.toString(), product]));

    // בדיקה על מוצרים חסרים או ששונה להם המחיר
    for (const item of cartItems) {
      const product = productMap.get(item._id.toString());

      // console.log('client cart item :>> ', item);

      // פריט מתנה/פרס: המוצר עשוי להיות מוסתר ולא נמכר ישירות — ניתן רק דרך מבצע.
      // מדלגים על בדיקות זמינות/מלאי ומוודאים רק שהמוצר עדיין קיים.
      const isGiftItem = Boolean(
        item?.isRewardProduct || item?.isWelcomeGift || item?.isCouponFreeProduct
      );

      if (!product) {
        // המוצר לא נמצא במאגר הנתונים
        missingProducts.push({
          ...item,
          reason: 'המוצר לא נמצא'
        });
      } else if (isGiftItem) {
        // מתנה/פרס — לא נחסם ע"י הסתרה/מלאי
      } else if (typeof product.stock === "number" && product.stock < item.quantity) {
        // מלאי לא מספק (מלאי null = בלתי מוגבל)
        missingProducts.push({
          ...product.toObject(),
          reason: 'לא במלאי'
        });
      } else if (product.status != "show") {
        // המוצר אינו זמין
        missingProducts.push({
          ...product.toObject(),
          reason: 'המוצר אינו זמין'
        });
      }
      // else if (product.purchaseLimit && item.quantity > product.purchaseLimit) {
      //   // כמות הכמות שביקש הלוקוח עוברת את ההגבלה
      //   missingProducts.push({
      //     ...product.toObject(),
      //     reason: `הכמות המבוקשת חורגת ממגבלת הקנייה (${product.purchaseLimit})`
      //   });
      // };

      // השוואת מחיר בסיס (ללא מבצע) — מתנות/פרסים נשארים במחיר המבצע
      if (product && !isGiftItem && item.prices.price !== product.prices.price) {
        // console.log('server product :>> ', product);
        priceConflicts.push({
          product: product.toObject(),
          clientPrice: item.prices.price,
          serverPrice: product.prices.price
        });
      }
    };

    // אם יש מוצרים חסרים, החזר אותם לקליינט וסיים את הביצוע
    if (missingProducts.length > 0) {
      return res.status(409).send({
        keyWord: "missingProducts",
        message: "המוצרים הבאים אינם זמינים יותר",
        missingProducts
      });
    };

    // אם יש פריטים בקונפליקט מחירים, נחזיר תשובה ללקוח ונפסיק את הביצוע
    if (priceConflicts.length > 0) {
      return res.status(409).send({
        keyWord: "priceConflicts",
        message: "למוצרים הבאים השתנה המחיר",
        priceConflicts
      });
    };

    // שלב 5: שליפת המבצעים
    const getNotActiveOffers = process.env.GET_NOT_ACTIVE_OFFERS === "true";

    let offerFilter = {};

    // אם לא במצב development - סנן מבצעים פעילים
    if (!getNotActiveOffers) {
      const now = new Date();
      const offerFilterConditions = [
        { isActive: true },
        {
          $or: [
            { startsAt: { $exists: false } },
            { startsAt: null },
            { startsAt: { $lte: now } }
          ]
        },
        {
          $or: [
            { endsAt: { $exists: false } },
            { endsAt: null },
            { endsAt: { $gte: now } }
          ]
        }
      ];

      offerFilter = { $and: offerFilterConditions };
    }

    // משיכת כל המבצעים הרלוונטים
    const offers = await Offer.find(offerFilter)
      .populate({ path: "products" })
      .populate({ path: "rewardProduct" })
      .populate({ path: "rewardProducts" })
      .populate({ path: "triggerProduct" });

    const waivedOfferIds = Array.isArray(req.body.waivedOfferIds)
      ? req.body.waivedOfferIds.map((id) => String(id))
      : [];
    const waivedExclusiveOfferIds = Array.isArray(req.body.waivedExclusiveOfferIds)
      ? req.body.waivedExclusiveOfferIds.map((id) => String(id))
      : [];
    const lockedExclusiveOfferId =
      req.body.lockedExclusiveOfferId != null && String(req.body.lockedExclusiveOfferId).length > 0
        ? String(req.body.lockedExclusiveOfferId)
        : null;

    // חישוב מבצעים בשרת בלבד: cartItems מה-body + מבצעים מה-DB — ללא snapshot/FROZEN מהלקוח
    const {
      updatedCartItems: itemsWithOffers,
      totalDiscount: offerDiscount,
      appliedOffers,
      thresholdDiscount
    } = findOptimalOfferCombination(cartItems, offers, {
      waivedOfferIds,
      waivedExclusiveOfferIds,
      lockedExclusiveOfferId
    });
    totalDiscount += offerDiscount;

    // אם יש מבצעים לא מעודכנים שהגיעו מהקליינט נחזיק קונפליקט ללקוח
    let offerConflicts = []; // מערך לשמירת מוצרים שהשתנה להם המבצע
    for (const clientItem of cartItems) {
      const serverItem = findServerItemForClientLine(clientItem, itemsWithOffers);

      const clientDiscounted = clientItem.discountedPrice ?? null;
      const serverDiscounted = serverItem?.discountedPrice ?? null;
      const offerTitle = serverItem?.offerTitle?.he;

      if (clientDiscounted !== serverDiscounted) {
        offerConflicts.push({
          product: serverItem ?? clientItem,
          clientDiscounted,
          serverDiscounted,
          offerTitle,
        });
      }
    }

    // חישוב הסכום הכולל לאחר החלת המבצעים
    itemsWithOffers.forEach(item => {
      if (item.isRewardProduct) {
        // מוצר פרס - מחיר לפי rewardPrice
        serverCalculatedTotal += (item.rewardPrice || 0) * item.quantity;
      } else if (item.discountedPrice) {
        // מוצר עם הנחת מבצע
        serverCalculatedTotal += item.discountedPrice;
      } else {
        // מוצר במחיר רגיל
        serverCalculatedTotal += item.prices.price * item.quantity;
      }
    });

    // שמירת המחיר הכולל לפני הנחות
    serverSubTotal = serverCalculatedTotal;

    // הפחתת הנחת קניה מעל סכום (THRESHOLD_DISCOUNT) אם קיימת
    if (thresholdDiscount && thresholdDiscount > 0) {
      serverCalculatedTotal -= thresholdDiscount;
    }

    // שלב 7: חישוב הנחה מקופון (מאפסים קופון אם לא נשלח מפורש – מונע שימוש בקופון ישן מתשלום קודם)
    let couponDiscount = 0;
    const couponIdRaw = req.body.coupon;
    const couponId = (couponIdRaw && String(couponIdRaw).trim() !== "") ? couponIdRaw : null;
    let coupon = null;
    if (couponId) {
      coupon = await Coupon.findById(couponId);
      if (!coupon) {
        return res.status(404).send({ message: "קופון לא נמצא!" });
      }
      if (coupon.isUsed) {
        return res.status(400).send({ message: "הקופון כבר שומש ואינו ניתן לשימוש חוזר!" });
      }
      const currentTime = dayjs().utc().toDate();
      if (coupon.startTime && currentTime < coupon.startTime) {
        return res.status(400).send({ message: "קופון עדיין לא בתוקף!" });
      }
      if (coupon.endTime && currentTime > coupon.endTime) {
        return res.status(400).send({ message: "קופון פג תוקף!" });
      }
      if (coupon.status == 'hide') {
        return res.status(400).send({ message: "קופון לא פעיל!" });
      }
      // קופון הרשמה (מוצר חינם) אינו נתמך בקופה — מחייב לקוח מחובר לאכיפת "פעם אחת לכל לקוח"
      if (coupon.freeProduct) {
        return res.status(400).send({ message: "קופון הרשמה (מוצר חינם) אינו נתמך בקופה." });
      }
      if (coupon.discountType.type === "fixed" && coupon.discountType.value < serverCalculatedTotal) {
        couponDiscount = coupon.discountType.value;
      } else if (coupon.discountType.type === "percentage") {
        couponDiscount = (coupon.discountType.value / 100) * serverCalculatedTotal;
      }
      console.log('couponDiscount: ', couponDiscount);
      serverCalculatedTotal -= couponDiscount;
    }

    // שלב 8: אימות הסכום הכולל
    console.log(`FINAL serverCalculatedTotal for cashier ${req.user.email}: `, serverCalculatedTotal.toFixed(2), 'req.body.total: ', req.body.total.toFixed(2))
    if (Math.abs(serverCalculatedTotal.toFixed(2) - req.body.total.toFixed(2)) > 0.01) {
      console.error("***Server Calculated Total is not match with req.body.total!***");
      return res.status(400).send({ message: "שגיאה! סכום הזמנה לא תואם לסכום הפריטים." });
    }

    // שלב 9: חילוץ המבצעים למערך "נוצלו מהעגלה" לצורך מעקב
    const usedOfferIds = [];
    itemsWithOffers.forEach(item => {
      // מבצעים על מוצרי פרס
      if (item.isRewardProduct && item.rewardOfferId) {
        const offerIdStr = item.rewardOfferId.toString();
        if (!usedOfferIds.includes(offerIdStr)) {
          usedOfferIds.push(offerIdStr);
        }
      }
      // מבצעים על מוצרים רגילים
      if (item.appliedOffers && Array.isArray(item.appliedOffers)) {
        item.appliedOffers.forEach(offer => {
          if (offer.offerId) {
            const offerIdStr = offer.offerId.toString();
            if (!usedOfferIds.includes(offerIdStr)) {
              usedOfferIds.push(offerIdStr);
            }
          }
        });
      }
    });

    // הוספת מבצעי THRESHOLD_DISCOUNT ל-usedOfferIds
    appliedOffers.forEach(offer => {
      if (offer.type === 'THRESHOLD_DISCOUNT' && offer.offerId) {
        const offerIdStr = offer.offerId.toString();
        if (!usedOfferIds.includes(offerIdStr)) {
          usedOfferIds.push(offerIdStr);
        }
      }
    });

    // שלב 10: יצירת הזמנת קופאי חדשה
    const newCashierOrder = new CashierOrder({
      cashier: req.user._id,
      cart: itemsWithOffers,
      user_info: req.body.user_info,
      subTotal: serverSubTotal.toFixed(2),
      total: serverCalculatedTotal.toFixed(2),
      discount: couponDiscount,
      offerDiscount: thresholdDiscount || 0, // הנחת קניה מעל סכום (THRESHOLD_DISCOUNT)
      coupon: coupon ? coupon._id : null,
      usedOfferIds: usedOfferIds, // שמירת המבצעים שנוצלו
    });
    const order = await newCashierOrder.save();

    // מימוש הקופון מיידית
    if (coupon) {
      if (coupon.discountType.type === "percentage") {
        coupon.timesIsUsed += 1;
      } else if (coupon.discountType.type === "fixed") {
        coupon.timesIsUsed += 1;
        coupon.isUsed = true; // סימון קופון כמשומש אם הוא מסוג "fixed"
      }

      await coupon.save();
    }

    // עדכון מלאי
    handleProductQuantity(order.cart);

    res.status(200).send({
      message: {
        he: "ההזמנה נוצרה בהצלחה!",
        en: "Order created successfully!",
      },
      order,
    });

  } catch (err) {
    console.log('addCashierOrder error: ', err);
    res.status(500).send({ message: err.message });
  }
};

const getAllCashierOrders = async (req, res) => {
  const {
    day,
    page,
    limit,
    startDate,
    endDate,
    customerName,
  } = req.query;

  //  day count
  let date = new Date();
  const today = date.toString();
  date.setDate(date.getDate() - Number(day));
  const dateTime = date.toString();

  const beforeToday = new Date();
  beforeToday.setDate(beforeToday.getDate() - 1);
  // const before_today = beforeToday.toString();

  // בנית aggregation pipeline
  let pipeline = [];

  // שלב 1: Lookup לקופאי וקופון
  pipeline.push(
    {
      $lookup: {
        from: "customers", // כיוון שהקופאי מוגדר כ-Customer
        localField: "cashier",
        foreignField: "_id",
        as: "cashierData"
      }
    },
    {
      $lookup: {
        from: "coupons",
        localField: "coupon",
        foreignField: "_id",
        as: "couponData"
      }
    }
  );

  // שלב 2: בנית match object
  const matchConditions = {};

  if (customerName) {
    // לבדוק אם ה-customerName הוא מספר תקין
    const orderNumber = Number(customerName);
    if (!isNaN(orderNumber)) {
      matchConditions.$or = [
        { "user_info.name": { $regex: `${customerName}`, $options: "i" } },
        { "user_info.phone": { $regex: `${customerName}`, $options: "i" } },
        { "total": orderNumber },
        { "invoice": orderNumber },
        { "cashierData.name": { $regex: `${customerName}`, $options: "i" } },
        { "couponData.couponCode": { $regex: `${customerName}`, $options: "i" } }
      ];
    } else {
      matchConditions.$or = [
        { "user_info.name": { $regex: `${customerName}`, $options: "i" } },
        { "user_info.phone": { $regex: `${customerName}`, $options: "i" } },
        { "cashierData.name": { $regex: `${customerName}`, $options: "i" } },
        { "couponData.couponCode": { $regex: `${customerName}`, $options: "i" } }
      ];
    }
  }

  if (day) {
    queryObject.createdAt = { $gte: dateTime, $lte: today };
  }

  if (startDate && endDate) {
    const startDateData = new Date(startDate);
    // startDateData.setHours(0, 0, 0, 0);

    const endDateData = new Date(endDate);
    endDateData.setHours(23, 59, 59, 999); // הגדר את השעה בסוף היום של תאריך הסיום

    matchConditions.updatedAt = {
      $gte: startDateData,
      $lte: endDateData,
    };
  }

  // הוספת match stage אם יש תנאים
  if (Object.keys(matchConditions).length > 0) {
    pipeline.push({ $match: matchConditions });
  }

  const pages = Number(page) || 1;
  const limits = Number(limit) || 25;
  const skip = (pages - 1) * limits;

  try {
    // חישוב סה"כ מסמכים
    const countPipeline = [...pipeline, { $count: "total" }];
    const countResult = await CashierOrder.aggregate(countPipeline);
    const totalDoc = countResult[0]?.total || 0;

    // חישוב נתונים סטטיסטיים
    const statisticsPipeline = [
      ...pipeline,
      {
        $group: {
          _id: null,
          totalAmount: { $sum: "$total" },
          totalDiscount: { $sum: "$discount" },
        }
      }
    ];

    const statisticsData = await CashierOrder.aggregate(statisticsPipeline);
    const statistics = statisticsData[0] || {
      totalAmount: 0,
      totalDiscount: 0,
      totalSubTotal: 0
    };

    statistics.totalSubTotal = statistics.totalAmount - statistics.totalDiscount;

    // קבלת ההזמנות עם pagination
    const ordersPipeline = [
      ...pipeline,
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limits },
      {
        $addFields: {
          cashier: { $arrayElemAt: ["$cashierData", 0] },
          coupon: { $arrayElemAt: ["$couponData", 0] }
        }
      },
      {
        $project: {
          cashierData: 0,
          couponData: 0,
          "cashier.password": 0,
          "cashier.createdAt": 0,
          "cashier.updatedAt": 0,
          "cashier.__v": 0
        }
      }
    ];

    const orders = await CashierOrder.aggregate(ordersPipeline);

    res.send({
      orders,
      limits,
      pages,
      totalDoc,
      totalAmount: parseFloat(statistics.totalAmount).toFixed(2),
      totalDiscount: parseFloat(statistics.totalDiscount).toFixed(2),
      totalSubTotal: parseFloat(statistics.totalSubTotal).toFixed(2),
    });
  } catch (err) {
    console.log('getAllCashierOrders error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const getCashierOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    let order;

    // בדיקה אם ה-ID הוא ObjectId תקף
    if (mongoose.Types.ObjectId.isValid(id)) {
      // אם כן, נחפש לפי _id
      order = await CashierOrder.findById(id)
        .populate({ path: "cashier", select: "name lastName email" })
        .populate({ path: "coupon" });
    } else {
      // אחרת נחפש לפי invoice
      order = await CashierOrder.findOne({ invoice: id })
        .populate({ path: "cashier", select: "name lastName email" })
        .populate({ path: "coupon" });
    }

    if (!order) {
      return res.status(404).send({ message: "Order not found" });
    }

    res.send(order);
  } catch (err) {
    console.log('getCashierOrderById error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const deleteCashierOrder = async (req, res) => {
  try {
    await CashierOrder.deleteOne({ _id: req.params.id });
    res.status(200).send({
      message: "Order Deleted Successfully!",
    });
  } catch (err) {
    console.log('deleteCashierOrder error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const getCashierDashboardCount = async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0); // Set the time to midnight for today

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1); // Set the time to midnight for yesterday

  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1); // Set the time to midnight for tomorrow

  const year = today.getFullYear();
  const month = today.getMonth();

  const thisMonthStartDate = new Date(year, month, 1);
  const thisMonthEndDate = tomorrow;

  let lastMonthStartDate, lastMonthEndDate;

  if (month === 0) {
    // אם זה ינואר, החודש הקודם הוא דצמבר של השנה הקודמת
    lastMonthStartDate = new Date(year - 1, 11, 1);
    lastMonthEndDate = new Date(year - 1, 11, 31);
  } else {
    lastMonthStartDate = new Date(year, month - 1, 1);
    lastMonthEndDate = new Date(year, month, 0); // היום האחרון בחודש הקודם
  }

  try {
    // פונקציית אגירה גנרית
    const aggregateOrders = async (additionalFilter) => {
      return await CashierOrder.aggregate([
        { $match: { ...additionalFilter } },
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
    const totalOrdersToday = await aggregateOrders({ createdAt: { $gte: today, $lt: tomorrow } });

    // כל ההזמנות מהחודש הנוכחי
    const totalOrdersThisMonth = await aggregateOrders({ createdAt: { $gte: thisMonthStartDate, $lt: thisMonthEndDate } });

    // כל ההזמנות מאז ומתמיד
    const totalOrders = await aggregateOrders();

    res.send({
      allTime: {
        totalOrders: totalOrders[0] || { _id: null, total: 0, count: 0 },
      },
      today: {
        totalOrders: totalOrdersToday[0] || { _id: null, total: 0, count: 0 },
      },
      thisMonth: {
        totalOrders: totalOrdersThisMonth[0] || { _id: null, total: 0, count: 0 },
      },
    });
  } catch (err) {
    console.log('getCashierDashboardCount error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const getCashierDashboardAmount = async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0); // Set the time to midnight for today

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1); // Set the time to midnight for yesterday

  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1); // Set the time to midnight for tomorrow

  const week = new Date(today);
  week.setDate(today.getDate() - 7); // Set the time to midnight for tomorrow

  const year = today.getFullYear();
  const month = today.getMonth();

  const thisMonthStartDate = new Date(year, month, 1);
  const thisMonthEndDate = tomorrow;

  let lastMonthStartDate, lastMonthEndDate;

  if (month === 0) {
    // אם זה ינואר, החודש הקודם הוא דצמבר של השנה הקודמת
    lastMonthStartDate = new Date(year - 1, 11, 1);
    lastMonthEndDate = new Date(year - 1, 11, 31);
  } else {
    lastMonthStartDate = new Date(year, month - 1, 1);
    lastMonthEndDate = new Date(year, month, 0); // היום האחרון בחודש הקודם
  }

  // console.log('thisMonthStartDate: ', thisMonthStartDate)
  // console.log('thisMonthEndDate: ', thisMonthEndDate)
  // console.log('lastMonthStartDate: ', lastMonthStartDate)
  // console.log('lastMonthEndDate: ', lastMonthEndDate)

  try {
    // total CashierOrder amount - תיקון: להוציא את הפילטר של היום
    const totalAmount = await CashierOrder.aggregate([
      {
        $group: {
          _id: null,
          tAmount: {
            $sum: "$total",
          },
        },
      },
    ]);

    // today's CashierOrder amount
    const todayAmount = await CashierOrder.aggregate([
      {
        $project: {
          year: { $year: "$updatedAt" },
          month: { $month: "$updatedAt" },
          total: 1,
          subTotal: 1,
          discount: 1,
          updatedAt: 1,
          createdAt: 1,
        },
      },
      {
        $match: {
          createdAt: { $gte: today, $lt: tomorrow },
        },
      },
      {
        $group: {
          _id: {
            day: {
              $dayOfMonth: "$createdAt",
            },
          },
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

    // yesterday's CashierOrder amount
    const yesterdayAmount = await CashierOrder.aggregate([
      {
        $project: {
          year: { $year: "$updatedAt" },
          month: { $month: "$updatedAt" },
          total: 1,
          subTotal: 1,
          discount: 1,
          updatedAt: 1,
          createdAt: 1,
        },
      },
      {
        $match: {
          createdAt: { $gte: yesterday, $lt: today },
        },
      },
      {
        $group: {
          _id: {
            day: {
              $dayOfMonth: "$createdAt",
            },
          },
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
    const thisMonthOrderAmount = await CashierOrder.aggregate([
      {
        $project: {
          year: { $year: "$updatedAt" },
          month: { $month: "$updatedAt" },
          total: 1,
          subTotal: 1,
          discount: 1,
          updatedAt: 1,
          createdAt: 1,
        },
      },
      {
        $match: {
          updatedAt: { $gte: thisMonthStartDate, $lt: thisMonthEndDate },
        },
      },
      {
        $group: {
          _id: {
            month: {
              $month: "$updatedAt",
            },
          },
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

    // last month's CashierOrder amount
    const lastMonthOrderAmount = await CashierOrder.aggregate([
      {
        $project: {
          year: { $year: "$updatedAt" },
          month: { $month: "$updatedAt" },
          total: 1,
          subTotal: 1,
          discount: 1,
          updatedAt: 1,
          createdAt: 1,
        },
      },
      {
        $match: {
          updatedAt: { $gte: lastMonthStartDate, $lt: lastMonthEndDate },
        },
      },
      {
        $group: {
          _id: {
            month: {
              $month: "$updatedAt",
            },
          },
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

    // CashierOrder list last 10 days
    const orderFilteringData = await CashierOrder.find(
      {
        updatedAt: {
          $gte: week,
        },
      },
      {
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
    console.log('getCashierDashboardAmount error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

module.exports = {
  addCashierOrder,
  getAllCashierOrders,
  getCashierOrderById,
  deleteCashierOrder,
  getCashierDashboardCount,
  getCashierDashboardAmount,
};
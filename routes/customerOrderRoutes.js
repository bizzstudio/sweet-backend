// routes/customerOrderRoutes.js
const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const {
  addOrder,
  getOrderById,
  getOrderCustomer,
} = require("../controller/customerOrderController");
const { createGuestCustomer } = require("../controller/customerController");
const { isAuth, isOrderTokenValid, extractUserDetails } = require("../config/auth");
const { clientIpKeyGenerator } = require("../lib/email-sender/sender");
const { PAYMENT_DISABLED } = require("../utils/paymentDisabled");

/*
 * הגבלת קצב על הזמנת אורח.
 *
 * כל עוד הייתה סליקה, הזמנת אורח שלא שולמה נשארה טיוטה (Pending) ונמחקה
 * בהזמנה הבאה — היא לא נגעה במלאי ולא הפיקה תעודת משלוח. כשהסליקה כבויה
 * (PAYMENT_DISABLED) כל בקשה כזו היא **הזמנה אמיתית**: יורדת מהמלאי, מפיקה
 * תעודה ושולחת מיילים, ואין שום שלב אימות בדרך — נתיב פתוח לחלוטין.
 * התקרה היא מה שנשאר במקום שער התשלום.
 *
 * התקרה מכוונת גבוה בכוונה: מספר לקוחות מאחורי NAT משותף (משרד, בית ספר)
 * חולקים IP, וחסימה שגויה עולה הזמנה אבודה. 20 הזמנות ברבע שעה מאותו IP
 * אינן תרחיש אמיתי בחנות הזו, אבל עוצרות סקריפט.
 *
 * keyGenerator: חובה — מאחורי Cloudflare/Apache req.ip הוא ה-IP של ה-proxy
 * וכל הלקוחות היו חולקים מונה אחד. אותו דפוס בדיוק כמו שאר הלימיטרים.
 * הכיוונון: GUEST_ORDER_RATE_LIMIT (0 = ללא הגבלה).
 */
const guestOrderRateLimit = Number(process.env.GUEST_ORDER_RATE_LIMIT ?? 20);
const guestOrderLimit = rateLimit({
  keyGenerator: clientIpKeyGenerator,
  windowMs: 15 * 60 * 1000,
  max: process.env.ENV === "dev" ? 1000 : guestOrderRateLimit,
  // מופעל רק כשאין סליקה, ורק כשהתקרה חיובית — אחרת המידלוור שקוף לגמרי
  // ואינו משנה דבר בהתנהגות הקיימת.
  skip: () => !PAYMENT_DISABLED || guestOrderRateLimit <= 0,
  handler: (req, res) => {
    console.warn("[order/add-guest] נחסם ע\"י הגבלת קצב");
    res.status(429).send({
      message: "יותר מדי הזמנות מהכתובת הזו. נסו שוב בעוד מספר דקות.",
    });
  },
});

// add an order (for registered customers - requires authentication)
router.post("/add", isAuth, addOrder);

// add an order as guest (for non-registered customers - no authentication required)
router.post("/add-guest", guestOrderLimit, createGuestCustomer, addOrder);

// get an order by id (requires authentication OR valid order token)
router.get("/:id", extractUserDetails, isOrderTokenValid, getOrderById);

// get all orders by a user (requires authentication)
router.get("/", isAuth, getOrderCustomer);

module.exports = router;
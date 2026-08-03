// api/index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const http = require("http");

const { connectDB } = require("../config/db");
const productRoutes = require("../routes/productRoutes");
const offerRoutes = require("../routes/offerRoutes");
const customerRoutes = require("../routes/customerRoutes");
const adminRoutes = require("../routes/adminRoutes");
const orderRoutes = require("../routes/orderRoutes");
const appOrderRoutes = require("../routes/appOrderRoutes");
const customerOrderRoutes = require("../routes/customerOrderRoutes");
const categoryRoutes = require("../routes/categoryRoutes");
const couponRoutes = require("../routes/couponRoutes");
const attributeRoutes = require("../routes/attributeRoutes");
const settingRoutes = require("../routes/settingRoutes");
const currencyRoutes = require("../routes/currencyRoutes");
const languageRoutes = require("../routes/languageRoutes");
const notificationRoutes = require("../routes/notificationRoutes");
const statusRoutes = require("../routes/statusRoutes");
const deliveryRoutes = require('../routes/deliveryRoutes');
const popupRoutes = require('../routes/popupRoutes');
const messageRoutes = require('../routes/messageRoutes');
const cashierOrderRoutes = require("../routes/cashierOrderRoutes");
const incomingOrderRoutes = require("../routes/incomingOrderRoutes");
const blogRoutes = require("../routes/blogRoutes");
const lotteryRoutes = require("../routes/lotteryRoutes");
const { getActiveLottery } = require("../controller/lotteryController");

const { isAuth, isAdmin, isApp, loginApp } = require("../config/auth");
const { loginAdmin, forgetPassword, resetPassword } = require("../controller/adminController");
const { passwordVerificationLimit } = require("../lib/email-sender/sender");
const { updateOrderWebHook } = require("../controller/orderController");
const { upload } = require("../utils/imgurUploader");
const { uploadFileToS3 } = require("../utils/awsUploader");
const { testUpdateOrderWebHook } = require("../script/test-updateOrderWebHook");

if (!process.env.MONGO_URI) {
  console.warn("Warning: MONGO_URI is not set in .env — database connection will fail.");
}

connectDB();
const app = express();

app.use((err, req, res, next) => {
  console.log("request entered");
  next();
});

// We are using this for the express-rate-limit middleware
// See: https://github.com/nfriedly/express-rate-limit
// app.enable('trust proxy');
app.set("trust proxy", 1);

// ‏webhook הווצאפ מקבל קבצים מצורפים כ-base64, וקובץ של 5MB תופס כ-6.7MB
// בקידוד הזה — מעל התקרה הכללית. הוא מדלג כאן ומפרסר את הגוף בעצמו, עם תקרה
// גדולה יותר ורק אחרי אימות ה-API key, כדי שהתקרה הרחבה לא תחול על כל השרת.
//
// הביטוי סלחני בכוונה: ניתוב ב-express אינו תלוי רישיות ומתעלם מלוכסן בסוף,
// ולכן גם הדילוג חייב להתנהג כך. השוואת מחרוזת פשוטה הייתה מחמיצה
// "/API/Incoming-Orders/WhatsApp/" — הבקשה הייתה מגיעה לנתיב הנכון, אבל עם
// תקרת 4MB, כלומר קובץ גדול היה נדחה ב-413 בלי הסבר.
const WHATSAPP_WEBHOOK_PATH = /^\/api\/incoming-orders\/whatsapp\/?$/i;
const jsonParser = express.json({ limit: "4mb" });

app.use((req, res, next) => {
  if (WHATSAPP_WEBHOOK_PATH.test(req.path)) return next();
  return jsonParser(req, res, next);
});
app.use(helmet());
app.use(cors());

//root route
app.get("/", (req, res) => {
  res.send("tomer-backend works properly! #6");
});

// Route for uploading images to S3
app.post('/api/upload', isAuth, upload.single('file'), async (req, res) => {
  try {
    // AWS S3
    const folder = req.body.folder || 'Uploads';
    const link = await uploadFileToS3(req.file, folder); // מעבירים את שם התיקייה לפונקציה
    console.log(`File uploaded successfully to ${folder} :`, link);
    res.json({ link });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).send('Error uploading file');
  }
});

//this for route will need for store front, also for admin dashboard
app.use("/api/products/", productRoutes);
app.use("/api/offers/", offerRoutes);
app.use("/api/category/", categoryRoutes);
app.use("/api/coupon/", couponRoutes);
app.use("/api/customer/", customerRoutes);
app.use("/api/order/", customerOrderRoutes);
app.use("/api/cashier-orders/", cashierOrderRoutes);
app.use("/api/attributes/", attributeRoutes);
app.use("/api/setting/", settingRoutes);
app.use("/api/currency/", isAuth, currencyRoutes);
app.use("/api/language/", languageRoutes);
app.use("/api/notification/", isAuth, notificationRoutes);
app.use('/api/deliveries', deliveryRoutes);
app.use('/api/popup', popupRoutes);
app.use('/api/message', messageRoutes);
app.use("/api/blog/", blogRoutes);

//login a admin
app.post("/api/admin/login", loginAdmin);

//forget-password
app.put("/api/admin/forget-password", passwordVerificationLimit, forgetPassword);

//reset-password
app.put("/api/admin/reset-password", resetPassword);

// update a order with webHook (for cardcom)
app.post("/api/orders/:id", updateOrderWebHook);

// ציבורי — לפופאפ הגרלה בחנות (ללא אימות)
app.get("/api/lottery/active", getActiveLottery);

app.use("/api/admin/lotteries", isAdmin, lotteryRoutes);
app.use("/api/admin/", isAdmin, adminRoutes);
app.use("/api/orders/", orderRoutes);
// קליטת הזמנות מהמייל ומווצאפ. האימות מוגדר per-route (webhook מול אדמין),
// ולכן אין כאן מידלוור גלובלי.
app.use("/api/incoming-orders/", incomingOrderRoutes);
app.use("/api/status/", isAdmin, statusRoutes);

// Sync the app with the orders
app.use("/api/app/login", loginApp);
app.use("/api/app/orders/", isApp, appOrderRoutes);

// Use express's default error handling middleware
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(400).json({ message: err.message });
});

const PORT = Number(process.env.PORT) || 5000;
const server = http.createServer(app);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Close the other process or set a different PORT in .env`
    );
  } else {
    console.error("Server listen error:", err.message);
  }
  process.exit(1);
});

// אל תשתמש ב-process.env.HOST — לעיתים זה כתובת של שירות אחר (מייל וכו') ואז listen נכשל ב-EADDRNOTAVAIL.
// אופציונלי: SERVER_BIND_HOST=127.0.0.1 או 0.0.0.0
const bindHost = process.env.SERVER_BIND_HOST;
const onListen = () => {
  const where = bindHost ? `http://${bindHost}:${PORT}` : `port ${PORT}`;
  console.log(`server running on ${where}`);
};

if (bindHost) {
  server.listen(PORT, bindHost, onListen);
} else {
  server.listen(PORT, onListen);
}
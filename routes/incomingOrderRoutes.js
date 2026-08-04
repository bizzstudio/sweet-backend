// routes/incomingOrderRoutes.js
const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();

const {
  receiveWhatsappMessage,
  getAllIncomingOrders,
  getIncomingOrderById,
  retryIncomingOrder,
  processCollectedNow,
  ignoreIncomingOrder,
  approveErrorOrder,
  retryFromOrder,
  approveSenderAndReprocess,
  getWhitelistStats,
  refreshWhitelist,
  scanEmailNow,
  testIngestion,
} = require("../controller/incomingOrderController");
const { isAdmin, isWhatsappServer } = require("../config/auth");

// הגבלת קצב על ה-webhook.
//
// כל הודעה שנקלטת מייצרת קריאה בתשלום ל-OpenAI (ולפעמים שתיים). בלי תקרה,
// דליפה של ה-API key או תקלת לופ בשרת הווצאפ היו מתורגמות ישירות לחיוב —
// ולזיהום המערכת בהזמנות שגיאה. חנות אמיתית לא מקבלת 120 הזמנות בדקה בווצאפ.
const whatsappWebhookLimit = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.INGESTION_WEBHOOK_RATE_LIMIT) || 120,
  // כל ההודעות מגיעות מאותו שרת ווצאפ, ולכן המפתח הוא ה-API key ולא ה-IP
  keyGenerator: (req) => req.headers["x-api-key"] || req.ip,
  handler: (req, res) => {
    console.warn("[whatsapp-webhook] נחסם ע\"י הגבלת קצב");
    res.status(429).send({
      success: false,
      message: "יותר מדי הודעות נכנסות. נסה שוב בעוד דקה.",
    });
  },
});

// פרסור הגוף של ה-webhook בלבד, בתקרה גדולה מזו של שאר השרת: קובץ מצורף
// מגיע כ-base64, שמנפח כל 5MB לכ-6.7MB. הנתיב הזה מדולג ב-express.json
// הגלובלי (ראה api/index.js), ולכן הפרסור נעשה כאן.
const whatsappBodyParser = express.json({
  limit: process.env.WHATSAPP_WEBHOOK_BODY_LIMIT || "12mb",
});

// webhook של שרת הווצאפ — הודעה נכנסת מלקוח.
// isWhatsappServer מאמת x-api-key (או טוקן אדמין, לצורך בדיקות).
//
// סדר המידלוורים אינו מקרי: הגבלת הקצב והאימות נבדקים **לפני** פרסור הגוף,
// כדי ששולח לא מאומת לא יוכל לגרום לשרת לבלוע 12MB לזיכרון.
router.post(
  "/whatsapp",
  whatsappWebhookLimit,
  isWhatsappServer,
  whatsappBodyParser,
  receiveWhatsappMessage
);

// ── דשבורד (אדמין בלבד) ──

// סריקת מייל ידנית
router.post("/scan-email", isAdmin, scanEmailNow);

// הרצת טקסט חופשי דרך הצינור (כיול הפרומפט)
router.post("/test", isAdmin, testIngestion);

// ── הרשימה הלבנה של השולחים המאושרים ──

// מצב הרשימה (כמה לקוחות מאושרים, מתי נטענה)
router.get("/whitelist/stats", isAdmin, getWhitelistStats);

// טעינה מחדש אחרי הוספת לקוחות
router.post("/whitelist/refresh", isAdmin, refreshWhitelist);

// "השולח הזה לקוח חדש שלנו" — יוצר לקוח וקורא את ההודעה מחדש
router.post("/:id/approve-sender", isAdmin, approveSenderAndReprocess);

// ── פעולות מתוך מסך ההזמנה, על הזמנה שנכנסה ב"שגיאה בקריאה" ──

// אישור ההזמנה: מעביר ל"בטיפול" *ומוריד מלאי*. שינוי סטטוס ידני לא מוריד מלאי.
router.post("/order/:orderId/approve", isAdmin, approveErrorOrder);

// הרצה חוזרת של ההודעה שממנה נוצרה ההזמנה (מוחק את הזמנת השגיאה)
router.post("/order/:orderId/retry", isAdmin, retryFromOrder);

// רשימת ההודעות שנקלטו
router.get("/", isAdmin, getAllIncomingOrders);

// הרצה חוזרת של הודעה שנכשלה
router.post("/:id/retry", isAdmin, retryIncomingOrder);

// עיבוד עכשיו של הודעה שממתינה להודעות המשך, בלי להמתין לסוף חלון השקט
router.post("/:id/process-now", isAdmin, processCollectedNow);

// סימון הודעה כלא רלוונטית
router.put("/:id/ignore", isAdmin, ignoreIncomingOrder);

// הודעה בודדת — אחרי הנתיבים הספציפיים, אחרת "count" ייתפס כ-:id
router.get("/:id", isAdmin, getIncomingOrderById);

module.exports = router;

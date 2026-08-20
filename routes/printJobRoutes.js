// routes/printJobRoutes.js
//
// המסלולים של סוכן ההדפסה. כולם מאחורי PRINT_AGENT_TOKEN ואף אחד מהם
// אינו נגיש מהאדמין או מהחנות — הסוכן הוא לקוח מכונה, לא משתמש.
//
// ⚠️ אין להוסיף כאן מסלול שהפרונט קורא לו. ה-PDF נמסר בלי שום בדיקת
//    הרשאה מעבר לטוקן, ולכן מי שמחזיק בטוקן קורא כל תעודת משלוח במערכת.

const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const {
  verifyPrintToken,
  getPendingJobs,
  getJobPdf,
  markPrinted,
  markFailed,
} = require("../controller/printJobController");

// הגבלת קצב, באותו דפוס כמו ה-webhook של הווצאפ (routes/incomingOrderRoutes).
//
// שתי סיבות. האחת אבטחה: הטוקן הוא הדבר היחיד ששומר על המסלולים האלה,
// ובלי תקרה אפשר לנחש אותו בקצב שהרשת מרשה. השנייה עלות: כל הורדת PDF
// מפעילה עיבוד ב-Chromium, ולולאה בסוכן (או סוכן שהותקן פעמיים) הייתה
// מתרגמת ישירות למעבד של השרת.
//
// 60 בקשות לדקה הן פי כמה ממה שסוכן אמיתי צריך: הוא פונה כל 10 שניות
// ומושך עד 5 משימות, כלומר לכל היותר כ-21 בקשות בדקה גם בעומס מלא.
//
// המפתח הוא ברירת המחדל של הספרייה — כתובת ה-IP (req.ip, שמכבד את
// trust proxy שמוגדר ב-api/index.js ולכן מחזיר את הכתובת האמיתית).
//
// ⚠️ **אין למפתח את הטוקן כאן.** ה-webhook של הווצאפ עושה זאת, אבל שם
//    המפתח הוא סוד תקין של שרת מוכר. כאן התקרה נועדה בין השאר לעצור
//    ניחוש טוקנים — ומיפתוח לפי הטוקן היה נותן לכל ניחוש דלי משלו,
//    כלומר מבטל את ההגנה בדיוק במקרה שבשבילו היא קיימת.
const printAgentLimit = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.PRINT_AGENT_RATE_LIMIT) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`[print] נחסם ע\"י הגבלת קצב (${req.ip})`);
    res.status(429).json({ message: "יותר מדי בקשות. נסה שוב בעוד דקה." });
  },
});

// הסדר חשוב: התקרה לפני האימות, אחרת ניסיונות ניחוש טוקן היו נעצרים
// ב-401 בלי להיספר לעולם.
router.use(printAgentLimit);
router.use(verifyPrintToken);

router.get("/pending", getPendingJobs);
router.get("/:id/pdf", getJobPdf);
router.post("/:id/printed", markPrinted);
router.post("/:id/failed", markFailed);

module.exports = router;

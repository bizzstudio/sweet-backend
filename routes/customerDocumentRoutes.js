// routes/customerDocumentRoutes.js
//
// "המסמכים שלי" באזור האישי בחנות. כל המסלולים דורשים לקוח מחובר, ואף
// אחד מהם אינו מקבל מזהה לקוח — ראו controller/customerDocumentController.

const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const { isAuth } = require("../config/auth");
const {
  getMyDocuments,
  getMyDeliveryNotePdf,
  getMyQuotePdf,
} = require("../controller/customerDocumentController");

// כל PDF הוא עמוד ב-Chromium המשותף של השרת — אותו דפדפן שמדפיס את תעודות
// המשלוח. בלי תקרה, לקוח אחד (או סקריפט עם הטוקן שלו) יכול לעכב את ההדפסה.
// המפתח הוא הלקוח ולא ה-IP: הבקשה כבר מזוהה, ולקוחות מאותו משרד חולקים IP.
const pdfLimit = rateLimit({
  keyGenerator: (req) => String(req.user?._id || ""),
  windowMs: 5 * 60 * 1000,
  max: process.env.ENV === "dev" ? 1000 : 40,
  handler: (req, res) => {
    res.status(429).send({ message: "יותר מדי מסמכים נפתחו ברצף. נסו שוב בעוד מספר דקות." });
  },
});

router.get("/", isAuth, getMyDocuments);
router.get("/delivery-note/:id/pdf", isAuth, pdfLimit, getMyDeliveryNotePdf);
router.get("/quote/:id/pdf", isAuth, pdfLimit, getMyQuotePdf);

module.exports = router;

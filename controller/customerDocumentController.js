// controller/customerDocumentController.js
//
// "המסמכים שלי" — המסמכים שהופקו ללקוח, לאזור האישי בחנות.
//
// נפרד מ-billingController בכוונה: שם כל מסלול הוא של אדמין, ומקבל מזהה
// לקוח מהכתובת. כאן אין מזהה לקוח בשום בקשה — הלקוח הוא תמיד מי שמחובר
// (req.user._id מהטוקן), ולכן אין דרך לבקש מסמכים של מישהו אחר.

const mongoose = require("mongoose");
const DeliveryNote = require("../models/DeliveryNote");
const Quote = require("../models/Quote");
const { listCustomerDocuments } = require("../lib/billing/customerDocuments");
const { generateDeliveryNotePdf, generateQuotePdf } = require("../lib/printing/deliveryNotePdf");

const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id || ""));

const getMyDocuments = async (req, res) => {
  try {
    // טוקן של מלקט או של אדמין עובר את isAuth אבל אינו של לקוח. מזהה
    // שאינו ObjectId היה מפיל את השאילתה ב-CastError
    if (!isValidId(req.user?._id)) {
      return res.status(401).send({ message: "ההזדהות נכשלה, יש להתחבר מחדש." });
    }
    res.send(await listCustomerDocuments(req.user._id));
  } catch (err) {
    console.error(`[my-documents] ${err.message}`);
    res.status(500).send({ message: "טעינת המסמכים נכשלה, נסו שוב בעוד רגע." });
  }
};

const sendPdf = (res, { buffer, filename }) => {
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${filename}"`,
    "Content-Length": buffer.length,
    // מסמך אישי — לא נשמר במטמון של proxy בדרך
    "Cache-Control": "private, no-store",
  });
  res.send(buffer);
};

/**
 * מוצא את המסמך רק אם הוא של הלקוח המחובר.
 *
 * הבעלות נבדקת בשאילתה עצמה ולא אחרי השליפה, והתשובה למסמך של לקוח אחר
 * זהה לזו של מסמך שאינו קיים — כדי שאי אפשר יהיה לגלות לפי התשובה אילו
 * מזהים קיימים.
 */
const ownedBy = (Model, req, extra = {}) =>
  isValidId(req.params.id) && isValidId(req.user?._id)
    ? Model.findOne({ _id: req.params.id, customer: req.user._id, ...extra }).select("_id").lean()
    : null;

const getMyDeliveryNotePdf = async (req, res) => {
  try {
    // תעודה מבוטלת אינה ברשימה של הלקוח, ולכן גם אינה נפתחת בקישור ישיר
    const note = await ownedBy(DeliveryNote, req, { "billing.status": { $ne: "cancelled" } });
    if (!note) return res.status(404).send({ message: "התעודה לא נמצאה" });
    sendPdf(res, await generateDeliveryNotePdf(note._id, { copies: 1 }));
  } catch (err) {
    console.error(`[my-documents] תעודה ${req.params.id}: ${err.message}`);
    res.status(500).send({ message: "פתיחת התעודה נכשלה, נסו שוב בעוד רגע." });
  }
};

const getMyQuotePdf = async (req, res) => {
  try {
    const quote = await ownedBy(Quote, req);
    if (!quote) return res.status(404).send({ message: "הצעת המחיר לא נמצאה" });
    sendPdf(res, await generateQuotePdf(quote._id));
  } catch (err) {
    console.error(`[my-documents] הצעת מחיר ${req.params.id}: ${err.message}`);
    res.status(500).send({ message: "פתיחת הצעת המחיר נכשלה, נסו שוב בעוד רגע." });
  }
};

module.exports = { getMyDocuments, getMyDeliveryNotePdf, getMyQuotePdf };

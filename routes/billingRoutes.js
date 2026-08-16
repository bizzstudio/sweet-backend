// routes/billingRoutes.js
//
// כל המסלולים כאן מוגנים ב-isAdmin. אין כאן שום דבר שלקוח אמור להגיע אליו:
// הפקת מסמך מס היא פעולה בלתי הפיכה, וגם קריאה בלבד חושפת נתוני חיוב של
// לקוחות אחרים.

const express = require("express");
const router = express.Router();
const { isAdmin } = require("../config/auth");
const billingController = require("../controller/billingController");

// --- iCount ---
router.get("/icount/status", isAdmin, billingController.icountStatus);
router.post("/icount/sync-customer/:customerId", isAdmin, billingController.syncCustomerToIcount);
router.get("/icount/document/:doctype/:docnum", isAdmin, billingController.getIcountDocument);

// --- תעודות משלוח ---
// סטטיים לפני /:id, אחרת "month" ייחשב ל-ObjectId
router.get("/delivery-notes", isAdmin, billingController.getDeliveryNotes);
router.post("/delivery-notes/from-order/:orderId", isAdmin, billingController.createDeliveryNote);
router.get("/delivery-notes/by-order/:orderId", isAdmin, billingController.getDeliveryNoteByOrder);
// תעודה ידנית — הסחורה שנשקלת. "manual" לפני /:id מאותה סיבה כמו השאר
router.post("/delivery-notes/manual", isAdmin, billingController.createManualDeliveryNote);
router.get("/delivery-notes/pending-manual/:orderId", isAdmin, billingController.getPendingManualItems);
router.get("/delivery-notes/:id", isAdmin, billingController.getDeliveryNote);
router.patch("/delivery-notes/:id/cancel", isAdmin, billingController.cancelDeliveryNote);

// --- סגירת חודש ---
// preview הוא GET ולא משנה כלום; close הוא POST ודורש confirm:true
router.get("/month/preview", isAdmin, billingController.previewMonth);
router.post("/month/close", isAdmin, billingController.closeMonth);

// --- זיכוי וקבלה ---
router.post("/credit", isAdmin, billingController.creditInvoice);
router.post("/receipt", isAdmin, billingController.createReceiptForPayment);

// --- הצעות מחיר ---
// price-items הוא POST למרות שהוא לא משנה כלום — רשימת הפריטים ארוכה מדי
// ל-query string
router.post("/quotes/price-items", isAdmin, billingController.priceItems);
router.get("/quotes", isAdmin, billingController.getQuotes);
router.post("/quotes", isAdmin, billingController.createQuote);
router.get("/quotes/:id", isAdmin, billingController.getQuote);
router.patch("/quotes/:id/accept", isAdmin, billingController.acceptQuote);
router.patch("/quotes/:id/reject", isAdmin, billingController.rejectQuote);

// --- כרטיס לקוח ---
router.get("/customer/:customerId/open-invoices", isAdmin, billingController.getCustomerOpenInvoices);
// כל המסמכים של הלקוח במקום אחד — לכרטיס הלקוח
router.get("/customer/:customerId/documents", isAdmin, billingController.getCustomerDocuments);

// --- חשבוניות וגבייה ---
// ?status=paid|unpaid|overdue&customer=<id>
router.get("/invoices", isAdmin, billingController.getInvoices);
// הסכום המחייב מ-iCount, לפני רישום תשלום
router.get("/invoices/:docnum/total", isAdmin, billingController.getInvoiceTotal);

module.exports = router;

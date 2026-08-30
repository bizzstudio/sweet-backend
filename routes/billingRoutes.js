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
// המצב בלבד, בלי קריאה ל-iCount — זה מה שהבאנר במסכי החיוב קורא
router.get("/icount/mode", isAdmin, billingController.icountMode);
router.post("/icount/sync-customer/:customerId", isAdmin, billingController.syncCustomerToIcount);
router.get("/icount/document/:doctype/:docnum", isAdmin, billingController.getIcountDocument);

// --- מסך דמו ---
// זמין רק כש-ICOUNT_MODE=demo; אחרת כל אחד מהם מחזיר 409 (הבדיקה בשכבת
// lib/billing/demo, כדי שגם קריאה מסקריפט תיחסם ולא רק מהמסלול)
router.get("/demo/options", isAdmin, billingController.demoOptions);
router.post("/demo/invoice", isAdmin, billingController.createDemoInvoice);
router.get("/demo/invoice/:docnum/total", isAdmin, billingController.getDemoTotal);
router.post("/demo/credit", isAdmin, billingController.createDemoCredit);
router.post("/demo/receipt", isAdmin, billingController.createDemoReceipt);

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

// עריכת תעודה שעדיין לא חויבה. תעודה שחויבה נדחית בשרת עם ההסבר —
// התיקון שלה עובר דרך זיכוי, שמחזיר אותה למצב פתוח
router.patch("/delivery-notes/:id", isAdmin, billingController.updateDeliveryNote);

// שכפול תעודה ("עוד אחת בדיוק כמו זו")
router.post("/delivery-notes/:id/duplicate", isAdmin, billingController.duplicateDeliveryNote);

// הפיכת תעודה בודדת לחשבונית מס, בלי להמתין לסגירת החודש
router.post("/delivery-notes/:id/bill", isAdmin, billingController.billDeliveryNote);
// הדפסה. הדפסה חוזרת היא POST כי היא מוציאה נייר; מצב ההדפסה הוא GET.
router.post("/delivery-notes/:id/reprint", isAdmin, billingController.reprintDeliveryNote);
router.get("/delivery-notes/:id/print-status", isAdmin, billingController.getDeliveryNotePrintStatus);

// --- סגירת חודש ---
// preview הוא GET ולא משנה כלום; close הוא POST ודורש confirm:true
router.get("/month/preview", isAdmin, billingController.previewMonth);
// הלקוחות שיש להם תעודות פתוחות — הבורר במסך סגירת החודש. ?month=YYYY-MM
router.get("/month/open-customers", isAdmin, billingController.openCustomers);
router.post("/month/close", isAdmin, billingController.closeMonth);

// --- זיכוי וקבלה ---
router.post("/credit", isAdmin, billingController.creditInvoice);
router.post("/receipt", isAdmin, billingController.createReceiptForPayment);
// רשימת הקבלות שהופקו. ?customer=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/receipts", isAdmin, billingController.getReceipts);

// --- הצעות מחיר ---
// price-items הוא POST למרות שהוא לא משנה כלום — רשימת הפריטים ארוכה מדי
// ל-query string
router.post("/quotes/price-items", isAdmin, billingController.priceItems);
router.get("/quotes", isAdmin, billingController.getQuotes);
router.post("/quotes", isAdmin, billingController.createQuote);
router.get("/quotes/:id", isAdmin, billingController.getQuote);
router.patch("/quotes/:id/accept", isAdmin, billingController.acceptQuote);
router.patch("/quotes/:id/reject", isAdmin, billingController.rejectQuote);

// שכפול הצעה, והפקת תעודת משלוח/חשבונית ממנה בלחיצה אחת
router.post("/quotes/:id/duplicate", isAdmin, billingController.duplicateQuote);
router.post("/quotes/:id/convert", isAdmin, billingController.convertQuote);

// --- כרטיס לקוח ---
router.get("/customer/:customerId/open-invoices", isAdmin, billingController.getCustomerOpenInvoices);
// כל המסמכים של הלקוח במקום אחד — לכרטיס הלקוח
router.get("/customer/:customerId/documents", isAdmin, billingController.getCustomerDocuments);

// --- חשבוניות וגבייה ---
// ?status=paid|unpaid|overdue&customer=<id>
router.get("/invoices", isAdmin, billingController.getInvoices);
// הסכום המחייב מ-iCount, לפני רישום תשלום
router.get("/invoices/:docnum/total", isAdmin, billingController.getInvoiceTotal);

// ריכוז התעודות שהחשבונית סגרה — הנספח המודפס שמצורף אליה
router.get("/invoices/:docnum/notes", isAdmin, billingController.getInvoiceNotes);

module.exports = router;

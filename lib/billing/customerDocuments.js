// lib/billing/customerDocuments.js
//
// המסמכים של לקוח כפי שהלקוח עצמו רואה אותם — "המסמכים שלי" באזור האישי
// בחנות.
//
// זה אינו getCustomerDocuments של האדמין עם הרשאה אחרת, ושלושה דברים
// מבדילים ביניהם:
//
//   1. הספרים האמיתיים בלבד (ledger.real). האדמין רואה את הכיס הפעיל, ובמצב
//      דמו זה כיס הדמו. הלקוח לא אמור לראות לעולם מסמך שאינו קיים בספרים.
//
//   2. רשימה לבנה של שדות. תעודה שנשלפת כמות שהיא נושאת claimToken, מי
//      הפיק, מי ערך, סיבת ביטול ולאיזו כתובת נשלח המייל — מידע פנימי
//      שהאדמין צריך והלקוח לא. לכן כל שורה נבנית כאן שדה-שדה, ושדה חדש
//      במודל אינו דולף החוצה מעצמו.
//
//   3. תעודות מבוטלות אינן מוצגות. ביטול הוא תיקון פנימי, ותעודה מבוטלת
//      ברשימה של הלקוח נראית כמו סחורה שהוא אמור לשלם עליה.
//
// הסכומים הם ברוטו (כולל מע"מ), מאותו חישוב שמופיע על המסמך המודפס —
// כדי שהמספר ברשימה יהיה המספר שבתחתית המסמך שנפתח ממנה.

const DeliveryNote = require("../../models/DeliveryNote");
const CreditNote = require("../../models/CreditNote");
const Quote = require("../../models/Quote");
const { listInvoices } = require("./invoices");
const { listReceipts } = require("./receipts");
const { calculateVat } = require("./vat");
const ledger = require("./ledger");

// הכתובות נשמרות אצלנו כפי שהגיעו מ-iCount. רק http(s) יוצא ללקוח — ערך
// אחר (נתון פגום, javascript:) היה הופך לקישור לחיץ בדפדפן שלו
const safeUrl = (url) => (/^https?:\/\//i.test(String(url || "")) ? String(url) : null);

const gross = (doc) => calculateVat(doc).total;

/** זיכויים של הלקוח. זיכוי אחד רשום על כל התעודות של החשבונית שזוכתה. */
const listCredits = async (customerId) => {
  const notes = await DeliveryNote.find({
    customer: customerId,
    "billing.credits.0": { $exists: true },
  })
    .select("billing.credits")
    .lean();

  const byDocNum = new Map();
  for (const note of notes) {
    for (const credit of note.billing?.credits || []) {
      if (!credit.creditDocNum || byDocNum.has(credit.creditDocNum)) continue;
      byDocNum.set(credit.creditDocNum, {
        docNum: credit.creditDocNum,
        date: credit.creditedAt || null,
        url: safeUrl(credit.creditDocUrl),
        invoiceDocNum: credit.originalDocNum || null,
      });
    }
  }

  // חשבוניות זיכוי שהופקו מתעודות זיכוי. הרישום האמיתי בלבד, כמו כל
  // דבר שהלקוח רואה
  const creditNotes = await CreditNote.find({
    customer: customerId,
    "billing.status": "billed",
  })
    .select("billing.creditDocNum billing.creditDocUrl billing.originalDocNum billing.billedAt")
    .lean();

  for (const note of creditNotes) {
    const docNum = note.billing?.creditDocNum;
    if (!docNum || byDocNum.has(docNum)) continue;
    byDocNum.set(docNum, {
      docNum,
      date: note.billing.billedAt || null,
      url: safeUrl(note.billing.creditDocUrl),
      invoiceDocNum: note.billing.originalDocNum || null,
    });
  }

  return [...byDocNum.values()].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
};

/**
 * @param {string} customerId - מזהה הלקוח המחובר. הקורא אחראי שהוא תקין
 *   ושהוא של מי שמבקש; כאן אין בדיקת הרשאה
 */
const listCustomerDocuments = async (customerId) => {
  const [invoices, receipts, credits, notes, quotes] = await Promise.all([
    listInvoices({ customerId, books: ledger.real }),
    listReceipts({ customerId, books: ledger.real }),
    listCredits(customerId),
    DeliveryNote.find({ customer: customerId, "billing.status": { $ne: "cancelled" } })
      .select(
        "number issuedAt orderNumber items subTotal shippingCost discount billing.status billing.icountDocNum"
      )
      .sort({ number: -1 })
      .lean(),
    Quote.find({ customer: customerId })
      .select("number createdAt validUntil status items subTotal discount")
      .sort({ number: -1 })
      .lean(),
  ]);

  return {
    invoices: invoices
      // listInvoices ממיין לפי דחיפות גבייה. ללקוח הסדר הטבעי הוא החדש למעלה
      .sort((a, b) => new Date(b.billedAt || 0) - new Date(a.billedAt || 0))
      .map((inv) => ({
        docNum: inv.docNum,
        date: inv.billedAt,
        url: safeUrl(inv.icountDocUrl),
        amount: inv.grossEstimate,
        isPaid: inv.isPaid,
        // מועד הפירעון יוצא ללקוח רק כשתנאי התשלום שלו מאושרים. טבלת
        // הקודים (lib/billing/paymentTerms) עדיין אינה מאומתת, ותאריך
        // שנגזר ממנה הוא ניחוש: באדמין הוא מוצג עם אזהרה, אבל ללקוח
        // "לתשלום עד" הוא התחייבות. עד לאישור הוא רואה "טרם שולמה" בלבד
        dueDate: inv.termsConfirmed ? inv.dueDate : null,
      })),
    receipts: receipts.map((r) => ({
      docNum: r.docNum,
      date: r.paidAt,
      url: safeUrl(r.docUrl),
      amount: r.grossEstimate,
      invoiceDocNums: r.invoices.map((i) => i.docNum),
    })),
    credits,
    deliveryNotes: notes.map((note) => ({
      _id: note._id,
      number: note.number,
      date: note.issuedAt,
      orderNumber: note.orderNumber || null,
      itemCount: (note.items || []).length,
      amount: gross(note),
      // החשבונית שסגרה את התעודה. רק כשהיא מחויבת: בזמן סגירת חודש
      // (status "billing") המספר עדיין לא סופי
      invoiceDocNum: note.billing?.status === "billed" ? note.billing.icountDocNum || null : null,
    })),
    quotes: quotes.map((q) => ({
      _id: q._id,
      number: q.number,
      date: q.createdAt,
      validUntil: q.validUntil || null,
      status: q.status,
      itemCount: (q.items || []).length,
      amount: gross(q),
    })),
  };
};

module.exports = { listCustomerDocuments };

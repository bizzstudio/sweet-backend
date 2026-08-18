// lib/billing/receipts.js
//
// רשימת הקבלות שהופקו — "מתי נכנס הכסף, ממי, ועל איזו חשבונית".
//
// כמו החשבוניות, גם לקבלה אין אצלנו ישות משלה: הקבלה חיה ב-iCount, ומה
// שיש לנו הוא תעודות המשלוח שסומנו כמשולמות (billing.receiptDocNum).
// לכן "רשימת הקבלות" היא תמיד קיבוץ של תעודות לפי מספר הקבלה, בדיוק
// כפי ש-invoices.js מקבץ לפי מספר החשבונית.
//
// ⚠️ שלוש מגבלות שנובעות מכך, והמסך מציין אותן במפורש:
//
//   1. הסכום כאן הוא אומדן מהתעודות ולא הסכום שנרשם על הקבלה. תשלום
//      חלקי, או קבלה שהופקה ידנית ב-iCount על סכום אחר, לא יופיעו נכון.
//      הסכום המחייב הוא זה שעל המסמך.
//
//   2. קבלה שהופקה ישירות ב-iCount, בלי לעבור דרך המסך שלנו, אינה
//      מסומנת על אף תעודה ולכן לא תופיע כאן כלל.
//
//   3. זיכוי חשבונית שהוחזרה למצב פתוח מנקה את שדות הקבלה מהתעודה
//      (monthlyBilling.creditInvoice). הקבלה עצמה נשארת ב-iCount, אבל
//      הקישור אליה נמחק אצלנו והיא תיעלם מהרשימה הזו.

const DeliveryNote = require("../../models/DeliveryNote");
const { calculateVat } = require("./vat");
const { israelDay } = require("./deliveryNotes");
const ledger = require("./ledger");

/** הסכום ברוטו של תעודה, לפי כללי המע"מ המשותפים (lib/billing/vat). */
const grossOfNote = (note) => calculateVat(note).total;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * האם המחרוזת היא יום תקין בפורמט YYYY-MM-DD.
 *
 * מיוצא כדי שהבקר יחזיר 400 על קלט פסול במקום להעביר Invalid Date
 * לשאילתה ולקבל 500 עם CastError.
 *
 * ההשוואה חזרה למחרוזת אינה מיותרת: "2026-02-31" עובר את התבנית, ו-
 * new Date אינו פוסל אותו אלא מגלגל אותו ל-3 במרץ. בלי הבדיקה הזאת
 * תאריך שגוי היה מסנן טווח אחר ממה שנבחר, בשקט.
 */
const isDayString = (value) => {
  const day = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
};

/**
 * @param {object} [opts]
 * @param {string} [opts.customerId] - סינון ללקוח אחד
 * @param {string} [opts.from]       - תאריך תשלום מ- (YYYY-MM-DD, כולל)
 * @param {string} [opts.to]         - תאריך תשלום עד (YYYY-MM-DD, כולל)
 * @returns {Promise<Array>} קבלות, החדשה ביותר ראשונה
 */
const listReceipts = async ({ customerId, from, to } = {}) => {
  // ערך פסול נבלע ולא הופך לשאילתה שגויה — הבקר כבר דחה אותו, וזו הגנת
  // שכבה שנייה למי שיקרא לפונקציה מסקריפט
  const fromDay = isDayString(from) ? from : null;
  const toDay = isDayString(to) ? to : null;

  // $nin: [null, ""] מוציא גם תעודות שהשדה חסר בהן (שדה חסר מתאים ל-null),
  // וגם מחרוזת ריקה — הערך שנשאר על תעודה שזיכוי ניקה
  const query = { [ledger.f("receiptDocNum")]: { $nin: [null, ""] } };
  if (customerId) query.customer = customerId;

  // הטווח הוא ימים בשעון ישראל, אבל paidAt הוא רגע ב-UTC ושעון השרת אינו
  // ידוע. לכן השאילתה לוקחת יום עודף בכל צד — כדי שלא תחתוך תשלום שנרשם
  // בקצה היום — והסינון המדויק נעשה בהמשך על היום הישראלי עצמו.
  if (fromDay || toDay) {
    const paidAtField = ledger.f("paidAt");
    query[paidAtField] = {};
    if (fromDay) {
      query[paidAtField].$gte = new Date(
        new Date(`${fromDay}T00:00:00.000Z`).getTime() - DAY_MS
      );
    }
    if (toDay) {
      query[paidAtField].$lte = new Date(
        new Date(`${toDay}T00:00:00.000Z`).getTime() + 2 * DAY_MS
      );
    }
  }

  // items נדרש לחישוב המע"מ (שורות פטורות), כמו ב-listInvoices
  const notes = ledger.normalizeAll(
    await DeliveryNote.find(query)
      .select("number customer customerSnapshot total subTotal shippingCost discount items billing")
      .lean()
  );

  // הקיבוץ כולל את הלקוח במפתח מאותה סיבה כמו בחשבוניות: מספרי מסמך
  // ב-iCount ייחודיים לחשבון ולא ללקוח, וצירוף בטעות של שני לקוחות תחת
  // קבלה אחת היה מזכה את הלקוח הלא נכון.
  const grouped = new Map();

  for (const note of notes) {
    const docNum = note.billing?.receiptDocNum;
    if (!docNum) continue;

    // הסינון המדויק: היום הישראלי שבו נרשם התשלום, לא היום ב-UTC
    if (fromDay || toDay) {
      if (!note.billing.paidAt) continue;
      const day = israelDay(new Date(note.billing.paidAt));
      if (fromDay && day < fromDay) continue;
      if (toDay && day > toDay) continue;
    }

    const key = `${note.customer}|${docNum}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        docNum,
        docUrl: note.billing.receiptDocUrl || null,
        customer: note.customer,
        customerName: note.customerSnapshot?.name || "—",
        customerNumber: note.customerSnapshot?.customerNumber || null,
        paidAt: note.billing.paidAt || null,
        grossEstimate: 0,
        // החשבוניות שהקבלה סגרה. קבלה אחת יכולה לכסות כמה חשבוניות
        invoices: [],
        notes: [],
        // מספרי החשבוניות שזוכו מבין אלה שבקבלה. נאסף כאן ומתורגם ל-
        // hasCredit בסוף, כי החשבוניות של הקבלה עדיין לא ידועות במלואן
        // בזמן המעבר על התעודה הראשונה
        creditedDocNums: new Set(),
      });
    }

    const entry = grouped.get(key);
    entry.grossEstimate = Number((entry.grossEstimate + grossOfNote(note)).toFixed(2));
    entry.notes.push(note.number);
    if (!entry.docUrl && note.billing.receiptDocUrl) entry.docUrl = note.billing.receiptDocUrl;
    if (!entry.paidAt && note.billing.paidAt) entry.paidAt = note.billing.paidAt;

    const invoiceNum = note.billing.icountDocNum;
    if (invoiceNum && !entry.invoices.some((i) => i.docNum === invoiceNum)) {
      entry.invoices.push({ docNum: invoiceNum, docUrl: note.billing.icountDocUrl || null });
    }

    // רק זיכויים של החשבוניות שבקבלה הזו. תעודה שזוכתה בעבר, נפתחה מחדש
    // וחויבה שוב שומרת את היסטוריית הזיכוי לנצח — סימון גורף היה מסמן
    // כל קבלה כזו כ"זוכתה" למרות שהתקבול שלה תקין
    for (const credit of note.billing.credits || []) {
      if (credit.originalDocNum) entry.creditedDocNums.add(String(credit.originalDocNum));
    }
  }

  return [...grouped.values()]
    .map(({ creditedDocNums, ...entry }) => ({
      ...entry,
      notes: entry.notes.sort((a, b) => a - b),
      // תעודה שבוטלה בזיכוי בלי פתיחה מחדש שומרת את הקבלה עליה. בלי
      // הסימון הזה הקבלה נראית כתקבול תקין על חשבונית שכבר זוכתה
      hasCredit: entry.invoices.some((i) => creditedDocNums.has(String(i.docNum))),
    }))
    .sort(
      // החדשה ביותר למעלה. שובר שוויון על מספר המסמך כדי שרענון של אותו
      // מסך לא יחזיר את אותן שורות בסדר אחר
      (a, b) =>
        new Date(b.paidAt || 0) - new Date(a.paidAt || 0) ||
        String(b.docNum).localeCompare(String(a.docNum), undefined, { numeric: true })
    );
};

module.exports = { listReceipts, isDayString };

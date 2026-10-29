// lib/billing/summaryReport.js
//
// עמוד ריכוז: "כמה עשיתי מתאריך X ועד היום" — בתעודות ובחשבוניות, בכסף.
//
// ── שני מספרים, ולמה הם לא אמורים להיות שווים ──
//
//   תעודות   — מה שסופק בטווח, לפי תאריך ההפקה של התעודה (issuedAt).
//   חשבוניות — מה שחויב בטווח, לפי תאריך ההפקה של החשבונית (billedAt).
//
// תעודה מסוף החודש מחויבת בסגירת החודש שאחריו, ולכן בכל טווח יש תעודות
// שעוד לא חויבו וחשבוניות על תעודות מלפני הטווח. הפער הוא לא טעות, והמסך
// מציג אותו במפורש ("תעודות שטרם חויבו") כדי שלא ייקרא כטעות.
//
// החשבוניות נבנות מ-listInvoices ולא מחושבות כאן מחדש: זה הקיבוץ שמסך
// החשבוניות וכרטיס הלקוח מציגים, ודוח שמחשב את אותו סכום בדרך אחרת היה
// מראה מספר שלישי.
//
// הסכומים אחרי מע"מ הם אומדן (lib/billing/vat). המקור המחייב הוא iCount.

const DeliveryNote = require("../../models/DeliveryNote");
const ledger = require("./ledger");
const { listInvoices } = require("./invoices");
const { calculateVat, VAT_RATE } = require("./vat");
const { israelDay } = require("./deliveryNotes");
const { isDayString } = require("./purchaseReport");

const DAY_MS = 24 * 60 * 60 * 1000;

// אותה תקרה כמו בדוח הרכישות, מאותה סיבה: טווח של שנים לא נשלף כולו
// לזיכרון, והמסך אומר במפורש כשהדוח נחתך
const MAX_NOTES = 20000;

const round2 = (n) => Number((Number(n) || 0).toFixed(2));

/** האם התאריך נופל בתוך הימים שנבחרו, לפי שעון ישראל. */
const inDayRange = (date, fromDay, toDay) => {
  if (!fromDay && !toDay) return true;
  if (!date) return false;
  const day = israelDay(new Date(date));
  if (fromDay && day < fromDay) return false;
  if (toDay && day > toDay) return false;
  return true;
};

const emptyMoney = () => ({ count: 0, net: 0, gross: 0 });

const add = (bucket, net, gross) => {
  bucket.count += 1;
  bucket.net += net;
  bucket.gross += gross;
};

const roundMoney = (bucket) => ({
  count: bucket.count,
  net: round2(bucket.net),
  gross: round2(bucket.gross),
  vat: round2(bucket.gross - bucket.net),
});

const notesInRange = async ({ customerId, fromDay, toDay }) => {
  const query = {};
  if (customerId) query.customer = customerId;

  // שאילתה עם יום עודף בכל צד, וסינון מדויק לפי היום הישראלי — כמו בדוח
  // הרכישות. שעון השרת אינו ידוע, והשדה במסד הוא רגע ב-UTC
  if (fromDay || toDay) {
    query.issuedAt = {};
    if (fromDay) {
      query.issuedAt.$gte = new Date(new Date(`${fromDay}T00:00:00.000Z`).getTime() - DAY_MS);
    }
    if (toDay) {
      query.issuedAt.$lte = new Date(new Date(`${toDay}T00:00:00.000Z`).getTime() + 2 * DAY_MS);
    }
  }

  // items נדרש לחישוב המע"מ (שורות פטורות) — כמו ב-listInvoices
  const rows = ledger.normalizeAll(
    await DeliveryNote.find(query)
      .select("customer customerSnapshot total subTotal shippingCost discount items billing issuedAt")
      .sort({ issuedAt: -1 })
      .limit(MAX_NOTES + 1)
      .lean()
  );

  const truncated = rows.length > MAX_NOTES;
  const notes = (truncated ? rows.slice(0, MAX_NOTES) : rows).filter((n) =>
    inDayRange(n.issuedAt, fromDay, toDay)
  );
  return { notes, truncated };
};

/**
 * @param {object} [opts]
 * @param {string} [opts.customerId] - סינון ללקוח אחד
 * @param {string} [opts.from]       - YYYY-MM-DD, כולל
 * @param {string} [opts.to]         - YYYY-MM-DD, כולל
 */
const summaryReport = async ({ customerId, from, to } = {}) => {
  const fromDay = isDayString(from) ? from : null;
  const toDay = isDayString(to) ? to : null;

  const [{ notes, truncated }, invoices] = await Promise.all([
    notesInRange({ customerId, fromDay, toDay }),
    listInvoices({ customerId }),
  ]);

  const byCustomer = new Map();
  const rowFor = (id, name, customerNumber) => {
    const key = String(id || "—");
    if (!byCustomer.has(key)) {
      byCustomer.set(key, {
        customerId: id ? String(id) : null,
        name: name || "—",
        customerNumber: customerNumber || null,
        notes: emptyMoney(),
        invoices: emptyMoney(),
        credits: emptyMoney(),
      });
    }
    return byCustomer.get(key);
  };

  // ---------- תעודות ----------
  const notesTotal = emptyMoney();
  const notesBilled = emptyMoney();
  const notesOpen = emptyMoney();
  const notesCancelled = emptyMoney();

  for (const note of notes) {
    const net = Number(note.total) || 0;
    const gross = calculateVat(note).total;
    const status = note.billing?.status || "open";

    // תעודה שבוטלה לא נכנסת לסכום — אבל נספרת בנפרד, כדי ש"למה יש כאן
    // פחות ממה שזכרתי" תקבל תשובה על המסך
    if (status === "cancelled") {
      add(notesCancelled, net, gross);
      continue;
    }

    add(notesTotal, net, gross);
    add(status === "billed" ? notesBilled : notesOpen, net, gross);
    add(
      rowFor(note.customer, note.customerSnapshot?.name, note.customerSnapshot?.customerNumber).notes,
      net,
      gross
    );
  }

  // ---------- חשבוניות וזיכויים ----------
  const invoicesTotal = emptyMoney();
  const invoicesPaid = emptyMoney();
  const invoicesUnpaid = emptyMoney();
  const creditsTotal = emptyMoney();
  const seenCredits = new Set();

  for (const inv of invoices) {
    if (inDayRange(inv.billedAt, fromDay, toDay)) {
      add(invoicesTotal, inv.netTotal, inv.grossEstimate);
      add(inv.isPaid ? invoicesPaid : invoicesUnpaid, inv.netTotal, inv.grossEstimate);
      add(rowFor(inv.customer, inv.customerName, inv.customerNumber).invoices, inv.netTotal, inv.grossEstimate);
    }

    // זיכוי חלקי נספר לפי התאריך שלו ולא לפי תאריך החשבונית: זיכוי שהופק
    // החודש על חשבונית מהחודש שעבר מקטין את ההכנסה של החודש הזה.
    //
    // זיכוי מלא אינו נספר: הוא מנקה את מספר החשבונית מהתעודות, ולכן
    // החשבונית המזוכה כבר לא מופיעה ברשימה — ספירה שלו הייתה מורידה פעמיים
    for (const credit of inv.credits || []) {
      if (!credit.partial || !inDayRange(credit.creditedAt, fromDay, toDay)) continue;
      // לפי תעודת הזיכוי ולא לפי מספר המסמך: חשבונית זיכוי מרוכזת אחת
      // מכסה כמה תעודות, והסכום של כל אחת נספר בנפרד
      const key = credit.creditNoteId ? String(credit.creditNoteId) : credit.creditDocNum;
      if (seenCredits.has(key)) continue;
      seenCredits.add(key);

      const gross = Number(credit.grossEstimate) || 0;
      // הזיכוי מגיע עם סכום ברוטו בלבד; הנטו נגזר בשיעור המע"מ הרגיל.
      // אומדן — כמו כל הסכומים אחרי מע"מ בדוח
      const net = gross / (1 + VAT_RATE);
      add(creditsTotal, net, gross);
      add(rowFor(inv.customer, inv.customerName, inv.customerNumber).credits, net, gross);
    }
  }

  const customers = [...byCustomer.values()]
    .map((row) => ({
      ...row,
      notes: roundMoney(row.notes),
      invoices: roundMoney(row.invoices),
      credits: roundMoney(row.credits),
    }))
    .sort((a, b) => b.notes.net + b.invoices.net - (a.notes.net + a.invoices.net));

  return {
    from: fromDay,
    to: toDay,
    notes: {
      total: roundMoney(notesTotal),
      billed: roundMoney(notesBilled),
      open: roundMoney(notesOpen),
      cancelled: roundMoney(notesCancelled),
    },
    invoices: {
      total: roundMoney(invoicesTotal),
      paid: roundMoney(invoicesPaid),
      unpaid: roundMoney(invoicesUnpaid),
      credits: roundMoney(creditsTotal),
      // מה שנשאר אחרי הזיכויים החלקיים שהופקו בטווח
      afterCredits: roundMoney({
        count: invoicesTotal.count,
        net: invoicesTotal.net - creditsTotal.net,
        gross: invoicesTotal.gross - creditsTotal.gross,
      }),
    },
    customers,
    truncated,
    limit: MAX_NOTES,
  };
};

module.exports = { summaryReport };

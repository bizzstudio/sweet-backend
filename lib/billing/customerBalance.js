// lib/billing/customerBalance.js
//
// יתרת הלקוח: כמה כסף נשאר לזכותו אצלנו, או כמה נשאר לחובתו.
//
// הכלל אחד, ואין לו חריגים:
//
//   בכל סגירת חשבונית נרשמת תנועה של (מה שהתקבל − סכום החשבונית).
//
// העביר 1,000 על חשבונית של 800 → ‎+200. בחשבונית הבאה, של 500, מספיק
// שיעביר 300: ‎300 − 500 = ‎−200, והיתרה חוזרת לאפס. העביר 500 על חשבונית
// של 800 → ‎−300, חוב שמתווסף למה שייגבה בפעם הבאה.
//
// היתרה מכסה רק את מה שכבר נסגר. חשבונית שעוד לא שולמה אינה "חוב" כאן —
// היא מופיעה במסך החשבוניות, ושם היא נספרת. לכן ביטול חשבונית מחזיר
// כסף ליתרה רק אם היא שולמה (ראו refundCancelledInvoice).
//
// חשבונית זיכוי מוסיפה תמיד את סכומה ליתרה, בין אם קושרה לחשבונית ובין
// אם לא. החשבונית המקורית ממשיכה להיסגר בסכומה המלא, והזיכוי מתקזז
// דרך היתרה — כך אותו זיכוי לא יורד פעמיים.

const mongoose = require("mongoose");
const CustomerBalanceEntry = require("../../models/CustomerBalanceEntry");
const DeliveryNote = require("../../models/DeliveryNote");
const { getDocument, DOC_TYPES } = require("../icount/documents");
const { isDemoMode } = require("../icount/mode");
const { calculateVat } = require("./vat");
const ledger = require("./ledger");

const MAX_REASON_CHARS = 300;
// תקרה לתיקון ידני. אין לקוח שהיתרה שלו מתקרבת לזה, ומספר שהוקלד עם
// שלושה אפסים מיותרים עדיף שייעצר כאן ולא יתגלה בגבייה
const MAX_MANUAL_DELTA = 1000000;

const money = (n) => Number((Number(n) || 0).toFixed(2));

const oid = (id) => new mongoose.Types.ObjectId(String(id));

/**
 * היתרות של כמה לקוחות בשאילתה אחת.
 *
 * @returns {Promise<Map<string, number>>} רק לקוחות שיש להם תנועות
 */
const balancesOf = async (customerIds, { demo = isDemoMode() } = {}) => {
  const ids = [...new Set((customerIds || []).map(String))].filter((id) =>
    mongoose.isValidObjectId(id)
  );
  if (!ids.length) return new Map();

  const rows = await CustomerBalanceEntry.aggregate([
    // demo: {$ne: true} ולא false — תופס גם תנועה שהשדה חסר בה
    { $match: { customer: { $in: ids.map(oid) }, demo: demo ? true : { $ne: true } } },
    { $group: { _id: "$customer", balance: { $sum: "$delta" } } },
  ]);

  return new Map(rows.map((r) => [String(r._id), money(r.balance)]));
};

/** היתרה של לקוח אחד. חיובי = לזכותו, שלילי = לחובתו. */
const balanceOf = async (customerId, opts) =>
  (await balancesOf([customerId], opts)).get(String(customerId)) || 0;

/**
 * התנועות של הלקוח, החדשה ראשונה, עם היתרה שנשארה אחרי כל אחת.
 *
 * היתרה המצטברת מחושבת כאן ולא נשמרת על התנועה: שתי תנועות שנכתבות
 * באותו רגע היו שומרות אותה "יתרה אחרי" שגויה לנצח.
 */
const history = async (customerId, { limit = 50, demo = isDemoMode() } = {}) => {
  const entries = await CustomerBalanceEntry.find({
    customer: customerId,
    demo: demo ? true : { $ne: true },
  })
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  let running = 0;
  const withBalance = entries.map((e) => {
    running = money(running + e.delta);
    return { ...e, balanceAfter: running };
  });

  return { balance: running, entries: withBalance.reverse().slice(0, limit) };
};

const record = (entry) =>
  CustomerBalanceEntry.create({ ...entry, delta: money(entry.delta), demo: isDemoMode() });

/**
 * סכום החשבוניות שהתשלום סוגר.
 *
 * הסכום המחייב הוא זה שב-iCount. כשאי אפשר להגיע אליו נופלים לאומדן
 * מהתעודות — אותה החלטה כמו במסך: תקלה אצלם אינה סיבה לא לרשום כסף
 * שנכנס, והתנועה מסמנת מאיפה הסכום הגיע.
 *
 * @returns {Promise<{total: number, source: "icount"|"estimate", invoices: Array}>}
 */
const invoiceDue = async ({ customerId, invoices }) => {
  const notes = await DeliveryNote.find({
    customer: customerId,
    [ledger.f("icountDocNum")]: { $in: invoices },
    [ledger.f("status")]: "billed",
  })
    .select("total subTotal shippingCost discount items billing")
    .lean();

  const estimates = new Map();
  for (const note of notes) {
    const docNum = String(ledger.of(note).icountDocNum);
    estimates.set(docNum, money((estimates.get(docNum) || 0) + calculateVat(note).total));
  }

  const out = [];
  let source = "icount";

  for (const docNum of invoices.map(String)) {
    // חשבונית שאין לה תעודות אצל הלקוח הזה אינה שלו. רישום תשלום עליה
    // היה מזיז את היתרה של לקוח אחד לפי חשבונית של לקוח אחר.
    if (!estimates.has(docNum)) {
      throw new Error(`חשבונית ${docNum} לא נמצאה אצל הלקוח הזה`);
    }

    let total = 0;
    try {
      const doc = await getDocument(DOC_TYPES.INVOICE, docNum);
      total = Number(doc.totalwithvat ?? doc.doc_total ?? 0);
    } catch {
      // iCount לא זמין — האומדן למטה
    }
    if (!(total > 0)) {
      total = estimates.get(docNum);
      source = "estimate";
    }
    out.push({ docNum, total: money(total) });
  }

  return { total: money(out.reduce((s, i) => s + i.total, 0)), source, invoices: out };
};

/**
 * מה יקרה ליתרה אם יירשם התשלום הזה. קריאה בלבד — לא כותב דבר.
 */
const planSettlement = async ({ customerId, invoices, received }) => {
  const [due, balanceBefore] = await Promise.all([
    invoiceDue({ customerId, invoices }),
    balanceOf(customerId),
  ]);
  const delta = money(received - due.total);

  return {
    due: due.total,
    source: due.source,
    invoices: due.invoices,
    balanceBefore,
    delta,
    balanceAfter: money(balanceBefore + delta),
  };
};

/** תשלום על חשבון, בלי חשבונית: כולו נכנס ליתרה. */
const planOnAccount = async ({ customerId, received }) => {
  const balanceBefore = await balanceOf(customerId);
  const delta = money(received);
  return { due: 0, invoices: [], balanceBefore, delta, balanceAfter: money(balanceBefore + delta) };
};

/**
 * חשבונית ששולמה ובוטלה בזיכוי: מה שנסגר עליה חוזר לזכות הלקוח.
 *
 * הסכום שחוזר הוא סכום החשבונית ולא מה שהתקבל בפועל. ההפרש ביניהם
 * כבר נרשם ביתרה ברגע התשלום, ולכן החזרת "מה שהתקבל" הייתה סופרת
 * אותו פעמיים.
 *
 * @param {object} p
 * @param {Array}  p.notes - תעודות החשבונית כפי שנשלפו *לפני* הזיכוי
 * @returns {Promise<number>} הסכום שנוסף ליתרה, או 0 אם החשבונית לא שולמה
 */
const refundCancelledInvoice = async ({ customerId, docNum, notes, creditDocNum, reason }) => {
  if (!notes.some((n) => ledger.of(n).paidAt)) return 0;

  const settled = await CustomerBalanceEntry.findOne({
    customer: customerId,
    demo: isDemoMode() ? true : { $ne: true },
    kind: { $in: ["payment", "fromBalance"] },
    "invoices.docNum": String(docNum),
  })
    .sort({ createdAt: -1 })
    .lean();

  // תשלום שנרשם לפני שהיתרה נוהלה אינו נושא תנועה. הלקוח שילם בכל
  // זאת, ולכן נופלים לאומדן מהתעודות.
  const amount = money(
    settled?.invoices?.find((i) => i.docNum === String(docNum))?.total ||
      notes.reduce((s, n) => s + calculateVat(n).total, 0)
  );
  if (!(amount > 0)) return 0;

  await record({
    customer: customerId,
    kind: "invoiceCancelled",
    delta: amount,
    invoices: [{ docNum: String(docNum), total: amount }],
    creditDocNum,
    reason,
  });
  return amount;
};

/** תיקון ידני של היתרה, עם סיבה. */
const adjust = async ({ customerId, delta, reason, createdBy }) => {
  const amount = money(delta);
  if (!Number.isFinite(Number(delta)) || amount === 0) {
    throw new Error("יש להזין סכום שונה מאפס");
  }
  if (Math.abs(amount) > MAX_MANUAL_DELTA) {
    throw new Error("הסכום גדול מדי לתיקון ידני");
  }
  const why = String(reason || "").trim().slice(0, MAX_REASON_CHARS);
  if (!why) throw new Error("חובה לציין סיבה לתיקון היתרה");

  await record({ customer: customerId, kind: "manual", delta: amount, reason: why, createdBy });
  return balanceOf(customerId);
};

/**
 * הסכום שנרשם על כל קבלה — למסך הקבלות, שבלעדיו מציג אומדן מהתעודות.
 *
 * @returns {Promise<Map<string, number>>} מפתח: "<לקוח>|<מספר קבלה>"
 */
const receivedByReceipt = async (docNums, { demo = isDemoMode() } = {}) => {
  const nums = [...new Set((docNums || []).filter(Boolean).map(String))];
  if (!nums.length) return new Map();

  const entries = await CustomerBalanceEntry.find({
    receiptDocNum: { $in: nums },
    demo: demo ? true : { $ne: true },
  })
    .select("customer receiptDocNum received")
    .lean();

  return new Map(
    entries
      .filter((e) => e.received > 0)
      .map((e) => [`${e.customer}|${e.receiptDocNum}`, e.received])
  );
};

module.exports = {
  balanceOf,
  balancesOf,
  history,
  record,
  invoiceDue,
  planSettlement,
  planOnAccount,
  refundCancelledInvoice,
  adjust,
  receivedByReceipt,
  money,
};

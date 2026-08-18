// scripts/demo-seed.js
//
// בונה ללקוח אחד סט מסמכים מלא, כמה מכל סוג, כדי שיהיה מה לראות ולעבוד
// מולו בכל מסכי החיוב: הצעות מחיר, תעודות משלוח, חשבוניות, קבלות וזיכוי.
//
// מה אמיתי ומה דמו:
//
//   הצעת מחיר ותעודת משלוח נבנות אצלנו ואינן נשלחות ל-iCount כלל, ולכן
//   הן נוצרות במסד כרגיל — זה מה שהופך את ההדגמה למשהו שאפשר לעבוד מולו.
//
//   חשבונית, זיכוי וקבלה הם מסמכי מס, ולכן הם נוצרים בחשבון הדמו והרישום
//   שלהם נכנס לכיס billing.demo. תעודות המשלוח נשארות פתוחות לחיוב האמיתי.
//
// הסקריפט דורש ICOUNT_MODE=demo ונעצר אחרת — בחשבון האמיתי הוא היה מפיק
// מסמכי מס ושולח אותם ללקוח.
//
//   node scripts/demo-seed.js          # הלקוח הראשון ברשימה
//   node scripts/demo-seed.js 723      # לפי מספר לקוח בהנהח"ש
//
// אפשר להריץ שוב: הרצה מוחקת קודם את מה שהיא עצמה יצרה בפעם הקודמת
// (מזוהה לפי createdBy/issuedBy = "הדגמה") ובונה מחדש. מסמכים שנוצרו
// בדרך אחרת אינם נוגעים.
//
// ניקוי מלא: scripts/billing-demo-reset.js מסיר את מצב הדמו מכל התעודות.

require("dotenv").config();
const mongoose = require("mongoose");

const Customer = require("../models/Customer");
const DeliveryNote = require("../models/DeliveryNote");
const Quote = require("../models/Quote");
const quotes = require("../lib/billing/quotes");
const { createManual } = require("../lib/billing/deliveryNotes");
const { closeMonth, creditInvoice } = require("../lib/billing/monthlyBilling");
const { listInvoices } = require("../lib/billing/invoices");
const { listReceipts } = require("../lib/billing/receipts");
const ledger = require("../lib/billing/ledger");
const { createReceipt } = require("../lib/icount/documents");
const { modeLabel } = require("../lib/icount/mode");

const TAG = "הדגמה";

const NIS = (n) =>
  `${Number(n || 0).toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₪`;
const line = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 52 - t.length))}`);

// שני סלים, כדי שהחשבונית תראה גם שורות חייבות מע"מ וגם פטורות — זה
// ההבדל שהכי קשה לראות בלי מסמך אמיתי מול העיניים
const SWEETS = [
  { sku: "4423", quantity: 24 },
  { sku: "85", quantity: 10 },
];
const PRODUCE = [
  { sku: "108", quantity: 6 },
  { sku: "109", quantity: 4 },
];

// שלושה חודשים אחורה מהחודש הנוכחי, מהישן לחדש
const monthsBack = (n) => {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (n - 1 - i), 15);
    return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, date: d };
  });
};

// אותו מיון כמו במסך הלקוחות באדמין (controller/customerController):
// שמות בעברית קודם, ואז לפי סדר אלפביתי
const firstCustomer = async () => {
  const all = await Customer.find({ "erp.customerNumber": { $exists: true, $ne: "" } })
    .select("+erp name lastName")
    .lean();
  all.sort((a, b) => {
    const A = /^[֐-׿]+$/.test(a.name);
    const B = /^[֐-׿]+$/.test(b.name);
    if (A && !B) return -1;
    if (!A && B) return 1;
    return a.name.localeCompare(b.name);
  });
  return all[0];
};

(async () => {
  if (modeLabel() !== "demo") {
    console.error("❌ הסקריפט רץ רק כש-ICOUNT_MODE=demo — בחשבון האמיתי הוא היה מפיק מסמכי מס");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const wanted = process.argv[2];
  const customer = wanted
    ? await Customer.findOne({ "erp.customerNumber": wanted }).select("+erp name").lean()
    : await firstCustomer();
  if (!customer) throw new Error(wanted ? `לא נמצא לקוח ${wanted}` : "לא נמצא לקוח");

  console.log(`מצב iCount: ${modeLabel()}`);
  console.log(`לקוח: ${customer.name} (מס' ${customer.erp.customerNumber}, ח.פ ${customer.erp.idNumber || "—"})`);

  // ── ניקוי ההרצה הקודמת ──────────────────────────────────────────
  const [dq, dn] = await Promise.all([
    Quote.deleteMany({ customer: customer._id, createdBy: TAG }),
    // idempotencyKey ולא issuedBy: מחיקה לפי שם המפיק הייתה מוחקת גם
    // תעודה שאדם הקליד ידנית וצירף לה את אותו שם. המפתח נוצר רק כאן.
    DeliveryNote.deleteMany({
      customer: customer._id,
      idempotencyKey: { $regex: `^demo-seed-${customer._id}-` },
    }),
  ]);
  if (dq.deletedCount || dn.deletedCount) {
    console.log(`ניקוי הרצה קודמת: ${dq.deletedCount} הצעות, ${dn.deletedCount} תעודות`);
  }

  const months = monthsBack(3);

  // ── הצעות מחיר ──────────────────────────────────────────────────
  line("הצעות מחיר");
  const quoteSpecs = [
    { items: [...SWEETS, ...PRODUCE], notes: "הצעה לכיבוד חודשי למשרד", outcome: "accepted" },
    { items: SWEETS, notes: "מארזי חג — הצעה ראשונית", outcome: "rejected", reason: "יקר מדי מול הצעה מתחרה" },
    { items: [...PRODUCE, { sku: "4424", quantity: 6 }], notes: "סל פירות שבועי", outcome: "open" },
  ];

  for (const spec of quoteSpecs) {
    const { quote } = await quotes.create({
      customerId: customer._id,
      items: spec.items,
      validDays: 30,
      notes: spec.notes,
      createdBy: TAG,
    });
    if (spec.outcome === "accepted") await quotes.accept(quote._id);
    if (spec.outcome === "rejected") await quotes.reject(quote._id, spec.reason);
    console.log(`  #${quote.number} · ${spec.outcome} · ${quote.items.length} שורות · ${NIS(quote.total)} · ${spec.notes}`);
  }

  // ── תעודות משלוח ────────────────────────────────────────────────
  line("תעודות משלוח");
  const mk = async (items, month, ref, label) => {
    const { note } = await createManual({
      customerId: customer._id,
      items,
      manualReference: ref,
      issuedAt: month.date,
      notes: label,
      issuedBy: TAG,
      idempotencyKey: `demo-seed-${customer._id}-${ref}`,
    });
    // billingMonth נגזר מ-issuedAt, אבל נקבע כאן במפורש כדי שהסגירה לחודש
    // הזה תיקח בדיוק את התעודות האלה
    await DeliveryNote.updateOne({ _id: note._id }, { $set: { "billing.billingMonth": month.key } });
    console.log(`  #${note.number} · ${month.key} · ${ref} · ${NIS(note.total)} · ${label}`);
    return note;
  };

  for (const m of months) {
    await mk(SWEETS, m, `A-${m.key}`, "מתוקים — חייב מע\"מ");
    await mk(PRODUCE, m, `B-${m.key}`, "פירות וירקות — פטור");
  }

  // ── חשבוניות ────────────────────────────────────────────────────
  line("חשבוניות");
  const issued = [];
  for (const m of months) {
    const res = await closeMonth({ month: m.key, customerId: customer._id });
    for (const inv of res.results.flatMap((r) => r.invoices)) {
      issued.push({ ...inv, month: m.key });
      console.log(`  #${inv.docNum} · ${m.key} · ${inv.noteCount} תעודות · נטו ${NIS(inv.netTotal)} · מייל: ${inv.emailedTo || "לא נשלח"}`);
    }
  }

  // ── זיכוי והפקה מחדש ────────────────────────────────────────────
  // התרחיש האמיתי: חשבונית יצאה עם טעות, מזכים אותה, והתעודות חוזרות
  // להיות פתוחות ומחויבות מחדש בחשבונית תקינה.
  line("זיכוי והפקה מחדש");
  const toCredit = issued[0];
  const credit = await creditInvoice({
    icountDocNum: toCredit.docNum,
    reason: "טעות בכמות — הופקה חשבונית מתקנת",
    reopenNotes: true,
  });
  console.log(`  זיכוי #${credit.creditDocNum} על חשבונית ${toCredit.docNum} (${credit.noteCount} תעודות)`);

  const reissue = await closeMonth({ month: toCredit.month, customerId: customer._id });
  const fixed = reissue.results.flatMap((r) => r.invoices)[0];
  console.log(`  חשבונית מתקנת #${fixed.docNum} · נטו ${NIS(fixed.netTotal)}`);

  // ── קבלות ───────────────────────────────────────────────────────
  line("קבלות");
  const open = await listInvoices({ customerId: customer._id });
  // הישנות משולמות, האחרונה נשארת פתוחה — כדי שדוח הגבייה יראה גם חוב
  const toPay = open.sort((a, b) => new Date(a.billedAt) - new Date(b.billedAt)).slice(0, -1);
  const methods = [
    { method: "transfer", details: { bank: "12", branch: "678", account: "334455" }, label: "העברה בנקאית" },
    { method: "check", details: { bank: "10", branch: "801", account: "112233", checkNum: "4471" }, label: "צ'ק" },
    { method: "cash", details: {}, label: "מזומן" },
  ];

  for (const [i, inv] of toPay.entries()) {
    const pay = methods[i % methods.length];
    const doc = await createReceipt({
      customerId: customer._id,
      amount: inv.grossEstimate,
      method: pay.method,
      forInvoices: [inv.docNum],
      details: { ...pay.details, date: new Date().toISOString().slice(0, 10) },
    });
    await DeliveryNote.updateMany(
      {
        customer: customer._id,
        [ledger.f("icountDocNum")]: inv.docNum,
        [ledger.f("status")]: "billed",
      },
      {
        $set: {
          [ledger.f("receiptDocNum")]: doc.docNum,
          [ledger.f("receiptDocUrl")]: doc.url || null,
          [ledger.f("receiptEmailedTo")]: doc.emailedTo || null,
          [ledger.f("paidAt")]: new Date(),
        },
      }
    );
    console.log(`  #${doc.docNum} · ${NIS(inv.grossEstimate)} · ${pay.label} · על חשבונית ${inv.docNum} · מייל: ${doc.emailedTo || "לא נשלח"}`);
  }

  // ── אימות ───────────────────────────────────────────────────────
  line("אימות");
  const finalQuotes = await Quote.find({ customer: customer._id, createdBy: TAG }).lean();
  const finalNotes = await DeliveryNote.find({
    customer: customer._id,
    idempotencyKey: { $regex: `^demo-seed-${customer._id}-` },
  }).lean();
  const finalInvoices = await listInvoices({ customerId: customer._id });
  const finalReceipts = await listReceipts({ customerId: customer._id });
  const mine = finalNotes.map((n) => n.billing);

  const checks = [
    ["3 הצעות מחיר בשלושה מצבים", finalQuotes.length === 3 && new Set(finalQuotes.map((q) => q.status)).size === 3],
    ["6 תעודות משלוח", finalNotes.length === 6],
    ["חשבונית פתוחה אחת לפחות", finalInvoices.some((i) => !i.paidAt)],
    ["חשבונית משולמת אחת לפחות", finalInvoices.some((i) => i.paidAt)],
    ["קבלות נרשמו", finalReceipts.length >= 2],
    ["זיכוי נרשם בהיסטוריה", mine.some((b) => (b.demo?.credits || []).length > 0)],
    ["אף מסמך לא נשלח במייל", finalInvoices.every((i) => !i.emailedTo) && finalReceipts.every((r) => !r.emailedTo)],
    ["הרישום האמיתי נקי", mine.every((b) => b.status === "open" && !b.icountDocNum && !b.paidAt && !(b.credits || []).length)],
    ["כל התעודות מחויבות בכיס הדמו", mine.every((b) => b.demo?.status === "billed")],
  ];
  for (const [name, ok] of checks) console.log(`  ${ok ? "✅" : "❌"} ${name}`);

  line("סיכום");
  console.log(`  הצעות מחיר: ${finalQuotes.map((q) => `#${q.number}`).join(", ")}`);
  console.log(`  תעודות משלוח: ${finalNotes.map((n) => `#${n.number}`).sort().join(", ")}`);
  console.log(`  חשבוניות: ${finalInvoices.map((i) => `#${i.docNum}${i.paidAt ? " (שולם)" : " (פתוח)"}`).join(", ")}`);
  console.log(`  קבלות: ${finalReceipts.map((r) => `#${r.docNum}`).join(", ")}`);
  console.log(`  זיכוי: #${credit.creditDocNum}`);

  await mongoose.disconnect();
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
})().catch(async (err) => {
  console.error("\n❌", err.message, err.details ? JSON.stringify(err.details) : "");
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});

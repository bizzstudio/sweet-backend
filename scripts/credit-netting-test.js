// scripts/credit-netting-test.js
//
// בדיקת סגירת תעודות זיכוי בתוך החשבונית החודשית, ודוח החוב לפי חודש.
//
// iCount מוחלף בפונקציות מדומות — הזרימה מפיקה חשבוניות וזיכויים, ואלה
// מסמכי מס שאי אפשר למחוק. כל השאר רץ באמת מול המסד.
//
// ⚠️ רץ רק מול מסד מקומי:
//
//   MONGO_URI=mongodb://127.0.0.1:27099/netting-test node scripts/credit-netting-test.js

process.env.ICOUNT_MODE = "live";

const mongoose = require("mongoose");

const uri = process.env.MONGO_URI || "";
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri)) {
  console.error("❌ הבדיקה רצה רק מול מסד מקומי (MONGO_URI=mongodb://127.0.0.1:...)");
  process.exit(1);
}

// ── החלפת iCount לפני שמישהו טוען אותו ──────────────────────────────
const icountDocs = require("../lib/icount/documents");
let seq = 3000;
let invoicesSent = [];
let refundsSent = [];
let failNext = false;

icountDocs.createInvoice = async (doc) => {
  if (failNext) {
    failNext = false;
    throw new Error("iCount מדומה: נכשל");
  }
  const docNum = String(++seq);
  invoicesSent.push({ docNum, ...doc });
  return { doctype: "invoice", docNum, url: `https://mock.icount/${docNum}` };
};
icountDocs.createCreditNote = async (doc) => {
  const docNum = String(++seq);
  refundsSent.push({ docNum, ...doc });
  return { doctype: "refund", docNum, url: `https://mock.icount/${docNum}` };
};
icountDocs.getDocument = async () => {
  throw new Error("iCount מדומה: לא זמין");
};

const DeliveryNote = require("../models/DeliveryNote");
const CreditNote = require("../models/CreditNote");
const Customer = require("../models/Customer");
const CustomerBalanceEntry = require("../models/CustomerBalanceEntry");
const monthlyBilling = require("../lib/billing/monthlyBilling");
const creditNotes = require("../lib/billing/creditNotes");
const { reissueInvoice } = require("../lib/billing/reissue");
const { listInvoices } = require("../lib/billing/invoices");
const { listReceipts } = require("../lib/billing/receipts");
const { debtReport } = require("../lib/billing/debtReport");
const { calculateVat } = require("../lib/billing/vat");
const customerBalance = require("../lib/billing/customerBalance");
const controller = require("../controller/billingController");

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const group = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`);
const near = (a, b) => Math.abs(a - b) < 0.011;

const call = async (handler, { body, params, query } = {}) => {
  const out = { status: 200, data: null };
  const res = {
    status(code) { out.status = code; return res; },
    send(data) { out.data = data; return res; },
  };
  await handler({ body, params: params || {}, query: query || {}, user: { email: "test@local" } }, res);
  return out;
};

const MONTH = "2026-10";
const OCT = new Date("2026-10-15T10:00:00Z");

const line = (name, lineTotal, extra = {}) => ({
  name, quantity: 1, unitPrice: lineTotal, lineTotal, isVatFree: false, categoryName: "מזון", ...extra,
});
const fruit = (name, lineTotal) => line(name, lineTotal, { isVatFree: true, categoryName: "פירות" });
const disposable = (name, lineTotal) => line(name, lineTotal, { categoryName: 'ח.ניקוי+ח"פ' });

let customerSeq = 1;
const newCustomer = async (billing = {}) => {
  const name = `לקוח ${customerSeq++}`;
  const { insertedId } = await Customer.collection.insertOne({
    name, email: `c${customerSeq}@test.local`, billing,
  });
  return insertedId;
};

let noteNumber = 1000;
const openNote = async (customer, items, { discount = 0, shippingCost = 0, billing = {} } = {}) => {
  const subTotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const { insertedId } = await DeliveryNote.collection.insertOne({
    number: noteNumber++,
    customer,
    customerSnapshot: { name: "לקוח" },
    items,
    subTotal,
    discount,
    shippingCost,
    total: subTotal + shippingCost - discount,
    issuedAt: OCT,
    billing: { status: "open", billingMonth: MONTH, ...billing },
  });
  return insertedId;
};

let creditNumber = 9000;
const openCredit = async (customer, items, { discount = 0, issuedAt = OCT, reason = "החזרה" } = {}) => {
  const subTotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const note = await CreditNote.create({
    number: creditNumber++,
    customer,
    customerSnapshot: { name: "לקוח" },
    items,
    subTotal,
    discount,
    total: subTotal - discount,
    reason,
    issuedAt,
    billing: { status: "open" },
  });
  return note;
};

const close = (customer, opts = {}) =>
  monthlyBilling.closeMonth({ month: MONTH, customerId: customer, emailDocument: false, ...opts });

const reload = (note) => CreditNote.findById(note._id).lean();

(async () => {
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();

  group("חשבונית מרוכזת: שורות זיכוי שליליות");
  const a = await newCustomer();
  await openNote(a, [line("קפה", 600), line("סוכר", 400), fruit("תפוח", 300)]);
  const aCredit = await openCredit(a, [line("קפה", 100), fruit("תפוח", 50)]);

  const preview = await close(a, { dryRun: true });
  const previewInv = preview.results[0].invoices[0];
  check("התצוגה המקדימה מציגה סכום אחרי זיכוי", previewInv.netTotal === 1150, JSON.stringify(previewInv));
  check("והתעודה ברשימה ניתנת לסימון", preview.results[0].creditNotes?.[0]?.number === aCredit.number);

  let res = await close(a);
  let sent = invoicesSent.at(-1);
  check("הופקה חשבונית אחת", res.invoicesCreated === 1);
  check(
    "שורות: שתי משלוח ושתי זיכוי",
    sent.items.map((i) => `${i.name}=${i.unitPrice}`).join("|") ===
      "ריכוז תעודות משלוח מזון=1000|ריכוז תעודות משלוח פירות=300|ריכוז תעודות זיכוי מזון=-100|ריכוז תעודות זיכוי פירות=-50",
    JSON.stringify(sent.items.map((i) => [i.name, i.unitPrice]))
  );
  const stored = await reload(aCredit);
  check("התעודה סומנה netted עם מספר החשבונית", stored.billing.status === "netted" && stored.billing.invoiceDocNum === sent.docNum);
  check("בלי טוקן תפיסה", !stored.billing.claimToken);
  let inv = (await listInvoices({ customerId: a }))[0];
  check("הברוטו ברשימת החשבוניות אחרי הזיכוי", near(inv.grossEstimate, 900 * 1.18 + 250), String(inv.grossEstimate));
  check("הנטו אחרי הזיכוי", inv.netTotal === 1150, String(inv.netTotal));
  check("החשבונית מציגה את תעודת הזיכוי", inv.creditNotes?.[0] === aCredit.number);

  let notesRes = await call(controller.getInvoiceNotes, { params: { docnum: sent.docNum }, query: {} });
  check("הנספח כולל את הזיכוי", notesRes.data.creditNotes?.[0]?.total === 150 && notesRes.data.totals.net === 1150, JSON.stringify(notesRes.data.totals));

  const due = await customerBalance.invoiceDue({ customerId: a, invoices: [sent.docNum] });
  check("סכום לתשלום (אומדן) אחרי הזיכוי", near(due.total, 900 * 1.18 + 250), String(due.total));

  group("הנחה");
  const b = await newCustomer();
  await openNote(b, [line("קפה", 1000)], { discount: 50 });
  await openCredit(b, [line("קפה", 100)], { discount: 5 });
  await close(b);
  sent = invoicesSent.at(-1);
  check("הנחת המסמך היא הפרש ההנחות", sent.discount === 45, String(sent.discount));
  inv = (await listInvoices({ customerId: b }))[0];
  check("החישוב שלנו תואם ל-iCount", near(inv.netTotal, 855), String(inv.netTotal));

  const b2 = await newCustomer();
  await openNote(b2, [line("קפה", 1000)]);
  const noDiscount = await openCredit(b2, [line("קפה", 100)], { discount: 5 });
  res = await close(b2);
  check("הנחה בזיכוי בלי הנחה בחשבונית — התעודה נשארת פתוחה", (await reload(noDiscount)).billing.status === "open");
  check("והיא מדווחת", res.creditsLeftOpen === 1);

  group("זיכוי גדול מהחשבונית");
  const c = await newCustomer();
  await openNote(c, [line("קפה", 100)]);
  const big = await openCredit(c, [line("קפה", 150)]);
  const small = await openCredit(c, [line("קפה", 40)]);
  res = await close(c);
  check("הגדול נשאר פתוח", (await reload(big)).billing.status === "open");
  check("הקטן נסגר", (await reload(small)).billing.status === "netted");
  check("הסכום לא שלילי", invoicesSent.at(-1).items.reduce((s, i) => s + i.lineTotal, 0) === 60);

  const c2 = await newCustomer();
  await openNote(c2, [line("קפה", 100), fruit("תפוח", 1000)]);
  const overTaxable = await openCredit(c2, [line("קפה", 500)]);
  await close(c2);
  check("זיכוי מעבר לחלק החייב נשאר פתוח", (await reload(overTaxable)).billing.status === "open");

  group("חשבוניות מפוצלות");
  const d = await newCustomer({ separateDisposablesInvoice: true, separateFruitInvoice: true });
  await openNote(d, [line("קפה", 500)]);
  await openNote(d, [disposable("כוסות", 200)]);
  const dDisposable = await openCredit(d, [disposable("כוסות", 20)]);
  const dFruit = await openCredit(d, [fruit("תפוח", 10)]);
  invoicesSent = [];
  await close(d);
  const disposablesInvoice = invoicesSent.find((i) => i.items.some((l) => /חד פעמי/.test(l.name)));
  check("שתי חשבוניות", invoicesSent.length === 2, String(invoicesSent.length));
  check(
    "זיכוי חד פעמי נסגר בחשבונית החד פעמי",
    (await reload(dDisposable)).billing.invoiceDocNum === disposablesInvoice?.docNum &&
      disposablesInvoice.items.some((l) => l.name === "ריכוז תעודות זיכוי חד פעמי" && l.unitPrice === -20),
    JSON.stringify(disposablesInvoice?.items)
  );
  check("זיכוי פירות בלי חשבונית פירות נשאר פתוח", (await reload(dFruit)).billing.status === "open");

  group("חשבונית מפורטת ואיחוד מוצרים");
  const e = await newCustomer({ summarizeInvoiceLines: false, mergeInvoiceProducts: true });
  await openNote(e, [line("קפה", 100), line("סוכר", 50)]);
  await openNote(e, [line("קפה", 100)]);
  await openCredit(e, [{ ...line("קפה", 40), quantity: 2, unitPrice: 20 }]);
  await close(e);
  sent = invoicesSent.at(-1);
  const creditLine = sent.items.find((i) => i.name === "זיכוי: קפה");
  check("שורת מוצר בכמות שלילית", creditLine?.quantity === -2 && creditLine.unitPrice === 20, JSON.stringify(sent.items));
  check("המוצרים החיוביים אוחדו", sent.items.find((i) => i.name === "קפה")?.quantity === 2);

  group("מה לא נסגר בחשבונית");
  const f = await newCustomer();
  const fNote = await openNote(f, [line("קפה", 500)]);
  const fCredit = await openCredit(f, [line("קפה", 50)]);
  const nextMonth = await openCredit(f, [line("קפה", 60)], { issuedAt: new Date("2026-11-02T10:00:00Z") });
  await monthlyBilling.billNotesNow({ customerId: f, noteIds: [fNote], detailed: true, emailDocument: false });
  check("חשבונית על תעודה בודדת לא סוגרת זיכוי", (await reload(fCredit)).billing.status === "open");
  check("ואין בה שורות שליליות", invoicesSent.at(-1).items.every((i) => i.lineTotal > 0));

  const f2 = await newCustomer();
  await openNote(f2, [line("קפה", 500)]);
  const f2Credit = await openCredit(f2, [line("קפה", 50)]);
  const f2Later = await openCredit(f2, [line("קפה", 60)], { issuedAt: new Date("2026-11-02T10:00:00Z") });
  await close(f2);
  check("זיכוי מהחודש הבא מחכה לחודש הבא", (await reload(f2Later)).billing.status === "open");
  check("זיכוי מהחודש נסגר", (await reload(f2Credit)).billing.status === "netted");

  const f3 = await newCustomer();
  await openNote(f3, [line("קפה", 500)]);
  const unselected = await openCredit(f3, [line("קפה", 50)]);
  await close(f3, { creditNoteIds: [] });
  check("זיכוי שלא סומן במסך נשאר פתוח", (await reload(unselected)).billing.status === "open");

  const onlyCredit = await newCustomer();
  const lonely = await openCredit(onlyCredit, [line("קפה", 50)]);
  res = await monthlyBilling.closeMonth({ month: MONTH, emailDocument: false, customerId: onlyCredit });
  check("לקוח בלי תעודות משלוח — אין חשבונית והזיכוי פתוח", res.invoicesCreated === 0 && (await reload(lonely)).billing.status === "open");

  group("כשל בהפקה");
  const g = await newCustomer();
  await openNote(g, [line("קפה", 500)]);
  const gCredit = await openCredit(g, [line("קפה", 50)]);
  failNext = true;
  res = await close(g);
  check("הכשל מדווח", res.failures.length === 1);
  const gStored = await reload(gCredit);
  check("הזיכוי חזר לפתוח בלי טוקן", gStored.billing.status === "open" && !gStored.billing.claimToken);
  check("התעודה חזרה לפתוח", (await DeliveryNote.findOne({ customer: g }).lean()).billing.status === "open");

  group("ביטול ותיקון חשבונית עם זיכוי");
  const h = await newCustomer();
  await openNote(h, [line("קפה", 500)]);
  const hCredit = await openCredit(h, [line("קפה", 50)]);
  await close(h);
  const hDoc = invoicesSent.at(-1).docNum;
  await monthlyBilling.creditInvoice({ icountDocNum: hDoc, reason: "טעות" });
  const refund = refundsSent.at(-1);
  check(
    "הזיכוי המלא בנוי כמו החשבונית",
    JSON.stringify(refund.items.map((i) => [i.name, i.unitPrice])) ===
      JSON.stringify(invoicesSent.at(-1).items.map((i) => [i.name, i.unitPrice])),
    JSON.stringify(refund.items)
  );
  check("זיכוי של ביטול לא נשלח ללקוח במייל", refund.emailDocument === false, String(refund.emailDocument));
  const hStored = await reload(hCredit);
  check("התעודה חזרה לפתוחה", hStored.billing.status === "open" && !hStored.billing.invoiceDocNum);

  await close(h);
  const hDoc2 = invoicesSent.at(-1).docNum;
  const reissued = await reissueInvoice({ icountDocNum: hDoc2, reason: "תיקון", emailDocument: true });
  check("התיקון הצליח", reissued.stage === "done", JSON.stringify(reissued));
  check(
    "בהפקה מחדש תיבת המייל חלה רק על החשבונית החדשה",
    refundsSent.at(-1).emailDocument === false && invoicesSent.at(-1).emailDocument === true,
    `${refundsSent.at(-1).emailDocument} / ${invoicesSent.at(-1).emailDocument}`
  );
  check("הזיכוי נכנס גם לחשבונית החדשה", invoicesSent.at(-1).items.some((i) => i.unitPrice === -50));
  check("ומשויך אליה", (await reload(hCredit)).billing.invoiceDocNum === reissued.docNums[0]);

  const late = await newCustomer();
  await openNote(late, [line("קפה", 500)]);
  const lateCredit = await openCredit(late, [line("קפה", 50)], { issuedAt: new Date("2026-11-01T06:00:00Z") });
  await monthlyBilling.closeMonth({ month: "2026-11", customerId: late, emailDocument: false });
  const lateDoc = invoicesSent.at(-1).docNum;
  const lateFixed = await reissueInvoice({ icountDocNum: lateDoc, reason: "תיקון", emailDocument: false });
  check(
    "תיקון מחזיר זיכוי גם כשהוא מאוחר לחודש התעודות",
    lateFixed.stage === "done" && (await reload(lateCredit)).billing.invoiceDocNum === lateFixed.docNums[0],
    JSON.stringify(lateFixed.problems)
  );

  const paid = await newCustomer();
  await openNote(paid, [line("קפה", 500)]);
  await openCredit(paid, [line("קפה", 100)]);
  await close(paid);
  const paidDoc = invoicesSent.at(-1).docNum;
  await DeliveryNote.updateMany({ customer: paid }, { $set: { "billing.paidAt": new Date() } });
  const cancelled = await monthlyBilling.creditInvoice({ icountDocNum: paidDoc, reason: "טעות" });
  check("ביטול חשבונית ששולמה מחזיר את הסכום אחרי הזיכוי", near(cancelled.balanceCredited, 472), String(cancelled.balanceCredited));

  group("תעודה שנסגרה בחשבונית");
  await creditNotes.issueInvoice(hCredit._id).then(
    () => check("הפקת חשבונית זיכוי נחסמת", false),
    (err) => check("הפקת חשבונית זיכוי נחסמת", /נסגרה בחשבונית/.test(err.message), err.message)
  );
  await creditNotes.cancel(hCredit._id, "x").then(
    () => check("ביטול נחסם", false),
    (err) => check("ביטול נחסם", /נסגרה בחשבונית/.test(err.message), err.message)
  );

  group("זיכוי שמקושר לחשבונית קודמת");
  const i = await newCustomer();
  await openNote(i, [line("קפה", 500)]);
  await close(i);
  const oldDoc = invoicesSent.at(-1).docNum;
  await openNote(i, [line("קפה", 500)]);
  const linked = await openCredit(i, [line("קפה", 50)]);
  await CreditNote.updateOne({ _id: linked._id }, { $set: { "billing.originalDocNum": oldDoc } });
  await close(i);
  await monthlyBilling.creditInvoice({ icountDocNum: oldDoc, reason: "x" }).then(
    () => check("ביטול החשבונית המקורית נחסם", false),
    (err) => check("ביטול החשבונית המקורית נחסם", /זיכוי/.test(err.message), err.message)
  );

  group("דוח חוב לפי חודש");
  const j = await newCustomer();
  await DeliveryNote.collection.insertOne({
    number: noteNumber++, customer: j, customerSnapshot: { name: "יעל" },
    items: [], subTotal: 1000, total: 1000, issuedAt: OCT,
    billing: { status: "billed", icountDocNum: "7001", billedAt: new Date("2026-11-01T08:00:00Z"), billingMonth: "2026-10" },
  });
  await DeliveryNote.collection.insertOne({
    number: noteNumber++, customer: j, customerSnapshot: { name: "יעל" },
    items: [], subTotal: 500, total: 500, issuedAt: OCT,
    billing: { status: "billed", icountDocNum: "7002", billedAt: new Date("2026-12-01T08:00:00Z"), billingMonth: "2026-11" },
  });
  await DeliveryNote.collection.insertOne({
    number: noteNumber++, customer: j, customerSnapshot: { name: "יעל" },
    items: [], subTotal: 300, total: 300, issuedAt: OCT,
    billing: { status: "billed", icountDocNum: "7003", billedAt: new Date("2026-11-01T08:00:00Z"), billingMonth: "2026-10", paidAt: new Date(), receiptDocNum: "8001" },
  });
  await CustomerBalanceEntry.create({ customer: j, kind: "manual", delta: 100, reason: "בדיקה" });
  const report = await debtReport({ customerId: j });
  const row = report.customers[0];
  check("חשבונית אוקטובר שהופקה בנובמבר נספרת באוקטובר", row.months[0].month === "2026-10" && row.months[0].amount === 1180, JSON.stringify(row.months));
  check("נובמבר בנפרד", row.months[1].month === "2026-11" && row.months[1].amount === 590);
  check("חשבונית ששולמה לא נספרת", row.total === 1770, String(row.total));
  check("יתרת הזכות יורדת מהסכום לתשלום", row.netDue === 1670 && row.balance === 100);
  const reportAll = await debtReport();
  check("הדוח הכללי כולל את הלקוח", reportAll.customers.some((r) => r.customerId === String(j)));

  const cKey = await newCustomer();
  await openNote(cKey, [line("קפה", 500)]);
  await close(cKey);
  const cDoc = invoicesSent.at(-1).docNum;
  const partial = await openCredit(cKey, [line("קפה", 100)], { reason: "חלקי" });
  await creditNotes.issueInvoice(partial._id, { originalDocNum: cDoc });
  const partialRow = (await debtReport({ customerId: cKey })).customers[0];
  check(
    "חשבונית זיכוי מקושרת נספרת פעם אחת, דרך היתרה",
    near(partialRow.total, 590) && near(partialRow.balance, 118) && near(partialRow.netDue, 472),
    JSON.stringify(partialRow)
  );

  const http = await call(controller.getDebtReport, { query: { customer: "לא-מזהה" } });
  check("מזהה לקוח פסול נדחה", http.status === 400);

  group("חיפוש לפי מספר");
  const number = (await DeliveryNote.findOne({ customer: a }).lean()).number;
  const aDoc = (await listInvoices({ customerId: a }))[0].docNum;
  let found = await call(controller.getDeliveryNotes, { query: { search: String(number) } });
  check("תעודה לפי מספר", found.data.notes?.some((n) => n.number === number), JSON.stringify(found.data).slice(0, 200));
  found = await call(controller.getDeliveryNotes, { query: { search: aDoc } });
  check("תעודה לפי מספר החשבונית", found.data.notes?.some((n) => n.number === number));
  found = await call(controller.getCreditNotes, { query: { search: String(aCredit.number) } });
  check("תעודת זיכוי לפי מספר", found.data.creditNotes?.length === 1 && found.data.creditNotes[0].number === aCredit.number);
  found = await call(controller.getCreditNotes, { query: { search: aDoc } });
  check("תעודת זיכוי לפי החשבונית שסגרה אותה", found.data.creditNotes?.[0]?.number === aCredit.number);
  found = await call(controller.getCreditNotes, { query: { status: "netted", customer: String(a) } });
  check("סינון לפי סטטוס netted", found.data.creditNotes?.length === 1);

  group("קבלה");
  await DeliveryNote.updateMany({ customer: a }, { $set: { "billing.receiptDocNum": "6001", "billing.paidAt": new Date() } });
  const receipt = (await listReceipts({ customerId: a }))[0];
  check("האומדן בקבלה אחרי הזיכוי", near(receipt.grossEstimate, 900 * 1.18 + 250), String(receipt.grossEstimate));

  group("חישוב המע\"מ תואם ל-iCount (חשבונית דמו 2017)");
  const vat = calculateVat({
    subTotal: 1150,
    discount: 23,
    items: [line("א", 1000), fruit("ב", 300), line("ג", -100), fruit("ד", -50)],
  });
  check("1,285.76 ₪", vat.total === 1285.76 && vat.vat === 158.76, JSON.stringify(vat));

  console.log(`\n${fail ? "❌" : "✅"} ${pass} עברו · ${fail} נכשלו`);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error("❌", err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});

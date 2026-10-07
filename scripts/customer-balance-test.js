// scripts/customer-balance-test.js
//
// בדיקת יתרת הלקוח: תשלום עודף, תשלום חסר, סגירה מהיתרה, ביטול חשבונית
// ששולמה, תיקון ידני ובידוד מצב הדמו.
//
// iCount מוחלף בפונקציות מדומות — הזרימה מפיקה קבלות וזיכויים, ואלה
// מסמכי מס שאי אפשר למחוק. כל השאר רץ באמת מול המסד.
//
// ⚠️ רץ רק מול מסד מקומי. הבדיקה יוצרת לקוח ותעודות "מחויבות", ומסד
//    הייצור אינו מקום לזה:
//
//   MONGO_URI=mongodb://127.0.0.1:27099/balance-test node scripts/customer-balance-test.js

process.env.ICOUNT_MODE = "live";

const mongoose = require("mongoose");

const uri = process.env.MONGO_URI || "";
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri)) {
  console.error("❌ הבדיקה רצה רק מול מסד מקומי (MONGO_URI=mongodb://127.0.0.1:...)");
  process.exit(1);
}

// ── החלפת iCount לפני שמישהו טוען אותו ──────────────────────────────
const icountDocs = require("../lib/icount/documents");
const icountTotals = new Map();
let icountDown = false;
let receipts = [];
let seq = 5000;

icountDocs.createReceipt = async ({ amount, forInvoices }) => {
  const docNum = String(++seq);
  receipts.push({ docNum, amount, forInvoices });
  return { doctype: "receipt", docNum, url: `https://mock.icount/${docNum}` };
};
icountDocs.createCreditNote = async () => {
  const docNum = String(++seq);
  return { doctype: "refund", docNum, url: `https://mock.icount/${docNum}` };
};
icountDocs.getDocument = async (doctype, docNum) => {
  if (icountDown || !icountTotals.has(String(docNum))) throw new Error("iCount מדומה: לא זמין");
  return { totalwithvat: icountTotals.get(String(docNum)) };
};

const DeliveryNote = require("../models/DeliveryNote");
const Customer = require("../models/Customer");
const CustomerBalanceEntry = require("../models/CustomerBalanceEntry");
const customerBalance = require("../lib/billing/customerBalance");
const monthlyBilling = require("../lib/billing/monthlyBilling");
const { listInvoices } = require("../lib/billing/invoices");
const { listReceipts } = require("../lib/billing/receipts");
const controller = require("../controller/billingController");

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const group = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`);

/** קריאה לנקודת קצה בלי שרת. */
const call = async (handler, { body, params, query } = {}) => {
  const out = { status: 200, data: null };
  const res = {
    status(code) { out.status = code; return res; },
    send(data) { out.data = data; return res; },
  };
  await handler({ body, params: params || {}, query: query || {}, user: { email: "test@local" } }, res);
  return out;
};

let noteNumber = 1;
/** חשבונית מחויבת: תעודה אחת, בלי שורות, כך שהברוטו הוא net × 1.18. */
const invoice = async (customer, docNum, net) => {
  await DeliveryNote.collection.insertOne({
    number: noteNumber++,
    customer: customer._id,
    customerSnapshot: { name: customer.name },
    items: [],
    subTotal: net,
    total: net,
    billing: { status: "billed", icountDocNum: docNum, billedAt: new Date() },
  });
};

const pay = (customer, docNum, amount) =>
  call(controller.createReceiptForPayment, {
    body: { customer: String(customer._id), amount, method: "transfer", forInvoices: [docNum] },
  });

(async () => {
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();

  const customer = (
    await Customer.collection.insertOne({ name: "לקוח בדיקה", email: "a@test.local" })
  ).insertedId;
  const c = { _id: customer, name: "לקוח בדיקה" };
  const other = { _id: (await Customer.collection.insertOne({ name: "אחר", email: "b@test.local" })).insertedId, name: "אחר" };

  // 677.97 × 1.18 = 800.00 · 423.73 × 1.18 = 500.00
  await invoice(c, "100", 677.97);
  await invoice(c, "101", 423.73);
  await invoice(c, "102", 423.73);
  await invoice(c, "103", 677.97);
  await invoice(other, "200", 677.97);
  for (const [n, t] of [["100", 800], ["101", 500], ["102", 500], ["103", 800], ["200", 800]]) {
    icountTotals.set(n, t);
  }

  group("תשלום עודף נשאר ליתרה");
  let r = await pay(c, "100", 1000);
  check("הקבלה הופקה על 1,000", r.status === 200 && receipts.at(-1)?.amount === 1000, JSON.stringify(r.data));
  check("יתרת זכות 200", (await customerBalance.balanceOf(customer)) === 200);
  check("התשובה מדווחת על היתרה", r.data.balance === 200 && /יתרת זכות 200/.test(r.data.message), r.data.message);
  check("לקוח אחר לא הושפע", (await customerBalance.balanceOf(other._id)) === 0);

  group("היתרה מתקזזת מהחשבונית הבאה");
  r = await pay(c, "101", 300);
  check("300 על חשבונית של 500 מאפס את היתרה", (await customerBalance.balanceOf(customer)) === 0, r.data?.message);
  check("החשבונית סומנה כמשולמת", (await listInvoices({ customerId: customer })).find((i) => i.docNum === "101")?.isPaid);

  group("תשלום חסר נרשם כחוב");
  r = await pay(c, "102", 400);
  check("חוב של 100", (await customerBalance.balanceOf(customer)) === -100, r.data?.message);
  check("ההודעה אומרת חוב", /יתרת חוב 100/.test(r.data.message), r.data.message);

  group("שומרים");
  r = await pay(c, "102", 100);
  check("תשלום כפול על אותה חשבונית נדחה", r.status === 409);
  r = await pay(c, "103", 0);
  check("0 ₪ בלי יתרה מכסה נדחה", r.status === 400, r.data?.message);
  r = await pay(c, "103", -5);
  check("סכום שלילי נדחה", r.status === 400);
  r = await pay(c, "200", 800);
  check("חשבונית של לקוח אחר נדחית", r.status === 400 && /לא נמצאה/.test(r.data.message), r.data?.message);
  r = await call(controller.createReceiptForPayment, {
    body: { customer: { $ne: null }, amount: 800, method: "transfer", forInvoices: ["103"] },
  });
  check("מזהה לקוח שאינו מחרוזת נדחה", r.status === 400 && /לא תקין/.test(r.data.message), r.data?.message);
  check("שום דבר מאלה לא שינה את היתרה", (await customerBalance.balanceOf(customer)) === -100);
  check("ולא הופקה קבלה", receipts.length === 3, String(receipts.length));

  group("תיקון ידני");
  r = await call(controller.adjustCustomerBalance, { params: { customerId: String(customer) }, body: { delta: 950 } });
  check("בלי סיבה נדחה", r.status === 400);
  r = await call(controller.adjustCustomerBalance, { params: { customerId: String(customer) }, body: { delta: 0, reason: "x" } });
  check("אפס נדחה", r.status === 400);
  r = await call(controller.adjustCustomerBalance, {
    params: { customerId: String(customer) },
    body: { delta: 950, reason: "מקדמה שהתקבלה לפני המערכת" },
  });
  check("זכות 850 אחרי התיקון", r.status === 200 && r.data.balance === 850, JSON.stringify(r.data));

  group("סגירה מהיתרה בלי קבלה");
  const before = receipts.length;
  r = await pay(c, "103", 0);
  check("החשבונית נסגרה", r.status === 200 && r.data.fromBalance === true, JSON.stringify(r.data));
  check("לא הופקה קבלה", receipts.length === before);
  check("נשארו 50", (await customerBalance.balanceOf(customer)) === 50);
  const inv103 = (await listInvoices({ customerId: customer })).find((i) => i.docNum === "103");
  check("מסומנת כמשולמת מהיתרה", inv103?.isPaid && inv103.paidFromBalance && !inv103.receiptDocNum);
  r = await pay(c, "103", 0);
  check("סגירה חוזרת נדחית", r.status === 409);
  check("ולא ירדה פעמיים", (await customerBalance.balanceOf(customer)) === 50);

  group("ביטול חשבונית ששולמה");
  let credit = await monthlyBilling.creditInvoice({ icountDocNum: "100", reason: "בדיקה" });
  check("800 חזרו ליתרה (לא 1,000)", credit.balanceCredited === 800, String(credit.balanceCredited));
  check("יתרה 850", (await customerBalance.balanceOf(customer)) === 850);
  await invoice(c, "104", 423.73);
  icountTotals.set("104", 500);
  credit = await monthlyBilling.creditInvoice({ icountDocNum: "104", reason: "בדיקה" });
  check("ביטול חשבונית שלא שולמה אינו נוגע ביתרה", credit.balanceCredited === 0 && (await customerBalance.balanceOf(customer)) === 850);

  group("iCount לא זמין");
  await invoice(c, "105", 423.73);
  icountDown = true;
  r = await pay(c, "105", 500);
  icountDown = false;
  const last = await CustomerBalanceEntry.findOne({ receiptDocNum: receipts.at(-1).docNum }).lean();
  check("נרשם לפי האומדן", r.status === 200 && last.totalSource === "estimate" && last.delta === 0, JSON.stringify(last));

  group("תצוגה");
  const hist = await call(controller.getCustomerBalance, { params: { customerId: String(customer) } });
  check("ההיסטוריה מחזירה יתרה ותנועות", hist.data.balance === 850 && hist.data.entries.length === 7, `${hist.data.balance} / ${hist.data.entries.length}`);
  check("החדשה ראשונה עם יתרה מצטברת", hist.data.entries[0].balanceAfter === 850 && hist.data.entries.at(-1).balanceAfter === 200);
  const list = await call(controller.getInvoices, { query: { customer: String(customer), status: "" } });
  check("רשימת החשבוניות נושאת את היתרה", list.data.invoices.every((i) => i.customerBalance === 850));
  const rec = await listReceipts({ customerId: customer });
  const overpaid = rec.find((x) => x.amount === 400);
  check("מסך הקבלות מציג את הסכום שהתקבל", overpaid && overpaid.grossEstimate === 500, JSON.stringify(rec.map((x) => [x.amount, x.grossEstimate])));

  group("בידוד מצב הדמו");
  await CustomerBalanceEntry.create({ customer, demo: true, kind: "manual", delta: 9999 });
  check("תנועת דמו אינה נספרת ביתרה האמיתית", (await customerBalance.balanceOf(customer)) === 850);
  check("ונספרת בנפרד", (await customerBalance.balanceOf(customer, { demo: true })) === 9999);

  console.log(`\n${fail ? "❌" : "✅"} ${pass} עברו · ${fail} נכשלו`);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error("❌", err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});

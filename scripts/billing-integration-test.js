// scripts/billing-integration-test.js
//
// בדיקת אינטגרציה של זרימות החיוב, עם iCount מדומה.
//
// למה מדומה: הזרימות האלה מפיקות מסמכי מס אמיתיים שאי אפשר למחוק. כדי
// לבדוק את מסלול ההצלחה — ולא רק את השומרים — מחליפים את שכבת ה-HTTP
// של iCount בפונקציה שמחזירה מספר מסמך מזויף. כל השאר (תפיסה, סימון,
// קיבוץ, שמירת קישורים, רשת הביטחון) רץ באמת מול המסד.
//
//   node scripts/billing-integration-test.js

require("dotenv").config();
const mongoose = require("mongoose");

// ── החלפת iCount לפני שמישהו טוען אותו ──────────────────────────────
const icountDocs = require("../lib/icount/documents");
let issued = [];
let failNext = false;

icountDocs.createInvoice = async ({ customerId, items, description }) => {
  if (failNext) {
    failNext = false;
    throw new Error("iCount מדומה: כשלון מכוון");
  }
  const docNum = `MOCK-${issued.length + 1000}`;
  issued.push({ docNum, customerId: String(customerId), items, description });
  return {
    doctype: "invoice",
    docNum,
    url: `https://mock.icount/${docNum}`,
  };
};

const DeliveryNote = require("../models/DeliveryNote");
const Order = require("../models/Order");
const Customer = require("../models/Customer");
const { createFromOrder } = require("../lib/billing/deliveryNotes");
const { splitByNoteKind } = require("../lib/billing/manualItems");
const { billNoteImmediately, closeMonth, previousMonth } = require("../lib/billing/monthlyBilling");
const { onOrderStatusChange } = require("../lib/billing/autoDeliveryNote");

let pass = 0;
let fail = 0;
const TAG = "INTEGRATION";

const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const group = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`);

const cleanup = async () => {
  await DeliveryNote.deleteMany({ issuedBy: { $regex: TAG } });
  await mongoose.connection.db.collection("app_counters").deleteOne({ _id: "delivery_note" });
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  await cleanup();

  // הזמנה שכולה סחורה נשקלת אינה מפיקה תעודה אוטומטית (createFromOrder
  // מחזיר note=null), ולכן היא אינה מתאימה לבדיקה הזו. מסננים אותן כאן
  // ולא מתגוננים בכל שימוש — שאם לא כן הבדיקה קורסת על null._id
  const candidates = await Order.find({ cart: { $exists: true, $not: { $size: 0 } } })
    .limit(20)
    .lean();

  const orders = [];
  for (const candidate of candidates) {
    const { automatic } = await splitByNoteKind(candidate.cart || []);
    if (automatic.length) orders.push(candidate);
    if (orders.length === 3) break;
  }

  if (orders.length < 2) {
    throw new Error("צריך לפחות 2 הזמנות עם שורות שאינן סחורה נשקלת לבדיקה");
  }

  const customer = await Customer.findById(orders[0].user).select("+erp").lean();
  const originalMode = customer.billing?.mode || "monthly";
  const originalSplit = Boolean(customer.billing?.splitInvoiceByCategory);

  // ─────────────────────────────────────────────────────────────────
  group("חיוב מיידי — מסלול ההצלחה");

  await Customer.updateOne(
    { _id: customer._id },
    { $set: { "billing.mode": "perDelivery", "billing.splitInvoiceByCategory": false } }
  );

  issued = [];
  const { note } = await createFromOrder(orders[0]._id, { issuedBy: TAG });
  const result = await billNoteImmediately(note._id);

  check("החיוב החזיר חשבונית", result?.invoices?.length === 1);
  check("נוצר מסמך אחד ב-iCount", issued.length === 1, `נוצרו ${issued.length}`);

  const afterBill = await DeliveryNote.findById(note._id).lean();
  check("סטטוס התעודה = חויבה", afterBill.billing.status === "billed");
  check("מספר החשבונית נשמר", afterBill.billing.icountDocNum === issued[0].docNum);
  check("הקישור למסמך נשמר", afterBill.billing.icountDocUrl === `https://mock.icount/${issued[0].docNum}`);
  check("תאריך החיוב נשמר", !!afterBill.billing.billedAt);
  check("טוקן התפיסה נוקה", !afterBill.billing.claimToken);
  check(
    "כל שורות התעודה נכנסו לחשבונית",
    issued[0].items.length === afterBill.items.length,
    `${issued[0].items.length} מול ${afterBill.items.length}`
  );
  check(
    'התיאור אומר "משלוח" ולא "חיוב חודש"',
    issued[0].description.startsWith("משלוח") && !issued[0].description.includes("חיוב חודש"),
    issued[0].description.split("\n")[0]
  );

  // ─────────────────────────────────────────────────────────────────
  group("חיוב מיידי — אין חיוב כפול");

  issued = [];
  check("קריאה שנייה לא מפיקה כלום", (await billNoteImmediately(note._id)) === null);
  check("לא נוצר מסמך נוסף", issued.length === 0);

  // ─────────────────────────────────────────────────────────────────
  group("לקוח מיידי אינו נאסף בסגירת חודש");

  await DeliveryNote.updateOne(
    { _id: note._id },
    { $set: { "billing.billingMonth": previousMonth() } }
  );
  const preview = await closeMonth({ month: previousMonth(), dryRun: true, customerId: customer._id });
  const stillOpen = preview.results.some((r) => r.invoices.length > 0);
  check("תעודה שחויבה מיידית לא נכללת בסגירה", !stillOpen);

  // ─────────────────────────────────────────────────────────────────
  group("רשת ביטחון — כשלון בחיוב מיידי");

  issued = [];
  failNext = true;
  const { note: note2 } = await createFromOrder(orders[1]._id, { issuedBy: TAG });
  const failed = await billNoteImmediately(note2._id);

  check("הפונקציה מחזירה null ולא זורקת", failed === null);
  check("לא נוצר מסמך", issued.length === 0);

  const afterFail = await DeliveryNote.findById(note2._id).lean();
  check("התעודה שוחררה למצב פתוח", afterFail.billing.status === "open");
  check("טוקן התפיסה שוחרר", !afterFail.billing.claimToken);

  await DeliveryNote.updateOne(
    { _id: note2._id },
    { $set: { "billing.billingMonth": previousMonth() } }
  );
  const rescue = await closeMonth({ month: previousMonth(), dryRun: true, customerId: customer._id });
  check("סגירת החודש אוספת אותה כרשת ביטחון", rescue.results.some((r) => r.invoices.length > 0));

  // ─────────────────────────────────────────────────────────────────
  group("שינוי סטטוס מפעיל את כל השרשרת");

  issued = [];
  await DeliveryNote.deleteMany({ order: orders[2] ? orders[2]._id : null });
  if (orders[2]) {
    await Customer.updateOne({ _id: orders[2].user }, { $set: { "billing.mode": "perDelivery" } });

    await onOrderStatusChange({
      orderId: orders[2]._id,
      toStatusName: "Delivered",
      changedBy: TAG,
    });
    // ההפעלה מהזרימה האוטומטית אינה ב-await
    await new Promise((r) => setTimeout(r, 2500));

    const auto = await DeliveryNote.findOne({ order: orders[2]._id }).lean();
    check("תעודה נוצרה מהסטטוס", !!auto);
    check("והיא חויבה מיידית", auto?.billing?.status === "billed", `סטטוס: ${auto?.billing?.status}`);
  }

  // ─────────────────────────────────────────────────────────────────
  group("פיצול לפי קטגוריה במסלול המיידי");

  issued = [];
  // mode נקבע שוב במפורש: הזמנות הבדיקה עשויות להשתייך לאותו לקוח,
  // וסעיף קודם יכול היה לשנות אותו
  await Customer.updateOne(
    { _id: customer._id },
    { $set: { "billing.splitInvoiceByCategory": true, "billing.mode": "perDelivery" } }
  );
  await DeliveryNote.updateOne(
    { _id: note2._id },
    {
      $set: {
        "billing.status": "open",
        items: [
          { name: "לחם", sku: "A", quantity: 1, unitPrice: 10, lineTotal: 10, categoryName: "מזון" },
          { name: "דף", sku: "B", quantity: 1, unitPrice: 5, lineTotal: 5, categoryName: "משרד" },
        ],
      },
      $unset: { "billing.icountDocNum": "", "billing.billedAt": "" },
    }
  );
  await billNoteImmediately(note2._id);
  check("משלוח מעורב מפיק חשבונית לכל קטגוריה", issued.length === 2, `הופקו ${issued.length}`);
  check(
    "התיאורים נושאים את שם הקטגוריה",
    issued.every((d) => d.description.includes("משלוח —")),
    issued.map((d) => d.description.split("\n")[0]).join(" | ")
  );

  // ─────────────────────────────────────────────────────────────────
  await Customer.updateOne(
    { _id: customer._id },
    { $set: { "billing.mode": originalMode, "billing.splitInvoiceByCategory": originalSplit } }
  );
  await cleanup();

  console.log(`\n${"═".repeat(58)}`);
  console.log(fail === 0 ? `✅ כל ${pass} הבדיקות עברו` : `${pass} עברו · ${fail} נכשלו`);
  console.log("═".repeat(58));

  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (err) => {
  console.error("\n❌ הבדיקה קרסה:", err.message, "\n", err.stack);
  try { await cleanup(); await mongoose.disconnect(); } catch {}
  process.exit(1);
});

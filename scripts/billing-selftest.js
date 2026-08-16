// scripts/billing-selftest.js
//
// בדיקות התנהגות למערך החיוב. מריצות זרימות אמיתיות מול המסד ומנקות
// אחריהן. אינן מפיקות מסמכים ב-iCount.
//
//   node scripts/billing-selftest.js

require("dotenv").config();
const mongoose = require("mongoose");

const DeliveryNote = require("../models/DeliveryNote");
const Quote = require("../models/Quote");
const Order = require("../models/Order");
const Customer = require("../models/Customer");

const Category = require("../models/Category");
const Product = require("../models/Product");

const { createFromOrder, createManual, billingMonthOf } = require("../lib/billing/deliveryNotes");
const {
  splitByNoteKind,
  manualNoteCategoryIds,
  clearCache: clearManualCache,
} = require("../lib/billing/manualItems");
const { groupIntoInvoices, previousMonth, isLastDayOfMonth, releaseStuckClaims, closeMonth, billNoteImmediately } = require("../lib/billing/monthlyBilling");
const { isDeliveredStatus } = require("../lib/billing/autoDeliveryNote");
const { dueDateFor, forCustomer } = require("../lib/billing/paymentTerms");
const { priceItemsForCustomer, priceQuality } = require("../lib/billing/pricing");
const { listInvoices } = require("../lib/billing/invoices");
const { calculateVat } = require("../lib/billing/vat");

let pass = 0;
let fail = 0;
const TAG = "SELFTEST";

const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const group = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

const cleanup = async () => {
  await DeliveryNote.deleteMany({ issuedBy: TAG });
  await Quote.deleteMany({ createdBy: TAG });
  // הקטגוריות הזמניות של בדיקת הסחורה הנשקלת. חייבות להימחק — קטגוריה
  // מסומנת שנשארה במסד הייתה מוציאה מוצרים מהתעודה האוטומטית בייצור
  await Category.deleteMany({ slug: { $regex: `^${TAG.toLowerCase()}-` } });
  await mongoose.connection.db
    .collection("app_counters")
    .deleteMany({ _id: { $in: ["delivery_note", "quote"] } });
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  await cleanup();

  // ─────────────────────────────────────────────────────────────────
  group("גבולות חודש (שעון ישראל)");

  check("31/07 23:30 שייך ל-2026-07", billingMonthOf(new Date("2026-07-31T20:30:00Z")) === "2026-07");
  check("01/08 00:30 שייך ל-2026-08", billingMonthOf(new Date("2026-07-31T21:30:00Z")) === "2026-08");
  check("previousMonth בינואר חוצה שנה", previousMonth(new Date("2026-01-15T10:00:00Z")) === "2025-12");
  check("previousMonth ב-1 לחודש", previousMonth(new Date("2026-08-01T09:00:00Z")) === "2026-07");

  // ─────────────────────────────────────────────────────────────────
  group("יום הסגירה — היום האחרון של החודש");

  check("31/08 הוא היום האחרון", isLastDayOfMonth(new Date("2026-08-31T09:00:00Z")));
  check("30/08 אינו האחרון", !isLastDayOfMonth(new Date("2026-08-30T09:00:00Z")));
  check("30/04 הוא היום האחרון (חודש בן 30)", isLastDayOfMonth(new Date("2026-04-30T09:00:00Z")));
  check("28/02 בשנה רגילה הוא האחרון", isLastDayOfMonth(new Date("2026-02-28T09:00:00Z")));
  check("28/02 בשנה מעוברת אינו האחרון", !isLastDayOfMonth(new Date("2024-02-28T09:00:00Z")));
  check("29/02 בשנה מעוברת הוא האחרון", isLastDayOfMonth(new Date("2024-02-29T09:00:00Z")));
  check(
    "31/08 23:30 שעון ישראל עדיין האחרון",
    isLastDayOfMonth(new Date("2026-08-31T20:30:00Z")),
    "חישוב לפי UTC היה מזיז את הבדיקה ל-1 בספטמבר"
  );
  check("01/09 00:30 שעון ישראל אינו האחרון", !isLastDayOfMonth(new Date("2026-08-31T21:30:00Z")));

  // ─────────────────────────────────────────────────────────────────
  group("זיהוי סטטוס נמסר");

  check("Delivered מפעיל", isDeliveredStatus("Delivered"));
  check("delivered (אותיות קטנות) מפעיל", isDeliveredStatus("delivered"));
  check("'נמסר' מפעיל", isDeliveredStatus("נמסר"));
  check("רווחים מסביב לא שוברים", isDeliveredStatus("  Delivered  "));
  check("Processing לא מפעיל", !isDeliveredStatus("Processing"));
  check("null לא מפעיל", !isDeliveredStatus(null));
  check("undefined לא מפעיל", !isDeliveredStatus(undefined));
  check("מחרוזת ריקה לא מפעילה", !isDeliveredStatus(""));

  // ─────────────────────────────────────────────────────────────────
  group("פיצול לפי קטגוריה");

  const notes = [
    {
      number: 1,
      billing: { billingMonth: "2026-08" },
      items: [
        { name: "לחם", lineTotal: 10, categoryName: "מזון" },
        { name: "סבון", lineTotal: 20, categoryName: "ניקיון" },
        { name: "תפוח", lineTotal: 5, categoryName: undefined },
      ],
    },
    {
      number: 2,
      billing: { billingMonth: "2026-08" },
      items: [
        { name: "חלב", lineTotal: 8, categoryName: "מזון" },
        { name: "דף", lineTotal: 3, categoryName: "משרד" },
      ],
    },
  ];

  const one = groupIntoInvoices(notes, false);
  const split = groupIntoInvoices(notes, true);
  const sum = (gs) => gs.reduce((s, g) => s + g.items.reduce((a, i) => a + i.lineTotal, 0), 0);

  check("בלי פיצול — חשבונית אחת", one.length === 1);
  check("עם פיצול — 4 קבוצות", split.length === 4, `קיבלתי ${split.length}`);
  check("שורה בלי קטגוריה נופלת ל'כללי'", split.some((g) => g.label === "כללי"));
  check("סכום נשמר בפיצול", sum(one) === sum(split), `${sum(one)} מול ${sum(split)}`);
  check("אף שורה לא אבדה", one[0].items.length === split.reduce((s, g) => s + g.items.length, 0));
  check("תעודה מופיעה בכל קבוצה שיש לה בה שורה", split.find((g) => g.label === "מזון").notes.length === 2);
  check("מערך תעודות ריק לא קורס", groupIntoInvoices([], true).length === 0);

  // ─────────────────────────────────────────────────────────────────
  group("תנאי תשלום — שוטף+N מסוף החודש");

  const c0 = { erp: { paymentTerms: 0, customerNumber: "T" } };
  check("חשבונית 3/1 → 2/3 (ולא 2/2)", dueDateFor(new Date(2026, 0, 3), c0).dueDate.getTime() === new Date(2026, 2, 2).getTime());
  check("חשבונית 31/1 → 2/3", dueDateFor(new Date(2026, 0, 31), c0).dueDate.getTime() === new Date(2026, 2, 2).getTime());
  check("15/12 חוצה שנה → 30/1", dueDateFor(new Date(2025, 11, 15), c0).dueDate.getTime() === new Date(2026, 0, 30).getTime());
  check("פברואר מעוברת נכון", dueDateFor(new Date(2024, 1, 10), c0).dueDate.getTime() === new Date(2024, 2, 30).getTime());
  check("קוד לא מוכר נופל לברירת מחדל", forCustomer({ erp: { paymentTerms: 999 } }).days === 30);
  check("לקוח בלי erp לא קורס", forCustomer({}).days === 30);
  check("לקוח null לא קורס", forCustomer(null).days === 30);

  // ─────────────────────────────────────────────────────────────────
  group("תעודת משלוח — יצירה, idempotency, ביטול");

  const order = await Order.findOne({ cart: { $exists: true, $not: { $size: 0 } } });
  const { note, created } = await createFromOrder(order._id, { issuedBy: TAG });
  check("תעודה נוצרה", created && note.number >= 1000);
  check("סכום התעודה = סכום השורות", Math.abs(note.subTotal - note.items.reduce((s, i) => s + i.lineTotal, 0)) < 0.01);
  check("סטטוס פתוח", note.billing.status === "open");
  check("חודש חיוב נקבע", /^\d{4}-\d{2}$/.test(note.billing.billingMonth));

  const again = await createFromOrder(order._id, { issuedBy: TAG });
  check("הרצה שנייה לא יוצרת כפילות", !again.created && again.note.number === note.number);
  check("יש בדיוק תעודה אחת להזמנה", (await DeliveryNote.countDocuments({ order: order._id })) === 1);

  // ─────────────────────────────────────────────────────────────────
  group("מניעת חיוב כפול");

  const claimA = await DeliveryNote.updateMany(
    { _id: note._id, "billing.status": "open" },
    { $set: { "billing.status": "billing", "billing.claimToken": "A", "billing.claimedAt": new Date() } }
  );
  const claimB = await DeliveryNote.updateMany(
    { _id: note._id, "billing.status": "open" },
    { $set: { "billing.status": "billing", "billing.claimToken": "B" } }
  );
  check("תפיסה ראשונה מצליחה", claimA.modifiedCount === 1);
  check("תפיסה מקבילה נחסמת", claimB.modifiedCount === 0);

  check("שחרור לא נוגע בתפיסה טרייה", (await releaseStuckClaims({ olderThanMinutes: 30 })) === 0);
  check("שחרור משחרר תפיסה ישנה", (await releaseStuckClaims({ olderThanMinutes: 0 })) === 1);
  check("התעודה חזרה לפתוחה", (await DeliveryNote.findById(note._id)).billing.status === "open");

  // ─────────────────────────────────────────────────────────────────
  group("סגירת חודש אוספת גם חודשים קודמים");

  // מדמים תעודה שזוכתה וחזרה לפתוחה בחודש ישן
  await DeliveryNote.updateOne({ _id: note._id }, { $set: { "billing.billingMonth": "2020-01" } });
  const preview = await closeMonth({ month: previousMonth(), dryRun: true, customerId: note.customer });
  const found = preview.results.some((r) => r.invoices.length > 0);
  check("תעודה מחודש ישן נכללת בסגירה", found, "תעודה שזוכתה הייתה נשארת פתוחה לנצח");

  await DeliveryNote.updateOne({ _id: note._id }, { $set: { "billing.billingMonth": billingMonthOf(new Date()) } });

  // ─────────────────────────────────────────────────────────────────
  group("שומרי סגירת חודש");

  const rejects = async (fn) => {
    try {
      await fn();
      return false;
    } catch {
      return true;
    }
  };

  const current = billingMonthOf(new Date());
  check("חודש נוכחי נדחה", await rejects(() => closeMonth({ month: current, dryRun: true })));

  // הסגירה האוטומטית מותרת רק ביום האחרון, ולכן התוצאה הנכונה תלויה
  // בתאריך שבו הבדיקה רצה
  const closingDay = isLastDayOfMonth();
  const currentWithFlag = await rejects(() =>
    closeMonth({ month: current, dryRun: true, allowCurrentMonth: true })
  );
  check(
    closingDay
      ? "ביום האחרון — הסגירה האוטומטית מקבלת את החודש הנוכחי"
      : "לא היום האחרון — allowCurrentMonth לבדו אינו פותח את החודש הנוכחי",
    closingDay ? !currentWithFlag : currentWithFlag
  );
  check(
    "חודש עתידי נדחה גם עם allowCurrentMonth",
    await rejects(() => closeMonth({ month: "2099-01", dryRun: true, allowCurrentMonth: true }))
  );
  check("חודש עתידי נדחה", await rejects(() => closeMonth({ month: "2099-01", dryRun: true })));
  check("פורמט שגוי נדחה", await rejects(() => closeMonth({ month: "2026-13", dryRun: true })));
  check("טקסט חופשי נדחה", await rejects(() => closeMonth({ month: "אוגוסט", dryRun: true })));
  check("חודש קודם מתקבל", !(await rejects(() => closeMonth({ month: previousMonth(), dryRun: true }))));
  check("בלי פרמטר — ברירת מחדל תקינה", !(await rejects(() => closeMonth({ dryRun: true }))));

  // ─────────────────────────────────────────────────────────────────
  group("תמחור");

  const customer = await Customer.findById(note.customer).select("+erp").lean();
  const priced = await priceItemsForCustomer(customer._id, [
    { sku: "85", quantity: 3 },
    { sku: "לא-קיים-בכלל", quantity: 1 },
  ]);
  check("שורה תקינה מתומחרת", priced[0].unitPrice > 0);
  check("סכום שורה = מחיר × כמות", Math.abs(priced[0].lineTotal - priced[0].unitPrice * 3) < 0.01);
  check("מק\"ט לא קיים מסומן", priced[1].unknownProduct === true && priced[1].source === "missing");
  check("איכות התמחור מדווחת חוסר", priceQuality(priced).hasMissing === true);
  check("כמות 0 לא מפילה", (await priceItemsForCustomer(customer._id, [{ sku: "85", quantity: 0 }]))[0].lineTotal === 0);

  // ─────────────────────────────────────────────────────────────────
  group("הצעת מחיר");

  const quotes = require("../lib/billing/quotes");
  const { quote } = await quotes.create({
    customerId: customer._id,
    items: [{ sku: "85", quantity: 2 }],
    validDays: 14,
    createdBy: TAG,
  });
  check("הצעה נוצרה עם מספר", quote.number >= 5000);
  check("אין שדות iCount על ההצעה", !("icountDocNum" in quote.toObject()));
  check("תוקף מחושב", quote.validUntil > new Date());
  check("מקור המחיר נשמר", !!quote.items[0].priceSource);

  let rejected = false;
  await quotes
    .create({ customerId: customer._id, items: [{ sku: "אין-כזה", quantity: 1 }], createdBy: TAG })
    .catch(() => (rejected = true));
  check("הצעה עם מק\"ט לא קיים נדחית", rejected);

  let emptyRejected = false;
  await quotes.create({ customerId: customer._id, items: [], createdBy: TAG }).catch(() => (emptyRejected = true));
  check("הצעה ריקה נדחית", emptyRejected);

  // ─────────────────────────────────────────────────────────────────
  group("רשימת חשבוניות וגבייה");

  const DAY = 86400000;
  // תעודה שחויבה לפני חודשיים ולא שולמה → אמורה להיות באיחור
  await DeliveryNote.updateOne(
    { _id: note._id },
    {
      $set: {
        "billing.status": "billed",
        "billing.icountDocNum": "TEST-INV-1",
        "billing.billedAt": new Date(Date.now() - 90 * DAY),
      },
      $unset: { "billing.paidAt": "", "billing.receiptDocNum": "" },
    }
  );

  const all = await listInvoices({ customerId: note.customer });
  const inv = all.find((i) => i.docNum === "TEST-INV-1");
  check("החשבונית מופיעה ברשימה", !!inv);
  check("סכום = סכום התעודות", Math.abs(inv.netTotal - note.total) < 0.01);
  check("ברוטו = נטו × 1.18", Math.abs(inv.grossEstimate - note.total * 1.18) < 0.02);
  check("מועד פירעון חושב", !!inv.dueDate);
  check("מסומנת כלא שולמה", inv.isPaid === false);
  check("מסומנת כבאיחור", inv.isOverdue === true);
  check("ימי איחור חיוביים", inv.daysLate > 0);
  check("מספרי התעודות מצורפים", inv.notes.includes(note.number));

  check("סינון unpaid כולל אותה", (await listInvoices({ customerId: note.customer, status: "unpaid" })).some((i) => i.docNum === "TEST-INV-1"));
  check("סינון overdue כולל אותה", (await listInvoices({ customerId: note.customer, status: "overdue" })).some((i) => i.docNum === "TEST-INV-1"));
  check("סינון paid לא כולל אותה", !(await listInvoices({ customerId: note.customer, status: "paid" })).some((i) => i.docNum === "TEST-INV-1"));

  // אחרי רישום תשלום
  await DeliveryNote.updateOne(
    { _id: note._id },
    { $set: { "billing.paidAt": new Date(), "billing.receiptDocNum": "TEST-RCPT-1" } }
  );
  const afterPay = (await listInvoices({ customerId: note.customer })).find((i) => i.docNum === "TEST-INV-1");
  check("אחרי תשלום — מסומנת כשולמה", afterPay.isPaid === true);
  check("אחרי תשלום — לא באיחור", afterPay.isOverdue === false);
  check("אחרי תשלום — מספר הקבלה נשמר", afterPay.receiptDocNum === "TEST-RCPT-1");
  check("סינון paid כולל אותה", (await listInvoices({ customerId: note.customer, status: "paid" })).some((i) => i.docNum === "TEST-INV-1"));
  check("סינון overdue כבר לא כולל אותה", !(await listInvoices({ customerId: note.customer, status: "overdue" })).some((i) => i.docNum === "TEST-INV-1"));

  check("חשבונית בלי docNum לא נספרת", !(await listInvoices({ customerId: note.customer })).some((i) => !i.docNum));

  // ── מע"מ על שורות פטורות ──
  // תעודה של 1000 נטו שחציה פטורה שווה 1090, לא 1180. הפער הזה זרם
  // ישירות לשדה הסכום בדיאלוג התשלום.
  await DeliveryNote.updateOne(
    { _id: note._id },
    {
      $set: {
        subTotal: 1000,
        total: 1000,
        shippingCost: 0,
        discount: 0,
        items: [
          { name: "חייב", sku: "A", quantity: 1, unitPrice: 500, lineTotal: 500, isVatFree: false },
          { name: "פטור", sku: "B", quantity: 1, unitPrice: 500, lineTotal: 500, isVatFree: true },
        ],
      },
      $unset: { "billing.paidAt": "", "billing.receiptDocNum": "" },
    }
  );
  const mixed = (await listInvoices({ customerId: note.customer })).find((i) => i.docNum === "TEST-INV-1");
  check("ברוטו מכבד שורות פטורות (1090 ולא 1180)", Math.abs(mixed.grossEstimate - 1090) < 0.01, `קיבלתי ${mixed.grossEstimate}`);

  // הכל חייב → 1180
  await DeliveryNote.updateOne(
    { _id: note._id },
    { $set: { "items.1.isVatFree": false } }
  );
  const allTaxable = (await listInvoices({ customerId: note.customer })).find((i) => i.docNum === "TEST-INV-1");
  check("הכל חייב → 1180", Math.abs(allTaxable.grossEstimate - 1180) < 0.01, `קיבלתי ${allTaxable.grossEstimate}`);

  // הכל פטור → 1000
  await DeliveryNote.updateOne(
    { _id: note._id },
    { $set: { "items.0.isVatFree": true, "items.1.isVatFree": true } }
  );
  const allExempt = (await listInvoices({ customerId: note.customer })).find((i) => i.docNum === "TEST-INV-1");
  check("הכל פטור → 1000", Math.abs(allExempt.grossEstimate - 1000) < 0.01, `קיבלתי ${allExempt.grossEstimate}`);

  // משלוח חייב במע"מ גם כשהפריטים פטורים
  await DeliveryNote.updateOne({ _id: note._id }, { $set: { shippingCost: 100, total: 1100 } });
  const withShip = (await listInvoices({ customerId: note.customer })).find((i) => i.docNum === "TEST-INV-1");
  check("משלוח חייב במע\"מ (1000 + 118)", Math.abs(withShip.grossEstimate - 1118) < 0.01, `קיבלתי ${withShip.grossEstimate}`);

  // תעודה בלי שורות לא מחזירה 0
  await DeliveryNote.updateOne({ _id: note._id }, { $set: { items: [], shippingCost: 0, total: 1000 } });
  const noItems = (await listInvoices({ customerId: note.customer })).find((i) => i.docNum === "TEST-INV-1");
  check("תעודה בלי שורות נופלת לאומדן גס ולא ל-0", noItems.grossEstimate > 0);

  // ─────────────────────────────────────────────────────────────────
  group("מסלול חיוב מיידי (perDelivery)");

  // הפונקציה בודקת בעצמה את מצב הלקוח; לקוח רגיל לא אמור להיות מחויב
  await DeliveryNote.updateOne(
    { _id: note._id },
    { $set: { "billing.status": "open" }, $unset: { "billing.icountDocNum": "", "billing.billedAt": "", "billing.paidAt": "", "billing.receiptDocNum": "" } }
  );
  await Customer.updateOne({ _id: note.customer }, { $set: { "billing.mode": "monthly" } });
  check("לקוח חודשי לא מחויב מיידית", (await billNoteImmediately(note._id)) === null);
  check("התעודה נשארה פתוחה", (await DeliveryNote.findById(note._id)).billing.status === "open");

  // תעודה שכבר חויבה לא תחויב שוב גם אם הלקוח perDelivery
  await Customer.updateOne({ _id: note.customer }, { $set: { "billing.mode": "perDelivery" } });
  await DeliveryNote.updateOne({ _id: note._id }, { $set: { "billing.status": "billed" } });
  check("תעודה שכבר חויבה לא מחויבת שוב", (await billNoteImmediately(note._id)) === null);

  // תעודה תפוסה על ידי סגירת חודש מקבילה
  await DeliveryNote.updateOne({ _id: note._id }, { $set: { "billing.status": "billing" } });
  check("תעודה תפוסה לא מחויבת", (await billNoteImmediately(note._id)) === null);

  check("תעודה שלא קיימת מחזירה null", (await billNoteImmediately("6a6b224747daff9a26037155")) === null);

  await DeliveryNote.updateOne({ _id: note._id }, { $set: { "billing.status": "open" } });
  await Customer.updateOne({ _id: note.customer }, { $set: { "billing.mode": "monthly" } });

  // ─────────────────────────────────────────────────────────────────
  group("שמירת קישורים והיסטוריית זיכויים");

  await DeliveryNote.updateOne(
    { _id: note._id },
    {
      $set: {
        "billing.status": "billed",
        "billing.icountDocNum": "TEST-INV-2",
        "billing.icountDocUrl": "https://app.icount.co.il/doc/INV2",
        "billing.receiptDocNum": "TEST-RCPT-2",
        "billing.receiptDocUrl": "https://app.icount.co.il/doc/RCPT2",
        "billing.paidAt": new Date(),
        "billing.billedAt": new Date(),
        "billing.credits": [
          { creditDocNum: "TEST-CR-1", creditDocUrl: "https://app.icount.co.il/doc/CR1", originalDocNum: "TEST-INV-2", reason: "בדיקה", creditedAt: new Date() },
          { creditDocNum: "TEST-CR-OTHER", originalDocNum: "אחרת", reason: "לא קשור", creditedAt: new Date() },
        ],
      },
    }
  );

  const linked = (await listInvoices({ customerId: note.customer })).find((i) => i.docNum === "TEST-INV-2");
  check("קישור לחשבונית נשמר ומוחזר", linked.icountDocUrl === "https://app.icount.co.il/doc/INV2");
  check("קישור לקבלה נשמר ומוחזר", linked.receiptDocUrl === "https://app.icount.co.il/doc/RCPT2");
  check("זיכוי של החשבונית מוחזר", linked.credits.some((c) => c.creditDocNum === "TEST-CR-1"));
  check("זיכוי של חשבונית אחרת מסונן", !linked.credits.some((c) => c.creditDocNum === "TEST-CR-OTHER"));
  check("קישור הזיכוי נשמר", linked.credits.find((c) => c.creditDocNum === "TEST-CR-1").creditDocUrl === "https://app.icount.co.il/doc/CR1");

  // אותו זיכוי על שתי תעודות של אותה חשבונית — לא נספר פעמיים
  const second = await createFromOrder(
    (await Order.findOne({ _id: { $ne: order._id }, cart: { $exists: true, $not: { $size: 0 } } }))._id,
    { issuedBy: TAG }
  );
  await DeliveryNote.updateOne(
    { _id: second.note._id },
    {
      $set: {
        customer: note.customer,
        "billing.status": "billed",
        "billing.icountDocNum": "TEST-INV-2",
        "billing.billedAt": new Date(),
        "billing.credits": [
          { creditDocNum: "TEST-CR-1", originalDocNum: "TEST-INV-2", reason: "בדיקה", creditedAt: new Date() },
        ],
      },
    }
  );
  const deduped = (await listInvoices({ customerId: note.customer })).find((i) => i.docNum === "TEST-INV-2");
  check("זיכוי משותף לשתי תעודות נספר פעם אחת", deduped.credits.filter((c) => c.creditDocNum === "TEST-CR-1").length === 1);

  // ─────────────────────────────────────────────────────────────────
  group("חישוב מע\"מ — מקור אחד");

  const vat = (doc) => calculateVat(doc).total;
  check("חצי חייב חצי פטור → 1090", vat({ subTotal: 1000, items: [{ lineTotal: 500 }, { lineTotal: 500, isVatFree: true }] }) === 1090);
  check("הכל חייב → 1180", vat({ subTotal: 1000, items: [{ lineTotal: 1000 }] }) === 1180);
  check("הכל פטור → 1000", vat({ subTotal: 1000, items: [{ lineTotal: 1000, isVatFree: true }] }) === 1000);
  check("משלוח חייב גם על פטור → 1118", vat({ subTotal: 1000, shippingCost: 100, items: [{ lineTotal: 1000, isVatFree: true }] }) === 1118);
  check("הנחה מתחלקת יחסית → 981", vat({ subTotal: 1000, discount: 100, items: [{ lineTotal: 500 }, { lineTotal: 500, isVatFree: true }] }) === 981);
  check("בלי שורות → אומדן גס", vat({ subTotal: 1000, items: [] }) === 1180);
  check("מסמך ריק → 0 ולא NaN", vat({}) === 0);
  check("items שאינו מערך לא מפיל", Number.isFinite(vat({ subTotal: 100, items: null })));
  check("הנחה גדולה מהסכום לא נותנת שלילי", calculateVat({ subTotal: 100, discount: 500, items: [{ lineTotal: 100 }] }).total >= 0);

  const full = calculateVat({ subTotal: 1000, items: [{ lineTotal: 500 }, { lineTotal: 500, isVatFree: true }] });
  check("חייב + פטור + מע\"מ = סה\"כ", Math.abs(full.taxableBase + full.exemptBase + full.vat - full.total) < 0.01);

  // ─────────────────────────────────────────────────────────────────
  group("הפרדת סחורה נשקלת מהתעודה האוטומטית");

  // קטגוריה זמנית מסומנת + בת שלה, כדי לבדוק גם את הירושה. שתיהן
  // נמחקות ב-cleanup לפי ה-slug
  const parentCat = await Category.create({
    name: { he: `${TAG} נשקל` },
    slug: `${TAG.toLowerCase()}-weighed`,
    requiresManualNote: true,
  });
  const childCat = await Category.create({
    name: { he: `${TAG} נשקל בן` },
    slug: `${TAG.toLowerCase()}-weighed-child`,
    parentId: String(parentCat._id),
  });
  const plainCat = await Category.create({
    name: { he: `${TAG} רגיל` },
    slug: `${TAG.toLowerCase()}-plain`,
  });

  clearManualCache();
  const manualIds = await manualNoteCategoryIds({ force: true });
  check("הקטגוריה המסומנת מזוהה", manualIds.has(String(parentCat._id)));
  check("קטגוריית הבת יורשת את הסימון", manualIds.has(String(childCat._id)));
  check("קטגוריה רגילה אינה מזוהה", !manualIds.has(String(plainCat._id)));

  const kindSplit = await splitByNoteKind([
    { sku: "A", quantity: 1, category: plainCat._id },
    { sku: "B", quantity: 2, category: parentCat._id },
    { sku: "C", quantity: 3, category: childCat._id },
    { sku: "D", quantity: 4, categories: [plainCat._id, parentCat._id] },
  ]);

  check(
    "שורה רגילה נשארת בתעודה האוטומטית",
    kindSplit.automatic.length === 1 && kindSplit.automatic[0].sku === "A"
  );
  check("שורה נשקלת יורדת מהאוטומטית", kindSplit.manual.some((i) => i.sku === "B"));
  check("שורה בקטגוריית בת יורדת גם היא", kindSplit.manual.some((i) => i.sku === "C"));
  check(
    "שיוך משני לקטגוריה נשקלת מספיק",
    kindSplit.manual.some((i) => i.sku === "D"),
    "מוצר ששויך גם ל'מבצעים' וגם לירקות חייב להיספר כירק"
  );
  check("אף שורה לא אבדה בפיצול", kindSplit.automatic.length + kindSplit.manual.length === 4);

  // ─────────────────────────────────────────────────────────────────
  group("תעודת משלוח ידנית — המשקל שנשקל בפועל");

  // מוצרים אמיתיים מהקטלוג: createManual מתמחר דרך pricing ודורש מק"ט קיים
  const priceable = await Product.find({ sku: { $exists: true, $ne: null }, "prices.price": { $gt: 0 } })
    .select("sku")
    .limit(2)
    .lean();

  if (priceable.length < 2) {
    check("דילוג — אין שני מוצרים מתומחרים בקטלוג", true);
  } else {
    const manualCustomer = await Customer.findById(order.user).lean();
    const key = `${TAG}-${Date.now()}`;

    const manual = await createManual({
      customerId: manualCustomer._id,
      items: [
        { sku: priceable[0].sku, quantity: 2.5 },
        { sku: priceable[1].sku, quantity: 1.25, unitPrice: 8 },
      ],
      manualReference: "פנקס 77",
      // חודש שכבר הסתיים: closeMonth חוסם סגירה של החודש הרץ, ובלי זה
      // הבדיקה המרכזית כאן לא הייתה יכולה לרוץ בכלל
      issuedAt: "2026-07-14",
      issuedBy: TAG,
      idempotencyKey: key,
    });

    check("תעודה ידנית נוצרה", manual.created && manual.note.number >= 1000);
    check("מסומנת kind=manual", manual.note.kind === "manual");
    check("אינה קשורה להזמנה", !manual.note.order);
    check("מספר הפנקס נשמר", manual.note.manualReference === "פנקס 77");
    check(
      "המשקל שהוזן הוא הכמות בתעודה",
      manual.note.items[0].quantity === 2.5,
      `קיבלתי ${manual.note.items[0].quantity}`
    );
    check("מחיר ידני גובר על המחירון", manual.note.items[1].unitPrice === 8);
    check("סכום השורה לפי המשקל שנשקל", Math.abs(manual.note.items[1].lineTotal - 10) < 0.01);
    check(
      "חודש החיוב נגזר מתאריך המסירה",
      manual.note.billing.billingMonth === "2026-07",
      `קיבלתי ${manual.note.billing.billingMonth}`
    );
    check("סטטוס פתוח — תיאסף בסגירת החודש", manual.note.billing.status === "open");

    const dupe = await createManual({
      customerId: manualCustomer._id,
      items: [{ sku: priceable[0].sku, quantity: 99 }],
      issuedBy: TAG,
      idempotencyKey: key,
    });
    check(
      "שליחה כפולה לא מפיקה תעודה שנייה",
      !dupe.created && String(dupe.note._id) === String(manual.note._id),
      "בלי זה לחיצה כפולה = חיוב כפול בסוף החודש"
    );
    check(
      "יש תעודה ידנית אחת בלבד למפתח",
      (await DeliveryNote.countDocuments({ idempotencyKey: key })) === 1
    );

    // הבדיקה המרכזית: המשקל הידני הוא זה שמגיע לחשבונית
    // ── ולידציות ──
    const rejects = async (label, patch, detail) => {
      try {
        await createManual({
          customerId: manualCustomer._id,
          items: [{ sku: priceable[0].sku, quantity: 1 }],
          issuedBy: TAG,
          ...patch,
        });
        check(label, false, "לא נזרקה שגיאה");
      } catch (err) {
        check(label, true, detail);
      }
    };

    const tomorrow = new Date(Date.now() + 36 * 60 * 60 * 1000)
      .toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });

    await rejects("תאריך עתידי נדחה", { issuedAt: tomorrow });
    await rejects("דמי משלוח שליליים נדחים", { shippingCost: -5 });
    await rejects("הנחה שלילית נדחית", { discount: -5 });
    await rejects("הנחה גדולה מהסכום נדחית", { discount: 999999 });
    await rejects("כמות אפס נדחית", { items: [{ sku: priceable[0].sku, quantity: 0 }] });
    await rejects("כמות שאינה מספר נדחית", { items: [{ sku: priceable[0].sku, quantity: "abc" }] });
    await rejects('מק"ט שאינו בקטלוג נדחה', { items: [{ sku: "___NO_SUCH_SKU___", quantity: 1 }] });

    // התעודה שנוצרה בהצלחה קודם היא היחידה שנשארה — הוולידציות לא יצרו כלום
    check(
      "בקשה שנדחתה לא יוצרת תעודה",
      (await DeliveryNote.countDocuments({ issuedBy: TAG, kind: "manual" })) === 1
    );

    // ── חסימת מק"ט שכבר הוקלד לאותה הזמנה ──
    const orderNote = await createManual({
      orderId: order._id,
      items: [{ sku: priceable[0].sku, quantity: 3 }],
      issuedBy: TAG,
    });
    check("תעודה ידנית מקושרת להזמנה נוצרה", orderNote.created);
    check("הקישור להזמנה נשמר", String(orderNote.note.order) === String(order._id));

    let blocked = false;
    try {
      await createManual({
        orderId: order._id,
        items: [{ sku: priceable[0].sku, quantity: 4 }],
        issuedBy: TAG,
      });
    } catch {
      blocked = true;
    }
    check(
      'מק"ט שכבר הוקלד לאותה הזמנה נחסם',
      blocked,
      "בלי זה שני אנשים שמקלידים את אותה שקילה גורמים לחיוב כפול"
    );

    // אותו מק"ט בתעודה עצמאית (בלי קישור להזמנה) עדיין מותר — משלוח מפוצל
    const standalone = await createManual({
      customerId: manualCustomer._id,
      items: [{ sku: priceable[0].sku, quantity: 4 }],
      issuedBy: TAG,
    });
    check("אותו מק\"ט בתעודה עצמאית מותר", standalone.created);

    // ── הקישור למוצר תקין ──
    const linked = await require("../models/Product").findById(manual.note.items[0].productId).lean();
    check(
      "productId על שורת התעודה מצביע על מוצר קיים",
      Boolean(linked),
      "Product.productId אינו ה-_id של המוצר"
    );

    const autoLinked = await require("../models/Product")
      .findById(note.items[0].productId)
      .lean();
    check(
      "productId על תעודה אוטומטית מצביע על מוצר קיים",
      Boolean(autoLinked),
      "line.productId בעגלה הוא מזהה מהתבנית ולא ה-_id"
    );

    const preview = await closeMonth({
      month: "2026-07",
      dryRun: true,
      customerId: manualCustomer._id,
    });
    const previewed = preview.results.reduce(
      (s, r) => s + r.invoices.reduce((a, i) => a + i.netTotal, 0),
      0
    );
    check(
      "התעודה הידנית נכנסת לחישוב החשבונית החודשית",
      previewed >= manual.note.total - 0.01,
      `תצוגה מקדימה ${previewed} מול תעודה ${manual.note.total}`
    );

    await DeliveryNote.deleteMany({ _id: manual.note._id });
  }

  // ─────────────────────────────────────────────────────────────────
  await cleanup();
  console.log(`\n${"═".repeat(60)}`);
  console.log(fail === 0 ? `✅ כל ${pass} הבדיקות עברו` : `${pass} עברו · ${fail} נכשלו`);
  console.log("═".repeat(60));

  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (err) => {
  console.error("\n❌ הבדיקה קרסה:", err.message);
  console.error(err.stack);
  try {
    await cleanup();
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});

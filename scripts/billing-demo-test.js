// scripts/billing-demo-test.js
//
// בדיקה שמצב הדמו באמת מבודד.
//
// התכונה שנבדקת כאן היא היחידה שמצדיקה את כל המנגנון: סגירת חודש בדמו
// מפיקה מסמכים, אבל **לא נוגעת במסד**. תעודת משלוח חייבת לצאת מהריצה
// בדיוק כפי שנכנסה — "open", בלי מספר חשבונית ובלי תאריך חיוב — אחרת
// היא לא תחויב לעולם בחשבונית האמיתית.
//
//   node scripts/billing-demo-test.js
//
// המצב נקבע כאן, לפני כל require, כי lib/icount/mode קורא את המשתנה
// בטעינה. iCount עצמו מוחלף בפונקציה מדומה — הבדיקה אינה מפיקה מסמכים
// גם לא בחשבון הדמו.

process.env.ICOUNT_MODE = "demo";
process.env.ICOUNT_DEMO_CID = process.env.ICOUNT_DEMO_CID || "demo-test";
process.env.ICOUNT_DEMO_USER = process.env.ICOUNT_DEMO_USER || "demo-test";
process.env.ICOUNT_DEMO_PASS = process.env.ICOUNT_DEMO_PASS || "demo-test";

require("dotenv").config();
process.env.ICOUNT_MODE = "demo"; // dotenv לא דורס ערך קיים, אבל לא סומכים על זה

const mongoose = require("mongoose");

const icountDocs = require("../lib/icount/documents");
let issued = [];
icountDocs.createInvoice = async ({ customerId, items, description }) => {
  const docNum = `DEMO-${issued.length + 5000}`;
  issued.push({ docNum, customerId: String(customerId), items, description });
  return { doctype: "invoice", docNum, url: `https://mock.icount/${docNum}`, emailedTo: null };
};
icountDocs.createReceipt = async () => ({
  doctype: "receipt", docNum: "DEMO-RCPT-1", url: "https://mock.icount/rcpt", emailedTo: null,
});
icountDocs.createCreditNote = async () => ({
  doctype: "refund", docNum: "DEMO-CRDT-1", url: "https://mock.icount/crdt", emailedTo: null,
});

const { isDemoMode } = require("../lib/icount/mode");
const DeliveryNote = require("../models/DeliveryNote");
const Order = require("../models/Order");
const Customer = require("../models/Customer");
const { createFromOrder } = require("../lib/billing/deliveryNotes");
const { splitByNoteKind } = require("../lib/billing/manualItems");
const { closeMonth, previousMonth, creditInvoice, releaseStuckClaims } =
  require("../lib/billing/monthlyBilling");
const { reissueInvoice } = require("../lib/billing/reissue");
const { listInvoices } = require("../lib/billing/invoices");
const { listReceipts } = require("../lib/billing/receipts");
const { createReceipt } = require("../lib/icount/documents");
const ledger = require("../lib/billing/ledger");

// רישום תשלום, כפי שהבקר עושה אותו — אותם שדות, דרך אותו ledger
const createReceiptForDemo = async ({ customer, invoices }) => {
  const doc = await createReceipt({
    customerId: customer,
    amount: 100,
    method: "transfer",
    forInvoices: invoices,
  });
  await DeliveryNote.updateMany(
    { customer, [ledger.f("icountDocNum")]: { $in: invoices }, [ledger.f("status")]: "billed" },
    {
      $set: {
        [ledger.f("receiptDocNum")]: doc.docNum,
        [ledger.f("receiptDocUrl")]: doc.url || null,
        [ledger.f("paidAt")]: new Date(),
      },
    }
  );
  return doc;
};

let pass = 0;
let fail = 0;
const TAG = "DEMO-TEST";

const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const group = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`);

const rejects = async (fn) => {
  try { await fn(); return false; } catch { return true; }
};

const cleanup = async () => {
  await DeliveryNote.deleteMany({ issuedBy: { $regex: TAG } });
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  await cleanup();

  group("המצב נקרא נכון");
  check("isDemoMode() = true", isDemoMode() === true);

  // הזמנה עם שורות שאינן סחורה נשקלת — רק היא מפיקה תעודה אוטומטית
  const candidates = await Order.find({ cart: { $exists: true, $not: { $size: 0 } } })
    .limit(20)
    .lean();

  let order = null;
  for (const candidate of candidates) {
    const { automatic } = await splitByNoteKind(candidate.cart || []);
    if (automatic.length) { order = candidate; break; }
  }
  if (!order) throw new Error("לא נמצאה הזמנה עם שורות שאינן סחורה נשקלת");

  const customer = await Customer.findById(order.user).select("+erp").lean();
  const originalMode = customer.billing?.mode || "monthly";

  await Customer.updateOne(
    { _id: customer._id },
    { $set: { "billing.mode": "monthly", "billing.splitInvoiceByCategory": false } }
  );

  const { note } = await createFromOrder(order._id, { issuedBy: TAG });
  const month = previousMonth();
  await DeliveryNote.updateOne({ _id: note._id }, { $set: { "billing.billingMonth": month } });

  // ─────────────────────────────────────────────────────────────────
  group("סגירת חודש בדמו — נרשמת בכיס הדמו בלבד");

  issued = [];
  const result = await closeMonth({ month, customerId: customer._id });

  check("התוצאה מסומנת כדמו", result.demo === true);
  check("הופקה חשבונית", result.invoicesCreated >= 1, `${result.invoicesCreated}`);
  check("נוצר מסמך ב-iCount", issued.length >= 1, `${issued.length}`);
  // ⚠️ הבדיקה הזאת הושוותה פעם ל-note.items.length בלבד, והיא נכשלה על
  //    התנהגות תקינה משתי סיבות: סגירת חודש סוגרת את *כל* התעודות
  //    הפתוחות של הלקוח ולא רק את זו שהבדיקה יצרה, ולקוח עם ריכוז שורות
  //    מקבל שורה לקטגוריה ולא שורה למוצר. שתיהן תלויות במה שיש במסד
  //    באותו רגע. מה שנכון בכל מצב הוא הסכום ומקור השורות, וזה מה שנבדק.
  const money2 = (n) => Number((Number(n) || 0).toFixed(2));
  const sumOf = (rows) => money2(rows.reduce((s, i) => s + (Number(i.lineTotal) || 0), 0));

  const closedNotes = await DeliveryNote.find({
    "billing.demo.icountDocNum": issued[0].docNum,
  }).lean();

  // שורת המשלוח מתווספת לחשבונית מעבר לשורות התעודות; ההנחה יורדת בשדה
  // נפרד ולא כשורה, ולכן אינה נכנסת לחישוב הזה
  const notesSum = money2(
    closedNotes.reduce(
      (s, n) => s + n.items.reduce((a, i) => a + (Number(i.lineTotal) || 0), 0) + (Number(n.shippingCost) || 0),
      0
    )
  );

  check(
    "החשבונית נסגרה על התעודה שנוצרה",
    closedNotes.some((n) => String(n._id) === String(note._id)),
    `${closedNotes.length} תעודות`
  );
  check(
    "סכום שורות החשבונית = סכום שורות התעודות שנסגרו",
    sumOf(issued[0].items) === notesSum,
    `${sumOf(issued[0].items)} מול ${notesSum}`
  );

  const after = await DeliveryNote.findById(note._id).lean();
  const demoNum = after.billing.demo?.icountDocNum;

  check("הרישום האמיתי לא נגע — status עדיין open", after.billing.status === "open", after.billing.status);
  check("הרישום האמיתי לא נגע — אין מספר חשבונית", !after.billing.icountDocNum);
  check("הרישום האמיתי לא נגע — אין תאריך חיוב", !after.billing.billedAt);
  check("כיס הדמו סומן billed", after.billing.demo?.status === "billed", after.billing.demo?.status);
  check("מספר החשבונית נשמר בכיס הדמו", demoNum === issued[0].docNum, `${demoNum}`);
  check("תאריך החיוב נשמר בכיס הדמו", !!after.billing.demo?.billedAt);
  check("טוקן התפיסה נוקה", !after.billing.demo?.claimToken);

  // ─────────────────────────────────────────────────────────────────
  group("אין חיוב כפול — גם בדמו");

  issued = [];
  const second = await closeMonth({ month, customerId: customer._id });
  check("הרצה שנייה לא מפיקה שוב", second.invoicesCreated === 0, `${second.invoicesCreated}`);
  check("ולא נוצר מסמך נוסף", issued.length === 0, `${issued.length}`);

  // ─────────────────────────────────────────────────────────────────
  group("המסכים רואים את מצב הדמו");

  const invoices = await listInvoices({ customerId: customer._id });
  const shown = invoices.find((i) => i.docNum === demoNum);
  check("החשבונית מופיעה במסך החשבוניות", !!shown);
  check("היא מסומנת כלא משולמת", shown && !shown.paidAt);

  // ─────────────────────────────────────────────────────────────────
  group("רישום תשלום וקבלה");

  const receipt = await createReceiptForDemo({
    customer: customer._id,
    invoices: [demoNum],
  });
  check("הופקה קבלה", !!receipt.docNum, `${receipt.docNum}`);

  const paid = await DeliveryNote.findById(note._id).lean();
  check("התשלום נרשם בכיס הדמו", !!paid.billing.demo?.paidAt);
  check("מספר הקבלה נשמר בכיס הדמו", paid.billing.demo?.receiptDocNum === receipt.docNum);
  check("הרישום האמיתי עדיין נקי מתשלום", !paid.billing.paidAt && !paid.billing.receiptDocNum);

  const receipts = await listReceipts({ customerId: customer._id });
  check("הקבלה מופיעה במסך הקבלות", receipts.some((r) => r.docNum === receipt.docNum));

  const afterPay = await listInvoices({ customerId: customer._id });
  check(
    "החשבונית מסומנת כשולמה",
    afterPay.find((i) => i.docNum === demoNum)?.paidAt != null
  );

  // ─────────────────────────────────────────────────────────────────
  // הזיכוי והחשבונית החדשה נרשמים בכיס הדמו, אבל deliveryNotes.update
  // ו-cancel כותבים לתעודה עצמה ולא לכיס. תעודה שנראית בדמו כמחויבת היא
  // תעודה פתוחה של לקוח אמיתי, ולכן תיקון תוכן בדמו חסום.
  group("תיקון חשבונית — עריכת תעודה חסומה בדמו");

  issued = [];
  try {
    await reissueInvoice({
      icountDocNum: demoNum,
      reason: "בדיקה",
      allowPaid: true,
      edits: [{ noteId: String(note._id), discount: 1 }],
    });
    check("עריכת תעודה בדמו נחסמת", false, "לא נזרקה שגיאה");
  } catch (err) {
    check("עריכת תעודה בדמו נחסמת", /מצב הדגמה/.test(err.message), err.message);
  }

  const guarded = await DeliveryNote.findById(note._id).lean();
  check("התעודה לא נערכה", !guarded.manuallyEdited);
  check("והיא עדיין מחויבת בכיס הדמו", guarded.billing.demo?.status === "billed");
  check("ולא הופק שום מסמך", issued.length === 0, `${issued.length}`);

  // ─────────────────────────────────────────────────────────────────
  group("זיכוי מחזיר את התעודה לחיוב — בכיס הדמו");

  issued = [];
  await creditInvoice({ icountDocNum: demoNum, reason: "בדיקה" });

  const credited = await DeliveryNote.findById(note._id).lean();
  check("כיס הדמו חזר ל-open", credited.billing.demo?.status === "open", credited.billing.demo?.status);
  check("מספר החשבונית נוקה מכיס הדמו", !credited.billing.demo?.icountDocNum);
  check("הזיכוי נרשם בהיסטוריית הדמו", (credited.billing.demo?.credits || []).length === 1);
  check("היסטוריית הזיכויים האמיתית ריקה", (credited.billing.credits || []).length === 0);
  check("הרישום האמיתי עדיין open", credited.billing.status === "open");

  // ─────────────────────────────────────────────────────────────────
  // כל הבדיקות בקבוצה הזאת נכתבו אחרי סקירת קוד שמצאה אותן שבורות
  group("תעודה שהדמו לא נגע בה");

  const untouched = await DeliveryNote.findById(note._id).lean();
  await DeliveryNote.updateOne({ _id: note._id }, { $unset: { "billing.demo": "" } });

  // תעודה בלי היסטוריית דמו מוצגת כפי שהיא באמת, ולא כ-"open" מומצא
  const asReal = await DeliveryNote.findById(note._id).lean();
  await DeliveryNote.updateOne(
    { _id: note._id },
    { $set: { "billing.status": "billed", "billing.icountDocNum": "REAL-1" } }
  );
  const reallyBilled = ledger.normalize(await DeliveryNote.findById(note._id).lean());
  check(
    "תעודה שחויבה באמת אינה מוצגת כפתוחה",
    reallyBilled.billing.status === "billed" && reallyBilled.billing.icountDocNum === "REAL-1",
    `${reallyBilled.billing.status}/${reallyBilled.billing.icountDocNum}`
  );
  check(
    "והיא אינה נאספת לחיוב בדמו",
    (await DeliveryNote.countDocuments({ _id: note._id, ...ledger.openQuery() })) === 0
  );

  // "פתוחה" בדמו חייב לכלול תעודה שאין לה כיס דמו כלל
  await DeliveryNote.updateOne(
    { _id: note._id },
    { $set: { "billing.status": "open" }, $unset: { "billing.icountDocNum": "" } }
  );
  check(
    "תעודה בלי כיס דמו נחשבת פתוחה",
    (await DeliveryNote.countDocuments({ _id: note._id, ...ledger.openQuery() })) === 1
  );

  // ─────────────────────────────────────────────────────────────────
  group("שחרור תעודות תקועות");

  const stuck = new Date(Date.now() - 60 * 60 * 1000);
  await DeliveryNote.updateOne(
    { _id: note._id },
    { $set: {
        "billing.status": "billing",
        "billing.claimedAt": stuck,
        "billing.claimToken": "STUCK-REAL",
        "billing.demo.status": "billing",
        "billing.demo.claimedAt": stuck,
        "billing.demo.claimToken": "STUCK-DEMO",
    } }
  );
  await releaseStuckClaims({ olderThanMinutes: 30 });
  const released = await DeliveryNote.findById(note._id).lean();
  check("תקיעה בכיס האמיתי שוחררה גם במצב דמו", released.billing.status === "open", released.billing.status);
  check("וגם התקיעה בכיס הדמו", released.billing.demo?.status === "open", released.billing.demo?.status);
  check("שני הטוקנים נוקו", !released.billing.claimToken && !released.billing.demo?.claimToken);

  // ─────────────────────────────────────────────────────────────────
  group("ניקוי מחזיר את התעודה למצב נקי");

  await DeliveryNote.updateMany(
    { _id: note._id },
    { $unset: { "billing.demo": "" } }
  );
  const clean = await DeliveryNote.findById(note._id).lean();
  check("billing.demo נמחק", clean.billing.demo === undefined || clean.billing.demo === null);
  check("והתעודה שוב נאספת לחיוב אמיתי", clean.billing.status === "open");

  // ─────────────────────────────────────────────────────────────────
  await Customer.updateOne({ _id: customer._id }, { $set: { "billing.mode": originalMode } });
  await cleanup();
  await mongoose.disconnect();

  console.log(`\n${"═".repeat(58)}`);
  console.log(fail ? `${pass} עברו · ${fail} נכשלו` : `✅ כל ${pass} הבדיקות עברו`);
  console.log("═".repeat(58));
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error("\n❌ הבדיקה קרסה:", err.message);
  try { await cleanup(); await mongoose.disconnect(); } catch {}
  process.exit(1);
});

// scripts/billing-reissue-test.js
//
// הרצף המלא של "תיקון חשבונית והפקה מחדש", מקצה לקצה:
//
//   חשבונית קיימת → זיכוי → תיקון התעודות → חשבונית חדשה
//
// למה סקריפט נפרד ולא עוד קבוצה ב-billing-selftest: הרצף מפיק מסמכי מס,
// ובדיקה אמיתית שלו מול iCount הייתה מייצרת זיכוי וחשבונית בספרים בכל
// הרצה. לכן iCount מוחלף כאן בפונקציה מדומה — בדיוק כמו ב-billing-demo-test —
// והבדיקה עדיין רצה מול המסד האמיתי עם התעודות והמחירים האמיתיים.
//
// ICOUNT_MODE=live בכוונה: הזרימה הנבדקת היא זו שרצה בייצור, וכיס הדמו
// מכוסה בנפרד (billing-demo-test בודק שעריכה בדמו חסומה).
//
//   node scripts/billing-reissue-test.js
//
// ⚠️ הבדיקה יוצרת תעודות סינתטיות (issuedBy: REISSUETEST) ומוחקת אותן
//    בסוף. היא אינה נוגעת בתעודות אמיתיות: כל השאילתות מוגבלות למספרי
//    המסמך המדומים שהיא עצמה יצרה.

process.env.ICOUNT_MODE = "live";
require("dotenv").config();
process.env.ICOUNT_MODE = "live";

const mongoose = require("mongoose");

// ── החלפת iCount לפני שמישהו טוען אותו ──────────────────────────────
const icountDocs = require("../lib/icount/documents");
let invoicesIssued = [];
let creditsIssued = [];

icountDocs.createInvoice = async ({ customerId, items, description, discount }) => {
  const docNum = `MOCKINV-${invoicesIssued.length + 1}`;
  invoicesIssued.push({ docNum, customerId: String(customerId), items, description, discount });
  return { doctype: "invoice", docNum, url: `https://mock/${docNum}`, emailedTo: null };
};
icountDocs.createCreditNote = async ({ customerId, originalDocNum, items, discount, reason }) => {
  const docNum = `MOCKCR-${creditsIssued.length + 1}`;
  creditsIssued.push({ docNum, customerId: String(customerId), originalDocNum, items, discount, reason });
  return { doctype: "refund", docNum, url: `https://mock/${docNum}`, emailedTo: null };
};

const DeliveryNote = require("../models/DeliveryNote");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const { nextFreeNumber } = require("../utils/deliveryNoteNumber");
const { previousMonth } = require("../lib/billing/monthlyBilling");
const { discountPercentFor } = require("../lib/billing/pricing");
const { reissueInvoice } = require("../lib/billing/reissue");

const TAG = "REISSUETEST";
let pass = 0;
let fail = 0;

const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const group = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 50 - t.length))}`);

const money = (n) => Number((Number(n) || 0).toFixed(2));
const sumOf = (rows) => money((rows || []).reduce((s, i) => s + (Number(i.lineTotal) || 0), 0));

const cleanup = async () => {
  await DeliveryNote.deleteMany({ issuedBy: { $regex: `^${TAG}` } });
  // המונה נמחק כדי שהמספרים שנצרכו כאן לא ייווצרו כפער בסדרה: הוא נזרע
  // מחדש מהמספר הגבוה ביותר שקיים במסד, ואחרי המחיקה זה שוב מספר אמיתי
  await mongoose.connection.db
    .collection("app_counters")
    .deleteMany({ _id: "delivery_note" });
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  await cleanup();

  // ── לקוח בלי הנחה קבועה ובלי פיצול לפי קטגוריה ──
  // שניהם היו משנים את הסכומים ואת מספר החשבוניות, וכאן נבדק הרצף ולא הם
  let customer = null;
  for (const c of await Customer.find({}).select("+erp name billing").limit(60).lean()) {
    if (c.billing?.splitInvoiceByCategory) continue;
    if ((await discountPercentFor(c)) > 0) continue;
    customer = c;
    break;
  }
  if (!customer) throw new Error("לא נמצא לקוח בלי הנחה קבועה ובלי פיצול לפי קטגוריה");

  // מוצר אמיתי מהקטלוג — buildPricedItems דוחה מק"ט שאינו קיים
  const product = await Product.findOne({ sku: { $exists: true, $ne: null } })
    .select("sku title")
    .lean();
  if (!product) throw new Error("לא נמצא מוצר עם מק\"ט");

  const month = previousMonth();
  const line = (qty, price) => ({
    name: "פריט בדיקה",
    sku: String(product.sku),
    quantity: qty,
    unitPrice: price,
    lineTotal: money(qty * price),
  });

  const makeBilled = async (docNum, items, extra = {}) =>
    DeliveryNote.create({
      number: await nextFreeNumber(),
      kind: "manual",
      customer: customer._id,
      customerSnapshot: { name: `${TAG}` },
      items,
      subTotal: sumOf(items),
      total: sumOf(items),
      issuedBy: TAG,
      billing: {
        status: "billed",
        billingMonth: month,
        icountDocNum: docNum,
        billedAt: new Date(),
        ...extra,
      },
    });

  console.log(`לקוח: ${customer.name} · מוצר: ${product.sku}`);

  // ─────────────────────────────────────────────────────────────────
  group("תיקון כמות — הרצף המלא");

  invoicesIssued = [];
  creditsIssued = [];

  const note = await makeBilled("REISSUE-A", [line(2, 10)]);

  const res = await reissueInvoice({
    icountDocNum: "REISSUE-A",
    reason: "בדיקת תיקון",
    changedBy: TAG,
    emailDocument: false,
    edits: [
      { noteId: String(note._id), items: [{ sku: String(product.sku), quantity: 5, unitPrice: 10 }] },
    ],
  });

  check("הרצף הושלם", res.stage === "done", `${res.stage} · ${res.problems.join("; ")}`);
  check("הופקה חשבונית זיכוי אחת", creditsIssued.length === 1, `${creditsIssued.length}`);
  check("הופקה חשבונית חדשה אחת", invoicesIssued.length === 1, `${invoicesIssued.length}`);
  check("התעודה נרשמה כמתוקנת", res.editedNotes.length === 1 && res.editedNotes[0] === note.number);

  // ⚠️ הבדיקה המרכזית: הזיכוי חייב לשקף את החשבונית *המקורית*.
  //    זיכוי שנבנה על התוכן המתוקן היה מזכה 50 במקום 20, וההפרש היה
  //    נשאר פתוח בספרים בלי שאיש רואה אותו.
  check("הזיכוי על הסכום המקורי (20)", sumOf(creditsIssued[0].items) === 20, `${sumOf(creditsIssued[0].items)}`);
  check("הזיכוי מצביע על החשבונית המקורית", creditsIssued[0].originalDocNum === "REISSUE-A");
  check("סיבת הזיכוי עברה למסמך", creditsIssued[0].reason === "בדיקת תיקון");
  check("החשבונית החדשה על הסכום המתוקן (50)", sumOf(invoicesIssued[0].items) === 50, `${sumOf(invoicesIssued[0].items)}`);

  const after = await DeliveryNote.findById(note._id).lean();
  check("התעודה חויבה מחדש", after.billing.status === "billed", after.billing.status);
  check("ומול מספר המסמך החדש", after.billing.icountDocNum === invoicesIssued[0].docNum, after.billing.icountDocNum);
  check("הכמות תוקנה", after.items[0].quantity === 5, `${after.items[0].quantity}`);
  check("הסכום חושב מחדש", after.total === 50, `${after.total}`);
  check("התעודה סומנה כנערכה ידנית", after.manuallyEdited === true);
  check("שם המתקן נשמר", after.editedBy === TAG, after.editedBy);
  check("הזיכוי נשמר בהיסטוריית התעודה", (after.billing.credits || []).length === 1);
  check(
    "והוא מצביע על החשבונית שזוכתה",
    after.billing.credits?.[0]?.originalDocNum === "REISSUE-A" &&
      after.billing.credits?.[0]?.creditDocNum === creditsIssued[0].docNum
  );
  check("תאריך החיוב עודכן", !!after.billing.billedAt);

  // ─────────────────────────────────────────────────────────────────
  group("הפקה מחדש בלי שינויים");

  invoicesIssued = [];
  creditsIssued = [];
  const plain = await makeBilled("REISSUE-B", [line(3, 7)]);

  const res2 = await reissueInvoice({
    icountDocNum: "REISSUE-B",
    reason: "נשלחה לכתובת שגויה",
    changedBy: TAG,
    emailDocument: false,
  });

  check("הרצף הושלם", res2.stage === "done", `${res2.stage} · ${res2.problems.join("; ")}`);
  check("אף תעודה לא סומנה כמתוקנת", res2.editedNotes.length === 0);
  check("הזיכוי והחשבונית על אותו סכום", sumOf(creditsIssued[0].items) === sumOf(invoicesIssued[0].items));
  const afterPlain = await DeliveryNote.findById(plain._id).lean();
  check("התוכן לא השתנה", afterPlain.total === 21 && afterPlain.items[0].quantity === 3);
  check("התעודה לא סומנה כנערכה ידנית", !afterPlain.manuallyEdited);
  check("מספר המסמך התחלף", afterPlain.billing.icountDocNum === invoicesIssued[0].docNum);

  // ─────────────────────────────────────────────────────────────────
  group("הסרת תעודה מהחשבונית");

  invoicesIssued = [];
  creditsIssued = [];
  const keep = await makeBilled("REISSUE-C", [line(1, 40)]);
  const drop = await makeBilled("REISSUE-C", [line(1, 15)]);

  const res3 = await reissueInvoice({
    icountDocNum: "REISSUE-C",
    reason: "סחורה הוחזרה",
    changedBy: TAG,
    emailDocument: false,
    edits: [{ noteId: String(drop._id), remove: true }],
  });

  check("הרצף הושלם", res3.stage === "done", `${res3.stage} · ${res3.problems.join("; ")}`);
  check("התעודה נרשמה כמוסרת", res3.removedNotes.length === 1 && res3.removedNotes[0] === drop.number);
  check("הזיכוי כיסה את שתי התעודות (55)", sumOf(creditsIssued[0].items) === 55, `${sumOf(creditsIssued[0].items)}`);
  check("החשבונית החדשה רק על הנשארת (40)", sumOf(invoicesIssued[0].items) === 40, `${sumOf(invoicesIssued[0].items)}`);

  const afterDrop = await DeliveryNote.findById(drop._id).lean();
  const afterKeep = await DeliveryNote.findById(keep._id).lean();
  check("התעודה שהוסרה בוטלה", afterDrop.billing.status === "cancelled", afterDrop.billing.status);
  check("ואינה נושאת מספר חשבונית חדש", afterDrop.billing.icountDocNum !== invoicesIssued[0].docNum);
  check("סיבת הביטול נשמרה", /סחורה הוחזרה/.test(afterDrop.billing.cancelReason || ""));
  check("הנשארת חויבה בחשבונית החדשה", afterKeep.billing.icountDocNum === invoicesIssued[0].docNum);

  // ─────────────────────────────────────────────────────────────────
  group("תיקון שני של אותה חשבונית");

  // התיקון הראשון החליף את מספר המסמך; ניסיון לתקן שוב את הישן חייב
  // להיכשל, אחרת ריענון של המסך היה מפיק זיכוי שני על אותה חשבונית
  invoicesIssued = [];
  creditsIssued = [];
  try {
    await reissueInvoice({ icountDocNum: "REISSUE-A", reason: "שוב", changedBy: TAG });
    check("תיקון חוזר של חשבונית שכבר תוקנה נחסם", false, "לא נזרקה שגיאה");
  } catch (err) {
    check("תיקון חוזר של חשבונית שכבר תוקנה נחסם", /לא נמצאו תעודות/.test(err.message), err.message);
  }
  check("ולא הופק שום מסמך", creditsIssued.length === 0 && invoicesIssued.length === 0);

  // אבל את החשבונית *החדשה* כן אפשר לתקן — אחרת תיקון שני היה בלתי אפשרי
  invoicesIssued = [];
  creditsIssued = [];
  const secondPass = await reissueInvoice({
    icountDocNum: after.billing.icountDocNum,
    reason: "תיקון שני",
    changedBy: TAG,
    emailDocument: false,
    edits: [
      { noteId: String(note._id), items: [{ sku: String(product.sku), quantity: 1, unitPrice: 10 }] },
    ],
  });
  check("תיקון של החשבונית החדשה עובד", secondPass.stage === "done", secondPass.stage);
  const twice = await DeliveryNote.findById(note._id).lean();
  check("הכמות תוקנה שוב", twice.items[0].quantity === 1, `${twice.items[0].quantity}`);
  check("שני הזיכויים רשומים על התעודה", (twice.billing.credits || []).length === 2, `${(twice.billing.credits || []).length}`);

  // ─────────────────────────────────────────────────────────────────
  await cleanup();
  console.log(`\n${"═".repeat(54)}`);
  console.log(fail === 0 ? `✅ כל ${pass} הבדיקות עברו` : `${pass} עברו · ${fail} נכשלו`);
  console.log("═".repeat(54));
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

// scripts/icount-demo-invoice.js
//
// הפקת חשבונית דמו אחת מהטרמינל, לבדיקת החיבור לחשבון הדמו.
//
// זו אותה פונקציה שמסך "הדגמת iCount" קורא לה — לא מימוש שני. השימוש
// שלה כאן הוא לבדוק חיבור בלי להפעיל את השרת והאדמין.
//
//   ICOUNT_MODE=demo node scripts/icount-demo-invoice.js
//   ICOUNT_MODE=demo node scripts/icount-demo-invoice.js 1234   # מספר לקוח בהנהח"ש
//
// assertDemo בתוך lib/billing/demo חוסם את הסקריפט אם המערכת מחוברת
// לחשבון האמיתי — הוא לא יכול להפיק מסמך מס בטעות.

require("dotenv").config();
const mongoose = require("mongoose");

const Customer = require("../models/Customer");
const { issueDemoInvoice, fetchDemoTotal } = require("../lib/billing/demo");
const { isDemoMode } = require("../lib/icount/mode");
const { ping } = require("../lib/icount/client");

const shekel = (n) =>
  Number(n || 0).toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  if (!isDemoMode()) {
    console.error("❌ ICOUNT_MODE אינו demo — הסקריפט לא ירוץ מול החשבון האמיתי");
    process.exit(1);
  }

  const account = await ping();
  console.log(`\nחשבון: ${account.cid} · משתמש: ${account.user} · ${account.fullName || ""}`);

  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const wanted = process.argv[2];
  const customer = await Customer.findOne(
    wanted
      ? { "erp.customerNumber": wanted }
      : { "erp.customerNumber": { $exists: true, $ne: "" } }
  )
    .select("+erp name lastName")
    .lean();

  if (!customer) throw new Error(wanted ? `לא נמצא לקוח ${wanted}` : "לא נמצא לקוח עם מספר בהנהח\"ש");

  console.log(`לקוח: ${customer.erp.customerNumber} — ${customer.name}\n`);

  const doc = await issueDemoInvoice({ customerId: customer._id });

  console.log(`✅ חשבונית דמו ${doc.docNum}`);
  if (doc.url) console.log(`   ${doc.url}`);
  console.log("");
  for (const it of doc.items) {
    console.log(
      `   ${it.name} · ${it.quantity} × ${shekel(it.unitPrice)} = ${shekel(it.lineTotal)} ₪` +
        (it.isVatFree ? "  (פטור)" : "")
    );
  }

  const ours = doc.estimate;
  console.log(
    `\n   האומדן שלנו:  לפני מע"מ ${shekel(ours.beforeVat)} · מע"מ ${shekel(ours.vat)} · סה"כ ${shekel(ours.total)} ₪`
  );

  const theirs = await fetchDemoTotal(doc.docNum);
  console.log(
    `   לפי iCount:   לפני מע"מ ${shekel(theirs.totalBeforeVat)} · מע"מ ${shekel(theirs.vat)} · סה"כ ${shekel(theirs.totalWithVat)} ₪`
  );

  const matches = Math.abs(theirs.totalWithVat - ours.total) < 0.02;
  console.log(matches ? "\n✅ הסכומים תואמים" : "\n❌ פער בין החישוב שלנו ל-iCount");

  await mongoose.disconnect();
  process.exit(matches ? 0 : 1);
})().catch(async (err) => {
  console.error("\n❌", err.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});

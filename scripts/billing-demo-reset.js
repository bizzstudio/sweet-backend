// scripts/billing-demo-reset.js
//
// מחיקת כל מצב החיוב של הדמו מהמסד — billing.demo מכל תעודות המשלוח.
//
// מה שנמחק הוא רק הכיס של הדמו: סטטוס, מספרי חשבונית וקבלה, תאריכי
// חיוב ותשלום וזיכויים שנוצרו מול חשבון הדמו. הרישום האמיתי (billing.*)
// לא נוגע. המסמכים עצמם נשארים בחשבון הדמו ב-iCount — אי אפשר למחוק
// מסמך שם, וגם אין צורך.
//
//   node scripts/billing-demo-reset.js          # תצוגה בלבד
//   node scripts/billing-demo-reset.js --yes    # מחיקה בפועל
//
// אין כאן בדיקת ICOUNT_MODE בכוונה: מנקים דווקא אחרי שחוזרים ל-live.

require("dotenv").config();
const mongoose = require("mongoose");
const DeliveryNote = require("../models/DeliveryNote");

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const query = { "billing.demo": { $exists: true } };
  const affected = await DeliveryNote.countDocuments(query);

  if (!affected) {
    console.log("אין מצב דמו במסד — לא נדרש ניקוי");
    await mongoose.disconnect();
    return;
  }

  const sample = await DeliveryNote.find(query).select("number billing.demo").limit(10).lean();
  console.log(`${affected} תעודות נושאות מצב דמו. דוגמה:`);
  for (const n of sample) {
    console.log(
      `  תעודה ${n.number}: ${n.billing.demo.status || "—"}` +
        (n.billing.demo.icountDocNum ? ` · חשבונית ${n.billing.demo.icountDocNum}` : "") +
        (n.billing.demo.receiptDocNum ? ` · קבלה ${n.billing.demo.receiptDocNum}` : "")
    );
  }

  if (!process.argv.includes("--yes")) {
    console.log(`\nהרצה יבשה. למחיקה בפועל: node ${require("path").basename(__filename)} --yes`);
    await mongoose.disconnect();
    return;
  }

  const res = await DeliveryNote.updateMany(query, { $unset: { "billing.demo": "" } });
  console.log(`\n✅ נמחק מצב הדמו מ-${res.modifiedCount} תעודות`);

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error("❌", err.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});

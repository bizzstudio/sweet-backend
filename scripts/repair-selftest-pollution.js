// scripts/repair-selftest-pollution.js
//
// מנקה תעודות אמיתיות שנחתמו בטעות בנתוני בדיקה.
//
// הרקע: scripts/billing-selftest.js קרא ל-createFromOrder על הזמנה אמיתית
// כדי לייצר "תעודה שנייה" לבדיקת דדופ. createFromOrder מחזיר את התעודה
// הקיימת כשכבר יש כזו להזמנה, ולכן הבדיקה חתמה billed / TEST-INV-* על
// תעודה של לקוח אמיתי. cleanup לא מחק אותה — issuedBy שלה אינו התג של
// הבדיקה — והיא נשארה במסך החשבוניות כחשבונית שאינה קיימת.
//
// הבדיקה תוקנה (30/08/26) ומייצרת עכשיו תעודה סינתטית משלה. הסקריפט הזה
// מנקה את מה שכבר נשאר.
//
//   node scripts/repair-selftest-pollution.js          # דוח בלבד
//   node scripts/repair-selftest-pollution.js --apply  # תיקון בפועל

require("dotenv").config();
const mongoose = require("mongoose");
const DeliveryNote = require("../models/DeliveryNote");

const APPLY = process.argv.includes("--apply");
const TEST_DOC = /^TEST-/;

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const polluted = await DeliveryNote.find({
    $or: [
      { "billing.icountDocNum": TEST_DOC },
      { "billing.receiptDocNum": TEST_DOC },
      { "billing.credits.creditDocNum": TEST_DOC },
    ],
  })
    .select("number issuedBy customerSnapshot.name billing")
    .lean();

  if (!polluted.length) {
    console.log("✅ אין תעודות עם נתוני בדיקה.");
    await mongoose.disconnect();
    return;
  }

  console.log(`נמצאו ${polluted.length} תעודות עם נתוני בדיקה:\n`);
  for (const n of polluted) {
    console.log(
      `  תעודה ${n.number} · ${n.customerSnapshot?.name || "—"} · ${n.issuedBy || "—"}\n` +
        `    סטטוס ${n.billing?.status} · חשבונית ${n.billing?.icountDocNum || "—"}` +
        ` · קבלה ${n.billing?.receiptDocNum || "—"}` +
        ` · ${n.billing?.credits?.length || 0} זיכויים`
    );
  }

  if (!APPLY) {
    console.log("\nהרצה בלבד. להחזרת התעודות למצב פתוח: --apply");
    await mongoose.disconnect();
    return;
  }

  // חזרה למצב פתוח: זה המצב שבו הן היו לפני שהבדיקה נגעה בהן. הן ייאספו
  // בסגירת החודש הבאה ויחויבו כרגיל.
  const res = await DeliveryNote.updateMany(
    { _id: { $in: polluted.map((n) => n._id) } },
    {
      $set: { "billing.status": "open" },
      $unset: {
        "billing.icountDocNum": "",
        "billing.icountDocType": "",
        "billing.icountDocUrl": "",
        "billing.icountDocEmailedTo": "",
        "billing.billedAt": "",
        "billing.receiptDocNum": "",
        "billing.receiptDocUrl": "",
        "billing.receiptEmailedTo": "",
        "billing.paidAt": "",
        "billing.credits": "",
      },
    }
  );

  console.log(`\n✅ ${res.modifiedCount} תעודות הוחזרו למצב "ממתינה לחיוב".`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

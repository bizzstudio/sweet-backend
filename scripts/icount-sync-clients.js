// scripts/icount-sync-clients.js
//
// סנכרון כרטיסי הלקוחות אל iCount.
//
//   node scripts/icount-sync-clients.js --dry-run          תצוגה בלבד, לא כותב
//   node scripts/icount-sync-clients.js --limit 5          חמישה לקוחות
//   node scripts/icount-sync-clients.js                    הכל
//   node scripts/icount-sync-clients.js --customer 552     לקוח בודד לפי מספר הנהח"ש
//
// ברירת המחדל היא dry-run מכוון: הרצה בלי דגלים מדפיסה מה יקרה ולא כותבת
// כלום. כדי לכתוב באמת צריך --apply. סנכרון של 769 לקוחות אינו פעולה שכדאי
// שתקרה בטעות מהיסטוריית הפקודות.

require("dotenv").config();
const mongoose = require("mongoose");
const Customer = require("../models/Customer");
const { ping } = require("../lib/icount/client");
const { syncCustomer, toIcountClient } = require("../lib/icount/clients");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i > -1 ? args[i + 1] : null;
};

const APPLY = has("--apply");
const LIMIT = Number(valueOf("--limit")) || 0;
const ONLY = valueOf("--customer");

// iCount מגביל קצב בקשות. הפסקה קצרה בין לקוחות עדיפה על ריצה שנחסמת
// באמצע ומשאירה חצי מהלקוחות מסונכרנים.
const DELAY_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const account = await ping();
  console.log(`[icount] מחובר: ${account.cid} / ${account.user}\n`);

  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const query = { "erp.customerNumber": { $exists: true, $nin: [null, ""] } };
  if (ONLY) query["erp.customerNumber"] = ONLY;

  let cursor = Customer.find(query).select("+erp").sort({ "erp.customerNumber": 1 });
  if (LIMIT) cursor = cursor.limit(LIMIT);
  const customers = await cursor.lean();

  console.log(`נמצאו ${customers.length} לקוחות לסנכרון`);
  if (!APPLY) {
    console.log("מצב תצוגה בלבד — לא נכתב כלום. להרצה אמיתית הוסיפי --apply\n");
  } else {
    console.log("");
  }

  const stats = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const failures = [];

  for (const [i, customer] of customers.entries()) {
    const label = `${customer.erp.customerNumber} — ${customer.name}`;

    // לקוח לא פעיל בהנהח"ש לא צריך כרטיס ב-iCount. הוא ייווצר מעצמו אם
    // וכאשר תיכנס עבורו הזמנה (דרך ensureClientId).
    if (customer.erp.active === false) {
      console.log(`⊘ ${label} — לא פעיל, מדלג`);
      stats.skipped++;
      continue;
    }

    if (!APPLY) {
      const payload = toIcountClient(customer);
      console.log(`· ${label}  →  ח.פ ${payload.vat_id || "—"} | ${payload.home_city || "—"} | ${payload.email || "אין מייל"}`);
      continue;
    }

    try {
      const { action } = await syncCustomer(customer);
      stats[action]++;
      console.log(`${action === "created" ? "✚" : "↻"} ${label}  (${i + 1}/${customers.length})`);
      await sleep(DELAY_MS);
    } catch (err) {
      stats.failed++;
      failures.push({ label, message: err.message, reason: err.reason });
      console.log(`✗ ${label} — ${err.message}`);
    }
  }

  console.log(`\n--- סיכום ---`);
  if (APPLY) {
    console.log(`נוצרו: ${stats.created} | עודכנו: ${stats.updated} | דולגו: ${stats.skipped} | נכשלו: ${stats.failed}`);
    if (failures.length) {
      console.log(`\nכשלונות:`);
      failures.forEach((f) => console.log(`  ${f.label}: ${f.message}`));
    }
  } else {
    console.log(`${customers.length - stats.skipped} לקוחות ייווצרו/יעודכנו, ${stats.skipped} ידולגו`);
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error("שגיאה:", err.message);
  process.exit(1);
});

// script/replay-failed-orders.js
//
// "מה יקרה אם אריץ מחדש את כל ההזמנות שנתקעו" — הרצה: npm run ingest:replay
//
// ── קריאה בלבד ──
//
// הסקריפט **אינו כותב דבר**: לא יוצר הזמנות, לא מוחק, לא נוגע במלאי. הוא לוקח
// את הטקסט המקורי של כל הזמנת שגיאה פתוחה ומריץ עליו בדיוק את מה שהצינור
// מריץ — פרסור, מחירון, היסטוריה, התאמה — ומדווח מה **היה** קורה עכשיו.
//
// זה המספר שעונה על "איך אני יודעת שזה עובד": לא בדיקה על מקרה אחד, אלא על
// כל מה שנכשל בפועל.

require("dotenv").config();
const mongoose = require("mongoose");

const Order = require("../models/Order");
const Customer = require("../models/Customer");
const { parseOrderText } = require("../lib/order-ingestion/tableParser");
const { resolveItems } = require("../lib/order-ingestion/resolvers");
const { getCustomerPriceMap } = require("../utils/customerPriceList");
const { getCustomerPurchaseProfile } = require("../utils/customerPurchaseHistory");

// אותם ספים שהצינור עצמו משתמש בהם — מיובאים ולא משוכפלים, אחרת הדוח
// יבטיח משהו אחר ממה שיקרה
const MIN_ORDER_CONFIDENCE = Number(process.env.INGESTION_MIN_ORDER_CONFIDENCE) || 0.7;
const ALLOW_PARTIAL = process.env.INGESTION_ALLOW_PARTIAL === "true";

const LIMIT = Number(process.argv[2]) || 50;

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000 });

  const orders = await Order.find({
    "ingestionError.code": { $exists: true, $ne: null },
    "ingestionError.resolvedAt": null,
    "ingestionError.rawText": { $exists: true, $ne: "" },
  })
    .select("invoice user source ingestionError.code ingestionError.rawText createdAt")
    .sort({ createdAt: -1 })
    .limit(LIMIT)
    .lean();

  console.log(`נבדקות ${orders.length} הזמנות שנתקעו (החדשות ביותר)\n`);

  // הפרופילים נשלפים פעם אחת ללקוח ולא לכל הזמנה
  const cache = new Map();
  const forCustomer = async (id) => {
    const key = String(id);
    if (!cache.has(key)) {
      cache.set(key, {
        priceMap: await getCustomerPriceMap(id).catch(() => null),
        historyProfile: await getCustomerPurchaseProfile(id).catch(() => null),
        customer: await Customer.findById(id).select("name lastName").lean().catch(() => null),
      });
    }
    return cache.get(key);
  };

  const stats = { pass: 0, fail: 0, byReason: new Map() };
  const rows = [];

  for (const order of orders) {
    const { priceMap, historyProfile, customer } =
      (await forCustomer(order.user)) || {};

    const parsed = parseOrderText({
      text: order.ingestionError.rawText,
      channel: order.source === "whatsapp" ? "whatsapp" : "email",
      sender: {},
    });

    let verdict;
    let detail = "";
    let usedHistory = 0;

    if (!parsed?.items?.length) {
      verdict = "נכשל";
      detail = "לא זוהו פריטים";
    } else {
      const { items, unmatched } = await resolveItems(parsed.items, {
        contextText: order.ingestionError.rawText,
        priceMap,
        historyProfile,
        customerId: order.user,
      });

      usedHistory = items.filter((i) => String(i.decidedBy || "").includes("היסטוריה")).length;

      const confidence = items.length
        ? Math.min(Number(parsed.confidence) || 0, ...items.map((i) => i.confidence))
        : 0;

      if (unmatched.length && !ALLOW_PARTIAL) {
        verdict = "נכשל";
        detail = `${unmatched.length} פריטים לא זוהו: ${unmatched
          .map((u) => `"${u.rawName}"`)
          .slice(0, 3)
          .join(", ")}`;
      } else if (!items.length) {
        verdict = "נכשל";
        detail = "אף פריט לא נכנס";
      } else if (confidence < MIN_ORDER_CONFIDENCE) {
        // איזה פריט מושך את הביטחון למטה — זה מה שצריך לתקן
        const weakest = items.reduce((a, b) => (a.confidence <= b.confidence ? a : b));
        verdict = "נכשל";
        detail = `ביטחון ${confidence} — החוליה החלשה: "${weakest.rawName}" (${weakest.confidence})`;
      } else {
        verdict = "עובר";
        detail = `${items.length} פריטים, ביטחון ${confidence}`;
      }
    }

    if (verdict === "עובר") stats.pass += 1;
    else {
      stats.fail += 1;
      const key = detail.split(":")[0].split("—")[0].trim();
      stats.byReason.set(key, (stats.byReason.get(key) || 0) + 1);
    }

    rows.push({
      invoice: order.invoice,
      customer: `${customer?.name || ""} ${customer?.lastName || ""}`.trim() || "—",
      hadHistory: Boolean(historyProfile),
      was: order.ingestionError.code,
      verdict,
      detail,
      usedHistory,
    });
  }

  rows.forEach((r) => {
    console.log(
      `  ${r.verdict === "עובר" ? "✅" : "❌"} #${String(r.invoice).padEnd(6)}` +
        `${r.customer.slice(0, 14).padEnd(16)}` +
        `${r.hadHistory ? "היסטוריה " : "בלי       "}` +
        `${r.usedHistory ? `(${r.usedHistory} דרך היסטוריה) ` : ""}` +
        r.detail
    );
  });

  console.log(`\n${"═".repeat(70)}`);
  console.log(`עוברות עכשיו: ${stats.pass} מתוך ${orders.length}`);
  if (stats.fail) {
    console.log(`\nלמה השאר עדיין נכשלות:`);
    [...stats.byReason.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([reason, n]) => console.log(`  ${String(n).padStart(3)} × ${reason}`));
  }

  const withHistory = rows.filter((r) => r.hadHistory);
  if (withHistory.length) {
    const ok = withHistory.filter((r) => r.verdict === "עובר").length;
    console.log(`\nמתוך אלה שיש להם היסטוריה: ${ok}/${withHistory.length} עוברות`);
  }
  console.log("\n(לא נכתב דבר למסד — קריאה בלבד)");

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error("שגיאה:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

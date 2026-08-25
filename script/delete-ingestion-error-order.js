// script/delete-ingestion-error-order.js
//
// מחיקת הזמנה שנוצרה בטעות בקליטה האוטומטית.
//
// הרצה:   npm run order:delete-error -- 10018            (דוח בלבד — לא מוחק)
//         npm run order:delete-error -- 10018 --apply    (מוחק, אחרי גיבוי)
//
// ── למה מותר למחוק דווקא הזמנה כזו ──
//
// הזמנה בסטטוס "שגיאה בקריאה" היא בכוונה לא הזמנה פעילה: היא לא הורידה מלאי,
// לא נכנסה לדוחות ההכנסות, לא הופיעה באפליקציית המלקטים ולא נשלח עליה מייל
// ללקוח (ראה ORDER-INGESTION.md). לכן אין מה "לבטל" — אין לה שום עקבות מחוץ
// לעצמה. זה בדיוק ההיגיון שמאחורי כפתור "נסה לקרוא שוב", שמוחק אותה ומריץ
// את ההודעה מחדש.
//
// ── ומה הסקריפט מסרב לעשות ──
//
// הזמנה שאינה בשגיאת קליטה, או כזו שכבר אושרה ידנית, **כן** נגעה במלאי
// ובדוחות. הסקריפט עוצר עליה במקום למחוק, כי מחיקה שם אינה הפיכה בפועל.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const Order = require("../models/Order");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const invoice = Number(args.find((a) => /^\d+$/.test(a)));

const run = async () => {
  if (!Number.isFinite(invoice)) {
    console.log('חסר מספר הזמנה. דוגמה: npm run order:delete-error -- 10018');
    process.exit(1);
  }

  await connectDB();

  const order = await Order.findOne({ invoice }).lean();
  if (!order) {
    console.log(`הזמנה ${invoice} לא נמצאה.`);
    return;
  }

  const status = await mongoose.connection.db
    .collection("statuses")
    .findOne({ _id: order.status });

  const unmatched = order.ingestionError?.unmatchedItems?.length || 0;
  console.log(`\n── הזמנה ${invoice} ──`);
  console.log(`סטטוס:            ${status?.heName || "—"}`);
  console.log(`מקור:             ${order.source || "—"}`);
  console.log(`קוד שגיאת קליטה:  ${order.ingestionError?.code || "אין"}`);
  console.log(`השגיאה נסגרה:     ${order.ingestionError?.resolvedAt || "לא"}`);
  console.log(`פריטים בעגלה:     ${(order.cart || []).length}`);
  console.log(`פריטים שלא זוהו:  ${unmatched}`);
  console.log(`סה"כ:             ${order.total}`);

  // ── סירובים ──
  if (!order.ingestionError?.code) {
    console.log(`\n⛔ ההזמנה אינה בשגיאת קליטה. ייתכן שהיא הורידה מלאי ונכנסה לדוחות — לא נמחקת מכאן.`);
    return;
  }
  if (order.ingestionError?.resolvedAt) {
    console.log(`\n⛔ השגיאה כבר סומנה כמטופלת — כלומר ההזמנה אושרה והמלאי ירד. לא נמחקת מכאן.`);
    return;
  }

  if (!APPLY) {
    console.log(`\nדוח בלבד. להרצה בפועל: npm run order:delete-error -- ${invoice} --apply`);
    return;
  }

  // ── גיבוי לפני מחיקה ──
  const dir = path.join(__dirname, "..", "uploads", "deleted-orders");
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `order-${invoice}.json`);
  fs.writeFileSync(backup, JSON.stringify(order, null, 1));
  console.log(`\nגובתה ל: ${backup} (${(fs.statSync(backup).size / 1024).toFixed(0)} KB)`);

  const res = await Order.deleteOne({ _id: order._id });
  console.log(`נמחקו ${res.deletedCount} הזמנות.`);

  const left = await Order.countDocuments({ "ingestionError.code": { $exists: true } });
  console.log(`נותרו הזמנות בשגיאת קליטה: ${left}`);
};

run()
  .catch((err) => {
    console.error("שגיאה:", err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

// script/reprocess-error-orders.js
//
// הרצה חוזרת של הזמנות שנתקעו ב"שגיאה בקריאה" — אותה פעולה בדיוק כמו כפתור
// "נסה לקרוא שוב" במסך ההזמנה, על כולן ברצף.
//
//   node script/reprocess-error-orders.js                    ← רשימה בלבד, לא כותב
//   node script/reprocess-error-orders.js --apply            ← מריץ על כולן
//   node script/reprocess-error-orders.js --apply --since=2026-10-08
//   node script/reprocess-error-orders.js --apply --only=148404,148403
//
// ── מה ההרצה עושה, ולמה ברירת המחדל היא רשימה בלבד ──
//
// הזמנת השגיאה **נמחקת** ובמקומה נוצרת הזמנה חדשה במספר חדש. מה שהושלם בה
// ידנית (מוצר שנבחר, כתובת) אינו עובר להזמנה החדשה.
//
// הזמנה שנקראת עכשיו במלואה נכנסת ל"טופלה", כלומר: מלאי יורד, נוצרת תעודת
// משלוח והיא עולה לליקוט. מייל אינו נשלח לאיש — ראה למטה. על הזמנה
// מלפני שבוע שכבר סופקה זו אספקה כפולה — לכן יש --since ו---only. לדוח "מה
// היה עובר" בלי לכתוב: npm run ingest:replay.
//
// הזמנה שנכשלת שוב חוזרת כהזמנת שגיאה חדשה.

require("dotenv").config();
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const Order = require("../models/Order");

// ── בלי מיילים בכלל, בסקריפט הזה בלבד ──
//
// הרצה חוזרת נוגעת בעשרות הזמנות בנות כמה ימים. בלי החסימה הזו יוצאים בבת
// אחת: הודעת "התקבלה הזמנה חדשה" לצוות וללקוח על כל הזמנה שנכנסת, והתראת
// "דורשת השלמה" על כל הזמנה שנכשלת שוב — עשרות מיילים על דבר שהמשרד כבר
// יודע עליו, ואישור ללקוח על הזמנה מלפני שבוע.
//
// ההחלפה נעשית על אובייקט ה-exports **לפני** טעינת הצינור: createOrder
// ו-index שולפים את הפונקציות ב-require, ולכן הם מקבלים את הגרסה השותקת.
// השרת עצמו אינו מושפע — זה תהליך נפרד, והזמנות חדשות ממשיכות לשלוח כרגיל.
const emailSender = require("../lib/email-sender/sender");
emailSender.sendOrderNotificationEmail = async () => {};
emailSender.sendEmailSilent = async () => {};

const { reprocess } = require("../lib/order-ingestion");
const { onOrderStatusChange } = require("../lib/billing/autoDeliveryNote");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const valueOf = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

const since = valueOf("since") ? new Date(`${valueOf("since")}T00:00:00+03:00`) : null;
const only = valueOf("only")
  ? new Set(valueOf("only").split(",").map((s) => s.trim()).filter(Boolean))
  : null;

const when = (date) =>
  new Date(date).toLocaleString("sv-SE", { timeZone: "Asia/Jerusalem" }).slice(0, 16);

const run = async () => {
  if (since && Number.isNaN(since.getTime())) {
    console.log("תאריך לא תקין ב---since. דוגמה: --since=2026-10-08");
    process.exit(1);
  }

  await connectDB();
  // connectDB תופס שגיאות חיבור ורק מדפיס אותן
  if (mongoose.connection.readyState !== 1) process.exit(1);

  // אותו תנאי שלפיו reprocess מוחק: שגיאה פתוחה שאדם עוד לא אישר
  const query = {
    "ingestionError.code": { $exists: true, $ne: null },
    "ingestionError.resolvedAt": null,
    incomingOrder: { $exists: true, $ne: null },
  };
  if (since) query.createdAt = { $gte: since };

  const orders = (
    await Order.find(query)
      .select("invoice incomingOrder createdAt cart user_info.name ingestionError.code")
      .sort({ createdAt: 1 })
      .lean()
  ).filter((o) => !only || only.has(String(o.invoice)));

  console.log(
    `${orders.length} הזמנות שגיאה פתוחות` +
      (since ? ` מאז ${when(since)}` : "") +
      (only ? ` (מתוך ${only.size} שהתבקשו)` : "") +
      (APPLY ? "\n" : " — רשימה בלבד, להרצה הוסף --apply\n")
  );

  const stats = { created: 0, failedAgain: 0, other: 0, crashed: 0 };

  for (const order of orders) {
    const label = `#${order.invoice} ${when(order.createdAt)} ${String(order.user_info?.name || "").slice(0, 24)}`;

    if (!APPLY) {
      console.log(`  ${label} — ${order.ingestionError.code}, ${(order.cart || []).length} פריטים`);
      continue;
    }

    try {
      const doc = await reprocess(order.incomingOrder);
      if (doc.status === "order_created") {
        stats.created++;
        // התעודה נוצרת בשרת ברקע, בלי await (utils/logStatusChange). בסקריפט
        // אין "רקע": החיבור נסגר לפני שהיא נשמרת, וההזמנה נשארת בלי נייר.
        // מחכים לה כאן במפורש — היצירה אידמפוטנטית, קריאה כפולה אינה יוצרת שתיים.
        const note = await onOrderStatusChange({
          orderId: doc.order,
          toStatusName: "Processing",
          changedBy: `orderIngestion:${doc.channel}`,
        });
        console.log(
          `  ✅ ${label} → הזמנה ${doc.invoice}` + (note ? `, תעודה ${note.number}` : ", בלי תעודה")
        );
      } else if (doc.status === "failed") {
        stats.failedAgain++;
        console.log(`  ❌ ${label} → ${doc.invoice ? `שגיאה ${doc.invoice}` : "בלי הזמנה"} (${doc.errorCode || "?"})`);
      } else {
        stats.other++;
        console.log(`  ⚠️  ${label} → סטטוס "${doc.status}"`);
      }
    } catch (err) {
      // הזמנה אחת שנופלת לא עוצרת את השאר
      stats.crashed++;
      console.log(`  💥 ${label} — ${err.message}`);
    }
  }

  if (APPLY) {
    console.log(
      `\nנכנסו תקין: ${stats.created} · נכשלו שוב: ${stats.failedAgain}` +
        ` · סטטוס אחר: ${stats.other} · נפלו: ${stats.crashed}`
    );
  }

  // חיוב מיידי של לקוח perDelivery (אם יש) רץ בלי await — נותנים לו לסיים
  if (APPLY) await new Promise((resolve) => setTimeout(resolve, 5000));
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

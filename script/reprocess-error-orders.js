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
// משלוח, נשלח מייל לצוות (ללקוח לא — ראה למטה), והיא עולה לליקוט. על הזמנה
// מלפני שבוע שכבר סופקה זו אספקה כפולה — לכן יש --since ו---only. לדוח "מה
// היה עובר" בלי לכתוב: npm run ingest:replay.
//
// הזמנה שנכשלת שוב חוזרת כהזמנת שגיאה חדשה, ונשלחת עליה התראת כשל לצוות.

require("dotenv").config();
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const Order = require("../models/Order");

// ── בלי מייל ללקוח, בסקריפט הזה בלבד ──
//
// הודעת "התקבלה הזמנה חדשה" יוצאת בנמען אחד לצוות וללקוח גם יחד. בהרצה
// חוזרת ההזמנה בת כמה ימים, והלקוח היה מקבל עליה אישור כאילו נשלחה עכשיו.
// הצוות ממשיך לקבל את ההודעה; רק כתובת הלקוח מוסרת.
//
// ההחלפה נעשית על אובייקט ה-exports **לפני** טעינת הצינור: createOrder שולף
// את הפונקציה ב-require, ולכן הוא מקבל את העטיפה. השרת עצמו אינו מושפע —
// זה תהליך נפרד.
const emailSender = require("../lib/email-sender/sender");
const sendToStaffAndCustomer = emailSender.sendOrderNotificationEmail;
emailSender.sendOrderNotificationEmail = (order, customer) =>
  sendToStaffAndCustomer(order, { ...customer, email: "" });

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

  // שליחת המיילים אינה ב-await — נותנים לה לסיים לפני סגירת התהליך
  if (APPLY) await new Promise((resolve) => setTimeout(resolve, 8000));
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

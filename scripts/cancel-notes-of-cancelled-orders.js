// scripts/cancel-notes-of-cancelled-orders.js
//
// מבטל תעודות משלוח שנשארו פתוחות מול הזמנות שבוטלו.
//
// הרקע: עד 13/10/26 ביטול הזמנה לא נגע בתעודה שלה. הסנכרון
// (deliveryNotes.syncFromOrder) רץ רק על שינוי בעגלה, בהנחה או במשלוח,
// ושינוי סטטוס לא היה ברשימה — כך שהתעודה נשארה "ממתינה לחיוב" והייתה
// נכנסת לחשבונית החודשית. מאז התיקון הביטול מגיע לתעודה מעצמו; הסקריפט
// הזה מטפל במה שבוטל לפניו.
//
// הוא אינו מבטל בעצמו אלא קורא לאותו syncFromOrder, כדי שהכללים יהיו
// אותם כללים: תעודה שחויבה או נתפסה לחיוב אינה משתנה, והיא מדווחת כאן
// כמי שדורשת חשבונית זיכוי.
//
//   node scripts/cancel-notes-of-cancelled-orders.js          # דוח בלבד
//   node scripts/cancel-notes-of-cancelled-orders.js --apply  # ביטול בפועל

require("dotenv").config();
const mongoose = require("mongoose");
const DeliveryNote = require("../models/DeliveryNote");
const Order = require("../models/Order");
const Status = require("../models/Status");
const { syncFromOrder } = require("../lib/billing/deliveryNotes");

const APPLY = process.argv.includes("--apply");

const describe = (n) =>
  `תעודה ${n.number} (${n.kind === "manual" ? "ידנית" : "אוטומטית"}) · ` +
  `הזמנה ${n.orderNumber || n.order} · ${n.customerSnapshot?.name || "ללא שם"} · ${n.total}₪`;

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const cancelStatus = await Status.findOne({ name: "Cancel" }).select("_id").lean();
  if (!cancelStatus) throw new Error('הסטטוס "Cancel" לא נמצא');

  const cancelledOrderIds = await Order.find({ status: cancelStatus._id }).distinct("_id");

  const notes = await DeliveryNote.find({
    order: { $in: cancelledOrderIds },
    "billing.status": { $ne: "cancelled" },
  })
    .select("number kind order orderNumber total customerSnapshot.name billing.status billing.icountDocNum")
    .sort({ number: 1 })
    .lean();

  const open = notes.filter((n) => n.billing?.status === "open");
  const locked = notes.filter((n) => n.billing?.status !== "open");

  console.log(`הזמנות מבוטלות: ${cancelledOrderIds.length}`);
  console.log(`תעודות פתוחות מולן: ${open.length}`);
  for (const n of open) console.log(`  ${describe(n)}`);

  if (locked.length) {
    console.log(`\nתעודות שכבר חויבו או נתפסו לחיוב — לא ישתנו, נדרשת חשבונית זיכוי: ${locked.length}`);
    for (const n of locked) {
      console.log(`  ${describe(n)} · ${n.billing?.status} · חשבונית ${n.billing?.icountDocNum || "—"}`);
    }
  }

  if (!APPLY) {
    console.log("\nדוח בלבד. להרצה בפועל: --apply");
  } else {
    const orderIds = [...new Set(open.map((n) => String(n.order)))];
    for (const orderId of orderIds) {
      await syncFromOrder(orderId, { changedBy: "ניקוי תעודות של הזמנות מבוטלות" });
    }

    const left = await DeliveryNote.countDocuments({
      _id: { $in: open.map((n) => n._id) },
      "billing.status": "open",
    });
    console.log(`\nבוטלו ${open.length - left} תעודות${left ? `, ${left} נשארו פתוחות` : ""}`);
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

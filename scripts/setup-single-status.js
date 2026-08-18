// scripts/setup-single-status.js
//
// מעבר לסטטוס אחד: "טופלה".
//
//   node scripts/setup-single-status.js --dry         בדיקה בלבד
//   node scripts/setup-single-status.js               ביצוע
//   node scripts/setup-single-status.js --backfill    ובנוסף השלמת תעודות חסרות
//
// עד השינוי הזה הזמנה עברה שני סטטוסים: "בטיפול" בקליטה, ו"נמסרה" כשמישהו
// סימן אותה ידנית בפאנל — ורק אז נוצרה תעודת המשלוח. הסימון הידני הוא
// שלב שאיש לא זוכר לבצע, ובלעדיו אין תעודה ולכן אין חיוב.
//
// מעכשיו יש סטטוס אחד. שני דברים משתנים במסד:
//
//   1. "Processing" מקבל שם עברי "טופלה".
//      השם הפנימי (name) נשאר "Processing" בכוונה — כל הקוד מחפש לפיו
//      (Status.findOne({ name: "Processing" })), ושינוי שלו היה מנתק את
//      הקליטה, את הדשבורד ואת אפליקציית הליקוט בבת אחת.
//
//   2. "Delivered" מכובה (isActive=false).
//      מכובה ולא נמחק: הדשבורד קורא את המזהה שלו ישירות
//      (deliveredStatus._id), ומחיקה הייתה מפילה אותו. כיבוי מוציא אותו
//      מתפריט הסטטוסים בפאנל — getAllStatuses מסנן isActive — ומשאיר
//      הזמנות היסטוריות מוצגות נכון.
//
// הסקריפט אידמפוטנטי: הרצה חוזרת לא משנה דבר.

require("dotenv").config();
const mongoose = require("mongoose");

const Status = require("../models/Status");
const Order = require("../models/Order");
const DeliveryNote = require("../models/DeliveryNote");

const args = process.argv.slice(2);
const DRY = args.includes("--dry") || args.includes("--dry-run");
const BACKFILL = args.includes("--backfill");

const HANDLED_HE_NAME = "טופלה";

const log = (msg) => console.log(msg);
const step = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

/** 1. "Processing" → "טופלה" */
const renameProcessing = async () => {
  step('שם הסטטוס "Processing"');

  const status = await Status.findOne({ name: "Processing" });
  if (!status) {
    throw new Error(
      'הסטטוס "Processing" לא נמצא במסד — בלעדיו קליטת ההזמנות לא עובדת. ' +
        "יש להריץ script/init-db.js או ליצור אותו בפאנל."
    );
  }

  log(`   כרגע: "${status.heName}"${status.isActive ? "" : " (מכובה)"}`);

  if (status.heName === HANDLED_HE_NAME && status.isActive) {
    return log("   כבר תקין");
  }
  if (DRY) return log(`   [dry] היה משתנה ל-"${HANDLED_HE_NAME}" ומופעל`);

  status.heName = HANDLED_HE_NAME;
  status.isActive = true;
  await status.save();
  log(`   ✅ "${HANDLED_HE_NAME}", פעיל`);
};

/** 2. כיבוי "Delivered" */
const disableDelivered = async () => {
  step('הסטטוס "Delivered"');

  const status = await Status.findOne({ name: "Delivered" });
  if (!status) return log("   לא קיים במסד — אין מה לכבות");

  const inUse = await Order.countDocuments({ status: status._id });
  log(`   "${status.heName}" · ${inUse} הזמנות היסטוריות בסטטוס הזה`);

  if (!status.isActive) return log("   כבר מכובה");
  if (DRY) return log("   [dry] היה מכובה ונעלם מתפריט הסטטוסים");

  status.isActive = false;
  await status.save();
  log("   ✅ מכובה — לא יופיע יותר בתפריט בפאנל");
  if (inUse) {
    log(`   ${inUse} ההזמנות ההיסטוריות ממשיכות להציג "${status.heName}" כרגיל`);
  }
};

/** 3. כמה הזמנות ב"טופלה" עדיין בלי תעודה */
const reportMissingNotes = async () => {
  step("תעודות חסרות");

  const handled = await Status.findOne({ name: "Processing" }).select("_id").lean();
  const orders = await Order.find({ status: handled._id }).select("_id invoice").lean();

  const withNotes = new Set(
    (
      await DeliveryNote.find({ order: { $in: orders.map((o) => o._id) } })
        .select("order")
        .lean()
    ).map((n) => String(n.order))
  );

  const missing = orders.filter((o) => !withNotes.has(String(o._id)));
  log(`   ${orders.length} הזמנות ב"${HANDLED_HE_NAME}" · ${missing.length} בלי תעודה`);

  if (!missing.length) return;

  if (!BACKFILL) {
    log("   אלה הזמנות שנקלטו לפני השינוי ולכן לא חויבו.");
    log("   להשלמה: הרצה חוזרת עם --backfill");
    return;
  }
  if (DRY) return log(`   [dry] --backfill היה מפיק תעודה ל-${missing.length} הזמנות`);

  const { backfill } = require("../lib/billing/autoDeliveryNote");
  const stats = await backfill();
  log(
    `   ✅ ${stats.created} תעודות הופקו · ${stats.manualOnly} ממתינות לתעודה ידנית · ` +
      `${stats.failed} נכשלו`
  );
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  log(DRY ? "מצב בדיקה — שום דבר לא ישתנה\n" : "");

  try {
    await renameProcessing();
    await disableDelivered();
    await reportMissingNotes();

    step("סיכום");
    log(`   הזמנה שנקלטת נכנסת ל"${HANDLED_HE_NAME}" ומקבלת תעודת משלוח מיד.`);
    log("   כל שינוי בהזמנה מרענן את התעודה, כל עוד היא לא חויבה בחשבונית.");
  } finally {
    await mongoose.disconnect();
  }
})().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});

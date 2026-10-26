// script/backfill-original-printed.js
//
// חד-פעמי, אחרי פריסת "מקור יש רק אחד" (26/10/2026): תעודה שהמדפסת
// האוטומטית כבר הדפיסה לפני הפריסה מסומנת כאילו המקור שלה יצא, כדי
// שהדפסה חוזרת שלה תהיה "העתק". התאריך הוא printedAt של משימת ההדפסה.
//
// הדפסות מהדפדפן לפני הפריסה לא נרשמו בשום מקום, ולכן אין מה להשלים עליהן.
//
// שימוש:
//   DRY_RUN=1 node script/backfill-original-printed.js   # רק סופר
//   node script/backfill-original-printed.js

require("dotenv").config();
const mongoose = require("mongoose");
const PrintJob = require("../models/PrintJob");
const DeliveryNote = require("../models/DeliveryNote");

const DRY_RUN = process.env.DRY_RUN === "1";

const run = async () => {
  const dbName = process.env.MONGO_DB_NAME;
  await mongoose.connect(process.env.MONGO_URI, dbName ? { dbName } : {});
  console.log(`מסד: ${mongoose.connection.name}${DRY_RUN ? " (הרצה יבשה)" : ""}\n`);
  // בניית האינדקסים של המודל רצה ברקע; ניתוק לפני שסיימה מדפיס אזהרת
  // "תעודה כפולה" מבהילה ולא נכונה. כשל אמיתי כבר נרשם בלוג ע"י המודל,
  // ואינו סיבה לעצור את ההשלמה
  await DeliveryNote.init().catch(() => {});

  // printedAt מתאפס בהדפסה חוזרת שעוד ממתינה; createdAt הוא קירוב סביר
  const jobs = await PrintJob.find({ docType: "deliveryNote", status: "printed" })
    .select("docId printedAt createdAt")
    .lean();

  let updated = 0;
  for (const job of jobs) {
    const filter = { _id: job.docId, originalPrintedAt: null };
    if (DRY_RUN) {
      if (await DeliveryNote.exists(filter)) updated++;
      continue;
    }
    const res = await DeliveryNote.updateOne(filter, {
      $set: { originalPrintedAt: job.printedAt || job.createdAt },
    });
    updated += res.modifiedCount;
  }

  console.log(`משימות שהודפסו: ${jobs.length}, תעודות ${DRY_RUN ? "שיסומנו" : "שסומנו"}: ${updated}`);
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});

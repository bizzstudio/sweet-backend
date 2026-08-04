// script/clean-ingestion-notes.js
//
// גיזום פירוט הכשל מ-customer_note של הזמנות שגיאה שנוצרו לפני התיקון.
//
// הרצה:   npm run notes:clean            (דוח בלבד — לא נוגע בכלום)
//         npm run notes:clean -- --apply (מבצע בפועל, עם גיבוי)
//
// ── למה זה קיים ──
//
// עד התיקון, createErrorOrder דחף לתוך customer_note את כל דוח הקליטה:
// "[⚠ שגיאה בקריאה] <הודעת הכשל> | פריטים שלא זוהו ואינם בהזמנה: ... |
//  הסכום בהזמנה חלקי — ...". הפרטים האלה כבר יושבים ב-ingestionError ומוצגים
// בבאנר שבראש מסך ההזמנה, ולכן זו הייתה כפילות שהטביעה את מה שהלקוח באמת כתב.
// גרוע מכך: ההערה מודפסת על התעודה, ומצוטטת תחת הכותרת "הערות הלקוח" במייל
// שנשלח *ללקוח* אחרי אישור ההזמנה.
//
// הקוד תוקן, אבל הזמנות שכבר נוצרו נושאות את ההערה הישנה במסד. הסקריפט הזה
// מנקה אותן.
//
// ── למה לא פשוט לחתוך עד ה-" | " האחרון ──
//
// הודעת הכשל עצמה עלולה להכיל " | " (למשל הערת לקוח שנספחה אליה), וחיתוך עיוור
// היה בולע גם את הערת הלקוח. במקום זה הסקריפט *משחזר* את הקידומת המדויקת
// מתוך ingestionError — אותו ביטוי בדיוק שבנה אותה — ומסיר אותה רק אם ההערה
// באמת מתחילה בה. הזמנה שההערה שלה נערכה ידנית מאז לא נוגעים בה, והיא מדווחת
// לבדיקה ידנית.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const { INGESTION_ERROR_STATUS_HE } = require("../utils/ingestionStatus");

const APPLY = process.argv.includes("--apply");

// משכפל את CHANNEL_LABELS של lib/order-ingestion/createOrder.js. הוא לא מיוצא,
// וייצוא שלו רק בשביל סקריפט חד-פעמי אינו מצדיק את עצמו.
const CHANNEL_LABELS = { whatsapp: "ווצאפ", email: "מייל", manual: "הרצה ידנית" };

const LEGACY_MARKER = `[⚠ ${INGESTION_ERROR_STATUS_HE}]`;

/**
 * שחזור הקידומת שהקוד הישן בנה, מתוך ingestionError.
 * חייב להישאר זהה תו-בתו לביטוי שהיה ב-createErrorOrder.
 */
const legacyPrefix = (err) => {
  const lines = [`${LEGACY_MARKER} ${err.message}`];
  const unmatched = err.unmatchedItems || [];
  if (unmatched.length) {
    lines.push(
      `פריטים שלא זוהו ואינם בהזמנה: ${unmatched
        .map((i) => `"${i.rawName}" (${i.failReason || "לא זוהה"})`)
        .join("; ")}`
    );
    lines.push("הסכום בהזמנה חלקי — חסרים בה הפריטים שלא זוהו");
  }
  return lines.join(" | ");
};

const run = async () => {
  const dbName = process.env.MONGO_DB_NAME;
  await mongoose.connect(process.env.MONGO_URI, dbName ? { dbName } : {});
  console.log(`מסד: ${mongoose.connection.name}\n`);

  // כל הזמנה שההערה שלה נושאת את הסימון הישן. גם הזמנות שכבר אושרו נכללות —
  // ההערה מודפסת ונשלחת גם אחרי אישור, ולכן היא צריכה להתנקות גם שם.
  const orders = await Order.find(
    { customer_note: new RegExp(`^\\[⚠ ${INGESTION_ERROR_STATUS_HE}\\]`) },
    { invoice: 1, source: 1, customer_note: 1, ingestionError: 1 }
  ).lean();

  if (!orders.length) {
    console.log("אין הזמנות עם ההערה הישנה — אין מה לנקות.");
    await mongoose.disconnect();
    return;
  }

  const updates = [];
  const manual = [];

  for (const order of orders) {
    const err = order.ingestionError;
    if (!err?.message) {
      manual.push({ invoice: order.invoice, why: "אין ingestionError.message לשחזור הקידומת" });
      continue;
    }

    const prefix = legacyPrefix(err);
    if (!order.customer_note.startsWith(prefix)) {
      manual.push({ invoice: order.invoice, why: "ההערה אינה תואמת את הקידומת המשוחזרת (נערכה ידנית?)" });
      continue;
    }

    // מה שנשאר אחרי הקידומת — הערת הלקוח, אזהרת כתובת, יחידות וכו'
    const rest = order.customer_note.slice(prefix.length).replace(/^\s*\|\s*/, "").trim();

    // הקוד הישן החליף את סימון המקור בקידומת השגיאה; מחזירים אותו
    const sourceLabel = CHANNEL_LABELS[order.source] || "מקור לא ידוע";
    const cleaned = [`[הזמנה נקלטה אוטומטית מ${sourceLabel}]`, rest].filter(Boolean).join(" | ");

    updates.push({ _id: order._id, invoice: order.invoice, before: order.customer_note, after: cleaned });
  }

  console.log(`נמצאו ${orders.length} הזמנות עם ההערה הישנה.\n`);
  for (const u of updates) {
    console.log(`  הזמנה ${u.invoice}`);
    console.log(`    לפני:  ${u.before}`);
    console.log(`    אחרי:  ${u.after}\n`);
  }

  if (manual.length) {
    console.log(`⚠ ${manual.length} הזמנות דורשות בדיקה ידנית — לא ישונו:`);
    manual.forEach((m) => console.log(`    הזמנה ${m.invoice} — ${m.why}`));
    console.log("");
  }

  if (APPLY && updates.length) {
    const backupPath = path.join(
      __dirname,
      `../data/ingestion-notes-backup-${mongoose.connection.name}.json`
    );
    fs.writeFileSync(
      backupPath,
      JSON.stringify(
        updates.map((u) => ({ _id: u._id, invoice: u.invoice, customer_note: u.before })),
        null,
        2
      )
    );
    console.log(`גיבוי ההערות המקוריות: ${backupPath}`);

    await Order.bulkWrite(
      updates.map((u) => ({
        updateOne: { filter: { _id: u._id }, update: { $set: { customer_note: u.after } } },
      }))
    );
  }

  console.log(`${"─".repeat(60)}`);
  console.log(`לניקוי: ${updates.length}   לבדיקה ידנית: ${manual.length}`);
  console.log(
    APPLY
      ? "\nבוצע."
      : "\nדוח בלבד — לא בוצע שינוי. להרצה בפועל: npm run notes:clean -- --apply"
  );

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

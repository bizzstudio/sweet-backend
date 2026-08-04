// script/split-system-notes.js
//
// פיצול ההערה המאוחדת של הזמנות שנקלטו אוטומטית לפני הפרדת השדות.
//
// הרצה:   npm run notes:split            (דוח בלבד — לא נוגע בכלום)
//         npm run notes:split -- --apply (מבצע בפועל, עם גיבוי)
//
// ── למה זה קיים ──
//
// עד התיקון, buildCustomerNote דחף לתוך customer_note שלושה סוגי מידע שונים:
// סימון מקור הקליטה ("[הזמנה נקלטה אוטומטית מווצאפ]"), אזהרות והנחות של המנוע
// (כתובת חסרה, יחידות מדידה, כמות שהונחה) — ואת מה שהלקוח באמת כתב. השדה הזה
// מצוטט חזרה *ללקוח* במייל אישור ההזמנה תחת הכותרת "הערות הלקוח", ונשלח
// כ-Comments לחשבונית, ולכן הלקוח קיבל ציטוט של טקסט שהמערכת כתבה.
//
// היום המידע הפנימי יושב ב-Order.systemNote, ו-customer_note מכיל רק את הלקוח.
// הסקריפט הזה מעביר את ההזמנות הקיימות לאותו מבנה.
//
// ── איך מפצלים בלי לאבד את הערת הלקוח ──
//
// ההערה הישנה בנויה מקטעים מופרדים ב-" | ", שכל אחד מהם נבנה בקוד בביטוי
// קבוע. לכן מזהים את קטעי המערכת לפי הביטויים האלה בדיוק, וכל מה שאינו מוכר
// נחשב הערת לקוח ונשמר. הערת לקוח שהכילה בעצמה " | " מתפצלת לכמה קטעים
// לא-מוכרים ומחוברת חזרה באותו סדר — התוצאה זהה למקור. (הערת לקוח כזו אכן
// קיימת: index.js מחזיר שורות שלא היו פריט אל parsed.note ומחבר אותן ב-" | ".)
//
// הזמנה שכבר יש לה systemNote (נוצרה אחרי התיקון) אינה נוגעת, ולכן הרצה
// חוזרת של הסקריפט אינה משנה דבר.
//
// ── סדר הרצה מול notes:clean ──
//
// הזמנת שגיאה ישנה פותחת ב-"[⚠ שגיאה בקריאה]" ולא בסימון המקור, ולכן היא
// *אינה* נכנסת לסקריפט הזה כלל. יש להריץ קודם `npm run notes:clean` — הוא
// מחזיר להן את סימון המקור — ורק אחריו `npm run notes:split`.
//
// ── מגבלה ידועה ──
//
// קטע שהלקוח עצמו כתב והוא פותח באחת מקידומות המערכת (למשל הערה שמתחילה
// ב-"⚠ ") יסווג בטעות כהערת מערכת. הדוח מציג לפני/אחרי לכל הזמנה, וקיים גיבוי
// מלא — לכן זה נראה לעין לפני ואחרי הביצוע.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Order = require("../models/Order");

const APPLY = process.argv.includes("--apply");

// משכפל את CHANNEL_LABELS של lib/order-ingestion/createOrder.js. הוא לא מיוצא,
// וייצוא שלו רק בשביל סקריפט חד-פעמי אינו מצדיק את עצמו.
const CHANNEL_LABELS = { whatsapp: "ווצאפ", email: "מייל", manual: "הרצה ידנית" };
const SOURCE_MARKER = /^\[הזמנה נקלטה אוטומטית מ.+\]$/;

// הקידומות שהקוד הישן בנה לקטעי מערכת. חייבות להישאר זהות תו-בתו לביטויים
// שהיו ב-buildCustomerNote (והיום ב-buildSystemNote).
const SYSTEM_PREFIXES = [
  "⚠ ",                                  // אזהרת כתובת חסרה
  "יחידות שהלקוח ציין — ",
  "נכתב בלי כמות ונלקחה יחידה אחת — ",
];

const isSystemPart = (part) =>
  SOURCE_MARKER.test(part) || SYSTEM_PREFIXES.some((p) => part.startsWith(p));

/**
 * פיצול הערה מאוחדת אחת. פונקציה טהורה — בלי DB — כדי שאפשר יהיה לבדוק אותה.
 *
 * @param {string} note   customer_note הקיים
 * @param {string} source Order.source ("whatsapp" / "email" / "manual")
 * @returns {{customerNote: string, systemNote: string} | {skip: string}}
 */
const splitNote = (note, source) => {
  const parts = String(note || "").split(" | ").map((p) => p.trim()).filter(Boolean);

  // סימון המקור הוא העוגן. בלעדיו אי אפשר לדעת שההערה אכן נבנתה בקוד הישן,
  // וניחוש כאן היה מוחק הערת לקוח אמיתית.
  if (!SOURCE_MARKER.test(parts[0] || "")) {
    return { skip: "ההערה אינה פותחת בסימון המקור (נערכה ידנית?)" };
  }

  // סימון המקור נבנה מחדש מ-source, כדי שהזמנה שההערה שלה נשמרה עם תווית
  // ישנה תקבל את התווית הנוכחית.
  const sourceLabel = CHANNEL_LABELS[source] || "מקור לא ידוע";
  const rest = parts.slice(1);

  return {
    systemNote: [
      `[הזמנה נקלטה אוטומטית מ${sourceLabel}]`,
      ...rest.filter(isSystemPart),
    ].join(" | "),
    customerNote: rest.filter((p) => !isSystemPart(p)).join(" | "),
  };
};

const run = async () => {
  const dbName = process.env.MONGO_DB_NAME;
  await mongoose.connect(process.env.MONGO_URI, dbName ? { dbName } : {});
  console.log(`מסד: ${mongoose.connection.name}\n`);

  // כל הזמנה שההערה שלה נושאת את סימון המקור ושעדיין לא פוצלה. גם הזמנות
  // שכבר אושרו ונשלחו נכללות — ההערה מודפסת ומוצגת גם אחרי אישור.
  const orders = await Order.find(
    {
      customer_note: /^\[הזמנה נקלטה אוטומטית מ/,
      $or: [{ systemNote: { $exists: false } }, { systemNote: "" }],
    },
    { invoice: 1, source: 1, customer_note: 1 }
  ).lean();

  if (!orders.length) {
    console.log("אין הזמנות עם הערה מאוחדת — אין מה לפצל.");
    await mongoose.disconnect();
    return;
  }

  const updates = [];
  const manual = [];

  for (const order of orders) {
    const split = splitNote(order.customer_note, order.source);
    if (split.skip) {
      manual.push({ invoice: order.invoice, why: split.skip });
      continue;
    }

    updates.push({
      _id: order._id,
      invoice: order.invoice,
      before: order.customer_note,
      customerNote: split.customerNote,
      systemNote: split.systemNote,
    });
  }

  console.log(`נמצאו ${orders.length} הזמנות עם הערה מאוחדת.\n`);
  for (const u of updates) {
    console.log(`  הזמנה ${u.invoice}`);
    console.log(`    לפני:          ${u.before}`);
    console.log(`    הערת לקוח:     ${u.customerNote || "(ריקה)"}`);
    console.log(`    הערת מערכת:    ${u.systemNote}\n`);
  }

  if (manual.length) {
    console.log(`⚠ ${manual.length} הזמנות דורשות בדיקה ידנית — לא ישונו:`);
    manual.forEach((m) => console.log(`    הזמנה ${m.invoice} — ${m.why}`));
    console.log("");
  }

  if (APPLY && updates.length) {
    const backupPath = path.join(
      __dirname,
      `../data/merged-notes-backup-${mongoose.connection.name}.json`
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
        updateOne: {
          filter: { _id: u._id },
          // הערת לקוח ריקה נמחקת ולא נשמרת כמחרוזת ריקה, כדי שהתצוגה
          // והמייל יתייחסו אליה כאל "אין הערה".
          update: u.customerNote
            ? { $set: { customer_note: u.customerNote, systemNote: u.systemNote } }
            : { $set: { systemNote: u.systemNote }, $unset: { customer_note: "" } },
        },
      }))
    );
  }

  console.log(`${"─".repeat(60)}`);
  console.log(`לפיצול: ${updates.length}   לבדיקה ידנית: ${manual.length}`);
  console.log(
    APPLY
      ? "\nבוצע."
      : "\nדוח בלבד — לא בוצע שינוי. להרצה בפועל: npm run notes:split -- --apply"
  );

  await mongoose.disconnect();
};

// הרצה רק כשהקובץ מופעל ישירות, כדי ש-splitNote תהיה ניתנת לבדיקה בלי DB.
if (require.main === module) {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { splitNote };

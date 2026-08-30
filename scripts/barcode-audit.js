// scripts/barcode-audit.js
//
// בדיקת תקינות הברקודים שמגיעים מהאקסל של מנוע (product.erp.barcode).
//
// מרגע שהתעודות והחשבוניות מזהות מוצר לפי ברקוד, ברקוד כפול או ערך זבל
// אינו רק אי-נוחות: הקלדת "2" שמחזירה ארבעה מוצרים היא שורה שגויה
// בתעודה, כלומר חיוב על מוצר שלא נמסר.
//
// הסקריפט מדווח בלבד ואינו משנה דבר. התיקון הוא באקסל של מנוע ובייבוא
// מחדש — לא כאן: ברקוד שנקבע ידנית במסד ייעלם בייבוא הבא.
//
//   node scripts/barcode-audit.js
//
// ⚠️ product.barcode (השדה ברמה העליונה) אינו נבדק כאן. הוא שדה של
//    תבנית החנות ומשמש לסדר תצוגה, והוא ריק בכל הקטלוג.

require("dotenv").config();
const mongoose = require("mongoose");
const Product = require("../models/Product");
const { MIN_SEARCHABLE_LENGTH } = require("../utils/barcode");

const nameOf = (p) => p.title?.he || p.title?.en || `מק"ט ${p.sku}`;

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const products = await Product.find({ sku: { $exists: true, $nin: [null, ""] } })
    .select("sku title erp.barcode")
    .lean();

  const missing = [];
  const tooShort = [];
  const nonNumeric = [];
  const byBarcode = new Map();

  for (const p of products) {
    const code = String(p.erp?.barcode ?? "").trim();

    if (!code) {
      missing.push(p);
      continue;
    }
    if (!/^\d+$/.test(code)) {
      nonNumeric.push({ p, code });
      continue;
    }
    if (code.length < MIN_SEARCHABLE_LENGTH) {
      tooShort.push({ p, code });
      // ממשיך לספירת הכפילויות: ערך קצר יכול להיות גם כפול
    }

    // נרמול אפסים מובילים, אותו נרמול שהחיפוש עושה — "0412" ו-"412"
    // הם התנגשות גם אם הם נראים שונה במסד
    const key = String(Number(code));
    if (!byBarcode.has(key)) byBarcode.set(key, []);
    byBarcode.get(key).push({ p, code });
  }

  const duplicates = [...byBarcode.entries()].filter(([, list]) => list.length > 1);

  console.log(`\nנבדקו ${products.length} מוצרים.\n`);
  console.log("─".repeat(72));

  console.log(`\n■ ללא ברקוד כלל: ${missing.length}`);
  if (missing.length) {
    console.log("  (יימצאו לפי שם או מק\"ט בלבד; הקלדת ברקוד לא תמצא אותם)");
    for (const p of missing.slice(0, 20)) {
      console.log(`    מק"ט ${p.sku} · ${nameOf(p)}`);
    }
    if (missing.length > 20) console.log(`    ...ועוד ${missing.length - 20}`);
  }

  console.log(`\n■ ברקוד שאינו מספרי: ${nonNumeric.length}`);
  for (const { p, code } of nonNumeric) {
    console.log(`    "${code}" · מק"ט ${p.sku} · ${nameOf(p)}`);
  }

  console.log(
    `\n■ ברקוד קצר מ-${MIN_SEARCHABLE_LENGTH} ספרות (לא ניתן לחיפוש): ${tooShort.length}`
  );
  for (const { p, code } of tooShort) {
    console.log(`    "${code}" · מק"ט ${p.sku} · ${nameOf(p)}`);
  }

  console.log(`\n■ ברקודים כפולים: ${duplicates.length} קבוצות`);
  if (duplicates.length) {
    console.log(
      "  הקלדת ברקוד כזה תציג בחירה במקום להוסיף שורה — לא תקלה, אבל מאט.\n"
    );
    for (const [key, list] of duplicates.sort((a, b) => b[1].length - a[1].length)) {
      console.log(`    ברקוד ${key} — ${list.length} מוצרים:`);
      for (const { p, code } of list) {
        console.log(`        "${code}" · מק"ט ${p.sku} · ${nameOf(p)}`);
      }
    }
  }

  const affected =
    new Set([
      ...nonNumeric.map((x) => String(x.p._id)),
      ...tooShort.map((x) => String(x.p._id)),
      ...duplicates.flatMap(([, list]) => list.map((x) => String(x.p._id))),
    ]).size;

  const unusable = nonNumeric.length + tooShort.length;

  console.log("\n" + "─".repeat(72));
  console.log(
    `סיכום: ${affected} מוצרים דורשים תשומת לב מתוך ${products.length}.\n\n` +
      `${unusable} מהם נושאים ערך שאינו ברקוד (utils/barcode.js פוסל אותו),\n` +
      `ולכן המערכת מתייחסת אליהם כאל מוצרים בלי ברקוד: הם לא יודפסו עם\n` +
      `ברקוד על תעודה או חשבונית — יופיע להם המק"ט — ולא ניתן למצוא אותם\n` +
      `בהקלדת ברקוד. הם עדיין נמצאים בחיפוש לפי שם ולפי מק"ט.\n\n` +
      `התיקון נעשה בקובץ האקסל של מנוע ובייבוא מחדש — ברקוד שיתוקן ידנית\n` +
      `במסד יידרס בייבוא הבא.\n`
  );

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

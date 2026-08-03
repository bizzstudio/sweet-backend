// script/set-stock.js
//
// קביעת מלאי אחיד לכל המוצרים בקטלוג.
//
// שימושי כשהקטלוג יובא מאקסל בלי נתוני מלאי, ורוצים לפתוח את כולם למכירה
// בלי לנהל מלאי אמיתי לכל פריט.
//
// שימוש:
//   npm run stock:set -- --value 500          # קובע 500 לכל המוצרים
//   npm run stock:set -- --value 500 --dry    # מראה מה ישתנה, בלי לכתוב
//   npm run stock:set -- --value 500 --only-zero   # רק למוצרים שהמלאי שלהם 0
//
// שים לב: זו כתיבה גורפת למסד. ההרצה מדפיסה את מצב הקטלוג לפני ואחרי.

require("dotenv").config();
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const Product = require("../models/Product");

const argv = process.argv.slice(2);
const getArg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const value = Number(getArg("value"));
const isDry = hasFlag("dry");
const onlyZero = hasFlag("only-zero");

if (!Number.isFinite(value) || value < 0) {
  console.error(`
חסר או שגוי --value.

  npm run stock:set -- --value 500
  npm run stock:set -- --value 500 --dry         # בלי לכתוב
  npm run stock:set -- --value 500 --only-zero   # רק מלאי 0
`);
  process.exit(1);
}

const line = () => console.log("─".repeat(60));

const run = async () => {
  await connectDB();
  if (mongoose.connection.readyState !== 1) {
    console.error("אין חיבור למסד הנתונים. בדוק MONGO_URI ב-.env.");
    process.exit(1);
  }

  const filter = onlyZero
    ? { $or: [{ stock: 0 }, { stock: null }, { stock: { $exists: false } }] }
    : {};

  const total = await Product.countDocuments({});
  const affected = await Product.countDocuments(filter);

  line();
  console.log(`מסד: ${mongoose.connection.name}`);
  console.log(`סה"כ מוצרים בקטלוג: ${total}`);
  console.log(`מוצרים שיושפעו:     ${affected}${onlyZero ? " (רק אלה עם מלאי 0)" : " (כולם)"}`);
  console.log(`מלאי חדש:           ${value}`);
  line();

  // התפלגות המלאי לפני
  const before = await Product.aggregate([
    { $group: { _id: null, min: { $min: "$stock" }, max: { $max: "$stock" }, avg: { $avg: "$stock" } } },
  ]);
  if (before[0]) {
    console.log(
      `מלאי לפני: מינימום ${before[0].min}, מקסימום ${before[0].max}, ממוצע ${Number(before[0].avg).toFixed(1)}`
    );
  }

  if (isDry) {
    console.log("\n[--dry] לא נכתב שום דבר.");
    await mongoose.connection.close();
    process.exit(0);
  }

  const result = await Product.updateMany(filter, { $set: { stock: value } });
  console.log(`\nעודכנו ${result.modifiedCount} מוצרים.`);

  const after = await Product.aggregate([
    { $group: { _id: null, min: { $min: "$stock" }, max: { $max: "$stock" }, avg: { $avg: "$stock" } } },
  ]);
  if (after[0]) {
    console.log(
      `מלאי אחרי: מינימום ${after[0].min}, מקסימום ${after[0].max}, ממוצע ${Number(after[0].avg).toFixed(1)}`
    );
  }

  // ── תזכורת: מלאי אינו החוסם היחיד ──
  // מוצר בלי מחיר לא ייכנס להזמנה גם עם מלאי, כי הוא היה יוצר הזמנה בסך 0.
  const noPrice = await Product.countDocuments({
    $or: [{ "prices.price": 0 }, { "prices.price": null }, { "prices.price": { $exists: false } }],
  });
  if (noPrice > 0) {
    line();
    console.log(`⚠️  ${noPrice} מוצרים עדיין ללא מחיר (0).`);
    console.log("   מוצר בלי מחיר לא ייכנס להזמנה — הוא היה יוצר הזמנה בסך 0 ש\"ח.");
    console.log("   יש להגדיר מחירים במסך המוצרים או ביבוא מהאקסל.");
  }
  line();

  await mongoose.connection.close();
  process.exit(0);
};

run().catch(async (err) => {
  console.error("כשל:", err.message);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});

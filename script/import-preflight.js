// script/import-preflight.js
// בדיקה מקדימה של המסד לפני יבוא האקסל הראשון (מוצרים/לקוחות).
//
// הסקריפט קורא בלבד. הוא לא כותב, לא מעדכן ולא מוחק שום דבר, ולכן בטוח
// להריץ אותו גם מול מסד הפרודקשן. הוא חושף בדיוק את מה שאי אפשר לבדוק
// בלי מסד אמיתי: מק"טים כפולים או בטיפוס לא עקבי, אימיילים כפולים,
// והאם האינדקסים שהיבוא נשען עליהם באמת קיימים.
//
// שימוש:
//   npm run import:preflight
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const Product = require("../models/Product");
const Customer = require("../models/Customer");

const line = (char = "─") => console.log(char.repeat(64));
const ok = (msg) => console.log(`  ✔ ${msg}`);
const warn = (msg) => console.log(`  ⚠ ${msg}`);
const bad = (msg) => console.log(`  ✖ ${msg}`);

// שמות האינדקסים שהיבוא נשען עליהם, לפי המפתחות שלהם
const indexOnKeys = (indexes, keys) =>
  indexes.find(
    (index) =>
      JSON.stringify(Object.keys(index.key)) === JSON.stringify(keys)
  );

const checkIndexes = async (model, expected) => {
  let indexes = [];
  try {
    indexes = await model.collection.indexes();
  } catch (err) {
    warn(`לא ניתן לקרוא אינדקסים (${err.message})`);
    return;
  }

  expected.forEach(({ keys, unique, why }) => {
    const found = indexOnKeys(indexes, keys);
    const label = keys.join(" + ");
    if (!found) {
      warn(`אין אינדקס על ${label} — ${why}`);
      return;
    }
    if (unique && !found.unique) {
      warn(`האינדקס על ${label} קיים אבל אינו unique — ${why}`);
      return;
    }
    ok(`אינדקס על ${label}${found.unique ? " (unique)" : ""}`);
  });
};

// מוצא ערכים שחוזרים יותר מפעם אחת בשדה נתון
const duplicatesOf = async (model, field, extraMatch = {}) => {
  return model.aggregate([
    { $match: { [field]: { $nin: [null, ""] }, ...extraMatch } },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
  ]);
};

const checkProducts = async () => {
  line();
  console.log("מוצרים");
  line();

  const total = await Product.countDocuments();
  console.log(`  סך המוצרים במסד: ${total}`);

  const withoutSku = await Product.countDocuments({
    $or: [{ sku: { $in: [null, ""] } }, { sku: { $exists: false } }],
  });
  if (withoutSku > 1) {
    warn(
      `${withoutSku} מוצרים בלי מק"ט. אם יש אינדקס unique על sku, יותר ממוצר` +
        ' אחד עם מק"ט ריק ייכשל בכתיבה'
    );
  } else {
    ok('לכל המוצרים (למעט אחד לכל היותר) יש מק"ט');
  }

  // היבוא מתאים לפי מק"ט. מק"ט שנשמר כמספר במסד וכמחרוזת בקובץ לא היה
  // מזוהה, ולכן היבוא מחפש בשתי הצורות - כאן בודקים אם זה בכלל קיים
  const numericSku = await Product.countDocuments({ sku: { $type: "number" } });
  if (numericSku > 0) {
    warn(
      `${numericSku} מוצרים עם מק"ט שנשמר כמספר ולא כמחרוזת. היבוא מחפש בשתי` +
        " הצורות ולכן יזהה אותם, אבל כדאי לנרמל את הנתון"
    );
  } else {
    ok('כל המק"טים נשמרים כמחרוזת');
  }

  const dupSku = await duplicatesOf(Product, "sku");
  if (dupSku.length) {
    bad(`מק"טים כפולים במסד: ${dupSku.map((d) => `${d._id} (x${d.count})`).join(", ")}`);
    console.log(
      '     היבוא יעדכן רק את אחד מהם לכל מק"ט. כדאי לאחד לפני היבוא'
    );
  } else {
    ok('אין מק"טים כפולים');
  }

  const dupSlug = await duplicatesOf(Product, "slug");
  if (dupSlug.length) {
    warn(`slug כפול: ${dupSlug.map((d) => `${d._id} (x${d.count})`).join(", ")}`);
  } else {
    ok("אין slug כפול");
  }

  const withErp = await Product.countDocuments({ "erp.syncedAt": { $exists: true } });
  console.log(`  מוצרים שכבר סונכרנו מההנהח"ש: ${withErp}`);

  await checkIndexes(Product, [
    { keys: ["sku"], unique: true, why: 'היבוא מתאים מוצרים לפי מק"ט' },
    { keys: ["slug"], why: "החנות מאתרת מוצר לפי slug" },
  ]);
};

const checkCustomers = async () => {
  line();
  console.log("לקוחות");
  line();

  const total = await Customer.countDocuments();
  console.log(`  סך הלקוחות במסד: ${total}`);

  const dupEmail = await Customer.aggregate([
    { $match: { email: { $nin: [null, ""] } } },
    { $group: { _id: { $toLower: "$email" }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 10 },
  ]);
  if (dupEmail.length) {
    bad(
      `אימיילים כפולים במסד: ${dupEmail.map((d) => `${d._id} (x${d.count})`).join(", ")}`
    );
  } else {
    ok("אין אימיילים כפולים");
  }

  const registered = await Customer.countDocuments({ isRegistered: true });
  console.log(`  לקוחות רשומים (יש להם סיסמה): ${registered}`);
  console.log("     היבוא לא נוגע בסיסמאות ולא ב-isRegistered");

  const withErp = await Customer.countDocuments({
    "erp.customerNumber": { $exists: true, $ne: "" },
  });
  console.log(`  לקוחות שכבר מקושרים למספר לקוח בהנהח"ש: ${withErp}`);

  const placeholders = await Customer.countDocuments({
    email: { $regex: "@import\\.local$" },
  });
  if (placeholders > 0) {
    console.log(`  לקוחות עם מזהה פנימי (@import.local): ${placeholders}`);
    console.log("     יקבלו את האימייל האמיתי ברגע שיופיע בקובץ");
  }

  const noPhone = await Customer.countDocuments({
    $or: [{ phone: { $in: [null, ""] } }, { phone: { $exists: false } }],
  });
  console.log(`  לקוחות בלי טלפון: ${noPhone}`);

  await checkIndexes(Customer, [
    { keys: ["email"], unique: true, why: "אימייל הוא המזהה הייחודי של לקוח" },
    { keys: ["erp.customerNumber"], why: "היבוא מתאים לקוחות לפי מספר לקוח" },
    { keys: ["phone"], why: "היבוא והכניסה ב-SMS מחפשים לפי טלפון" },
  ]);
};

const main = async () => {
  console.log("\nבדיקה מקדימה ליבוא אקסל — קריאה בלבד, שום דבר לא נכתב\n");

  await connectDB();
  if (mongoose.connection.readyState !== 1) {
    console.log("\nההתחברות למסד נכשלה. בדוק MONGO_URI ב-.env\n");
    process.exit(1);
  }
  console.log(`  מסד: ${mongoose.connection.name}\n`);

  try {
    await checkProducts();
    await checkCustomers();
    line("═");
    console.log(
      "סיום. ✖ = לטפל לפני היבוא, ⚠ = כדאי לבדוק, ✔ = תקין.\n" +
        "אינדקסים חסרים נוצרים לבד בעליית השרת לפי המודלים.\n"
    );
  } catch (err) {
    console.log("\nהבדיקה נכשלה:", err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
};

main();

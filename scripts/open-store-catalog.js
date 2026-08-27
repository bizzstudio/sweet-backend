// scripts/open-store-catalog.js
//
// פותח את הקטלוג לתצוגה בחנות. הריצה אידמפוטנטית — אפשר להריץ שוב אחרי כל
// יבוא מוצרים חדש.
//
// רקע: כל 4,320 המוצרים וכל הקטגוריות (חוץ מהשורש "ראשי") היו בסטטוס "hide",
// ולכן ‎/products/store ו-‎/category/show החזירו רשימות ריקות והחנות נראתה
// ריקה גם כשהיו מחירים ומלאי.
//
// מה הסקריפט עושה:
//   1. מסמן "show" לקטגוריות האמיתיות ומצמיד להן אייקונים מקומיים.
//   2. מעביר את המוצר הבודד שנתקע בקטגוריית האשפה "40" אל "מזון" — אחרת הוא
//      אינו נגיש מאף מסלול קטגוריה בחנות.
//   3. מסמן "show" לכל המוצרים, למעט שורות שאינן מוצרים למכירה (שכירות,
//      זיכויים, הפרשי מחירים, תעודות שבוטלו וכו') שנכנסו לקטלוג מיבוא הנה"ח.
//
// הרצה:  node scripts/open-store-catalog.js          (הרצה יבשה: --dry)
require("dotenv").config();
const mongoose = require("mongoose");

const DRY = process.argv.includes("--dry");

// אייקוני הקטגוריות יושבים ב-public של החנות. הנתיב נשמר יחסי כדי שיעבוד גם
// כשהחנות מוגשת מתת-נתיב (‎/sweet-store) — ראה src/utils/basePath.js.
const CATEGORY_ICONS = {
  "מזון": "food",
  "פירות": "produce",
  'ח.ניקוי+ח"פ': "cleaning",
  "כללית": "general",
  "משרד": "office",
};

// שורות הנה"ח שנכנסו לקטלוג ואינן מוצרים: אין להן מחיר אמיתי ואסור שיופיעו
// בחנות. הביטוי נבדק מול כל 4,320 השמות ותפס 37 שורות — כולן חשבונאיות.
const NON_SELLABLE =
  /שכירות|זיכוי|הפרש|החזרת מוצר|חשבונית|עמלה|ריבית|הנחה כללית|משלוח|דמי |ביטול|טעות/;

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const Categories = db.collection("categories");
  const Products = db.collection("products");

  const log = (...a) => console.log(DRY ? "[dry]" : "[run]", ...a);

  // ---- 1. קטגוריות ----------------------------------------------------
  for (const [name, icon] of Object.entries(CATEGORY_ICONS)) {
    const cat = await Categories.findOne({ "name.he": name });
    if (!cat) {
      console.warn(`  ! קטגוריה לא נמצאה: ${name}`);
      continue;
    }
    const update = {
      status: "show",
      icon: `/category-icons/${icon}.svg`,
      coloredIcon: `/category-icons/${icon}_color.svg`,
    };
    if (!DRY) await Categories.updateOne({ _id: cat._id }, { $set: update });
    log(`קטגוריה "${name}" → show, icon=${icon}`);
  }

  // השורש "ראשי" חייב להישאר show — עליו נבנה עץ הקטגוריות בחנות
  if (!DRY) await Categories.updateOne({ slug: "home" }, { $set: { status: "show" } });

  // ---- 2. קטגוריית האשפה "40" ----------------------------------------
  const junkCat = await Categories.findOne({ "name.he": "40" });
  const foodCat = await Categories.findOne({ "name.he": "מזון" });
  if (junkCat && foodCat) {
    const stuck = await Products.countDocuments({ categories: junkCat._id });
    if (stuck && !DRY) {
      // $addToSet/$pull ולא $set על המערך: מוצר יכול להשתייך ליותר מקטגוריה
      // אחת, ודריסת המערך הייתה מוחקת שיוכים אחרים בלי להשאיר עקבות.
      // MongoDB אוסר $addToSet ו-$pull על אותו שדה בפקודה אחת, ולכן שני שלבים.
      await Products.updateMany(
        { categories: junkCat._id },
        { $addToSet: { categories: foodCat._id } }
      );
      await Products.updateMany(
        { categories: junkCat._id },
        { $pull: { categories: junkCat._id } }
      );
      // השדה category (יחיד) משמש ל-populate בחנות ומצביע על קטגוריית האם
      await Products.updateMany(
        { category: junkCat._id },
        { $set: { category: foodCat._id } }
      );
    }
    if (!DRY) await Categories.updateOne({ _id: junkCat._id }, { $set: { status: "hide" } });
    log(`קטגוריה "40" הוסתרה; ${stuck} מוצרים הועברו ל"מזון"`);
  }

  // ---- 3. מוצרים ------------------------------------------------------
  const hideFilter = {
    $or: [{ "prices.price": { $lte: 0 } }, { "title.he": { $regex: NON_SELLABLE } }],
  };
  const toHide = await Products.countDocuments(hideFilter);
  const toShow = await Products.countDocuments({ $nor: [hideFilter] });

  if (!DRY) {
    await Products.updateMany({ $nor: [hideFilter] }, { $set: { status: "show" } });
    await Products.updateMany(hideFilter, { $set: { status: "hide" } });
  }
  log(`מוצרים: ${toShow} → show, ${toHide} → hide (שורות הנה"ח)`);

  // ---- סיכום ----------------------------------------------------------
  const summary = await Products.aggregate([
    { $group: { _id: "$status", n: { $sum: 1 } } },
  ]).toArray();
  console.log("\nסטטוס מוצרים ב-DB:", summary);
  console.log(
    "קטגוריות פעילות:",
    (await Categories.find({ status: "show" }).toArray()).map((c) => c.name.he).join(", ")
  );

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// script/fix-category-tree.js
// תיקון עץ הקטגוריות: כל הקטגוריות בחנות חייבות להיות ילדים של קטגוריית
// שורש אחת ("Home"), כי דף הקטגוריות באדמין והתפריטים בחנות מציגים רק את
// data[0].children. קטגוריה בלי parentId נשמרת במסד אבל לא מופיעה בשום מסך -
// זה מה שקרה לקטגוריות שנוצרו ביבוא המוצרים מאקסל.
//
// הסקריפט יוצר את קטגוריית השורש אם היא חסרה, ותולה מתחתיה כל קטגוריה
// שנשארה בלי הורה. הוא לא מוחק ולא משנה שמות, ואפשר להריץ אותו שוב ושוב.
//
// שימוש:
//   node script/fix-category-tree.js --dry     (בדיקה בלבד, בלי לכתוב)
//   node script/fix-category-tree.js --hide    (גם מסתיר אותן מהחנות)
//   node script/fix-category-tree.js
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const Category = require("../models/Category");
const {
  resolveRootCategory,
  findRootCategory,
  isRootCategory,
} = require("../utils/rootCategory");

const isDry = process.argv.includes("--dry");
// --hide: הקטגוריות יופיעו באדמין אבל לא בתפריט החנות, עד שיוחלט מה להציג
const shouldHide = process.argv.includes("--hide");

const run = async () => {
  await connectDB();

  const categories = await Category.find({})
    .select("name slug parentId parentName")
    .lean();
  console.log(`סה"כ קטגוריות במסד: ${categories.length}`);

  const rootsBefore = categories.filter(isRootCategory);
  console.log(`קטגוריות בלי הורה: ${rootsBefore.length}`);

  if (rootsBefore.length <= 1) {
    console.log("עץ הקטגוריות תקין - יש בדיוק קטגוריית שורש אחת. אין מה לתקן.");
    return;
  }

  if (isDry) {
    // בהרצת בדיקה משתמשים באותו איתור שורש, רק בלי ליצור אותו במסד
    const existingRoot = findRootCategory(categories);
    console.log(
      existingRoot
        ? `שורש קיים: ${existingRoot.slug}`
        : 'לא נמצא שורש - תיווצר קטגוריית "ראשי" (slug: home)'
    );
    rootsBefore
      .filter((c) => String(c._id) !== String(existingRoot?._id))
      .forEach((c) =>
        console.log(
          `  → יעבור מתחת לשורש: ${c.name?.he || c.slug}${
            shouldHide ? " + יוסתר מהחנות" : ""
          }`
        )
      );
    return;
  }

  const root = await resolveRootCategory(categories);
  console.log(`קטגוריית השורש: ${root.name} (${root._id})`);

  const orphans = rootsBefore.filter(
    (category) => String(category._id) !== String(root._id)
  );

  for (const category of orphans) {
    const update = { parentId: String(root._id), parentName: root.name };
    if (shouldHide) update.status = "hide";

    await Category.updateOne({ _id: category._id }, { $set: update });
    console.log(
      `  ✔ ${category.name?.he || category.slug} → ${root.name}${
        shouldHide ? " (מוסתרת)" : ""
      }`
    );
  }

  console.log(`הועברו ${orphans.length} קטגוריות מתחת לשורש.`);
};

run()
  .catch((err) => {
    console.error("fix-category-tree error:", err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

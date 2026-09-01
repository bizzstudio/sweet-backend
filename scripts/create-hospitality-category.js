// scripts/create-hospitality-category.js
//
// יצירת קטגוריית "כיבוד".
//
// הרקע: הלקוחה ביקשה (30/08/26) שהחשבונית החודשית תפצל בין מזון, כיבוד
// וחד פעמי — יש לקוחות שדורשים את ההפרדה הזו במפורש (למשל 616, המרכז
// לטכנולוגיה חינוכית). הפיצול נעשה לפי הקטגוריה של המוצר, אבל "כיבוד"
// לא קיימת בשום מקום:
//
//   - לא בקטגוריות שלנו (מזון / פירות / ח.ניקוי+ח"פ / כללית / משרד)
//   - ולא בקיבוץ שהגיע ממנוע (erp.groupName — בדיוק אותן חמש)
//
// כלומר אין נתון שממנו אפשר לגזור אותה, וסיווג אוטומטי היה ניחוש. לכן
// הסקריפט יוצר את הקטגוריה **ריקה**, והשיוך נעשה במסך "שיוך מוצרים
// לקטגוריה" בפאנל.
//
// היחידים שמשויכים כאן הם מוצרים ששמם כבר מכיל "כיבוד" (--seed) — אלה
// פריטי חיוב מרוכזים שמשמשים לחייב אירוע שלם בשורה אחת, ואין ספק לגביהם.
//
//   node scripts/create-hospitality-category.js          # תצוגה בלבד
//   node scripts/create-hospitality-category.js --apply  # יצירה
//   node scripts/create-hospitality-category.js --apply --seed
//
// ⚠️ הקטגוריה נוצרת עם requiresManualNote=false, כמו מזון: הסחורה נמכרת
//    ביחידות ונכנסת לתעודה האוטומטית. רק פירות נשקלים.

require("dotenv").config();
const mongoose = require("mongoose");
const Category = require("../models/Category");
const Product = require("../models/Product");

const APPLY = process.argv.includes("--apply");
const SEED = process.argv.includes("--seed");

const NAME = "כיבוד";
const SLUG = "כיבוד";

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const existing = await Category.findOne({
    $or: [{ "name.he": NAME }, { slug: SLUG }],
  }).lean();

  // ההורה נלקח מקטגוריה קיימת ולא מקובע: הוא נוצר בייבוא, והמזהה שלו
  // אינו זהה בין סביבות
  const sibling = await Category.findOne({ "name.he": "מזון" }).lean();
  if (!sibling) {
    console.error('לא נמצאה קטגוריית "מזון" — אי אפשר לגזור ממנה את ההורה');
    process.exit(1);
  }

  // "חשבונית כיבוד שבוטלה" אינו כיבוד אלא שורת ביטול, ומקומו עם שאר
  // פריטי הביטול ("תעודת משלוח שבוטלה", "תעודת פרות שבוטלה")
  const candidates = await Product.find({
    "title.he": /כיבוד/,
    "title.he": { $regex: /כיבוד/, $not: /שבוטל/ },
  })
    .select("sku title.he category")
    .lean();

  if (existing) {
    const count = await Product.countDocuments({ category: existing._id });
    console.log(`✅ הקטגוריה "${NAME}" כבר קיימת (${existing._id}) · ${count} מוצרים משויכים`);
  } else {
    console.log(`הקטגוריה "${NAME}" אינה קיימת ותיווצר:`);
    console.log(`   הורה: ${sibling.parentName} (${sibling.parentId})`);
    console.log(`   תעודה ידנית: לא (נמכר ביחידות, כמו מזון)`);
  }

  console.log(`\nמוצרים ששמם מכיל "כיבוד" (${candidates.length}):`);
  for (const p of candidates) {
    console.log(`   מק"ט ${String(p.sku).padEnd(6)} ${p.title.he}`);
  }

  if (!APPLY) {
    console.log("\nהרצה בלבד. ליצירה: --apply   (ולשיוך המוצרים שלמעלה: --apply --seed)");
    await mongoose.disconnect();
    return;
  }

  let category = existing;
  if (!category) {
    category = await Category.create({
      name: { he: NAME, en: NAME },
      description: { he: "", en: "" },
      slug: SLUG,
      status: "show",
      parentId: sibling.parentId,
      parentName: sibling.parentName,
      icon: sibling.icon,
      coloredIcon: sibling.coloredIcon,
      // נמכר ביחידות ולא נשקל — נכנס לתעודה האוטומטית כמו מזון
      requiresManualNote: false,
    });
    console.log(`\n✅ הקטגוריה נוצרה: ${category._id}`);
  }

  if (SEED && candidates.length) {
    // category *וגם* categories: הראשון קובע את הפיצול בחשבונית, השני הוא
    // מה שהחנות מסננת לפיו. שדה אחד בלי השני משאיר את המוצר חצי-משויך.
    const res = await Product.updateMany(
      { _id: { $in: candidates.map((p) => p._id) } },
      { $set: { category: category._id, categories: [category._id] } }
    );
    console.log(`✅ ${res.modifiedCount} מוצרים שויכו ל"${NAME}"`);
  }

  console.log(
    `\nהשלב הבא: פאנל → קטלוג → "שיוך מוצרים לקטגוריה" — משם מעבירים\n` +
      `מוצרים מ"מזון" ל"${NAME}" בחיפוש ובסימון.\n\n` +
      `⚠️ ייבוא אקסל חוזר של המוצרים ידרוס את השיוך: הקובץ של מנוע מכיל\n` +
      `   "מזון" בעמודת הקבוצה. יש לבדוק אחרי כל ייבוא.`
  );

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

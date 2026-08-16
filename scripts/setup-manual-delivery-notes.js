// scripts/setup-manual-delivery-notes.js
//
// הכנת המסד להפרדה בין תעודה אוטומטית לתעודה ידנית.
//
//   node scripts/setup-manual-delivery-notes.js --dry        בדיקה בלבד
//   node scripts/setup-manual-delivery-notes.js              ביצוע
//   node scripts/setup-manual-delivery-notes.js --category="פירות וירקות"
//
// שלושה דברים, וכולם חייבים לקרות לפני שהקוד החדש רץ בייצור:
//
//   1. סימון kind="auto" על כל התעודות הקיימות.
//      האינדקס החדש שמונע שתי תעודות אוטומטיות לאותה הזמנה מסונן על
//      kind="auto". מסמך בלי השדה אינו נכנס לסינון, ולכן בלי השלב הזה
//      התעודות הישנות היו מאבדות את ההגנה בשקט.
//
//   2. הסרת האינדקס הייחודי הישן על order.
//      הוא אוסר שתי תעודות לאותה הזמנה — בדיוק מה שההפרדה דורשת (אחת
//      אוטומטית ואחת ידנית). mongoose לא מוחק אינדקס שהוסר מהסכמה, ולכן
//      זה נעשה כאן במפורש.
//
//   3. סימון קטגוריית הסחורה הנשקלת (ברירת מחדל: "פירות וירקות").
//      בלעדיו splitByNoteKind לא מוצא מה להוציא מהתעודה האוטומטית, והכל
//      ממשיך להתנהג כמו קודם — כלומר פירות מחויבים לפי המשקל המוזמן.
//
// הסקריפט אידמפוטנטי: הרצה חוזרת לא משנה דבר.

require("dotenv").config();
const mongoose = require("mongoose");

const DeliveryNote = require("../models/DeliveryNote");
const Category = require("../models/Category");

const args = process.argv.slice(2);
const DRY = args.includes("--dry") || args.includes("--dry-run");

// שם הקטגוריה בפועל במסד הוא "פירות" (367 מוצרים, כולל ירקות: גזר, מלפפון,
// עגבניות, חסה). "פירות וירקות" שמופיע ב-categoryController הוא שריד
// מהתבנית שממנה הפרויקט שוכפל ואינו קיים במסד.
const CATEGORY_NAME =
  (args.find((a) => a.startsWith("--category=")) || "").split("=")[1] || "פירות";

const log = (msg) => console.log(msg);
const step = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

/** 1. kind="auto" על כל התעודות הקיימות */
const backfillKind = async () => {
  step("סימון סוג התעודות הקיימות");

  const missing = await DeliveryNote.countDocuments({ kind: { $exists: false } });
  log(`   ${missing} תעודות ללא שדה kind`);

  if (!missing) return log("   אין מה לעדכן");
  if (DRY) return log("   [dry] היו מסומנות כ-auto");

  const res = await DeliveryNote.updateMany(
    { kind: { $exists: false } },
    { $set: { kind: "auto" } }
  );
  log(`   ✅ ${res.modifiedCount} תעודות סומנו כ-auto`);
};

/** 2. הסרת האינדקס הייחודי הישן על order */
const dropLegacyOrderIndex = async () => {
  step("אינדקס ההזמנה");

  const indexes = await DeliveryNote.collection.indexes();

  // האינדקס הישן: order בלבד, ייחודי, בלי partialFilterExpression. החדש
  // נראה כמעט זהה ולכן ההבחנה היא דווקא על היעדר הסינון
  const legacy = indexes.find(
    (i) =>
      i.unique &&
      !i.partialFilterExpression &&
      Object.keys(i.key).length === 1 &&
      i.key.order === 1
  );

  if (!legacy) return log("   האינדקס הישן כבר אינו קיים");
  log(`   נמצא אינדקס ישן: ${legacy.name}`);

  if (DRY) return log("   [dry] היה נמחק");

  await DeliveryNote.collection.dropIndex(legacy.name);
  log(`   ✅ ${legacy.name} נמחק`);
};

/** בניית האינדקסים החדשים מהסכמה */
const buildNewIndexes = async () => {
  step("בניית האינדקסים החדשים");
  if (DRY) return log("   [dry] createIndexes היה רץ");

  // לא syncIndexes: הוא מוחק כל אינדקס שאינו בסכמה, כולל כאלה שנוצרו ביד
  // לצרכי תפעול. כאן רוצים רק להוסיף
  await DeliveryNote.createIndexes();
  log("   ✅ האינדקסים נבנו");
};

/** 3. סימון קטגוריית הסחורה הנשקלת */
const flagCategory = async () => {
  step(`סימון הקטגוריה "${CATEGORY_NAME}"`);

  const already = await Category.find({ requiresManualNote: true })
    .select("name")
    .lean();

  if (already.length) {
    log(
      `   כבר מסומנות: ${already
        .map((c) => c.name?.he || c.name?.en || c._id)
        .join(", ")}`
    );
    return;
  }

  // התאמה על השם העברי. הקטגוריות נשמרות כאובייקט רב-לשוני, ולכן אין
  // דרך לשאול על השם בלי לציין שפה
  const matches = await Category.find({ "name.he": CATEGORY_NAME })
    .select("name parentId")
    .lean();

  if (!matches.length) {
    const all = await Category.find({}).select("name").lean();
    const names = all.map((c) => c.name?.he).filter(Boolean).slice(0, 40);
    log(`   ❌ לא נמצאה קטגוריה בשם "${CATEGORY_NAME}"`);
    log(`      קטגוריות קיימות: ${names.join(" · ")}`);
    log(`      יש להריץ שוב עם --category="השם המדויק", או לסמן מהפאנל`);
    return;
  }

  if (matches.length > 1) {
    log(`   ⚠️ ${matches.length} קטגוריות בשם הזה — כולן יסומנו`);
  }

  if (DRY) {
    return log(`   [dry] ${matches.length} קטגוריות היו מסומנות`);
  }

  const res = await Category.updateMany(
    { _id: { $in: matches.map((c) => c._id) } },
    { $set: { requiresManualNote: true } }
  );
  log(`   ✅ ${res.modifiedCount} קטגוריות סומנו`);
  log("      הבנות שלהן יורשות את הסימון אוטומטית — אין צורך לסמן כל אחת");
};

/** סיכום: מה בפועל יֵצא מהתעודה האוטומטית מעכשיו */
const summary = async () => {
  step("סיכום");

  const { manualNoteCategoryIds, clearCache } = require("../lib/billing/manualItems");
  clearCache();
  const ids = await manualNoteCategoryIds({ force: true });

  if (!ids.size) {
    log("   ⚠️ אין קטגוריות מסומנות — כל השורות ימשיכו להיכנס לתעודה האוטומטית");
    log("      כלומר החיוב החודשי עדיין לפי המשקל שהוזמן");
    return;
  }

  const Product = require("../models/Product");
  const affected = await Product.countDocuments({
    $or: [{ category: { $in: [...ids] } }, { categories: { $in: [...ids] } }],
  });

  log(`   ${ids.size} קטגוריות מסומנות · ${affected} מוצרים`);
  log("   מוצרים אלה לא ייכנסו יותר לתעודת המשלוח האוטומטית,");
  log("   ועליהם יש להפיק תעודה ידנית עם המשקל שנשקל בפועל.");
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  log(DRY ? "מצב בדיקה — שום דבר לא ישתנה\n" : "");

  try {
    await backfillKind();
    await dropLegacyOrderIndex();
    await buildNewIndexes();
    await flagCategory();
    await summary();
  } finally {
    await mongoose.disconnect();
  }
})().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});

// script/dedupe-products.js
//
// איתור וטיפול בכפילויות בקטלוג המוצרים.
//
// הרצה:   npm run products:dedupe            (דוח בלבד — לא נוגע בכלום)
//         npm run products:dedupe -- --apply (מבצע בפועל)
//         npm run products:dedupe -- --apply --loose  (כולל הבדלי סוגריים)
//
// ── למה זה קיים ──
//
// הזמנה אמיתית נתקעה כי "נייר אפייה 50 יחידות" קיים בקטלוג פעמיים: sku 1535
// ו-sku 160 ("נייר אפייה 50 יחידות (ח')"). מנוע ההתאמה נתן לשניהם ציון כמעט
// זהה (הפרש 0.4 מתוך 14,381), ולכן דיווח "אי אפשר להכריע" ושלח את הפריט
// לטיפול ידני. כל עוד שתי הרשומות קיימות, כל הזמנה של המוצר הזה תיתקע שוב.
//
// ── למה לא פשוט למחוק ──
//
// מוצר שכבר מופיע בהזמנה קיימת אינו ניתן למחיקה: ההזמנה מפנה אליו, ומחיקה
// תשבור היסטוריה. לכן שני מסלולים:
//
//   מוצר שאינו מופיע באף הזמנה  →  נמחק.
//   מוצר שמופיע בהזמנה          →  נשאר, אבל שמו מסומן ב-"[כפול-<sku>]" כדי
//                                   שלא יתחרה יותר על אותה שאילתה.
//
// בשני המקרים הרשומה ששורדת היא זו שיש לה היסטוריית הזמנות, ואם לאין — זו
// עם ה-sku הנמוך, שהיא המקורית מהיבוא.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Product = require("../models/Product");
const Order = require("../models/Order");

const APPLY = process.argv.includes("--apply");
const LOOSE = process.argv.includes("--loose");

const norm = (s) =>
  String(s || "").toLowerCase().replace(/["'`״׳''""]/g, "").replace(/\s+/g, " ").trim();

// הסרת סימון פנימי בסוגריים ("(ח')") — הבדל שאינו מבדיל מוצרים בפועל
const looseKey = (s) => norm(String(s || "").replace(/\([^)]*\)/g, " "));

const DUPLICATE_TAG = /\[כפול-[^\]]*\]/;

/**
 * כמה הזמנות מפנות למוצר. cart הוא מערך חופשי בסכמה, ולכן ההפניה נבדקת
 * בכמה שדות אפשריים — עדיף לספור יותר מאשר למחוק מוצר שמופיע בהיסטוריה.
 */
const countOrderRefs = async (product) => {
  const id = String(product._id);
  return Order.countDocuments({
    $or: [
      { "cart.id": id },
      { "cart._id": id },
      { "cart.productId": id },
      { "cart.sku": product.sku },
    ],
  });
};

const run = async () => {
  const dbName = process.env.MONGO_DB_NAME;
  await mongoose.connect(process.env.MONGO_URI, dbName ? { dbName } : {});
  console.log(`מסד: ${mongoose.connection.name}\n`);

  const all = await Product.find({}, { title: 1, sku: 1, status: 1, prices: 1, stock: 1 }).lean();

  const groups = new Map();
  all.forEach((p) => {
    const title = p.title?.he;
    // רשומה שכבר סומנה בריצה קודמת אינה מתחרה שוב
    if (!title || DUPLICATE_TAG.test(title)) return;
    const key = LOOSE ? looseKey(title) : norm(title);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });

  const duplicates = [...groups.values()].filter((v) => v.length > 1);

  if (!duplicates.length) {
    console.log("לא נמצאו כפילויות.");
    await mongoose.disconnect();
    return;
  }

  console.log(
    `נמצאו ${duplicates.length} קבוצות כפולות (${duplicates.reduce((s, v) => s + v.length, 0)} מוצרים)` +
      `${LOOSE ? " — כולל הבדלי סוגריים" : ""}\n`
  );

  let toDelete = 0;
  let toRename = 0;

  // גיבוי של כל מה שנמחק, לפני שנמחק. מחיקה ממסד נתונים אינה הפיכה, והמחיר
  // של קובץ JSON אחד זניח מול הסיכוי שהתברר בדיעבד ששתי רשומות לא היו זהות.
  const deleted = [];
  const backupPath = path.join(__dirname, `../data/dedupe-backup-${mongoose.connection.name}.json`);

  for (const group of duplicates) {
    // ספירת הפניות לכל חבר בקבוצה
    const withRefs = [];
    for (const p of group) withRefs.push({ ...p, refs: await countOrderRefs(p) });

    // השורד: הכי הרבה הזמנות, ובתיקו — ה-sku הנמוך (המקורי מהיבוא)
    withRefs.sort((a, b) => b.refs - a.refs || Number(a.sku) - Number(b.sku));
    const [keeper, ...losers] = withRefs;

    console.log(`\n• ${keeper.title.he}`);
    console.log(`    נשאר:  sku ${keeper.sku}  (${keeper.refs} הזמנות)`);

    for (const loser of losers) {
      if (loser.refs > 0) {
        toRename++;
        const newTitle = `${loser.title.he} [כפול-${keeper.sku}]`;
        console.log(`    סימון: sku ${loser.sku}  (${loser.refs} הזמנות — לא נמחק) → "${newTitle}"`);
        if (APPLY) {
          await Product.updateOne(
            { _id: loser._id },
            { $set: { "title.he": newTitle, status: "hide" } }
          );
        }
      } else {
        toDelete++;
        console.log(`    מחיקה: sku ${loser.sku}  (0 הזמנות)`);
        if (APPLY) {
          // המסמך המלא נשלף לגיבוי — ה-find למעלה החזיר שדות חלקיים בלבד
          const full = await Product.findById(loser._id).lean();
          if (full) deleted.push({ ...full, mergedInto: keeper.sku });
          await Product.deleteOne({ _id: loser._id });
        }
      }
    }
  }

  if (APPLY && deleted.length) {
    fs.writeFileSync(backupPath, JSON.stringify(deleted, null, 2));
    console.log(`\nגיבוי ${deleted.length} מוצרים שנמחקו: ${backupPath}`);
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`למחיקה: ${toDelete}   לסימון: ${toRename}`);
  console.log(
    APPLY
      ? "\nבוצע."
      : "\nדוח בלבד — לא בוצע שינוי. להרצה בפועל: npm run products:dedupe -- --apply"
  );

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

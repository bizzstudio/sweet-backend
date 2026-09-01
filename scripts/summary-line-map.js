// scripts/summary-line-map.js
//
// המוצר שמייצג שורת ריכוז בחשבונית, לכל קטגוריה.
//
// שורת "ריכוז תעודות משלוח" בחשבונית אינה טקסט חופשי אלא מוצר בקטלוג עם
// ברקוד משלו — כך זה במנוע, וכך רואה החשבון מצליב. הקטלוג שיובא ממנוע
// מכיל שלושה כאלה:
//
//   3570 · ברקוד 3570 · ריכוז תעודות משלוח
//   3569 · ברקוד 3569 · ריכוז תעודות משלוח - מוצרים ללא מעמ
//   3649 · ברקוד 3997 · ריכוז תעודות משלוח פיירות
//
// קטגוריה שאין לה מוצר ייעודי (כיבוד, ח.ניקוי+ח"פ) נופלת לכללי — השם על
// השורה עדיין נכון ("ריכוז תעודות משלוח כיבוד"), רק הברקוד משותף.
// כשייווצר במנוע מוצר ריכוז ייעודי, ממפים אותו כאן — בלי שינוי קוד.
//
//   node scripts/summary-line-map.js                        הצגת המיפוי
//   node scripts/summary-line-map.js --set "כיבוד=3801"     מיפוי קטגוריה
//   node scripts/summary-line-map.js --set "default=3570"   ברירת המחדל
//   node scripts/summary-line-map.js --set "vatFree=3569"   ברירת מחדל לפטור
//   node scripts/summary-line-map.js --unset "כיבוד"        הסרת מיפוי
//
// ⚠️ שינוי כאן משפיע רק על חשבוניות עתידיות. חשבונית שכבר הופקה קפואה.

require("dotenv").config();
const mongoose = require("mongoose");
const Setting = require("../models/Setting");
const Product = require("../models/Product");
const Category = require("../models/Category");
const { SETTING_NAME, DEFAULTS, clearCache } = require("../lib/billing/summaryLines");

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
};

const setPair = arg("--set");
const unsetKey = arg("--unset");

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const saved = await Setting.findOne({ name: SETTING_NAME }).lean();
  const config = saved?.setting
    ? {
        defaultSku: saved.setting.defaultSku || DEFAULTS.defaultSku,
        vatFreeSku: saved.setting.vatFreeSku || DEFAULTS.vatFreeSku,
        byCategory: saved.setting.byCategory || {},
      }
    : JSON.parse(JSON.stringify(DEFAULTS));

  const describe = async (sku) => {
    if (!sku) return "(לא מוגדר)";
    const p = await Product.findOne({ sku: String(sku) })
      .select("sku title erp.barcode")
      .lean();
    if (!p) return `מק"ט ${sku} — ⚠️ אינו קיים בקטלוג`;
    return `מק"ט ${p.sku} · ברקוד ${p.erp?.barcode || "—"} · ${p.title?.he || ""}`;
  };

  if (setPair) {
    const [rawKey, rawSku] = String(setPair).split("=");
    const key = String(rawKey || "").trim();
    const sku = String(rawSku || "").trim();

    if (!key || !sku) {
      console.error('שימוש: --set "קטגוריה=מקט"');
      process.exit(1);
    }

    // המוצר נבדק לפני השמירה: מק"ט שאינו קיים היה משאיר את השורה בלי
    // ברקוד בשקט, וזה מתגלה רק על החשבונית
    const product = await Product.findOne({ sku }).select("sku").lean();
    if (!product) {
      console.error(`מק"ט ${sku} אינו קיים בקטלוג`);
      process.exit(1);
    }

    if (key === "default") config.defaultSku = sku;
    else if (key === "vatFree") config.vatFreeSku = sku;
    else {
      // שם קטגוריה נבדק גם הוא: שגיאת כתיב הייתה יוצרת מיפוי שלעולם
      // לא נתפס, כי ההשוואה היא מול categoryName שעל שורת התעודה
      const cat = await Category.findOne({ "name.he": key }).select("_id").lean();
      if (!cat) {
        console.error(
          `הקטגוריה "${key}" אינה קיימת. הקטגוריות: ` +
            (await Category.find({}).select("name").lean())
              .map((c) => c.name?.he)
              .filter(Boolean)
              .join(", ")
        );
        process.exit(1);
      }
      config.byCategory[key] = sku;
    }

    await Setting.updateOne(
      { name: SETTING_NAME },
      { $set: { name: SETTING_NAME, setting: config } },
      { upsert: true }
    );
    clearCache();
    console.log(`✅ ${key} → ${await describe(sku)}\n`);
  }

  if (unsetKey) {
    delete config.byCategory[String(unsetKey).trim()];
    await Setting.updateOne(
      { name: SETTING_NAME },
      { $set: { name: SETTING_NAME, setting: config } },
      { upsert: true }
    );
    clearCache();
    console.log(`✅ המיפוי של "${unsetKey}" הוסר — יפול לברירת המחדל\n`);
  }

  console.log("מיפוי שורות הריכוז:\n");
  console.log(`  ברירת מחדל (חייב במע"מ)   ${await describe(config.defaultSku)}`);
  console.log(`  ברירת מחדל (פטור ממע"מ)   ${await describe(config.vatFreeSku)}`);

  const categories = await Category.find({}).select("name").lean();
  console.log("\n  לפי קטגוריה:");
  for (const c of categories) {
    const name = c.name?.he;
    if (!name || name === "ראשי") continue;
    const mapped = config.byCategory[name];
    const count = await Product.countDocuments({ category: c._id });
    console.log(
      `    ${name.padEnd(14)} ${String(count).padStart(5)} מוצרים  ` +
        (mapped ? `→ ${await describe(mapped)}` : "→ (ברירת מחדל)")
    );
  }

  if (!saved) {
    console.log("\n  * לא נשמרה הגדרה — מוצגת ברירת המחדל שבקוד.");
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

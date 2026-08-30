// lib/billing/summaryLines.js
//
// המוצרים שמייצגים שורת ריכוז בחשבונית החודשית.
//
// בחשבונית שמנוע מפיק היום, שורת "ריכוז תעודות משלוח" אינה טקסט חופשי
// אלא **מוצר בקטלוג** עם ברקוד משלו. הקטלוג שלנו כבר מכיל אותם, כי הוא
// יובא ממנוע:
//
//   3570 · ברקוד 3570 · ריכוז תעודות משלוח
//   3569 · ברקוד 3569 · ריכוז תעודות משלוח - מוצרים ללא מעמ
//   3649 · ברקוד 3997 · ריכוז תעודות משלוח פיירות
//
// זה חשוב לשני דברים:
//
//   1. עמודת הברקוד על החשבונית לא נשארת ריקה — היא מה שרואה החשבון
//      מצליב מולו, ומה שמופיע בחשבוניות הקודמות של אותו לקוח.
//   2. ההפרדה בין חייב לפטור נשמרת גם ברמת המוצר ולא רק בדגל מע"מ.
//
// המיפוי נשמר בהגדרות (settings, name: "billingSummaryLines") ולא בקוד,
// כדי שקטגוריה חדשה — "כיבוד", למשל — תוכל לקבל מוצר ריכוז משלה בלי
// שינוי קוד. קטגוריה בלי מוצר ייעודי נופלת למוצר הכללי (או לפטור, לפי
// שורות התעודה), ואם גם הוא חסר — לשורה בלי ברקוד, שעדיין תקינה.

const Product = require("../../models/Product");
const Setting = require("../../models/Setting");
const { barcodeOf } = require("../../utils/barcode");

const SETTING_NAME = "billingSummaryLines";

// ברירת המחדל מתארת את מה שכבר קיים בקטלוג. היא אינה נכתבת למסד —
// הגדרה שנשמרה גוברת עליה, וכל עוד לא נשמרה אין מה לתחזק.
const DEFAULTS = {
  // הכללי: כל קטגוריה חייבת במע"מ שאין לה מוצר ייעודי
  defaultSku: "3570",
  // כל שורה פטורה שאין לה מוצר ייעודי
  vatFreeSku: "3569",
  // קטגוריה -> מק"ט מוצר הריכוז שלה
  byCategory: {
    פירות: "3649",
  },
};

// המיפוי משתנה נדירות מאוד (רק כשנוספת קטגוריה), וסגירת חודש קוראת אותו
// לכל לקוח. מטמון קצר חוסך מאות שאילתות בריצה על כל הלקוחות, ותפוגה
// קצרה מבטיחה שקטגוריה שנוספה תיכנס לתוקף בלי הפעלה מחדש של השרת.
const CACHE_TTL_MS = 60 * 1000;
let cache = null;

/** ניקוי המטמון — לבדיקות, ולמסך שמשנה את ההגדרה. */
const clearCache = () => {
  cache = null;
};

/**
 * טוען את מוצרי הריכוז ומחזיר מפענח.
 *
 * @returns {Promise<{for: (category: string, vatFree: boolean) => ({sku, barcode}|null)}>}
 */
const loadSummaryLines = async () => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.resolver;

  let config = DEFAULTS;
  try {
    const saved = await Setting.findOne({ name: SETTING_NAME }).lean();
    if (saved?.setting) {
      config = {
        defaultSku: saved.setting.defaultSku || DEFAULTS.defaultSku,
        vatFreeSku: saved.setting.vatFreeSku || DEFAULTS.vatFreeSku,
        byCategory: saved.setting.byCategory || {},
      };
    }
  } catch (err) {
    // הגדרה שלא נטענה אינה סיבה להפיל סגירת חודש. נופלים לברירת המחדל,
    // ובמקרה הגרוע השורה תצא בלי ברקוד.
    console.warn(`[billing] טעינת מיפוי שורות הריכוז נכשלה: ${err.message}`);
  }

  const skus = [
    ...new Set(
      [config.defaultSku, config.vatFreeSku, ...Object.values(config.byCategory || {})]
        .map((s) => String(s || "").trim())
        .filter(Boolean)
    ),
  ];

  const products = skus.length
    ? await Product.find({ sku: { $in: skus } })
        .select("sku title erp.barcode")
        .lean()
    : [];

  const bySku = new Map(
    products.map((p) => [
      String(p.sku),
      { sku: String(p.sku), barcode: barcodeOf(p), name: p.title?.he || p.title?.en || "" },
    ])
  );

  // מק"ט שמופיע במיפוי ואינו קיים בקטלוג — שקט כאן היה מייצר שורות בלי
  // ברקוד בלי שאיש יבין למה
  for (const sku of skus) {
    if (!bySku.has(sku)) {
      console.warn(
        `[billing] מוצר הריכוז ${sku} אינו קיים בקטלוג — שורות שממופות אליו יצאו בלי ברקוד`
      );
    }
  }

  const resolver = {
    config,
    for(category, vatFree) {
      const mapped = config.byCategory?.[category];
      // סדר: מוצר ייעודי לקטגוריה -> פטור/חייב כללי
      const sku = mapped || (vatFree ? config.vatFreeSku : config.defaultSku);
      return bySku.get(String(sku || "")) || null;
    },
  };

  cache = { at: Date.now(), resolver };
  return resolver;
};

module.exports = { loadSummaryLines, clearCache, SETTING_NAME, DEFAULTS };

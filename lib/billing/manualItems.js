// lib/billing/manualItems.js
//
// אילו שורות בהזמנה אינן נכנסות לתעודת המשלוח האוטומטית.
//
// הרקע: פירות וירקות נמכרים במשקל. ההזמנה נקלטת עם המשקל שהלקוח *ביקש*,
// אבל מה שנמסר בפועל נקבע על המאזניים ביום האריזה. תעודה אוטומטית על
// השורות האלה הייתה מחייבת בסוף החודש לפי המשקל המוזמן — מספר שאיש לא שקל.
//
// לכן השורות האלה יורדות מהתעודה האוטומטית, ועליהן מוציאים תעודה ידנית עם
// המשקל האמיתי. החשבונית החודשית נבנית מהתעודות (ראו monthlyBilling), ולכן
// היא מחייבת בדיוק את מה שהוזן ידנית.
//
// הסימון יושב על הקטגוריה (Category.requiresManualNote) ולא על שם הקטגוריה
// בקוד: שם שמוקלד בקוד נשבר בשקט ביום שמישהו יערוך אותו בפאנל, ואז פירות
// יחזרו בשקט לתעודה האוטומטית — כלומר לחיוב לפי משקל מוזמן. זו בדיוק
// התקלה שהמנגנון הזה בא למנוע, והיא כזו שאף אחד לא מגלה עד שהלקוח מתקשר.

const mongoose = require("mongoose");
const Category = require("../../models/Category");
const Product = require("../../models/Product");

// הרשימה נטענת מהמסד בכל הפקת תעודה. מטמון קצר מספיק כדי לא לשאול פעמיים
// באותה פעולה, וקצר מספיק כדי שסימון קטגוריה חדשה בפאנל ייכנס לתוקף מיד
// ולא אחרי ריסטארט.
const CACHE_TTL_MS = 60 * 1000;
let cache = { ids: null, at: 0 };

/**
 * מזהי כל הקטגוריות שסחורתן נמסרת בתעודה ידנית — המסומנות עצמן וכל
 * צאצאיהן.
 *
 * הירושה לצאצאים מכוונת: מספיק לסמן את "פירות וירקות" פעם אחת, ותת-קטגוריה
 * שתיווצר מחר ("פירות העונה") תתנהג נכון בלי שאיש יזכור לסמן אותה.
 *
 * @returns {Promise<Set<string>>}
 */
const manualNoteCategoryIds = async ({ force = false } = {}) => {
  if (!force && cache.ids && Date.now() - cache.at < CACHE_TTL_MS) return cache.ids;

  const all = await Category.find({}).select("_id parentId requiresManualNote").lean();

  // parentId מוחזק כמחרוזת ולא כ-ObjectId (ראו models/Category), ולכן כל
  // ההשוואות כאן על מחרוזות
  const childrenOf = new Map();
  for (const cat of all) {
    const parent = cat.parentId ? String(cat.parentId) : null;
    if (!parent) continue;
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(String(cat._id));
  }

  const ids = new Set();
  const stack = all.filter((c) => c.requiresManualNote).map((c) => String(c._id));

  while (stack.length) {
    const id = stack.pop();
    // עץ הקטגוריות נערך ביד ויכול להכיל מעגל (הורה שהוצב תחת צאצא שלו).
    // בלי הבדיקה הזו הלולאה לא הייתה נגמרת ותקיעה כזו הייתה משביתה כל
    // הפקת תעודה במערכת.
    if (ids.has(id)) continue;
    ids.add(id);
    for (const child of childrenOf.get(id) || []) stack.push(child);
  }

  cache = { ids, at: Date.now() };
  return ids;
};

/** איפוס המטמון. משמש בסקריפטים ובבדיקות שמשנות סימון קטגוריה ובודקות מיד. */
const clearCache = () => {
  cache = { ids: null, at: 0 };
};

/**
 * המזהה של המוצר בשורת עגלה.
 *
 * במפורש *לא* `line.productId`: השדה Product.productId הוא מחרוזת מהתבנית
 * שממנה הפרויקט שוכפל, והוא אינו ה-_id של המוצר (נבדק על הקטלוג — כל
 * 4,320 המוצרים נושאים שם מזהה שאינו מצביע על אף מוצר). שאילתה לפיו הייתה
 * מחזירה כלום, והשורה הייתה מסווגת כלא-נשקלת בשקט.
 */
const productIdOf = (line) => {
  const id = line._id || line.id;
  return id && mongoose.Types.ObjectId.isValid(String(id)) ? String(id) : null;
};

/**
 * השלמת הקטגוריות לשורות שהגיעו בלעדיהן.
 *
 * שורת עגלה נושאת בדרך כלל `category` (ראו order-ingestion/createOrder),
 * אבל הזמנות ישנות ועגלות שנערכו ביד לא תמיד. שורה בלי קטגוריה הייתה
 * מסווגת כ"לא פירות" ונכנסת לתעודה האוטומטית — כלומר מחויבת לפי המשקל
 * המוזמן, בשקט. עדיף לשלם על שאילתה אחת ולדעת.
 *
 * @param {Array} lines - שורות עם _id / sku
 * @returns {Promise<Map<number, string[]>>} אינדקס שורה → מזהי הקטגוריות
 */
const resolveMissingCategories = async (lines) => {
  const resolved = new Map();

  const missing = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !line.category);

  if (!missing.length) return resolved;

  const ids = missing.map(({ line }) => productIdOf(line)).filter(Boolean);
  const skus = missing.map(({ line }) => line.sku).filter(Boolean).map(String);

  const query = [];
  if (ids.length) query.push({ _id: { $in: ids } });
  if (skus.length) query.push({ sku: { $in: skus } });
  if (!query.length) return resolved;

  // גם categories ולא רק category: מוצר יכול להיות משויך לפירות בשיוך
  // משני בלבד, ואז השדה הראשי לבדו היה מפספס אותו
  const products = await Product.find({ $or: query })
    .select("sku category categories")
    .lean();

  const byId = new Map(products.map((p) => [String(p._id), p]));
  const bySku = new Map(products.map((p) => [String(p.sku), p]));

  for (const { line, index } of missing) {
    const product = byId.get(productIdOf(line) || "") || bySku.get(String(line.sku || ""));
    if (!product) continue;

    const all = [product.category, ...(product.categories || [])]
      .filter(Boolean)
      .map(String);
    if (all.length) resolved.set(index, all);
  }

  return resolved;
};

/**
 * פיצול שורות לשתי קבוצות לפי אופן ההפקה.
 *
 * @param {Array} lines - שורות עגלה או שורות תעודה
 * @returns {Promise<{automatic: Array, manual: Array}>}
 *          automatic — נכנסות לתעודה האוטומטית
 *          manual    — ממתינות לתעודה ידנית עם המשקל שנשקל
 */
const splitByNoteKind = async (lines = []) => {
  const manualIds = await manualNoteCategoryIds();

  // אין קטגוריה מסומנת — אין מה לפצל. זהו המצב לפני הרצת סקריפט הסימון,
  // וההתנהגות בו זהה למה שהיה קודם: הכל בתעודה אחת אוטומטית.
  if (!manualIds.size) return { automatic: [...lines], manual: [] };

  const fallback = await resolveMissingCategories(lines);

  const automatic = [];
  const manual = [];

  lines.forEach((line, index) => {
    // כל השיוכים של השורה, לא רק הראשי. מוצר ששויך גם ל"מבצעים" וגם
    // ל"ירקות" חייב להיספר כירק, אחרת שיוך שיווקי היה מוציא אותו מהשקילה.
    const own = [
      line.category,
      ...(Array.isArray(line.categories) ? line.categories : []),
    ]
      .filter(Boolean)
      .map(String);

    const categories = own.length ? own : fallback.get(index) || [];
    const isManual = categories.some((id) => manualIds.has(id));

    (isManual ? manual : automatic).push(line);
  });

  return { automatic, manual };
};

module.exports = {
  manualNoteCategoryIds,
  splitByNoteKind,
  clearCache,
};

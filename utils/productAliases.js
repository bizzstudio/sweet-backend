// utils/productAliases.js
//
// שליפה ושמירה של "איך הלקוח קורא למוצר" (models/ProductAlias).
//
// המודול הזה הוא **הבעלים היחיד של הנרמול**. אליאס נשמר בפעולת אדם ונשלף
// בצינור הקליטה, ואם שני הצדדים היו מנרמלים בנפרד היה מספיק הבדל של רווח כפול
// כדי שהכרעה שנשמרה לא תימצא לעולם — כשל שקט לחלוטין: הממשק מראה שהאליאס
// קיים, והקליטה ממשיכה להיכשל על אותה שורה.

const mongoose = require("mongoose");

const ProductAlias = require("../models/ProductAlias");
const Product = require("../models/Product");
const { normalizeTitleForMatch } = require("./productMatching");

/**
 * המפתח שתחתיו נשמר ונשלף אליאס.
 *
 * נגזר מ-normalizeTitleForMatch של מנוע ההתאמה ולא מנרמול משלנו, כדי ששני
 * המנגנונים יראו את אותו טקסט: מה שנחשב "אותו שם" בהתאמה נחשב "אותו שם" גם
 * כאן.
 */
const aliasKey = (text) => normalizeTitleForMatch(text);

/**
 * המוצרים של אליאס, בצורה אחת: ‎[{ product, quantity }]‎.
 *
 * רשומות שנשמרו לפני שאליאס יכול היה להחזיק כמה מוצרים מחזיקות רק `product`.
 * הן אינן מוסבות במסד — הן נקראות כאן כרשימה של מוצר אחד בכמות "כמו בשורה",
 * וכך כל מי שקורא אליאס רואה צורה אחת בלי לדעת מתי הוא נשמר.
 *
 * @returns {Array<{product: ObjectId, quantity: number|null}>} ריק באליאס ignore
 */
const aliasEntries = (alias) => {
  if (!alias || alias.ignore) return [];
  if (Array.isArray(alias.products) && alias.products.length) {
    return alias.products
      .filter((entry) => entry?.product)
      .map((entry) => ({ product: entry.product, quantity: entry.quantity ?? null }));
  }
  return alias.product ? [{ product: alias.product, quantity: null }] : [];
};

/**
 * המוצר שהוכרע עבור הטקסט הזה, אם הוכרע.
 *
 * @param {string} rawName - השם כפי שהלקוח כתב (אחרי ניקוי מזהים, ראה resolvers)
 * @param {string|ObjectId|null} customerId
 * @returns {Promise<null|{product: Object, products: Array<{product: Object, quantity: number|null}>, alias: Object, scope: "customer"|"global", ignore?: true}>}
 *          ‏product הוא הראשון ב-products; באליאס של מוצר אחד הם אותו דבר.
 */
const findAliasMatch = async (rawName, customerId = null) => {
  const key = aliasKey(rawName);
  if (!key) return null;

  // ── שאילתה אחת לשני ההיקפים ──
  //
  // שתי שאילתות (קודם לקוח, ואם אין אז כללי) היו עולות סיבוב רשת נוסף על כל
  // שורה בכל הזמנה — והרוב המוחלט של השורות אינו אליאס כלל. כאן נשלפות שתי
  // הרשומות האפשריות יחד, וההעדפה נקבעת בזיכרון.
  const scopes = customerId ? [customerId, null] : [null];
  const found = await ProductAlias.find({ key, customer: { $in: scopes } }).lean();
  if (!found.length) return null;

  // ללקוח קודם לכלל-מערכתי: מי שהכריע במפורש עבור הלקוח הזה ידע עליו משהו
  // שההכרעה הגורפת לא ידעה.
  const alias =
    found.find((a) => a.customer && String(a.customer) === String(customerId)) || found[0];

  const scope = alias.customer ? "customer" : "global";
  if (alias.ignore) return { ignore: true, product: null, alias, scope };

  const entries = aliasEntries(alias);
  if (!entries.length) return null;

  const loaded = await Product.find({ _id: { $in: entries.map((entry) => entry.product) } }).lean();
  const byId = new Map(loaded.map((product) => [String(product._id), product]));

  // ── מוצר שנמחק מהקטלוג ──
  //
  // האליאס אינו נמחק כאן. מחיקה בתוך מסלול קריאה הופכת תקלה זמנית בקטלוג
  // (מוצר שהוסתר וייחזר, יבוא שרץ באמצע) לאובדן בלתי הפיך של הכרעה אנושית.
  // במקום זה מדווחים כלום, והשורה חוזרת למנוע ההתאמה הרגיל — כלומר לכל היותר
  // חוזרים למצב שלפני האליאס.
  //
  // באליאס של כמה מוצרים זה חל על **כל** הרשימה ולא רק על החסר: פריסה חלקית
  // ("סכו"ם וצלחות" בלי הצלחות) הייתה נכנסת להזמנה בביטחון מלא, וההזמנה
  // הייתה יוצאת חסרה בלי שאיש יודע. עדיף שהשורה תעצור לאדם.
  if (entries.some((entry) => !byId.has(String(entry.product)))) return null;

  const products = entries.map((entry) => ({
    product: byId.get(String(entry.product)),
    quantity: entry.quantity,
  }));

  // ‏product נשאר המוצר הראשון: כל מי שמכיר רק אליאס של מוצר אחד ממשיך לעבוד
  return { product: products[0].product, products, alias, scope };
};

/**
 * רישום שימוש. לא נכשל ולא מעכב — הוא סטטיסטיקה, לא נכונות.
 */
const recordAliasHit = (aliasId) =>
  ProductAlias.updateOne(
    { _id: aliasId },
    { $inc: { hits: 1 }, $set: { lastUsedAt: new Date() } }
  ).catch((err) => {
    console.log(`[aliases] עדכון מונה נכשל (${aliasId}): ${err.message}`);
  });

/**
 * שמירת הכרעה אנושית.
 *
 * upsert ולא create: אדם שמכריע מחדש על שם שכבר הוכרע מתקן את ההכרעה הקודמת,
 * ולא מייצר רשומה שנייה שתתחרה בה (ראה האינדקס הייחודי ב-ProductAlias).
 *
 * ‏productId — מוצר אחד (כל מי שקרא לפונקציה לפני שהיו כמה מוצרים).
 * ‏products — ‎[{ productId, quantity }]‎: שורה אחת שהיא כמה מוצרים. ‏quantity
 * ריק = "כמו בשורה". ראה ההסבר ב-models/ProductAlias.
 *
 * @returns {Promise<Object>} האליאס שנשמר
 */
const saveAlias = async ({
  rawName,
  productId,
  products = null,
  customerId = null,
  createdBy = null,
  ignore = false,
}) => {
  const key = aliasKey(rawName);
  if (!key) throw new Error("שם ריק — אי אפשר לשמור אליאס");
  if (ignore) {
    return upsertAlias(key, customerId, {
      product: null,
      products: [],
      ignore: true,
      sourceName: String(rawName).trim(),
      createdBy,
    });
  }

  const entries = await validateEntries(
    Array.isArray(products) && products.length ? products : productId ? [{ productId }] : []
  );

  return upsertAlias(key, customerId, {
    product: entries[0].product,
    products: entries,
    ignore: false,
    sourceName: String(rawName).trim(),
    createdBy,
  });
};

/**
 * בדיקת רשימת המוצרים של אליאס, והחזרתה בצורה שנשמרת במסד.
 *
 * זורק הודעה בעברית שמיועדת למסך — כל אחת מהן אומרת לעובד מה לתקן.
 */
const validateEntries = async (list) => {
  if (!list.length) throw new Error("לא נבחר מוצר");

  const entries = [];
  const seen = new Set();
  for (const raw of list) {
    const productId = raw?.productId ?? raw?.product;

    // ‏findById על מחרוזת שאינה ObjectId זורק CastError, וההודעה הגולמית שלו
    // ("Cast to ObjectId failed ... for model Product") הייתה מגיעה כמות שהיא
    // למסך: היא אינה אומרת דבר למי שקורא אותה וגם חושפת מבנה פנימי.
    if (!productId || !mongoose.Types.ObjectId.isValid(String(productId))) {
      throw new Error("מזהה מוצר לא תקין");
    }

    // אותו מוצר פעמיים ברשימה היה נכנס להזמנה כשתי שורות של אותו פריט —
    // כמעט בוודאות לחיצה כפולה ולא כוונה, ולכן נשמר פעם אחת
    if (seen.has(String(productId))) continue;
    seen.add(String(productId));

    // ‏0, ריק או לא-מספר = "כמו בשורה". כמות קבועה של 0 הייתה מכניסה להזמנה
    // שורה שאין בה כלום — מי שלא רוצה מוצר מסיר אותו מהרשימה.
    const quantity = Number(raw?.quantity);
    entries.push({
      product: productId,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,
    });
  }

  const found = await Product.find({ _id: { $in: entries.map((entry) => entry.product) } })
    .select("_id")
    .lean();
  if (found.length !== entries.length) {
    throw new Error(entries.length > 1 ? "אחד המוצרים לא נמצא בקטלוג" : "המוצר לא נמצא בקטלוג");
  }

  return entries;
};

const upsertAlias = async (key, customerId, fields) => {
  const filter = { key, customer: customerId || null };
  const update = {
    $set: fields,
    // מונה השימושים מתאפס בהכרעה חדשה: הוא סופר כמה פעמים *ההכרעה הזו*
    // שירתה, ולא כמה פעמים השם הופיע.
    $setOnInsert: { hits: 0 },
  };
  const options = { upsert: true, new: true, setDefaultsOnInsert: true };

  try {
    return await ProductAlias.findOneAndUpdate(filter, update, options).lean();
  } catch (err) {
    // ── שני אדמינים לחצו על אותה שורה באותו רגע ──
    //
    // ‏upsert על אינדקס ייחודי אינו אטומי מול upsert מקביל: שניהם יכולים לא
    // למצוא רשומה ולנסות להוסיף, והמפסיד מקבל E11000. זו אינה תקלה אלא מרוץ
    // שהסתיים — הרשומה קיימת עכשיו, וניסיון שני יעדכן אותה.
    //
    // בלי זה האדמין שהפסיד היה רואה "E11000 duplicate key" במקום אישור,
    // והיה סביר שילחץ שוב ויכתוב מחדש הכרעה של חברו.
    if (err?.code !== 11000) throw err;
    return ProductAlias.findOneAndUpdate(filter, update, options).lean();
  }
};

/**
 * עריכת המוצרים של אליאס קיים — מכרטיס הלקוח.
 *
 * המפתח וההיקף אינם משתנים כאן: הם מה שהאליאס *הוא* (השם שהלקוח כותב, ואצל
 * מי). מי שרוצה שם אחר — מוחק ומכריע מחדש מתוך ההזמנה.
 *
 * מונה השימושים **אינו** מתאפס, בניגוד ל-saveAlias: הוספת סוג סכו"ם לשורה
 * שכבר שירתה עשרות הזמנות היא אותה הכרעה שהורחבה, לא הכרעה חדשה.
 *
 * @returns {Promise<Object|null>} null כשהאליאס לא נמצא
 */
const updateAliasProducts = async (aliasId, products) => {
  if (!mongoose.Types.ObjectId.isValid(String(aliasId))) throw new Error("מזהה לא תקין");
  const entries = await validateEntries(Array.isArray(products) ? products : []);
  return ProductAlias.findByIdAndUpdate(
    aliasId,
    {
      $set: {
        product: entries[0].product,
        products: entries,
        ignore: false,
      },
    },
    { new: true, runValidators: true }
  ).lean();
};

// ── מק"ט → מזהה מוצר ──
//
// מק"ט שמופיע ביותר ממוצר אחד אינו מכריע — לא בוחרים אחד מהם בשקט. זורק
// הודעה שמיועדת למסך.
const productIdBySku = async (sku) => {
  const bySku = await Product.find({ sku: String(sku) }).select("_id").limit(2).lean();
  if (bySku.length !== 1) {
    throw new Error(
      bySku.length
        ? `המק"ט ${sku} שייך ליותר ממוצר אחד בקטלוג — יש לתקן בקטלוג`
        : `לא נמצא מוצר עם מק"ט ${sku}`
    );
  }
  return bySku[0]._id;
};

/**
 * רשימת מוצרים מהמסך ‎[{ productId | sku, quantity }]‎ → ‎[{ productId, quantity }]‎.
 * משותף למסך ההזמנה (resolve-item) ולכרטיס הלקוח (controller/productAliasController).
 */
const resolveProductList = async (list) => {
  if (!Array.isArray(list)) return [];
  // רשימה ארוכה מזה אינה פריסה של שורה אלא תקלה בצד ששלח אותה
  if (list.length > 30) throw new Error("יותר מדי מוצרים לשורה אחת");
  const out = [];
  for (const entry of list) {
    const productId = entry?.productId || (entry?.sku ? await productIdBySku(entry.sku) : null);
    if (!productId) throw new Error("לא נבחר מוצר");
    out.push({ productId, quantity: entry?.quantity ?? null });
  }
  return out;
};

module.exports = {
  aliasKey,
  aliasEntries,
  findAliasMatch,
  recordAliasHit,
  saveAlias,
  updateAliasProducts,
  productIdBySku,
  resolveProductList,
};

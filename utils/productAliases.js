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
 * המוצר שהוכרע עבור הטקסט הזה, אם הוכרע.
 *
 * @param {string} rawName - השם כפי שהלקוח כתב (אחרי ניקוי מזהים, ראה resolvers)
 * @param {string|ObjectId|null} customerId
 * @returns {Promise<null|{product: Object, alias: Object, scope: "customer"|"global"}>}
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

  const product = await Product.findById(alias.product).lean();

  // ── מוצר שנמחק מהקטלוג ──
  //
  // האליאס אינו נמחק כאן. מחיקה בתוך מסלול קריאה הופכת תקלה זמנית בקטלוג
  // (מוצר שהוסתר וייחזר, יבוא שרץ באמצע) לאובדן בלתי הפיך של הכרעה אנושית.
  // במקום זה מדווחים כלום, והשורה חוזרת למנוע ההתאמה הרגיל — כלומר לכל היותר
  // חוזרים למצב שלפני האליאס.
  if (!product) return null;

  return {
    product,
    alias,
    scope: alias.customer ? "customer" : "global",
  };
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
 * @returns {Promise<Object>} האליאס שנשמר
 */
const saveAlias = async ({ rawName, productId, customerId = null, createdBy = null }) => {
  const key = aliasKey(rawName);
  if (!key) throw new Error("שם ריק — אי אפשר לשמור אליאס");
  if (!productId) throw new Error("לא נבחר מוצר");

  // ‏findById על מחרוזת שאינה ObjectId זורק CastError, וההודעה הגולמית שלו
  // ("Cast to ObjectId failed ... for model Product") הייתה מגיעה כמות שהיא
  // למסך: היא אינה אומרת דבר למי שקורא אותה וגם חושפת מבנה פנימי.
  if (!mongoose.Types.ObjectId.isValid(String(productId))) {
    throw new Error("מזהה מוצר לא תקין");
  }

  const product = await Product.findById(productId).select("_id").lean();
  if (!product) throw new Error("המוצר לא נמצא בקטלוג");

  const filter = { key, customer: customerId || null };
  const update = {
    $set: {
      product: productId,
      sourceName: String(rawName).trim(),
      createdBy,
    },
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

module.exports = {
  aliasKey,
  findAliasMatch,
  recordAliasHit,
  saveAlias,
};

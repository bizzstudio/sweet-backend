// lib/order-ingestion/resolvers.js
//
// הפיכת הפלט של ה-LLM לישויות אמיתיות במערכת:
//   resolveItems()    — שמות מוצרים → מוצרים בקטלוג (עם מחירים מה-DB בלבד)
//   resolveCustomer() — טלפון/מייל → רשומת Customer (קיימת או חדשה)
//   resolveDelivery() — עיר → יעד משלוח מוגדר, עלות ומינימום הזמנה

const Customer = require("../../models/Customer");
const Delivery = require("../../models/Delivery");
const Product = require("../../models/Product");
const { canonicalPhone, phoneVariations } = require("../../utils/phone");
const {
  matchProductByName,
  CANDIDATE_POOL_SIZE,
  HISTORY_CANDIDATE_LIMIT,
} = require("../../utils/productMatching");
const { findAliasMatch, recordAliasHit, saveAlias } = require("../../utils/productAliases");
const { priceForProduct } = require("../../utils/customerPriceList");
const {
  pickFromHistory,
  coversAllWords,
  coversRequest,
  sameName,
  assortedOf,
  isAssorted,
  closestOwnProducts,
  sharedWordCount,
  guessStrength,
  OWN_LIST_DOMINANCE_RATIO,
  lookupProduct,
} = require("../../utils/purchaseHistoryRanking");
const {
  extractQualifiers,
  applyQualifiers,
  hasProductWord,
  extractSizesFromTitle,
  withoutPlainWords,
} = require("./qualifiers");
const {
  getCatalogVocabulary,
  looksLikeProductAttempt,
} = require("../../utils/catalogVocabulary");
const { chooseProduct } = require("./llm");
const { resolveOpenLines } = require("./aiFallback");
const { getPackSizes, packSizeOf } = require("../../utils/packSizes");
const { manualNoteCategoryIds } = require("../billing/manualItems");

// האם מותר לפנות לשירות AI חיצוני. כבוי בברירת מחדל — ראה lib/order-ingestion/index.js.
// חייב להיאכף גם כאן: בלי זה שלב ההכרעה בין מועמדים היה שולח קריאה בתשלום
// למרות ש"ה-AI כבוי", וזו הבטחה שבורה כלפי מי שהחליט לכבות אותו.
const USE_EXTERNAL_AI = () => process.env.INGESTION_USE_EXTERNAL_AI === "true";

// מעל הסף הזה מקבלים את הכרעת מנוע ההתאמה כמו שהיא
const AUTO_ACCEPT_CONFIDENCE = Number(process.env.INGESTION_AUTO_ACCEPT_CONFIDENCE) || 0.9;
// מתחת לסף הזה הפריט נחשב לא מזוהה גם אחרי הכרעת LLM
const MIN_ITEM_CONFIDENCE = Number(process.env.INGESTION_MIN_ITEM_CONFIDENCE) || 0.7;

// ── שורה עמומה: להיכנס עם המועמד הסביר, או לעצור את ההזמנה ──
//
// דלוק בברירת מחדל: הזמנה שנעצרת בגלל שורה אחת עולה יותר מפריט שנבחר לפי
// הסולם ב-autoPick — במיוחד כשהעמימות אמיתית ("עוגיות" מול חמישה מוצרים),
// כלומר גם אדם לא היה מכריע מהטקסט. ‏false מחזיר את ההתנהגות הקודמת: כל
// שורה עמומה מעבירה את ההזמנה ל"שגיאה בקריאה".
const AUTO_PICK_AMBIGUOUS = () => process.env.INGESTION_AUTO_PICK_AMBIGUOUS !== "false";

// "הכול נכנס" — ראה הבלוק בסוף resolveItems. כבוי כברירת מחדל.
const BEST_EFFORT = () => process.env.INGESTION_BEST_EFFORT === "true";
// שורה שכללי ההיסטוריה לא סגרו נשלחת ל-AI, שבוחר רק מתוך מה שהלקוח קונה
// (ראה aiFallback). כבוי כברירת מחדל: כל הזמנה עם שורה פתוחה היא קריאה בתשלום.
const AI_FALLBACK = () => process.env.INGESTION_AI_FALLBACK === "true";
// הכרעה שעברה את הבודק נשמרת ללקוח, כך שאותו ניסוח אינו נשלח ל-AI פעמיים
const AI_SAVE_ALIASES = () => process.env.INGESTION_AI_SAVE_ALIASES !== "false";
const MONTH_MS = 30.44 * 24 * 60 * 60 * 1000;
// אריזה שמכילה כמה יחידות. שישייה אינה כאן: מוצרי שתייה רבים נמכרים כשישייה
// בשם המוצר עצמו, והתאמת השם כבר מכריעה ביניהם.
const MULTI_PACK_WORD_RE = /(?:^|[^א-ת])(קרטון|קרטונים|ארגז|ארגזים|מגש|מגשים|שרוול|שרוולים)(?=$|[^א-ת])/;
// מקום השורה בהזמנה והשורה כפי שנכתבה. סמלים ולא שדות: הם עוברים עם ‎...base
// לכל מקום שהשורה מגיעה אליו, ואינם נשמרים במסד ואינם מופיעים ב-JSON.
const LINE = Symbol("line");
const SOURCE = Symbol("source");
// ‏false = בלי ניחושים בכלל: שורה שלא זוהתה בוודאות יורדת להערת ההזמנה
// כ"להשלים", ושום מוצר אינו נכנס על סמך דמיון. ההזמנה נכנסת עם הוודאי בלבד.
const BEST_EFFORT_GUESS = () => process.env.INGESTION_BEST_EFFORT_GUESS !== "false";

// ── שמירת הכרעת ה-LLM כאליאס של הלקוח ──
//
// בלי זה ה-LLM מכריע, הפריט נכנס — וההכרעה מתאדה. נמדד: אמן מחשבים כתבה
// "קולה זירו" בשלוש הזמנות נפרדות, וכל אחת מהן הייתה קריאה נפרדת בתשלום על
// אותה שאלה בדיוק. כלומר ה-AI היה מס קבוע לכל הודעה במקום תשלום חד-פעמי לכל
// מילה חדשה.
//
// עם השמירה, "קולה זירו" של אותו לקוח נפתר פעם אחת ומכאן והלאה נענה
// מהאליאס — מיידית, בלי קריאה, בלי עלות. נמדד שאצל לקוחות שחזרו 56%–100%
// מהשמות חוזרים, ולכן קצב הקריאות דועך מהר.
const SAVE_LLM_ALIASES = () => process.env.INGESTION_SAVE_LLM_ALIASES !== "false";

// ── למה סף נפרד, וגבוה ──
//
// אליאס אינו החלטה לשורה אחת אלא **כלל קבוע**: מכאן והלאה הוא ייענה בלי
// שום בדיקה נוספת (findAliasMatch מחזיר confidence 1). לכן הכרעה שה-LLM עצמו
// אינו בטוח בה מותר לה להיכנס להזמנה הזו — היא עוברת סף רגיל — אבל אסור לה
// להפוך לכלל. הסף כאן נמדד מול ההכרעות בפועל: אחרי השקלול מול איכות ההתאמה
// (ראה למטה) הכרעה טובה יושבת על 0.83 ומעלה, וניחוש "הפחות גרוע" נופל הרבה
// מתחת.
const LLM_ALIAS_MIN_CONFIDENCE =
  Number(process.env.INGESTION_LLM_ALIAS_MIN_CONFIDENCE) || 0.8;

// ניקוד שמיוחס להתאמה שהגיעה מאליאס. הוא אינו תוצאה של דירוג אלא של הכרעת
// אדם, ולכן הוא גבוה מכל ניקוד שהמנוע מייצר (התאמה מושלמת לווריאציה = 15,000).
// הוא נכנס לתיעוד ולהשוואות, ולא לשום החלטה — ההחלטה כבר התקבלה.
const ALIAS_MATCH_SCORE = 100000;

// ── הביטחון שהיסטוריה ודאית מקנה ──
//
// נגזר מסף הקבלה ולא מספר קבוע, כי המשמעות של "היסטוריה הכריעה" היא בדיוק
// "מותר לקבל את השורה". מספר קשיח היה מתנתק מהסף ברגע שמישהו משנה את
// INGESTION_AUTO_ACCEPT_CONFIDENCE — ואז הכרעה ודאית הייתה מפסיקה להתקבל
// בשקט, בלי ששום דבר בקוד ישתנה.
const HISTORY_MATCH_CONFIDENCE = AUTO_ACCEPT_CONFIDENCE;

// דומיין פיקטיבי ללקוחות שהגיעו מווצאפ בלי מייל. Customer.email הוא required+unique
// בסכמה, ולכן חייבים ערך — אבל אסור לשלוח לשם דואר אמיתי (ראה isSyntheticEmail).
const SYNTHETIC_EMAIL_DOMAIN = "whatsapp.local";

// האם מותר להזמין מוצר שאינו מפורסם בחנות (status: "hide").
// ברירת המחדל false, בהתאמה ל-addOrder שדוחה מוצר כזה ("המוצר אינו זמין").
const ALLOW_HIDDEN_PRODUCTS = () => process.env.INGESTION_ALLOW_HIDDEN_PRODUCTS === "true";

// האם להתעלם מטבלת יעדי המשלוח.
// כשהחנות לא מנהלת יעדים, אין מול מה לאמת עיר ואין מאיפה לגזור דמי משלוח —
// ואימות מול טבלה ריקה היה מפיל *כל* הזמנת משלוח.
const IGNORE_DELIVERY_TARGETS = () =>
  process.env.INGESTION_IGNORE_DELIVERY_TARGETS === "true";

/**
 * בדיקת זמינות המוצר *אחרי* שנמצא, והחזרת סיבה מדויקת אם אינו זמין.
 *
 * זו הנקודה שבה נשבר הזיהוי בשטח: מנוע ההתאמה חיפש רק מוצרים מפורסמים עם
 * מלאי, וכל הקטלוג היה status:"hide" עם מלאי 0 — כך שהודעת הכשל אמרה "לא נמצא
 * מוצר מתאים בקטלוג" למרות שהמוצר קיים. עובד שקיבל את ההודעה הזו חיפש במקום
 * הלא נכון. עכשיו מחפשים בכל הקטלוג ומסבירים בדיוק מה חסר.
 *
 * @param {number|null} [customerPrice] - המחיר מהמחירון הפרטי של הלקוח, אם יש.
 *        מוצר שאין לו מחיר בקטלוג אבל יש לו מחיר במחירון הלקוח **אינו** חסום:
 *        הוא נמכר במחיר שבמחירון, וזה המחיר שההזמנה תיווצר איתו.
 * @returns {string|null} סיבה מדויקת, או null אם המוצר זמין להזמנה
 */
const productUnavailableReason = (product, quantity, customerPrice = null) => {
  const title = product.title?.he || product.sku || "המוצר";

  if (product.status !== "show" && !ALLOW_HIDDEN_PRODUCTS()) {
    return `"${title}" מוסתר בקטלוג — יש להפעיל אותו במסך המוצרים.`;
  }

  // מחיר 0 הוא חסימה אמיתית: בלעדיו תיווצר הזמנה בסך 0 ש"ח.
  const catalogPrice = Number(product.prices?.price);
  const price =
    customerPrice !== null && Number.isFinite(Number(customerPrice))
      ? Number(customerPrice)
      : catalogPrice;
  if (!Number.isFinite(price) || price <= 0) {
    return `ל"${title}" אין מחיר בקטלוג — יש להגדיר מחיר.`;
  }

  // stock מסוג null/undefined = מלאי בלתי מוגבל (אותה סמנטיקה כמו ב-addOrder).
  // רק מספר ממשי שקטן מהמבוקש הוא חסר מלאי.
  if (typeof product.stock === "number" && product.stock < quantity) {
    return `ל"${title}" אין מלאי מספיק — מבוקש ${quantity}, במלאי ${product.stock}.`;
  }

  return null;
};

const isSyntheticEmail = (email) =>
  typeof email === "string" && email.toLowerCase().endsWith(`@${SYNTHETIC_EMAIL_DOMAIN}`);

// ─────────────────────────────────────────────────────────────
//  פריטים
// ─────────────────────────────────────────────────────────────

// המרת כמות ויחידה לכמות יחידות מוצר בפועל.
// המוצרים בקטלוג נמכרים ביחידות (שקית/מארז/מגש), לא במשקל. לכן "2 קילו" של
// מוצר שנמכר בשקיות אינו 2 יחידות בהכרח — אבל אין בסכמת המוצר שדה משקל-לאריזה
// אמין לחישוב, ולכן שומרים את היחידה בהערה לליקוט ולא מנחשים המרה.
const normalizeQuantity = (quantity) => {
  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) return 1;
  // כמות שאינה שלמה ("חצי קילו" = 0.5) מעוגלת מעלה ליחידה אחת לפחות —
  // אי אפשר להזמין חצי שקית. היחידה המקורית נשמרת בהערת הפריט.
  return Math.max(1, Math.ceil(q));
};

// ── סחורה שנמכרת במשקל: "1.5 קילו בננות" מול "בננות 5.5 קילו" ──
//
// הכלל שלמעלה ("אי אפשר להזמין חצי שקית") נכון לסחורה ארוזה, ושגוי לפירות
// וירקות: שם הארגז בקטלוג הוא משקל, והלקוח מזמין מתוכו כמה שהוא צריך. עד כאן
// שורה כזו נעצרה כ"מידה שאינה בקטלוג" והמתינה לאדם — בכל הזמנה מחדש.
//
// ההמרה היא לחלק יחסי מהאריזה (1.5 ÷ 5.5 = 0.273), כך שהמחיר והמלאי יורדים
// לפי מה שהתבקש. היא מוגבלת לקטגוריות שסומנו כנשקלות (אותו סימון שמפריד
// תעודה ידנית מאוטומטית, ראה lib/billing/manualItems): "גבינה 500 גרם" מול
// אריזת 360 גרם נשארת מוצר שאין, ולא הופכת ל-1.39 אריזות.

/**
 * המשקל שהלקוח ביקש בשורה, בגרמים — או null כשהשורה אינה בקשה במשקל.
 *
 * שני מקורות: עמודת כמות עם יחידה ("8 ק\"ג" → unit), או מידה בתוך השם
 * ("1.5 קילו בננות"). מידה בשם מוכפלת בכמות השורה ("2 × 1.5 קילו").
 */
const requestedWeight = (qualifiers, rawQuantity, unit, quantity) => {
  if (unit) {
    const amount = Number(rawQuantity);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const [size] = extractQualifiers(`${amount} ${unit}`).sizes;
    return size?.base === "gram" ? { grams: size.normalized, label: size.raw } : null;
  }

  const distinct = [];
  qualifiers.sizes.forEach((s) => {
    if (!distinct.some((d) => d.base === s.base && d.normalized === s.normalized)) distinct.push(s);
  });
  if (distinct.length !== 1 || distinct[0].base !== "gram") return null;

  const [size] = distinct;
  return {
    grams: size.normalized * quantity,
    unitGrams: size.normalized,
    fromName: true,
    label: quantity > 1 ? `${quantity} × ${size.raw}` : size.raw,
  };
};

// שלוש ספרות: בשתיים 1.5 ק"ג מתוך 5.5 מתומחר כ-1.485 ק"ג
const packsForWeight = (grams, packGrams) =>
  Math.max(0.001, Math.round((grams / packGrams) * 1000) / 1000);

/**
 * משקל האריזה של מוצר נשקל, בגרמים — או null כשאין מה להמיר מולו.
 * נדרשת מידת משקל אחת ויחידה בשם: שתיים ("2 × 3 קילו") אינן חד-משמעיות.
 */
const weighedPackGrams = (product, weighedIds) => {
  if (!product || !weighedIds?.size) return null;

  const categories = [product.category, ...(product.categories || [])].filter(Boolean).map(String);
  if (!categories.some((id) => weighedIds.has(id))) return null;

  const weights = extractSizesFromTitle(product.title).filter((s) => s.base === "gram");
  return weights.length === 1 && weights[0].normalized > 0 ? weights[0].normalized : null;
};

/**
 * התאמת כל הפריטים שה-LLM חילץ למוצרים בקטלוג.
 *
 * זרימה לכל פריט:
 *   1. מנוע ההתאמה (voiceParser + דירוג) מחזיר מוצר + ביטחון.
 *   2. ביטחון גבוה → מקבלים.
 *   3. ביטחון בינוני → ה-LLM מכריע מבין המועמדים האמיתיים בלבד.
 *   4. אין התאמה / ביטחון נמוך גם אחרי הכרעה → הפריט מסומן כלא מזוהה.
 *
 * @param {Object} [options]
 * @param {string} [options.contextText]
 * @param {Map<string,number>|null} [options.priceMap] - מחירון הלקוח. משמש כאן
 *        רק לבדיקת הזמינות: מוצר בלי מחיר בקטלוג אך עם מחיר במחירון הלקוח אינו
 *        נחסם. התמחור עצמו נעשה ב-createOrder.
 * @param {string|ObjectId|null} [options.customerId] - למי שייכת ההזמנה. משמש
 *        להעדפת אליאס פרטי של הלקוח על פני אליאס כלל-מערכתי (ראה
 *        utils/productAliases). בלעדיו נקראים רק אליאסים כלל-מערכתיים —
 *        התנהגות נכונה, אבל היא מוותרת על ההכרעות המדויקות ביותר שיש.
 * @param {boolean} [options.dryRun] - הרצת כיול: הכרעות ה-AI אינן נשמרות ללקוח
 * @param {Object|null} [options.historyProfile] - מה הלקוח קנה בפועל
 *        (utils/customerPurchaseHistory). משמש כשובר שוויון בין מועמדים
 *        שמנוע ההתאמה כבר הביא, ולעולם לא כחיפוש בקטלוג. ראה
 *        utils/purchaseHistoryRanking.
 * @returns {Promise<{items: Array, unmatched: Array, dropped: Array}>}
 *          dropped — שורות שהכמות שלהן הונחה ולא נמצא להן מוצר. הן אינן כשל:
 *          כנראה לא היו פריט מלכתחילה, ולכן אינן מפילות את ההזמנה.
 */
const resolveItems = async (
  llmItems,
  { contextText = "", priceMap = null, customerId = null, historyProfile = null, dryRun = false } = {}
) => {
  // ── אוצר המילים של הקטלוג, פעם אחת להזמנה ──
  //
  // משמש להכריע אם שורה בלי כמות היא ניסיון להזמין מוצר או שיחה (ראה
  // droppedAsText). ממוטמן ב-utils/catalogVocabulary, ולכן הקריאה כאן זולה.
  // כשל אינו מפיל את הקליטה — הוא רק מחזיר את ההתנהגות הקודמת.
  let vocabulary = null;
  try {
    vocabulary = await getCatalogVocabulary();
  } catch (err) {
    console.log(`[ingestion/resolveItems] אוצר המילים לא נטען: ${err.message}`);
  }

  const items = [];
  const unmatched = [];
  // שורות שהכמות שלהן הונחה ולא נמצא להן מוצר — כנראה לא היו פריט מלכתחילה
  const dropped = [];

  // ── קודם מחפשים במה שהלקוח הזה קונה ──
  //
  // עד כאן ההיסטוריה רק דירגה את מה שהחיפוש בקטלוג הביא. זה משאיר בחוץ את
  // המקרה הנפוץ ביותר: המוצר שהלקוח קונה כלל לא הגיע לבריכה, כי 4,300 מוצרים
  // מתחרים על אותן מילים. נמדד (11/10/26): "מי עדן" הותאם ל"מעדן באדי" ב-0.97,
  // "חב' שקיות פח אשפה" למסטיק — ושניהם נכנסו להזמנה שעברה כתקינה.
  //
  // הרשימה של לקוח היא 150–500 מוצרים, ובתוכה אותן מילים מצביעות כמעט תמיד
  // על מוצר אחד. נטענת פעם אחת להזמנה, ורק כשיש שורה שצריכה אותה.
  let ownProductsPromise = null;
  const ownProducts = () => {
    if (!historyProfile?.byProduct?.size) return Promise.resolve([]);
    ownProductsPromise =
      ownProductsPromise ||
      Product.find({ _id: { $in: [...historyProfile.byProduct.keys()] } })
        .select("title sku")
        .lean()
        .catch((err) => {
          console.log(`[ingestion/resolveItems] מוצרי ההיסטוריה לא נטענו: ${err.message}`);
          return [];
        });
    return ownProductsPromise;
  };

  // מוצר שהלקוח קנה, או שיש לו מחיר במחירון הפרטי שלו
  const knownToCustomer = (product) =>
    Boolean(lookupProduct(historyProfile, product)) ||
    priceForProduct(priceMap, product) !== null;

  // הקטגוריות שסחורתן נשקלת. נטען רק כשיש בהזמנה שורה במשקל; כשל מחזיר את
  // ההתנהגות הקודמת (אין המרה, השורה נעצרת לאדם) ואינו מפיל את הקליטה.
  let weighedIdsPromise = null;
  const weighedCategoryIds = () => {
    weighedIdsPromise =
      weighedIdsPromise ||
      manualNoteCategoryIds().catch((err) => {
        console.log(`[ingestion/resolveItems] קטגוריות נשקלות לא נטענו: ${err.message}`);
        return new Set();
      });
    return weighedIdsPromise;
  };

  let lineNo = -1;
  for (const raw of llmItems) {
    lineNo += 1;
    const rawName = String(raw?.rawName || "").trim();
    const quantity = normalizeQuantity(raw?.quantity);
    const unit = raw?.unit || null;
    const note = raw?.note || null;
    // שורה בלי מספר ("מתקן סבון") נקראת כיחידה אחת — ראה tableParser.
    const quantityAssumed = Boolean(raw?.quantityAssumed);
    // "חלב רגיל 2" — הכמות הוסקה מצורת הרשימה (ראה TRAILING_QUANTITY_RE
    // ב-tableParser). שורה כזו שלא נמצא לה מוצר עלולה להיות כתובת ("כנרת 13"),
    // ולכן היא עוברת את אותו מבחן "טקסט או פריט" כמו שורה בלי כמות.
    const quantityInferred = quantityAssumed || Boolean(raw?.quantityFromTrailing);

    if (!rawName) continue;

    const base = {
      rawName,
      quantity,
      unit,
      note,
      quantityAssumed,
      ...(raw?.countUnit ? { countUnit: true } : {}),
      [LINE]: lineNo,
      [SOURCE]: String(raw?.sourceLine || rawName),
    };

    /**
     * ── שורה שהכמות שלה הונחה: או התאמה ברורה, או שזה בכלל לא פריט ──
     *
     * שורה בלי כמות היא ניחוש של המערכת שמדובר בפריט, ולכן היא נכנסת להזמנה
     * רק בביטחון שממילא מספיק לקבלה אוטומטית. כל דבר אחר חוזר להיות טקסט:
     * הוא נרשם בהערת ההזמנה, מוצג במסך הקליטה — ו**אינו מפיל את ההזמנה**.
     *
     * הניסיון הראשון כאן העמיד את הגבול על 0.4, מתוך הנחה שביטחון מפריד בין
     * שם מוצר לטקסט. מדידה על הקטלוג האמיתי הפריכה את ההנחה: "הרצל 5 בני
     * ברק" קיבל 0.47 מול "שכירות חודש 08/25 עבור נכס ברחוב בן גוריון 19",
     * "קומה 3 דירה 12" קיבל 0.6 — בעוד שם מוצר אמיתי ("מגבות נייר") יורד
     * ל-0.53 כשיש לו כפילויות בקטלוג. הטווחים חופפים, ולכן כל גבול ביניים
     * היה הופך כל שורת כתובת בהזמנה לכשל שמעביר את ההזמנה לטיפול ידני.
     *
     * המחיר: שורה בלי כמות שהתאמתה עמומה לא תיכנס להזמנה. היא לא נעלמת —
     * לפני השינוי הזה היא לא נקראה בכלל, וכעת הטקסט שלה לפחות מגיע להערה
     * ולמסך. שורה שהלקוח כתב עם כמות ממשיכה להיכשל בקול כמו קודם.
     */
    const droppedAsText = (conf, reason, candidates = null) => {
      if (!quantityInferred) return false;
      // משקל מפורש שנמצא לו מוצר נשקל הוא בקשה, לא שיחה
      if (base.weightAsk?.sizeWaived) return false;

      // ── שורה שכל מילה בה נמצאת בשם מוצר אינה טקסט ──
      //
      // הכלל שלמעלה שתק על שורה אמיתית: הזמנה #10066 ביקשה "3. עוגיות",
      // הנקודה מנעה את קריאת הכמות, "עוגיות" קיבל 0.53 מול חמישה מוצרים
      // שנבדלים בנקודה אחת מתוך 18,199 — והשורה ירדה להערה. ההזמנה נוצרה
      // כ"נקראה במלואה" בלי עוגיות ובלי שאיש ידע שחסר בה פריט.
      //
      // ‏coversAllWords הוא אותו מבחן שמפריד טקסט משם מוצר שלושים שורות
      // למטה, ובאותו נימוק: "קומה 3 דירה 12" לא תמצא מוצר שנושא גם "קומה"
      // וגם "דירה", ואילו "עוגיות" נמצאת במלואה ב"עוגיות אוראו". השורה
      // עוברת לאדם עם המועמדים לצידה — לא נכנסת להזמנה ולא נעלמת ממנה.
      //
      // הבדיקה היא על **כל המועמדים** ולא על המוביל בלבד. הסינון לפי צורת
      // אריזה מחליף את המוביל, ולכן "מגבות נייר" — מוצר אמיתי — נבדק מול
      // "נייר מגבת חוגלה שישיות" שאין בו "מגבות", ונפל. די בכך שמוצר אחד
      // בקטלוג נושא את כל מה שהלקוח כתב כדי שהשורה תהיה שם מוצר.
      //
      // ‏hasProductWord נבדק לצד הכיסוי: שורה שכולה כמות ויחידה
      // ("5 יח'") מכוסה על ידי כל מוצר שנושא "יח" — כלומר מבחן הכיסוי לבדו
      // מאשר אותה, וההזמנה נעצרת בגלל שבר של שורת טבלה.
      const pool = [].concat(candidates || []).filter(Boolean);
      const describesProduct =
        hasProductWord(searchName) &&
        pool.some((candidate) => coversAllWords(searchName, candidate));

      if (describesProduct) return false;

      // ── שורה שלא כוסתה במלואה אינה בהכרח שיחה ──
      //
      // "חלב 3 אחוז" מול "חלב טרי 3%" — "אחוז" אינו בשם, והכיסוי נכשל. עד כה
      // השורה ירדה להערה וההזמנה נכנסה כ"נקראה במלואה", כלומר **נשלחה בלי
      // הפריט**. זה הכשל השקט הגרוע ביותר: אין שגיאה, אין מסך, אין מי שיעצור.
      //
      // מילה מתחום המוצרים מבדילה: "חלב" מופיעה ב-41 שמות מוצר, ואילו "מה"
      // ו-"סבבה" באחד. שורה כזו אינה יורדת להערה — היא ממשיכה במסלול הרגיל
      // ומגיעה לאדם עם המועמדים לצידה.
      //
      // הכיוון בטווח הספק הוא **לאדם ולא להערה**: שורת שיחה שנשלחת לבדיקה
      // עולה מבט אחד, ופריט אמיתי שיורד להערה נשלח חסר. נמדד: 1 מתוך 30
      // ביטויי שיחה מגיע לאדם, ו-0 מתוך 16 מוצרים בניסוח חופשי אובד.
      //
      // ‏!vocabulary: כשהאוצר לא נטען אין אות, והברירה היא בין להשתיק את
      // השורה לבין להעביר אותה לאדם. הכיוון הוא **לאדם** — תקלה רגעית במסד
      // אינה סיבה להתחיל לשלוח הזמנות חסרות בשקט.
      if (!vocabulary || looksLikeProductAttempt(searchName, vocabulary)) return false;

      // ── ולמה הכיסוי גובר על הביטחון, ולא רק משלים אותו ──
      //
      // הניסוח הקודם בדק כיסוי **רק** מתחת ל-MIN_ITEM_CONFIDENCE, כלומר שורה
      // בלי כמות שקיבלה 0.7+ נכנסה להזמנה בלי שנשאל אם היא בכלל שם מוצר.
      //
      // ‏ביטחון אינו יכול להפריד ביניהם. נמדד על הקטלוג הזה מול 60 ביטויי
      // שיחה: "מה נשמע" מקבל 0.6, "סבבה גמור" 0.6, "נו טוב" 0.6 — **גבוה
      // מ-0.53 שמקבלים "מגבות נייר", "קלסר" ו-"חלב טרי"**. הטווחים חופפים
      // לחלוטין.
      //
      // הכיסוי כן מפריד: מתוך 60 ביטויי השיחה אחד בלבד נמצא מכוסה, ומתוך 67
      // שמות מוצר אמיתיים (46 מהיסטוריית לקוח + 21 צורות מקוצרות) **אף אחד
      // לא נפסל**. לכן זה הכלל, ורשימת מילות המילוי שב-tableParser היא קיצור
      // דרך שחוסך עבודה — לא ההגנה.
      //
      // ‏!pool.length: כשאין מועמדים אין מול מה לבדוק כיסוי, ואז הסף נשאר
      // הקריטריון היחיד — בדיוק כמו קודם.
      if (!pool.length && conf >= MIN_ITEM_CONFIDENCE) return false;

      dropped.push({ ...base, reason });
      return true;
    };

    // המועמדים שנבדקים כשמכריעים אם השורה היא טקסט. נקרא כפונקציה ולא נשמר
    // כערך: ‏match ו-chosenProduct משתנים תוך כדי (סינון מזהים, הכרעת LLM),
    // וצילום מוקדם שלהם היה בודק מועמדים שכבר אינם הרלוונטיים.
    const textCandidates = () => [chosenProduct, match.product, ...(match.alternatives || [])];

    // ── חילוץ המזהים לפני החיפוש ──
    //
    // קריטי שהחיפוש ייעשה על השם *המנוקה*: הביטוי השלילי הוא חלק מהטקסט שהלקוח
    // כתב, ואם הוא נשאר בשאילתה הוא מרעיל אותה. "תה חליטת לימונית ולואיזה
    // (לא תה ירוק)" היה מחפש מוצר שהכותרת שלו מכילה גם "לא" וגם "ירוק" —
    // ולכן לא מוצא כלום, למרות שהמוצר קיים בקטלוג.
    // גם ההוראה המותנית ("אם אין אז תכלת") מוסרת מהשאילתה מאותה סיבה.
    const qualifiers = extractQualifiers(rawName);
    const searchName = qualifiers.cleanName || rawName;

    // ההוראה המותנית מצטרפת להערת הפריט, כדי שתגיע למלקט
    const itemNote = [note, qualifiers.instruction].filter(Boolean).join(" | ") || null;
    base.note = itemNote;

    // בקשה במשקל — ראה requestedWeight. ההמרה עצמה נעשית אחרי ההכרעה, כי רק
    // אז ידוע מול איזו אריזה ממירים.
    const weightAsk = requestedWeight(qualifiers, raw?.quantity, unit, quantity);
    if (weightAsk) base.weightAsk = weightAsk;
    const weighedIds = weightAsk ? await weighedCategoryIds() : null;

    // הכמות שתיכנס להזמנה אם המוצר הזה ייבחר — לבדיקת המלאי. בלי זה "8 ק\"ג"
    // נבדק כ-8 ארגזים ונחסם על מלאי שמספיק בהחלט.
    const orderQuantity = (product) => {
      const packGrams = weightAsk ? weighedPackGrams(product, weighedIds) : null;
      return packGrams ? packsForWeight(weightAsk.grams, packGrams) : quantity;
    };

    // ── הכרעה אנושית שנשמרה גוברת על החיפוש ──
    //
    // אם אדם כבר קבע פעם ש"קולה זירו" של הלקוח הזה הוא מוצר מסוים, אין מה
    // לחפש: החיפוש יחזיר בדיוק את אותה עמימות שבגללה הוא נשאל מלכתחילה.
    //
    // שלילה מפורשת מבטלת את האליאס. "תה לימונית (לא תה ירוק)" הוא בקשה
    // *מסויגת*, והסייג נכתב דווקא כי הפעם הלקוח רוצה משהו אחר מהרגיל. אליאס
    // שנשמר על "תה לימונית" אינו יודע דבר על הסייג הזה, ולהחיל אותו פירושו
    // להתעלם מהמשפט היחיד שהלקוח טרח לכתוב.
    let aliasHit = null;
    if (!qualifiers.negations.length) {
      try {
        aliasHit = await findAliasMatch(searchName, customerId);
      } catch (err) {
        // אליאסים הם שכבת שיפור, לא תלות. תקלה כאן מחזירה לחיפוש הרגיל.
        console.log(`[ingestion/resolveItems] שליפת אליאס ל-"${rawName}" נכשלה: ${err.message}`);
      }
    }

    // ── אדם קבע שהשורה הזו אינה מוצר ──
    //
    // כותרת קבוצה, שאלה, שם של עובד — מה שהכללים לא תפסו ואדם סימן במסך
    // ההזמנה "לא מוצר". השורה יורדת להערה כמו כל טקסט, ואינה עוצרת את ההזמנה.
    if (aliasHit?.ignore) {
      recordAliasHit(aliasHit.alias._id);
      dropped.push({ ...base, reason: "סומן במסך ההזמנה: לא שורת מוצר" });
      continue;
    }

    // ── אדם קבע שהשורה הזו היא כמה מוצרים ──
    //
    // "חד פעמי סכו"ם וצלחות" אינו מוצר אחד בקטלוג אלא מזלגות, סכינים, כפות
    // וצלחות. השורה נפרשת כאן לפריט לכל מוצר, בכמות שנקבעה לו או בכמות שהלקוח
    // כתב בשורה (ראה products ב-models/ProductAlias).
    //
    // המסלול נפרד מהמסלול הרגיל שלמטה, כי כל השלבים שם (סינון מזהים, היסטוריה,
    // מילת אריזה, המרת משקל) שואלים "איזה מוצר אחד התכוונו אליו" — שאלה
    // שאדם כבר ענה עליה כאן אחרת. נשארת רק בדיקת הזמינות: האליאס עונה על
    // "למה התכוונו", לא על "אפשר לספק את זה".
    //
    // גם אליאס של מוצר אחד עם כמות קבועה עובר כאן: המסלול הרגיל מכניס תמיד
    // את הכמות שבשורה, והכמות שאדם קבע הייתה נבלעת בו בשקט.
    if (aliasHit?.products?.length > 1 || aliasHit?.products?.[0]?.quantity) {
      recordAliasHit(aliasHit.alias._id);
      const decidedBy = `alias(${aliasHit.scope === "customer" ? "לקוח" : "כללי"})+כמה-מוצרים`;
      // בקשה במשקל אינה חלה על פריסה: "2 ק"ג סכו"ם" לא אומר כמה מכל מוצר,
      // והמרה לאריזות של כל אחד מהם הייתה ממציאה כמויות
      const { weightAsk: _ignoredWeight, ...lineBase } = base;
      const expanded = aliasHit.products.map(({ product, quantity: fixed }) => ({
        ...lineBase,
        product,
        quantity: fixed ?? quantity,
        // הכמות כבר אינה "הונחה" כשאדם קבע אותה למוצר הזה
        quantityAssumed: fixed ? false : quantityAssumed,
        confidence: 1,
        matchScore: ALIAS_MATCH_SCORE,
        decidedBy,
        alternatives: [],
      }));

      // ── מוצר אחד שאי אפשר לספק עוצר את כל השורה ──
      //
      // ולא רק את הפריט שלו: מי שעובר על ההזמנה רואה את השורה כפי שהלקוח
      // כתב אותה, עם כל המוצרים שלה כהצעה — ויכול להחליף את המוצר שאזל
      // בתוך אותה הכרעה. פריסה חלקית הייתה מכניסה את השאר להזמנה, והשורה
      // שנשארת פתוחה הייתה נשמרת מחדש כמוצר אחד ומוחקת את הפריסה.
      const blocked = expanded
        .map((item) =>
          productUnavailableReason(item.product, item.quantity, priceForProduct(priceMap, item.product))
        )
        .filter(Boolean);
      if (blocked.length) {
        unmatched.push({
          ...lineBase,
          confidence: 1,
          matchScore: ALIAS_MATCH_SCORE,
          alternatives: [],
          productTitle: aliasHit.product.title?.he,
          suggestions: aliasHit.products.map((entry) => entry.product),
          product: undefined,
          failReason:
            expanded.length > 1
              ? `השורה נשמרה כ-${expanded.length} מוצרים, ולא כולם זמינים: ${blocked.join(" ")}`
              : blocked[0],
        });
        continue;
      }

      items.push(...expanded);
      continue;
    }

    let match;
    if (aliasHit) {
      recordAliasHit(aliasHit.alias._id);
      match = {
        product: aliasHit.product,
        // הניקוד משמש רק לתיעוד ולהשוואה מול מועמדים; אין מועמדים אחרים כאן.
        score: ALIAS_MATCH_SCORE,
        confidence: 1,
        quantityFromText: null,
        query: searchName,
        alternatives: [],
      };
    } else {
      try {
        // הקליטה מחפשת בכל הקטלוג — כולל מוצרים מוסתרים ומוצרים בלי מלאי —
        // כדי שנוכל לומר "המוצר קיים אבל מוסתר" במקום "לא נמצא". הסינון עצמו
        // נעשה מיד אחרי, ב-productUnavailableReason.
        match = await matchProductByName(searchName, {
          requireShown: false,
          requireStock: false,
          // רשימת מועמדים רחבה מברירת המחדל: היא הבריכה שבתוכה המק"ט שהלקוח
          // הדפיס מחפש את עצמו (ראו למטה), וגם מה שה-LLM מקבל להכרעה.
          alternativesCount: 8,
          // הבריכה המלאה לשלבי הסינון הפנימיים — ראה CANDIDATE_POOL_SIZE
          poolCount: CANDIDATE_POOL_SIZE,
          // ── שליפה רחבה, רק כשיש היסטוריה לאמת מולה ──
          //
          // בלי זה, שאילתה שתואמת ליותר מ-20 מוצרים ("נייר" — 156, "תה" — 148)
          // מקבלת 20 שרירותיים מה-DB, **לפני** שיש ציונים. המוצר שהלקוח קונה
          // יכול פשוט לא להישלף, וההיסטוריה לעולם לא תראה אותו — בדיוק מה
          // שקרה ב-"קלסר", רק חמור יותר: שם החיתוך היה אחרי הדירוג, כאן הוא
          // לפניו.
          //
          // ‏poolCount עולה יחד איתו כדי שההיסטוריה תראה את כל מי שנשלף.
          // ‏alternativesCount נשאר 8, ולכן מה שנשמר על ההזמנה ומה שנשלח
          // ל-LLM לא משתנה.
          //
          // **זה משנה גם את המועמד המוביל** אצל לקוח עם היסטוריה: הוא נבחר
          // מעכשיו מבין כל מי שתואם ולא מבין 20 אקראיים. זו התנהגות נכונה
          // יותר, אבל היא שונה — ולכן היא מוגבלת ללקוחות שיש להם היסטוריה,
          // כלומר למי שיש דרך עצמאית לאמת את התוצאה.
          ...(historyProfile
            ? {
                candidateLimit: HISTORY_CANDIDATE_LIMIT,
                poolCount: HISTORY_CANDIDATE_LIMIT,
              }
            : {}),
        });
      } catch (err) {
        // רגרסיה בבניית ה-regex או שגיאת DB — הפריט לא מזוהה, ההודעה כולה לא נופלת
        console.log(`[ingestion/resolveItems] כשל בהתאמת "${rawName}": ${err.message}`);
        unmatched.push({ ...base, confidence: 0, failReason: `תקלה בחיפוש המוצר: ${err.message}` });
        continue;
      }
    }

    if (!match) {
      if (droppedAsText(0, "לא נמצא מוצר בשם הזה")) continue;
      unmatched.push({
        ...base,
        confidence: 0,
        failReason: "לא נמצא מוצר בשם הזה בקטלוג",
      });
      continue;
    }

    // ── שובר שוויון: המק"ט שהלקוח הדפיס בהזמנה ──
    //
    // שם מוצר הוא טקסט חופשי ולכן עמום מטבעו; מק"ט הוא מפתח. כשהזמנת רכש
    // נושאת עמודת מק"ט, המספר הזה מכריע מיידית בין מועמדים שהשם לבדו לא הצליח
    // להפריד ("חלב עמיד 3%" מול "חלב עמיד 1%", ששניהם קיבלו ציון זהה לחלוטין).
    //
    // הזהירות כאן מכוונת: המספר **אינו מחפש בקטלוג בעצמו**, אלא רק מזוהה בתוך
    // רשימת המועמדים שהשם כבר הביא. הסיבה היא שהמק"ט בהזמנה הוא של מערכת
    // הלקוח, לא שלנו — בהזמנה אמיתית שנבדקה כאן הופיע 880025 שאינו קיים בקטלוג.
    // חיפוש ישיר לפי המספר הזה היה מושך מוצר אקראי שבמקרה נושא אותו מספר,
    // כלומר הופך הזמנה שנתקעת לאדם להזמנה שגויה בשקט. קוד זר פשוט לא יתאים
    // לאיש מהמועמדים, והזיהוי ימשיך לפי השם כרגיל.
    const sourceSku = String(raw?.sourceSku || "").trim();
    let skuConfirmed = false;

    // אליאס הוא הכרעה של אדם שמכיר את הלקוח, והמק"ט בהזמנה הוא של מערכת
    // הלקוח ולא שלנו (ראה ההסבר למעלה). אין סיבה שהשני יבטל את הראשון.
    if (sourceSku && !aliasHit) {
      // ── למה דווקא כאן נשאר החלון הצר ──
      //
      // אותו חיתוך שרירותי שפוגע בהיסטוריה פוגע גם כאן: מק"ט שהלקוח הדפיס
      // והמוצר שלו דורג במקום 11 אינו נמצא. **אבל** הרחבה כאן מגדילה גם את
      // הסיכון שהוזהר ממנו למעלה — קוד זר שנופל במקרה על מק"ט שלנו — ולא
      // נמדדה כאן. הרחבתה היא שינוי בהתנהגות של מסלול שעובד היום ואינו חלק
      // מהתקלה שתוקנה, ולכן היא נשארת החלטה מפורשת ולא תופעת לוואי.
      const pool = [match.product, ...(match.alternatives || [])];
      const hit = pool.find(
        (c) => c?.sku && String(c.sku).trim().toLowerCase() === sourceSku.toLowerCase()
      );

      if (hit) {
        // המועמד המוביל הוא כבר מסמך מלא; לחלופות יש רק _id/title/sku
        const full = hit.prices !== undefined ? hit : await Product.findById(hit._id).lean();
        if (full) {
          match = { ...match, product: full, confidence: 0.99 };
          skuConfirmed = true;
        }
      }
    }

    // ── הפעלת מזהי הגרסה על המועמדים (מנוע פנימי, בלי AI) ──
    //
    // כאן נסגר פער אמיתי במנוע ההתאמה: voiceParser מסיר ספרות מהשאילתה, ולכן
    // "קפה 200 גרם" ו-"קפה 100 גרם" נראים לו זהים. השלב הזה מחזיר את המשקל,
    // את מספר היחידות ואת מזהי הצבע למשחק, ואוכף שלילה מפורשת של הלקוח
    // ("לא תה ירוק").
    let qualifierNotes = [];
    // הבריכה שההיסטוריה תדרג. ברירת המחדל היא מה שמנוע ההתאמה הביא; אם שלב
    // מזהי הגרסה רץ, הוא מצמצם אותה למי ששרד. ההבחנה קריטית — היסטוריה שתדרג
    // את הבריכה המקורית הייתה יכולה להחזיר לחיים מועמד שנפסל בשלילה מפורשת.
    let survivingPool = null;
    let requestedSizeMissing = false;
    // מה בדיוק הלקוח ביקש ולא קיים ("500 גרם", "גדולות") — נכנס להודעה לעובד
    let missingSizeLabel = null;
    // המידה חסרה בחלון הצר אבל קיימת בבריכה הרחבה — ראה ליד ההכרעה לפי היסטוריה
    let sizeFoundInWidePool = false;

    // כשהמק"ט כבר הכריע אין מה לסנן: מזהי הגרסה נועדו להפריד בין מועמדים
    // דומים, והמפתח עשה זאת בוודאות גבוהה יותר מכל היוריסטיקה על שם.
    //
    // אליאס מדלג על השלב הזה מאותה סיבה שהמק"ט מדלג עליו: מזהי הגרסה נועדו
    // להפריד בין מועמדים דומים, וכאן אין מועמדים — יש מוצר אחד שאדם קבע.
    // סינון מזהים על מועמד יחיד יכול רק לפסול אותו, כלומר לבטל את ההכרעה.
    // ── למה גם כשהלקוח לא ציין שום מזהה ──
    //
    // התנאי המקורי דרש שהלקוח יציין מזהה כלשהו, מתוך הנחה שבלי מזהה אין מה
    // לסנן. ההנחה נשברה על "קולה זירו": אין בה מידה, גודל, גוון או שלילה,
    // ולכן היא דילגה על השלב כולו — ונשארה עם שישה מועמדים בהפרש נקודה אחת.
    //
    // אבל **השתיקה עצמה היא מידע**. לקוח שלא כתב "פחיות" לא ביקש פחיות, ומועמד
    // שנושא צורת אריזה או טעם שלא נאמרו נפסל בדיוק מהסיבה הזו (ראה
    // applyQualifiers, הבלוק האחרון). זה עובד רק אם מגיעים לשם.
    //
    // התנאי `alternatives.length` שומר על העלות: פריט עם מועמד יחיד אין מה
    // לסנן בו, וזה הרוב.
    if (
      !skuConfirmed &&
      !aliasHit &&
      (qualifiers.negations.length ||
        qualifiers.plain ||
        qualifiers.sizes.length ||
        qualifiers.sizeWords.length ||
        qualifiers.variants.length ||
        match.alternatives.length)
    ) {
      const candidatePool = [
        { product: match.product, score: match.score },
        ...match.alternatives.map((a) => ({ product: a, score: a.score })),
      ];

      const { kept, rejected, appliedFilters, sizeMismatch, sizeMismatchLabel } =
        applyQualifiers(candidatePool, qualifiers);
      requestedSizeMissing = Boolean(sizeMismatch);
      missingSizeLabel = sizeMismatchLabel;

      // ── שלילה על מוצר "סוגים שונים" היא בחירה מתוכו, לא דחייה שלו ──
      //
      // "פסטרמה/נקניק סוגים שונים — נקניק, לא פסטרמה": הלקוח קונה את המוצר
      // הזה (109 פעמים) ואומר איזה סוג. השלילה פסלה את המוצר היחיד. כשהמוביל
      // הוא מוצר "סוגים שונים" שהלקוח קונה, הוא נכנס והבקשה מגיעה כהערה.
      if (!kept.length && isAssorted(match.product) && knownToCustomer(match.product)) {
        items.push({
          ...base,
          product: match.product,
          confidence: HISTORY_MATCH_CONFIDENCE,
          matchScore: match.score,
          decidedBy: "היסטוריה(סוגים שונים)",
          alternatives: match.alternatives,
          note: [base.note, `הלקוח כתב: "${rawName}"`].filter(Boolean).join(" | "),
        });
        continue;
      }

      if (!kept.length) {
        // כל המועמדים נפסלו — לרוב בגלל שלילה מפורשת. עדיף לא לנחש.
        if (droppedAsText(match.confidence, "לא נמצא מוצר מתאים")) continue;
        unmatched.push({
          ...base,
          confidence: 0,
          matchScore: match.score,
          alternatives: candidatePool.map((c) => c.product),
          failReason:
            rejected[0]?.reason || "אין בקטלוג מוצר שמתאים למה שהלקוח ביקש",
        });
        continue;
      }

      // המועמד המוביל אחרי הסינון עשוי להיות אחר מזה שהמנוע בחר
      const topAfter = kept[0];
      if (String(topAfter.product._id) !== String(match.product._id)) {
        const replacement =
          topAfter.product.prices !== undefined
            ? topAfter.product
            : await Product.findById(topAfter.product._id).lean();

        if (replacement) {
          match = {
            ...match,
            product: replacement,
            score: topAfter.score,
            // סינון החזיר החלטה חד-משמעית → ביטחון גבוה
            confidence: kept.length === 1 ? 0.95 : match.confidence,
          };
        }
      } else if (kept.length === 1) {
        // אותו מוצר, אבל עכשיו הוא היחיד שעומד בתנאים
        match = { ...match, confidence: Math.max(match.confidence, 0.95) };
      }

      if (appliedFilters.length) qualifierNotes = appliedFilters;

      // ── הבריכה הרחבה, להיסטוריה בלבד ──
      //
      // כל מה שלמעלה עובד על החלון הצר בדיוק כמו קודם, בלי שינוי. הסיבה
      // מדידה: הביטחון 0.95 ניתן כש-`kept.length === 1`, ו-`sizeMismatch`
      // נקבע לפי "אף מועמד לא נושא את המידה שביקשו". שניהם משתנים כשמרחיבים
      // את הבריכה — ופריטים שהתקבלו אוטומטית עד היום היו מתחילים ליפול
      // לטיפול ידני. זו רגרסיה בכיסוי שאיש לא ביקש.
      //
      // ההיסטוריה היא הצרכן היחיד שמרוויח מהרוחב, כי היא **מזהה** בתוך בריכה
      // ולא מדרגת אותה מחדש: מועמד נוסף יכול רק להיתפס כמוכר או להתעלם ממנו.
      // לכן הסינון רץ עליה שוב, בנפרד — פונקציה טהורה בזיכרון, בלי שאילתה —
      // ורק כשללקוח יש היסטוריה בכלל.
      //
      // הסינון **חייב** לרוץ גם עליה: בלעדיו שלילה מפורשת ("לא תה ירוק")
      // הייתה חוסמת בחלון הצר וחוזרת מהדלת האחורית דרך הרחב.
      if (historyProfile) {
        const widePool = [
          { product: match.product, score: match.score },
          ...(match.pool || match.alternatives).map((a) => ({
            product: a,
            score: a.score,
          })),
        ];
        // ‏keptBeforeSilentDrops ולא kept: הסינון האחרון ב-applyQualifiers הוא
        // כלל של שתיקה — "הלקוח לא כתב 50 יח, מכאן שלא רצה 50 יח". זה ההסבר
        // החלש ביותר בשרשרת, וההיסטוריה היא ראיה חזקה ממנו בהרבה. נמדד אצל
        // לקוח אמיתי: "כפיות" ירד מ-21 מועמדים ל-6 והכפיות שהוא קונה 4 פעמים
        // נמחקו; "נייר טואלט" מ-27 ל-8; "כוסות" מ-91 ל-2.
        //
        // שלילה מפורשת ומידה שביקש כבר סוננו למעלה ואינן חוזרות דרך כאן.
        const wide = applyQualifiers(widePool, qualifiers);
        survivingPool = wide.keptBeforeSilentDrops.map((k) => ({ product: k.product }));
        // הבריכה הרחבה מכילה את הצרה, ולכן "אין אי-התאמה" בה פירושו שמישהו
        // נושא את המידה — ומי ששרד את הסינון הוא בדיוק מי שנושא אותה.
        sizeFoundInWidePool = requestedSizeMissing && !wide.sizeMismatch;
      }
    }

    // ── המידה "חסרה" רק מפני שהמוצר נמכר במשקל ──
    //
    // "1.5 קילו" מול "בננות 5.5 קילו" אינו מוצר שאין אלא חלק מארגז. מילת
    // גודל שלא נמצאה ("גדולות") נשארת סיבה לעצור, ולכן היא מבטלת את הוויתור.
    if (
      weightAsk?.fromName &&
      requestedSizeMissing &&
      !qualifiers.sizeWords.length &&
      weighedPackGrams(match.product, weighedIds)
    ) {
      requestedSizeMissing = false;
      missingSizeLabel = null;
      weightAsk.sizeWaived = true;
      qualifierNotes = [...qualifierNotes, "נמכר במשקל"];

      // המשקל אינו חלק משם המוצר: מה שנשאר ("בננות") הוא מה שצריך להימצא
      // בשם. כשהוא נמצא, ואין מוצר נשקל אחר שעונה לאותו שם, אין מה להכריע.
      const nameOnly = qualifiers.sizes
        .reduce((text, size) => text.replace(size.raw, " "), searchName)
        .replace(/\s+/g, " ")
        .trim();
      // החלופות מגיעות רזות, בלי קטגוריה — ובלעדיה "יוגורט בננות 150 גרם"
      // נראה כמו ארגז מתחרה. נשלפות רק אלה שהשם והמשקל שלהן מתאימים.
      const lookalikes = (match.alternatives || []).filter(
        (alt) =>
          String(alt._id) !== String(match.product._id) &&
          extractSizesFromTitle(alt.title).some((s) => s.base === "gram") &&
          coversAllWords(nameOnly, alt)
      );
      const rival =
        lookalikes.length > 0 &&
        (
          await Product.find({ _id: { $in: lookalikes.map((alt) => alt._id) } })
            .select("title category categories")
            .lean()
        ).some((candidate) => weighedPackGrams(candidate, weighedIds));
      if (nameOnly && !rival && coversAllWords(nameOnly, match.product)) {
        match = { ...match, confidence: Math.max(match.confidence, AUTO_ACCEPT_CONFIDENCE) };
      }
      // שני ארגזים באותו שם ("תפוחים 5 קילו" / "12 קילו"): מחיר הקילו שונה
      // ביניהם, ולכן מאיזה מהם לשקול היא הכרעה של אדם — ראה autoPick.
      weightAsk.rival = rival;
    }

    let chosenProduct = match.product;
    let confidence = match.confidence;
    let decidedBy = aliasHit
      ? `alias(${aliasHit.scope === "customer" ? "לקוח" : "כללי"})`
      : skuConfirmed
        ? `sku(${sourceSku})`
        : qualifierNotes.length
          ? `catalog+מזהים(${qualifierNotes.join("; ")})`
          : "catalog";

    // ── שם זהה = החלטה, לא ניחוש ──
    //
    // מנוע ההתאמה מדרג לפי ניקוד ומחזיר ביטחון לפי כמה מועמדים קרובים נמצאו.
    // לכן "נייר אפייה 50 יחידות" קיבל ביטחון 0.53 — למרות שהמוצר שנבחר נושא
    // **בדיוק אותו שם** — רק כי קיים בקטלוג גם "נייר אפייה 50 יחידות (ח')".
    // התוצאה: פריטים שזוהו נכון לחלוטין נפלו מתחת לסף ועברו לטיפול ידני.
    //
    // כשהשם שהלקוח כתב זהה לשם המוצר, אין מה להכריע. קיומו של מוצר אחר בשם
    // דומה אינו הופך את ההתאמה המדויקת למפוקפקת.
    //
    // `!skuConfirmed` בתנאי אינו קוסמטי: כשהמק"ט הוא שהכריע, הוא מה שצריך
    // להופיע ב-decidedBy. בלי הסייג הזה כל פריט שגם שמו זהה היה מתויג
    // "catalog+שם-זהה", כלומר תיעוד ההכרעה היה מצביע על השם — ומי שבודק למה
    // נבחר מוצר מסוים היה מקבל תשובה שגויה.
    if (!skuConfirmed && isExactTitleMatch(chosenProduct, searchName, rawName)) {
      confidence = Math.max(confidence, 0.95);
      decidedBy = qualifierNotes.length
        ? `catalog+מזהים(${qualifierNotes.join("; ")})+שם-זהה`
        : "catalog+שם-זהה";
    }

    // ── המידה שהלקוח ביקש לא קיימת באף מועמד ──
    //
    // ההתאמה עשויה להיראות מצוינת לפי השם, אבל אם ביקשו 500 גרם ובקטלוג יש רק
    // 360 גרם — זה לא אותו מוצר. הורדה מתחת לסף הקבלה האוטומטית שולחת את
    // הפריט לאדם עם המועמד המוביל לצידו, במקום להכניס אריזה אחרת להזמנה.
    //
    // המק"ט גובר: כשהוא זוהה, המוצר ידוע בוודאות ואי-התאמת מידה בשם אינה
    // מעידה על טעות אלא על ניסוח שונה בקטלוג.
    if (requestedSizeMissing && !skuConfirmed) {
      confidence = Math.round(Math.min(confidence, MIN_ITEM_CONFIDENCE - 0.05) * 100) / 100;
      decidedBy += "+מידה-חסרה";
    }

    // ── מה הלקוח הזה קונה בפועל ──
    //
    // כאן נסגר הפער שאף שלב קודם אינו יכול לסגור. 66% מהשורות שנתקעות אינן
    // באג בזיהוי אלא עמימות אמיתית: הלקוח כתב קטגוריה ולא מוצר. "פרכיות"
    // מתאים לשישה מוצרים שהציון שלהם נבדל בנקודה אחת מתוך 18,428, ואין בטקסט
    // שום דבר שמכריע ביניהם. גם אדם לא היה מכריע מהטקסט — הוא מכריע מתוך
    // היכרות עם הלקוח, וזו בדיוק ההיכרות ששמורה כאן.
    //
    // ── שלושה תנאים לכניסה, וכל אחד מהם הוא גבול ──
    //
    // ‏!aliasHit    — אליאס הוא הכרעה מפורשת של אדם על השם הזה. סטטיסטיקה
    //                 שדורסת אותה היא בדיוק הכשל ש-ProductAlias מזהיר מפניו.
    // ‏!skuConfirmed — המק"ט הוא מפתח; הוא ודאי יותר מכל היוריסטיקה על שם.
    // ‏confidence <  — מעל הסף אין מה להכריע, ואין טעם לשלם על החישוב.
    //
    // מה שהיסטוריה **אינה** עושה: היא אינה מחפשת בקטלוג. הבריכה שהיא מדרגת
    // היא זו שמנוע ההתאמה הביא, ואם שלב מזהי הגרסה רץ — רק מי ששרד אותו.
    // בלי הגבול הזה שלילה מפורשת של הלקוח ("לא תה ירוק") הייתה מבוטלת על ידי
    // מה שהוא נהג לקנות, כלומר המערכת הייתה מתעלמת מהמשפט היחיד שהוא טרח
    // לכתוב.
    //
    // ── מוצר שהלקוח לא קנה אף פעם אינו נכנס לבד ──
    //
    // גם כשהחיפוש בקטלוג בטוח בעצמו. ביטחון גבוה פירושו "השם דומה", לא "זה
    // מה שהלקוח רוצה" — ו"מעדן באדי" דומה מאוד ל"מי עדן". כשיש ללקוח היסטוריה
    // והמוצר אינו בה (ואינו במחירון שלו), ההיסטוריה נשאלת בכל מקרה; ואם גם
    // היא לא מכריעה, השורה מגיעה לאדם פעם אחת.
    //
    // פטורים: מק"ט, אליאס, ושורה שהיא **אותו שם** כמו המוצר — הלקוח כתב את
    // המוצר עצמו, ואין כאן דמיון שצריך לאמת. נמדד: בלי הפטור הזה נעצרו
    // "פסטרמה דק דק" מול "פסטרמה דק דק 120 גר'" ו"3 קילו בננה" מול "בננות 3
    // ק\"ג" — מוצרים נכונים שהלקוח פשוט מזמין לראשונה. ראה sameName.
    const requestText = qualifiers.plain ? withoutPlainWords(searchName) : searchName;
    const judgedByHistory = Boolean(historyProfile) && !aliasHit && !skuConfirmed;
    const unfamiliar = (product) =>
      judgedByHistory &&
      !isExactTitleMatch(product, searchName, rawName) &&
      !knownToCustomer(product) &&
      !sameName(requestText, product, { vocabulary });

    let historyPick = null;
    if (judgedByHistory && (confidence < AUTO_ACCEPT_CONFIDENCE || unfamiliar(chosenProduct))) {
      const pool = survivingPool || [
        { product: match.product },
        ...(match.pool || match.alternatives || []).map((alt) => ({ product: alt })),
      ];

      // מה שהלקוח קונה ונושא את כל מה שנכתב בשורה — גם אם החיפוש בקטלוג לא
      // הביא אותו. עובר את אותו סינון מזהים כמו הבריכה: שלילה ומידה שהלקוח
      // ביקש חלות גם על ההיסטוריה שלו.
      const own = (await ownProducts())
        .filter((product) => coversRequest(requestText, product, { vocabulary }))
        .map((product) => ({ product }));
      const ownFiltered = own.length ? applyQualifiers(own, qualifiers) : null;
      const ownPool = ownFiltered && !ownFiltered.sizeMismatch ? ownFiltered.keptBeforeSilentDrops : [];

      historyPick = pickFromHistory([...pool, ...ownPool], historyProfile, {
        requestText,
        vocabulary,
      });
    }

    // ── שורה בלי כמות: דרישה חדה יותר, לא חסימה ──
    //
    // "3 בננות" הצהירה שהיא פריט. "בננות" היא ניחוש של הפרסר — ובאותו ניחוש
    // נכנסות גם שורות כתובת וחתימה. נמדד: "הרצל 5 בני ברק" קיבל 0.47 ו-"קומה
    // 3 דירה 12" קיבל 0.6, בעוד "מגבות נייר" — מוצר אמיתי — ירד ל-0.53.
    // הטווחים חופפים, ולכן ביטחון אינו יכול להכריע ביניהם.
    //
    // הניסוח הראשון כאן חסם שורות בלי כמות לגמרי. זה היה גורף מדי: "קפה טורקי"
    // היא הצורה הנפוצה ביותר להזמין בווצאפ, וחסימתה מוותרת על רוב הערך —
    // בעוד שהיא בדיוק המקרה שההיסטוריה יודעת לפתור.
    //
    // מה שמפריד באמת הוא שהשורה **מתארת את המוצר**: כל מילה שנכתבה נמצאת בשם
    // המוצר. "קפה טורקי" עומדת בזה מול "קפה טורקי עלית 200 גר"; "קומה 3 דירה
    // 12" לא תמצא מוצר שנושא גם "קומה" וגם "דירה". שורה עם כמות אינה נדרשת
    // לזה — היא כבר הצהירה שהיא פריט.
    //
    // ‏coversRequest הוא אותו מבחן בסובלנות לניסוח: מילת אריזה ("חבילה"), אות
    // שימוש ("ולואיזה") ושגיאת כתיב של תו אחד אינן הופכות שם מוצר לשיחה. הוא
    // עדיין דורש שכל מילת מוצר שנכתבה תימצא בשם — "קומה 3 דירה 12" נשארת בחוץ.
    //
    // ‏related: מוצר שאינו חולק עם השורה אף מילת מוצר אינו מכריע, גם בשורה עם
    // כמות — ראה pickFromHistory.
    const historyMayDecide =
      historyPick?.tier === "decisive" &&
      historyPick.related !== false &&
      (!quantityInferred ||
        historyPick.coversRequest ||
        coversAllWords(
          qualifiers.plain ? withoutPlainWords(searchName) : searchName,
          historyPick.product
        ));

    // ── מידה שהלקוח ביקש ואינה בקטלוג גוברת על ההיסטוריה ──
    //
    // לקוח שביקש 500 גרם וקיים רק 360 ביקש מוצר שאין. העובדה שהוא קנה בעבר
    // את אריזת ה-360 אינה הופכת אותה למה שביקש הפעם, והשורה צריכה להגיע לאדם
    // עם ההסבר. ההיסטוריה עדיין נאמרת לו כרמז — היא רק אינה מאשרת לבדה.
    //
    // ── "אינה בקטלוג" נמדד על החלון הצר, וזה לא אותו דבר ──
    //
    // נמדד על 11 הזמנות אמת: "חלב 3%" מביא לחלון הצר את "חלב לקפה", "חלב
    // עיזים" ו"חלב גד 1 ליטר" — אף אחד מהם אינו 3%, ולכן המידה סומנה כחסרה.
    // אבל "חלב טרי בקרטון 1 ליטר 3%" נמצא בבריכה הרחבה, והלקוח קנה אותו 972
    // פעמים. המוצר שביקש קיים, וההיסטוריה הצביעה עליו — רק שהכלל שלמעלה חסם
    // אותה. כשהמידה נמצאה ברחבה, מי שההיסטוריה בוחרת נושא אותה בהגדרה (הוא
    // שרד את סינון המידה), ולכן אין כאן "אריזה אחרת ממה שביקש".
    //
    // ‏coversRequest: כל מספר שהלקוח כתב נמצא בשם המוצר שנבחר (ראה שם), ולכן
    // המידה שביקש אינה חסרה בו. נמדד: "יגורט פירות 0%" מול "יוגורט פיירות
    // טעמים 3%/0%" שהלקוח קונה 951 פעמים.
    if (
      historyMayDecide &&
      (!requestedSizeMissing || sizeFoundInWidePool || historyPick.coversRequest)
    ) {
      // המועמד המוביל הוא מסמך מלא; חלופות מגיעות רזות (‏_id/title/sku)
      const picked =
        historyPick.product.prices !== undefined
          ? historyPick.product
          : await Product.findById(historyPick.product._id).lean();

      if (picked) {
        chosenProduct = picked;
        // המידה נמצאה — היא כבר אינה סיבה לעצור, לא כאן ולא בהודעה לעובד
        requestedSizeMissing = false;
        missingSizeLabel = null;
        confidence = Math.max(confidence, HISTORY_MATCH_CONFIDENCE);
        decidedBy = qualifierNotes.length
          ? `catalog+מזהים(${qualifierNotes.join("; ")})+היסטוריה`
          : "catalog+היסטוריה";
      } else {
        // המוצר נמחק מהקטלוג בין השליפה להכרעה. אין כאן כשל — חוזרים למסלול
        // הרגיל, כלומר לכל היותר למצב שלפני ההיסטוריה.
        historyPick = null;
      }
    }

    // ── מוצר ה"מגוון סוגים" שהלקוח קונה ──
    //
    // רק כשההיסטוריה לא הכריעה והשורה עומדת להיעצר. הגרסה שהלקוח כתב ("ללא
    // סוכר", "כחול") נצמדת לפריט כהערה, כדי שהמלקט ייקח את הנכונה. ראה
    // assortedOf. אותו סינון מזהים חל גם כאן — שלילה מפורשת נשארת שלילה.
    const decidedByHistory = decidedBy.endsWith("+היסטוריה");
    if (
      judgedByHistory &&
      !decidedByHistory &&
      !requestedSizeMissing &&
      (confidence < AUTO_ACCEPT_CONFIDENCE || unfamiliar(chosenProduct))
    ) {
      const own = await ownProducts();
      // שלילה מפורשת חלה גם כאן; מידה נבדקת בנפרד (requestedSizeMissing)
      const decideAmong = (candidates) => {
        if (!candidates.length) return null;
        const kept = applyQualifiers(candidates, { ...qualifiers, sizes: [], sizeWords: [] })
          .keptBeforeSilentDrops;
        const pick = kept.length
          ? pickFromHistory(kept, historyProfile, { dominanceRatio: OWN_LIST_DOMINANCE_RATIO })
          : null;
        return pick?.tier === "decisive" ? pick.product : null;
      };

      let ownChoice = decideAmong(
        own
          .filter((product) => assortedOf(requestText, product, { vocabulary }))
          .map((product) => ({ product }))
      );
      let ownRule = "מגוון סוגים";

      // ── המוצר של הלקוח שהכי קרוב למה שכתב — ראה closestOwnProducts ──
      //
      // שורה בלי כמות נדרשת גם להיראות כמו שם מוצר: "יום טוב" אינו בקשה ל"יום
      // אף 5", גם אם זה המוצר היחיד של הלקוח שמתחיל ב"יום".
      if (
        !ownChoice &&
        (!quantityInferred || (vocabulary && looksLikeProductAttempt(searchName, vocabulary)))
      ) {
        ownChoice = decideAmong(
          closestOwnProducts(requestText, own, {
            vocabulary,
            usage: (product) => lookupProduct(historyProfile, product),
          })
        );
        ownRule = "הקרוב ביותר";

        // ── המוצר שהחיפוש בקטלוג מצא מתאר את השורה טוב יותר ──
        //
        // נמדד: "שישיית מי סודה" קיבל מההיסטוריה את "מי עדן שישיה" — שתי מילים
        // משותפות — בעוד שבקטלוג יש מוצר שנושא גם "סודה". כשהקטלוג מכיר מוצר
        // שקרוב יותר למה שנכתב, הלקוח ביקש אותו ולא את הרגיל שלו, והשורה
        // נשארת לאדם. בשוויון ההיסטוריה גוברת ("גבינת עיזים של גד").
        if (
          ownChoice &&
          sharedWordCount(requestText, chosenProduct, { vocabulary }) >
            sharedWordCount(requestText, ownChoice, { vocabulary })
        ) {
          ownChoice = null;
        }
      }

      if (ownChoice) {
        const picked = await Product.findById(ownChoice._id).lean();
        if (picked) {
          chosenProduct = picked;
          confidence = Math.max(confidence, HISTORY_MATCH_CONFIDENCE);
          decidedBy = `היסטוריה(${ownRule})`;
          // מה שהלקוח כתב מגיע למלקט: הגרסה, המותג או הניסוח שלו
          base.note = [base.note, `הלקוח כתב: "${rawName}"`].filter(Boolean).join(" | ");
        }
      }
    }

    // ההיסטוריה לא הכריעה, והמוצר שנשאר אינו משהו שהלקוח קנה
    const neverBought = unfamiliar(chosenProduct);
    if (neverBought) {
      confidence = Math.round(Math.min(confidence, MIN_ITEM_CONFIDENCE - 0.05) * 100) / 100;
      decidedBy += "+לא-נקנה-בעבר";
    }

    // מה שההיסטוריה יודעת נאמר לעובד גם כשהיא לא הכריעה. שורה שנתקעת מציגה
    // "הלקוח הזמין בעבר X 6 פעמים, Y פעם אחת" — וזה בדיוק המידע שהוא היה
    // מחפש ידנית. ההודעה מנוסחת ב-describeEvidence, ליד הכללים שמייצרים אותה.
    const historyNote = historyPick?.reason || null;

    // ההערה נצמדת לסיבת הכשל ולא מחליפה אותה: מה שעצר את השורה נשאר המשפט
    // הראשון, וההיסטוריה היא ההקשר שמאפשר להכריע מהר.
    const withHistory = (reason) => (historyNote ? `${reason} · ${historyNote}` : reason);

    // ── שורה שהכמות שלה הונחה ולא נגעה בשום מוצר ──
    //
    // ההכרעה נעשית כאן, לפני כל שלב נוסף, ולא בכל ענף כשל בנפרד: משם היא גם
    // חוסמת קריאת LLM בתשלום על שורת טקסט כשההכרעה החיצונית מודלקת, וגם
    // מונעת בדיקת זמינות של מוצר שממילא לא הלקוח ביקש.
    if (droppedAsText(confidence, "השורה לא נראית כשם מוצר", textCandidates())) continue;

    // ── זמינות המוצר ──
    // המוצר נמצא בקטלוג. עכשיו נבדק אם אפשר בכלל להזמין אותו, ואם לא —
    // מדוע בדיוק. הסיבה הזו היא מה שהעובד רואה, ולכן היא חייבת להיות מדויקת
    // ולהצביע על הפעולה הנדרשת (לפרסם מוצר / להגדיר מחיר / להשלים מלאי).
    const unavailableReason = productUnavailableReason(
      chosenProduct,
      orderQuantity(chosenProduct),
      priceForProduct(priceMap, chosenProduct)
    );
    if (unavailableReason) {
      unmatched.push({
        ...base,
        confidence,
        matchScore: match.score,
        alternatives: match.alternatives,
        productTitle: chosenProduct.title?.he,
        product: undefined, // אינו נכנס לעגלה
        failReason: unavailableReason,
      });
      continue;
    }

    // ── "קרטון" / "מגש" / "ארגז" מול מוצר שנמכר ביחידה ──
    //
    // ‏"וופל מן - קרטון 1" נכנס להזמנה כחבילת וופל אחת (202337, 14/10/26): הכמות
    // נקראה, מילת האריזה נשארה בשם, ואף אחד לא נשאל כמה יחידות בקרטון. זה
    // ניחוש שקט של כמות — בדיוק מה שאסור. השורה עוצרת לאדם עם המוצר כהצעה.
    // הכרעה שאדם שמר (אליאס) נכנסת, אבל המלקט רואה את מילת האריזה בהערה.
    //
    // ‏"חלב 3% - קרטון בלבד", "באריזת קרטון", "4 קרטון" מול "חלב טרי בקרטון":
    // כאן קרטון הוא חומר האריזה של המוצר עצמו ולא ארגז. נמדד על 84 ההזמנות
    // הפתוחות — 26 שורות חלב כאלה נעצרו בגרסה הראשונה של הכלל. לכן מוצר
    // שבשמו מופיעה מילת האריזה (גם בתחילית: "בקרטון") פטור, וכך גם "קרטון
    // בלבד/רגיל" ו"אריזת קרטון".
    const sourceText = String(base[SOURCE]);
    const packAsked = sourceText.match(MULTI_PACK_WORD_RE);
    const titleText = chosenProduct.title?.he || "";
    const packIsMaterial =
      packAsked &&
      (titleText.includes(packAsked[1].replace(/ים$/, "")) ||
        new RegExp(`אריזת\\s*${packAsked[1]}|${packAsked[1]}\\s+(?:בלבד|רגיל)`).test(sourceText) ||
        // שרוול כוסות מול "כוסות ... 50 יח" — המוצר הוא השרוול עצמו
        (/^שרוול/.test(packAsked[1]) && /\d+\s*(?:יח|יחידות)/.test(titleText)));
    if (packAsked && !packIsMaterial && !MULTI_PACK_WORD_RE.test(titleText)) {
      if (aliasHit) {
        base.note = [base.note, `הלקוח כתב "${packAsked[1]}" — לבדוק כמות`].filter(Boolean).join(" | ");
      } else {
        unmatched.push({
          ...base,
          confidence,
          matchScore: match.score,
          alternatives: match.alternatives,
          productTitle: chosenProduct.title?.he,
          suggestions: [chosenProduct],
          product: undefined,
          failReason: `הלקוח ביקש "${packAsked[1]}" — צריך לקבוע כמה יחידות של "${chosenProduct.title?.he}"`,
        });
        continue;
      }
    }

    // ── שורה עמומה נכנסת להזמנה במקום לעצור אותה ──
    //
    // "עוגיות" מתאימה לחמישה מוצרים שנבדלים בנקודה אחת מתוך 18,199. עד כאן
    // שורה כזו העבירה את **ההזמנה כולה** ל"שגיאה בקריאה" והמתינה לאדם. זה
    // נכון כשיש מה להכריע, אבל המחיר הוא שהזמנה שלמה יושבת בגלל שורה אחת —
    // ולכן ההחלטה היא שההזמנה נכנסת רגיל, עם המועמד הסביר ביותר.
    //
    // הבחירה אינה שקטה: הפריט נושא `autoPicked`, מסך הקליטה מסמן אותו
    // "(נבחר אוטומטית מ«...»)", והערת המערכת על ההזמנה — זו שמודפסת על תעודת
    // הליקוט — אומרת מה נבחר ומאיזו שורה. המלקט הוא מי שיכול לתפוס בחירה
    // שגויה לפני שהיא יוצאת מהדלת, ולכן שני הצדדים מופיעים שם.
    //
    // הסולם הוא מהמבוסס לשרירותי, וכל שלב בו הוא ראיה על *הלקוח הזה*:
    //   1. שם שמכיל את כל מה שהלקוח כתב — "עוגיות" נמצאת ב"עוגיות אוראו"
    //      ולא ב"נייר מגבת חוגלה". בלי התנאי הזה סינון צורת האריזה היה
    //      מכתיב בחירה שחסרה בה מחצית מהמילים שהלקוח כתב.
    //   2. מה שהוא קנה בפועל — גם ברמת "רמז" שאינה מספיקה להכרעה לבדה.
    //   3. מוצר שיש לו מחיר במחירון הפרטי שלו: סימן שזה מה שהוא מקבל.
    //   4. הציון הגבוה ביותר.
    //
    // מה **אינו** נכנס כך: שורה שלא נמצא לה מוצר, שורה בלי מילת מוצר, שורה
    // שהכמות בה נכתבה כמידה, שורה שהלקוח ביקש בה מידה שאינה בקטלוג, ומוצר
    // שאי אפשר לספק (מוסתר / בלי מחיר / בלי מלאי). בכל אלה אין "מועמד סביר"
    // אלא בקשה שאי אפשר למלא, וזו החלטה של אדם.
    const autoPick = async () => {
      // אותו סייג של droppedAsText, ומאותה סיבה: שורה בלי מילת מוצר אינה
      // בקשה עמומה אלא רעש, ואין בה מה לבחור.
      if (!AUTO_PICK_AMBIGUOUS() || requestedSizeMissing || weightAsk?.rival) return null;
      if (!hasProductWord(searchName)) return null;

      // ── כמות שנכתבה כמידה אינה כמות להזמנה ──
      //
      // ‏unit מלא פירושו שהלקוח כתב מידה ("200 גרם", "4 ליטר"), והקוד **אינו**
      // ממיר משקל לאריזות — הוא מעביר את המידה כהערה למלקט. בחירה אוטומטית
      // של מוצר על גבי מספר שאינו מספר אריזות מצרפת שתי אי-ודאויות: נמדד על
      // הזמנה אמת שבה עמודת המידה זוהתה כעמודת הכמות, ו-"נס קפה 200 גרם"
      // הפך ל-200 יחידות. שורה כזו עוברת לאדם — הוא היחיד שיודע כמה אריזות
      // התבקשו.
      if (unit) return null;

      const covering = textCandidates().filter(
        (candidate) => candidate && coversAllWords(searchName, candidate)
      );
      if (!covering.length) return null;

      const preferred =
        (historyPick &&
          covering.find(
            (candidate) => String(candidate._id) === String(historyPick.product._id)
          )) ||
        covering.find((candidate) => priceForProduct(priceMap, candidate) !== null) ||
        covering[0];

      // החלופות מגיעות רזות (‏_id/title/sku); ההזמנה צריכה את המסמך המלא
      const product =
        preferred.prices !== undefined
          ? preferred
          : await Product.findById(preferred._id).lean();
      if (!product) return null;

      // הזמינות נבדקת שוב ולא נסמכת על הבדיקה שלמעלה: הסולם כאן יכול לבחור
      // מועמד אחר מזה שנבדק, ומוצר בלי מלאי אינו הופך לזמין מפני שהוא הסביר.
      if (
        productUnavailableReason(product, orderQuantity(product), priceForProduct(priceMap, product))
      ) {
        return null;
      }

      // בחירה אוטומטית היא "המועמד הסביר ביותר" — ומוצר שהלקוח לא קנה אף
      // פעם אינו סביר מספיק כדי להיכנס בלי שאדם ראה אותו.
      if (unfamiliar(product)) return null;

      return product;
    };

    // ביטחון לא מספיק, וה-AI כבוי — אין מי שיכריע, והפריט עובר לאדם.
    // זו ההתנהגות הנכונה: עדיף שעובד יבחר מוצר מאשר שהמערכת תנחש.
    if (confidence < AUTO_ACCEPT_CONFIDENCE && !USE_EXTERNAL_AI()) {
      if (confidence >= MIN_ITEM_CONFIDENCE) {
        // ביטחון בינוני-גבוה — מקבלים כמו שהוא
        items.push({
          ...base,
          product: chosenProduct,
          confidence,
          matchScore: match.score,
          decidedBy,
          alternatives: match.alternatives,
        });
      } else {
        // ── ההודעה אומרת מה לעשות, לא כמה המחשב בטוח ──
        //
        // הניסוח הקודם היה "זוהו כמה מוצרים אפשריים ואי אפשר להכריע אוטומטית
        // (ביטחון 0.53). המועמד המוביל: X" — פסקה שנקראת כמו הצלחה ומסתירה את
        // מה שצריך לעשות. מה שעצר את הפריט הוא מי שעמד לידו: שלוש רשומות
        // כמעט זהות בקטלוג. השמות והמק"טים הם מה שמאפשר לבחור; מספר הביטחון
        // אינו אומר לעובד דבר, ולכן אינו מופיע.
        const picked = await autoPick();
        if (picked) {
          items.push({
            ...base,
            product: picked,
            confidence,
            matchScore: match.score,
            decidedBy: `${decidedBy}+נבחר-אוטומטית`,
            alternatives: match.alternatives,
            autoPicked: true,
          });
          continue;
        }

        const rivalProducts = (match.alternatives || [])
          .filter((a) => a?.score >= match.score * 0.95)
          .slice(0, 3);
        const rivals = rivalProducts.map((a) => `"${a.title?.he}"${a.sku ? ` (${a.sku})` : ""}`);

        const leader = `"${chosenProduct.title?.he}"${chosenProduct.sku ? ` (${chosenProduct.sku})` : ""}`;

        unmatched.push({
          ...base,
          confidence,
          matchScore: match.score,
          alternatives: match.alternatives,
          productTitle: chosenProduct.title?.he,
          // מה שהמסך מציע כלחיצה אחת: המוביל, ובמקרה של כמה שקולים — גם הם
          suggestions: [chosenProduct, ...(neverBought || requestedSizeMissing ? [] : rivalProducts)],
          // כשהסיבה לעצירה היא מידה או גודל שאינם בקטלוג, אמירת הסיבה חוסכת
          // לעובד את החיפוש: הוא רואה מיד שהלקוח ביקש משהו שאין, ויכול לאשר
          // את החלופה או לחזור ללקוח.
          failReason: withHistory(
            requestedSizeMissing
              ? `הלקוח ביקש "${missingSizeLabel}" ואין מוצר כזה בקטלוג — צריך לאשר שזה ${leader}`
              : neverBought
                ? `הלקוח לא הזמין בעבר את ${leader} — צריך לאשר שלזה הוא מתכוון`
              : rivals.length
                ? `יש בקטלוג כמה מוצרים בשם דומה — צריך לבחור אחד: ${leader}, ${rivals.join(", ")}`
                : `הזיהוי לא היה ודאי — צריך לאשר שזה ${leader}`
          ),
        });
      }
      continue;
    }

    // ביטחון לא מספיק — נותנים ל-LLM להכריע בין המועמדים האמיתיים
    if (confidence < AUTO_ACCEPT_CONFIDENCE) {
      const candidates = [
        { _id: match.product._id, title: match.product.title, sku: match.product.sku },
        ...match.alternatives,
      ];

      try {
        const choice = await chooseProduct({ rawName, contextText, candidates });

        if (choice.chosenIndex === -1) {
          unmatched.push({
            ...base,
            confidence: 0,
            matchScore: match.score,
            alternatives: candidates,
            failReason: `לא ברור לאיזה מוצר הלקוח התכוון${choice.reason ? ` — ${choice.reason}` : ""}`,
          });
          continue;
        }

        const picked = candidates[choice.chosenIndex];
        // המועמד הראשון הוא כבר מסמך מלא; לחלופות יש רק _id/title/sku
        chosenProduct =
          choice.chosenIndex === 0
            ? match.product
            : await Product.findById(picked._id).lean();

        if (!chosenProduct) {
          unmatched.push({
            ...base,
            confidence: 0,
            failReason: "המוצר שנבחר כבר לא קיים בקטלוג",
          });
          continue;
        }

        // שקלול שני האותות.
        //
        // ביטחון מנוע ההתאמה נמוך בעיקר כשיש כמה מוצרים דומים — וזו בדיוק
        // העמימות שה-LLM נשלח להכריע בה, ולכן אחרי ההכרעה הוא לא צריך למשוך
        // את הציון למטה. מצד שני, כשמנוע ההתאמה כמעט לא מצא כלום, רשימת
        // המועמדים עצמה חשודה וה-LLM בחר "את הפחות גרוע" — ואז אסור לתת
        // ביטחון גבוה. לכן הכרעת ה-LLM קובעת, אך תקרתה נגזרת מאיכות ההתאמה.
        confidence =
          Math.round(Math.min(choice.confidence, match.confidence + 0.3) * 100) / 100;
        decidedBy = "llm";

        // ── ההכרעה נשמרת, כדי שלא תישאל שוב ──
        //
        // ‏searchName ולא rawName: זה בדיוק המפתח ש-findAliasMatch מחפש בו
        // למעלה. שמירה תחת שם אחר הייתה יוצרת אליאס שלא יימצא לעולם — כשל
        // שקט שבו הממשק מראה שההכרעה קיימת והקליטה ממשיכה לשאול את ה-LLM.
        //
        // ── למה אין כאן סכנת דריסה של הכרעת אדם ──
        //
        // הענף הזה מגיע רק כשלא נמצא אליאס כלל: אליאס קיים — של הלקוח או
        // כלל-מערכתי — היה נתפס ב-aliasHit למעלה, ו-match היה מגיע ממנו
        // בביטחון 1, כלומר לעולם לא היינו נכנסים לכאן. לכן `saveAlias` כאן
        // תמיד יוצר רשומה חדשה ולא מעדכן קיימת.
        //
        // ‏customerId בלבד ולעולם לא היקף כללי: הכרעה של מכונה על מה שלקוח
        // אחד התכוון אינה ראיה למה שכל הלקוחות מתכוונים.
        if (SAVE_LLM_ALIASES() && customerId && confidence >= LLM_ALIAS_MIN_CONFIDENCE) {
          try {
            await saveAlias({
              rawName: searchName,
              productId: chosenProduct._id,
              customerId,
              // מסומן כדי שאפשר יהיה לסנן, לבדוק ולבטל הכרעות מכונה בלי לגעת
              // בהכרעות אדם. זה מה שהופך את זה להפיך.
              createdBy: "llm",
            });
            decidedBy = "llm+נשמר";
          } catch (err) {
            // שמירה היא שיפור, לא תלות: הפריט כבר הוכרע ונכנס להזמנה.
            console.log(
              `[ingestion/resolveItems] שמירת אליאס ל-"${searchName}" נכשלה: ${err.message}`
            );
          }
        }
      } catch (err) {
        console.log(`[ingestion/resolveItems] כשל בהכרעת LLM ל-"${rawName}": ${err.message}`);
        unmatched.push({
          ...base,
          confidence: match.confidence,
          matchScore: match.score,
          alternatives: match.alternatives,
          failReason: `תקלה בבחירת המוצר: ${err.message}`,
        });
        continue;
      }
    }

    // נבדק שוב אחרי הכרעת ה-LLM: היא יכולה למשוך את הביטחון למטה, ואז שורה
    // שהכמות שלה הונחה חוזרת להיות טקסט במקום להפיל את ההזמנה.
    if (confidence < MIN_ITEM_CONFIDENCE) {
      if (droppedAsText(confidence, "השורה לא נראית כשם מוצר", textCandidates())) continue;

      // אותו סולם שמפעיל את המסלול בלי AI — ראה autoPick. גם כאן ההזמנה
      // נכנסת רגיל במקום להיעצר בגלל שורה אחת.
      const picked = await autoPick();
      if (picked) {
        items.push({
          ...base,
          product: picked,
          confidence,
          matchScore: match.score,
          decidedBy: `${decidedBy}+נבחר-אוטומטית`,
          alternatives: match.alternatives,
          autoPicked: true,
        });
        continue;
      }

      unmatched.push({
        ...base,
        confidence,
        matchScore: match.score,
        alternatives: match.alternatives,
        productTitle: chosenProduct.title?.he,
        failReason: withHistory(
          `הזיהוי לא היה ודאי — צריך לבחור ידנית ("${chosenProduct.title?.he}"?)`
        ),
      });
      continue;
    }

    items.push({
      ...base,
      product: chosenProduct,
      confidence,
      matchScore: match.score,
      decidedBy,
      alternatives: match.alternatives,
    });
  }

  // ── מה שההיסטוריה לא סגרה לבד: AI, ורק מתוך מה שהלקוח קונה ──
  //
  // ‏INGESTION_AI_FALLBACK=true. המודל מקבל את כל שורות ההזמנה לפי הסדר ואת
  // רשימת המוצרים של הלקוח, מציע מוצר לכל שורה פתוחה, והקוד מאשר או פוסל
  // (aiFallback.verifyAnswer). מה שלא אושר נשאר ב-unmatched בדיוק כמו קודם —
  // עם הסיבה — ולכן כשל של המודל או של הרשת אינו משנה דבר בהזמנה.
  if (AI_FALLBACK() && historyProfile?.byProduct?.size) {
    const isOpen = (item) => item.confidence < MIN_ITEM_CONFIDENCE;
    if (unmatched.length || items.some(isOpen)) {
      try {
        const own = await ownProducts();
        const sizes = await getPackSizes().catch((err) => {
          console.log(`[ingestion/resolveItems] גודלי הקרטון לא נטענו: ${err.message}`);
          return null;
        });
        const history = own
          .map((product) => {
            const entry = historyProfile.byProduct.get(String(product._id));
            return {
              _id: product._id,
              title: product.title?.he || "",
              n: entry?.lines ?? null,
              ago: entry?.lastAt ? Math.round((Date.now() - new Date(entry.lastAt)) / MONTH_MS) : 999,
              pack: packSizeOf(sizes, product),
            };
          })
          .filter((product) => product.title)
          .sort((a, b) => (b.n || 0) - (a.n || 0));

        const entries = [
          ...items.map((item) => ({ item, status: isOpen(item) ? "open" : "ok" })),
          ...unmatched.map((item) => ({ item, status: "open" })),
          ...dropped.map((item) => ({ item, status: "text" })),
        ].sort((a, b) => (a.item[LINE] ?? Infinity) - (b.item[LINE] ?? Infinity));
        // מה שנכנס להזמנה מכל שורה — "כמות של השורה הקודמת" מתעדכנת עליו
        for (const entry of entries) entry.resolved = entry.status === "ok" ? [entry.item] : [];

        const decisions = await resolveOpenLines({
          lines: entries.map(({ item, status }) => ({
            source: item[SOURCE] || item.rawName,
            raw: item.rawName,
            qty: item.quantity,
            assumed: Boolean(item.quantityAssumed),
            status,
            product: status === "ok" ? item.product?.title?.he : undefined,
          })),
          history,
          vocabulary,
        });

        const byLine = new Map();
        for (const decision of decisions) {
          byLine.set(decision.index, [...(byLine.get(decision.index) || []), decision]);
        }
        const remove = (item) => {
          for (const list of [items, unmatched]) {
            const at = list.indexOf(item);
            if (at >= 0) list.splice(at, 1);
          }
        };
        const leaveOpen = (item, reason) => {
          if (unmatched.includes(item)) {
            item.failReason = [item.failReason, `AI: ${reason}`].filter(Boolean).join(" | ");
          }
        };

        for (const [index, group] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
          const entry = entries[index];
          const { item } = entry;
          const [{ decision }] = group;

          if (decision === "open") {
            const { reason, suggestion } = group[0];
            leaveOpen(item, suggestion ? `${reason} (הצעה: "${suggestion}")` : reason);
            continue;
          }

          if (decision === "drop") {
            remove(item);
            dropped.push({ ...item, reason: "אינה שורת מוצר" });
            continue;
          }

          if (decision === "attach") {
            // "5 חב'" מתחת ל"מפיות": הכמות של השורה שמעליה. רק כשהשורה שמעליה
            // נכנסה להזמנה ולא נכתבה לה כמות משלה — אחרת אין על מה להלביש.
            const above = entries[index - 1]?.resolved || [];
            const quantity = group[0].quantity;
            const fits =
              above.length &&
              above.every((target) => target.quantityAssumed) &&
              Number.isInteger(quantity) &&
              quantity > 0;
            if (!fits) {
              leaveOpen(item, "שורת כמות בלי מוצר ברור מעליה");
              continue;
            }
            for (const target of above) {
              target.quantity = quantity;
              target.quantityAssumed = false;
            }
            remove(item);
            continue;
          }

          // accept — מוצר אחד, או כמה כשבשורה נכתבו כמה מוצרים
          const picks = [];
          let blocked = null;
          for (const pick of group) {
            const full = await Product.findById(pick.product._id).lean();
            blocked = !full
              ? "המוצר לא נמצא בקטלוג"
              : productUnavailableReason(full, pick.quantity, priceForProduct(priceMap, full));
            if (blocked) break;
            picks.push({ product: full, quantity: pick.quantity });
          }
          if (blocked) {
            leaveOpen(item, blocked);
            continue;
          }

          remove(item);
          const { failReason, productTitle, alternatives, matchScore, autoPicked, ...rest } = item;
          for (const pick of picks) {
            const accepted = {
              ...rest,
              quantity: pick.quantity,
              quantityAssumed: false,
              product: pick.product,
              confidence: HISTORY_MATCH_CONFIDENCE,
              decidedBy: "AI+היסטוריה",
              note: [item.note, `הלקוח כתב: "${item.rawName}"`].filter(Boolean).join(" | "),
            };
            items.push(accepted);
            entry.resolved.push(accepted);
          }

          // נשמר רק כשהאליאס ישחזר בדיוק את ההכרעה הזו: מוצר אחד, והכמות היא
          // זו שהפרסר קרא. שורת קרטון אינה נשמרת — הכמות שלה חושבה כאן.
          // הרצת כיול (dryRun) אינה משאירה נתונים במערכת.
          if (
            AI_SAVE_ALIASES() &&
            !dryRun &&
            customerId &&
            picks.length === 1 &&
            picks[0].quantity === item.quantity
          ) {
            try {
              await saveAlias({
                rawName: item.rawName,
                productId: picks[0].product._id,
                customerId,
                createdBy: "ai-history",
              });
              entry.resolved[0].decidedBy = "AI+היסטוריה+נשמר";
            } catch (err) {
              console.log(`[ingestion/resolveItems] שמירת אליאס ל-"${item.rawName}" נכשלה: ${err.message}`);
            }
          }
        }

        // הפריטים חוזרים לסדר שבו הלקוח כתב אותם
        items.sort((a, b) => (a[LINE] ?? Infinity) - (b[LINE] ?? Infinity));
      } catch (err) {
        console.log(`[ingestion/resolveItems] שלב ה-AI נכשל: ${err.message}`);
      }
    }
  }

  // ── מצב "הכול נכנס": הניחוש הטוב ביותר מתוך מה שהלקוח קונה ──
  //
  // ‏INGESTION_BEST_EFFORT=true. החלטה עסקית מ-11/10/26: הזמנה לא נעצרת בגלל
  // שורה שלא זוהתה בוודאות. כל מה שלמעלה נשאר כפי שהוא — ההכרעות הוודאיות
  // אינן משתנות — וכאן מטופל רק מה שנשאר ב-unmatched:
  //
  //   • אם ללקוח יש מוצר שחולק עם השורה מילת מוצר, נכנס זה שחולק הכי הרבה
  //     מילים, ובשוויון זה שהוא קונה הכי הרבה. הפריט מסומן autoPicked, ולכן
  //     מופיע בהערת המערכת ("נבחר אוטומטית") ועל תעודת הליקוט, יחד עם מה
  //     שהלקוח כתב.
  //   • אחרת השורה יורדת להערת ההזמנה כ"לא זוהה — להשלים", ואינה מפילה אותה.
  //
  // הניחוש הוא **רק מתוך ההיסטוריה של הלקוח**. מוצר מהקטלוג שהלקוח לא קנה
  // אף פעם אינו נכנס כניחוש: שם נמדדו הטעויות הגסות ("נוטלה" → נבטים,
  // "סמרטוטים" → גלידה).
  if (BEST_EFFORT()) {
    const own = await ownProducts();

    for (const line of unmatched) {
      const qualifiers = extractQualifiers(line.rawName);
      const requestText = qualifiers.cleanName || line.rawName;
      let guess = null;

      // שורה בלי כמות חייבת גם להיראות כמו שם מוצר — "המשרדים היו סגורים"
      // אינה בקשה לענבים סגולים. שני מוצרים בשורה אחת אינם ניחוש אחד.
      const guessable =
        BEST_EFFORT_GUESS() &&
        own.length &&
        hasProductWord(requestText) &&
        !/\+|\*\s*\d|\sאו\s/.test(line.rawName) &&
        (!line.quantityAssumed || (vocabulary && looksLikeProductAttempt(requestText, vocabulary)));

      if (guessable) {
        // רק שמות מוצר נספרים, ושם העצם של השורה חייב להיות במוצר — צבע,
        // גודל, אריזה ו"ללא סוכר" אינם קושרים שורה למוצר
        const scored = own
          .map((product) => ({
            product,
            shared: guessStrength(requestText, product, { vocabulary }),
          }))
          .filter((entry) => entry.shared > 0);
        const best = Math.max(0, ...scored.map((entry) => entry.shared));
        const leaders = scored.filter((entry) => entry.shared === best);
        // שלילה מפורשת של הלקוח נשארת שלילה גם בניחוש
        const allowed = leaders.length
          ? applyQualifiers(leaders, { ...qualifiers, sizes: [], sizeWords: [] }).keptBeforeSilentDrops
          : [];
        const pick = allowed.length
          ? pickFromHistory(allowed, historyProfile, { dominanceRatio: 1 })
          : null;
        if (pick) {
          const full = await Product.findById(pick.product._id).lean();
          const blocked =
            !full ||
            productUnavailableReason(full, line.quantity, priceForProduct(priceMap, full));
          if (!blocked) guess = full;
        }
      }

      if (!guess) {
        dropped.push({ ...line, reason: "לא זוהה — להשלים ידנית" });
        continue;
      }

      const { failReason, productTitle, ...rest } = line;
      items.push({
        ...rest,
        product: guess,
        confidence: MIN_ITEM_CONFIDENCE,
        decidedBy: "היסטוריה(ניחוש)",
        autoPicked: true,
        note: [line.note, `לבדוק — הלקוח כתב: "${line.rawName}"`].filter(Boolean).join(" | "),
      });
    }

    // כל שורה או נכנסה כניחוש או ירדה להערה
    unmatched.length = 0;

    // פריט שנבחר אוטומטית כבר מסומן לבדיקה; הוא אינו מפיל את ביטחון ההזמנה
    for (const item of items) {
      if (item.autoPicked && item.confidence < MIN_ITEM_CONFIDENCE) {
        item.confidence = MIN_ITEM_CONFIDENCE;
      }
    }
  }

  // ── "פחיות קולה - 24 יח" מול מארז "פחיות קולה 24 יח" ──
  //
  // ‏countUnit מסמן שהכמות נקראה מ-"N יח" (ראה COUNT_UNIT ב-tableParser). כשהמוצר
  // שנבחר הוא בעצמו מארז של אותו מניין, הלקוח ביקש מארז אחד ולא N מארזים —
  // בלי התיקון 24 פחיות היו הופכות ל-576. נבדק אחרי ההכרעה, כי רק אז ידוע
  // איזה מוצר נבחר.
  for (const item of items) {
    if (!item.countUnit || !item.product?.title) continue;
    const packOfSame = extractSizesFromTitle(item.product.title).some(
      (size) => size.base === "count" && size.normalized === item.quantity
    );
    if (packOfSame) {
      item.note = [item.note, `הלקוח כתב "${item.quantity} יח" — נספר כמארז אחד`]
        .filter(Boolean)
        .join(" | ");
      item.quantity = 1;
    }
  }

  // ── המרת משקל לחלק מאריזה ──
  //
  // נעשית כאן ולא בזמן ההכרעה מאותה סיבה שלמעלה: המוצר הסופי יכול להיות אחר
  // מהמועמד המוביל (היסטוריה, בחירה אוטומטית, LLM), וההמרה היא מול האריזה שלו.
  if (items.some((item) => item.weightAsk)) {
    const weighedIds = await weighedCategoryIds();

    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      const ask = item.weightAsk;
      if (!ask) continue;

      const packGrams = weighedPackGrams(item.product, weighedIds);

      if (!packGrams) {
        // הוויתור על המידה ניתן מול מוצר נשקל, ובסוף נבחר מוצר אחר — כלומר
        // המידה שוב חסרה. בלי זה אריזה במידה אחרת הייתה נכנסת בשקט.
        if (ask.sizeWaived) {
          const { product, decidedBy, autoPicked, ...rest } = item;
          items.splice(index, 1);
          unmatched.push({
            ...rest,
            productTitle: product.title?.he,
            suggestions: [product],
            failReason: `הלקוח ביקש "${ask.label}" ואין מוצר כזה בקטלוג — צריך לאשר שזה "${product.title?.he}"`,
          });
        }
        continue;
      }

      // ביקש בדיוק את האריזה ("בננות 5.5 קילו") — הכמות היא כבר מספר האריזות
      if (ask.fromName && ask.unitGrams === packGrams) continue;

      const converted = packsForWeight(ask.grams, packGrams);
      item.note = [item.note, `הלקוח ביקש ${ask.label} — ${converted} מתוך "${item.product.title?.he}"`]
        .filter(Boolean)
        .join(" | ");
      item.quantity = converted;
      // שניהם נאמרו בהערה, והשארתם הייתה מדפיסה "0.273 קילו" ו"נלקחה יחידה אחת"
      item.unit = null;
      item.quantityAssumed = false;
    }
  }

  // סימון פנימי של השלב הזה — אינו חלק מהפלט
  [...items, ...unmatched, ...dropped].forEach((entry) => delete entry.weightAsk);

  return { items, unmatched, dropped };
};

// ─────────────────────────────────────────────────────────────
//  לקוח
// ─────────────────────────────────────────────────────────────

/**
 * מציאת הלקוח או יצירתו.
 *
 * סדר העדיפויות מכוון: מה שידוע מהערוץ עצמו (מספר הווצאפ ששלח, כתובת המייל
 * ששלחה) אמין יותר ממה שכתוב בגוף ההודעה, שאותו ה-LLM חילץ מטקסט חופשי.
 *
 * @returns {Promise<{customer: Object, wasCreated: boolean}>}
 * @throws {Error} כשאין שום מזהה שאפשר לבנות עליו לקוח
 */
const resolveCustomer = async ({
  parsedCustomer = {},
  sender = {},
  channel,
  // בהרצה יבשה (כיול) אסור לכתוב כרטיס לקוח חדש — כלי בדיקה לא אמור להשאיר
  // נתונים במערכת. בערוצים האמיתיים הרשימה הלבנה כבר מבטיחה שהלקוח קיים,
  // ולכן מסלול היצירה כמעט לא נגיש שם בכלל.
  allowCreate = true,
} = {}) => {
  const channelPhone = canonicalPhone(sender.phone);
  const parsedPhone = canonicalPhone(parsedCustomer.phone);
  const phone = channelPhone || parsedPhone;

  const channelEmail = sender.email ? String(sender.email).toLowerCase().trim() : null;
  const parsedEmail = parsedCustomer.email
    ? String(parsedCustomer.email).toLowerCase().trim()
    : null;
  const email = channelEmail || parsedEmail;

  if (!phone && !email) {
    const err = new Error("אין טלפון ואין מייל — לא ניתן לזהות או ליצור לקוח");
    err.code = "customer_unresolved";
    throw err;
  }

  // ── חיפוש לפי סדר אמון יורד ──
  //
  // קריטי שהמזהה מהערוץ יקדם למזהה מגוף ההודעה. גוף ההודעה הוא טקסט חופשי,
  // ולקוח יכול לכתוב בו כתובת מייל של מישהו אחר (מייל של בן משפחה, של מקום
  // העבודה, או סתם טעות). חיפוש שמתחיל בו היה משייך את ההזמנה ללקוח הלא נכון —
  // עם הכתובת השמורה שלו ועם זיהום היסטוריית ההזמנות שלו.
  // המספר ששלח בווצאפ, או התיבה ששלחה את המייל, הם מזהים מאומתים.
  const findByEmail = async (value) =>
    value ? Customer.findOne({ email: value }) : null;

  // phone אינו ייחודי בסכמה, ולכן — בעקבות אותה הכרעה שנעשתה בכניסה ב-SMS —
  // מעדיפים חשבון רשום, והחדש מביניהם.
  const findByPhone = async (value) => {
    if (!value) return null;
    const variations = phoneVariations(value);
    return (
      (await Customer.findOne({ phone: { $in: variations }, isRegistered: true }).sort({
        _id: -1,
      })) || (await Customer.findOne({ phone: { $in: variations } }).sort({ _id: -1 }))
    );
  };

  const strategies = [
    { label: "מייל הערוץ", run: () => findByEmail(channelEmail) },
    { label: "טלפון הערוץ", run: () => findByPhone(channelPhone) },
    { label: "מייל מגוף ההודעה", run: () => findByEmail(parsedEmail) },
    { label: "טלפון מגוף ההודעה", run: () => findByPhone(parsedPhone) },
  ];

  let customer = null;
  for (const strategy of strategies) {
    customer = await strategy.run();
    if (customer) {
      console.log(`[ingestion/customer] זוהה לפי ${strategy.label}: ${customer._id}`);
      break;
    }
  }

  if (customer) {
    // השלמת פרטים חסרים בלבד, ורק ממזהה מאומת מהערוץ — לא כותבים לרשומת לקוח
    // קיימת מספר טלפון שמישהו הקליד בטקסט חופשי.
    if (!customer.phone && channelPhone) {
      customer.phone = channelPhone;
      try {
        await customer.save();
      } catch (saveErr) {
        // רשומת לקוח ותיקה יכולה להיכשל בוולידציה על שדה אחר לגמרי. השלמת
        // הטלפון היא נוחות, ואסור שהיא תחסום את ההזמנה.
        console.log(
          `[ingestion/customer] לא ניתן להשלים טלפון ללקוח ${customer._id}: ${saveErr.message}`
        );
      }
    }
    return { customer, wasCreated: false };
  }

  // 3. יצירת לקוח חדש (אורח — isRegistered: false, כמו בצ'קאאוט אורח)
  if (!allowCreate) {
    const err = new Error(
      "הלקוח אינו קיים במערכת, ובמצב הזה אין יצירת לקוח חדש אוטומטית"
    );
    err.code = "customer_unresolved";
    throw err;
  }

  const name = String(parsedCustomer.name || parsedCustomer.businessName || sender.name || "").trim();
  const emailForRecord =
    email || (phone ? `wa-${phone}@${SYNTHETIC_EMAIL_DOMAIN}` : null);

  if (!emailForRecord) {
    const err = new Error("אין מייל ואין טלפון תקין ליצירת לקוח");
    err.code = "customer_unresolved";
    throw err;
  }

  const newCustomer = new Customer({
    name: name || (phone ? `לקוח ${phone}` : "לקוח ללא שם"),
    lastName: String(parsedCustomer.lastName || "").trim(),
    email: emailForRecord,
    phone: phone || "",
    isRegistered: false,
  });

  try {
    await newCustomer.save();
  } catch (err) {
    // ריצה מקבילה יכולה ליצור את אותו מייל פעמיים — נופלים חזרה לרשומה הקיימת
    if (err.code === 11000) {
      const existing = await Customer.findOne({ email: emailForRecord });
      if (existing) return { customer: existing, wasCreated: false };
    }
    throw err;
  }

  return { customer: newCustomer, wasCreated: true };
};

// ─────────────────────────────────────────────────────────────
//  משלוח וכתובת
// ─────────────────────────────────────────────────────────────

// נרמול שם מוצר להשוואת זהות: גרשים, מקפים ורווחים כפולים אינם הבדל אמיתי
const normalizeTitle = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/['"''`ʼʻ״׳]/g, "")
    .replace(/[-־–]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * האם המוצר שנבחר נושא בדיוק את השם שהלקוח כתב.
 *
 * נבדק גם מול השם הנקי (אחרי הסרת מזהי גרסה) וגם מול השם הגולמי, כי הלקוח
 * יכול לכתוב את השם המדויק עם או בלי תוספות.
 */
const isExactTitleMatch = (product, ...names) => {
  const title = normalizeTitle(product?.title?.he);
  if (!title) return false;
  return names.some((name) => name && normalizeTitle(name) === title);
};

// נרמול שם עיר להשוואה: הסרת גרשים, רווחים כפולים, ו"תל-אביב" → "תל אביב"
const normalizeCityName = (name) =>
  String(name || "")
    .replace(/['"''`ʼʻ]/g, "")
    .replace(/[-־–]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * התאמת שם עיר מטקסט חופשי ליעד משלוח מוגדר בטבלת Delivery.
 * החנות מחלקת רק לעיר שהאדמין הגדיר, ולכן עיר שלא מוגדרת = אין משלוח.
 */
const matchDeliveryCity = async (cityName) => {
  const wanted = normalizeCityName(cityName);
  if (!wanted) return null;

  const deliveries = await Delivery.find({}).lean();
  if (!deliveries.length) return null;

  // התאמה מדויקת אחרי נרמול
  const exact = deliveries.find(
    (d) => normalizeCityName(d.city?.city_name_he) === wanted
  );
  if (exact) return exact;

  // הכלה דו-כיוונית — "תל אביב יפו" מול "תל אביב".
  //
  // נדרש אורך מינימלי של 4 תווים בשני הצדדים: שמות עיר קצרים בעברית ("לוד",
  // "עכו", "יבנה") מטופלים כבר בהתאמה המדויקת, ואילו הכלה על מחרוזת קצרה
  // עלולה להתאים עיר שגויה לחלוטין ולשלוח משלוח למקום הלא נכון.
  const MIN_CONTAINMENT_LENGTH = 4;
  if (wanted.length >= MIN_CONTAINMENT_LENGTH) {
    const contained = deliveries.find((d) => {
      const cityInDb = normalizeCityName(d.city?.city_name_he);
      if (!cityInDb || cityInDb.length < MIN_CONTAINMENT_LENGTH) return false;
      return cityInDb.includes(wanted) || wanted.includes(cityInDb);
    });
    if (contained) return contained;
  }

  return null;
};

/**
 * קביעת סוג המשלוח, הכתובת ועלות המשלוח.
 *
 * @returns {Promise<{shippingOption: string, address: Object, delivery: Object|null, city: string|null}>}
 * @throws {Error} כשמבוקש משלוח לעיר שאינה ביעדי החלוקה
 */
const resolveDelivery = async ({ parsedDelivery = {}, customer }) => {
  const saved = customer?.address || {};

  // איסוף עצמי — אין כתובת ואין עלות
  if (parsedDelivery.type === "pickup") {
    return { shippingOption: "1", address: {}, delivery: null, city: null };
  }

  const cityFromMessage = parsedDelivery.city || null;
  const cityFromCustomer = saved.city?.city_name_he || null;
  const streetFromMessage = parsedDelivery.street || null;

  // האם העיר שבהודעה היא אותה עיר ששמורה ללקוח. מחושב כאן, לפני שני המסלולים,
  // כי שניהם צריכים אותו כדי לא לערבב כתובות משתי ערים שונות.
  const sameCity =
    cityFromMessage &&
    cityFromCustomer &&
    normalizeCityName(cityFromMessage) === normalizeCityName(cityFromCustomer);

  // ── מצב "בלי יעדי משלוח" ──
  //
  // כשהחנות לא מנהלת יעדי משלוח (הטבלה ריקה או שהמנגנון כבוי), אין מול מה
  // לאמת עיר ואין מאיפה לגזור דמי משלוח. במצב הזה הכתובת נרשמת כמו שהיא,
  // דמי המשלוח 0, ואין אכיפת מינימום הזמנה — וחשוב מזה: **כתובת חסרה אינה
  // מפילה את ההזמנה**. היא כן מסומנת בהערה, כדי שמי שמלקט יראה שחסר מידע
  // ולא יגלה את זה מול הדלת.
  if (IGNORE_DELIVERY_TARGETS()) {
    // גם כאן אסור לערבב בין הכתובת שבהודעה לכתובת השמורה. עיר מההודעה עם
    // רחוב שמור מעיר אחרת מייצרת כתובת שאינה קיימת ("באר שבע, הרצל 5"),
    // והשליח נוסע לכלום. במצב הזה אין מי שיעצור את ההזמנה, ולכן הזהירות
    // כאן קריטית אף יותר מאשר במסלול הרגיל.
    let cityName = null;
    let base = null; // מאיזו כתובת נלקחים הרחוב ומספר הבית

    if (cityFromMessage && streetFromMessage) {
      cityName = cityFromMessage;
      base = "message";
    } else if (cityFromMessage && sameCity && saved.street) {
      // אותה עיר — מותר להשלים את הרחוב מהכתובת השמורה
      cityName = cityFromMessage;
      base = "saved";
    } else if (cityFromMessage) {
      // עיר מההודעה בלי רחוב, והכתובת השמורה בעיר אחרת (או שאין) —
      // לוקחים את העיר בלבד. הרחוב יסומן כחסר.
      cityName = cityFromMessage;
      base = "none";
    } else if (cityFromCustomer && saved.street) {
      cityName = cityFromCustomer;
      base = "saved";
    } else if (streetFromMessage) {
      // רחוב בלי עיר — נדיר, אבל עדיף לרשום אותו מאשר לאבד אותו
      base = "message";
    }

    // פרטי בניין מהכתובת השמורה מותרים רק כשהיא הבסיס או כשמדובר באותה עיר
    const canBorrowSaved = base === "saved" || Boolean(sameCity);

    const address = {
      // CitySchema דורש city_name_he בלבד ומאפשר שדות נוספים (strict:false).
      // כשהעיר היא השמורה — משתמשים באובייקט המלא, שיש בו גם קודי עיר.
      ...(cityName
        ? {
            city:
              base === "saved" && saved.city?.city_name_he
                ? saved.city
                : { city_name_he: cityName },
          }
        : {}),
      street: (base === "message" ? streetFromMessage : base === "saved" ? saved.street : "") || "",
      houseNumber:
        (base === "message"
          ? parsedDelivery.houseNumber
          : base === "saved"
            ? saved.houseNumber
            : "") || "",
      apartmentNumber:
        parsedDelivery.apartmentNumber || (canBorrowSaved ? saved.apartmentNumber : "") || "",
      floor: parsedDelivery.floor || (canBorrowSaved ? saved.floor : "") || "",
      entryCode: parsedDelivery.entryCode || (canBorrowSaved ? saved.entryCode : "") || "",
      postalCode: (canBorrowSaved ? saved.postalCode : "") || "",
    };

    const missing = [];
    if (!cityName) missing.push("עיר");
    if (!address.street) missing.push("רחוב");
    if (!address.houseNumber) missing.push("מספר בית");

    return {
      shippingOption: "2",
      address,
      delivery: null, // אין יעד מוגדר → דמי משלוח 0 ובלי מינימום
      city: cityName,
      ignoredDeliveryTargets: true,
      addressWarning: missing.length
        ? `כתובת חסרה בהזמנה (${missing.join(", ")}) — יש להשלים מול הלקוח`
        : null,
    };
  }

  // איזו כתובת משמשת בסיס. אסור לערבב בין השתיים: עיר מההודעה עם רחוב שמור
  // מעיר אחרת תיתן כתובת שלא קיימת, והשליח ייסע לכלום.
  // (sameCity מחושב למעלה — משותף לשני המסלולים)
  let cityName;
  let base; // מאיזו כתובת נלקחים הרחוב ומספר הבית

  if (cityFromMessage && streetFromMessage) {
    // ההודעה מכילה כתובת שלמה
    cityName = cityFromMessage;
    base = "message";
  } else if (cityFromMessage && sameCity && saved.street) {
    // ההודעה ציינה את אותה עיר שכבר שמורה — משלימים את הרחוב מהשמור
    cityName = cityFromMessage;
    base = "saved";
  } else if (cityFromMessage && !streetFromMessage) {
    // יודעים עיר אבל לא רחוב, ואין כתובת שמורה תואמת
    const err = new Error(
      `מבוקש משלוח ל"${cityFromMessage}" אבל אין רחוב בהודעה ואין כתובת שמורה בעיר הזו`
    );
    err.code = "address_unresolved";
    throw err;
  } else if (cityFromCustomer && saved.street) {
    // אין כתובת בהודעה — משתמשים בכתובת השמורה של הלקוח
    cityName = cityFromCustomer;
    base = "saved";
  } else {
    const err = new Error(
      "מבוקש משלוח אבל אין כתובת בהודעה ואין כתובת שמורה ללקוח"
    );
    err.code = "address_unresolved";
    throw err;
  }

  const deliveryDoc = await matchDeliveryCity(cityName);
  if (!deliveryDoc) {
    const err = new Error(`העיר "${cityName}" אינה מוגדרת ביעדי המשלוח`);
    err.code = "address_unresolved";
    throw err;
  }

  // פרטי הכתובת נלקחים מהבסיס שנקבע. פרטי בניין (קומה, קוד כניסה, מיקוד)
  // מושלמים מהשמור רק כשמדובר באותה עיר — אחרת הם שייכים לכתובת אחרת.
  const canBorrowBuildingDetails = base === "saved" || sameCity;

  const address = {
    city: deliveryDoc.city,
    street: (base === "message" ? streetFromMessage : saved.street) || "",
    houseNumber:
      (base === "message" ? parsedDelivery.houseNumber : saved.houseNumber) || "",
    apartmentNumber:
      parsedDelivery.apartmentNumber ||
      (canBorrowBuildingDetails ? saved.apartmentNumber : "") ||
      "",
    floor:
      parsedDelivery.floor || (canBorrowBuildingDetails ? saved.floor : "") || "",
    entryCode:
      parsedDelivery.entryCode ||
      (canBorrowBuildingDetails ? saved.entryCode : "") ||
      "",
    postalCode: canBorrowBuildingDetails ? saved.postalCode || "" : "",
  };

  return {
    shippingOption: "2",
    address,
    delivery: deliveryDoc,
    city: deliveryDoc.city?.city_name_he || null,
  };
};

module.exports = {
  resolveItems,
  resolveCustomer,
  resolveDelivery,
  matchDeliveryCity,
  isSyntheticEmail,
  normalizeQuantity,
  SYNTHETIC_EMAIL_DOMAIN,
  AUTO_ACCEPT_CONFIDENCE,
  MIN_ITEM_CONFIDENCE,
};

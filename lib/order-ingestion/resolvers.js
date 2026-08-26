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
} = require("../../utils/purchaseHistoryRanking");
const { extractQualifiers, applyQualifiers, hasProductWord } = require("./qualifiers");
const { chooseProduct } = require("./llm");

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
  { contextText = "", priceMap = null, customerId = null, historyProfile = null } = {}
) => {
  const items = [];
  const unmatched = [];
  // שורות שהכמות שלהן הונחה ולא נמצא להן מוצר — כנראה לא היו פריט מלכתחילה
  const dropped = [];

  for (const raw of llmItems) {
    const rawName = String(raw?.rawName || "").trim();
    const quantity = normalizeQuantity(raw?.quantity);
    const unit = raw?.unit || null;
    const note = raw?.note || null;
    // שורה בלי מספר ("מתקן סבון") נקראת כיחידה אחת — ראה tableParser.
    const quantityAssumed = Boolean(raw?.quantityAssumed);

    if (!rawName) continue;

    const base = { rawName, quantity, unit, note, quantityAssumed };

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
      if (!quantityAssumed || conf >= MIN_ITEM_CONFIDENCE) return false;

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
      if (
        hasProductWord(searchName) &&
        pool.some((candidate) => coversAllWords(searchName, candidate))
      ) {
        return false;
      }

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
        survivingPool = applyQualifiers(widePool, qualifiers).keptBeforeSilentDrops.map(
          (k) => ({ product: k.product })
        );
      }
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
    let historyPick = null;
    if (historyProfile && !aliasHit && !skuConfirmed && confidence < AUTO_ACCEPT_CONFIDENCE) {
      const pool = survivingPool || [
        { product: match.product },
        ...(match.pool || match.alternatives || []).map((alt) => ({ product: alt })),
      ];

      historyPick = pickFromHistory(pool, historyProfile);
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
    const historyMayDecide =
      historyPick?.tier === "decisive" &&
      (!quantityAssumed || coversAllWords(searchName, historyPick.product));

    // ── מידה שהלקוח ביקש ואינה בקטלוג גוברת על ההיסטוריה ──
    //
    // לקוח שביקש 500 גרם וקיים רק 360 ביקש מוצר שאין. העובדה שהוא קנה בעבר
    // את אריזת ה-360 אינה הופכת אותה למה שביקש הפעם, והשורה צריכה להגיע לאדם
    // עם ההסבר. ההיסטוריה עדיין נאמרת לו כרמז — היא רק אינה מאשרת לבדה.
    if (historyMayDecide && !requestedSizeMissing) {
      // המועמד המוביל הוא מסמך מלא; חלופות מגיעות רזות (‏_id/title/sku)
      const picked =
        historyPick.product.prices !== undefined
          ? historyPick.product
          : await Product.findById(historyPick.product._id).lean();

      if (picked) {
        chosenProduct = picked;
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
      quantity,
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
      if (!AUTO_PICK_AMBIGUOUS() || requestedSizeMissing) return null;
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
        productUnavailableReason(product, quantity, priceForProduct(priceMap, product))
      ) {
        return null;
      }

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

        const rivals = (match.alternatives || [])
          .filter((a) => a?.score >= match.score * 0.95)
          .slice(0, 3)
          .map((a) => `"${a.title?.he}"${a.sku ? ` (${a.sku})` : ""}`);

        const leader = `"${chosenProduct.title?.he}"${chosenProduct.sku ? ` (${chosenProduct.sku})` : ""}`;

        unmatched.push({
          ...base,
          confidence,
          matchScore: match.score,
          alternatives: match.alternatives,
          productTitle: chosenProduct.title?.he,
          // כשהסיבה לעצירה היא מידה או גודל שאינם בקטלוג, אמירת הסיבה חוסכת
          // לעובד את החיפוש: הוא רואה מיד שהלקוח ביקש משהו שאין, ויכול לאשר
          // את החלופה או לחזור ללקוח.
          failReason: withHistory(
            requestedSizeMissing
              ? `הלקוח ביקש "${missingSizeLabel}" ואין מוצר כזה בקטלוג — צריך לאשר שזה ${leader}`
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

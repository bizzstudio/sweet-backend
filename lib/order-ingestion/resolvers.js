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
const { matchProductByName } = require("../../utils/productMatching");
const { priceForProduct } = require("../../utils/customerPriceList");
const { extractQualifiers, applyQualifiers } = require("./qualifiers");
const { chooseProduct } = require("./llm");

// האם מותר לפנות לשירות AI חיצוני. כבוי בברירת מחדל — ראה lib/order-ingestion/index.js.
// חייב להיאכף גם כאן: בלי זה שלב ההכרעה בין מועמדים היה שולח קריאה בתשלום
// למרות ש"ה-AI כבוי", וזו הבטחה שבורה כלפי מי שהחליט לכבות אותו.
const USE_EXTERNAL_AI = () => process.env.INGESTION_USE_EXTERNAL_AI === "true";

// מעל הסף הזה מקבלים את הכרעת מנוע ההתאמה כמו שהיא
const AUTO_ACCEPT_CONFIDENCE = Number(process.env.INGESTION_AUTO_ACCEPT_CONFIDENCE) || 0.9;
// מתחת לסף הזה הפריט נחשב לא מזוהה גם אחרי הכרעת LLM
const MIN_ITEM_CONFIDENCE = Number(process.env.INGESTION_MIN_ITEM_CONFIDENCE) || 0.7;

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
 * @returns {Promise<{items: Array, unmatched: Array, dropped: Array}>}
 *          dropped — שורות שהכמות שלהן הונחה ולא נמצא להן מוצר. הן אינן כשל:
 *          כנראה לא היו פריט מלכתחילה, ולכן אינן מפילות את ההזמנה.
 */
const resolveItems = async (llmItems, { contextText = "", priceMap = null } = {}) => {
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
    const droppedAsText = (conf, reason) => {
      if (!quantityAssumed || conf >= MIN_ITEM_CONFIDENCE) return false;
      dropped.push({ ...base, reason });
      return true;
    };

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

    let match;
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
      });
    } catch (err) {
      // רגרסיה בבניית ה-regex או שגיאת DB — הפריט לא מזוהה, ההודעה כולה לא נופלת
      console.log(`[ingestion/resolveItems] כשל בהתאמת "${rawName}": ${err.message}`);
      unmatched.push({ ...base, confidence: 0, failReason: `תקלה בחיפוש המוצר: ${err.message}` });
      continue;
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

    if (sourceSku) {
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
    let requestedSizeMissing = false;
    // מה בדיוק הלקוח ביקש ולא קיים ("500 גרם", "גדולות") — נכנס להודעה לעובד
    let missingSizeLabel = null;

    // כשהמק"ט כבר הכריע אין מה לסנן: מזהי הגרסה נועדו להפריד בין מועמדים
    // דומים, והמפתח עשה זאת בוודאות גבוהה יותר מכל היוריסטיקה על שם.
    if (
      !skuConfirmed &&
      (qualifiers.negations.length ||
        qualifiers.sizes.length ||
        qualifiers.sizeWords.length ||
        qualifiers.variants.length)
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
    }

    let chosenProduct = match.product;
    let confidence = match.confidence;
    let decidedBy = skuConfirmed
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

    // ── שורה שהכמות שלה הונחה ולא נגעה בשום מוצר ──
    //
    // ההכרעה נעשית כאן, לפני כל שלב נוסף, ולא בכל ענף כשל בנפרד: משם היא גם
    // חוסמת קריאת LLM בתשלום על שורת טקסט כשההכרעה החיצונית מודלקת, וגם
    // מונעת בדיקת זמינות של מוצר שממילא לא הלקוח ביקש.
    if (droppedAsText(confidence, "השורה לא נראית כשם מוצר")) continue;

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
          failReason: requestedSizeMissing
            ? `הלקוח ביקש "${missingSizeLabel}" ואין מוצר כזה בקטלוג — צריך לאשר שזה ${leader}`
            : rivals.length
              ? `יש בקטלוג כמה מוצרים בשם דומה — צריך לבחור אחד: ${leader}, ${rivals.join(", ")}`
              : `הזיהוי לא היה ודאי — צריך לאשר שזה ${leader}`,
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
      if (droppedAsText(confidence, "השורה לא נראית כשם מוצר")) continue;
      unmatched.push({
        ...base,
        confidence,
        matchScore: match.score,
        alternatives: match.alternatives,
        productTitle: chosenProduct.title?.he,
        failReason: `הזיהוי לא היה ודאי — צריך לבחור ידנית ("${chosenProduct.title?.he}"?)`,
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

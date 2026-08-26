// utils/purchaseHistoryRanking.js
//
// "מה הלקוח הזה קונה בפועל" כשובר שוויון בין מועמדים.
//
// ── הבעיה שזה פותר ──
//
// 66% מהשורות שנתקעות ב"דורשות השלמה" אינן באג בזיהוי אלא עמימות אמיתית:
// הלקוח כתב קטגוריה ולא מוצר. "פרכיות" מתאים לשישה מוצרים בקטלוג שהציון שלהם
// נבדל בנקודה אחת מתוך 18,428, ו-"חלב עמיד 1 3% ליטר" מקבל ציון זהה לחלוטין
// לגרסת 1%. מנוע ההתאמה צודק כשהוא לא מכריע — אין בטקסט שום דבר שמכריע.
//
// אבל יש מידע שאינו בטקסט: **מה הלקוח הזה קנה בעבר**. לקוח טיפוסי קנה 47
// מק"טים מתוך 4,320 בקטלוג. אם מבין ששת המועמדים רק אחד נמצא ברשימה הזו, זו
// אינה סברה אלא הכרעה — הסיכוי לפגיעה מקרית הוא כ-6.5%.
//
// ── הגבול: מזהים בתוך הבריכה, לא מחפשים בקטלוג ──
//
// המודול הזה **אינו מחפש מוצרים**. הוא מקבל את רשימת המועמדים שמנוע ההתאמה
// כבר הביא ומדרג אותה מחדש. זו אותה משמעת בדיוק שנקבעה למק"ט שהלקוח מדפיס
// בהזמנה (ראה resolvers.js, "שובר שוויון: המק\"ט שהלקוח הדפיס"): היסטוריה
// שמחפשת בעצמה הייתה מכניסה להזמנה מוצר שהלקוח כלל לא הזכיר, בשקט ובביטחון
// מלא — וזה הכשל היקר ביותר בצינור הזה.
//
// מכאן נובע גם המיקום בסדר ההכרעה: **אחרי** סינון מזהי הגרסה, לא לפניו. לקוח
// שכתב "לא תה ירוק" מקבל את מה שביקש גם אם קנה תה ירוק במשך שנתיים — ההיסטוריה
// מדרגת את מי ששרד, ואינה מחזירה לחיים מועמד שנפסל.

const { normalizeSku, numericSkuKey } = require("./customerPriceList");
// אותו נרמול שמנוע ההתאמה משתמש בו — ראה ההסבר ב-utils/productAliases על
// למה שני נרמולים שונים הם כשל שקט
const { normalizeTitleForMatch } = require("./productMatching");

// ── כמה זמן קנייה נשארת רלוונטית ──
//
// המשקל דועך לפי 1/(1+חודשים/12): קנייה מהחודש שעבר שווה כמעט 1, קנייה מלפני
// שנה שווה חצי, מלפני שלוש שנים כרבע. הדעיכה רציפה ולא מדרגה, כי אין תאריך
// שבו מוצר "מפסיק להיות מה שהלקוח קונה" — הוא רק נעשה פחות סביר.
const RECENCY_MONTHS_SCALE = 12;

// קנייה בחצי השנה האחרונה נחשבת "עדכנית". זה הסף שמאפשר לקנייה **חד-פעמית**
// להכריע: מוצר שנקנה פעם אחת לפני שבועיים הוא הזמנה שוטפת, ומוצר שנקנה פעם
// אחת לפני שנתיים ומעולם לא שוב הוא כנראה טעות או ניסיון חד-פעמי.
const FRESH_MONTHS = 6;

// כמה קניות הופכות מוצר ל"רגיל אצל הלקוח" גם בלי עדכניות
const REPEAT_LINES = 2;

// ── כמה המוביל צריך להיות גדול מהשני כדי להכריע ──
//
// כששני מועמדים שונים נמצאים שניהם בהיסטוריה, עצם הנוכחות כבר לא מפרידה
// ביניהם — הלקוח קונה את שניהם. פי 3 במשקל פירושו שאחד מהם הוא ההזמנה השוטפת
// והשני חריג; פחות מזה זו בחירה בין שני מוצרים שהלקוח קונה באמת, ואסור למכונה
// להכריע בה. במקרה כזה חוזרים ל-hint: אדם יבחר, אבל עם המספרים מולו.
const DOMINANCE_RATIO = 3;

// פריט בלי תאריך אחרון מטופל כישן מאוד ולא כחסר. אפס היה מאפס את המשקל
// ומבטל גם את מספר הקניות, וזה מידע שכן קיים.
const UNDATED_MONTHS = 120;

const MS_PER_MONTH = 30.44 * 24 * 60 * 60 * 1000;

const monthsSince = (date, now) => {
  const time = date instanceof Date ? date.getTime() : Date.parse(date);
  if (!Number.isFinite(time)) return UNDATED_MONTHS;
  // תאריך עתידי (קובץ עם תאריכים שגויים) נחשב "היום" ולא מקבל משקל מנופח
  return Math.max(0, (now - time) / MS_PER_MONTH);
};

const recencyFactor = (monthsAgo) => 1 / (1 + monthsAgo / RECENCY_MONTHS_SCALE);

/**
 * בניית פרופיל הרכישות משורות ההיסטוריה השמורות.
 *
 * שני מפתחות ולא אחד: המזהה הוא הדרך הנכונה, והמק"ט הוא נפילה עבור שורה
 * שהמוצר שלה טרם היה בקטלוג בזמן היבוא ונוסף מאז. בלי הנפילה הזו היבוא היה
 * צריך לרוץ מחדש בכל פעם שמוצר נוסף לקטלוג.
 *
 * @param {Array} items - שורות מ-CustomerPurchaseHistory.items
 * @returns {{byProduct: Map, bySku: Map, size: number}}
 */
const buildPurchaseProfile = (items = []) => {
  const byProduct = new Map();
  const bySku = new Map();
  // כמה מוצרים **שונים** יש בפרופיל. אינו נגזר מגודל המפות: ‏bySku מחזיק גם
  // מפתחות מספריים כנפילה, ולכן size שלו מנפח את המספר — והוא מוצג ביומן
  // הקליטה ("ללקוח יש היסטוריית רכישות (N מוצרים)").
  let distinct = 0;

  // ── מיזוג ולא דריסה ──
  //
  // שני מק"טים שונים בקובץ יכולים להצביע על אותו מוצר בקטלוג: הקטלוג מכיל
  // קבוצות כפילויות, וגם הנפילה המספרית ("77" מול "0077") מובילה לשם. הניסוח
  // הראשון כאן עשה set פשוט, כלומר הרשומה השנייה **מחקה** את הראשונה — והלקוח
  // שקנה מוצר 9 פעמים היה נספר כמי שקנה אותו פעם אחת, כלומר הכרעה ודאית
  // הייתה יורדת לרמז.
  const mergeInto = (existing, entry) => {
    existing.lines += entry.lines;
    existing.totalQty += entry.totalQty;
    if (entry.lastAt && (!existing.lastAt || entry.lastAt > existing.lastAt)) {
      existing.lastAt = entry.lastAt;
    }
    if (!existing.name && entry.name) existing.name = entry.name;
    return existing;
  };

  for (const item of items) {
    if (!item) continue;

    const lines = Number(item.lines) > 0 ? Number(item.lines) : 1;
    const entry = {
      sku: normalizeSku(item.sku),
      name: item.name || null,
      lines,
      totalQty: Number(item.totalQty) || 0,
      lastAt: item.lastAt ? new Date(item.lastAt) : null,
    };
    // תאריך שאינו ניתן לפענוח מטופל כחסר ולא כ-Invalid Date, שכל השוואה מולו
    // מחזירה false ומשתיקה את דירוג העדכניות בשקט
    if (entry.lastAt && Number.isNaN(entry.lastAt.getTime())) entry.lastAt = null;

    // ‏_id ולא productId: Product.productId הוא שריד מהתבנית שהפרויקט שוכפל
    // ממנה ואינו מצביע על שום מסמך קיים (ראה models/Product).
    const productKey = item.product ? String(item.product) : null;

    if (productKey && byProduct.has(productKey)) {
      const merged = mergeInto(byProduct.get(productKey), entry);
      // המק"ט השני מצביע על אותה רשומה מאוחדת, כדי ששני המסלולים יראו את
      // אותו מונה
      if (entry.sku && !bySku.has(entry.sku)) bySku.set(entry.sku, merged);
      continue;
    }

    if (productKey) {
      byProduct.set(productKey, entry);
      distinct += 1;
    }

    if (entry.sku) {
      if (!bySku.has(entry.sku)) {
        bySku.set(entry.sku, entry);
        if (!productKey) distinct += 1;
      }
      const alias = numericSkuKey(entry.sku);
      // ההתאמה המדויקת קודמת תמיד; המפתח המספרי הוא נפילה בלבד
      if (alias && alias !== entry.sku && !bySku.has(alias)) bySku.set(alias, entry);
    }
  }

  return { byProduct, bySku, size: distinct };
};

/** האם המוצר הזה מופיע בהיסטוריה של הלקוח, ואם כן — באיזו עוצמה. */
const lookupProduct = (profile, product) => {
  if (!profile || !product) return null;

  const byId = profile.byProduct?.get(String(product._id));
  if (byId) return byId;

  const sku = normalizeSku(product.sku);
  if (!sku || !profile.bySku) return null;

  if (profile.bySku.has(sku)) return profile.bySku.get(sku);
  const alias = numericSkuKey(sku);
  return alias ? profile.bySku.get(alias) || null : null;
};

/**
 * הכרעה בין מועמדים לפי היסטוריית הרכישות של הלקוח.
 *
 * @param {Array<{product: Object, score?: number}>} candidates - בריכת המועמדים
 *        כפי שהיא נבנית ב-resolveItems: המוביל ואחריו החלופות.
 * @param {{byProduct: Map, bySku: Map}} profile - מ-buildPurchaseProfile
 * @param {Object} [options]
 * @param {number} [options.now=Date.now()] - מוזרק כדי שהבדיקות לא יהיו תלויות בשעון
 * @returns {null | {
 *   product: Object,
 *   tier: "decisive" | "hint",
 *   evidence: Array<{product: Object, lines: number, totalQty: number,
 *                    monthsAgo: number, weight: number}>,
 *   reason: string,
 * }}
 *   ‏null = אין אות. אף מועמד לא נמצא בהיסטוריה, ואין מה לומר על השורה הזו.
 *   ‏decisive = מותר לקבל אוטומטית.
 *   ‏hint = לא מכריע. המידע נועד להיאמר לאדם שבוחר, לא להחליט במקומו.
 */
const pickFromHistory = (candidates = [], profile = null, { now = Date.now() } = {}) => {
  if (!profile || !candidates.length) return null;

  // ── דה-דופליקציה, ולמה היא חשובה כאן ──
  //
  // אותו מוצר שמופיע פעמיים בבריכה היה נספר כשני "מועמדים בהיסטוריה", כלומר
  // הופך הכרעה ודאית (פגיעה אחת) להתלבטות בין שניים — בדיוק הפוך מהאמת.
  const seen = new Set();
  const hits = [];

  for (const candidate of candidates) {
    const product = candidate?.product || candidate;
    if (!product?._id) continue;

    const id = String(product._id);
    if (seen.has(id)) continue;
    seen.add(id);

    const entry = lookupProduct(profile, product);
    if (!entry) continue;

    const monthsAgo = monthsSince(entry.lastAt, now);
    hits.push({
      product,
      lines: entry.lines,
      totalQty: entry.totalQty,
      monthsAgo,
      weight: entry.lines * recencyFactor(monthsAgo),
    });
  }

  if (!hits.length) return null;

  // ── מיון יציב במפורש ──
  //
  // שני מועמדים במשקל זהה היו מסודרים לפי סדר השליפה מהמסד, כלומר אותה הזמנה
  // בדיוק הייתה יכולה לבחור מוצר אחר בהרצה חוזרת. שוברי השוויון כאן קובעים
  // סדר אחד ויחיד: משקל, מספר קניות, כמות, ולבסוף המזהה.
  hits.sort(
    (a, b) =>
      b.weight - a.weight ||
      b.lines - a.lines ||
      b.totalQty - a.totalQty ||
      String(a.product._id).localeCompare(String(b.product._id))
  );

  const top = hits[0];
  const runnerUp = hits[1];

  // מוצר שנקנה פעם אחת מזמן אינו "מה שהלקוח קונה" — הוא אירוע בודד
  const topIsEstablished = top.lines >= REPEAT_LINES || top.monthsAgo <= FRESH_MONTHS;

  const dominant = !runnerUp || top.weight >= runnerUp.weight * DOMINANCE_RATIO;
  const tier = topIsEstablished && dominant ? "decisive" : "hint";

  return { product: top.product, tier, evidence: hits, reason: describeEvidence(hits) };
};

/**
 * האם כל מה שהלקוח כתב מופיע בשם המוצר.
 *
 * ── למה זה קיים ──
 *
 * שורה שהלקוח כתב **בלי כמות** היא ניחוש של הפרסר שמדובר בפריט בכלל. נמדד על
 * הזמנות אמיתיות ששורות כאלה כוללות גם כתובות וחתימות:
 *
 *     "הרצל 5 בני ברק"   התאים למוצר בציון 0.47
 *     "קומה 3 דירה 12"   0.6
 *     "מגבות נייר"       0.53   ← מוצר אמיתי
 *
 * הטווחים חופפים, ולכן ביטחון אינו יכול להפריד ביניהם. מה שכן מפריד: **שם
 * מוצר הוא תיאור של המוצר.** מי שכתב "קפה טורקי" כתב שתי מילים שנמצאות שתיהן
 * בשם המוצר; מי שכתב "קומה 3 דירה 12" לא יימצא מוצר שנושא גם "קומה" וגם
 * "דירה".
 *
 * הדרישה מוחלת **רק** על שורות בלי כמות. שורה שהלקוח כתב לה מספר כבר הצהירה
 * שהיא פריט, ואין סיבה לדרוש ממנה גם ניסוח מלא.
 *
 * מילים בנות תו אחד מדולגות, כמו במנוע ההתאמה: הן רועשות מכדי להעיד על דבר.
 */
const coversAllWords = (text, product) => {
  const words = normalizeTitleForMatch(text)
    .split(" ")
    .filter((word) => word.length > 1);
  if (!words.length) return false;

  const title = new Set(
    [product?.title?.he, product?.title?.en]
      .filter(Boolean)
      .flatMap((value) => normalizeTitleForMatch(value).split(" "))
  );

  // מילה שלמה ולא substring: "תה" אינו נחשב מופיע בתוך "מתה" או "פתה"
  return words.every((word) => title.has(word));
};

const roundMonths = (monthsAgo) => Math.max(1, Math.round(monthsAgo));

/**
 * ניסוח הראיה בעברית, להודעה שהעובד קורא.
 *
 * הניסוח חי כאן ולא ב-resolvers כדי שהמספרים והטקסט לא יתפצלו: מי שמשנה את
 * כללי הדירוג רואה מיד מה נאמר עליהם למשתמש.
 */
const describeEvidence = (hits = []) => {
  const phrase = (hit) => {
    const title = hit.product?.title?.he || hit.product?.title?.en || "מוצר";
    const times =
      hit.lines === 1 ? "פעם אחת" : hit.lines === 2 ? "פעמיים" : `${hit.lines} פעמים`;
    const when =
      hit.monthsAgo >= UNDATED_MONTHS
        ? "בלי תאריך"
        : hit.monthsAgo < 1
          ? "החודש"
          : `לפני ${roundMonths(hit.monthsAgo)} חודשים`;
    return `"${title}" ${times} (אחרון: ${when})`;
  };

  return `הלקוח הזמין בעבר ${hits.slice(0, 3).map(phrase).join(", ")}`;
};

module.exports = {
  buildPurchaseProfile,
  pickFromHistory,
  coversAllWords,
  // מיוצאים לבדיקות ולכיול הספים
  FRESH_MONTHS,
  REPEAT_LINES,
  DOMINANCE_RATIO,
};

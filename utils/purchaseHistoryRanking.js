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
const { canonicalWords, DICTIONARY_ON } = require("./orderWording");

// ── כמה זמן קנייה נשארת רלוונטית ──
//
// המשקל דועך לפי 1/(1+חודשים/12): קנייה מהחודש שעבר שווה כמעט 1, קנייה מלפני
// שנה שווה חצי, מלפני שלוש שנים כרבע. הדעיכה רציפה ולא מדרגה, כי אין תאריך
// שבו מוצר "מפסיק להיות מה שהלקוח קונה" — הוא רק נעשה פחות סביר.
const RECENCY_MONTHS_SCALE = 12;

// קנייה בחצי השנה האחרונה נחשבת "עדכנית". זה הסף שמאפשר לקנייה **חד-פעמית**
// להכריע כשיש לה מתחרה: מוצר שנקנה פעם אחת לפני שבועיים הוא הזמנה שוטפת.
const FRESH_MONTHS = 6;

// ── קנייה חד-פעמית **בלי מתחרה** ──
//
// ‏FRESH_MONTHS כויל על מוצרי מכולת: חלב, קפה וסוכר נקנים שבועית, ומוצר
// שנעלם לחצי שנה כנראה הוחלף. ציוד משרדי נקנה בקצב אחר לגמרי — קלסר, שדכן
// ומחברת נקנים פעם בשנה.
//
// נמדד בהזמנה אמיתית: הלקוח כתב "קלסר", בקטלוג 15 קלסרים, והוא קנה בדיוק
// אחד מהם — פעם אחת, לפני 8.7 חודשים. הכלל החזיר רמז, השורה נשארה בביטחון
// 0.53, ו**כל ההזמנה** נפלה ל"לא הובנה במלואה" (הביטחון הכולל הוא המינימום
// מבין הפריטים). שלושת הפריטים האחרים נפתרו ב-0.9.
//
// ── למה מותר להאריך דווקא כאן ──
//
// דעיכת העדכניות נועדה לתפוס **החלפת העדפה**. כשהלקוח קנה מוצר אחד ויחיד
// מתוך הבריכה, אין שום ראיה שההעדפה השתנתה — אין מתחרה שהוא עבר אליו. הסיכוי
// שדווקא זה שהוא נגע בו מתוך 15 הוא צירוף מקרים הוא 1 ל-15.
//
// כשיש **כמה** מועמדים בהיסטוריה, המצב הפוך: הלקוח קונה יותר מאחד, ואז
// חד-פעמיות ישנה חייבת להיות טרייה כדי לגבור. שם FRESH_MONTHS ממשיך לחול.
//
// התקרה קיימת כדי שקנייה בודדת מלפני שנים לא תכריע לנצח.
const SINGLE_HIT_MAX_MONTHS =
  Number(process.env.INGESTION_HISTORY_SINGLE_HIT_MONTHS) || 24;

// כמה קניות הופכות מוצר ל"רגיל אצל הלקוח" גם בלי עדכניות
const REPEAT_LINES = 2;

// ── כמה המוביל צריך להיות גדול מהשני כדי להכריע ──
//
// כששני מועמדים שונים נמצאים שניהם בהיסטוריה, עצם הנוכחות כבר לא מפרידה
// ביניהם — הלקוח קונה את שניהם. פי 3 במשקל פירושו שאחד מהם הוא ההזמנה השוטפת
// והשני חריג; פחות מזה זו בחירה בין שני מוצרים שהלקוח קונה באמת, ואסור למכונה
// להכריע בה. במקרה כזה חוזרים ל-hint: אדם יבחר, אבל עם המספרים מולו.
const DOMINANCE_RATIO = 3;

// ── בתוך הרשימה של הלקוח מספיק פער קטן יותר ──
//
// פי 3 נקבע לבריכה שמגיעה מחיפוש בקטלוג, שבה שני המועמדים יכולים להיות
// מוצרים שונים לגמרי. כאן המועמדים כבר סוננו ל**אותו מוצר** מתוך מה שהלקוח
// קונה ("חלב" → החלבים שלו, "סוכר" → הסוכרים שלו), והשאלה היא רק איזו גרסה
// היא הרגילה שלו. אדם היה לוקח את זו שהוא קונה הכי הרבה; פי 1.5 דורש שהיא
// גם תהיה מובילה בבירור, ומה שהלקוח כתב מגיע למלקט כהערה.
const OWN_LIST_DOMINANCE_RATIO =
  Number(process.env.INGESTION_OWN_LIST_DOMINANCE_RATIO) || 1.5;

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

// ── "מה הלקוח ביקש" מול "איך הוא ארוז" ──
//
// נמדד על 435 שורות שנתקעו (11/10/26). שני כשלים חזרו בהן:
//
//  1. מתחרה שאינו אותו מוצר. "קרטון בייגלה" הביא לבריכה את "חלב טרי **ב**קרטון"
//     (507 קניות) מול "בייגלה שטוחים" (227) — פחות מפי 3, ולכן רמז בלבד. החלב
//     חולק עם השורה מילת אריזה, לא מוצר. אותו דבר ב"שקית …" מול "מגבונים לחים
//     שקית מילוי", וב"… 100 יח" מול "תה ויסוצקי 100 יח".
//
//  2. מבחן הכיסוי המדויק נופל על ניסוח. "קינדל אצבעות- חבילה" מול "אצבעות
//     קינדר אריזה כפולה": שגיאת כתיב ומילת אריזה, והמוצר היחיד שהלקוח קונה
//     לא התקבל. כך גם "לואיזה" מול "ולואיזה", ו-‏"1ק\"ג לימון" מול "לימון 1 ק\"ג".
//
// הפתרון לשניהם הוא אותה שאלה: האם המוצר נושא את **כל מה שהלקוח ביקש** —
// אחרי שמסירים מהשורה את מה שאינו שם של מוצר. מי שנושא הכול הוא מועמד; מי
// שחולק עם השורה מילה אחת אינו מתחרה שלו.
//
// מה מוסר: מספרים ויחידות מידה (המידה נאכפת בנפרד, ב-applyQualifiers, והבריכה
// שמגיעה לכאן כבר סוננה לפיה), ומילים שאומרות "יחידת מכירה אחת".
// ‏"קרטון" ו"ארגז" **אינם** ברשימה בכוונה: הם מכפלה ("3 קרטונים" אינם 3
// יחידות), ושורה כזו צריכה להגיע לאדם.
const NON_PRODUCT_WORDS = new Set([
  "מארז", "שקית", "שקיות", "חב", "יח", "קג", "גר", "ליטר", "מל", "חצי",
  // צורת אריזה שהלקוח מזכיר ושם המוצר לא תמיד נושא: "סודה שישייה" מול
  // "סודה 1.5 ליטר", "שרוול כוסות" מול "כוסות שתיה קרה", "חליטת תה" מול "תה"
  ...(DICTIONARY_ON ? ["שישיה", "שלישיה", "שרוול", "שרוולים", "חליטת", "חליטה"] : []),
]);

// אותיות השימוש שנדבקות למילה: "ולואיזה", "בקופסה", "לידיים"
const CLITICS = ["ו", "ב", "ה", "ל", "ש", "מ"];
const MIN_CLITIC_BASE = 3;

// שגיאת כתיב של תו אחד, ורק במילים ארוכות: "טיסטר"/"טסטר", "קינדל"/"קינדר".
// במילים קצרות תו אחד הוא מילה אחרת ("חם"/"קר", "תה"/"תות").
const FUZZY_MIN_LONG = 5;
const FUZZY_MIN_SHORT = 4;

const withinOneEdit = (a, b) => {
  if (a === b) return true;
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  if (long.length < FUZZY_MIN_LONG || short.length < FUZZY_MIN_SHORT) return false;
  if (long.length - short.length > 1) return false;

  let i = 0;
  while (i < short.length && long[i] === short[i]) i += 1;
  // תו אחד שונה, שני תווים סמוכים שהתחלפו ("טאולט"/"טואלט"), או תו אחד
  // עודף במילה הארוכה
  if (long.length === short.length) {
    return (
      long.slice(i + 1) === short.slice(i + 1) ||
      (long[i] === short[i + 1] && long[i + 1] === short[i] && long.slice(i + 2) === short.slice(i + 2))
    );
  }
  return long.slice(i + 1) === short.slice(i);
};

// ── שגיאת כתיב מתוקנת רק למילה שאינה קיימת בקטלוג ──
//
// נמדד: "לימונים" התקבל כ"לימונית" והלקוח קיבל תה במקום לימונים; "שלישיות"
// התקבל כ"שישיות". שתיהן מילים תקינות שנמצאות בקטלוג — כלומר לא שגיאת כתיב
// אלא מילה אחרת. "קינדל", "טיסטר" ו"טינה" אינן בקטלוג, ולכן הן כן שגיאה.
// בלי אוצר מילים אין דרך להבחין, ואז לא מתקנים דבר.
// ── יחיד מול רבים ──
//
// "בננה"/"בננות", "לימון"/"לימונים", "אגס"/"אגסים". רק שלוש הצורות האלה,
// ולא חיתוך סיומת כללי: חיתוך של ה' היה משווה "חלב" ל"חלבה", ושל "ית"
// היה משווה "לימון" ל"לימונית" — שני מוצרים שונים בכל אחד מהזוגות.
const MIN_STEM = 3;
// אות סופית באמצע מילה: "לימון" + "ים" הוא "לימונים", לא "לימוןים"
const FINALS = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };
const openFinal = (word) => word.replace(/[ךםןףץ]/g, (ch) => FINALS[ch]);

const singularPlural = (first, second) => {
  const a = openFinal(first);
  const b = openFinal(second);
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  if (long === `${short}ימ`) return short.length >= MIN_STEM;
  // תואר שמתאים עצמו לשם: "פלפלים אדומים" מול "גמבה אדומה", "גדולות" מול
  // "גדולים". ‏(X, Xה) עדיין אינו כאן — "חלב" אינו "חלבה".
  for (const [one, other] of [["ה", "ימ"], ["ימ", "ות"]]) {
    for (const [x, y] of [[a, b], [b, a]]) {
      if (x.endsWith(one) && y.endsWith(other)) {
        const stem = x.slice(0, -one.length);
        if (stem.length >= MIN_STEM && stem === y.slice(0, -other.length)) return true;
      }
    }
  }
  if (long === `${short}ים` || long === `${short}ות`) return short.length >= MIN_STEM;
  return (
    short.endsWith("ה") &&
    long === `${short.slice(0, -1)}ות` &&
    short.length - 1 >= MIN_STEM
  );
};

const sameWord = (asked, inTitle, vocabulary) => {
  if (asked === inTitle) return true;
  if (singularPlural(asked, inTitle)) return true;
  for (const clitic of CLITICS) {
    if (inTitle === clitic + asked && asked.length >= MIN_CLITIC_BASE) return true;
    if (asked === clitic + inTitle && inTitle.length >= MIN_CLITIC_BASE) return true;
  }
  if (!vocabulary || vocabulary.has(asked)) return false;
  return withinOneEdit(asked, inTitle);
};

// ‏"1ק\"ג" מגיע מהנרמול כאסימון אחד ("1קג") — מפרידים ספרות מאותיות לפני הסינון
const splitDigits = (word) => word.split(/(?<=\d)(?=\D)|(?<=\D)(?=\d)/);

/**
 * מילות השורה שמתארות את המוצר עצמו. מה שבסוגריים הוא הוראה ("כל מיני
 * סוגים", "לא להביא תחליף") ולא חלק מהשם — "מיקס חסות (כל מיני סוגים)" התאים
 * בגלל "מיני" ל"שוקולד מיקס מיני".
 */
const productWordsOf = (text) =>
  canonicalWords(String(text || "").replace(/\([^)]*\)?/g, " "))
    .flatMap(splitDigits)
    .filter((word) => word.length > 1 && !/^\d/.test(word) && !NON_PRODUCT_WORDS.has(word));

// כל רצף ספרות בטקסט, כולל ספרה בודדת (‏canonicalWords משמיט אותה)
// ── מספר עשרוני הוא מספר אחד ──
//
// נמדד: "יוגורט ביו 1.8%" התקבל כ"יוגורט ביו מולר 2.8%/1.7%" — אחרי פירוק
// לספרות, ה-1 וה-8 נמצאו שניהם בשם המוצר. המספרים נקראים מהטקסט המקורי,
// ו"1/2 קילו"/"חצי קילו" נספרים כ-500 כדי שיתאימו ל"500 גר".
const numbersOf = (text) =>
  (
    String(text || "")
      .replace(DICTIONARY_ON ? /(?:1\/2|חצי)\s*(?:קילו|ק["״]?ג)/g : /$^/, " 500 ")
      .match(/\d+(?:[.,]\d+)?/g) || []
  ).map((number) => number.replace(",", "."));

const titleTextOf = (product) =>
  [product?.title?.he, product?.title?.en].filter(Boolean).join(" ");

/**
 * האם המוצר נושא את כל מה שהלקוח ביקש — בסובלנות לאריזה, לאות שימוש ולשגיאת
 * כתיב של תו אחד. שורה שאין בה מילת מוצר ("1 יח'") אינה מכוסה על ידי דבר.
 *
 * ── מספר שאינו בשם המוצר עוצר את הכיסוי ──
 *
 * נמדד: "חלב רגיל 3% 50" היא שורה מרשימת מלאי שבה 50 היא הכמות, והפרסר לא
 * קרא אותה. בלי הסייג השורה התקבלה ככמות 1 — הזמנה שנכנסת "תקינה" עם חלב
 * אחד במקום חמישים. מספר שהלקוח כתב ואינו בשם המוצר הוא או מידה אחרת או
 * כמות שלא נקראה, ובשני המקרים זו הכרעה של אדם.
 *
 * @param {Map} [options.vocabulary] - אוצר המילים של הקטלוג; בלעדיו שגיאות
 *        כתיב אינן מתוקנות (ראה sameWord).
 */
const coversRequest = (text, product, { vocabulary = null } = {}) => {
  const asked = productWordsOf(text);
  if (!asked.length) return false;

  const titleText = titleTextOf(product);
  const title = canonicalWords(titleText);
  const titleNumbers = new Set(numbersOf(titleText));

  return (
    numbersOf(text).every((number) => titleNumbers.has(number)) &&
    asked.every((word) => title.some((inTitle) => sameWord(word, inTitle, vocabulary)))
  );
};

// שלוש אותיות ראשונות משותפות: "נקטרינות"/"נקטרינה", "אגס"/"אגסים",
// "גמבות"/"גמבה". זה מבחן **שלילה** בלבד — הוא פוסל מוצר שאין לו שום קשר
// לשורה, ואינו מאשר דבר — ולכן מותר לו להיות רחב. מבחן מדויק כאן פסל יחיד
// מול רבים והפיל שורות שהתקבלו נכון עד היום.
const RELATED_PREFIX = 3;
const looselyRelated = (asked, inTitle) =>
  asked.length >= RELATED_PREFIX &&
  inTitle.length >= RELATED_PREFIX &&
  asked.slice(0, RELATED_PREFIX) === inTitle.slice(0, RELATED_PREFIX);

// מילת גודל אינה קשר בין שורה למוצר: "שקיות פח אשפה גדולות" מול "מסטיק
// בקופסה גדולה" חולקים רק אותה, והמסטיק נכנס להזמנה (נמדד, #202292).
const SIZE_STEMS = ["גדול", "קטן", "קטנ", "בינונ", "ענק", "מיני"];
const isSizeWord = (word) => SIZE_STEMS.some((stem) => word.startsWith(stem));

/**
 * האם השורה והמוצר הם אותו שם — כל מה שהלקוח כתב נמצא בשם המוצר, **וגם** כל
 * מה שבשם המוצר נכתב בשורה (מלבד מידה ואריזה).
 *
 * הכיוון השני הוא מה שמפריד: "תפוח ירוק" מכוסה במלואו על ידי "תה ירוק תפוח
 * וקינמון", ו"קיסמים" על ידי "קיסמים לניקוי אוזנים מעץ" — אבל בשניהם שם
 * המוצר אומר דברים שהלקוח לא כתב. "פסטרמה דק דק" מול "פסטרמה דק דק 120 גר'"
 * ו"3 קילו בננה" מול "בננות 3 ק\"ג" הם אותו שם.
 */
const sameName = (text, product, { vocabulary = null } = {}) => {
  if (!coversRequest(text, product, { vocabulary })) return false;
  const asked = productWordsOf(text);
  return productWordsOf(titleTextOf(product)).every((inTitle) =>
    asked.some((word) => sameWord(word, inTitle, vocabulary))
  );
};

// ── מוצר "מגוון סוגים": שם אחד בקטלוג לכל הגרסאות ──
//
// הקטלוג מחזיק "חלב סויה טרי מגוון סוגים" כמוצר אחד, והלקוח כותב את הגרסה:
// "חלב סויה ללא סוכר", "חלב סויה (כחול)". אף מוצר אינו נושא "ללא סוכר", ולכן
// השורה נפלה — או גרוע מזה, הותאמה ל"חלבה לייט/ללא סוכר" (נמדד בשמונה
// הזמנות, 11/10/26). כשהלקוח קונה את מוצר ה"מגוון", הגרסה שכתב היא הוראה
// למלקט ולא מוצר אחר.
//
// התנאי הוא על **שם המוצר**: כל מה שבו (מלבד "מגוון סוגים" עצמו) נכתב בשורה.
// כך "חלב סויה טרי מגוון סוגים" עונה ל"חלב סויה ללא סוכר", ואינו עונה ל"חלב".
const ASSORTED_WORDS = new Set(["מגוון", "סוגים", "שונים", "טעמים", "סוג", "טרי"]);
const isAssorted = (product) => {
  const words = new Set(canonicalWords(titleTextOf(product)));
  return (words.has("סוגים") || words.has("טעמים")) && (words.has("מגוון") || words.has("שונים"));
};

/** האם המוצר הוא "מגוון סוגים" של מה שהלקוח ביקש. */
const assortedOf = (text, product, { vocabulary = null } = {}) => {
  if (!isAssorted(product)) return false;
  const asked = productWordsOf(text);
  // "לחם קל/מלא סוגים שונים": מה שמחובר בלוכסן הוא רשימת האפשרויות, לא חלק
  // מהשם — "לחם חום" הוא אחד מהסוגים בדיוק כמו "קל" ו"מלא".
  const tokens = titleTextOf(product).split(/\s+/);
  const withoutOptions = tokens.filter((token) => !token.includes("/")).join(" ");
  let core = productWordsOf(withoutOptions).filter((word) => !ASSORTED_WORDS.has(word));
  // "פסטרמה/נקניק סוגים שונים": כל השם הוא רשימת האפשרויות. אז האפשרות
  // שהלקוח כתב ("נקניק סלמי") היא שם המוצר.
  if (!core.length) {
    const options = productWordsOf(tokens.filter((token) => token.includes("/")).join(" "));
    core = options.filter((option) => asked.some((word) => sameWord(word, option, vocabulary))).slice(0, 1);
  }
  // מוצר שכל שמו הוא "מגוון סוגים" אינו עונה לשום דבר מסוים
  if (!core.length || !asked.length) return false;

  // מספר בשורה שאינו בשם המוצר — אותו סייג כמו ב-coversRequest
  const titleNumbers = new Set(numbersOf(titleTextOf(product)));
  if (!numbersOf(text).every((number) => titleNumbers.has(number))) return false;

  // ── המילה הראשונה בשורה היא המוצר ──
  //
  // נמדד: "עוגיות שוקולד ציפ של מילקה" ענה ל"שוקולד מילקה טעמים שונים" — כל
  // מילות המוצר נמצאות בשורה, אבל הלקוח ביקש עוגיות. בעברית שם העצם בא
  // ראשון, ולכן הוא חייב להיות חלק משם המוצר.
  if (!core.some((inTitle) => sameWord(asked[0], inTitle, vocabulary))) return false;

  return core.every((inTitle) => asked.some((word) => sameWord(word, inTitle, vocabulary)));
};

// ── המוצר של הלקוח שהכי קרוב למה שכתב ──
//
// הלקוח כותב "גבינת עיזים של גד", ובהיסטוריה שלו יש "גבינת עיזים למריחה" —
// גבינת העיזים היחידה שהוא קונה. מבחן הכיסוי המלא נכשל על "של גד", והשורה
// נעצרה. אדם שמכיר את הלקוח לא היה מתלבט, והמידע שעליו הוא נשען נמצא כאן:
// ברשימה של הלקוח אין גבינת עיזים אחרת.
//
// הכלל פועל **רק בתוך הרשימה של הלקוח**, ושם שלושה תנאים:
//   • המילה הראשונה בשורה (שם העצם) נמצאת בשם המוצר.
//   • לפחות שתי מילות מוצר משותפות — או שהשורה כולה מילה אחת.
//   • אף מילה שהלקוח כתב ואינה במוצר הנבחר אינה מופיעה במוצר **אחר** שלו
//     מאותו סוג. זה מה שעוצר "כוסות שתייה חמה" מול "כוסות שתיה קרה": ללקוח
//     יש גם "כוסות חם", ולכן "חמה" היא בדיוק מה שמבדיל בין השניים.
//
// ‏"קרטון" ו"ארגז" פוסלים את השורה מראש — הם שאלה של כמות, לא של מוצר.
const MULTIPLIER_WORDS = ["קרטון", "קרטונים", "ארגז", "ארגזים"];
// בכמה שמות מוצר בקטלוג מותר למילה להופיע כדי להיחשב שם של מוצר מסוים
const RARE_WORD_MAX = 3;

// מילים שהופכות את המוצר למוצר אחר: גודל, צבע, טעם, "נטול"/"זירו"/"דיאט"
const VARIANT_STEMS = [
  "גדול", "קטן", "קטנ", "בינונ", "ענק", "מיני", "אישי",
  "אדום", "אדומ", "ירוק", "כחול", "תכלת", "צהוב", "לבן", "לבנ", "שחור", "כתום", "כתומ",
  "חום", "חומ", "ורוד", "סגול", "כהה", "בהיר",
  "נטול", "זירו", "דיאט", "לייט", "טבעונ", "אורגנ", "מלוח", "מתוק", "קלוי", "חריף",
  "וניל", "שוקולד", "תות", "לימון", "בננה", "אפרסק", "מנגו", "פטל", "קרמל", "קוקוס",
];
// שמות מוצר שמתחילים במקרה כמו צבע או טעם: "חומוס" אינו "חום". נמדד 12/10/26:
// "חומוס קטן" מול "סלט חומוס" נחשב כשורה בלי שם מוצר משותף.
const NOT_VARIANT_WORDS = new Set(["חומוס", "חומץ", "חומר", "חומרי", "לימונדה"]);
const isVariantWord = (word) => {
  if (NOT_VARIANT_WORDS.has(word)) return false;
  const open = openFinal(word);
  return VARIANT_STEMS.some((stem) => open.startsWith(openFinal(stem)));
};

const looseSame = (a, b, vocabulary) => {
  if (sameWord(a, b, vocabulary)) return true;
  const x = openFinal(a);
  const y = openFinal(b);
  return x.length >= 2 && y.length >= 2 && (x.startsWith(y) || y.startsWith(x));
};

/**
 * @param {string} text - מה שהלקוח כתב
 * @param {Array<Object>} products - המוצרים שהלקוח קנה (עם title)
 * @returns {Array<{product: Object}>} המועמדים הקרובים ביותר, או רשימה ריקה
 *          כשאין מועמד שעומד בתנאים. ההכרעה ביניהם נשארת ל-pickFromHistory.
 */
const closestOwnProducts = (text, products = [], { vocabulary = null, usage = null } = {}) => {
  const asked = productWordsOf(text);
  if (!asked.length) return [];
  const allWords = canonicalWords(text);
  if (allWords.some((word) => MULTIPLIER_WORDS.includes(word))) return [];

  // ── שלושה מצבים שבהם "הקרוב ביותר" הוא ניחוש (נמדד, 11/10/26) ──
  //
  // שני מוצרים בשורה אחת: "תפוח ירוק * 2 תפוח אדום", "מלפפון בייבי+ גמבה
  // בייבי", "גבינת עזים צוריאל או כל גבינה אחרת" — כל בחירה משמיטה אחד.
  // כוכבית לבדה היא הדגשה של ווצאפ ("חלב סויה *ללא סוכר*"); כוכבית ואחריה
  // מספר היא מוצר שני.
  if (/\+|\*\s*\d|\sאו\s/.test(String(text))) return [];
  // שורה שנפתחת במילת אריזה ונשארת בה מילה אחת: "שקיות שקופות" — האריזה היא
  // המוצר עצמו, ו"שקופות" לבדה התאימה למזלגות שקופים. "מארז נייר טואלט זול"
  // אינו כזה: נשאר בו שם מוצר שלם.
  // רק "שקית"/"שקיות": הן יכולות להיות המוצר. "חב' טישו" ו"חבילת מפיות"
  // נפתחות במילה שלעולם אינה מוצר, ושם מה שנשאר הוא שם המוצר כולו.
  if (["שקית", "שקיות"].includes(allWords[0]) && asked.length < 2) return [];

  // ── מילה נדירה שרק מוצר אחד של הלקוח נושא ──
  //
  // "פטל ויטמינציק" מול "סירופ ויטמינציק 1 ליטר": שם העצם שונה, אבל
  // "ויטמינציק" מופיע בשלושה מוצרים בכל הקטלוג ובאחד בלבד ממה שהלקוח קונה
  // (98 פעמים). מילה כזו היא שם המוצר בפי הלקוח, והטעם שכתב מגיע כהערה.
  if (vocabulary) {
    for (const word of asked) {
      const frequency = vocabulary.get(word) || 0;
      if (word.length < 4 || frequency < 1 || frequency > RARE_WORD_MAX) continue;
      const carriers = products.filter((product) =>
        canonicalWords(titleTextOf(product)).includes(word)
      );
      if (carriers.length !== 1) continue;

      // מה שהלקוח כתב ואינו בשם המוצר חייב להיות טעם או גרסה ("פטל"), לא שם
      // של מוצר אחר ולא גודל. נמדד: "מיקס חסות" התאים ל"שוקולד מיקס מיני",
      // ו"טחינה הר ברכה **גדול**" לחצי קילו.
      const title = canonicalWords(titleTextOf(carriers[0]));
      const missing = asked.filter(
        (other) => !title.some((inTitle) => sameWord(other, inTitle, vocabulary))
      );
      const harmless = missing.every(
        (other) => !isSizeWord(other) && (isVariantWord(other) || !vocabulary.has(other))
      );
      if (harmless) return [{ product: carriers[0] }];
    }
  }

  // ── שם המוצר כולו כתוב בשורה ──
  //
  // "מארז מאגדת מיני מגנום סוגים שונים כולל שוקולד חם": הלקוח כתב את שם
  // המוצר שהוא קונה והוסיף הערות. כשכל שם המוצר (שתי מילים ומעלה) נמצא
  // בשורה, ורק מוצר אחד שלו כזה, מה שנוסף הוא הוראה למלקט.
  const named = products.filter((product) => {
    const titleText = titleTextOf(product);
    const names = productWordsOf(titleText);
    if (names.length < 2) return false;
    const titleNumbers = new Set(numbersOf(titleText));
    if (!numbersOf(text).every((number) => titleNumbers.has(number))) return false;
    // בשורה חייב להיות יותר משם המוצר לבדו: כשהיא שווה לו בדיוק, גם מוצר
    // ארוך יותר שלו עונה לה ("מלח למדיח" מול "מלח למדיח כלים"), וההכרעה
    // ביניהם היא לפי מה שהוא קונה יותר — למטה.
    if (asked.length <= names.length) return false;
    return names.every((inTitle) => asked.some((word) => sameWord(word, inTitle, vocabulary)));
  });
  if (named.length === 1) return [{ product: named[0] }];

  const scored = [];
  for (const product of products) {
    const titleText = titleTextOf(product);
    const title = canonicalWords(titleText);
    const inTitleWord = (word) => title.some((inTitle) => sameWord(word, inTitle, vocabulary));
    // שם העצם הוא המילה הראשונה, או השנייה כשהראשונה כללית ("אגוז קשיו קלוי")
    // השנייה חייבת להיות שם של מוצר ("קשיו"), לא מילת מילוי: "סויה ללא סוכר"
    // התאים כך ל"מסטיק ללא סוכר".
    const secondIsHead =
      asked.length >= 3 && isNameWord(asked[1]) && inTitleWord(asked[1]) && inTitleWord(asked[2]);
    if (!inTitleWord(asked[0]) && !secondIsHead) continue;

    // מספר בשורה שאינו בשם המוצר — כמות שלא נקראה או מידה אחרת
    const titleNumbers = new Set(numbersOf(titleText));
    if (!numbersOf(text).every((number) => titleNumbers.has(number))) continue;

    const missing = asked.filter(
      (word) => !title.some((inTitle) => sameWord(word, inTitle, vocabulary))
    );
    scored.push({ product, title, shared: asked.length - missing.length, missing });
  }
  if (!scored.length) return [];

  const best = Math.max(...scored.map((entry) => entry.shared));
  if (best < 2 && asked.length > 1) return [];

  const leaders = scored.filter((entry) => entry.shared === best);

  // מילת גרסה שהלקוח כתב והמוצר אינו נושא: "קוקה קולה בקבוק **קטן**" אינו
  // שישיית 1.5 ליטר, ו"טסטר צ'ויס **נטול** קפאין" אינו האדום הרגיל. מותג או
  // תיאור ("של גד", "מחוזק") אינם ברשימה — הם לא הופכים את המוצר לאחר.
  if (leaders.some((leader) => leader.missing.some(isVariantWord))) return [];
  // מותג שנכתב באותיות לטיניות הוא בקשה מפורשת: "טוש שחור staedtler" אינו שארפי
  if (leaders.some((leader) => leader.missing.some((word) => /^[a-z]/.test(word)))) return [];

  // מילה שהלקוח כתב, שאינה במובילים, וכן נמצאת במוצר **אחר** שלו שחולק עם
  // השורה מילה נוספת. "חליטת תה לימונית" מול "תה חליטת חורף": ללקוח יש גם
  // "תה ירוק לימונית", ו"לימונית" היא מה שמבדיל. "חלב גד" אינו פוסל את
  // "גבינת עיזים של גד" — הוא חולק עם השורה רק את "גד".
  // מתחרה הוא רק מוצר שהלקוח עדיין קונה. נמדד: "כפיות קשיח בז' 50 יח'" נחסם
  // בגלל מוצר שנקנה פעם אחת לפני 51 חודשים, מול 379 קניות של המוביל.
  const stillBought = (product) => {
    if (!usage) return true;
    const entry = usage(product);
    return Boolean(entry) && (entry.lines >= 3 || monthsSince(entry.lastAt, Date.now()) <= 12);
  };
  const leaderIds = new Set(leaders.map((entry) => String(entry.product._id)));
  const rivals = products
    .filter((product) => !leaderIds.has(String(product._id)) && stillBought(product))
    .map((product) => canonicalWords(titleTextOf(product)));
  const distinguishing = leaders.some((leader) =>
    leader.missing.some((word) =>
      rivals.some(
        (title) =>
          title.some((inTitle) => looseSame(word, inTitle, vocabulary)) &&
          asked.some(
            (other) =>
              other !== word && title.some((inTitle) => sameWord(other, inTitle, vocabulary))
          )
      )
    )
  );
  if (distinguishing) return [];

  return leaders.map(({ product }) => ({ product }));
};

// מילים שאינן שם של מוצר ואינן יכולות לבדן לקשור שורה למוצר: צבע, גודל,
// "ללא", "סוג". נמדד בניחוש (11/10/26): "פלפלים אדומים" → נס קפה **אדום**,
// "חומוס גדול" → ביסלי **גדול**, "סויה ללא סוכר" → מסטיק **ללא סוכר**.
const FILLER_WORDS = new Set([
  "ללא", "סוג", "סוגים", "מכל", "כל", "של", "עם", "או", "בלי", "רק", "בלבד", "שונים", "מגוון",
  "טעמים", "בטעם", "סוכר", "קרטון", "קרטונים", "ארגז", "בקבוק", "קופסה", "שישיה", "שלישיה",
  "חד", "פעמי", "פעמיות", "פעמים", "טרי", "רגיל", "רגילה", "רגילים",
]);
const isNameWord = (word) => !FILLER_WORDS.has(word) && !isVariantWord(word) && !isSizeWord(word);

// צבע, גודל וטמפרטורה: כשבשורה כתוב אחד ובשם המוצר אחר, אלה שני מוצרים.
// "פלפלים **אדומים**" אינם "פלפל **שחור**", ו"כוסות שתיה **חמה**" אינן "**קרה**".
const CONTRAST_STEMS = [
  "גדול", "קטן", "קטנ", "בינונ", "ענק", "מיני",
  "אדום", "אדומ", "ירוק", "כחול", "צהוב", "לבן", "לבנ", "שחור", "כתום", "כתומ", "חום", "חומ",
  "ורוד", "סגול", "חמ", "קר",
];
const contrastOf = (words) =>
  words
    .map(openFinal)
    .filter((word) => CONTRAST_STEMS.some((stem) => word.startsWith(openFinal(stem)) && word.length <= stem.length + 3));

/**
 * ניחוש מתוך הרשימה של הלקוח: כמה חזק המוצר הזה עונה לשורה. 0 = לא ניחוש.
 *
 * נמדד על 171 ניחושים (11/10/26). מה שהפריד בין הנכונים לשגויים:
 *   • מספר בשורה שאינו בשם המוצר — כמות שלא נקראה או מידה אחרת.
 *   • צבע/גודל/טמפרטורה שונים בשורה ובמוצר.
 *   • שם מוצר אחד משותף מתוך שניים ("נייר **כסף**" מול "נייר **טואלט**",
 *     "קפסולות **למדיח**" מול "קפסולות **לקפה**") — מטבע. נדרשים שניים.
 *   • שורה של שם אחד ("שקדים") מול מוצר ששם העצם שלו אחר ("**חלב** שקדים").
 * מילה נדירה בקטלוג ("נוטלה", "ג'ייקובס", "ויטמינציק") היא שם של מוצר מסוים
 * ומספיקה לבדה.
 */
const guessStrength = (text, product, { vocabulary = null } = {}) => {
  const titleText = titleTextOf(product);
  const titleNumbers = new Set(numbersOf(titleText));
  if (!numbersOf(text).every((number) => titleNumbers.has(number))) return 0;

  const asked = productWordsOf(text);
  const title = canonicalWords(titleText);
  const askedContrast = contrastOf(asked);
  const titleContrast = contrastOf(title);
  const differs = (list, other) => list.some((word) => !other.some((o) => o.slice(0, 2) === word.slice(0, 2)));
  if (askedContrast.length && titleContrast.length && differs(askedContrast, titleContrast)) return 0;

  const names = asked.filter(isNameWord);
  if (!names.length) return 0;
  const has = (word) => title.some((inTitle) => sameWord(word, inTitle, vocabulary));
  const shared = names.filter(has);
  if (!shared.length) return 0;

  const rare = (word) => {
    const frequency = vocabulary ? vocabulary.get(word) || 0 : 0;
    return word.length >= 4 && frequency >= 1 && frequency <= RARE_WORD_MAX;
  };
  if (shared.some(rare)) return shared.length + 1;
  if (shared.length >= 2) return shared.length;

  // שם אחד בלבד בשורה: שם העצם של המוצר חייב להיות הוא
  const titleNames = productWordsOf(titleText).filter(isNameWord);
  if (names.length === 1 && titleNames.length && sameWord(names[0], titleNames[0], vocabulary)) return 1;
  return 0;
};

/**
 * האם שם של מוצר שהלקוח כתב נמצא בשם המוצר — בלי צבע, גודל ומילות מילוי.
 * ‏"קפה שחור" ו"קפה עלית מוסדי" חולקים את "קפה"; "שחור" לבדו ו"פלפל שחור"
 * אינם חולקים שם של מוצר.
 */
const sharesNameWord = (text, product, { vocabulary = null } = {}) => {
  const names = productWordsOf(text).filter(isNameWord);
  if (!names.length) return false;
  const title = canonicalWords(titleTextOf(product));
  return names.some((word) => title.some((inTitle) => sameWord(word, inTitle, vocabulary)));
};

/** כמה ממילות המוצר שבשורה נמצאות בשם המוצר. */
const sharedWordCount = (text, product, { vocabulary = null } = {}) => {
  const title = canonicalWords(titleTextOf(product));
  return productWordsOf(text).filter((word) =>
    title.some((inTitle) => sameWord(word, inTitle, vocabulary))
  ).length;
};

/** האם המוצר חולק עם השורה מילת מוצר אחת לפחות. */
const sharesProductWord = (text, product, { vocabulary = null } = {}) => {
  const asked = productWordsOf(text).filter((word) => !isSizeWord(word));
  // שורה בלי מילת מוצר אינה ראיה נגד אף מועמד
  if (!asked.length) return true;
  const title = canonicalWords(titleTextOf(product));
  return asked.some((word) =>
    title.some(
      (inTitle) => sameWord(word, inTitle, vocabulary) || looselyRelated(word, inTitle)
    )
  );
};

/**
 * הכרעה בין מועמדים לפי היסטוריית הרכישות של הלקוח.
 *
 * @param {Array<{product: Object, score?: number}>} candidates - בריכת המועמדים
 *        כפי שהיא נבנית ב-resolveItems: המוביל ואחריו החלופות.
 * @param {{byProduct: Map, bySku: Map}} profile - מ-buildPurchaseProfile
 * @param {Object} [options]
 * @param {number} [options.now=Date.now()] - מוזרק כדי שהבדיקות לא יהיו תלויות בשעון
 * @param {string} [options.requestText] - מה שהלקוח כתב. כשהוא נמסר, מועמד
 *        שנושא את כל מילות המוצר שבו גובר על מי שחולק איתו מילה אחת, והתוצאה
 *        נושאת `coversRequest` — ראה NON_PRODUCT_WORDS.
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
const pickFromHistory = (
  candidates = [],
  profile = null,
  { now = Date.now(), requestText = null, vocabulary = null, dominanceRatio = DOMINANCE_RATIO } = {}
) => {
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

  // ── מתי קנייה בודדת נחשבת "מה שהלקוח קונה" ──
  //
  // חלון העדכניות תלוי בשאלה אם יש מתחרה. מועמד יחיד מההיסטוריה = אין ראיה
  // שההעדפה השתנתה, ולכן מספיק שהקנייה אינה עתיקה. כמה מועמדים = הלקוח קונה
  // יותר מאחד, וחד-פעמיות חייבת להיות טרייה. ראה SINGLE_HIT_MAX_MONTHS.
  const tierOf = (ranked) => {
    const top = ranked[0];
    const runnerUp = ranked[1];
    const freshnessWindow = ranked.length === 1 ? SINGLE_HIT_MAX_MONTHS : FRESH_MONTHS;
    const topIsEstablished = top.lines >= REPEAT_LINES || top.monthsAgo <= freshnessWindow;
    const dominant = !runnerUp || top.weight >= runnerUp.weight * dominanceRatio;
    return topIsEstablished && dominant ? "decisive" : "hint";
  };

  const tier = tierOf(hits);
  const reason = describeEvidence(hits);
  const covering = requestText
    ? hits.filter((hit) => coversRequest(requestText, hit.product, { vocabulary }))
    : [];
  // ── המוביל חייב להיות אותו סוג מוצר ──
  //
  // הבריכה הרחבה מביאה גם מוצרים שחולקים עם השורה מידה או אריזה בלבד: בשורה
  // "סכינים חד פעמי 100 יח'" המוביל בהיסטוריה היה "תה ויסוצקי 1.5 גר 100 יח"
  // (696 קניות). מוצר כזה אינו ראיה למה שהלקוח ביקש, גם כשהוא שולט במספרים.
  // בלי טקסט אין מול מה לבדוק, והתשובה נשארת כפי שהייתה.
  const related = (hit) =>
    !requestText || sharesProductWord(requestText, hit.product, { vocabulary });

  // ── הכרעה בין מי שנושא את כל מה שהלקוח ביקש ──
  //
  // רק כשהדירוג הרגיל **לא** הכריע, כדי שמה שהתקבל עד היום ימשיך להתקבל
  // בדיוק כמו קודם. הבדיקה כאן יכולה רק להוסיף הכרעות, ורק על מוצר שכל
  // מילה שהלקוח כתב נמצאת בשמו.
  if (tier !== "decisive" && covering.length && tierOf(covering) === "decisive") {
    return {
      product: covering[0].product,
      tier: "decisive",
      evidence: hits,
      reason,
      coversRequest: true,
      related: true,
    };
  }

  return {
    product: hits[0].product,
    tier,
    evidence: hits,
    reason,
    coversRequest: covering.includes(hits[0]),
    related: related(hits[0]),
  };
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
  // ── שני הצדדים בצורה קנונית ──
  //
  // "חלב 3 אחוז" מול "חלב טרי 3%" אינו עמימות — זו אותה מילה בניסוח אחר,
  // ובלי הנרמול היא נראית כשורה שאינה מתארת מוצר. ראה utils/orderWording.
  // נמדד: 17 מתוך 18 ניסוחים חופשיים של מוצרים אמיתיים נכנסים, ו-0 מתוך 30
  // ביטויי שיחה.
  const words = canonicalWords(text);
  if (!words.length) return false;

  const title = new Set(
    [product?.title?.he, product?.title?.en]
      .filter(Boolean)
      .flatMap((value) => canonicalWords(value))
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
  coversRequest,
  sharesProductWord,
  sameName,
  assortedOf,
  isAssorted,
  closestOwnProducts,
  sharedWordCount,
  sharesNameWord,
  guessStrength,
  lookupProduct,
  // מיוצאים לבדיקות ולכיול הספים
  FRESH_MONTHS,
  SINGLE_HIT_MAX_MONTHS,
  REPEAT_LINES,
  DOMINANCE_RATIO,
  OWN_LIST_DOMINANCE_RATIO,
};

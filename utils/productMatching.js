// utils/productMatching.js
//
// מנוע התאמת טקסט חופשי למוצרים בקטלוג.
//
// המודול הזה חולץ מ-controller/productController.js (findProductByTranscript) כדי
// שיהיה מנוע התאמה *אחד* המשותף ל:
//   1. חיפוש קולי בחנות/בקופה  (GET /api/products/voice-search)
//   2. קליטת הזמנות מהמייל ומווצאפ (lib/order-ingestion)
//
// לוגיקת הדירוג זהה למה שהיה בחיפוש הקולי — לא שונתה התנהגות.

const Product = require("../models/Product");
const {
  parseText,
  generateHebrewVariations,
  createApostropheIgnoringRegex,
} = require("./voiceParser");

// ── גודל הבריכה לשלבי סינון פנימיים ──
//
// ‏alternativesCount היא רשימה **לתצוגה ולהכרעה חיצונית**, וקצרה בכוונה: היא
// נשמרת על ההזמנה ונשלחת ל-LLM, ואורך עולה שם כסף ורעש. ‏pool היא מה שמקבל מי
// שמסנן בעצמו — מזהי הגרסה, שובר השוויון של המק"ט, היסטוריית הרכישות, ורשימת
// "בחר מוצר" של העובד.
//
// למה זה נדרש: נמדד על "קלסר" מהזמנה אמיתית — 15 מוצרים בקטלוג, כולם בטווח
// 12023.6–12026.4, כלומר הפרש של 2.8 נקודות מתוך 12,026 (0.02%) שמקורו בקנס
// אורך שם. המוצר שהלקוח קונה בפועל דורג במקום 11, וחלון של 9 חתך אותו. זה
// אינו סינון אלא חיתוך שרירותי באמצע ערימה של מועמדים זהים כמעט לגמרי.
//
// ── למה הקבוע יושב **כאן** ──
//
// שלושה מסלולים נפרדים חייבים לראות את אותה בריכה: הצינור שמכריע, המדידה
// שמבטיחה מראש "כך יקרה", והרשימה שהעובד בוחר ממנה. ערך שכתוב שלוש פעמים
// נפרד ביום שבו מישהו משנה אחד מהם — והתוצאה היא בדיוק ההבטחה השבורה:
// התצוגה המקדימה מבטיחה מספר אחד, הקליטה עושה אחר.
//
// 19 ולא יותר: הבריכה חסומה ממילא ב-candidateLimit (20 מסמכים מה-DB), ולכן
// זהו בדיוק "כל מה שנשלף ודורג" בלי שאילתה נוספת.
const CANDIDATE_POOL_SIZE = 19;

// ── תקרת השליפה כשיש במה לאמת את התוצאה ──
//
// ‏candidateLimit ברירת המחדל הוא 20 **מסמכים מה-DB**, ובלי מיון. כלומר
// כשהשאילתה תואמת ליותר מ-20 מוצרים, אלה שנשלפים הם שרירותיים לחלוטין —
// החיתוך קורה **לפני** שיש ציונים בכלל. מדידה על הקטלוג (4,320 מוצרים):
//
//     "נייר"  156 מוצרים · "תה" 148 · "כוסות" 91 · "קפה" 75 · "שוקולד" 73
//
// ‏145 מילים שונות בקטלוג מחזירות מעל 20 מוצרים. בכל אחת מהן "המועמד המוביל"
// הוא המוביל מבין 20 אקראיים, ולא מבין כל מי שתואם.
//
// 300 מכסה כל מילה שהיא **שם מוצר** בקטלוג הזה. שש המילים שמעליה (קג,
// יחידות, ליטר, יח, גר, יחידה — עד 339) הן מילות מידה, ואינן מופיעות לבדן
// כשורת הזמנה.
//
// ── למה זה אינו ברירת המחדל ──
//
// המחיר הוא סריקת אוסף מלאה: השאילתה היא רגקסים על כותרת, שאף אינדקס אינו
// משרת, ולכן תקרה נמוכה מאפשרת ל-mongo לעצור מוקדם. 4,320 מסמכים קטנים הם
// עשרות מילישניות לשורה — זניח בעיבוד רקע, אבל לא משהו שמדליקים לכולם בלי
// סיבה.
//
// הסיבה שמצדיקה אותו היא **אימות**: כשללקוח יש היסטוריית רכישות, יש למערכת
// דרך עצמאית לוודא איזה מהמועמדים הוא הנכון. בלי היסטוריה, בריכה רחבה רק
// מחליפה ניחוש אחד באחר.
const HISTORY_CANDIDATE_LIMIT = 300;

// כמה מסמכים נשלפים כברירת מחדל. מוגדר כקבוע כדי שהשליפה הקלה (ראה
// matchProductByName) תדע מתי היא במצב "רחב" בלי מספר קסם שני.
const DEFAULT_CANDIDATE_LIMIT = 20;

// אורך מרבי של שם שנשלח לחיפוש. ראה הנימוק המלא ב-matchProductByName —
// בקצרה: בלי חסם, שורת פריט ארוכה במייל של לקוח מפילה את השרת ב-OOM.
const MAX_SEARCH_NAME_LENGTH = 200;

// נרמול כותרת/שאילתה להשוואה מילולית. זהה בכוונה ל-normalizeForComparison
// שבתוך rankProductsByRelevance, כדי ששתי ההשוואות יראו את אותו טקסט.
const normalizeTitleForMatch = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/['"''`ʼʻ״׳]/g, "")
    .replace(/[^֐-׿a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// פונקציה לדירוג תוצאות לפי קרבה לשאילתא המקורית
const rankProductsByRelevance = (products, originalQuery, queryWords, variations = []) => {
  const normalizeForComparison = (text) => {
    return text.toLowerCase()
      .replace(/['"''`ʼʻ]/g, '') // הסרת גרשים
      .replace(/[^\u0590-\u05ffa-z0-9\s]/g, ' ') // הסרת סימנים מיוחדים
      .replace(/\s+/g, ' ')
      .trim();
  };

  // פונקציה משופרת לבדיקה אם מילה מופיעה כמילה שלמה (תומכת בעברית)
  const isWholeWordMatch = (text, word) => {
    // פיצול הטקסט למילים ובדיקה אם המילה מופיעה כמילה נפרדת
    const words = text.split(/\s+/);
    return words.some(textWord => textWord === word);
  };

  return products.map(product => {
    // הגנה על מוצרים ללא title (קליטת ההזמנות אוטומטית — אסור שתקרוס על מוצר פגום)
    const heTitle = normalizeForComparison(product.title?.he || '');
    const enTitle = normalizeForComparison(product.title?.en || '');
    const normalizedQuery = normalizeForComparison(originalQuery);

    let score = 0;

    // 1. בדיקה אם יש התאמה מושלמת לאחת מה-variations (הציון הכי גבוה!)
    let foundPerfectVariationMatch = false;
    if (variations && variations.length > 0) {
      for (const variation of variations) {
        const normalizedVariation = normalizeForComparison(variation);
        if (heTitle === normalizedVariation || enTitle === normalizedVariation) {
          score += 15000; // ציון הכי גבוה - התאמה מושלמת לווריאציה
          foundPerfectVariationMatch = true;
          break;
        }
        // בדיקה אם הווריאציה מופיעה כמילה שלמה בתחילת השם
        else if (heTitle.startsWith(normalizedVariation + ' ') || enTitle.startsWith(normalizedVariation + ' ') ||
          heTitle.startsWith(normalizedVariation + '(') || enTitle.startsWith(normalizedVariation + '(')) {
          score += 12000; // ציון גבוה מאוד - ווריאציה בתחילת השם
          foundPerfectVariationMatch = true;
          break;
        }
      }
    }

    // 2. התאמה מדויקת של השאילתה המעובדת (אם לא מצאנו התאמה מושלמת לווריאציה)
    if (!foundPerfectVariationMatch) {
      if (heTitle === normalizedQuery || enTitle === normalizedQuery) {
        score += 10000; // ציון גבוה להתאמה מושלמת לשאילתה המעובדת
      }
      // 3. התאמה של המחרוזת השלמה כ-substring
      else if (heTitle.includes(normalizedQuery) || enTitle.includes(normalizedQuery)) {
        score += 5000; // ציון גבוה אבל פחות מהתאמה מושלמת

        // בונוס אם זה בתחילת השם
        if (heTitle.startsWith(normalizedQuery) || enTitle.startsWith(normalizedQuery)) {
          score += 2000;
        }
      }
    }

    // 4. בדיקת התאמה של מילים בודדות - מילה שלמה vs חלק ממילה
    let wordMatchScore = 0;
    let foundWholeWords = 0;
    let foundPartialWords = 0;

    // בדיקה גם מול הvariations
    const allWordsToCheck = [...queryWords];
    if (variations && variations.length > 0) {
      // נוסיף את כל הvariations כמילים לבדיקה
      variations.forEach(variation => {
        const variationWords = variation.trim().split(/\s+/).filter(word => word.length > 1);
        allWordsToCheck.push(...variationWords);
      });
    }

    // הסרת כפילויות
    const uniqueWordsToCheck = [...new Set(allWordsToCheck.map(w => normalizeForComparison(w)))];

    uniqueWordsToCheck.forEach(word => {
      // בדיקה להתאמה של מילה שלמה
      const heWholeMatch = isWholeWordMatch(heTitle, word);
      const enWholeMatch = isWholeWordMatch(enTitle, word);

      if (heWholeMatch || enWholeMatch) {
        foundWholeWords++;

        // ציון גבוה יותר אם המילה מופיעה בvariations המקוריות
        const isFromOriginalVariation = variations && variations.some(v =>
          normalizeForComparison(v).includes(word)
        );

        const baseScore = isFromOriginalVariation ? 4000 : 3000;
        wordMatchScore += baseScore; // ציון גבוה מאוד למילה שלמה

        // בונוס אם המילה השלמה בתחילת השם
        const titleToCheck = heWholeMatch ? heTitle : enTitle;
        if (titleToCheck.startsWith(word + ' ') || titleToCheck === word) {
          wordMatchScore += isFromOriginalVariation ? 1500 : 1000;
        }
      }
      // אם לא מצאנו התאמה שלמה, בדוק כ-substring
      else if (heTitle.includes(word) || enTitle.includes(word)) {
        foundPartialWords++;
        wordMatchScore += 500; // ציון נמוך יותר לחלק ממילה
      }
    });

    score += wordMatchScore;

    // 5. ציון לפי אחוז המילים שנמצאו (עדיפות למילים שלמות)
    const totalWords = uniqueWordsToCheck.length;
    if (totalWords > 0) {
      const wholeWordPercentage = (foundWholeWords / totalWords) * 100;
      const partialWordPercentage = (foundPartialWords / totalWords) * 100;

      score += wholeWordPercentage * 10; // משקל גבוה למילים שלמות
      score += partialWordPercentage * 2;  // משקל נמוך למילים חלקיות
    }

    // 6. בונוס קל לשמות קצרים יותר (רק אם יש התאמה טובה)
    //
    // ⚠ נוסה כאן קנס לפי **מילים** בכותרת שהלקוח לא כתב, במקום לפי מספר תווים.
    // הרעיון נכון בתיאוריה — "בייגלה שטוחים לפסח" מוסיף מזהה שלא נתבקש — אבל
    // המדידה על 146 שמות פריטים אמיתיים הפריכה אותו: 34 מהם שינו מוצר,
    // "נייר אפייה 50 יחידות" צנח מ-0.97 ל-0.53 ועבר לגרסת ה-(ח'),
    // "צלחות חד פעמיות שטוחות קטנות" עבר מ-"קטן" ל-"גדול", ו-"סויה ללא סוכר"
    // קיבל "סוכריות ללא סוכר" בביטחון 0.85. הכיוון הזה מגדיל ביטחון בתשובות
    // שגויות, ולכן נזנח. הכרעה בין מועמדים שקולים נעשית ב-ProductAlias.
    if (foundWholeWords > 0) {
      const titleLength = heTitle.length || enTitle.length;
      if (titleLength > 0) {
        score += Math.max(0, 30 - titleLength / 5); // בונוס גבוה יותר לשמות קצרים
      }
    }

    return { product, score };
  }).sort((a, b) => b.score - a.score);
};

// בניית תנאי ה-$or לחיפוש מוצר לפי שאילתה + ווריאציות צליליות/מורפולוגיות
const buildProductSearchConditions = (query, variations) => {
  const searchConditions = [];

  // חיפוש עבור השאילתה הבסיסית וכל הווריאציות הצליליות
  const allQueries = variations && variations.length > 0 ? variations : [query];

  allQueries.forEach(currentQuery => {
    // פיצול השאילתה למילים נפרדות
    const queryWords = currentQuery.trim().split(/\s+/).filter(word => word.length > 1);

    // חיפוש רגיל (מחרוזת שלמה) - עם התעלמות מגרשים
    const fullRegex = createApostropheIgnoringRegex(currentQuery);
    searchConditions.push(
      { 'title.he': fullRegex },
      { 'title.en': fullRegex },
      { slug: fullRegex },
      { sku: currentQuery },
      { barcode: currentQuery }
    );

    // חיפוש מתקדם - כל מילה בנפרד (טוב לטיפול בסוגריים ואותיות סופיות)
    if (queryWords.length > 0) {
      // יצירת רגקסים עם ווריאציות של כל מילה (אותיות סופיות + זכר/נקבה)
      const wordVariationsRegexes = queryWords.map(word => {
        const hebrewVariations = generateHebrewVariations(word);

        // יצירת regex שמחפש כל אחת מהווריאציות תוך התעלמות מגרשים
        const variationsWithoutApostrophes = hebrewVariations.map(v =>
          createApostropheIgnoringRegex(v).source
        );
        const variationsPattern = variationsWithoutApostrophes.join('|');
        return new RegExp(variationsPattern, 'i');
      });

      // תנאי שכל המילים (או הווריאציות שלהן) צריכות להופיע בכותרת העברית
      const heAllWordsCondition = {
        $and: wordVariationsRegexes.map(regex => ({ 'title.he': regex }))
      };

      // תנאי שכל המילים צריכות להופיע בכותרת האנגלית (עם התעלמות מגרשים)
      const enAllWordsCondition = {
        $and: queryWords.map(word => ({ 'title.en': createApostropheIgnoringRegex(word) }))
      };

      searchConditions.push(heAllWordsCondition, enAllWordsCondition);
    }
  });

  return searchConditions;
};

/**
 * המרת ציון הדירוג לרמת ביטחון 0..1.
 *
 * שני גורמים:
 *   1. עוצמת ההתאמה עצמה (הציון המוחלט).
 *   2. עמימות — כמה המוצר הבא בתור קרוב. שני מוצרים עם ציון כמעט זהה
 *      ("תמרים מג'הול" מול "תמרים מג'הול אורגני") אומרים שאין החלטה ברורה,
 *      ולכן הביטחון יורד גם אם הציון המוחלט גבוה.
 */
const scoreToConfidence = (topScore, runnerUpScore = 0, { exactTitleMatch = false } = {}) => {
  let confidence;
  if (topScore >= 12000) confidence = 0.97;
  else if (topScore >= 10000) confidence = 0.92;
  else if (topScore >= 7000) confidence = 0.85;
  else if (topScore >= 5000) confidence = 0.75;
  else if (topScore >= 3000) confidence = 0.6;
  else if (topScore >= 1000) confidence = 0.4;
  else confidence = 0.15;

  // ── מתי קנס העמימות אינו במקום ──
  //
  // הקנס מניח ששני ציונים קרובים = אין החלטה ברורה. ההנחה נשברת כשהמועמד
  // המוביל הוא **בדיוק** מה שהלקוח כתב, אות באות. בקטלוג כאן היו שתי רשומות
  // כמעט זהות — "נייר אפייה 50 יחידות" ו-"נייר אפייה 50 יחידות (ח')" —
  // בהפרש של 0.4 נקודות מתוך 14,381. הראשונה תואמת את בקשת הלקוח במדויק,
  // ובכל זאת הביטחון צנח מ-0.97 ל-0.53 וההזמנה עברה לטיפול ידני.
  //
  // התאמה מילולית מלאה היא אות חזק בהרבה מהפרש ציונים, ולכן היא גוברת עליו.
  if (runnerUpScore > 0 && topScore > 0 && !exactTitleMatch) {
    const ratio = runnerUpScore / topScore;
    if (ratio > 0.95) confidence *= 0.55;
    else if (ratio > 0.85) confidence *= 0.75;
    else if (ratio > 0.7) confidence *= 0.9;
  }

  return Math.round(confidence * 100) / 100;
};

/**
 * התאמת שם מוצר בטקסט חופשי למוצר בקטלוג.
 *
 * @param {string} rawName - שם המוצר כפי שהלקוח כתב אותו ("2 קילו מג'הול גדול")
 * @param {Object} [options]
 * @param {boolean} [options.includeStoreProducts=false] - לכלול מוצרי חנות פיזית
 * @param {boolean} [options.requireStock=true] - לדרוש מלאי > 0
 * @param {boolean} [options.requireShown=true] - לדרוש status:"show"
 *
 *        שני הדגלים האחרונים נכונים לחיפוש בקופה — אין טעם שקופאי ימצא מוצר
 *        שאזל או שאינו מפורסם. בקליטת הזמנות הם דווקא מזיקים: הם הופכים
 *        "המוצר קיים אבל מוסתר / אזל" ל-"לא נמצא מוצר בקטלוג", כלומר להודעת
 *        שגיאה שמפנה את העובד לחפש במקום הלא נכון. הקליטה מכבה אותם ומסננת
 *        בעצמה, כדי שתוכל להסביר בדיוק מה חסר.
 * @param {number}  [options.candidateLimit=20] - מקסימום מועמדים מה-DB
 * @param {number}  [options.alternativesCount=4] - כמה חלופות להחזיר לתיעוד/הכרעה
 * @param {number}  [options.poolCount=alternativesCount] - כמה מועמדים להחזיר
 *        ב-`pool`, לצרכנים שמסננים בעצמם (מזהי גרסה, היסטוריית רכישות).
 *        ראה ההסבר על `pool` בערך המוחזר.
 * @returns {Promise<null|{product: Object, score: number, confidence: number, quantityFromText: number, query: string, alternatives: Array}>}
 */
const matchProductByName = async (rawName, options = {}) => {
  const {
    includeStoreProducts = false,
    requireStock = true,
    requireShown = true,
    candidateLimit = DEFAULT_CANDIDATE_LIMIT,
    alternativesCount = 4,
    poolCount = alternativesCount,
  } = options;

  if (!rawName || typeof rawName !== "string" || !rawName.trim()) return null;

  // ── חסימת אורך הקלט ──
  //
  // כל מה שמתחת בונה רגקסים מהטקסט הזה: `createApostropheIgnoringRegex` מוסיפה
  // קבוצה **לכל תו**, וכל ווריאציה צליליות הופכת ל-5 תנאי חיפוש. העלות גדלה
  // מהר יותר מלינארית באורך, ובלי חסם היא מגיעה עד קריסת התהליך: נמדד ש-5,000
  // תווים מפילים את השרת ב-OOM, ו-1,000 תווים זורקים שגיאת Buffer מתוך הדרייבר.
  //
  // הנתיב פתוח לקלט לא מהימן: שורת פריט במייל של לקוח מגיעה לכאן כמו שהיא.
  // כלומר מייל אחד יכול להפיל את **כל השרת**, לא רק את קליטת ההזמנה.
  //
  // התקרה נמדדה: השם הארוך ביותר בקטלוג הוא 59 תווים, וכל שם פריט אמיתי
  // שנצפה בהזמנות קצר מ-200. מה שארוך מזה אינו שם מוצר אלא שורת נתונים
  // שנקראה בטעות, והחיתוך רק מגדיל את הסיכוי שהחלק המשמעותי שלה יימצא.
  const boundedName = rawName.length > MAX_SEARCH_NAME_LENGTH
    ? rawName.slice(0, MAX_SEARCH_NAME_LENGTH)
    : rawName;

  // parseText מוציא גם את הכמות מתוך הטקסט ("שתי שקיות תמרים" → quantity 2)
  const { query, quantity, variations } = parseText(boundedName);
  if (!query) return null;

  const searchConditions = buildProductSearchConditions(query, variations);

  // ── תנאי נוסף על הטקסט המקורי, כולל ספרות ──
  //
  // parseText מסיר ספרות מהשאילתה כי בחיפוש קולי ספרה היא כמות. אבל בשם מוצר
  // הספרה היא לרוב המזהה: "קפה עלית 100 גרם" מול "200 גרם", "50 יחידות" מול
  // "100 יחידות". בלי התנאי הזה השאילתה מאבדת בדיוק את מה שמבדיל ביניהם,
  // ומוצר שכתוב בשמו במדויק לא נמצא בכלל.
  // ‏boundedName ולא rawName: גם כאן נבנים רגקסים מהטקסט, ולכן הוא חייב להיות
  // חסום מאותה סיבה בדיוק. הניסוח הראשון של החסימה פספס את השורה הזו, כך
  // שהחסם הוחל על parseText בלבד והנתיב הזה נשאר פתוח לרוחב.
  const originalTrimmed = boundedName.trim();
  if (/\d/.test(originalTrimmed)) {
    searchConditions.push(
      { "title.he": createApostropheIgnoringRegex(originalTrimmed) },
      { "title.en": createApostropheIgnoringRegex(originalTrimmed) }
    );

    // גם כל מילה בנפרד מהטקסט המקורי — שומר על הספרות ועל סדר חופשי
    const originalWords = originalTrimmed
      .replace(/[()[\]{}]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1);

    if (originalWords.length > 1) {
      searchConditions.push({
        $and: originalWords.map((w) => ({
          "title.he": createApostropheIgnoringRegex(w),
        })),
      });
    }
  }

  const baseFilter = {
    ...(requireShown ? { status: "show" } : {}),
    ...(requireStock ? { stock: { $gt: 0 } } : {}),
    ...(includeStoreProducts ? {} : { isStoreProduct: { $ne: true } }),
  };

  // ── שליפה רחבה מושכת מסמכים קלים בלבד ──
  //
  // המסמך המלא נדרש **רק למועמד המוביל**: כל השאר עוברים דרך `thin()` ומאבדים
  // ממילא את כל השדות מלבד מזהה, כותרת ומק"ט. שליפה רחבה בלי projection הייתה
  // מושכת מאות מסמכים שלמים — עם description, image, variants ו-erp — כדי
  // להשתמש באחד מהם. הפרויקציה מכסה את מה שהדירוג, ה-baseFilter והשוואת
  // השמות צריכים, והמוביל נשלף מחדש במלואו אחריה.
  //
  // ‏prices **אינו** בפרויקציה במכוון: הקוד שמעלינו מזהה מסמך רזה בדיוק לפי
  // `product.prices === undefined` (ראה resolvers), ומסמך חלקי שנראה מלא היה
  // מגיע לעגלה בלי תמונה, slug ומחירים — כשל שקט לגמרי.
  const lightFetch = candidateLimit > DEFAULT_CANDIDATE_LIMIT;
  const LIGHT_SELECT = "_id sku title status stock isStoreProduct";

  const search = (conditions, limit) => {
    const query = Product.find({ ...baseFilter, $or: conditions }).lean().limit(limit);
    return lightFetch ? query.select(LIGHT_SELECT) : query;
  };

  let products = await search(searchConditions, candidateLimit);

  // ── נפילה: חיפוש מקל כשהחיפוש המדויק לא החזיר כלום ──
  //
  // כל התנאים למעלה דורשים ש**כל** מילות השאילתה יופיעו בכותרת. זה נכון
  // כשהלקוח מעתיק שם מהקטלוג, ושגוי כשהוא מתאר מוצר במילים שלו — וזה הרוב.
  // בהזמנה אמיתית שנבדקה כאן:
  //
  //     "ביצים 30 יח' XL"              בקטלוג: "ביצים 30 יח"        (עודף: XL)
  //     "פתי בר בסקוויט \"עלית\" 1,750 ק\"ג"  בקטלוג: "פתי בר עלית 1.750 ק\"ג"  (עודף: בסקוויט)
  //     "קפה שחור קלוי וטחון 1 ק\"ג"    בקטלוג: "קפה שחור לנדוור 1 קילו"  (עודף: קלוי וטחון)
  //
  // בכל אחד מהם המוצר קיים בקטלוג, ובכל אחד מהם מילה מיותרת אחת החזירה **אפס**
  // מועמדים — והעובד קיבל "לא נמצא מוצר מתאים בקטלוג", כלומר הודעה ששולחת
  // אותו לחפש מוצר שכבר קיים.
  //
  // ההקלה מדורגת, כדי לוותר על הדיוק רק כמה שצריך:
  //   שלב 1 — כל המילים חוץ מאחת (מכסה את המקרה הנפוץ: מילה מתארת אחת עודפת)
  //   שלב 2 — כל מילה בנפרד, ודירוג בזיכרון יקבע
  //
  // ההקלה אינה מסכנת נכונות: היא רק מרחיבה את רשימת המועמדים, והדירוג וסף
  // הביטחון ממשיכים להחליט כרגיל. מוצר שנמצא בביטחון נמוך עובר לאדם — אבל
  // עכשיו עם הצעה קונקרטית במקום "לא נמצא".
  if (!products.length) {
    const words = String(query).trim().split(/\s+/).filter((w) => w.length > 1);

    // מספיק גדול כדי שהדירוג בזיכרון יראה את המועמד הנכון, ולא רק 20 שרירותיים
    const RELAXED_LIMIT = Math.max(candidateLimit, 200);

    if (words.length > 2) {
      const dropOne = words.map((_, skip) => ({
        $and: words
          .filter((__, i) => i !== skip)
          .map((w) => ({ "title.he": createApostropheIgnoringRegex(w) })),
      }));
      products = await search(dropOne, RELAXED_LIMIT);
    }

    if (!products.length && words.length > 1) {
      products = await search(
        words.map((w) => ({ "title.he": createApostropheIgnoringRegex(w) })),
        RELAXED_LIMIT
      );
    }
  }

  if (!products || products.length === 0) return null;

  const queryWords = query.trim().split(/\s+/).filter((w) => w.length > 1);
  const ranked = rankProductsByRelevance(products, query, queryWords, variations);

  const best = ranked[0];
  const runnerUp = ranked[1];

  // האם המוביל הוא בדיוק מה שנכתב, אות באות (ראה scoreToConfidence).
  // ההשוואה מול הטקסט המקורי ולא מול `query`, כי `parseText` מסיר ממנו ספרות
  // ואת הספרות האלה בדיוק אנחנו רוצים לאמת.
  //
  // התנאי השני קריטי: אם גם המועמד השני זהה מילולית, הקטלוג מכיל שתי רשומות
  // באותו שם — וזו עמימות אמיתית שאסור לוותר על הקנס בגללה.
  const wantedTitle = normalizeTitleForMatch(rawName);
  const isExactTitle = (p) =>
    Boolean(wantedTitle) &&
    [normalizeTitleForMatch(p?.title?.he), normalizeTitleForMatch(p?.title?.en)].includes(
      wantedTitle
    );
  const exactTitleMatch =
    isExactTitle(best.product) && !(runnerUp && isExactTitle(runnerUp.product));


  const thin = (r) => ({
    _id: r.product._id,
    title: r.product.title,
    sku: r.product.sku,
    score: r.score,
  });

  // מיפוי אחד לשתי הרשימות: ‏alternatives הוא תמיד רישא של pool, ולכן אין
  // טעם לבנות את אותם אובייקטים פעמיים
  const rest = ranked
    .slice(1, 1 + Math.max(alternativesCount, poolCount))
    .map(thin);

  // ── המוביל חוזר לצורתו המלאה ──
  //
  // בשליפה רחבה הוא הגיע מפורייקטד, ומכאן הוא ממשיך לבדיקת הזמינות, לתמחור
  // ולבניית שורת העגלה — שכולן קוראות שדות שאינם בפרויקציה.
  //
  // ‏null פירושו שהמוצר נמחק בין שתי השאילתות. מחזירים "לא נמצא" ולא מסמך
  // חלקי: הראשון הוא מצב שהקורא כבר יודע לטפל בו, השני נכנס להזמנה שבורה.
  let leader = best.product;
  if (lightFetch) {
    leader = await Product.findById(best.product._id).lean();
    if (!leader) return null;
  }

  return {
    product: leader,
    score: best.score,
    confidence: scoreToConfidence(best.score, runnerUp?.score || 0, { exactTitleMatch }),
    quantityFromText: quantity,
    query,
    alternatives: rest.slice(0, alternativesCount),

    // ── pool: כל מה שדורג, ולא רק החלופות המוצגות ──
    //
    // ‏alternatives הן רשימה **לתצוגה ולהכרעה חיצונית** ולכן היא קצרה בכוונה:
    // היא נשמרת על ההזמנה ונשלחת ל-LLM, ואורך עולה שם כסף ורעש.
    //
    // אבל שלבים שמסננים בעצמם (מזהי גרסה, היסטוריית רכישות) צריכים את הבריכה
    // המלאה, כי החיתוך הקצר הוא **שרירותי ולא משמעותי**. נמדד על "קלסר": 15
    // מוצרים בקטלוג, כולם בטווח 12023.6–12026.4 — הפרש של 2.8 נקודות מתוך
    // 12,026, כלומר 0.02%. חלון של 9 חתך שישה מהם, וביניהם דווקא זה שהלקוח
    // קונה. הפרש כזה הוא רעש של קנס אורך, ואינו מפריד בין מוצר נכון ללא נכון.
    //
    // הבריכה חסומה ממילא ב-candidateLimit — היא לא יכולה לגדול מעבר למה
    // שנשלף מה-DB, ולכן אין כאן עלות שאילתה נוספת.
    pool: rest.slice(0, poolCount),
  };
};

module.exports = {
  // המקור היחיד לגדלים. כל מי שמסנן בעצמו מייבא אותם מכאן ואינו כותב מספר
  // משלו — ראה ההסבר למעלה.
  CANDIDATE_POOL_SIZE,
  HISTORY_CANDIDATE_LIMIT,
  // מיוצא כדי ש-utils/productAliases ינרמל בדיוק כמו מנוע ההתאמה. שני נרמולים
  // שונים היו גורמים לאליאס שנשמר לא להימצא לעולם — ראה שם.
  normalizeTitleForMatch,
  rankProductsByRelevance,
  buildProductSearchConditions,
  scoreToConfidence,
  matchProductByName,
};

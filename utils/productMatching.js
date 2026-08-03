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
 * @returns {Promise<null|{product: Object, score: number, confidence: number, quantityFromText: number, query: string, alternatives: Array}>}
 */
const matchProductByName = async (rawName, options = {}) => {
  const {
    includeStoreProducts = false,
    requireStock = true,
    requireShown = true,
    candidateLimit = 20,
    alternativesCount = 4,
  } = options;

  if (!rawName || typeof rawName !== "string" || !rawName.trim()) return null;

  // parseText מוציא גם את הכמות מתוך הטקסט ("שתי שקיות תמרים" → quantity 2)
  const { query, quantity, variations } = parseText(rawName);
  if (!query) return null;

  const searchConditions = buildProductSearchConditions(query, variations);

  // ── תנאי נוסף על הטקסט המקורי, כולל ספרות ──
  //
  // parseText מסיר ספרות מהשאילתה כי בחיפוש קולי ספרה היא כמות. אבל בשם מוצר
  // הספרה היא לרוב המזהה: "קפה עלית 100 גרם" מול "200 גרם", "50 יחידות" מול
  // "100 יחידות". בלי התנאי הזה השאילתה מאבדת בדיוק את מה שמבדיל ביניהם,
  // ומוצר שכתוב בשמו במדויק לא נמצא בכלל.
  const originalTrimmed = String(rawName).trim();
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

  const search = (conditions, limit) =>
    Product.find({ ...baseFilter, $or: conditions }).lean().limit(limit);

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

  return {
    product: best.product,
    score: best.score,
    confidence: scoreToConfidence(best.score, runnerUp?.score || 0, { exactTitleMatch }),
    quantityFromText: quantity,
    query,
    alternatives: ranked.slice(1, 1 + alternativesCount).map((r) => ({
      _id: r.product._id,
      title: r.product.title,
      sku: r.product.sku,
      score: r.score,
    })),
  };
};

module.exports = {
  rankProductsByRelevance,
  buildProductSearchConditions,
  scoreToConfidence,
  matchProductByName,
};

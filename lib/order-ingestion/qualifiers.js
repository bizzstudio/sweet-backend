// lib/order-ingestion/qualifiers.js
//
// חילוץ "מזהי גרסה" משם מוצר שלקוח כתב, והפעלתם על מועמדים מהקטלוג.
//
// למה זה נדרש: מנוע ההתאמה הקיים (voiceParser) מסיר ספרות מהשאילתה, כי הוא נבנה
// לחיפוש קולי שבו ספרה היא כמות. אבל בהזמנה עסקית הספרות הן לרוב *מזהה המוצר*:
//
//     "קפה טורקי עלית 200 גרם (אדום)"  →  query: "קפה טורק עלית גרם אדום"
//     "קפה טורקי עלית 100 גרם עם הל"   →  query: "קפה טורק עלית גרם עם הל"
//
// שני המוצרים האלה נבדלים בקטלוג *רק* במשקל — ובלי הטיפול כאן הם נראים למנוע
// זהים, והוא בוחר ביניהם באקראי. אותו דבר לגבי "50 יחידות" מול "100 יחידות".
//
// שלושה סוגי מזהים, וכל אחד מופעל אחרת:
//
//   שלילה   — "(לא תה ירוק)"   → פסילה מוחלטת. הלקוח אמר במפורש מה לא רוצה.
//   מידה    — "200 גרם"        → סינון חזק. משקל שונה = מוצר שונה.
//   גרסה    — "(אדום)"         → תוספת ניקוד. רמז, לא חוק.

// ── יחידות מידה ומקדמי נרמול לבסיס משותף ──
// המרה לבסיס אחד מאפשרת להשוות "1 ק\"ג" מול "1000 גרם".
const UNIT_GROUPS = [
  {
    base: "gram",
    units: [
      { names: ["ק\"ג", "קג", "קילו", "קילוגרם", "kg"], factor: 1000 },
      { names: ["גרם", "גר'", "גר", "ג'", "g", "gr"], factor: 1 },
    ],
  },
  {
    base: "ml",
    units: [
      { names: ["ליטר", "ל'", "l", "liter", "litre"], factor: 1000 },
      { names: ["מ\"ל", "מל", "ml"], factor: 1 },
    ],
  },
  {
    base: "count",
    units: [
      { names: ["יחידות", "יחידה", "יח'", "יח", "units", "unit", "pcs"], factor: 1 },
    ],
  },
  // אחוז אינו יחידת מידה אלא מזהה גרסה — אבל הוא מתנהג בדיוק כמוה: "חלב עמיד
  // 3%" ו-"חלב עמיד 1%" הם שני מוצרים שונים שנבדלים *רק* בו. בלי זה שניהם
  // מקבלים ציון זהה לחלוטין, ההזמנה נתקעת ב"אי אפשר להכריע", והמערכת שולחת
  // עובד להכריע בין שני מוצרים שהלקוח כבר הבדיל ביניהם במפורש.
  {
    base: "percent",
    units: [{ names: ["%", "אחוז"], factor: 1 }],
  },
];

// מפה שטוחה: שם היחידה → { base, factor }
const UNIT_LOOKUP = new Map();
UNIT_GROUPS.forEach((group) => {
  group.units.forEach((unit) => {
    unit.names.forEach((name) => {
      UNIT_LOOKUP.set(name.toLowerCase(), { base: group.base, factor: unit.factor });
    });
  });
});

// מילות גרסה נפוצות בהזמנות: צבעי אריזה, סוג קלייה, מאפיינים.
// צבע אריזה הוא הדרך שבה לקוחות עסקיים מזהים גרסאות ("עלית אדום" מול "ירוק").
//
// מילות הגודל (גדול/קטן/בינוני/ענק) **אינן** כאן: הן חזקות מדי בשביל תוספת
// ניקוד. ראה SIZE_WORD_FORMS.
const VARIANT_WORDS = [
  "אדום", "ירוק", "כחול", "תכלת", "צהוב", "לבן", "שחור", "כתום", "חום", "ורוד", "סגול",
  "כהה", "בהיר",
  "אורגני", "טבעוני", "ללא גלוטן", "ללא סוכר", "דיאט", "לייט", "מלוח", "מתוק",
  "קלוי", "טבעי", "טרי", "קפוא", "מיובש",
];

// ── מילות גודל: מידה שאין לה מספר ──
//
// בעיני הלקוח "גדולות" היא מידה לכל דבר, בדיוק כמו "500 גרם". לכן הן מטופלות
// כמו מידה ולא כמו גוון: כשהלקוח ביקש גודל שאין לו מוצר, ההזמנה עוצרת לאדם.
//
// שני כשלים אמיתיים הובילו לכאן. הראשון: "נשיקות צבעוניות **גדולות** קופסה"
// הותאם ל-"נשיקות צבעוניות **קטנות** קופסה פלסטיק" בביטחון 0.97 — הלקוח ביקש
// גדולות וקיבל קטנות, בלי שום סימן. השני: הרשימה הכילה רק צורת יחיד-זכר
// ("גדול"), ולכן "גדולה", "גדולים" ו-"גדולות" לא זוהו בכלל — כלומר גם המנגנון
// החלש שכן היה קיים לא פעל על רוב הניסוחים.
//
// כל צורה נכתבת במפורש ולא כגזע: חיתוך ל-"גדול" היה תופס גם "גדולים" שבתוך שם
// מוצר אחר, ובעברית אין נטיית ריבוי אחידה שאפשר לחתוך לפיה בבטחה.
const SIZE_WORD_FORMS = {
  גדול: ["גדול", "גדולה", "גדולים", "גדולות"],
  קטן: ["קטן", "קטנה", "קטנים", "קטנות"],
  בינוני: ["בינוני", "בינונית", "בינוניים", "בינוניות"],
  ענק: ["ענק", "ענקי", "ענקית", "ענקיים", "ענקיות"],
  מיני: ["מיני"],
};

const SIZE_WORD_BASES = Object.keys(SIZE_WORD_FORMS);

// ── מפרט שהלקוח לא ביקש ──
//
// כל הסינונים שבמודול הזה שואלים "האם המועמד סותר את מה שהלקוח ביקש". השאלה
// ההפוכה חסרה, והיא זו שחוסמת בפועל: **האם המועמד מוסיף מפרט שהלקוח לא ביקש.**
//
// המקרה שהוביל לזה — הלקוחה כתבה "קולה זירו", ובקטלוג יש שישה:
//
//     פחיות קולה זירו              ← "פחיות": אריזה שלא ביקשו
//     פחיות קולה זירו 24 יח        ← אריזה + מניין
//     קוקה קולה זירו 1 ליטר        ← נקי
//     קוקה קולה זירו לימון 1.5     ← "לימון": טעם שלא ביקשו
//     בקבוקי קולה זירו זכוכית      ← אריזה
//     בקבוקי קולה זירו 1/2 ל' 24   ← אריזה + מניין
//
// הציונים נבדלו בנקודה אחת מתוך 13,313, המערכת דיווחה "אי אפשר להכריע",
// ושלוש הזמנות נעצרו. אבל **אפשר** להכריע: מי שרוצה פחיות כותב "פחיות".
// לקוח שכתב את שם המוצר בלבד ביקש את המוצר בצורתו הבסיסית, ומועמד שנושא
// צורת אריזה או טעם שלא נאמרו הוא מוצר אחר — לא ניסוח אחר של אותו מוצר.
//
// ── למה אוצר מילים סגור ולא "הכי מעט מילים עודפות" ──
//
// ספירת מילים עודפות נותנת כאן את התשובה ההפוכה: ל-"פחיות קולה זירו" יש מילה
// עודפת אחת ול-"קוקה קולה זירו 1 ליטר" שלוש. ההבדל אינו בכמות אלא בסוג —
// "קוקה" הוא שם המותג ו-"1 ליטר" היא המידה הבסיסית, ואילו "פחיות" היא בחירה.
// לכן הרשימות כאן מונות סוגי מפרט, ואינן היוריסטיקה על אורך.
const PACKAGING_WORDS = [
  "פחית", "פחיות", "בקבוק", "בקבוקי", "בקבוקים", "קרטון", "קרטונים",
  "מארז", "מארזים", "שישייה", "שישיה", "שלישייה", "שלישיה", "זוגות", "זוג",
  "שקית", "שקיות", "קופסה", "קופסא", "קופסאות", "צנצנת", "צנצנות",
  "גליל", "גלילים", "מגש", "מגשים", "חבילה", "חבילות", "דלי", "דליים",
  "זכוכית", "פלסטיק", "ואקום", "תפזורת",
];

// טעמים וגרסאות שהם בחירה מפורשת של הלקוח. הרשימה אינה מתיימרת לכסות הכול —
// מה שאינו בה פשוט לא מסונן, וזה הכיוון הבטוח.
const FLAVOR_WORDS = [
  "לימון", "תות", "וניל", "שוקולד", "בננה", "תפוח", "אפרסק", "מנגו", "פטל",
  "אוכמניות", "דובדבן", "קרמל", "הל", "נענע", "לימונענע", "רימון", "ענבים",
  "תפוז", "אשכולית", "קוקוס", "פיסטוק", "אגוזים", "דבש", "סלרי", "שום",
];


// ── גבול מילה שעובד בעברית ──
//
// מלכודת: `\b` ב-JavaScript מוגדר מול `\w`, שהוא ASCII בלבד. אחרי אות עברית
// אין "תו מילה" ולכן `/גרם\b/` **לעולם לא מתאים**. שימוש ב-\b כאן היה גורם
// לחילוץ המידות להחזיר רשימה ריקה תמיד — כלומר לבאג של 200 גרם מול 100 גרם
// להישאר בלי שאף בדיקה תצעק.
// הפתרון: lookahead/lookbehind שמכסה גם את טווח העברית.
const HEB_BOUNDARY_AFTER = "(?![\\u0590-\\u05FF\\w])";
const HEB_BOUNDARY_BEFORE = "(?<![\\u0590-\\u05FF\\w])";

// מניין באריזה: "24 יח", "10 יחידות", "מארז 6".
// לא כל מספר — רק מספר שצמוד למילת יחידות, כדי ש-"1 ליטר" לא ייתפס.
const PACK_COUNT_RE = new RegExp(
  `${HEB_BOUNDARY_BEFORE}\\d{1,4}\\s*(?:יח['׳]?|יחידות|יחי['׳]?)${HEB_BOUNDARY_AFTER}`
);

/**
 * אילו סוגי מפרט מופיעים בטקסט: אריזה, טעם, מניין באריזה.
 * @returns {{packaging: string[], flavor: string[], packCount: boolean}}
 */
const findSpecs = (text) => {
  const normalized = normalizeForCompare(text);
  return {
    packaging: PACKAGING_WORDS.filter((w) => wordAppears(normalized, w)),
    flavor: FLAVOR_WORDS.filter((w) => wordAppears(normalized, w)),
    packCount: PACK_COUNT_RE.test(normalized),
  };
};

const stripPunctuation = (text) =>
  String(text || "")
    .replace(/[.,;:!?]+$/g, "")
    .trim();

const normalizeForCompare = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/["'`״׳''""]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * האם המילה מופיעה בטקסט כמילה שלמה.
 *
 * הגבול הוא "תו שאינו אות" ולא רווח: בכותרות בקטלוג המילה נצמדת לסוגריים
 * ולפסיקים ("קופסה קטנה(ח')"), ובדיקה מול רווח בלבד הייתה מפספסת אותן.
 */
const wordAppears = (normalizedText, word) =>
  new RegExp(`${HEB_BOUNDARY_BEFORE}${normalizeForCompare(word)}${HEB_BOUNDARY_AFTER}`).test(
    normalizedText
  );

/**
 * מילות הגודל שמופיעות בטקסט, לפי צורת הבסיס שלהן.
 * @returns {Array<{base: string, raw: string}>}
 */
const findSizeWords = (text) => {
  const normalized = normalizeForCompare(text);
  const found = [];
  SIZE_WORD_BASES.forEach((base) => {
    const hit = SIZE_WORD_FORMS[base].find((form) => wordAppears(normalized, form));
    if (hit) found.push({ base, raw: hit });
  });
  return found;
};

/**
 * חילוץ המזהים משם המוצר כפי שהלקוח כתב אותו.
 *
 * @param {string} rawName
 * @returns {{cleanName: string, sizes: Array, variants: Array, negations: Array, instruction: string|null}}
 */
const extractQualifiers = (rawName) => {
  let text = String(rawName || "").trim();

  const negations = [];
  const variants = [];
  const sizes = [];
  let instruction = null;

  // ── 1. הוראה מותנית ──
  // "חלב סויה עם סוכר מופחת (ירוק כהה). אם אין אז תכלת"
  // ההוראה נשמרת להערה למלקט; היא אינה חלק משם המוצר לחיפוש.
  const conditionalMatch = text.match(/(?:^|[.,])\s*(אם\s+אין[^.]*|במידה\s+ואין[^.]*|אחרת[^.]*)/);
  if (conditionalMatch) {
    instruction = stripPunctuation(conditionalMatch[1]);
    text = text.replace(conditionalMatch[0], " ");
  }

  // ── 2. תוכן בסוגריים ──
  // "(לא תה ירוק)" = שלילה. "(אדום)" / "(בריסטה)" = גרסה.
  text = text.replace(/\(([^)]*)\)/g, (_, inner) => {
    const content = stripPunctuation(inner);
    if (!content) return " ";

    const negationMatch = content.match(/^(?:לא|בלי|ללא)\s+(.+)$/);
    if (negationMatch) {
      // "ללא סוכר" הוא מאפיין מוצר לגיטימי ולא שלילה של מועמד —
      // רק "לא X" מתפרש כפסילה.
      const isProductAttribute = /^(?:בלי|ללא)\s/.test(content);
      if (isProductAttribute) {
        variants.push(content);
      } else {
        negations.push(stripPunctuation(negationMatch[1]));
      }
      return " ";
    }

    // גרסה — נשמרת גם כמזהה וגם בטקסט לחיפוש (השם בקטלוג עשוי לכלול אותה)
    variants.push(content);
    return ` ${content} `;
  });

  // ── 3. שלילה מחוץ לסוגריים ──
  const bareNegation = text.match(
    new RegExp(`${HEB_BOUNDARY_BEFORE}לא\\s+([\\u0590-\\u05FF\\w'"]+(?:\\s+[\\u0590-\\u05FF\\w'"]+)?)`)
  );
  if (bareNegation) {
    negations.push(stripPunctuation(bareNegation[1]));
    text = text.replace(bareNegation[0], " ");
  }

  // ── 4. מידות: מספר + יחידה ──
  // נסרק לפני שהמספרים מגיעים ל-parseText, שהיה קורא אותם ככמות.
  // "%" חייב להופיע בראש האלטרנציה ולא בסופה: מנוע ה-regex בוחר את החלופה
  // הראשונה שמתאימה, ואם יחידה עברית קודמת לו הוא לעולם לא ייבדק בטקסט שבו
  // שתיהן אפשריות.
  const sizePattern = new RegExp(
    `(\\d+(?:[.,]\\d+)?)\\s*(%|ק"ג|קג|קילוגרם|קילו|kg|גרם|גר'|גר|ג'|gr|g|ליטר|ל'|liter|litre|l|מ"ל|מל|ml|יחידות|יחידה|יח'|יח|units|unit|pcs|אחוז)${HEB_BOUNDARY_AFTER}`,
    "gi"
  );
  let sizeMatch;
  while ((sizeMatch = sizePattern.exec(text)) !== null) {
    const value = Number(String(sizeMatch[1]).replace(",", "."));
    const unitRaw = sizeMatch[2];
    const unitInfo = UNIT_LOOKUP.get(unitRaw.toLowerCase());
    if (unitInfo && Number.isFinite(value)) {
      sizes.push({
        value,
        unit: unitRaw,
        base: unitInfo.base,
        normalized: value * unitInfo.factor,
        raw: sizeMatch[0],
      });
    }
  }

  // ── 5. מילות גרסה בטקסט חופשי (בלי סוגריים) ──
  const normalizedText = normalizeForCompare(text);
  VARIANT_WORDS.forEach((word) => {
    const normalizedWord = normalizeForCompare(word);
    // גבול מילה כדי ש"אדום" לא ייתפס בתוך "אדומדם"
    const pattern = new RegExp(`(?:^|\\s)${normalizedWord}(?:$|\\s)`);
    if (pattern.test(normalizedText) && !variants.some((v) => normalizeForCompare(v) === normalizedWord)) {
      variants.push(word);
    }
  });

  return {
    cleanName: text.replace(/\s+/g, " ").trim(),
    sizes,
    // מילות הגודל נשארות ב-cleanName בכוונה: הן חלק מהשם שהלקוח כתב, והן
    // מסייעות לדירוג כשהן כן קיימות בקטלוג. הן מטופלות בנוסף, לא במקום.
    sizeWords: findSizeWords(text),
    variants: [...new Set(variants)],
    negations: [...new Set(negations)],
    instruction,
  };
};

/**
 * חילוץ המידות שמופיעות בשם מוצר מהקטלוג, לצורך השוואה.
 * מקבל את הכותרת (he/en) ומחזיר רשימת מידות מנורמלות.
 */
const extractSizesFromTitle = (title) => {
  const text = `${title?.he || ""} ${title?.en || ""}`;
  const { sizes } = extractQualifiers(text);
  return sizes;
};

/**
 * הפעלת המזהים על רשימת מועמדים מהקטלוג.
 *
 * @param {Array} candidates - [{ product, score }] או [{ _id, title, ... }]
 * @param {Object} qualifiers - הפלט של extractQualifiers
 * @returns {{kept: Array, rejected: Array, appliedFilters: Array, sizeMismatch: boolean, sizeMismatchLabel: string|null}}
 */
const applyQualifiers = (candidates, qualifiers) => {
  const appliedFilters = [];
  const rejected = [];
  // הלקוח ציין מידה או גודל, ולאף מועמד אין אותם. ראה ההסבר ליד ההשמה.
  let sizeMismatch = false;
  // מה בדיוק התבקש ולא נמצא — כדי שהודעת הכשל תגיד לעובד למה נעצרנו
  let sizeMismatchLabel = null;

  const titleOf = (c) => {
    const product = c.product || c;
    return normalizeForCompare(`${product.title?.he || ""} ${product.title?.en || ""}`);
  };

  let kept = [...candidates];

  // ── שלילה: פסילה מוחלטת ──
  // הלקוח כתב "(לא תה ירוק)" כי הוא יודע שמתבלבלים. מועמד שמכיל את הביטוי
  // הזה הוא בדיוק הטעות שהוא ביקש למנוע.
  if (qualifiers.negations.length) {
    const before = kept.length;
    kept = kept.filter((c) => {
      const title = titleOf(c);
      const hit = qualifiers.negations.find((neg) => title.includes(normalizeForCompare(neg)));
      if (hit) {
        rejected.push({ candidate: c, reason: `נפסל בגלל שלילה מפורשת: "לא ${hit}"` });
        return false;
      }
      return true;
    });
    if (kept.length !== before) {
      appliedFilters.push(`שלילה (${qualifiers.negations.join(", ")})`);
    }
  }

  // ── מידה: סינון חזק ──
  // משקל/נפח/מספר יחידות שונה = מוצר שונה. מסננים רק אם *יש* מועמדים תואמים,
  // כדי שלא נישאר בלי כלום כשהמידה לא מופיעה בכותרות בקטלוג.
  //
  // ── למה נספרות התאמות ולא מספיקה אחת ──
  //
  // כשהתנאי היה "מספיקה מידה אחת תואמת", מוצר שחלק על *כל* המידות עם מוצר אחר
  // חוץ מאחת לא היה נבדל ממנו כלל: "חלב עמיד 3% 1 ליטר" מול "חלב עמיד 1 ליטר
  // 1%" — שניהם 1 ליטר, ולכן שניהם עברו את הסינון והתיקו נשאר בעינו. ספירה
  // מבדילה ביניהם: הראשון תואם 2 מידות והשני רק 1.
  //
  // התנאי הוא `kept.length` ולא `kept.length > 1` בכוונה. הסינון עצמו אכן
  // חסר משמעות עם מועמד אחד — אבל *הזיהוי* של אי-התאמה דווקא קריטי שם:
  // מועמד יחיד במידה שגויה הוא בדיוק המקרה שאין לו מתחרה שיסמן שמשהו לא
  // בסדר, והוא זה שהתקבל בביטחון 0.97 ("500 גרם" שהותאם ל-"360 גר'").
  if (qualifiers.sizes.length && kept.length) {
    // מידה שנכתבה פעמיים לא תיספר פעמיים
    const wanted = [];
    qualifiers.sizes.forEach((s) => {
      if (!wanted.some((w) => w.base === s.base && w.normalized === s.normalized)) wanted.push(s);
    });

    const wantedLabel = wanted.map((w) => w.raw).join("/");

    const scored = kept.map((c) => {
      const product = c.product || c;
      const candidateSizes = extractSizesFromTitle(product.title);
      const hits = wanted.filter((w) =>
        candidateSizes.some((cs) => cs.base === w.base && cs.normalized === w.normalized)
      ).length;
      return { candidate: c, hits, hasSizes: candidateSizes.length > 0 };
    });

    const bestHits = Math.max(...scored.map((s) => s.hits));

    // רק אם *מישהו* תאם. אם אף מועמד לא מציין מידה בכותרת, אין על מה לסנן
    // ועדיף להשאיר את כולם מאשר להישאר בלי כלום.
    if (bestHits > 0) {
      scored
        .filter((s) => s.hits < bestHits)
        .forEach((s) => {
          rejected.push({
            candidate: s.candidate,
            reason: s.hasSizes
              ? `מידה לא תואמת (מבוקש ${wantedLabel})`
              : `אין מידה בשם המוצר (מבוקש ${wantedLabel})`,
          });
        });

      kept = scored.filter((s) => s.hits === bestHits).map((s) => s.candidate);
      appliedFilters.push(`מידה (${wanted.map((w) => w.raw).join(", ")})`);
    } else if (scored.some((s) => s.hasSizes)) {
      // ── הלקוח ביקש מידה שלא קיימת אצל אף מועמד ──
      //
      // עד כאן המצב הזה נבלע בשקט: אין מול מה לסנן, ולכן הסינון פשוט דולג
      // והמועמד המוביל התקבל כרגיל. התוצאה שנראתה בפועל — "גבינה צהובה 500
      // גרם נועם" הותאם ל-"גבינה צהובה נועם רגיל/לייט 360 גר'" בביטחון 0.97,
      // כלומר אריזה קטנה יותר נכנסה להזמנה בלי שאיש ידע.
      //
      // מוצרים שיש בשמם מידה, ואף אחת מהן אינה מה שהתבקש, הם סימן מובהק
      // שהמוצר המבוקש פשוט אינו בקטלוג. זה חייב להוריד ביטחון ולהגיע לאדם.
      sizeMismatch = true;
      sizeMismatchLabel = wanted.map((w) => w.raw).join(", ");
      appliedFilters.push(`מידה מבוקשת (${sizeMismatchLabel}) לא נמצאה באף מועמד`);
    }
  }

  // ── גודל בתואר: אותו דין כמו מידה במספר ──
  //
  // המבנה זהה בכוונה לבלוק שמעליו, ומאותו נימוק: אם *יש* מועמד שנושא את הגודל
  // המבוקש — מסננים אליו. אם אף מועמד לא נושא אותו אבל מישהו כן מציין גודל
  // אחר, זו אינדיקציה שהמוצר המבוקש אינו בקטלוג, וזה חייב להגיע לאדם.
  //
  // כשאף מועמד אינו מציין גודל בכלל אין סתירה אלא שתיקה — הקטלוג פשוט אינו
  // מבחין בין גדול לקטן במוצר הזה. עצירה במקרה כזה הייתה שולחת לטיפול ידני כל
  // "שקית גדולה" ו-"מגש גדול", גם כשיש מוצר אחד ויחיד והוא הנכון.
  if (qualifiers.sizeWords?.length && kept.length) {
    const wantedSizes = qualifiers.sizeWords;
    const wantedSizeLabel = wantedSizes.map((w) => w.raw).join(", ");

    const scored = kept.map((c) => {
      const title = titleOf(c);
      const hits = wantedSizes.filter((w) =>
        SIZE_WORD_FORMS[w.base].some((form) => wordAppears(title, form))
      ).length;
      const hasAnySizeWord = SIZE_WORD_BASES.some((base) =>
        SIZE_WORD_FORMS[base].some((form) => wordAppears(title, form))
      );
      return { candidate: c, hits, hasAnySizeWord };
    });

    const bestHits = Math.max(...scored.map((s) => s.hits));

    if (bestHits > 0) {
      scored
        .filter((s) => s.hits < bestHits)
        .forEach((s) =>
          rejected.push({
            candidate: s.candidate,
            reason: `גודל לא תואם (מבוקש ${wantedSizeLabel})`,
          })
        );
      kept = scored.filter((s) => s.hits === bestHits).map((s) => s.candidate);
      appliedFilters.push(`גודל (${wantedSizeLabel})`);
    } else if (scored.some((s) => s.hasAnySizeWord)) {
      sizeMismatch = true;
      sizeMismatchLabel = sizeMismatchLabel
        ? `${sizeMismatchLabel}, ${wantedSizeLabel}`
        : wantedSizeLabel;
      appliedFilters.push(`גודל מבוקש (${wantedSizeLabel}) לא נמצא באף מועמד`);
    }
  }

  // ── גרסה: תוספת ניקוד, לא סינון ──
  // "אדום" הוא רמז חזק אבל לא ודאי: הוא עלול להיות חלק משם המוצר בקטלוג
  // ועלול גם לא להופיע בו בכלל.
  if (qualifiers.variants.length && kept.length > 1) {
    kept = kept.map((c) => {
      const title = titleOf(c);
      const hits = qualifiers.variants.filter((v) => title.includes(normalizeForCompare(v)));
      return hits.length
        ? { ...c, score: (c.score || 0) + hits.length * 4000, variantHits: hits }
        : c;
    });
    kept.sort((a, b) => (b.score || 0) - (a.score || 0));
    appliedFilters.push(`גרסה (${qualifiers.variants.join(", ")})`);
  }

  // ── מפרט שלא התבקש: פסילה, אבל רק כשנשאר ממי לבחור ──
  //
  // רץ אחרון, אחרי שכל הסינונים שנשענים על מה שהלקוח *כן* אמר סיימו. הסדר
  // הזה חשוב: הכלל כאן הוא ההסבר החלש מבין השניים ("הלקוח שתק, מכאן שהוא רצה
  // את הבסיסי"), ואסור לו לפסול מועמד שסינון חזק יותר כבר בחר בו.
  //
  // ‏`survivors.length` בכל שלב הוא התנאי היחיד: כשכל המועמדים נושאים אריזה,
  // אין "בסיסי" בקטלוג ואין על מה להכריע — עדיף להשאיר את כולם ולתת לאדם
  // לבחור מאשר לפסול את כולם ולהחזיר "לא נמצא מוצר".
  if (kept.length > 1) {
    const asked = findSpecs(qualifiers.cleanName || "");

    const dropBySpec = (label, hasUnrequested) => {
      if (kept.length <= 1) return;
      const survivors = kept.filter((c) => !hasUnrequested(titleOf(c)));
      if (!survivors.length || survivors.length === kept.length) return;

      kept
        .filter((c) => hasUnrequested(titleOf(c)))
        .forEach((c) =>
          rejected.push({ candidate: c, reason: `${label} שהלקוח לא ביקש` })
        );
      kept = survivors;
      appliedFilters.push(`בלי ${label} שלא התבקשה`);
    };

    // אריזה — רק אם הלקוח לא ציין אריזה בעצמו ("שקיות של 250 ג'" כן ציין)
    if (!asked.packaging.length) {
      dropBySpec("צורת אריזה", (title) =>
        PACKAGING_WORDS.some((w) => wordAppears(title, w))
      );
    }

    // טעם
    if (!asked.flavor.length) {
      dropBySpec("טעם", (title) => FLAVOR_WORDS.some((w) => wordAppears(title, w)));
    }

    // מניין באריזה ("24 יח")
    if (!asked.packCount) {
      dropBySpec("כמות באריזה", (title) => PACK_COUNT_RE.test(title));
    }
  }

  return { kept, rejected, appliedFilters, sizeMismatch, sizeMismatchLabel };
};

module.exports = {
  extractQualifiers,
  extractSizesFromTitle,
  applyQualifiers,
  UNIT_LOOKUP,
  VARIANT_WORDS,
  SIZE_WORD_FORMS,
};

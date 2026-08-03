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
const VARIANT_WORDS = [
  "אדום", "ירוק", "כחול", "תכלת", "צהוב", "לבן", "שחור", "כתום", "חום", "ורוד", "סגול",
  "כהה", "בהיר", "גדול", "קטן", "בינוני", "ענק",
  "אורגני", "טבעוני", "ללא גלוטן", "ללא סוכר", "דיאט", "לייט", "מלוח", "מתוק",
  "קלוי", "טבעי", "טרי", "קפוא", "מיובש",
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
 * @returns {{kept: Array, rejected: Array, appliedFilters: Array}}
 */
const applyQualifiers = (candidates, qualifiers) => {
  const appliedFilters = [];
  const rejected = [];
  // הלקוח ציין מידה, ולאף מועמד אין אותה. ראה ההסבר ליד ההשמה.
  let sizeMismatch = false;

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
      appliedFilters.push(`מידה מבוקשת (${wanted.map((w) => w.raw).join(", ")}) לא נמצאה באף מועמד`);
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

  return { kept, rejected, appliedFilters, sizeMismatch };
};

module.exports = {
  extractQualifiers,
  extractSizesFromTitle,
  applyQualifiers,
  UNIT_LOOKUP,
  VARIANT_WORDS,
};

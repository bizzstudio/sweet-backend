// lib/billing/depositSuggestions.js
//
// הצעה ראשונית: אילו מוצרים בקטלוג הם משקאות במכל שמחייב פיקדון, ואיזה.
// זו הצעה בלבד — מסך "פיקדונות" באדמין מציג אותה לאישור, ושום דבר לא
// נשמר בלי שאדם סימן אותו.
//
// הכלל שנקבע (23/11/2026): פחיות ובקבוקים קטנים → פיקדון פחיות;
// בקבוקים של ליטר וחצי ומעלה → פיקדון ליטר וחצי.

const titleOf = (p) => String(p?.title?.he || p?.title?.en || "").trim();

/** מוצר פיקדון לפי השם. */
const isDepositTitle = (title) => /פי?קדון/.test(title);

/** "cans" / "large" / null — סוג מוצר הפיקדון לפי השם שלו. */
const depositKind = (title) => {
  if (/1[.,]5|ליטר\s*וחצי|גדול/.test(title)) return "large";
  if (/פחי|קטן/.test(title)) return "cans";
  return null;
};

// משקל או נפח של מוצר שאינו משקה — "500 גרם" אינו בקבוק קטן
const NOT_A_DRINK = /גרם|גר'|ק"ג|קילו|שקית|אבקה|נייר|סבון|נוזל כלים|אקונומיקה|שמן|חומץ|רוטב|קטשופ|מיונז|ממרח|דבש|סילאן|טחינה|יוגורט|שמנת|לבן(?:\s|$)|גבינ/;

// כמה מכלים ביחידה אחת של המוצר, לפי השם. (?<!\d) כדי ש-"330x24" לא
// ייקרא כ-"30"
const PACK_PATTERNS = [
  /(?:מארז|קרטון|ארגז)\s*(?:של\s*)?(?<!\d)(\d{1,2})(?!\d)/,
  /(?<!\d)(\d{1,2})\s*(?:יח|פחיות|בקבוקים)/,
  /(?<![\d.,])(\d{1,2})\s*[x×*]\s*\d/,
  /\d\s*[x×*]\s*(\d{1,2})(?![\d.,])/,
];
const packSize = (title) => {
  if (/שישי/.test(title)) return 6;
  for (const re of PACK_PATTERNS) {
    const m = title.match(re);
    if (m) return Number(m[1]);
  }
  return 1;
};

/**
 * סוג הפיקדון המוצע למוצר, וכמה ביחידה.
 * @returns {{kind: "cans"|"large", perUnit: number, reason: string} | null}
 */
const suggestFor = (title) => {
  if (!title || isDepositTitle(title) || NOT_A_DRINK.test(title)) return null;

  let kind = null;
  let reason = "";
  if (/1[.,]5\s*(ל|ליטר|L\b)|ליטר\s*וחצי|\b1[.,]5\b|\b2\s*(ל'|ליטר)|\b2L\b/i.test(title)) {
    kind = "large";
    reason = "ליטר וחצי / 2 ליטר";
  } else if (/פחי/.test(title)) {
    kind = "cans";
    reason = "פחית";
  } else if (/(?<![\d.,])(250|330|350|500)(?![\d.,])|(?<![\d.,])0[.,](25|33|5)\s*(ל|ליטר)|בקבוקון/i.test(title)) {
    kind = "cans";
    reason = "בקבוק קטן";
  }
  if (!kind) return null;

  let perUnit = 1;
  const pack = packSize(title);
  if (pack >= 2 && pack <= 48) {
    perUnit = pack;
    reason += ` · מארז ${pack}`;
  }

  return { kind, perUnit, reason };
};

module.exports = { titleOf, isDepositTitle, depositKind, suggestFor };

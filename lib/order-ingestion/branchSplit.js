// lib/order-ingestion/branchSplit.js
//
// מייל אחד, כמה סניפים.
//
// לקוחות רשתיים (כלנית, טבולה) שולחים מייל הזמנה אחד ובו קובץ PDF לכל סניף.
// קוראי המייל משרשרים את כל הקבצים לטקסט אחד, וכך נוצרה הזמנה אחת — על
// הכרטיס של השולח — עם הפריטים של כל הסניפים יחד, בתעודה אחת.
//
// כאן שני החלקים של הפתרון:
//   1. splitAttachmentParts — פירוק הטקסט חזרה לקובץ-קובץ, לפי הכותרת שקורא
//      הקבצים כותב לפני כל קובץ ("--- קובץ מצורף: ... ---").
//   2. pickBranch — לכל קובץ, איזה מכרטיסי הרשת הוא. המועמדים הם רק כרטיסים
//      שקשורים לכתובת השולח (אותו מייל, מייל איש קשר, או דומיין החברה), כך
//      שקובץ לעולם לא ישויך ללקוח של מישהו אחר.

const Customer = require("../../models/Customer");
const { PUBLIC_EMAIL_DOMAINS } = require("./senderWhitelist");

// הכותרת ש-lib/attachment-reader כותב לפני הטקסט של כל קובץ
const PART_HEADER = /^--- קובץ מצורף: (.+) ---$/gm;

/**
 * פירוק טקסט ההודעה לגוף המייל ולקבצים.
 *
 * @param {string} text
 * @returns {{ body: string, parts: Array<{ filename: string, text: string }> }}
 */
const splitAttachmentParts = (text) => {
  const source = String(text || "");
  const headers = [...source.matchAll(PART_HEADER)];
  if (!headers.length) return { body: source.trim(), parts: [] };

  const body = source.slice(0, headers[0].index).trim();
  const parts = headers.map((header, i) => {
    const end = i + 1 < headers.length ? headers[i + 1].index : source.length;
    return {
      filename: header[1].trim(),
      // הכותרת נשארת בטקסט: היא מה שמסך הקליטה מציג כדי לומר מאיזה קובץ
      // הגיעה הרשומה, והיא מה שהפרסר רגיל לראות.
      text: source.slice(header.index, end).trim(),
    };
  });

  return { body, parts };
};

// ── נרמול להשוואה ──

const normalize = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/['"''`ʼʻ״׳]/g, "")
    .replace(/[-־–_/\\,.():]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// מילים שמופיעות בשמות כרטיסים ואינן מבדילות בין סניף לסניף
const NOISE_WORDS = new Set(["סניף", "בעמ", "חברה", "ltd", "inc"]);

const tokensOf = (value) =>
  normalize(value)
    .split(" ")
    .filter((token) => token.length >= 2 && !NOISE_WORDS.has(token));

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * האם המילה מופיעה בטקסט כמילה שלמה. בעברית מותרת אות שימוש אחת לפניה —
 * "ברעננה", "לרעננה", "מרעננה" הם עדיין רעננה.
 */
const hasWord = (normalizedText, token) => {
  const prefix = /[א-ת]/.test(token[0]) ? "[ובהלמשכ]?" : "";
  const pattern = new RegExp(
    `(^|[^א-תa-z0-9])${prefix}${escapeRegex(token)}(?=$|[^א-תa-z0-9])`
  );
  return pattern.test(normalizedText);
};

const domainOf = (email) => {
  const at = String(email || "").lastIndexOf("@");
  return at === -1 ? null : String(email).slice(at + 1).toLowerCase().trim();
};

/**
 * כרטיסי הלקוח שקשורים לכתובת השולח: אותו מייל ראשי, אותו מייל איש קשר,
 * או מייל ראשי באותו דומיין חברה (לא gmail וכדומה).
 *
 * @returns {Promise<Array>} כרטיסים, ריק אם אין כתובת
 */
const findBranchFamily = async (senderEmail) => {
  const email = String(senderEmail || "").toLowerCase().trim();
  if (!email) return [];

  const conditions = [{ email }, { contactEmail: email }];
  const domain = domainOf(email);
  if (domain && !PUBLIC_EMAIL_DOMAINS.has(domain)) {
    conditions.push({ email: new RegExp(`@${escapeRegex(domain)}$`, "i") });
  }

  return Customer.find({ $or: conditions }).limit(100);
};

/**
 * איזה מכרטיסי הרשת הוא הקובץ.
 *
 * סדר הראיות, מהחזקה לחלשה:
 *   1. השם — המילים בשם הכרטיס שאינן משותפות לכל הרשת ("רעננה" מתוך
 *      "כלנית רעננה"). הראיה הראשית: כך סניף נקרא בקובץ.
 *   2. רחוב ומספר בית.
 *   3. עיר — רק כשאין בה סניף אחר של הרשת.
 *
 * בכל שלב מכריעים רק כשמועמד אחד בדיוק עומד בו. שני מועמדים = אין הכרעה,
 * ועוברים לראיה הבאה. אם אף ראיה לא הכריעה — null, ואדם בוחר.
 *
 * @returns {{ customer: Object, via: string } | null}
 */
const pickBranch = (family, text) => {
  if (!Array.isArray(family) || family.length < 2) return null;
  const haystack = normalize(text);

  // מילים שמופיעות בשמות כל הכרטיסים (שם הרשת) אינן מבדילות
  const tokenSets = family.map((customer) => new Set(tokensOf(customer.name)));
  const shared = new Set(
    [...tokenSets[0]].filter((token) => tokenSets.every((set) => set.has(token)))
  );

  // 1. שם: הכרטיס שכל המילים המבדילות שלו בטקסט. אם כמה עומדים בזה, זוכה
  //    מי שהתאים ביותר מילים ("רעננה צפון" גובר על "רעננה").
  const byName = family
    .map((customer, i) => {
      const distinctive = [...tokenSets[i]].filter((token) => !shared.has(token));
      const matched = distinctive.length && distinctive.every((t) => hasWord(haystack, t));
      return { customer, score: matched ? distinctive.length : 0 };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (byName.length === 1 || (byName.length > 1 && byName[0].score > byName[1].score)) {
    return { customer: byName[0].customer, via: "שם הסניף בקובץ" };
  }
  if (byName.length > 1) return null;

  // 2. רחוב + מספר בית
  const byStreet = family.filter((customer) => {
    const street = tokensOf(customer.address?.street);
    const number = normalize(customer.address?.houseNumber);
    if (!street.length || !number) return false;
    return street.every((t) => hasWord(haystack, t)) && hasWord(haystack, number);
  });
  if (byStreet.length === 1) return { customer: byStreet[0], via: "כתובת הסניף בקובץ" };
  if (byStreet.length > 1) return null;

  // 3. עיר, כשהיא ייחודית ברשת
  // בכרטיס העיר היא אובייקט מטבלת היישובים; ‏rawCity הוא הטקסט מהייבוא
  const cityOf = (customer) =>
    normalize(customer.address?.city?.city_name_he || customer.rawCity);
  const byCity = family.filter((customer) => {
    const city = cityOf(customer);
    if (!city) return false;
    const sameCity = family.filter((other) => cityOf(other) === city);
    return sameCity.length === 1 && hasWord(haystack, city);
  });
  if (byCity.length === 1) return { customer: byCity[0], via: "עיר הסניף בקובץ" };

  return null;
};

module.exports = {
  splitAttachmentParts,
  findBranchFamily,
  pickBranch,
};

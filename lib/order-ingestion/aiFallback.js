// lib/order-ingestion/aiFallback.js
//
// מה שההיסטוריה לא זיהתה לבד נשלח ל-AI — ורק מול מה שהלקוח הזה קונה.
//
// ── למה זה קיים, ולמה כך ──
//
// כללי ההיסטוריה משווים מילים. הם אינם יודעים ש"נייר ידיים" הוא נייר צץ רץ
// או ש"פלפל אדום" הוא גמבה, ולכן כל ניסוח חדש נעצר עד שמלמדים אותו. מודל שפה
// יודע את זה מעצמו. נמדד על 52 הזמנות שנתקעו (12/10/26): מתוך 248 שורות
// שהכללים לא סגרו, המודל ענה נכון על רובן — אבל כשדחקו בו להכריע הוא גם
// המציא: "קרטון כוסות" הפך ל-1,000 יחידות, "גבינת שמנת 5%" ל-30%, ושורה עם
// כמות מפורשת ("200 צלחות") סומנה "לא מוצר".
//
// לכן המודל **מציע**, והקוד **מאשר**. שלושה גבולות:
//   • הוא בוחר רק מתוך רשימת המוצרים של הלקוח. מוצר שהלקוח לא קנה אינו
//     אפשרות — זו הסיבה היחידה שבגללה שורה אמורה להיעצר.
//   • כל תשובה עוברת את verifyAnswer. מה שנפסל חוזר אליו פעם אחת עם הסיבה.
//   • כמות של קרטון/מגש/שרוול אינה ניחוש שלו: היא מחושבת מגודל האריזה
//     שנגזר מהזמנות העבר (utils/packSizes). בלי גודל ידוע — השורה לאדם.
//
// המודול אינו נוגע במסד ואינו יודע דבר על הזמנות: הוא מקבל שורות ורשימת
// מוצרים ומחזיר הכרעות. כך אפשר למדוד אותו על נתוני אמת בלי להפעיל את הצינור.

const { hasProductWord } = require("./qualifiers");
const { sharesNameWord, sharedWordCount, isAssorted } = require("../../utils/purchaseHistoryRanking");
const { canonicalWords } = require("../../utils/orderWording");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = () => process.env.INGESTION_AI_MODEL || process.env.OPENAI_ORDER_PARSER_MODEL || "gpt-4o";
const TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS) || 60000;
// רשימת המוצרים נשלחת בכל קריאה; מעבר לזה המחיר עולה והמוצרים הנוספים הם
// כאלה שנקנו פעם-פעמיים (הרשימה ממוינת לפי מספר הקניות)
const MAX_HISTORY_PRODUCTS = 450;
// מוצר שנקנה פחות מזה אינו "מה שהלקוח קונה" אלא רכישה חד-פעמית
const MIN_PURCHASES = 3;

const SYSTEM_PROMPT = `אתה קולט הזמנות של עסק סיטונאי למזון, ניקיון וציוד משרדי. אתה מקבל:
(א) רשימת המוצרים שהלקוח הזה קנה בעבר: מספר | שם | כמה פעמים | לפני כמה חודשים | גודל אריזה (קרטון/מארז), אם ידוע.
(ב) כל שורות ההזמנה לפי הסדר. שורה שמסומנת ✓ כבר זוהתה. שורה שמסומנת ? פתוחה, ועליה אתה עונה.

לכל שורה פתוחה החזר תשובה אחת, או כמה תשובות אם בשורה כתובים כמה מוצרים ("תפוח ירוק 2, תפוח אדום 3", "מלפפון בייבי + גמבה בייבי").
kind:
• "product" — שורת מוצר. product = המספר ברשימה, ו-title = שם המוצר בדיוק כפי שהוא ברשימה. אם אין ברשימה מוצר שמתאים: product = -1, title = "".
• "quantity_of_previous" — השורה אינה מוצר אלא הכמות של השורה שלפניה ("1 יח'", "5 חב'", "2 יח' מכל סוג"). quantity = הכמות שהיא מציינת.
• "not_product" — כותרת, ברכה, כתובת, הערה כללית או שם קטגוריה ("חלב ותחליפים", "כלים וח\\"פ"). שורה שהלקוח כתב לה כמות היא בקשה למוצר ואינה "not_product" גם אם לא מצאת אותו.

בחירת המוצר:
1. מילים שונות לאותו מוצר הן התאמה: "נייר ידיים" = נייר צץ רץ; "קפה שחור" = קפה טורקי, או "קפה עלית" שאינו נס קפה; "פלפל אדום" = גמבה אדומה; "נייר כסף" = נייר אלומיניום; "נייר סופג" = מגבות נייר; "סוכרזית" = ממתיק.
2. אסור להחליף במוצר דומה שאינו מה שהתבקש. כשהלקוח ציין אחוז שומן, משקל, נפח או מספר יחידות — בחר רק מוצר שנושא בדיוק אותו מספר. כשציין סוג (חם/קר, נטול קפאין, קלוי/טבעי, במים/בשמן, גדול/קטן, שלישיה/שישיה, טעם, צבע) — בחר רק מוצר מאותו סוג. אחרת product = -1.
3. נס קפה וקפה טורקי הם מוצרים שונים. יוגורט, מעדן וגבינה הם מוצרים שונים.
4. כשכמה מוצרים ברשימה מתאימים באותה מידה למה שנכתב, בחר את זה שהלקוח קונה הכי הרבה בתקופה האחרונה. מוצר שנקנה פעמים בודדות או לפני יותר משנתיים אינו הרגיל שלו.
5. sure = true כשאתה בטוח שזה המוצר. sure = false כשזה ניחוש.

כמות (quantity = כמה יחידות של המוצר שבחרת):
6. qty שבסוגריים הוא מה שהמערכת קראה, ולפעמים הוא שגוי. קרא את הכמות מהשורה עצמה ("- 3 חבילות", "חלב 3% 50", "x4"). בשורת טבלה עם כמה מספרים (מחיר, סה"כ, מק"ט) בחר את עמודת הכמות.
7. משקל: מוצר שנמכר ב-1 ק"ג ו"5 קילו" בשורה = 5. מספר פריטים בודדים של מוצר שנמכר בק"ג ("10 לימונים") — quantity = null.
8. קרטון / ארגז / מגש / שרוול / שישייה / מארז: packs = כמה כאלה הלקוח ביקש, ו-quantity = packs × גודל האריזה שברשימה. אם שם המוצר עצמו הוא האריזה ("שישיה", "ארגז 6 יח") — quantity = packs. אם גודל האריזה אינו ידוע — quantity = null. אסור לנחש גודל אריזה.
9. בכל מקרה אחר packs = null.
ענה ב-JSON בלבד.`;

const RESPONSE_SCHEMA = {
  name: "order_lines",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["lines"],
    properties: {
      lines: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["i", "kind", "product", "title", "quantity", "packs", "sure", "reason"],
          properties: {
            i: { type: "integer" },
            kind: { type: "string", enum: ["product", "quantity_of_previous", "not_product"] },
            product: { type: "integer" },
            title: { type: "string" },
            quantity: { type: ["number", "null"] },
            packs: { type: ["number", "null"] },
            sure: { type: "boolean" },
            reason: { type: "string" },
          },
        },
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────
//  הבודק: הקוד מאשר או פוסל כל תשובה של המודל
// ─────────────────────────────────────────────────────────────

// מספרים כפי שנכתבו, כולל עשרוניים. "1/2 קילו" ו"חצי קילו" הם 500.
const numbersIn = (text) =>
  (
    String(text || "")
      .replace(/(?:1\/2|חצי)\s*(?:קילו|ק["״]?ג)/g, " 500 ")
      .match(/\d+(?:[.,]\d+)?/g) || []
  ).map((n) => String(Number(n.replace(",", "."))));

const wordIn = (text, forms) =>
  forms.some((form) => new RegExp(`(^|[^א-ת])${form}([^א-ת]|$)`).test(String(text || "")));

// זוגות שאינם מתחלפים: כשהלקוח כתב אחד והמוצר נושא את השני, זה מוצר אחר
const OPPOSITES = [
  [["חם", "חמה", "חמים"], ["קר", "קרה", "קרים"]],
  [["קלוי", "קלויים"], ["טבעי", "טבעיים"]],
  [["גדול", "גדולה", "גדולות", "גדולים"], ["קטן", "קטנה", "קטנות", "קטנים"]],
  [["שלישיות", "שלישיה", "שלישייה"], ["שישיות", "שישיה", "שישייה"]],
  [["במים"], ["בשמן"]],
];

const PACK_WORDS = [
  "קרטון", "קרטונים", "ארגז", "ארגזים", "מגש", "מגשים", "שרוול", "שרוולים",
  // "סודה 1.5 ליטר - 3 שישיות" מול "סודה 1.5 ליטר" (יחידה): 3 שישיות הן 18
  "שישיה", "שישייה", "שישיות", "שישיית", "שישית", "מארזים",
];

const SIX_PACK_WORDS = ["שישיה", "שישייה", "שישיות", "שישיית", "שישית"];
const SLEEVE_WORDS = ["שרוול", "שרוולים"];
const BIG_WORDS = ["גדול", "גדולה", "גדולות", "גדולים"];
const SMALL_WORDS = ["קטן", "קטנה", "קטנות", "קטנים"];
const SIZE_WORDS = [...BIG_WORDS, ...SMALL_WORDS];
// מילים בשם המוצר שאומרות את אותו דבר: "בקבוק אישי" הוא הבקבוק הקטן
const BIG_IN_TITLE = [...BIG_WORDS, "ענק", "משפחתי", "משפחתית", "מוסדי"];
const SMALL_IN_TITLE = [...SMALL_WORDS, "אישי", "אישית", "אישיים", "מיני"];

// המידה שבשם המוצר ביחידה אחת (גרם / מ"ל / OZ), כדי להשוות גדול מול קטן
const measureOf = (title) => {
  const text = String(title || "");
  const oz = text.match(/OZ\s*(\d+)|(\d+)\s*OZ/i);
  if (oz) return Number(oz[1] || oz[2]);
  const kilo = text.match(/(\d+(?:\.\d+)?|1\/2|חצי)\s*(?:ק["״]?ג|קילו|ליטר)/);
  if (kilo) return (kilo[1] === "1/2" || kilo[1] === "חצי" ? 0.5 : Number(kilo[1])) * 1000;
  const gram = text.match(/(\d+(?:\.\d+)?)\s*(?:גרם|גר|ג['׳]|מ["״]?ל)/);
  return gram ? Number(gram[1]) : null;
};
// אותו מוצר באריזה שהשתנתה: הלקוח כותב "נוטלה 350 גרם" והמוצר היום 400 גר,
// "קרקר 900 גר" מול 1 קילו. מעבר לזה זה גודל אחר (200 מול 250, 500 מול 1 ק"ג).
const WEIGHT_TOLERANCE = 0.15;
const MIN_WEIGHT = 100;

// טעם שהלקוח ביקש במפורש ואינו בשם המוצר: "קפסולות וניל" אינן קפסולות קפה,
// ו"מעדן אפרסק" אינו מעדן סויה. מוצר "מגוון טעמים" פטור — הטעם הוא ההערה למלקט.
const FLAVORS = ["וניל", "שוקולד", "תות", "לימון", "אפרסק", "פטל", "מנגו", "קרמל", "קוקוס", "בננה", "דובדבן", "אוכמניות"];

// מוצרים שונים ששמם דומה מדי בשביל המודל: כפות ≠ כפיות
const LOOKALIKES = [
  [["כפות", "כף"], ["כפיות", "כפית"]],
  [["מעדן", "מעדנים"], ["יוגורט", "יוגורטים"]],
];
// מילים שנשארות בשורה שהיא רק כמות ("2 יח' מכל סוג")
const QUANTITY_ONLY_RE = /מכל סוג|יחידות|יחידה|יח['׳]?|חב['׳]?|חבילות|חבילה|שקיות|שקית|של|גר['׳]?|ג['׳]/g;

/**
 * האם התשובה של המודל עומדת בכללים.
 *
 * @param {Object} line - השורה כפי שהצינור מכיר אותה: { source, raw, qty, assumed }
 * @param {Object} answer - תשובת המודל לשורה
 * @param {Object|null} product - המוצר שנבחר מרשימת הלקוח: { title, n, pack }
 * @param {Array} [history] - שאר מוצרי הלקוח, כדי לדעת אם יש לו מוצר מתחרה
 * @param {Map|Set|null} [vocabulary] - המילים שמופיעות בשמות המוצרים בקטלוג
 * @returns {{ok: boolean, reason?: string, quantity?: number}}
 */
const verifyAnswer = (line, answer, product, history = [], vocabulary = null) => {
  const raw = String(line.raw || line.source || "");
  const source = String(line.source || raw).replace(/\t/g, " ");

  if (answer.kind === "not_product") {
    // כמות מפורשת היא הצהרה של הלקוח שזו בקשה. נמדד: "200 צלחות חד פעמיות"
    // סומנה "לא מוצר" וההזמנה נסגרה ריקה.
    if (!line.assumed && hasProductWord(raw)) {
      return { ok: false, reason: "הלקוח כתב כמות — זו בקשה למוצר" };
    }
    return { ok: true };
  }

  if (answer.kind === "quantity_of_previous") {
    if (hasProductWord(raw.replace(QUANTITY_ONLY_RE, " "))) {
      return { ok: false, reason: "יש בשורה שם של מוצר — היא אינה הכמות של השורה שלפניה" };
    }
    return { ok: true };
  }

  if (answer.product < 0 || !product) return { ok: false, reason: "אין ברשימת הלקוח", final: true };

  // "סניף: 40" היא תווית של טופס ולא מוצר. נמדד: הפכה ל-40 אבוקדו.
  if (/^[^\d:]{1,20}:\s*\d*\s*$/.test(raw.trim()) || /^[^\d:]{1,20}:\s*\d*\s*$/.test(source.trim())) {
    return { ok: false, reason: "שורת תווית ולא מוצר", final: true };
  }

  // "טחינה גולמית (לא לחיץ)" אינה "טחינה לחיץ בבקבוק"
  const refused = [...raw.matchAll(/(?:^|[^א-ת])(?:לא|ללא|בלי)\s+([א-ת]{3,})/g)].map((m) => m[1]);
  const refusedInTitle = refused.find((word) => wordIn(product.title, [word]));
  if (refusedInTitle) {
    return { ok: false, reason: `הלקוח כתב "לא ${refusedInTitle}" והמוצר הוא כזה` };
  }

  // המספר והשם חייבים להצביע על אותו מוצר. נמדד: "מיץ לימון" קיבל את המספר
  // של "תפוחים אדומים" — טעות ספירה ברשימה ארוכה, לא טעות בהבנה.
  if (answer.title && answer.title.trim() !== String(product.title).trim()) {
    return { ok: false, reason: "המספר ושם המוצר אינם תואמים" };
  }

  // מוצר שנקנה פעם-פעמיים נמצא בהיסטוריה, ולכן הוא אפשרות — אבל רק כשהשורה
  // קוראת לו בשמו. בלי זה רכישה חד-פעמית הופכת ל"מה שהלקוח קונה".
  const named = sharesNameWord(raw, { title: { he: product.title } });
  if (product.n !== null && product.n < MIN_PURCHASES && !(answer.sure && named)) {
    return { ok: false, reason: `המוצר נקנה רק ${product.n} פעמים, והשורה אינה קוראת לו בשמו`, final: true };
  }

  // כמה קרטונים/שישיות/שרוולים: המספר שכתוב לפני מילת האריזה ("3 שישיות")
  const askedByPack = wordIn(raw, PACK_WORDS);
  const packCount = askedByPack ? raw.match(new RegExp(`(\\d+)\\s*(?:${PACK_WORDS.join("|")})`)) : null;

  // ── מידה, אחוז ומספר יחידות שהלקוח כתב חייבים להיות בשם המוצר ──
  const titleNumbers = new Set(numbersIn(product.title));
  const packs = answer.packs === null || answer.packs === undefined ? null : String(answer.packs);
  // מספר שצמודה אליו יחידת מידה הוא גודל המוצר ולא הכמות, גם כשהוא שווה לה:
  // "שקית קפה שחור 1 ק"ג" אינה קפה 200 גר. יוצא מן הכלל: מוצר שנמכר במשקל
  // ("מלפפון 1 ק"ג"), שבו "4 קילו" הם הכמות.
  const soldByWeight = /(^|\s)1\s*(?:קילו|ק["״]?ג)/.test(product.title);
  const sized = new Set(
    (raw.match(/\d+(?:[.,]\d+)?\s*(?:%|(?:ק["״]?ג|קילו|גרם|גר|ליטר|מ["״]?ל)(?![א-ת]))/g) || [])
      .filter((part) => !(soldByWeight && /ק["״]?ג|קילו/.test(part)))
      .flatMap((part) => numbersIn(part))
  );
  const asked = numbersIn(raw).filter(
    (n) =>
      sized.has(n) ||
      (n !== String(answer.quantity) && n !== String(line.qty) && n !== packs && n !== (packCount && packCount[1]))
  );
  // "1 קילו" בשם המוצר הוא 1000 גרם
  const titleWeights = [...titleNumbers].map(Number);
  if (soldByWeight) titleWeights.push(1000);
  const sameWeight = (n) =>
    Number(n) >= MIN_WEIGHT &&
    titleWeights.some((w) => w >= MIN_WEIGHT && Math.abs(w - Number(n)) / w <= WEIGHT_TOLERANCE);
  const absent = asked.filter((n) => !titleNumbers.has(n) && !sameWeight(n));
  // שורת טבלה עם מחירים וסכומים אינה נבדקת כך — המספרים שבה אינם מידות
  if (absent.length && asked.length <= 3) {
    return { ok: false, reason: `הלקוח כתב ${absent.join(", ")} והמוצר שנבחר אינו כזה` };
  }

  for (const [a, b] of OPPOSITES) {
    for (const [mine, theirs] of [[a, b], [b, a]]) {
      // "קלוי/טבעי" — הלקוח כתב את שניהם, ואין כאן ניגוד
      if (wordIn(raw, mine) && !wordIn(raw, theirs) && wordIn(product.title, theirs) && !wordIn(product.title, mine)) {
        return { ok: false, reason: `הלקוח כתב "${mine[0]}" והמוצר הוא "${theirs[0]}"` };
      }
    }
  }

  for (const [a, b] of LOOKALIKES) {
    for (const [mine, theirs] of [[a, b], [b, a]]) {
      if (wordIn(raw, mine) && !wordIn(raw, theirs) && wordIn(product.title, theirs) && !wordIn(product.title, mine)) {
        return { ok: false, reason: `"${mine[0]}" ו"${theirs[0]}" הם מוצרים שונים` };
      }
    }
  }

  if (!isAssorted({ title: { he: product.title } })) {
    const titleWords = new Set(canonicalWords(product.title));
    const lineWords = canonicalWords(raw);
    const missingFlavor = FLAVORS.find((flavor) => lineWords.includes(flavor) && !titleWords.has(flavor));
    // "7 פטל" — הטעם הוא שם המוצר (סירופ פטל), לא תוספת למוצר אחר
    const flavorIsTheName = !hasProductWord(lineWords.filter((word) => !FLAVORS.includes(word)).join(" "));
    if (missingFlavor && !flavorIsTheName) {
      return { ok: false, reason: `הלקוח ביקש "${missingFlavor}" והמוצר אינו כזה` };
    }
  }

  const isInstant = (text) => wordIn(text, ["נס", "נמס"]);
  const namedBrand = /טסטר|ט[יי]*סטר|ג.{0,2}קובס|רד מאג|פלטינום|פלטיניום/.test(raw);
  if (/קפה/.test(raw) && /קפה/.test(product.title) && !namedBrand && isInstant(raw) !== isInstant(product.title)) {
    return { ok: false, reason: "נס קפה וקפה טורקי הם מוצרים שונים" };
  }

  // ── כמות ──
  let quantity = answer.quantity;

  if (askedByPack) {
    // גודל הקרטון אינו ניחוש של המודל: הוא מחושב כאן מהנתון שנמסר לו
    const sixPack = wordIn(raw, SIX_PACK_WORDS);
    const sleeve = wordIn(raw, SLEEVE_WORDS);
    // המוצר עצמו הוא האריזה שהתבקשה: "שישיה"/"ארגז" בשם, שישייה מול "6 יח",
    // שרוול מול "50 יח" (מה שבתוך השרוול — ולכן לא גודל הקרטון)
    const titleIsPack =
      /שישיה|שישייה|שישיות|ארגז|מארז/.test(product.title) ||
      (sixPack && /(^|\D)6\s*יח/.test(product.title)) ||
      (sleeve && /\d+\s*יח/.test(product.title));
    // אחרת מה שהמודל קרא, אחרת הכמות שהפרסר קרא מהשורה, אחרת אחד
    const count = packCount ? Number(packCount[1]) : answer.packs ?? (line.assumed ? 1 : Number(line.qty) || 1);
    if (titleIsPack) quantity = count;
    // שישייה היא שש, בכל מוצר
    else if (sixPack) quantity = count * 6;
    else if (product.pack) quantity = count * product.pack;
    else return { ok: false, reason: "גודל הקרטון של המוצר אינו ידוע", final: true };
  }

  // "24 בקבוקים" מול מוצר שנמכר בשישיות הם 4 שישיות, לא 24
  const singles = source.match(/(\d+)\s*(?:בקבוקים|בקבוקי|פחיות)/);
  if (!askedByPack && singles && /שישיה|שישייה|שישיות/.test(product.title)) {
    if (Number(singles[1]) % 6) return { ok: false, reason: "מספר הבקבוקים אינו מתחלק לשישיות", final: true };
    quantity = Number(singles[1]) / 6;
  }

  if (quantity === null || quantity === undefined) {
    return { ok: false, reason: "הכמות אינה ברורה מהשורה", final: true };
  }

  const weighed = /ק"ג|קילו/.test(product.title) && /קילו|ק"ג/.test(source);
  if (!(quantity > 0) || (!Number.isInteger(quantity) && !weighed)) {
    return { ok: false, reason: `כמות לא תקינה: ${quantity}` };
  }

  // כמות שאינה כתובה בשורה ואינה 1 היא חישוב של המודל — מותר רק מגודל אריזה
  // כתובה בשורה, או שזו הכמות שהפרסר עצמו קרא ממנה
  const written =
    numbersIn(source).includes(String(quantity)) || (!line.assumed && quantity === Number(line.qty));
  // "24 בקבוקים קטנים של מים" מול מוצר שנמכר בשישיות: 4 שישיות
  const dividedBySix =
    /שישיה|שישייה|שישיות/.test(product.title) && numbersIn(source).includes(String(quantity * 6));
  if (!written && quantity !== 1 && !askedByPack && !dividedBySix) {
    return { ok: false, reason: `הכמות ${quantity} אינה כתובה בשורה` };
  }

  // ── "לא בטוח" של המודל אינו סוף פסוק ──
  //
  // נמדד: המודל סימן "לא בטוח" 68 תשובות, ורובן נכונות ("קפה שחור" → "קפה
  // עלית מוסדי", "40 חלב" → חלב 3%, "מפיות מרובעות" → מפיות מקופלות). הסימון
  // שלו אינו מבחין בין השניים. מה שכן מבחין: כשהשורה והמוצר חולקים **שם של
  // מוצר**, והתשובה כבר עברה את כל הבדיקות שלמעלה, זו ההכרעה של "מה שהלקוח
  // קונה". בלי מילה משותפת ("קליק ירוק" → "קינדר עוגיות") ההצעה היא ניחוש.
  // רשימת הלקוח מחזיקה שם כמחרוזת; כללי ההיסטוריה מצפים ל-title.he
  // בלי מילה משותפת נשאר מקרה אחד שהוא כן הכרעה: הלקוח קרא למוצר במילה
  // שאין בקטלוג בכלל ("סוכרזית", "סמרטוטי", "ספרי ריח"), ולכן מילה אחרת היא
  // הדרך היחידה למצוא אותו. כשהמילה שלו כן שם של מוצרים בקטלוג ("צלחות")
  // והמודל הציע מוצר בלי המילה הזו ("כוסות") — זה מוצר אחר.
  if (!answer.sure && !named) {
    const ownWords = canonicalWords(raw).filter((word) => word.length > 2 && hasProductWord(word));
    const knownElsewhere = vocabulary && ownWords.some((word) => vocabulary.has(word));
    if (!vocabulary || knownElsewhere || !ownWords.length) {
      return { ok: false, reason: "המודל אינו בטוח, ואין שם מוצר משותף לשורה ולהצעה", final: true };
    }
  }

  // ── "גדול"/"קטן" שאינו בשם המוצר ──
  //
  // כשללקוח יש רק מוצר אחד כזה, "חומוס גדול" הוא החומוס שלו. כשיש לו שניים
  // (400 גר ו-1 ק"ג) המילה היא בדיוק מה שמבדיל ביניהם, והמודל אינו יודע איזה.
  const wantsBig = wordIn(raw, BIG_WORDS);
  const wantsSmall = wordIn(raw, SMALL_WORDS);
  const saidInTitle = wordIn(product.title, wantsBig ? BIG_IN_TITLE : SMALL_IN_TITLE);
  if (wantsBig !== wantsSmall && !saidInTitle) {
    const bare = SIZE_WORDS.reduce(
      (text, word) => text.replace(new RegExp(`(^|[^א-ת])${word}(?=[^א-ת]|$)`, "g"), "$1 "),
      raw
    );
    const asTitle = (entry) => ({ title: { he: entry.title } });
    const shared = sharedWordCount(bare, asTitle(product));
    const head = canonicalWords(product.title)[0];
    const rivals = history.filter(
      (other) =>
        other.title !== product.title &&
        (other.n === null || other.n >= MIN_PURCHASES) &&
        (shared > 0
          ? sharedWordCount(bare, asTitle(other)) >= shared
          : canonicalWords(other.title)[0] === head)
    );
    // כשלכולם יש מידה בשם, "גדול" הוא הגדול שבהם ו"קטן" הקטן שבהם
    const mine = measureOf(product.title);
    const theirs = rivals.map((other) => measureOf(other.title));
    const isExtreme =
      mine !== null &&
      theirs.every((size) => size !== null && (wantsBig ? size < mine : size > mine));
    if ((rivals.length && !isExtreme) || (!rivals.length && !answer.sure)) {
      return {
        ok: false,
        reason: rivals.length
          ? `הלקוח ביקש ${wantsBig ? "גדול" : "קטן"}, ויש לו גם "${rivals[0].title}"`
          : "הלקוח ביקש גודל שאינו כתוב בשם המוצר",
        final: true,
      };
    }
  }

  return { ok: true, quantity };
};

// "א + ב", או שם-מספר-שם-מספר ("ממרח נוטלה 1 ממרח שחר 1")
const UNIT_AFTER_NUMBER = "גרם|גר|ג|ק\"ג|קג|קילו|ליטר|מל|מ\"ל|יח|יחידות|יחידה|חב|חבילות|חבילה|שקית|שקיות|אחוז|סמ|מטר|דף";
const NAME_NUMBER_NAME_NUMBER = new RegExp(
  `[א-ת]{2,}\\s+\\d+\\s+(?!(?:${UNIT_AFTER_NUMBER})(?![א-ת]))[א-ת]{2,}[^\\d]*\\d+\\s*$`
);
const looksLikeTwoProducts = (text) => {
  const t = String(text || "");
  return /\S\s*\+\s*\S/.test(t) || NAME_NUMBER_NAME_NUMBER.test(t) || /[\dא-ת]\s*\*\s*\d+\s+[א-ת]/.test(t);
};

// ─────────────────────────────────────────────────────────────
//  הקריאה למודל
// ─────────────────────────────────────────────────────────────

const formatHistory = (history) =>
  history
    .map((p, i) => `${i}|${p.title}|${p.n}|${p.ago}|${p.pack || "-"}`)
    .join("\n");

// ההודעה יוצאת לשירות חיצוני. טלפון ומייל שנשארו בשורת טקסט (חתימה, איש
// קשר) אינם נחוצים לזיהוי מוצר, ולכן אינם נשלחים.
const withoutContacts = (text) =>
  String(text || "")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[מייל]")
    .replace(/(?:\+?972|0)[\d\s-]{8,12}\d/g, "[טלפון]");

const formatLines = (lines) =>
  lines
    .map((line, i) => {
      const source = withoutContacts(line.source);
      return line.status === "ok"
        ? `${i}. ✓ ${source}   → ${line.product} ×${line.qty}`
        : line.status === "text"
          ? `${i}. (טקסט) ${source}`
          : `${i}. ? ${source}   (qty שנקרא: ${line.qty}${line.assumed ? ", הונח" : ""})`;
    })
    .join("\n");

const callModel = async (messages, { apiKey, usage }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(OPENAI_URL, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: MODEL(),
          temperature: 0,
          response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
          messages,
        }),
      });
      if (response.status === 429 || response.status >= 500) {
        await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
        continue;
      }
      const json = await response.json();
      if (!response.ok) throw new Error(`OpenAI ${response.status}: ${json?.error?.message || ""}`.slice(0, 200));
      if (usage) {
        usage.in += json.usage?.prompt_tokens || 0;
        usage.out += json.usage?.completion_tokens || 0;
        usage.calls += 1;
      }
      return { raw: json.choices[0].message.content, lines: JSON.parse(json.choices[0].message.content).lines };
    }
    throw new Error("OpenAI לא ענה אחרי 3 ניסיונות");
  } finally {
    clearTimeout(timer);
  }
};

/**
 * הכרעות לשורות הפתוחות של הזמנה אחת.
 *
 * @param {Object} input
 * @param {Array} input.lines - כל שורות ההזמנה לפי הסדר: { source, raw, qty, assumed,
 *        status: "ok"|"open"|"text", product? }
 * @param {Array} input.history - מוצרי הלקוח: { title, n, ago, pack?, ...כל שדה נוסף }
 * @param {string} [input.apiKey]
 * @param {Object} [input.usage] - מונה טוקנים מצטבר: { in, out, calls }
 * @param {Function} [input.ask] - מחליף את הקריאה למודל (בדיקות, בלי רשת)
 * @param {Map|null} [input.vocabulary] - אוצר המילים של הקטלוג (utils/catalogVocabulary)
 * @returns {Promise<Array<{index: number, decision: "accept"|"drop"|"attach"|"open",
 *           product?: Object, quantity?: number, reason?: string}>>}
 *          תשובה לכל שורה פתוחה. כמה "accept" לאותה שורה = כמה מוצרים בשורה.
 */
const resolveOpenLines = async ({
  lines,
  history,
  apiKey = process.env.OPENAI_API_KEY,
  usage = null,
  ask = callModel,
  vocabulary = null,
}) => {
  const open = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.status === "open");
  if (!open.length || !history?.length || (!apiKey && ask === callModel)) return [];

  const list = history.slice(0, MAX_HISTORY_PRODUCTS);
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `רשימת המוצרים של הלקוח:\n${formatHistory(list)}\n\nשורות ההזמנה:\n${formatLines(lines)}` },
  ];

  const judge = (answers) => {
    const byIndex = new Map();
    for (const answer of answers) {
      const line = lines[answer.i];
      if (!line || line.status !== "open") continue;
      const product = answer.kind === "product" && answer.product >= 0 ? list[answer.product] || null : null;
      const soFar = byIndex.get(answer.i) || [];
      // אותה תשובה פעמיים לאותה שורה אינה שני מוצרים — בלי זה הפריט נכנס כפול
      if (soFar.some((seen) => seen.answer.kind === answer.kind && seen.answer.product === answer.product)) continue;
      const verdict = verifyAnswer(line, answer, product, list, vocabulary);
      byIndex.set(answer.i, [...soFar, { answer, product, verdict }]);
    }
    return byIndex;
  };

  const first = await ask(messages, { apiKey, usage });
  let judged = judge(first.lines);

  // ── סיבוב שני: מה שנפסל חוזר למודל עם הסיבה ──
  //
  // רק פסילות שאפשר לתקן. "אין ברשימה" או "גודל הקרטון אינו ידוע" אינן
  // טעות של המודל, ושאלה חוזרת עליהן רק מזמינה תשובה מומצאת.
  const fixable = [...judged.entries()].filter(([, results]) =>
    results.some(({ verdict }) => !verdict.ok && !verdict.final)
  );
  if (fixable.length) {
    const complaints = fixable
      .map(([i, results]) =>
        results
          .filter(({ verdict }) => !verdict.ok)
          .map(({ answer, verdict }) => `שורה ${i}: ענית "${answer.title || answer.kind}" — נפסל: ${verdict.reason}.`)
          .join("\n")
      )
      .join("\n");
    const second = await ask(
      [
        ...messages,
        { role: "assistant", content: first.raw },
        {
          role: "user",
          content:
            `התשובות האלה נפסלו בבדיקה:\n${complaints}\n\n` +
            `ענה שוב רק על השורות האלה. אם אין ברשימה מוצר שעומד בדרישה — product = -1. אל תחזור על תשובה שנפסלה.`,
        },
      ],
      { apiKey, usage }
    );
    const retried = judge(second.lines);
    for (const [i] of fixable) if (retried.has(i)) judged.set(i, retried.get(i));
  }

  const decisions = [];
  for (const { index } of open) {
    const results = judged.get(index);
    if (!results) {
      decisions.push({ index, decision: "open", reason: "המודל לא ענה על השורה" });
      continue;
    }
    // ── שני מוצרים בשורה אחת, תשובה אחת ──
    //
    // "מלפפון בייבי + גמבה בייבי", "ממרח נוטלה 1 ממרח שחר 1": המודל ענה על
    // אחד מהם והשני נעלם מההזמנה. שורה כזו נסגרת רק כשהוא החזיר את שניהם.
    const products = results.filter(({ answer }) => answer.kind === "product").length;
    if (products === 1 && [lines[index].raw, lines[index].source].some(looksLikeTwoProducts)) {
      decisions.push({ index, decision: "open", reason: "בשורה כתובים שני מוצרים", suggestion: results[0].product?.title || null });
      continue;
    }

    // שורה עם כמה מוצרים נסגרת רק אם כולם אושרו
    if (results.some(({ verdict }) => !verdict.ok)) {
      const failed = results.find(({ verdict }) => !verdict.ok);
      decisions.push({
        index,
        decision: "open",
        reason: failed.verdict.reason,
        suggestion: failed.product?.title || null,
      });
      continue;
    }
    for (const { answer, product, verdict } of results) {
      if (answer.kind === "not_product") decisions.push({ index, decision: "drop" });
      else if (answer.kind === "quantity_of_previous") decisions.push({ index, decision: "attach", quantity: answer.quantity });
      else decisions.push({ index, decision: "accept", product, quantity: verdict.quantity });
    }
  }
  return decisions;
};

module.exports = { resolveOpenLines, verifyAnswer, looksLikeTwoProducts, callModel, SYSTEM_PROMPT, MIN_PURCHASES };

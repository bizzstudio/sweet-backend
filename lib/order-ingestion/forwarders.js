// lib/order-ingestion/forwarders.js
//
// הזמנה שהמשרד מעביר בשם לקוח.
//
// לקוחות שולחים לפעמים הזמנה לפלאפון הפרטי, ומשם היא מועברת לנייד המחובר
// למערכת או למייל ההזמנות. השולח שהמערכת רואה הוא אז המשרד ולא הלקוח, וכל
// זיהוי הלקוח בצינור בנוי על השולח. התוצאה הייתה "שולח לא מוכר", בלי קריאה
// ובלי תעודה, גם כשבהודעה נכתב שם הלקוח.
//
// כאן המסלול השני: מספרים וכתובות שהוגדרו כ"מעבירים פנימיים" עוברים את
// הרשימה הלבנה, והלקוח נקבע לפי השם שנכתב בהודעה. ההכרעה זהירה:
//   - נבדקות רק שורות קצרות שבהן השם הוא עיקר השורה, ולא שורת פריט כמו
//     "2 קפה עלית" שבמקרה מכילה מילה משם של לקוח.
//   - לקוח אחד בלבד מנצח. שניים שקולים, או שני לקוחות שונים בהודעה, הם
//     "לא זוהה" — ואז אדם בוחר בכפתור "שייך ללקוח". המערכת לא מנחשת.
//
// ⚠️ מעביר פנימי לעולם אינו מזוהה לפי השולח עצמו: אילו נפל למסלול הרגיל,
//    resolveCustomer היה פותח כרטיס לקוח על המספר של המשרד ומצמיד אליו את
//    כל ההזמנות המועברות.
//
// הגדרה ב-.env (רשימות מופרדות בפסיק):
//   INGESTION_FORWARDER_PHONES=050-1234567,052-7654321
//   INGESTION_FORWARDER_EMAILS=office@example.co.il

const Customer = require("../../models/Customer");
const { canonicalPhone } = require("../../utils/phone");
const { normalize, tokensOf, hasWord } = require("./branchSplit");

const listFromEnv = (name) =>
  String(process.env[name] || "")
    .split(/[,;\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);

const forwarderPhones = () =>
  new Set(listFromEnv("INGESTION_FORWARDER_PHONES").map(canonicalPhone).filter(Boolean));

const forwarderEmails = () =>
  new Set(listFromEnv("INGESTION_FORWARDER_EMAILS").map((e) => e.toLowerCase()));

/** האם השולח הוא מעביר פנימי (המשרד), ולא לקוח. */
const isForwarder = (sender = {}) => {
  const phone = canonicalPhone(sender.phone);
  if (phone && forwarderPhones().has(phone)) return true;
  const email = sender.email ? String(sender.email).toLowerCase().trim() : null;
  return Boolean(email && forwarderEmails().has(email));
};

// ── שמות הלקוחות, בזיכרון ──
//
// ההתאמה עוברת על כל הכרטיסים, ובווצאפ היא רצה על כל הודעה של המעביר (כדי
// לזהות מעבר ללקוח הבא). טעינה אחת לכמה דקות, כמו ברשימה הלבנה.
const NAMES_TTL_MS = 5 * 60 * 1000;
let namesCache = { customers: [], loadedAt: 0 };
let namesLoading = null;

const loadCustomerNames = async () => {
  if (namesCache.loadedAt && Date.now() - namesCache.loadedAt < NAMES_TTL_MS) {
    return namesCache.customers;
  }
  if (!namesLoading) {
    namesLoading = Customer.find({}, { name: 1 })
      .lean()
      .then((rows) => {
        const customers = rows
          .map((row) => ({ _id: row._id, name: row.name, tokens: [...new Set(tokensOf(row.name))] }))
          // שם של מילה אחת קצרה ("אב") תופס כל שורה — אינו ראיה
          .filter((c) => c.tokens.length > 1 || (c.tokens.length === 1 && c.tokens[0].length >= 3));
        namesCache = { customers, loadedAt: Date.now() };
        return customers;
      })
      .finally(() => {
        namesLoading = null;
      });
  }
  return namesLoading;
};

/** לאחר הוספת לקוח או שינוי שם, כדי שהשם החדש יזוהה מיד. */
const refreshCustomerNames = () => {
  namesCache.loadedAt = 0;
};

// מילים שנכתבות סביב השם ואינן חלק ממנו ("הזמנה של כלנית רעננה")
const FILLER_WORDS = new Set([
  "הזמנה", "הזמנת", "הזמנות", "של", "עבור", "בשביל", "לקוח", "לקוחה", "שם",
  "מאת", "מועבר", "מועברת", "הועבר", "הועברה", "fw", "fwd", "re", "forwarded",
]);

// מילים ש-tokensOf מסנן משמות הכרטיסים — מסוננות גם מהשורה, כדי ש"כלנית
// רעננה סניף" ייחשב שורה של שם בלבד
const NAME_NOISE = new Set(["סניף", "בעמ", "חברה", "ltd", "inc"]);

const MAX_NAME_LINE_CHARS = 80;

/**
 * הלקוח ששמו כתוב באחת השורות.
 *
 * @param {string[]} lines - שורות מועמדות (נושא, הודעה קצרה, ראש ההודעה)
 * @param {Array} customers - מ-loadCustomerNames
 * @returns {{ customer: Object|null, ambiguous: string[] }}
 *          ‏customer כשיש מנצח יחיד; ‏ambiguous = שמות המועמדים כשאין הכרעה
 */
const matchCustomerInLines = (lines, customers) => {
  const best = new Map(); // customerId → { customer, score }

  for (const line of lines) {
    if (!line || line.length > MAX_NAME_LINE_CHARS) continue;
    const haystack = normalize(line);
    // כל מילה בשורה נספרת, כולל מספרים: "2 קפה עלית" הן שלוש מילים ולא שתיים
    const lineTokens = haystack
      .split(" ")
      .filter((t) => t && !FILLER_WORDS.has(t) && !NAME_NOISE.has(t));
    if (!lineTokens.length) continue;

    for (const customer of customers) {
      if (!customer.tokens.every((t) => hasWord(haystack, t))) continue;
      // השם צריך להיות רוב השורה. "2 קפה עלית" ו"קפה עלית" אינם הלקוח "עלית".
      const coverage = customer.tokens.length / lineTokens.length;
      if (coverage <= 0.5) continue;
      // שם ארוך יותר גובר: "כלנית רעננה" על "כלנית" כשנכתב "כלנית רעננה"
      const score = customer.tokens.length * 10 + Math.min(coverage, 1);
      const key = String(customer._id);
      if (!best.has(key) || best.get(key).score < score) best.set(key, { customer, score });
    }
  }

  const ranked = [...best.values()].sort((a, b) => b.score - a.score);
  if (!ranked.length) return { customer: null, ambiguous: [] };

  // שם שמוכל בשם המנצח אינו מתחרה בו ("כלנית" בתוך "כלנית רעננה"). כל לקוח
  // אחר שנמצא — כן: שני לקוחות שונים בהודעה אחת הם שתי הזמנות, או טעות.
  const top = ranked[0];
  const rivals = ranked.slice(1).filter(
    (entry) => !entry.customer.tokens.every((t) => top.customer.tokens.includes(t))
  );
  const tiedWithTop = ranked
    .slice(1)
    .filter((entry) => entry.score === top.score);

  if (!rivals.length && !tiedWithTop.length) return { customer: top.customer, ambiguous: [] };

  const names = [top, ...rivals, ...tiedWithTop].map((entry) => entry.customer.name);
  return { customer: null, ambiguous: [...new Set(names)].slice(0, 8) };
};

const nonEmptyLines = (text) =>
  String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

// סוף החלק שהמשרד כתב במייל מועבר — מכאן מתחילה ההודעה המקורית
const FORWARD_HEADER = /^(?:-{3,}.*(?:forwarded message|original message|הודעה שהועברה|הודעה מקורית)|(?:from|מאת)\s*:)/i;

/**
 * השורות שבהן ייתכן שנכתב שם הלקוח.
 *
 * בווצאפ אי אפשר לערוך הודעה מועברת, ולכן השם נשלח כהודעה נפרדת וקצרה. ממנה
 * נלקחות כל השורות; מהודעה ארוכה (ההזמנה עצמה) רק השורה הראשונה והאחרונה.
 * במייל: הנושא, ומה שנכתב מעל ההודעה המועברת.
 */
const candidateLines = (doc) => {
  if (doc.channel === "whatsapp" && Array.isArray(doc.messages) && doc.messages.length) {
    return doc.messages.flatMap((message) => {
      const lines = nonEmptyLines(message.text);
      if (lines.length <= 2) return lines;
      return [lines[0], lines[lines.length - 1]];
    });
  }

  const lines = nonEmptyLines(doc.rawText);
  const headerAt = lines.findIndex((line) => FORWARD_HEADER.test(line));
  const ownPart = headerAt > 0 ? lines.slice(0, Math.min(headerAt, 5)) : lines.slice(0, 3);
  return [doc.subject, ...ownPart].filter(Boolean);
};

/**
 * הלקוח שבשמו הועברה ההודעה.
 *
 * @returns {Promise<{ customer: Object|null, ambiguous: string[] }>} ‏customer
 *          הוא מסמך Customer מלא כשיש הכרעה.
 */
const findForwardedCustomer = async (doc) => {
  const customers = await loadCustomerNames();
  const { customer, ambiguous } = matchCustomerInLines(candidateLines(doc), customers);
  if (!customer) return { customer: null, ambiguous };
  const full = await Customer.findById(customer._id);
  return full ? { customer: full, ambiguous: [] } : { customer: null, ambiguous: [] };
};

/**
 * האם הודעת ווצאפ אחת פותחת הזמנה של לקוח — שם הלקוח בשורה הראשונה שלה.
 * המשרד כותב את השם בשורה הראשונה: לבד בהודעה, או מעל ההזמנה שהודבקה.
 * משמש לחיתוך בין הזמנות של לקוחות שונים שמועברות ברצף.
 *
 * @returns {Promise<string|null>} מזהה הלקוח
 */
const customerIdNamedIn = async (text) => {
  const [firstLine] = nonEmptyLines(text);
  if (!firstLine) return null;
  const customers = await loadCustomerNames();
  const { customer } = matchCustomerInLines([firstLine], customers);
  return customer ? String(customer._id) : null;
};

module.exports = {
  isForwarder,
  findForwardedCustomer,
  customerIdNamedIn,
  refreshCustomerNames,
  // לבדיקות
  matchCustomerInLines,
  candidateLines,
};

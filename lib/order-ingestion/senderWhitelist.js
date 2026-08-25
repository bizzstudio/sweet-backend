// lib/order-ingestion/senderWhitelist.js
//
// רשימת השולחים המאושרים: המערכת קוראת הודעות **רק** מלקוחות שקיימים במערכת.
// מייל או מספר טלפון שאינם בכרטיסי הלקוחות — ההודעה לא נקראת בכלל.
//
// שלושה רווחים מהמנגנון הזה:
//   1. אבטחה — רק לקוח מוכר יכול להזרים הזמנה למערכת.
//   2. שקט — ניוזלטרים, חשבוניות ספקים וספאם לא נכנסים לתיבת הטיפול.
//   3. עלות — הודעה שאינה מלקוח מוכר לא מגיעה לשום ניתוח.
//
// ── למה מחזיקים את הרשימה בזיכרון ──
//
// על `Customer.email` יש אינדקס ייחודי, אבל על `Customer.phone` **אין אינדקס
// בכלל**. בדיקה של כל הודעת ווצאפ מול ה-DB הייתה סריקת קולקציה מלאה לכל הודעה.
// לכן הרשימה נטענת פעם אחת לזיכרון ומתרעננת ב-TTL, והבדיקה עצמה היא O(1).
//
// המלצה משלימה ברמת ה-DB: אינדקס על `phone` (ראה ORDER-INGESTION.md).
//
// ── חריג אחד: פלטפורמות הזמנות ──
//
// כשלקוח מזמין דרך פלטפורמה (Zestt וכדומה), המייל מגיע מ-no-reply@ של
// הפלטפורמה ולא מהלקוח — כלומר הרשימה הלבנה, בצדק, דוחה אותו. אבל זו כן
// הזמנה אמיתית של לקוח אמיתי.
//
// לכן יש מסלול שני: דומיין שאושר **פעם אחת** כפלטפורמה במרשם
// (models/OrderPlatform) עובר את הרשימה הלבנה. השער לא נפתח לרווחה — הוא
// נפתח לדומיין אחד שאדם אישר, וההזמנה שמגיעה דרכו עדיין חייבת להתאים ללקוח
// קיים לפני שהיא נהפכת להזמנה. ראה ./platforms.js.

const Customer = require("../../models/Customer");
const { canonicalPhone, phoneVariations } = require("../../utils/phone");
const { isSyntheticEmail } = require("./resolvers");
const { isApprovedPlatformSender } = require("./platforms");

// כל כמה זמן נטענת הרשימה מחדש. לקוח שנוסף עכשיו יזוהה תוך דקות,
// ואפשר גם לרענן מיד ע"י refresh() אחרי הוספת לקוח.
const TTL_MS = Number(process.env.INGESTION_SENDER_CACHE_TTL_MS) || 5 * 60 * 1000;

// ערוצים שהרשימה הלבנה נאכפת עליהם. "manual" הוא הרצה יזומה של אדמין
// (כיול/בדיקה) ולכן פטור — האדמין הוא כבר גורם מאושר.
const ENFORCED_CHANNELS = new Set(["email", "whatsapp"]);

// מעל הגיל הזה, דחייה של שולח מצדיקה רענון לפני שדוחים סופית
const MISS_REFRESH_STALE_MS = Number(process.env.INGESTION_SENDER_MISS_STALE_MS) || 30 * 1000;
// אבל לא יותר מרענון אחד כזה בפרק הזמן הזה — אחרת כל ספאם טוען מחדש את הכול
const MISS_REFRESH_COOLDOWN_MS =
  Number(process.env.INGESTION_SENDER_MISS_COOLDOWN_MS) || 60 * 1000;

// ── התאמה לפי דומיין החברה ──
//
// נמדד על הנתונים: 41 הודעות נדחו כ"שולח לא מוכר" למרות שהחברה היא לקוח —
// הן פשוט נשלחו מעובד אחר. הלקוח "טבולה קום" רשום כ-amit.friedland@taboola.com,
// וההזמנה הגיעה מ-or.naor@taboola.com. אותו דבר ב-f5, medone, sarine, abbott,
// ramat-gan.muni.il ועוד.
//
// ── למה זה כבוי בברירת מחדל ──
//
// זו הרחבה של גבול אבטחה, לא תיקון באג. עם הדגל דלוק, **כל** מי שיש לו כתובת
// בדומיין של לקוח יכול להזרים הזמנה למערכת. בספק B2B זה לרוב מה שרוצים — אבל
// זו החלטה של בעל העסק, ולא ברירת מחדל שנכנסת בשקט בעדכון גרסה.
const MATCH_BY_DOMAIN = () => process.env.INGESTION_WHITELIST_BY_DOMAIN === "true";

// ── דומיינים שלעולם אינם מזהים חברה ──
//
// בלי הרשימה הזו לקוח יחיד שנרשם עם gmail היה פותח את השער לכל כתובת gmail
// בעולם — כלומר מבטל את הרשימה הלבנה כולה. נמדד כאן: 20 מההודעות שנחסמו הן
// מ-gmail, וכולן ספאם.
const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "walla.com", "walla.co.il", "hotmail.com",
  "outlook.com", "outlook.co.il", "live.com", "yahoo.com", "yahoo.co.il",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
  "nana.co.il", "bezeqint.net", "012.net.il", "netvision.net.il",
]);

const domainOf = (email) => {
  const at = String(email || "").lastIndexOf("@");
  return at === -1 ? null : String(email).slice(at + 1).toLowerCase().trim();
};

let cache = {
  emails: new Set(),
  phones: new Set(),
  domains: new Set(),
  loadedAt: 0,
  customerCount: 0,
};

let loading = null;
let lastMissRefreshAt = 0;

/**
 * טעינת הרשימה מה-DB.
 *
 * נטענים רק שני שדות מכל לקוח, ולכן גם עם עשרות אלפי לקוחות טביעת הרגל
 * בזיכרון קטנה (שתי מחרוזות ללקוח).
 */
const load = async () => {
  const customers = await Customer.find({}, { email: 1, phone: 1 }).lean();

  const emails = new Set();
  const phones = new Set();
  const domains = new Set();

  customers.forEach((customer) => {
    // מייל סינתטי (wa-05...@whatsapp.local) נוצר על ידינו ללקוח ווצאפ בלי מייל.
    // הוא אינו כתובת אמיתית ואין טעם לאשר שליחה ממנו.
    if (customer.email && !isSyntheticEmail(customer.email)) {
      const normalized = String(customer.email).toLowerCase().trim();
      emails.add(normalized);

      // הדומיין נאסף תמיד, גם כשהדגל כבוי — כדי ש-stats() יוכל לדווח כמה
      // חברות היו נפתחות, ושאפשר יהיה להחליט על הדגל מתוך מספר ולא מתחושה.
      const domain = domainOf(normalized);
      if (domain && !PUBLIC_EMAIL_DOMAINS.has(domain)) domains.add(domain);
    }

    if (customer.phone) {
      // כל הווריאציות (05../972../+972..) כדי שהשוואה תהיה השוואת מחרוזות פשוטה
      phoneVariations(customer.phone).forEach((v) => phones.add(v));
      const canonical = canonicalPhone(customer.phone);
      if (canonical) phones.add(canonical);
    }
  });

  cache = {
    emails,
    phones,
    domains,
    loadedAt: Date.now(),
    customerCount: customers.length,
  };

  console.log(
    `[whitelist] נטענו ${customers.length} לקוחות — ${emails.size} כתובות מייל, ` +
      `${phones.size} ווריאציות טלפון, ${domains.size} דומיינים` +
      `${MATCH_BY_DOMAIN() ? " (התאמה לפי דומיין פעילה)" : ""}`
  );

  return cache;
};

/**
 * הבטחת רשימה טעונה ועדכנית.
 * טעינות מקבילות מתמזגות לאותה הבטחה, כדי שלא ייטענו כמה פעמים במקביל.
 */
const ensureLoaded = async () => {
  const isFresh = cache.loadedAt && Date.now() - cache.loadedAt < TTL_MS;
  if (isFresh) return cache;

  if (!loading) {
    loading = load().finally(() => {
      loading = null;
    });
  }

  return loading;
};

/** טעינה מחדש מיידית — לשימוש אחרי הוספת לקוח. */
const refresh = async () => {
  cache.loadedAt = 0;
  return ensureLoaded();
};

/**
 * התאמת מייל לרשימה — כתובת מדויקת, ואם הדגל דלוק גם דומיין של לקוח.
 *
 * משותפת לשני המסלולים (הבדיקה הראשונה והבדיקה שאחרי הרענון) בכוונה: שתי
 * העתקות של אותו כלל היו נפרדות בעדכון הבא, וההפרש היה מתגלה כהזמנה שנדחתה
 * רק כשהרשימה במקרה הייתה מיושנת — כלומר באג שקשה מאוד לשחזר.
 */
const matchEmail = (email) => {
  if (!email) return null;
  if (cache.emails.has(email)) return `email:${email}`;

  if (MATCH_BY_DOMAIN()) {
    const domain = domainOf(email);
    if (domain && cache.domains.has(domain)) return `domain:${domain}`;
  }

  return null;
};

const matchPhone = (phone) => {
  if (!phone) return null;
  // בדיקה מול כל הווריאציות של המספר שהתקבל, לא רק כפי שנכתב
  const candidates = [phone, canonicalPhone(phone), ...phoneVariations(phone)].filter(Boolean);
  const hit = candidates.find((c) => cache.phones.has(c));
  return hit ? `phone:${hit}` : null;
};

/**
 * האם השולח מאושר.
 *
 * @param {Object} sender - { email, phone }
 * @param {string} channel - "email" | "whatsapp" | "manual"
 * @param {boolean} [hasOrderLinks] - האם בגוף ההודעה זוהה קישור להזמנה.
 *        מדווח למי שדוחה: הודעה כזו משולח לא מוכר אינה ספאם אלא פלטפורמה
 *        שטרם אושרה, והיא צריכה להגיע למסך אישור ולא ללשונית של ספאם.
 * @returns {Promise<{allowed: boolean, matchedBy: string|null, reason: string|null,
 *                    platform: Object|null, platformStatus: string|null}>}
 */
const isAllowedSender = async ({ sender = {}, channel, hasOrderLinks = false } = {}) => {
  if (!ENFORCED_CHANNELS.has(channel)) {
    return { allowed: true, matchedBy: "channel-exempt", reason: null, platform: null };
  }

  await ensureLoaded();

  const email = sender.email ? String(sender.email).toLowerCase().trim() : null;
  const phone = sender.phone ? String(sender.phone).trim() : null;

  const matched = matchEmail(email) || matchPhone(phone);
  if (matched) return { allowed: true, matchedBy: matched, reason: null };

  // ── לא נמצא ──
  //
  // ייתכן שהרשימה בזיכרון מיושנת ולקוח נוסף בדקות האחרונות. לפני שדוחים
  // הודעה — שעלולה להיות הזמנה אמיתית — מרעננים פעם אחת ובודקים שוב.
  //
  // אבל הרענון הזה חייב קירור: בלעדיו **כל** הודעת ספאם הייתה מפעילה טעינה
  // מחדש של כל טבלת הלקוחות. תיבה עם כמה מיילים זרים בסריקה = כמה טעינות
  // מלאות כל שתי דקות, וזה גדל עם מספר הלקוחות.
  const sinceLoad = Date.now() - cache.loadedAt;
  const sinceMissRefresh = Date.now() - lastMissRefreshAt;

  if (sinceLoad > MISS_REFRESH_STALE_MS && sinceMissRefresh > MISS_REFRESH_COOLDOWN_MS) {
    lastMissRefreshAt = Date.now();
    await refresh();
    const retried = matchEmail(email) || matchPhone(phone);
    if (retried) return { allowed: true, matchedBy: retried, reason: null, platform: null };
  }

  // ── מסלול הפלטפורמות ──
  //
  // השולח אינו לקוח. לפני שדוחים — האם הוא פלטפורמת הזמנות שאושרה? הבדיקה
  // הזו היא שאילתה אחת לפי מפתח עם אינדקס ייחודי, והיא רצה **רק** אחרי
  // שהמסלול הרגיל נכשל, כלומר לא על כל הודעה.
  return classifyRejectedSender({ email, phone, channel, hasOrderLinks });
};

/**
 * שולח שאינו לקוח — פלטפורמה, או פשוט לא מוכר.
 *
 * ההבדל בין השניים אינו קוסמטי: "שולח לא מוכר" מציע לפתוח ממנו כרטיס לקוח,
 * ועל מייל של פלטפורמה הפעולה הזו הייתה יוצרת לקוח בשם "Zestt" שכל ההזמנות
 * של כל המסעדות מוצמדות אליו.
 */
const classifyRejectedSender = async ({ email, phone, channel, hasOrderLinks }) => {
  const rejection = {
    allowed: false,
    matchedBy: null,
    reason: buildRejectionReason(email, phone),
    platform: null,
    platformStatus: null,
  };

  // פלטפורמה מזוהה לפי דומיין מייל. בווצאפ אין דומיין, ואין פלטפורמה.
  if (channel !== "email" || !email) return rejection;

  let approved = false;
  let platform = null;
  try {
    ({ approved, platform } = await isApprovedPlatformSender(email));
  } catch (err) {
    // כשל בשליפת המרשם אינו סיבה לקרוא הודעה משולח לא מוכר. נדחה, ונרשם.
    console.log(`[whitelist] בדיקת מרשם הפלטפורמות נכשלה: ${err.message}`);
    return rejection;
  }

  if (approved) {
    return {
      allowed: true,
      matchedBy: `platform:${platform.key}`,
      reason: null,
      platform,
      platformStatus: "approved",
    };
  }

  if (platform) {
    return {
      ...rejection,
      platform,
      platformStatus: platform.status,
      reason:
        platform.status === "blocked"
          ? `הפלטפורמה ${platform.name || platform.key} מסומנת כחסומה — הודעות ממנה אינן נקראות.`
          : `הפלטפורמה ${platform.name || platform.key} ממתינה לאישור. אחרי אישור אחד, כל ההזמנות ממנה ייקראו אוטומטית.`,
    };
  }

  // אין רשומה במרשם. אם בגוף ההודעה יש קישור להזמנה — זו פלטפורמה חדשה
  // שאיש לא ידע עליה, וזה בדיוק המצב שהמרשם נועד לתפוס.
  if (hasOrderLinks) {
    return {
      ...rejection,
      platformStatus: "unregistered",
      reason:
        "השולח אינו לקוח, אבל בהודעה יש קישור להזמנה — ייתכן שזו פלטפורמת הזמנות חדשה. " +
        "אישור הפלטפורמה יגרום לקריאה אוטומטית של כל ההזמנות ממנה.",
    };
  }

  return rejection;
};

const buildRejectionReason = (email, phone) => {
  const identifier = email || phone || "לא ידוע";
  return `השולח ${identifier} אינו לקוח במערכת. המערכת קוראת הזמנות רק מלקוחות קיימים.`;
};

/** מצב הרשימה — לתצוגה בדשבורד ולתחקור. */
const stats = async () => {
  await ensureLoaded();
  return {
    customerCount: cache.customerCount,
    emailCount: cache.emails.size,
    phoneVariationCount: cache.phones.size,
    loadedAt: new Date(cache.loadedAt),
    ttlMs: TTL_MS,
    enforcedChannels: [...ENFORCED_CHANNELS],
    domainCount: cache.domains.size,
    matchByDomain: MATCH_BY_DOMAIN(),
  };
};

module.exports = {
  isAllowedSender,
  refresh,
  stats,
  ENFORCED_CHANNELS,
};

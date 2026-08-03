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

const Customer = require("../../models/Customer");
const { canonicalPhone, phoneVariations } = require("../../utils/phone");
const { isSyntheticEmail } = require("./resolvers");

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

let cache = {
  emails: new Set(),
  phones: new Set(),
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

  customers.forEach((customer) => {
    // מייל סינתטי (wa-05...@whatsapp.local) נוצר על ידינו ללקוח ווצאפ בלי מייל.
    // הוא אינו כתובת אמיתית ואין טעם לאשר שליחה ממנו.
    if (customer.email && !isSyntheticEmail(customer.email)) {
      emails.add(String(customer.email).toLowerCase().trim());
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
    loadedAt: Date.now(),
    customerCount: customers.length,
  };

  console.log(
    `[whitelist] נטענו ${customers.length} לקוחות — ${emails.size} כתובות מייל, ${phones.size} ווריאציות טלפון`
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
 * האם השולח מאושר.
 *
 * @param {Object} sender - { email, phone }
 * @param {string} channel - "email" | "whatsapp" | "manual"
 * @returns {Promise<{allowed: boolean, matchedBy: string|null, reason: string|null}>}
 */
const isAllowedSender = async ({ sender = {}, channel } = {}) => {
  if (!ENFORCED_CHANNELS.has(channel)) {
    return { allowed: true, matchedBy: "channel-exempt", reason: null };
  }

  await ensureLoaded();

  const email = sender.email ? String(sender.email).toLowerCase().trim() : null;
  if (email && cache.emails.has(email)) {
    return { allowed: true, matchedBy: `email:${email}`, reason: null };
  }

  const phone = sender.phone ? String(sender.phone).trim() : null;
  if (phone) {
    // בדיקה מול כל הווריאציות של המספר שהתקבל, לא רק כפי שנכתב
    const candidates = [phone, canonicalPhone(phone), ...phoneVariations(phone)].filter(Boolean);
    const hit = candidates.find((c) => cache.phones.has(c));
    if (hit) {
      return { allowed: true, matchedBy: `phone:${hit}`, reason: null };
    }
  }

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
    return isAllowedSenderAfterRefresh({ email, phone });
  }

  return {
    allowed: false,
    matchedBy: null,
    reason: buildRejectionReason(email, phone),
  };
};

// בדיקה חוזרת אחרי רענון, בלי לרדת לרקורסיה נוספת
const isAllowedSenderAfterRefresh = ({ email, phone }) => {
  if (email && cache.emails.has(email)) {
    return { allowed: true, matchedBy: `email:${email}`, reason: null };
  }
  if (phone) {
    const candidates = [phone, canonicalPhone(phone), ...phoneVariations(phone)].filter(Boolean);
    const hit = candidates.find((c) => cache.phones.has(c));
    if (hit) return { allowed: true, matchedBy: `phone:${hit}`, reason: null };
  }
  return { allowed: false, matchedBy: null, reason: buildRejectionReason(email, phone) };
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
  };
};

module.exports = {
  isAllowedSender,
  refresh,
  stats,
  ENFORCED_CHANNELS,
};

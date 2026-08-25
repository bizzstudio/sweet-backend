// lib/link-follower/extractLinks.js
//
// איזה קישור במייל הוא ההזמנה.
//
// מייל של פלטפורמת הזמנות (Zestt וכל מי שיבוא אחריה) נראה כך: כותרת, כמה
// פרטים, כפתור אחד "לצפייה בהזמנה", ואחר כך פוטר עם חנויות האפליקציות,
// רשתות חברתיות והסרה מרשימת התפוצה. בגוף הטקסט אין שורות הזמנה בכלל —
// הן נמצאות רק מעבר לכפתור.
//
// לכן צריך לבחור. פתיחת **כל** הקישורים הייתה עולה זמן דפדפן על כל מייל,
// ומסוכנת מזה: "הסרה מרשימת תפוצה" הוא קישור שפתיחתו **מבצעת פעולה** —
// השרת שלנו היה מוריד את הלקוח מרשימת התפוצה של הפלטפורמה בעצמו.
//
// הניקוד כאן מכוון להיות שמרני: עדיף לא לפתוח כלום ולהשאיר את ההודעה
// לטיפול אנושי, מאשר לפתוח קישור שלא היה צריך.

// טקסט הכפתור. זה האיתות החזק ביותר — הוא נכתב עבור בן אדם שצריך להבין
// לאן הוא לוחץ, ולכן הוא מתאר את היעד טוב יותר מכל דבר אחר במייל.
const ORDER_ANCHOR = [
  /לצפי[יה]ה?\s+בהזמנה/,
  /לצפי[יה]ה?\s+בהזמנות/,
  /צפ[הי]?\s+בהזמנה/,
  /לפרטי\s+ההזמנה/,
  /פרטי\s+ההזמנה/,
  /לצפי[יה]ה?\s+בפרטים/,
  /להזמנה\s+המלאה/,
  /לצפי[יה]ה?/,
  /לחץ\s+כאן\s+לצפי/,
  /view\s+(the\s+)?order/i,
  /open\s+(the\s+)?order/i,
  /order\s+details/i,
  /view\s+details/i,
  /see\s+order/i,
];

// נתיב בכתובת. איתות חלש יותר מטקסט הכפתור — הוא נכתב למחשב ולא לאדם —
// אבל הוא מה שנשאר כשהכפתור הוא תמונה בלי טקסט חלופי.
const ORDER_PATH = [
  /\/orders?\b/i,
  /\/order[-_]?(view|details|show)/i,
  /\/purchase[-_]?orders?\b/i,
  /\/po\/\d/i,
  /[?&](order|orderid|order_id|po|doc)=/i,
];

// ── מסמך שאינו הזמנה, גם כשהוא של אותו לקוח ──
//
// חשבונית או קבלה מכילות בדיוק את אותן שורות כמו ההזמנה, ולכן קריאתן מצליחה
// — ומייצרת **הזמנה שנייה לאותה הזמנה**. הכשל הזה גרוע מכשל קריאה: הוא נכנס
// למערכת בהצלחה, יורד ממנו מלאי, והוא מתגלה רק בהתחשבנות.
//
// זה גם המקום היחיד שבו הניקוד לא מספיק: "לצפייה בחשבונית" מקבל את אותם
// עשרה נקודות כמו "לצפייה בהזמנה", כי שתיהן "לצפייה ב...".
const NOT_AN_ORDER_DOC = [
  /חשבונית/,
  /קבלה/,
  /תעודת\s+משלוח/,
  /דוח\s+/,
  /כתב\s+כמויות/,
  /\binvoice/i,
  /\breceipt/i,
  /\bstatement/i,
  /credit\s*note/i,
];

const NOT_AN_ORDER_PATH = [
  /\/invoices?\b/i,
  /\/receipts?\b/i,
  /\/credit[-_]?notes?\b/i,
  /\/statements?\b/i,
];

// ── מה שלא נפתח בשום ניקוד ──
//
// הרשימה הזו קודמת לכל ניקוד חיובי, ובכוונה: קישור "הסרה מרשימת תפוצה"
// שבמקרה יושב על נתיב שמכיל /order יקבל ניקוד חיובי, ופתיחתו תבצע פעולה
// בשם הלקוח. חסימה מנצחת ניקוד, תמיד.
const NEVER_FOLLOW_ANCHOR = [
  /הסר[הת]?\s*(אותי)?\s*מרשימ[הת]/,
  /להסרה\s+מרשימת/,
  /ביטול\s+מנוי/,
  /הסרה\s+מהתפוצה/,
  /unsubscribe/i,
  /opt[-\s]?out/i,
  /manage\s+(your\s+)?preferences/i,
  /דווח\s+על\s+ספאם/,
  /מדיניות\s+פרטיות/,
  /privacy\s+policy/i,
  /terms/i,
  /תנאי\s+שימוש/,
  /להורדת\s+האפליקציה/,
  /download\s+(the\s+)?app/i,
];

const NEVER_FOLLOW_HOST = [
  /(^|\.)apps\.apple\.com$/i,
  /(^|\.)itunes\.apple\.com$/i,
  /(^|\.)play\.google\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)linkedin\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)youtube\.com$/i,
  /(^|\.)tiktok\.com$/i,
  /(^|\.)wa\.me$/i,
  /(^|\.)whatsapp\.com$/i,
  /(^|\.)waze\.com$/i,
  /(^|\.)google\.com$/i,      // "צפה במפה"
  /(^|\.)maps\.google\.[a-z.]+$/i,
];

const NEVER_FOLLOW_PATH = [
  /unsubscribe/i,
  /opt[-_]?out/i,
  /\/preferences?\b/i,
  /\/privacy\b/i,
  /\/terms\b/i,
  /\/(help|support|faq|contact)\b/i,
  // פיקסל מעקב ותמונות — נטענים ממילא ע"י הדפדפן, ואין בהם טקסט
  /\.(png|jpe?g|gif|svg|webp|css|js|ico|woff2?)($|\?)/i,
  /\/(open|pixel|track|beacon|click\.gif)\b/i,
];

const stripTags = (html) =>
  String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();

const decodeHref = (href) =>
  String(href || "")
    .trim()
    .replace(/&amp;/gi, "&")
    .replace(/^["']|["']$/g, "");

/**
 * מיזוג כתובות שהן אותה כתובת.
 *
 * ‏# בסוף, סלאש בסוף וסדר פרמטרים אינם מבדילים בין שני קישורים, אבל כן היו
 * גורמים לנו לפתוח את אותו דף פעמיים — בשני עמודים, כלומר בכפול זמן דפדפן.
 */
const normalizeKey = (url) => {
  try {
    const parsed = new URL(url);
    parsed.hash = parsed.hash === "#" ? "" : parsed.hash;
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.host}${path}${parsed.search}${parsed.hash}`.toLowerCase();
  } catch (_) {
    return String(url).toLowerCase();
  }
};

const anchorMatches = (patterns, text) => patterns.some((re) => re.test(text));

// ── תשובה למייל אינה הזמנה חדשה ──
//
// ‏stripQuotedReply חותך את הציטוט מהטקסט, אבל הקישורים מחולצים מה-HTML —
// ושם הציטוט נשאר. לקוח שעונה "תודה" על מייל הזמנה ישן שולח לנו בחזרה את
// כל המייל המקורי, כולל הכפתור. בלי הבדיקה הזו הצינור היה פותח את הקישור
// הישן, קורא את ההזמנה שכבר טופלה, ויוצר אותה **פעם שנייה**.
//
// העברה (Fwd) דווקא כן נשארת: "הלקוח העביר לנו את מייל ההזמנה" הוא מקרה
// שימוש אמיתי, ובו הכפתור הוא בדיוק מה שאנחנו רוצים.
const REPLY_SUBJECT = /^\s*(re|תגובה|תשובה)\s*[:\-]/i;

/**
 * חילוץ מועמדים מגוף מייל.
 *
 * @param {Object} input
 * @param {string} [input.html] - גוף ה-HTML של המייל, אם היה
 * @param {string} [input.text] - גוף הטקסט (נפילה: מייל טקסט בלבד)
 * @param {string} [input.subject] - נושא ההודעה. תשובה (Re:) אינה הזמנה חדשה
 * @param {number} [input.limit=3] - כמה מועמדים להחזיר
 * @returns {Array<{url: string, anchor: string, score: number, reason: string}>}
 *          מסודר מהמועמד הטוב לפחות טוב. רשימה ריקה = אין מה לפתוח.
 */
const extractOrderLinks = ({ html, text, subject, limit = 3 } = {}) => {
  if (subject && REPLY_SUBJECT.test(String(subject))) return [];

  const candidates = new Map();

  const consider = ({ url, anchor }) => {
    const href = decodeHref(url);
    if (!/^https?:\/\//i.test(href)) return; // mailto:, tel:, cid:, data:

    let parsed;
    try {
      parsed = new URL(href);
    } catch (_) {
      return;
    }

    const host = parsed.hostname.toLowerCase();
    const pathAndQuery = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    const anchorText = stripTags(anchor);

    // ── חסימות: קודמות לכל ניקוד ──
    if (NEVER_FOLLOW_HOST.some((re) => re.test(host))) return;
    if (NEVER_FOLLOW_PATH.some((re) => re.test(pathAndQuery))) return;
    if (anchorText && anchorMatches(NEVER_FOLLOW_ANCHOR, anchorText)) return;

    // חשבונית של הזמנה שכבר נכנסה תיקרא בהצלחה ותייצר הזמנה כפולה — ראה
    // NOT_AN_ORDER_DOC. חסימה ולא ניקוד שלילי, כי "לצפייה בחשבונית" מנצח
    // בניקוד בדיוק כמו "לצפייה בהזמנה".
    if (anchorText && anchorMatches(NOT_AN_ORDER_DOC, anchorText)) return;
    if (NOT_AN_ORDER_PATH.some((re) => re.test(pathAndQuery))) return;

    // ── ניקוד ──
    let score = 0;
    const reasons = [];

    if (anchorText && anchorMatches(ORDER_ANCHOR, anchorText)) {
      score += 10;
      reasons.push(`טקסט הכפתור "${anchorText.slice(0, 40)}"`);
    }
    if (ORDER_PATH.some((re) => re.test(pathAndQuery))) {
      score += 5;
      reasons.push("הנתיב בכתובת");
    }
    // כתובת עם מזהה ארוך היא כמעט תמיד קישור למסמך מסוים ולא לדף בית
    if (/[/=][a-z0-9._-]{12,}/i.test(pathAndQuery)) {
      score += 2;
      reasons.push("מזהה מסמך בכתובת");
    }
    // שורש הדומיין בלי נתיב הוא הלוגו או "לאתר שלנו" — לא הזמנה
    const hasPath = parsed.pathname.replace(/\/+$/, "").length > 0 || Boolean(parsed.search) || Boolean(parsed.hash);
    if (!hasPath) score -= 8;

    if (score <= 0) return;

    const key = normalizeKey(href);
    const existing = candidates.get(key);
    // אותה כתובת יכולה להופיע גם כתמונה וגם ככפתור. נשמר הניקוד הגבוה,
    // כלומר המופע שבו היה טקסט מסביר.
    if (!existing || existing.score < score) {
      candidates.set(key, {
        url: href,
        host,
        anchor: anchorText.slice(0, 120),
        score,
        reason: reasons.join(" + "),
      });
    }
  };

  // ── קישורים מתוך HTML ──
  //
  // אלה המועמדים האמיתיים: רק כאן יש טקסט כפתור לצד הכתובת. הביטוי סלחני
  // לגבי סדר המאפיינים ולגבי מרכאות, כי HTML של מייל נכתב בידי כל כלי דיוור
  // בעולם ואין בו אחידות.
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(String(html || ""))) !== null) {
    const attrs = match[1];
    const hrefMatch = attrs.match(/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!hrefMatch) continue;
    const href = hrefMatch[2] ?? hrefMatch[3] ?? hrefMatch[4] ?? "";
    consider({ url: href, anchor: match[2] });
  }

  // ── נפילה: כתובות בגוף טקסט ──
  //
  // מייל טקסט בלבד, או HTML שהכפתור בו נבנה ב-JavaScript. אין טקסט כפתור,
  // ולכן מועמד כזה ינצח רק אם הנתיב עצמו מספר שזו הזמנה.
  if (text) {
    const urlRe = /https?:\/\/[^\s<>"')\]]+/gi;
    let hit;
    while ((hit = urlRe.exec(text)) !== null) {
      consider({ url: hit[0].replace(/[.,;:]+$/, ""), anchor: "" });
    }
  }

  return [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, limit);
};

module.exports = { extractOrderLinks, normalizeKey };

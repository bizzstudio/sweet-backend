// lib/gmail-reader/parseMessage.js
//
// פירוק הודעת Gmail (מבנה MIME מקונן) לטקסט קריא + פרטי שולח + קבצים מצורפים.
//
// שלוש נקודות שדורשות תשומת לב:
//   1. מיילים מגיעים גם כ-text/plain וגם כ-text/html. מעדיפים plain; אם יש רק
//      HTML — ממירים אותו לטקסט בעצמנו (בלי להוסיף תלות חדשה).
//   2. הודעה עם תשובה/העברה כוללת את כל השרשור. חותכים את הציטוט כדי שה-LLM
//      לא יקרא הזמנה ישנה מתוך הציטוט ויצור אותה שוב.
//   3. הזמנות מלקוחות עסקיים מגיעות לפעמים כקובץ מצורף — Excel, ‏PDF או Word.
//      הקריאה עצמה יושבת ב-lib/attachment-reader, המשותף לכל הערוצים, והטקסט
//      שחולץ מצטרף לגוף ההודעה.

const { readAttachment } = require("../attachment-reader");
const { extractOrderLinks } = require("../link-follower/extractLinks");

const decodeBase64Url = (data) => {
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf8");
};

// שורת טבלה "פנימית" — שאין בתוכה טבלה מקוננת. רק בה מותר לשטח פסקאות בתוך
// תא, ורק כשיש בה לפחות שני תאים (כלומר טבלת נתונים "מוצר | כמות"). תא יחיד
// הוא טבלת עימוד (רוב מיילי ה-HTML בנויים כך), ושיטוח שלו היה מדביק הזמנה
// שנכתבה שורה-שורה לשורה אחת.
//
// [^<>]* ולא [^>]* בכל תגית: הקלט מגיע מכל שולח באינטרנט (הפירוק קורה לפני
// בדיקת הרשימה הלבנה), ו-"<tr<tr<tr..." בלי ">" גרם ל-[^>]* לסרוק עד סוף
// ההודעה מכל פתיחה — זמן ריבועי, עשרות שניות על 200KB.
const INNER_ROW_RE = /<tr\b[^<>]*>(?:(?!<\/?(?:tr|table)\b)[\s\S])*?<\/tr>/gi;
const BLOCK_BREAK_RE = /<br\b[^<>]*>|<\/(?:p|div|li|h[1-6])\s*>/gi;

// בתוך שורה פנימית כל התוכן הוא תאים, ולכן מספיק להחליף כל שבירה בשורה כולה
// ברווח — הגבולות בין התאים ובין השורות נשמרים ע"י </td> ו-</tr> בהמשך.
const flattenTableCells = (html) =>
  html.replace(INNER_ROW_RE, (row) => {
    const cells = row.match(/<t[dh]\b/gi) || [];
    return cells.length < 2 ? row : row.replace(BLOCK_BREAK_RE, " ");
  });

// המרת HTML לטקסט. לא מנוע רינדור — רק מה שצריך כדי שהזמנה תישאר קריאה:
// שבירות שורה במקומות הנכונות, טבלאות שנשארות בשורות, וישויות HTML מפוענחות.
const htmlToText = (html) => {
  if (!html) return "";

  // Outlook (וטבלה שהודבקה מ-Excel) עוטף כל תא ב-<p class=MsoNormal>.
  // בלי השיטוח, סוף הפסקה הופך לשבירת שורה *בתוך* התא — שם המוצר והכמות
  // נוחתים בשורות נפרדות והפרסר כבר לא רואה שורת "מוצר ⇥ כמות" (טריילוג, 11/2026).
  return flattenTableCells(html)
    // הסרת בלוקים שאינם תוכן
    // הסריקה נעצרת בפתיחה הבאה של אותה תגית — "<style" חוזר בלי סגירה היה
    // אחרת סורק עד סוף ההודעה מכל פתיחה (ריבועי, ראה INNER_ROW_RE)
    .replace(/<style\b(?:(?!<\/?style\b)[\s\S])*<\/style\s*>/gi, " ")
    .replace(/<script\b(?:(?!<\/?script\b)[\s\S])*<\/script\s*>/gi, " ")
    .replace(/<head\b(?:(?!<\/?head\b)[\s\S])*<\/head\s*>/gi, " ")
    // סוף תא בטבלה → מפריד, כדי ש"מוצר | כמות" לא יידבק
    .replace(/<\/t[dh]>/gi, "\t")
    // שבירות שורה
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    // שאר התגיות
    .replace(/<[^<>]*>/g, "") // [^<>] ולא [^>] — ראה INNER_ROW_RE
    // ישויות HTML נפוצות
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    // ניקוי רווחים
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

// תא כמות: מספר, ואחריו אולי יחידה קצרה בלי ספרות — "3 יח'", "1 שרוול מכל סוג"
// (טקדה). בלי ספרות ביחידה כדי ש"03-1234567" בטבלת חתימה לא ייחשב לכמות.
const QUANTITY_CELL_RE = /^\s*\d+(?:[.,]\d+)?(?:\s*[^\d\s][^\d]{0,24})?\s*$/;
const LETTER_RE = /[֐-׿a-z]/i;

/**
 * כמה שורות בטקסט נראות כמו שורת טבלה עם כמות: תא עם אותיות, ואחריו תא כמות.
 * זו הצורה ש-htmlToText נותן לשורת "מוצר | כמות". פיצול לפי טאב ולא regex על
 * השורה כולה — שורה ארוכה בלי טאב (HTML בשורה אחת) לא עולה כאן זמן ריבועי.
 */
const countTableQuantityRows = (text) =>
  String(text || "")
    .split("\n")
    .filter((line) => {
      if (!line.includes("\t")) return false;
      let seenName = false;
      for (const cell of line.split("\t")) {
        if (seenName && QUANTITY_CELL_RE.test(cell)) return true;
        if (LETTER_RE.test(cell)) seenName = true;
      }
      return false;
    }).length;

// תחילת הציטוט ב-HTML: Outlook (שולחן עבודה ו-OWA), Gmail ו-blockquote כללי.
// ב-plain הציטוט נחתך לפי טקסט ("____", "From:/Sent:"), אבל בגרסת ה-HTML של
// Outlook העברי אין שורת "____" ו"מאת:/נשלח:" אינם בסמנים — בלי החיתוך הזה
// טבלת ההזמנה הקודמת שבשרשור הייתה נקראת שוב כחלק מההזמנה החדשה.
const HTML_QUOTE_START_RE =
  /<div\b[^<>]*\bid=["']?(?:divRplyFwdMsg|appendonsend)\b|<div\b[^<>]*\bclass=["']?gmail_(?:quote|attr)\b|<blockquote\b|<div\b[^<>]*border-top:\s*solid\s*#(?:E1E1E1|B5C4DF)/i;

const cutHtmlQuote = (html) => {
  const at = html.search(HTML_QUOTE_START_RE);
  return at > 0 ? html.slice(0, at) : html;
};

/**
 * בחירת גוף ההודעה: plain או HTML מומר.
 *
 * ברירת המחדל נשארת plain. אבל כשההזמנה היא טבלה, חלק ה-plain שהשולח הפיק
 * (Outlook) או ש-mailparser גזר מה-HTML שובר כל תא לשורה משלו — "מוצר" בשורה
 * אחת, "5" בשורה אחרת — והזוגיות אובדת. ב-HTML השורה עדיין שלמה. לכן: אם ה-HTML
 * מכיל (לפני הציטוט) לפחות שתי שורות טבלה עם כמות, ויותר ממה שה-plain מכיל — עוברים אליו.
 */
const chooseBodyText = (plain, html) => {
  const plainText = String(plain || "").trim();
  if (!html) return plainText;
  if (!plainText) return htmlToText(html);
  if (!/<table\b/i.test(html)) return plainText;

  // רק החלק שהשולח כתב עכשיו: טבלה שקיימת רק בציטוט של תשובה משאירה את
  // ההתנהגות הקודמת — plain. חריג מכוון: כשההודעה *כולה* ציטוט (העברה בלי
  // מילה משלו, at === 0) לא חותכים — בדיוק כמו stripQuotedReply, שמחזיר את
  // הטקסט המלא כשהחיתוך משאיר כלום.
  const htmlText = htmlToText(cutHtmlQuote(html));
  const htmlRows = countTableQuantityRows(htmlText);
  if (htmlRows >= 2 && htmlRows > countTableQuantityRows(plainText)) return htmlText;
  return plainText;
};

/**
 * חיתוך ציטוט של תשובה/העברה.
 *
 * בלי זה, לקוח שעונה "כן תודה" על אישור הזמנה שולח לנו את כל ההזמנה המקורית
 * בציטוט — וה-LLM יקרא אותה כהזמנה חדשה.
 */
const stripQuotedReply = (text) => {
  if (!text) return "";

  const markers = [
    /^בתאריך .+ מאת .+:$/m,           // ציטוט בעברית של Gmail
    /^On .+ wrote:$/m,                  // ציטוט באנגלית של Gmail
    /^-{2,}\s*הודעה מקורית\s*-{2,}/m,
    /^-{2,}\s*Original Message\s*-{2,}/im,
    /^-{2,}\s*Forwarded message\s*-{2,}/im,
    /^_{10,}$/m,                        // מפריד של Outlook
    /^From:.*\nSent:.*$/m,              // כותרות ציטוט של Outlook
  ];

  let cutAt = text.length;
  for (const marker of markers) {
    const match = text.match(marker);
    if (match && match.index !== undefined && match.index < cutAt) {
      cutAt = match.index;
    }
  }

  // שורות שמתחילות ב-">" הן ציטוט — נסירן מהשארית
  const body = text.slice(0, cutAt);
  const withoutQuotes = body
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .trim();

  // אם החיתוך השאיר כמעט כלום, כנראה זיהינו מפריד בטעות — מחזירים את המקור
  return withoutQuotes.length >= 3 ? withoutQuotes : text.trim();
};

// חילוץ כתובת ושם מכותרת From: 'ישראל ישראלי <israel@example.com>'
const parseFromHeader = (fromHeader) => {
  const raw = String(fromHeader || "").trim();
  const angle = raw.match(/<([^>]+)>/);
  const email = (angle ? angle[1] : raw).trim().toLowerCase();
  let name = angle ? raw.slice(0, angle.index).trim() : "";
  // הסרת מרכאות עוטפות שגוגל מוסיפה לשמות
  name = name.replace(/^["']|["']$/g, "").trim();

  return { name: name || undefined, email: email || undefined, raw };
};

const getHeader = (headers, name) =>
  headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;

/**
 * סריקה רקורסיבית של חלקי ה-MIME.
 * אוספת את הטקסט, את ה-HTML ואת רשימת הקבצים המצורפים.
 */
const walkParts = (part, collected) => {
  if (!part) return;

  const mimeType = part.mimeType || "";
  const filename = part.filename || "";
  const body = part.body || {};

  // קובץ מצורף — יש לו filename ו-attachmentId
  if (filename && body.attachmentId) {
    collected.attachments.push({
      filename,
      mimeType,
      size: body.size,
      attachmentId: body.attachmentId,
    });
  } else if (mimeType === "text/plain" && body.data) {
    collected.plain.push(decodeBase64Url(body.data));
  } else if (mimeType === "text/html" && body.data) {
    collected.html.push(decodeBase64Url(body.data));
  }

  if (Array.isArray(part.parts)) {
    part.parts.forEach((child) => walkParts(child, collected));
  }
};

/**
 * פירוק הודעת Gmail מלאה.
 *
 * @param {Object} message - התוצאה של gmail.users.messages.get עם format:"full"
 * @param {Object} [options]
 * @param {Function} [options.fetchAttachment] - async (attachmentId) => Buffer,
 *        מוזרק מבחוץ כדי שהמודול הזה יישאר נקי מקריאות רשת
 * @param {Function} [options.canReadAttachments] - async (sender) => boolean.
 *        קריאת גיליון מצורף היא פרסור קובץ שהגיע מבחוץ (SheetJS), ולכן היא
 *        מותנית באישור השולח — בדיוק כמו הניתוח עצמו. בלי זה כל שולח באינטרנט
 *        יכול להזרים קובץ לפרסר, כי הרשימה הלבנה נבדקת רק בהמשך הצינור.
 * @returns {Promise<{subject: string, sender: Object, text: string, links: Array, attachments: Array, receivedAt: Date}>}
 */
const parseGmailMessage = async (message, { fetchAttachment, canReadAttachments } = {}) => {
  const headers = message?.payload?.headers || [];

  const subject = getHeader(headers, "Subject") || "";
  const sender = parseFromHeader(getHeader(headers, "From"));
  const dateHeader = getHeader(headers, "Date");

  const collected = { plain: [], html: [], attachments: [] };
  walkParts(message?.payload, collected);

  // גוף ההודעה: plain אם יש, אחרת HTML מומר
  let bodyText = chooseBodyText(collected.plain.join("\n"), collected.html.join("\n"));
  // נפילה אחרונה: snippet שגוגל מחזירה
  if (!bodyText) bodyText = message?.snippet || "";

  bodyText = stripQuotedReply(bodyText);

  // ── קישורי הזמנה ──
  //
  // כמו בקורא ה-IMAP: החילוץ נעשה מול ה-HTML הגולמי, כי htmlToText מסיר את
  // כל הכתובות. מייל של פלטפורמת הזמנות הוא מייל שההזמנה בו נמצאת מעבר
  // לכפתור, ובלי הכתובת אין לאן ללכת. ראה lib/link-follower.
  const links = extractOrderLinks({
    html: collected.html.join("\n"),
    text: bodyText,
    subject,
  });

  // ── קבצים מצורפים ──
  // הבדיקה נעשית פעם אחת לכל ההודעה, לפני שנוגעים בקובץ כלשהו
  const attachmentsAllowed = canReadAttachments ? await canReadAttachments(sender) : true;

  const attachmentSummaries = [];
  const attachmentTexts = [];

  for (const att of collected.attachments) {
    // ההורדה עצלה: Gmail מחזירה את הקובץ בקריאה נפרדת, ולכן היא נעשית רק אחרי
    // שכל הבדיקות עברו — סוג, רשימה לבנה וגודל.
    const { summary, text } = await readAttachment({
      filename: att.filename,
      mimeType: att.mimeType,
      size: att.size,
      allowed: attachmentsAllowed,
      fetchContent: fetchAttachment
        ? () => fetchAttachment(att.attachmentId)
        : undefined,
    });

    if (text) attachmentTexts.push(text);
    attachmentSummaries.push(summary);
  }

  const text = [bodyText, ...attachmentTexts].filter(Boolean).join("\n\n");

  return {
    subject,
    sender,
    text,
    links,
    attachments: attachmentSummaries,
    receivedAt: dateHeader
      ? new Date(dateHeader)
      : message?.internalDate
        ? new Date(Number(message.internalDate))
        : new Date(),
  };
};

module.exports = {
  parseGmailMessage,
  htmlToText,
  chooseBodyText,
  stripQuotedReply,
  parseFromHeader,
};

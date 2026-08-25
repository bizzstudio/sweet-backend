// lib/imap-reader/parseMessage.js
//
// פירוק הודעת מייל גולמית (RFC822) לטקסט קריא + פרטי שולח + קבצים מצורפים.
//
// ההבדל מ-lib/gmail-reader/parseMessage.js: שם קיבלנו מבנה JSON מקונן מ-Gmail API
// והיינו צריכים לטייל בו בעצמנו. כאן mailparser עושה את כל עבודת ה-MIME —
// קידודים, כותרות מקודדות (עברית ב-Subject), חלקים מקוננים וקבצים מצורפים.
//
// כל הכללים שמעבר לפירוק ה-MIME — חיתוך ציטוטים והמרת HTML לטקסט — משותפים
// לשני הערוצים ולכן מיובאים משם ולא משוכפלים. קריאת הקבצים המצורפים עצמה
// יושבת ב-lib/attachment-reader, המשותף גם לווצאפ.

const { simpleParser } = require("mailparser");

const { htmlToText, stripQuotedReply } = require("../gmail-reader/parseMessage");
const { readAttachment, isReadableAttachment } = require("../attachment-reader");
const { extractOrderLinks } = require("../link-follower/extractLinks");

/**
 * פירוק הודעה גולמית.
 *
 * @param {Buffer|string} source - ההודעה כפי שהתקבלה מהשרת (RFC822)
 * @param {Object} [options]
 * @param {Function} [options.canReadAttachments] - async (sender) => boolean.
 *        מחליט אם מותר לפרסר לקרוא גיליונות מצורפים. בלעדיו — מותר.
 * @returns {Promise<{subject: string, sender: Object, text: string, links: Array, attachments: Array, messageId: string, receivedAt: Date}>}
 */
const parseImapMessage = async (source, { canReadAttachments } = {}) => {
  // skipImageLinks מונע הפיכת תמונות מוטמעות לקישורים בגוף הטקסט. הוא **אינו**
  // מוציא אותן מרשימת הקבצים המצורפים — זה נעשה בהמשך לפי att.related.
  const parsed = await simpleParser(source, { skipImageLinks: true });

  const from = parsed.from?.value?.[0] || {};
  const sender = {
    name: from.name || undefined,
    email: from.address ? String(from.address).toLowerCase() : undefined,
    raw: parsed.from?.text || "",
  };

  // גוף ההודעה: טקסט אם יש, אחרת HTML מומר
  let bodyText = (parsed.text || "").trim();
  if (!bodyText && parsed.html) {
    bodyText = htmlToText(parsed.html);
  }
  bodyText = stripQuotedReply(bodyText);

  // ── קישורי הזמנה ──
  //
  // חייב לקרות **כאן** ולא בהמשך הצינור: ‏htmlToText מסיר את כל התגיות,
  // כלומר את כל הכתובות. מרגע שההודעה הפכה לטקסט, הכפתור "לצפייה בהזמנה"
  // הוא מילים בלי יעד — ומייל של פלטפורמה הוא בדיוק מייל שכל ההזמנה בו
  // נמצאת מעבר לאותו יעד. ראה lib/link-follower.
  const links = extractOrderLinks({
    html: parsed.html,
    text: bodyText,
    subject: parsed.subject,
  });

  // ── קבצים מצורפים ──
  //
  // קריאת גיליון היא הרצת קוד פרסור על קובץ שהגיע מבחוץ, ולכן היא מותנית
  // באישור השולח. הבודק מוזרק מבחוץ (canReadAttachments) ונקרא רק עכשיו,
  // כשכבר ידוע מי השולח — כך הרשימה הלבנה חלה גם על הקבצים ולא רק על הטקסט.
  // נבדק פעם אחת, ורק אם באמת יש גיליון לקרוא — לרוב המיילים אין
  let allowedPromise = null;
  const attachmentsAllowed = () => {
    if (!canReadAttachments) return Promise.resolve(true);
    if (!allowedPromise) allowedPromise = Promise.resolve(canReadAttachments(sender));
    return allowedPromise;
  };

  const attachmentSummaries = [];
  const attachmentTexts = [];

  for (const att of parsed.attachments || []) {
    // תמונה מוטמעת בחתימה (לוגו, קו מפריד) אינה קובץ מצורף מבחינת הלקוח.
    // בלי הסינון הזה כל מייל עסקי נראה כאילו צורפו אליו שלושה קבצים.
    if (att.related) continue;

    const filename = att.filename || "ללא שם";

    // הרשימה הלבנה נבדקת רק כשיש קובץ שבאמת נקרא — לרוב המיילים אין
    const allowed = isReadableAttachment(filename, att.contentType)
      ? await attachmentsAllowed()
      : true;

    const { summary, text } = await readAttachment({
      filename,
      mimeType: att.contentType,
      size: att.size ?? att.content?.length ?? 0,
      content: att.content,
      allowed,
    });

    if (text) attachmentTexts.push(text);
    attachmentSummaries.push(summary);
  }

  const text = [bodyText, ...attachmentTexts].filter(Boolean).join("\n\n");

  return {
    subject: parsed.subject || "",
    sender,
    text,
    links,
    attachments: attachmentSummaries,
    // Message-ID של התקן — יציב ולא משתנה, ולכן מזהה טוב למניעת כפילות.
    // trim חשוב: ה-externalId נבנה ממנו, וגם רווח אחד יוצר רשומה כפולה.
    messageId: (parsed.messageId || "").trim(),
    receivedAt: parsed.date || new Date(),
  };
};

module.exports = { parseImapMessage };

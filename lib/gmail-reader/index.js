// lib/gmail-reader/index.js
//
// סריקת תיבת המייל של החנות וקליטת הזמנות ממנה.
//
// אחרי שהודעה נקלטת היא מסומנת כנקראה ומתויגת בתווית ("נקלט למערכת").
// יש שתי שכבות הגנה מפני עיבוד כפול:
//   1. שאילתת החיפוש מוציאה הודעות שכבר תויגו.
//   2. externalId הייחודי במודל IncomingOrder (מזהה ההודעה ב-Gmail).
// שכבה 2 היא הקובעת — התיוג יכול להיכשל, ה-DB לא.

const { getGmailClient, isGmailConfigured } = require("./auth");
const { parseGmailMessage } = require("./parseMessage");
const { ingestMessage } = require("../order-ingestion");
const { isAllowedSender } = require("../order-ingestion/senderWhitelist");

// התווית שמסמנת "כבר טופל". נוצרת אוטומטית אם אינה קיימת.
const PROCESSED_LABEL = process.env.GMAIL_PROCESSED_LABEL || "נקלט למערכת";

// שאילתת Gmail לבחירת ההודעות לעיבוד.
// ברירת המחדל: כל מה שלא נקרא בתיבה, בלי ספאם/סל, בלי מה שכבר תויג.
const BASE_QUERY = process.env.GMAIL_ORDERS_QUERY || "is:unread in:inbox";

// מקסימום הודעות בסריקה אחת — מגן על עלות ה-LLM ועל זמן הריצה
const MAX_PER_RUN = Number(process.env.GMAIL_MAX_PER_RUN) || 20;

// מונע שתי סריקות במקביל (cron איטי + הרצה ידנית מהדשבורד)
let isRunning = false;

// מזהה התווית נשמר בזיכרון — הוא לא משתנה, ובלי המטמון הזה כל סריקה
// (כל 2 דקות) הייתה מבצעת קריאת labels.list מיותרת ל-Gmail API
let cachedLabelId = null;

/**
 * מציאת מזהה התווית, ויצירתה אם אינה קיימת.
 */
const ensureLabel = async (gmail, userId, labelName) => {
  if (cachedLabelId) return cachedLabelId;

  const { data } = await gmail.users.labels.list({ userId });
  const existing = data.labels?.find((l) => l.name === labelName);
  if (existing) {
    cachedLabelId = existing.id;
    return existing.id;
  }

  const created = await gmail.users.labels.create({
    userId,
    requestBody: {
      name: labelName,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
  });
  console.log(`[gmail] נוצרה תווית "${labelName}"`);
  cachedLabelId = created.data.id;
  return created.data.id;
};

/**
 * סריקה אחת של התיבה.
 *
 * @param {Object} [options]
 * @param {string} [options.query] - שאילתת Gmail חלופית (לבדיקות/הרצה ידנית)
 * @param {number} [options.max] - מקסימום הודעות
 * @param {boolean} [options.markProcessed=true] - לסמן ולתייג אחרי עיבוד
 * @returns {Promise<{scanned: number, ingested: number, results: Array}>}
 */
const pollOnce = async ({ query, max, markProcessed = true } = {}) => {
  if (isRunning) {
    console.log("[gmail] סריקה כבר רצה — מדלג");
    return { scanned: 0, ingested: 0, results: [], skipped: "already-running" };
  }

  isRunning = true;

  try {
    const { gmail, userId, method } = getGmailClient();

    const processedLabelId = markProcessed
      ? await ensureLabel(gmail, userId, PROCESSED_LABEL)
      : null;

    // הוצאת הודעות שכבר תויגו מהשאילתה
    const effectiveQuery = [
      query || BASE_QUERY,
      markProcessed ? `-label:"${PROCESSED_LABEL}"` : null,
    ]
      .filter(Boolean)
      .join(" ");

    const list = await gmail.users.messages.list({
      userId,
      q: effectiveQuery,
      maxResults: max || MAX_PER_RUN,
    });

    const messages = list.data.messages || [];
    if (!messages.length) {
      return { scanned: 0, ingested: 0, results: [] };
    }

    console.log(
      `[gmail] ${messages.length} הודעות לעיבוד (${method}, שאילתה: ${effectiveQuery})`
    );

    const results = [];
    let ingested = 0;

    for (const { id } of messages) {
      try {
        const { data: message } = await gmail.users.messages.get({
          userId,
          id,
          format: "full",
        });

        const parsed = await parseGmailMessage(message, {
          // אותה הגנה כמו במסלול ה-IMAP: לא מפרסרים קובץ משולח שאינו לקוח
          canReadAttachments: async (sender) => {
            try {
              const verdict = await isAllowedSender({ sender, channel: "email" });
              return verdict.allowed;
            } catch (err) {
              console.warn(`[gmail] בדיקת שולח לקובץ מצורף נכשלה: ${err.message}`);
              return false;
            }
          },
          fetchAttachment: async (attachmentId) => {
            const { data } = await gmail.users.messages.attachments.get({
              userId,
              messageId: id,
              id: attachmentId,
            });
            return Buffer.from(data.data, "base64url");
          },
        });

        if (!parsed.text || !parsed.text.trim()) {
          // מייל בלי טקסט (תמונה בלבד וכו') — אין מה לנתח.
          // מתייגים בכל זאת כדי שלא ייסרק בכל סריקה מחדש.
          console.log(`[gmail] הודעה ${id} ללא טקסט — מדלג`);
          results.push({ id, status: "no_text" });
        } else {
          const doc = await ingestMessage({
            channel: "email",
            externalId: `gmail:${id}`,
            text: parsed.text,
            subject: parsed.subject,
            sender: parsed.sender,
            // הכפתור "לצפייה בהזמנה" — הצינור יפתח אותו אם לא נקראו פריטים
            links: parsed.links,
            attachments: parsed.attachments,
            receivedAt: parsed.receivedAt,
          });

          ingested += 1;
          results.push({
            id,
            status: doc.status,
            invoice: doc.invoice,
            error: doc.error,
            incomingOrderId: doc._id,
          });
        }

        // סימון וטיוג — נעשה גם כשההודעה נכשלה בעיבוד, כי הכשל מתועד ב-DB
        // ובדשבורד. בלי זה אותה הודעה תיסרק ותשלח ל-LLM בכל סריקה.
        if (markProcessed) {
          await gmail.users.messages.modify({
            userId,
            id,
            requestBody: {
              addLabelIds: [processedLabelId],
              removeLabelIds: ["UNREAD"],
            },
          });
        }
      } catch (err) {
        // כשל בהודעה בודדת לא עוצר את הסריקה
        console.error(`[gmail] כשל בעיבוד הודעה ${id}: ${err.message}`);
        results.push({ id, status: "error", error: err.message });
      }
    }

    console.log(`[gmail] הסריקה הסתיימה: ${ingested}/${messages.length} נקלטו`);
    return { scanned: messages.length, ingested, results };
  } finally {
    isRunning = false;
  }
};

module.exports = {
  pollOnce,
  isGmailConfigured,
  ensureLabel,
  PROCESSED_LABEL,
  BASE_QUERY,
};

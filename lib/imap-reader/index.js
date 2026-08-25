// lib/imap-reader/index.js
//
// סריקת תיבת המייל של החנות בפרוטוקול IMAP וקליטת הזמנות ממנה.
//
// זו הדרך הפשוטה להתחבר לתיבה: משתמש + **סיסמת אפליקציה** של גוגל, בדיוק כמו
// שהפרויקט כבר עושה לשליחת מיילים ב-nodemailer. אין OAuth, אין טוקן שפג תוקף,
// ואין תלות בפרויקט ב-Google Cloud.
//
// דורש שאימות דו-שלבי יהיה מופעל בתיבה (בלעדיו גוגל לא מייצרת סיסמת אפליקציה),
// ושגישת IMAP תהיה פתוחה בהגדרות Gmail.
//
// ── מה מונע עיבוד כפול ──
//
// **externalId בלבד**, מבוסס Message-ID של ההודעה, עם אינדקס ייחודי במודל
// IncomingOrder. הוא נבדק בשלב המעטפות לפני שמורידים גוף הודעה כלשהו.
//
// הסריקה **אינה** מסתמכת על הדגל "נקרא". קודם היא כן, וזה איבד הזמנות: אדם
// שפתח מייל בג'ימייל לפני שהסריקה רצה סימן אותו כנקרא, והמערכת לא ראתה אותו
// לעולם. סימון כנקרא נשאר, אבל רק כאיתות לבני אדם — לא כזיכרון של המערכת.

require("dotenv").config();
const { ImapFlow } = require("imapflow");

const { parseImapMessage } = require("./parseMessage");
const { ingestMessage, isAlreadyIngested } = require("../order-ingestion");
const { isAllowedSender } = require("../order-ingestion/senderWhitelist");

const HOST = process.env.IMAP_HOST || "imap.gmail.com";
const PORT = Number(process.env.IMAP_PORT) || 993;
const MAILBOX = process.env.IMAP_MAILBOX || "INBOX";

// התיקייה שאליה מועתקת הודעה שטופלה. ב-Gmail תיקייה = תווית, כך שהעתקה לשם
// פשוט מוסיפה תווית להודעה. ערך ריק מבטל את התיוג (הסימון כנקרא נשאר).
const PROCESSED_MAILBOX =
  process.env.IMAP_PROCESSED_MAILBOX ?? process.env.GMAIL_PROCESSED_LABEL ?? "נקלט למערכת";

// מקסימום הודעות בסריקה אחת — מגן על עלות ה-LLM ועל זמן הריצה
const MAX_PER_RUN =
  Number(process.env.MAIL_MAX_PER_RUN) || Number(process.env.GMAIL_MAX_PER_RUN) || 20;

// ── חסם גיל ──
// תיבה אמיתית מכילה עשרות אלפי הודעות ישנות שלא נקראו. בלי החסם הזה הסריקה
// הראשונה הייתה מתחילה לעבד את כל הארכיון — כל הודעה היא קריאה בתשלום ל-LLM,
// ואף אחת מהן אינה הזמנה פתוחה. נסרקות רק הודעות מהימים האחרונים.
const SINCE_DAYS = Number(process.env.MAIL_SINCE_DAYS) || 2;

const sinceDate = () => new Date(Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000);

// מונע שתי סריקות במקביל (cron + הרצה ידנית מהדשבורד)
let isRunning = false;

/**
 * האם לסמן את ההודעה כנקראה ולתייג אותה "נקלט למערכת".
 *
 * הכלל: נוגעים רק בהודעה שבאמת טיפלנו בה.
 *
 *   unknown_sender — השולח אינו לקוח שלנו. ההודעה הזו לא שלנו בכלל: היא יכולה
 *                    להיות התראה של המערכת עצמה, מייל מספק, או שיחה פרטית.
 *                    תיוג "נקלט למערכת" הוא שקר, וסימון כנקרא עלול לגרום
 *                    לפספוס מייל חשוב.
 *   no_text        — לא הצלחנו לקרוא כלום (תמונה בלבד). אין לנו מה להצהיר.
 *   not_an_order   — הודעה מלקוח אמיתי שאינה הזמנה: שאלה, בירור, תלונה. היא
 *                    מחכה לתשובה **אנושית**, ולכן חייבת להישאר לא נקראה.
 *   platform_pending — פלטפורמת הזמנות שטרם אושרה. **לא נקלט כלום**: הקישור
 *                    לא נפתח וההזמנה לא נקראה, ולכן תווית "נקלט למערכת" היא
 *                    שקר, וסימון כנקרא מסתיר הזמנה אמיתית מהעיניים. הרשומה
 *                    כן קיימת ב-DB, ולכן סריקה חוזרת לא תיצור כפילות
 *                    (‏externalId ייחודי) — אין סיכון בהשארתה לא מסומנת.
 *
 * כל השאר (הזמנה נוצרה, או הזמנת שגיאה שמתועדת בדשבורד ונשלחה עליה התראה) —
 * טופל על ידינו, ולכן מסומן.
 */
const NOT_OURS_TO_TOUCH = new Set(["unknown_sender", "not_an_order", "platform_pending"]);
const shouldMarkProcessed = (outcome) => !NOT_OURS_TO_TOUCH.has(outcome);

// ברירת המחדל היא התיבה שכבר משמשת לשליחת מיילים (EMAIL_USER/EMAIL_PASS).
// סיסמת אפליקציה של גוגל אינה מוגבלת ל-SMTP — אותה סיסמה פותחת גם IMAP, ולכן
// אין צורך בסיסמה נפרדת לקריאה. IMAP_USER/IMAP_PASS נדרשים רק אם ההזמנות
// מגיעות לתיבה אחרת מזו ששולחת.
const getCredentials = () => ({
  user: process.env.IMAP_USER || process.env.EMAIL_USER,
  pass: process.env.IMAP_PASS || process.env.EMAIL_PASS,
});

// הכתובת שלנו עצמנו — משמשת לסינון מיילים שהמערכת שלחה וחזרו לתיבה
const ownAddress = () =>
  String(process.env.EMAIL_USER || getCredentials().user || "").toLowerCase().trim();

// האם קליטת המייל ב-IMAP מוגדרת (בלי לזרוק) — לשימוש בהפעלת ה-cron
const isImapConfigured = () => {
  const { user, pass } = getCredentials();
  return Boolean(user && pass);
};

/**
 * חיבור לתיבה. זורק שגיאה מפורשת אם אין תצורה.
 */
const connect = async () => {
  const { user, pass } = getCredentials();

  if (!user || !pass) {
    throw new Error(
      "קליטת מייל אינה מוגדרת. נדרשים EMAIL_USER ו-EMAIL_PASS (או IMAP_USER/IMAP_PASS לתיבה אחרת) בקובץ .env."
    );
  }

  const client = new ImapFlow({
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user, pass },
    // ImapFlow מדפיס ברירת מחדל לוג מפורט מאוד של כל פקודת IMAP
    logger: false,
    // בלי אלה, הזדהות שגויה תלויה על החיבור דקות ארוכות במקום להיכשל.
    // הסריקה רצה ב-cron כל 2 דקות — עדיף שתיפול מהר ותנסה שוב.
    greetingTimeout: 15 * 1000,
    connectionTimeout: 20 * 1000,
    // זהו זמן חוסר פעילות על ה-socket, ובין שתי פקודות IMAP אנחנו מעבדים
    // הודעה שלמה מול ה-DB. ערך נמוך היה מנתק אותנו באמצע עיבוד תקין.
    socketTimeout: 5 * 60 * 1000,
  });

  await client.connect();
  return client;
};

/**
 * מציאת התיקייה/תווית לסימון "כבר טופל", ויצירתה אם אינה קיימת.
 * כשל כאן אינו קריטי — מחזיר null והסריקה ממשיכה בלי תיוג.
 */
const ensureProcessedMailbox = async (client) => {
  if (!PROCESSED_MAILBOX) return null;

  try {
    const list = await client.list();
    if (list.some((box) => box.path === PROCESSED_MAILBOX)) {
      return PROCESSED_MAILBOX;
    }
    await client.mailboxCreate(PROCESSED_MAILBOX);
    console.log(`[imap] נוצרה תיקייה "${PROCESSED_MAILBOX}"`);
    return PROCESSED_MAILBOX;
  } catch (err) {
    console.warn(`[imap] לא ניתן להכין את התיקייה "${PROCESSED_MAILBOX}": ${err.message}`);
    return null;
  }
};

/**
 * חיפוש ההודעות לעיבוד.
 *
 * ברירת המחדל: מה שלא נקרא בתיבה **מהימים האחרונים בלבד** (ראה SINCE_DAYS).
 * אם הועברה שאילתה — משתמשים בתחביר החיפוש של Gmail דרך ההרחבה X-GM-RAW,
 * כך ש-`is:unread -category:promotions` עובד בדיוק כמו בממשק של Gmail.
 * גם אז חסם הגיל נשמר, כדי ששאילתה רחבה בטעות לא תגרור את כל הארכיון.
 */
const searchMessages = async (client, query) => {
  const since = sinceDate();

  if (query) {
    if (!client.capabilities.has("X-GM-EXT-1")) {
      throw new Error(
        "שאילתת חיפוש חופשית נתמכת רק בתיבות Gmail. הסר את query כדי לסרוק לפי חלון הימים."
      );
    }
    return (await client.search({ gmraw: query, since }, { uid: true })) || [];
  }

  // ── למה לא מסננים לפי "לא נקרא" ──
  //
  // הסינון הזה היה כאן, והוא איבד הזמנות: אדם שפתח את המייל בג'ימייל לפני
  // שהסריקה הספיקה לרוץ סימן אותו כנקרא, והמערכת כבר לא ראתה אותו לעולם.
  // בתיבה שאנשים עובדים בה זה קורה כל יום.
  //
  // "נקרא" הוא סימן של אדם, לא של המערכת. הסימן שהמערכת טיפלה בהודעה הוא
  // externalId ב-DB — הוא הסמכות היחידה למניעת כפילות, והוא נבדק בשלב המעטפות
  // לפני שמורידים משהו. לכן אפשר לסרוק את כל חלון הימים בלי לשלם על זה.
  return (await client.search({ since }, { uid: true })) || [];
};

/**
 * סריקה אחת של התיבה.
 *
 * @param {Object} [options]
 * @param {string} [options.query] - שאילתת Gmail חלופית (לבדיקות/הרצה ידנית)
 * @param {number} [options.max] - מקסימום הודעות
 * @param {boolean} [options.markProcessed=true] - לסמן כנקרא ולתייג אחרי עיבוד
 * @returns {Promise<{scanned: number, ingested: number, results: Array}>}
 */
const pollOnce = async ({ query, max, markProcessed = true } = {}) => {
  if (isRunning) {
    console.log("[imap] סריקה כבר רצה — מדלג");
    return { scanned: 0, ingested: 0, results: [], skipped: "already-running" };
  }

  isRunning = true;
  let client;

  try {
    client = await connect();

    const processedMailbox = markProcessed ? await ensureProcessedMailbox(client) : null;

    // הנעילה מבטיחה שלא נבחר תיבה אחרת באמצע העיבוד
    const lock = await client.getMailboxLock(MAILBOX);

    try {
      const allUids = await searchMessages(client, query);

      if (!allUids.length) {
        return { scanned: 0, ingested: 0, results: [] };
      }

      const perRun = max || MAX_PER_RUN;

      // ── שלב מקדים: סינון לפי מעטפת בלבד ──
      //
      // הודעה שבמכוון אינה מסומנת כנקראה (שולח לא מוכר, שיחה שאינה הזמנה)
      // חוזרת בכל סריקה עד שהיא יוצאת מחלון הימים. בלי השלב הזה היא נמשכת
      // **במלואה** ומפורקת מחדש כל שתי דקות — עשרות אלפי הורדות מיותרות ביום.
      // המעטפת היא כותרות בלבד, זולה בסדר גודל מגוף ההודעה.
      //
      // נבדק חלון רחב מהמכסה, כדי שהזמנה חדשה לא תידחק החוצה ע"י הודעות
      // שכבר נקלטו וממילא ידולגו.
      const candidates = allUids.slice(-(perRun * 5));

      const envelopes = [];
      for await (const msg of client.fetch(
        candidates,
        { uid: true, envelope: true },
        { uid: true }
      )) {
        envelopes.push({
          uid: msg.uid,
          messageId: (msg.envelope?.messageId || "").trim(),
          from: (msg.envelope?.from?.[0]?.address || "").toLowerCase().trim(),
        });
      }

      // הבדיקה מול ה-DB נעשית אחרי שהזרם נסגר, ולא בתוכו: המתנה ל-DB באמצע
      // זרם IMAP פתוח מעכבת את החיבור ועלולה להפיל אותו ב-socketTimeout.
      const fresh = [];
      let skippedKnown = 0;
      let skippedSelf = 0;

      for (const envelope of envelopes) {
        // ── מייל שאנחנו עצמנו שלחנו ──
        //
        // התיבה שנסרקת היא גם התיבה ששולחת: התראות "הזמנה דורשת השלמה",
        // אישורי הזמנה ואיפוסי סיסמה חוזרים אליה. בלי הסינון הזה כל התראה
        // שהמערכת שולחת נקלטת בחזרה כהודעה נכנסת — לולאה שרק גדלה.
        // הסינון על המעטפת, ולכן לא יורד גוף הודעה בכלל.
        if (envelope.from && envelope.from === ownAddress()) {
          skippedSelf += 1;
          continue;
        }

        if (envelope.messageId && (await isAlreadyIngested(`email:${envelope.messageId}`))) {
          skippedKnown += 1;
          continue;
        }
        fresh.push(envelope.uid);
      }

      // ההודעות החדשות ביותר קודם — אם יש פיגור, הזמנה טרייה נכנסת ראשונה
      const uids = fresh.slice(-perRun);

      console.log(
        `[imap] ${uids.length} הודעות לעיבוד ` +
          `(נמצאו ${allUids.length}, ${skippedKnown} כבר נקלטו, ${skippedSelf} מאיתנו, ` +
          `${MAILBOX}, ${SINCE_DAYS} ימים אחורה)`
      );

      if (!uids.length) {
        return { scanned: 0, ingested: 0, results: [], skippedKnown };
      }

      const results = [];
      let ingested = 0;

      for (const uid of uids) {
        try {
          const message = await client.fetchOne(
            String(uid),
            { source: true, envelope: true },
            { uid: true }
          );

          if (!message || !message.source) {
            results.push({ id: uid, status: "error", error: "ההודעה לא נמשכה מהשרת" });
            continue;
          }

          // קריאת גיליון מצורף היא פרסור של קובץ שהגיע מבחוץ (SheetJS), ולכן
          // היא מותנית ברשימה הלבנה — בדיוק כמו הניתוח עצמו. בלי זה כל שולח
          // באינטרנט יכול היה להזרים קובץ לפרסר, כי הרשימה נבדקת רק בהמשך
          // הצינור, אחרי הפירוק.
          const parsed = await parseImapMessage(message.source, {
            canReadAttachments: async (sender) => {
              try {
                const verdict = await isAllowedSender({ sender, channel: "email" });
                return verdict.allowed;
              } catch (err) {
                // כשל בבדיקה = לא קוראים. מוטב לאבד תוכן קובץ מאשר לפרסר אותו
                // בלי אישור; גוף ההודעה עצמו ממילא נקרא ונשמר.
                console.warn(`[imap] בדיקת שולח לקובץ מצורף נכשלה: ${err.message}`);
                return false;
              }
            },
          });

          // Message-ID עדיף על UID: הוא לא משתנה, וגם אם ההודעה תועבר בין
          // תיקיות היא לא תיקלט שוב.
          const messageId = parsed.messageId || message.envelope?.messageId;
          const externalId = messageId ? `email:${messageId}` : `imap:${MAILBOX}:${uid}`;

          // הודעה שכבר נקלטה בעבר — מדלגים בשקט.
          // רלוונטי בעיקר להודעות שאינן מלקוחות: הן במכוון אינן מסומנות
          // כנקראו, ולכן חוזרות בכל סריקה עד שהן יוצאות מחלון הימים.
          if (await isAlreadyIngested(externalId)) {
            results.push({ id: externalId, status: "already_ingested" });
            continue;
          }

          // ── מייל בלי טקסט קריא (תמונה/סריקה בלבד) ──
          //
          // גם הוא עובר בצינור, ובכוונה. אחרת נוצרות שתי בעיות:
          //   1. הזמנה שלקוח אמיתי שלח כתצלום פשוט נעלמת — אף אחד לא יודע עליה.
          //   2. בלי רשומה ובלי סימון כנקרא, ההודעה נמשכת מחדש בכל סריקה
          //      (כל 2 דקות) לאורך כל חלון הימים.
          // עם המעבר בצינור: שולח שאינו לקוח נעצר ברשימה הלבנה, ולקוח אמיתי
          // מקבל רשומת כשל גלויה ב"הזמנות שגויות".
          const hasText = Boolean(parsed.text && parsed.text.trim());
          const textForIngestion = hasText
            ? parsed.text
            : `[מייל ללא טקסט קריא — ייתכן שההזמנה נשלחה כתמונה או כקובץ סרוק]` +
              (parsed.subject ? `\nנושא: ${parsed.subject}` : "") +
              (parsed.attachments?.length
                ? `\nקבצים מצורפים: ${parsed.attachments.map((a) => a.filename).join(", ")}`
                : "");

          if (!hasText) {
            console.log(`[imap] הודעה ${uid} ללא טקסט קריא — נרשמת לטיפול`);
          }

          const doc = await ingestMessage({
            channel: "email",
            externalId,
            text: textForIngestion,
            subject: parsed.subject,
            sender: parsed.sender,
            attachments: parsed.attachments,
            // הכפתור "לצפייה בהזמנה" — הצינור יפתח אותו אם לא נקראו פריטים
            links: parsed.links,
            receivedAt: parsed.receivedAt,
          });

          const outcome = doc.status;
          if (doc.status !== "unknown_sender") ingested += 1;

          results.push({
            id: externalId,
            status: doc.status,
            hasText,
            invoice: doc.invoice,
            error: doc.error,
            incomingOrderId: doc._id,
          });

          // ── מה מסמנים ומה לא ──
          //
          // התיבה הזו היא תיבת הדואר של החנות, לא תור עבודה שלנו. מסמנים
          // כנקרא ומתייגים **רק** הודעה שבאמת טיפלנו בה. לגעת בהודעה שאינה
          // שלנו זה גם שקר (התווית אומרת "נקלט למערכת" כשלא נקלט כלום) וגם
          // מסוכן — סימון כנקרא מסתיר מייל מהעיניים שאמורות לראות אותו.
          if (markProcessed && shouldMarkProcessed(outcome)) {
            await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });

            if (processedMailbox) {
              // ב-Gmail העתקה לתיקייה = הוספת תווית. ההודעה נשארת ב-Inbox.
              try {
                await client.messageCopy(String(uid), processedMailbox, { uid: true });
              } catch (err) {
                console.warn(`[imap] כשל בתיוג הודעה ${uid}: ${err.message}`);
              }
            }
          } else if (markProcessed) {
            console.log(
              `[imap] הודעה ${uid} (${outcome}) — לא סומנה ולא תויגה, היא לא שלנו`
            );
          }
        } catch (err) {
          // כשל בהודעה בודדת לא עוצר את הסריקה
          console.error(`[imap] כשל בעיבוד הודעה ${uid}: ${err.message}`);
          results.push({ id: uid, status: "error", error: err.message });
        }
      }

      console.log(`[imap] הסריקה הסתיימה: ${ingested}/${uids.length} נקלטו`);
      return { scanned: uids.length, ingested, results };
    } finally {
      lock.release();
    }
  } finally {
    isRunning = false;
    if (client) {
      // logout סוגר את החיבור בנימוס; אם הוא נכשל, close מנתק בכוח
      await client.logout().catch(() => client.close());
    }
  }
};

/**
 * בדיקת חיבור בלי לעבד כלום — לשימוש בסקריפט הבדיקה ובדשבורד.
 */
const testConnection = async () => {
  const client = await connect();
  try {
    const mailbox = await client.mailboxOpen(MAILBOX, { readOnly: true });
    const unseen = (await client.search({ seen: false }, { uid: true })) || [];
    // אותו חיפוש שהסריקה עצמה עושה — כל חלון הימים, נקראו או לא
    const recent = (await client.search({ since: sinceDate() }, { uid: true })) || [];

    return {
      user: getCredentials().user,
      host: HOST,
      mailbox: MAILBOX,
      total: mailbox.exists,
      unread: unseen.length,
      sinceDays: SINCE_DAYS,
      // רק אלה ייסרקו בפועל — ההפרש מ-unread הוא הארכיון הישן שנחסם
      toScan: recent.length,
    };
  } finally {
    await client.logout().catch(() => client.close());
  }
};

module.exports = {
  pollOnce,
  isImapConfigured,
  testConnection,
};

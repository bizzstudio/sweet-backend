// lib/mail-reader/index.js
//
// בחירת ערוץ קליטת המייל. שני ערוצים נתמכים, ושניהם מזרימים את אותן הודעות
// לאותו צינור עיבוד (ingestMessage) — ההבדל הוא רק באופן ההתחברות לתיבה:
//
//   IMAP  — משתמש + סיסמת אפליקציה של גוגל. פשוט להגדרה, אין טוקן שפג תוקף.
//           זה הערוץ המומלץ לתיבת Gmail רגילה.
//   Gmail API — OAuth או חשבון שירות עם domain-wide delegation. נדרש בעיקר
//           כשמנהל הדומיין חוסם סיסמאות אפליקציה.
//
// הבחירה נעשית לפי מה שמוגדר ב-.env. אם שניהם מוגדרים, IMAP מנצח — הגדרת
// IMAP_PASS היא הצהרת כוונה מפורשת.

const imap = require("../imap-reader");
const gmailApi = require("../gmail-reader");

const getActiveChannel = () => {
  if (imap.isImapConfigured()) return "imap";
  if (gmailApi.isGmailConfigured()) return "gmail-api";
  return null;
};

const isMailConfigured = () => getActiveChannel() !== null;

const pollOnce = (options) => {
  const channel = getActiveChannel();

  if (channel === "imap") return imap.pollOnce(options);
  if (channel === "gmail-api") return gmailApi.pollOnce(options);

  throw new Error(
    "קליטת מייל אינה מוגדרת. נדרשים EMAIL_USER ו-EMAIL_PASS (סיסמת אפליקציה של גוגל) בקובץ .env."
  );
};

module.exports = {
  pollOnce,
  isMailConfigured,
  getActiveChannel,
};

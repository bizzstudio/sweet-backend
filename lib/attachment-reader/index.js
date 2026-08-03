// lib/attachment-reader/index.js
//
// קריאת קובץ מצורף — נקודה אחת לכל הערוצים.
//
// ── למה מודול משותף ──
//
// אותה החלטה בדיוק נדרשת בשלושה מקומות: סריקת IMAP, ‏Gmail API ו-webhook של
// הווצאפ. שלוש העתקות של "איזה סוג קובץ, האם השולח מאושר, האם הוא גדול מדי,
// ומה הודעת השגיאה" היו נפרדות זו מזו בגרסה הראשונה שנייה שנוספה — ואז
// PDF נקרא ב-IMAP ולא ב-Gmail, בלי שאיש שם לב. הכלל צריך להיות כתוב פעם אחת.
//
// ── סדר ההחלטה ──
//
//   1. סוג שאינו נקרא         → נרשם בלבד (ול-.doc הישן יש הסבר משלו)
//   2. השולח אינו מאושר       → לא נקרא. פרסור קובץ הוא הרצת קוד על קלט לא
//                                מהימן, ולכן הרשימה הלבנה חלה גם עליו
//   3. גדול מהמותר            → לא נקרא
//   4. אחרת                    → נקרא, וכשל בקובץ אינו מפיל את ההודעה
//
// הקבצים שנקראים: Excel/CSV, ‏PDF שנוצר במערכת, ו-Word (.docx).

const { spreadsheetToText, isSpreadsheet } = require("../spreadsheet-reader");
const { extractPdfText, isPdf } = require("../pdf-reader");
const { extractDocxText, isDocx, isLegacyDoc } = require("../docx-reader");

// גודל מקסימלי לקובץ מצורף שנקרא (מעליו רק נרשמות המטא-דאטה).
// השם ההיסטורי GMAIL_* נשמר — הוא כבר מוגדר בסביבות קיימות.
const MAX_ATTACHMENT_BYTES =
  Number(process.env.GMAIL_MAX_ATTACHMENT_BYTES) || 5 * 1024 * 1024;

/**
 * האם זה סוג קובץ שיש טעם להוריד ולנסות לקרוא.
 * ‏Gmail API מוריד קבצים בקריאה נפרדת, ולכן הוא צריך לדעת את זה **לפני**
 * ההורדה ולא אחריה.
 */
const isReadableAttachment = (filename, mimeType) =>
  isSpreadsheet(filename, mimeType) ||
  isPdf(filename, mimeType) ||
  isDocx(filename, mimeType);

/**
 * קריאת קובץ מצורף יחיד.
 *
 * @param {Object}   input
 * @param {string}   input.filename
 * @param {string}   [input.mimeType]
 * @param {number}   [input.size]         - הגודל המוצהר, לפני ההורדה
 * @param {Buffer}   [input.content]      - התוכן, כשהוא כבר בידינו (IMAP, ווצאפ)
 * @param {Function} [input.fetchContent] - async () => Buffer, להורדה עצלה (Gmail)
 * @param {boolean}  [input.allowed]      - האם השולח אישר את הרשימה הלבנה
 * @returns {Promise<{summary: Object, text: string}>}
 */
const readAttachment = async ({
  filename,
  mimeType,
  size = 0,
  content,
  fetchContent,
  allowed = true,
}) => {
  const name = filename || "ללא שם";
  const summary = { filename: name, mimeType, size, read: false };

  if (!isReadableAttachment(name, mimeType)) {
    // ‏.doc הישן הוא הפורמט הבינארי מ-2003, לא ZIP, ואינו נקרא. הוא מזוהה
    // בנפרד רק כדי שהאדמין יראה *למה* ומה לבקש מהלקוח.
    if (isLegacyDoc(name, mimeType)) {
      summary.error = "פורמט .doc ישן אינו נקרא — יש לשמור את המסמך כ-.docx";
    }
    return { summary, text: "" };
  }

  if (!allowed) {
    summary.error = "הקובץ לא נקרא — השולח אינו לקוח מאושר";
    return { summary, text: "" };
  }

  if (size > MAX_ATTACHMENT_BYTES) {
    summary.error = `הקובץ גדול מהמותר לקריאה (${size} bytes)`;
    return { summary, text: "" };
  }

  try {
    const buffer = content || (fetchContent ? await fetchContent() : null);
    if (!buffer) return { summary, text: "" };

    // הגודל המוצהר יכול להיות שגוי או חסר — בודקים שוב מול מה שהתקבל בפועל
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      summary.error = `הקובץ גדול מהמותר לקריאה (${buffer.length} bytes)`;
      return { summary, text: "" };
    }
    if (!summary.size) summary.size = buffer.length;

    let text = "";

    if (isPdf(name, mimeType)) {
      const pdf = await extractPdfText(buffer);
      text = pdf.text;
      // PDF סרוק או בעל גופן שבור: הטקסט שיוצא ממנו הוא ג'יבריש, ואסור
      // שייכנס לפרסר. עדיף שההזמנה תמתין לאדם מאשר שתיווצר שגויה.
      if (!pdf.readable) summary.error = pdf.reason;
      else if (pdf.reason) summary.note = pdf.reason;
    } else if (isDocx(name, mimeType)) {
      const docx = extractDocxText(buffer);
      text = docx.text;
      // מסמך שכולו תמונה, או ארכיון שאינו וורד — מגיע לאדם
      if (!docx.readable) summary.error = docx.reason;
    } else {
      text = spreadsheetToText(buffer);
    }

    if (text) {
      summary.read = true;
      return { summary, text: `--- קובץ מצורף: ${name} ---\n${text}` };
    }
  } catch (err) {
    // קובץ פגום לא מפיל את קליטת ההודעה — הטקסט של הגוף עדיין שווה עיבוד
    summary.error = err.message;
    console.log(`[attachment] כשל בקריאת ${name}: ${err.message}`);
  }

  return { summary, text: "" };
};

module.exports = {
  readAttachment,
  isReadableAttachment,
  MAX_ATTACHMENT_BYTES,
};

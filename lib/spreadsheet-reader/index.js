// lib/spreadsheet-reader/index.js
//
// המרת גיליון מצורף (Excel/CSV) לטקסט שה-tableParser יודע לקרוא.
//
// היה בתוך lib/gmail-reader/parseMessage.js, והוצא לכאן כששלושה ערוצים —
// IMAP, ‏Gmail API וווצאפ — נזקקו לאותה קריאה. גם `pdf-reader` ו-`docx-reader`
// יושבים בתיקיות משלהם, ולכן זו גם התבנית הקיימת.

const XLSX = require("xlsx");

// ── חתימות שמזהות את הקידוד ──
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);
const ZIP_SIG = Buffer.from([0x50, 0x4b]); // "PK" — xlsx/xlsm
const OLE_SIG = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]); // xls הישן

const startsWith = (buffer, sig) =>
  buffer.length >= sig.length && buffer.subarray(0, sig.length).equals(sig);

const isValidUtf8 = (buffer) => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
};

/**
 * באיזה קידוד לקרוא את הקובץ.
 *
 * ‏CSV אינו נושא הצהרת קידוד, ולישראל יש בדיוק שלוש אפשרויות נפוצות — ולכל
 * אחת מהן תשובה אחרת. קיבוע ערך יחיד שובר את שתי האחרות, ולכן זו בדיקה ולא
 * קבוע:
 *
 *   • BOM כלשהו      → לא מתערבים. הספרייה מזהה אותו לבד ועושה את זה נכון.
 *                       (זה המצב של "CSV UTF-8" מאקסל — הנפוץ ביותר.)
 *   • UTF-8 בלי BOM  → 65001. בלי זה הקובץ נקרא כ-latin1 ו"כמות" יוצא "××××ª".
 *   • לא UTF-8 תקין  → 1255, עברית של ווינדוס. זה מה ש"CSV (מופרד בפסיקים)"
 *                       של אקסל מייצר, וגם שם בלי זה יוצא ג'יבריש.
 *
 * ‏xlsx ו-xls הם פורמטים בינאריים שנושאים את הקידוד בתוכם — להם לא מעבירים
 * כלום, כדי לא לשנות התנהגות שעובדת.
 *
 * @returns {number|undefined} הערך ל-codepage, או undefined כשאין להתערב
 */
const detectCodepage = (buffer) => {
  if (
    startsWith(buffer, ZIP_SIG) ||
    startsWith(buffer, OLE_SIG) ||
    startsWith(buffer, UTF8_BOM) ||
    startsWith(buffer, UTF16LE_BOM) ||
    startsWith(buffer, UTF16BE_BOM)
  ) {
    return undefined;
  }

  return isValidUtf8(buffer) ? 65001 : 1255;
};

/**
 * המרת קובץ Excel/CSV מצורף לטקסט.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
const spreadsheetToText = (buffer) => {
  const codepage = detectCodepage(buffer);

  const workbook = XLSX.read(buffer, {
    type: "buffer",
    ...(codepage ? { codepage } : {}),
  });
  const chunks = [];

  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    // TSV שומר על מבנה העמודות בצורה שקריאה ל-LLM
    const tsv = XLSX.utils.sheet_to_csv(sheet, { FS: "\t", blankrows: false });
    if (tsv.trim()) {
      chunks.push(`--- גיליון: ${sheetName} ---\n${tsv.trim()}`);
    }
  });

  return chunks.join("\n\n");
};

const isSpreadsheet = (filename, mimeType) =>
  /\.(xlsx|xlsm|xls|csv)$/i.test(filename || "") ||
  /spreadsheet|excel|csv/i.test(mimeType || "");

module.exports = {
  spreadsheetToText,
  isSpreadsheet,
  detectCodepage,
};

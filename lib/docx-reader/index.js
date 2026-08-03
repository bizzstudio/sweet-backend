// lib/docx-reader/index.js
//
// חילוץ טבלת הזמנה מקובץ Word (.docx) מצורף.
//
// ── למה זה קל יותר מ-PDF ──
//
// בניגוד ל-PDF, שהוא הוראות ציור ושחזור הטבלה ממנו הוא ניחוש לפי קואורדינטות,
// ‏.docx הוא ZIP שבתוכו XML שבו הטבלה מפורשת: <w:tbl> → <w:tr> → <w:tc>. אין
// כאן מה לשחזר — התאים כתובים בקובץ, וכל מה שנדרש הוא להעביר אותם ל-tableParser
// באותו פורמט שהוא כבר קורא: תא = טאב, שורה = שורה.
//
// שתי תוצאות נגזרות מזה:
//   1. אין בעיית ג'יבריש. הטקסט ב-.docx הוא Unicode אמיתי, ולכן אין צורך
//      ב-looksReadable() שמגן על מסלול ה-PDF מפני גופן בלי טבלת תווים.
//   2. אין היפוך סוגריים. הטקסט שמור בסדר לוגי ולא ויזואלי, ולכן "(100 גרם)"
//      יוצא כמו שנכתב ולא כמו ש-fixMirroredBrackets נדרש לתקן ב-PDF.
//
// ── למה בלי ספרייה ──
//
// mammoth (הבחירה המקובלת) מוציא כל תא טבלה כפסקה נפרדת, כלומר כל תא בשורה
// משלו. זה בדיוק מה שהורס הזמנה: הכמות מתנתקת משם המוצר, ו-tableParser מקבל
// שורות של מספר בודד. כאן דרוש שליטה מלאה במיפוי תא→טאב, ולכן ה-XML נקרא
// ישירות. בונוס: קלט לא מהימן מפורסר בקוד שאנחנו רואים, בלי להוסיף תלות.
//
// ── הגנות על קלט מבחוץ ──
//
// הקובץ מגיע ממייל של לקוח. שתי ההגנות המהותיות הן תקרת ניפוח (zip bomb —
// קובץ 40KB שמתנפח לג'יגה) ודילוג על ZIP64. שאר הקובץ פשוט לא נקרא: רק
// word/document.xml מחולץ, ושום קובץ אחר בארכיון לא נפתח.

const zlib = require("zlib");

// חתימות ZIP
const EOCD_SIG = 0x06054b50; // End of Central Directory
const CD_SIG = 0x02014b50; // Central Directory entry
const LOCAL_SIG = 0x04034b50; // Local file header

const EOCD_MIN_SIZE = 22;
const MAX_ZIP_COMMENT = 0xffff;
const ZIP64_MARKER = 0xffffffff;

// תקרת הניפוח של document.xml. מסמך וורד אמיתי של הזמנה הוא עשרות KB;
// 20MB הוא כבר לא מסמך אלא ניסיון. הבדיקה נאכפת פעמיים: מול הגודל המוצהר
// בארכיון, ושוב ע"י zlib עצמו — כי הגודל המוצהר מגיע מאותו קובץ לא מהימן.
const MAX_XML_BYTES = Number(process.env.DOCX_MAX_XML_BYTES) || 20 * 1024 * 1024;

const DOCUMENT_ENTRY = "word/document.xml";

/**
 * איתור רשומת ה-EOCD, שממנה מתחיל כל פענוח של ZIP.
 * נסרק מהסוף, כי אחריה יכולה לבוא הערת ארכיון באורך משתנה.
 */
const findEocd = (buf) => {
  const earliest = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_ZIP_COMMENT);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= earliest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
};

/**
 * חילוץ קובץ יחיד מתוך ארכיון ZIP.
 *
 * @returns {Buffer|null} תוכן הקובץ, או null אם אינו קיים בארכיון
 * @throws כשהארכיון פגום, מנופח מדי, או ZIP64
 */
const readZipEntry = (buf, wanted) => {
  if (buf.length < EOCD_MIN_SIZE) throw new Error("הקובץ קטן מכדי להיות מסמך וורד");

  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("הקובץ אינו ארכיון ZIP תקין");

  const entries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  if (cdOffset === ZIP64_MARKER) throw new Error("ארכיון ZIP64 אינו נתמך");

  let p = cdOffset;

  for (let i = 0; i < entries; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) break;

    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLength);

    if (name === wanted) {
      if (localOffset === ZIP64_MARKER || compressedSize === ZIP64_MARKER) {
        throw new Error("ארכיון ZIP64 אינו נתמך");
      }
      if (uncompressedSize > MAX_XML_BYTES) {
        throw new Error(`תוכן המסמך גדול מהמותר (${uncompressedSize} bytes)`);
      }

      // הכותרת המקומית — ממנה נגזר היכן מתחיל התוכן עצמו. אורכי השם וה-extra
      // בה שונים לפעמים מאלה שבספריית המרכז, ולכן חובה לקרוא אותם משם.
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
        throw new Error("הארכיון פגום");
      }

      const localNameLength = buf.readUInt16LE(localOffset + 26);
      const localExtraLength = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const end = start + compressedSize;

      if (end > buf.length) throw new Error("הארכיון חתוך");

      const raw = buf.subarray(start, end);

      if (method === 0) return raw; // מאוחסן בלי דחיסה

      if (method === 8) {
        try {
          return zlib.inflateRawSync(raw, { maxOutputLength: MAX_XML_BYTES });
        } catch (err) {
          // ‏maxOutputLength תופס קובץ שהצהיר גודל קטן ומתנפח לגדול — הכותרת
          // מגיעה מאותו קובץ לא מהימן, ולכן זו ההגנה האמיתית. השגיאה של zlib
          // אנגלית וטכנית, ומי שקורא אותה הוא אדמין בדשבורד.
          throw new Error(
            err.code === "ERR_BUFFER_TOO_LARGE"
              ? `תוכן המסמך גדול מהמותר (מעל ${MAX_XML_BYTES} bytes)`
              : "לא ניתן לפרוס את המסמך — הקובץ פגום"
          );
        }
      }

      throw new Error(`שיטת דחיסה ${method} אינה נתמכת`);
    }

    p += 46 + nameLength + extraLength + commentLength;
  }

  return null;
};

const decodeEntities = (text) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    // אחרון בכוונה: אחרת "&amp;lt;" היה הופך ל-"<" במקום ל-"&lt;"
    .replace(/&amp;/g, "&");

/**
 * המרת document.xml לשורות טקסט בפורמט של tableParser.
 *
 * הכלל היחיד שחשוב: **תא טבלה מסתיים בטאב, שורת טבלה מסתיימת בשורה חדשה.**
 * ‏tableParser מזהה לבד איזו עמודה היא הכמות, ולכן אין צורך לסדר את העמודות —
 * רק לשמור על ההפרדה ביניהן. סדר התאים נשמר כפי שהוא בקובץ.
 *
 * טקסט נאסף אך ורק מתוך <w:t>. זה מוציא מהחשבון, בלי טיפול מיוחד, גם קודי
 * שדות (<w:instrText>) וגם טקסט שנמחק במעקב שינויים (<w:delText>) — שניהם
 * תגיות אחרות, ולכן פשוט לא נקראות.
 */
const xmlToText = (xml) => {
  const lines = [];

  let paragraph = "";
  let inText = false;

  // מחסניות ולא משתנים בודדים. טבלה בתוך תא של טבלה אחרת נדירה במסמך הזמנה,
  // אבל עם משתנה יחיד השורה הפנימית הייתה **דורסת** את השורה החיצונית — כלומר
  // הפריטים של השורה החיצונית היו נעלמים בשקט. עם מחסנית כל רמה עומדת בפני
  // עצמה, ושורות הטבלה הפנימית נפלטות כשורות נפרדות לפני החיצונית.
  const openRows = []; // לכל שורה פתוחה: מערך התאים שלה
  const openCells = []; // לכל תא פתוח: מערך הפסקאות שלו

  // פסקה שהסתיימה: בתוך תא היא חלק מהתא, מחוצה לו היא שורה בפני עצמה
  const flushParagraph = () => {
    const text = paragraph.replace(/[ \t]+$/, "").trim();
    paragraph = "";
    if (!text) return;

    if (openCells.length) {
      // בתוך תא, טאב **אינו** מפריד עמודות — העמודות כבר מוגדרות ע"י התאים.
      // בלי הנטרול הזה טאב שהוקלד בתוך תא היה מפצל אותו לשתי עמודות מדומות,
      // ומזיז את עמודת הכמות שהפרסר מזהה.
      openCells[openCells.length - 1].push(text.replace(/\t+/g, " "));
    } else {
      lines.push(text);
    }
  };

  const tagPattern = /<([^>]*)>/g;
  let match;
  let cursor = 0;

  while ((match = tagPattern.exec(xml)) !== null) {
    if (inText && match.index > cursor) {
      paragraph += decodeEntities(xml.slice(cursor, match.index));
    }
    cursor = tagPattern.lastIndex;

    const raw = match[1];
    if (!raw || raw[0] === "?" || raw[0] === "!") continue;

    const closing = raw[0] === "/";
    // תגית ריקה (<w:t/>). בלי הזיהוי הזה inText היה נתקע על true, וכל רווח
    // בין תגיות במסמך מודפס-יפה היה נספר כטקסט.
    const selfClosing = raw[raw.length - 1] === "/";
    const name = raw.replace(/^\//, "").split(/[\s/]/)[0];

    switch (name) {
      case "w:t":
        inText = !closing && !selfClosing;
        break;

      case "w:tab":
        // טאב מחוץ לטבלה הוא הפרדת עמודות של מי שיישר בלי טבלה — בדיוק המפריד
        // ש-tableParser מחפש, ולכן הוא נשמר. בתוך תא הוא מנוטרל ב-flushParagraph.
        if (!closing) paragraph += "\t";
        break;

      case "w:br":
      case "w:cr":
        if (!closing) flushParagraph();
        break;

      case "w:p":
        if (closing) flushParagraph();
        break;

      case "w:tc":
        if (closing) {
          flushParagraph();
          const parts = openCells.pop();
          // תגית סוגרת בלי פותחת (מסמך פגום) — מדלגים במקום לרשום תא ריק
          if (parts && openRows.length) {
            openRows[openRows.length - 1].push(parts.join(" "));
          }
        } else {
          flushParagraph(); // הגנה: פסקה פתוחה שלא נסגרה לפני התא
          openCells.push([]);
        }
        break;

      case "w:tr":
        if (closing) {
          const row = openRows.pop();
          if (row && row.some((cell) => cell !== "")) lines.push(row.join("\t"));
        } else {
          openRows.push([]);
        }
        break;

      default:
        break;
    }
  }

  flushParagraph();

  return lines.join("\n").trim();
};

/**
 * חילוץ טקסט מקובץ Word.
 *
 * @param {Buffer} buffer
 * @returns {{text: string, tables: number, readable: boolean, reason: string|null}}
 */
const extractDocxText = (buffer) => {
  const xmlBuffer = readZipEntry(buffer, DOCUMENT_ENTRY);

  if (!xmlBuffer) {
    // ‏ZIP תקין בלי word/document.xml — כלומר .odt, .pages או ארכיב ששמו שונה
    return {
      text: "",
      tables: 0,
      readable: false,
      reason: "הקובץ אינו מסמך Word (חסר word/document.xml)",
    };
  }

  const xml = xmlBuffer.toString("utf8");
  const text = xmlToText(xml);
  const tables = (xml.match(/<w:tbl[\s>]/g) || []).length;

  if (!text) {
    // מסמך בלי טקסט הוא כמעט תמיד מסמך שכולו תמונה — צילום הזמנה שהודבק
    // לתוך וורד. אין לנו OCR, ולכן הוא מגיע לאדם.
    return {
      text: "",
      tables,
      readable: false,
      reason: "אין טקסט במסמך — כנראה תמונה שהודבקה לתוך וורד",
    };
  }

  return { text, tables, readable: true, reason: null };
};

const isDocx = (filename, mimeType) =>
  /\.docx$/i.test(filename || "") ||
  /wordprocessingml\.document/i.test(mimeType || "");

// ‏.doc הישן (OLE בינארי מ-2003) הוא פורמט אחר לגמרי ואינו נקרא. הוא מזוהה
// בנפרד רק כדי שהאדמין יראה בדשבורד *למה* הקובץ לא נקרא, במקום שורה שקטה.
const isLegacyDoc = (filename, mimeType) =>
  /\.doc$/i.test(filename || "") || /^application\/msword/i.test(mimeType || "");

module.exports = {
  extractDocxText,
  isDocx,
  isLegacyDoc,
  xmlToText,
  readZipEntry,
};

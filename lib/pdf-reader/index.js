// lib/pdf-reader/index.js
//
// חילוץ טבלת הזמנה מקובץ PDF מצורף.
//
// ── למה זה לא טריוויאלי ──
//
// קובץ PDF אינו מבנה נתונים אלא הוראות ציור: "צייר את התו ג בנקודה (412,738)".
// אין בו שורות, אין עמודות ואין תאים — הטבלה קיימת רק בעין של הקורא. לכן
// המודול הזה משחזר אותה מהקואורדינטות: מקבץ מילים לשורות לפי גובה, ומפריד
// לעמודות לפי מרווחים אופקיים. הפלט הוא טקסט עם טאבים, בדיוק הפורמט
// ש-tableParser כבר יודע לקרוא.
//
// ── שני סוגי PDF ──
//
// 1. PDF שנוצר במערכת (ERP, וורד) — יש בו טקסט אמיתי. זה המקרה שעובד.
// 2. PDF סרוק, או PDF שהפונט שלו בלי טבלת ToUnicode — הטקסט יוצא ג'יבריש.
//    בקובץ אמיתי שנבדק כאן יצאו 934 תווים לטיניים ואפס תווים עבריים, כלומר
//    כל אות עברית קיבלה אות לטינית שגויה. **חובה לזהות את זה ולא להזין את
//    הג'יבריש לפרסר** — משם הוא היה הופך להזמנה עם פריטים מומצאים במקום להגיע
//    ללשונית "הזמנות שגויות".

const HEBREW_CHAR = /[֐-׿]/;

// גובה מקסימלי (בנקודות) שבו שני פריטי טקסט נחשבים לאותה שורה.
// ערך גדול מדי מדביק שתי שורות טבלה; קטן מדי מפצל שורה אחת לשתיים.
const ROW_TOLERANCE = 4;

// מרווח אופקי שמעליו שני פריטים הם תאים נפרדים ולא אותה מילה.
// מחושב יחסית לגובה הגופן כדי שיעבוד גם במסמך בגופן גדול או קטן.
const COLUMN_GAP_RATIO = 0.8;

const MAX_PAGES = Number(process.env.PDF_MAX_PAGES) || 10;

let pdfjsPromise = null;

// pdfjs-dist הוא ESM והפרויקט הוא CommonJS — טעינה דינמית, פעם אחת.
const loadPdfjs = () => {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsPromise;
};

/**
 * קיבוץ פריטי טקסט לשורות לפי הקואורדינטה האנכית.
 */
const groupIntoRows = (items) => {
  const rows = [];

  items.forEach((item) => {
    const row = rows.find((r) => Math.abs(r.y - item.y) <= ROW_TOLERANCE);
    if (row) {
      row.items.push(item);
      // ממוצע מתגלגל, כדי ששורה מעט משופעת לא תיסחף
      row.y = (row.y * (row.items.length - 1) + item.y) / row.items.length;
    } else {
      rows.push({ y: item.y, items: [item] });
    }
  });

  // מלמעלה למטה. ב-PDF ציר ה-Y עולה כלפי מעלה, ולכן סדר יורד.
  return rows.sort((a, b) => b.y - a.y);
};

/**
 * הרכבת שורת טקסט אחת מפריטיה, עם טאב בין תאים.
 *
 * המסמכים כאן בעברית, ולכן הסריקה היא מימין לשמאל: התא הימני ביותר הוא
 * הראשון. `tableParser` ממילא מזהה את עמודת הכמות לבד ולא מניח סדר, אבל
 * שמירת הסדר הוויזואלי עוזרת כשאדם קורא את מה שנקלט.
 */
// סוגריים ותווים מכוונים מתהפכים בחילוץ מטקסט RTL: "(100 גרם)" יוצא
// ") 100 גרם(". ההיפוך מבוצע רק בשורה שיש בה עברית, כדי לא לפגוע בשורה
// באנגלית שבה הסוגריים כבר נכונים.
const MIRRORED = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{" };

const fixMirroredBrackets = (line) => {
  if (!HEBREW_CHAR.test(line)) return line;
  return line.replace(/[()[\]{}]/g, (char) => MIRRORED[char]).replace(/\(\s+/g, "(");
};

const rowToText = (row) => {
  const sorted = [...row.items].sort((a, b) => b.x - a.x);

  let text = "";
  let previous = null;

  sorted.forEach((item) => {
    if (previous) {
      // המרווח נמדד מקצה התא הקודם (השמאלי) עד תחילת הנוכחי (הימני)
      const gap = previous.x - (item.x + item.width);
      const threshold = Math.max(item.height, 6) * COLUMN_GAP_RATIO;
      text += gap > threshold ? "\t" : " ";
    }
    text += item.str.trim();
    previous = item;
  });

  return fixMirroredBrackets(text.replace(/[ \t]+$/, ""));
};

/**
 * האם הטקסט שחולץ קריא בכלל.
 *
 * מסמך עסקי ישראלי שאין בו **אף אות עברית** אינו מסמך באנגלית — הוא מסמך
 * שהפונט שלו לא נפתח. זו ההגנה שמונעת מג'יבריש להפוך להזמנה.
 */
const looksReadable = (text) => {
  const stripped = String(text || "").replace(/\s/g, "");
  if (stripped.length < 20) return false;

  const hebrew = (stripped.match(/[֐-׿]/g) || []).length;
  const latin = (stripped.match(/[A-Za-z]/g) || []).length;

  // מסמך באנגלית לגיטימי — הרבה לטינית ואפס עברית זה בסדר רק אם אין בכלל
  // רמז לעברית. הסימן לג'יבריש הוא דווקא **הרבה** לטינית בלי שום עברית
  // במסמך שהגיע מלקוח ישראלי, ולכן הבדיקה שמרנית: אם יש עברית — קריא.
  if (hebrew > 0) return true;

  // בלי עברית: קריא רק אם זה נראה כמו אנגלית אמיתית ולא רצף אותיות אקראי.
  // מילים באנגלית אמיתית מכילות תנועות; ג'יבריש של פונט שבור כמעט ולא.
  const vowels = (stripped.match(/[aeiouAEIOU]/g) || []).length;
  return latin > 0 && vowels / latin > 0.2;
};

/**
 * חילוץ טקסט מקובץ PDF.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{text: string, pages: number, readable: boolean, reason: string|null}>}
 */
const extractPdfText = async (buffer) => {
  const pdfjs = await loadPdfjs();

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    // המסמך מגיע מבחוץ: בלי הרצת JavaScript משובץ ובלי בקשות רשת
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;

  try {
    const pageCount = Math.min(doc.numPages, MAX_PAGES);
    const pageTexts = [];

    for (let p = 1; p <= pageCount; p++) {
      const page = await doc.getPage(p);
      try {
        const content = await page.getTextContent();

        const items = content.items
          .filter((i) => i.str && i.str.trim())
          .map((i) => ({
            str: i.str,
            x: i.transform[4],
            y: i.transform[5],
            width: i.width || 0,
            height: i.height || Math.abs(i.transform[3]) || 10,
          }));

        if (items.length) {
          pageTexts.push(groupIntoRows(items).map(rowToText).join("\n"));
        }
      } finally {
        page.cleanup();
      }
    }

    const text = pageTexts.join("\n").trim();

    if (!text) {
      return { text: "", pages: doc.numPages, readable: false, reason: "אין טקסט בקובץ — כנראה סריקה" };
    }

    if (!looksReadable(text)) {
      return {
        text: "",
        pages: doc.numPages,
        readable: false,
        reason: "הטקסט בקובץ אינו קריא — הגופן חסר טבלת תווים (מסמך סרוק או מיוצא לא תקין)",
      };
    }

    return {
      text,
      pages: doc.numPages,
      readable: true,
      reason: doc.numPages > MAX_PAGES ? `נקראו ${MAX_PAGES} עמודים מתוך ${doc.numPages}` : null,
    };
  } finally {
    await doc.destroy();
  }
};

const isPdf = (filename, mimeType) =>
  /\.pdf$/i.test(filename || "") || /application\/pdf/i.test(mimeType || "");

module.exports = {
  extractPdfText,
  isPdf,
  looksReadable,
  groupIntoRows,
  rowToText,
  HEBREW_CHAR,
};

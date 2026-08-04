// lib/order-ingestion/tableParser.js
//
// פרסר פנימי דטרמיניסטי להזמנות מובנות. זה המנוע הראשי של קליטת ההזמנות.
//
// למה דטרמיניסטי ולא AI: הזמנה עסקית מגיעה כטבלה עם עמודת כמות ועמודת מוצר.
// לקריאת עמודה אין ניחוש — התוצאה זהה בכל הרצה, מיידית, בעלות אפס, וכל טעות
// ניתנת לאיתור בשורת קוד. נתוני הלקוחות גם לא יוצאים מהשרת.
//
// הפלט זהה במבנה לפלט של llm.js (extractOrder), כדי שהצינור לא יידע מי ניתח.
//
// ── מה הפרסר מזהה ──
//
// טבלה (מגיעה מ-parseMessage כשורות עם טאבים בין תאים):
//     6	חלב טרי בקרטון 1 ליטר
//     4	חלב דל לקטוז
//
// שורות מקבצות שאינן מוצרים ("כמות | כיבוד", "כמות | תחזוקה") — מדולגות.
// שורות רשימה חופשית ("2 מגשי תמרים", "- 3 שקיות פיסטוק") — נתמכות כנפילה.

const { extractQualifiers } = require("./qualifiers");

// מפרידי תאים אפשריים: טאב (מטבלת HTML), קו אנכי, או שלושה רווחים ויותר
const CELL_SEPARATOR = /\t+|\s*\|\s*|\s{3,}/;

// כמה מילים עוד נראות כשם מוצר. שם מוצר בקטלוג הוא קצר ("מגבות נייר ביתי
// שישייה" — ארבע מילים); משפט שיחה ארוך ממנו, וזה ההבדל שמונע ממנו להפוך
// לפריט כשאין בשורה כמות.
const MAX_WORDS_IN_ASSUMED_ITEM = 6;

// תקרה לשורות שהכמות שלהן הונחה, לכל הודעה.
//
// כל שורה כזו עולה חיפוש בקטלוג — כלומר קלט חיצוני (מסמך PDF ארוך, מייל עם
// נייר מכתבים) קובע כמה שאילתות DB יירוצו. התקרה הופכת את זה לחסום. הזמנה
// אמיתית שכולה שורות בלי כמות ומעל התקרה היא מקרה שלא נראה בשטח, ומה שמעבר
// לה מתועד כשורה מדולגת ולא נעלם.
const MAX_ASSUMED_ITEMS = 15;

// מילים שמסמנות שורת כותרת ולא מוצר
const HEADER_WORDS = new Set([
  "כמות", "מוצר", "פריט", "תאור", "תיאור", "שם", "מק\"ט", "מקט", "סה\"כ", "סהכ",
  "מחיר", "יחידה", "הערות", "הערה",
  "quantity", "qty", "product", "item", "description", "name", "sku", "total", "price",
]);

// כותרות מקבצות שראינו בהזמנות אמיתיות — קטגוריה בתוך הטבלה, לא מוצר
const SECTION_WORDS = new Set([
  "כיבוד", "תחזוקה", "משרד", "מטבח", "ניקיון", "שתייה", "מזון", "חד פעמי", "אחר", "שונות",
]);

// שורות שאינן חלק מההזמנה: פתיחה, סגירה, חתימה
//
// שים לב שאין כאן `\b` אחרי המילים העבריות: `\b` ב-JavaScript מוגדר מול `\w`
// שהוא ASCII בלבד, ולכן אחרי אות עברית הוא לא מתאים לעולם — הסינון היה נכשל
// בשקט. במקום זאת: או סוף שורה, או תו שאינו אות (רווח, פסיק, נקודתיים).
const BOILERPLATE_PATTERNS = [
  /^(?:בוקר טוב|צהריים טובים|ערב טוב|שלום|היי|הי|אהלן|תודה רבה|תודה|בברכה|בהצלחה|כל טוב|להתראות)(?:$|[^֐-׿\w])/i,
  /^(?:hi|hello|hey|thanks|thank you|regards|best regards|br)(?:$|[^\w])/i,
  // כותרת פתיחה של ההזמנה עצמה. נדרש מאז ששורה בלי כמות נקראת כפריט: בלעדיה
  // "הזמנה חדשה" הפך לשם מוצר לחיפוש, ומנוע ההתאמה מצא לו "אירוע שנה חדשה".
  //
  // ההתאמה היא לשורה **שלמה** ולא לתחילתה, בניגוד לשאר הדפוסים כאן. הסיבה:
  // "בבקשה חלב x3" היא שורת פריט תקפה, ודפוס תחילית היה מוחק אותה על הסף.
  /^(?:הזמנה|הזמנה חדשה|הזמנה נוספת|רשימה|רשימת קניות|בבקשה|נא לשלוח|אנא לשלוח)[:!.]?$/,
  // "לכבוד" לעולם אינו פותח שורת פריט, ולכן כאן תחילית מותרת
  /^לכבוד(?:$|[^֐-׿\w])/,
  /^-{2,}$/,
  /^_{2,}$/,
  /^https?:\/\//i,
  /^\d+\s*\/\s*\d+$/, // מספרי עמוד ("1/2")
];

const isBoilerplate = (line) => BOILERPLATE_PATTERNS.some((p) => p.test(line.trim()));

// מספר "נקי": כמות היא תמיד מספר בפני עצמו בתא, לא בתוך טקסט
const parseCleanNumber = (cell) => {
  const text = String(cell || "").trim();
  if (!text) return null;
  // מותר: "6", "2.5", "1,5", "3 יח'" — אסור: "200 גרם" (זו מידה, לא כמות)
  const match = text.match(/^(\d+(?:[.,]\d+)?)\s*(?:יח'?|יחידות|units?|pcs)?$/i);
  if (!match) return null;
  const value = Number(String(match[1]).replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : null;
};

// יחידות מידה ואריזה שראינו בעמודת הכמות של הזמנות אמיתיות.
// ₪ ו-ILS **אינם** כאן בכוונה — עמודת מחיר אינה עמודת כמות.
const QUANTITY_UNITS =
  "גרם|גר'?|ג'|קילו|ק\"ג|קג|kg|g|ליטר|ל'|מ\"ל|ml|l|מארז|מארזים|קופסא|קופסה|קופסאות|שקית|שקיות|חבילה|חבילות|יח'?|יחידות|units?|pcs";

/**
 * כמות עם יחידה: "300 גרם", "8 ק\"ג", "1 מארז".
 *
 * בהזמנות אמיתיות חלק משורות הטבלה כותבות משקל או אריזה בעמודת הכמות. הפרסר
 * המקורי דחה אותן, והשורה **נשמטה בשקט** — כלומר הלקוח הזמין 8 ק"ג בננות
 * ואף אחד לא ידע. עכשיו הכמות נקראת והיחידה נשמרת בנפרד, כדי שהמלקט יראה
 * אותה. הקוד עדיין אינו ממיר משקל לאריזות — זו החלטה של אדם.
 */
const parseQuantityWithUnit = (cell) => {
  const text = String(cell || "").trim();
  if (!text) return null;

  const bare = parseCleanNumber(text);
  if (bare !== null) return { quantity: bare, unit: null };

  const match = text.match(new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*(${QUANTITY_UNITS})$`, "i"));
  if (!match) return null;

  const value = Number(String(match[1]).replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return null;

  return { quantity: value, unit: match[2] };
};

const isHeaderCell = (cell) => {
  const normalized = String(cell || "")
    .toLowerCase()
    .replace(/["'`״׳:]/g, "")
    .trim();
  return HEADER_WORDS.has(normalized);
};

const isSectionCell = (cell) => {
  const normalized = String(cell || "")
    .toLowerCase()
    .replace(/["'`״׳:.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return SECTION_WORDS.has(normalized) || HEADER_WORDS.has(normalized);
};

/**
 * פיצול הטקסט לשורות תאים, ושמירת השורות שנראות כשורות טבלה.
 */
const splitRows = (text) =>
  String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim())
    .map((line) => ({
      raw: line,
      cells: line.split(CELL_SEPARATOR).map((c) => c.trim()).filter((c) => c !== ""),
    }));

/**
 * זיהוי עמודת הכמות.
 *
 * לא מניחים שהכמות ראשונה: בטבלת RTL סדר התאים במקור יכול להיות הפוך, ולקוחות
 * שונים בונים את הטבלה אחרת. במקום להניח — בודקים איזו עמודה היא *עקבית מספרית*
 * על פני כל השורות. זה גם מה שמבדיל טבלה אמיתית מטקסט מקרי.
 *
 * @returns {number|null} אינדקס העמודה, או null אם אין טבלה
 */
/**
 * האם העמודה נראית כמספר סידורי (1, 2, 3, ...) ולא ככמות.
 *
 * טבלה ממוספרת ("1 | 6 | חלב") מכילה שתי עמודות מספריות, והראשונה היא המונה
 * ולא הכמות. בלי ההבחנה הזו נבחרת עמודת המונה, וכל ההזמנה מקבלת כמויות
 * 1,2,3... — שגיאה שקטה שקשה לתפוס בעין.
 *
 * הזיהוי שמרני בכוונה: נדרשת סדרה עולה ברצף שמתחילה ב-1 ולפחות 3 שורות.
 * הוא מופעל רק כשקיימת עמודה מספרית חלופית, כדי שלא נפסול כמויות אמיתיות
 * שבמקרה יצאו 1,2,3.
 */
const looksLikeSerialColumn = (values) => {
  if (values.length < 3) return false;
  return values.every((v, i) => v === i + 1);
};

/**
 * האם העמודה היא קוד ולא כמות.
 *
 * בהזמנת רכש אמיתית ראינו עמודת "קוד פריט" שבה אותו ערך (400925) חוזר בכל
 * השורות. היא מספרית לחלוטין, ולכן זכתה על פני עמודת "כמות" האמיתית — וכל
 * ההזמנה יצאה עם כמות 400,925 ליחידה, בביטחון 0.95.
 *
 * ערך זהה בכל השורות אינו כמות. שלוש שורות ומעלה כדי לא לפסול הזמנה קטנה
 * שבמקרה כל הכמויות בה שוות.
 */
const looksLikeConstantCodeColumn = (values) => {
  if (values.length < 3) return false;
  return values.every((v) => v === values[0]);
};

// כותרות שמצהירות במפורש "זו עמודת הכמות"
const QUANTITY_HEADER = /^(?:כמות|כמויות|מס'? ?יחידות|יחידות|כמ'|qty|quantity|amount)$/i;

const normalizeHeader = (cell) =>
  String(cell || "").toLowerCase().replace(/["'`״׳:.]/g, "").replace(/\s+/g, " ").trim();

/**
 * אינדקס העמודה שכותרתה מצהירה "כמות", אם יש שורת כותרת כזו.
 * הצהרה מפורשת של הלקוח גוברת על כל ניחוש סטטיסטי.
 */
const findQuantityHeaderColumn = (rows) => {
  for (const row of rows) {
    const index = row.cells.findIndex((cell) => QUANTITY_HEADER.test(normalizeHeader(cell)));
    if (index !== -1) return index;
  }
  return null;
};

const detectQuantityColumn = (rows) => {
  const multiCellRows = rows.filter((r) => r.cells.length >= 2);
  if (multiCellRows.length < 2) return null;

  const columnCount = Math.max(...multiCellRows.map((r) => r.cells.length));
  const candidates = [];

  for (let col = 0; col < columnCount; col++) {
    let nonNumericText = 0;
    const values = [];

    multiCellRows.forEach((row) => {
      const cell = row.cells[col];
      if (cell === undefined) return;
      // לעניין *זיהוי* העמודה גם "300 גרם" נחשב כמות — אחרת טבלה שבה חלק
      // מהשורות במשקל לא הייתה מזוהה ככזו בכלל
      const parsed = parseQuantityWithUnit(cell);
      if (parsed !== null) values.push(parsed.quantity);
      else if (cell.length > 2) nonNumericText++;
    });

    // עמודת כמות צריכה להיות מספרית ברוב השורות, ולא להכיל בעיקר טקסט.
    // דורשים לפחות שתי שורות מספריות — שורה אחת יכולה להיות מקרית.
    if (values.length >= 2 && values.length >= nonNumericText) {
      candidates.push({ index: col, numeric: values.length, values });
    }
  }

  if (!candidates.length) return null;

  // ── 1. כותרת מפורשת גוברת ──
  const headerColumn = findQuantityHeaderColumn(rows);
  if (headerColumn !== null && candidates.some((c) => c.index === headerColumn)) {
    return headerColumn;
  }

  // ── 2. פסילת עמודות מונה ועמודות קוד — רק אם נשארת חלופה ──
  let usable = candidates;
  if (candidates.length > 1) {
    const filtered = candidates.filter(
      (c) => !looksLikeSerialColumn(c.values) && !looksLikeConstantCodeColumn(c.values)
    );
    if (filtered.length) usable = filtered;
  }

  // ── 3. מבין הנותרות: זו עם הכי הרבה ערכים מספריים, והראשונה במקרה של תיקו ──
  return usable.reduce((best, c) => (c.numeric > best.numeric ? c : best), usable[0]).index;
};

// תאי מנהלה שאינם חלק משם המוצר: ברקוד בין כוכביות, תאריך אספקה, וסכום כסף
const METADATA_CELL_PATTERNS = [
  /^\*[\d\s-]+\*$/,                                  // *880025*
  /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/,               // 09/04/26
  /^(?:ILS|USD|EUR|₪|\$|€)\s*[\d.,]+$/i,             // ILS 2.95
  /^[\d.,]+\s*(?:ILS|USD|EUR|₪|\$|€)$/i,             // 196.00 ₪
  // תא שכולו מספר. parseCleanNumber פוסל אפס ("000", "0.00") ולכן הוא דלף
  // לשם המוצר — "000 קוטג אישי 0.00". שם מוצר לעולם אינו מספר בלבד.
  /^\d+(?:[.,]\d+)?$/,
];

// גבול עליון לכמות ששוחזרה מתא מאוחד. שורת פריט בהזמנה סיטונאית לא מגיעה
// לסדר גודל כזה, ואילו מספרי עוסק מורשה, ברקודים ומספרי טלפון כן — ולכן
// המספר הגדול הוא הסימן שמדובר בשורת מנהלה ולא בפריט.
const MAX_MERGED_QUANTITY = 10000;

const isMetadataCell = (cell) => {
  const text = String(cell || "").trim();
  return METADATA_CELL_PATTERNS.some((p) => p.test(text));
};

/**
 * ניקוי שאריות מנהלה מתוך שם המוצר.
 *
 * בחילוץ מ-PDF הברקוד לא תמיד יושב בתא נפרד — אם המרווח בין העמודות היה קטן,
 * הוא מודבק לשם: "*880025* גבינה לבנה 5%". סינון ברמת התא לא תופס את זה,
 * ולכן מנקים גם ברמת המחרוזת.
 */
const stripMetadataTokens = (name) =>
  String(name || "")
    .replace(/\*[\d\s-]+\*/g, " ")        // *880025*
    .replace(/\s{2,}/g, " ")
    .trim();

const NOTE_HEADER = /^(?:הערות?|notes?|remarks?|comments?)$/i;

/**
 * אינדקס עמודת ההערות, אם הטבלה מצהירה עליה בכותרת.
 *
 * מזוהה רק לפי כותרת מפורשת ולא בניחוש: עמודה טקסטואלית נוספת יכולה להיות
 * גם שם מוצר בשפה שנייה או תיאור, וטעות כאן מוציאה טקסט מהשם.
 */
const findNoteColumn = (rows) => {
  for (const row of rows) {
    const index = row.cells.findIndex((cell) => NOTE_HEADER.test(normalizeHeader(cell)));
    if (index !== -1) return index;
  }
  return null;
};

// עמודת מק"ט. הזמנת רכש מ-ERP כמעט תמיד נושאת אותה, והיא המזהה החד-משמעי
// היחיד בשורה — שם מוצר הוא טקסט חופשי, מק"ט הוא מפתח.
//
// חשוב: המספר הזה אינו בהכרח המק"ט *שלנו*. לקוח עסקי מדפיס את קוד הפריט
// מהמערכת שלו, ובהזמנה אמיתית שנבדקה כאן הופיע 880025 שאינו קיים בקטלוג.
// לכן הוא נקלט בלבד, וב-resolveItems הוא משמש רק כשובר שוויון בין מועמדים
// שכבר נמצאו לפי השם — לעולם לא כחיפוש עצמאי. קוד זר פשוט לא יתאים לאיש
// ויתעלמו ממנו, במקום למשוך מוצר אקראי בעל אותו מספר.
const SKU_HEADER = /^(?:מקט|מק ט|קוד|קוד פריט|קטלוג|מספר פריט|sku|item code|catalog|code)$/i;

const findSkuColumn = (rows) => {
  for (const row of rows) {
    const index = row.cells.findIndex((cell) => SKU_HEADER.test(normalizeHeader(cell)));
    if (index !== -1) return index;
  }
  return null;
};

// ערך תא מק"ט. מותר מספר או קוד אלפאנומרי קצר; לא טקסט חופשי.
const parseSkuCell = (cell) => {
  const text = String(cell || "").trim().replace(/^\*|\*$/g, "");
  if (!text || text.length > 24) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(text)) return null;
  // "0" / "000" אינם מזהים אלא מציין ריק בטבלאות ERP
  if (/^0+$/.test(text)) return null;
  return text;
};

/**
 * ניתוח הזמנה מטבלה.
 * @returns {{items: Array, skipped: Array}|null} null אם לא זוהתה טבלה
 */
const parseTable = (rows) => {
  const quantityColumn = detectQuantityColumn(rows);
  if (quantityColumn === null) return null;

  const noteColumn = findNoteColumn(rows);
  const skuColumn = findSkuColumn(rows);

  const items = [];
  const skipped = [];
  let assumedCount = 0;

  rows.forEach((row) => {
    if (row.cells.length < 2) return;

    // ── שחזור כמות שנדבקה לשם ──
    //
    // הפרדת העמודות ב-PDF מבוססת על המרווח האופקי בין המילים, ולכן מרווח מעט
    // צר מהרגיל בשורה אחת מאחד שני תאים לאחד. בקובץ אמיתי שנבדק כאן זה קרה
    // בשורה אחת מתוך עשר: "אורז סוגת 1 ק\"ג 20" במקום "אורז סוגת 1 ק\"ג" ו-"20".
    //
    // מה שקרה אז הוא הגרוע ביותר האפשרי: לשורה לא הייתה עמודת כמות, היא נחשבה
    // לשורת כותרת ו**נשמטה בשקט**. ההזמנה נוצרה עם 9 פריטים מתוך 10, בביטחון
    // מלא, ובלי שום סימן שמשהו חסר — לא בהזמנה ולא בהודעה לעובד.
    //
    // כאן משוחזר המספר מסוף התא: הוא נלקח ככמות והשאר נשאר כשם. הבדיקה
    // מצומצמת בכוונה לשורה שבה עמודת הכמות *נעדרת לגמרי*, כי בשורה תקינה
    // מספר בסוף השם הוא חלק מהשם ("50 יחידות") ואסור לגעת בו.
    // שני התנאים נדרשו אחרי שהשחזור המציא פריט משורת הכותרת של המסמך:
    // "עוסק מורשה: 514882910 | מס. תיק ניכויים: 934771205" נקראה כמוצר
    // "מס. תיק ניכויים" בכמות 934,771,205. הזמנה שגויה בשקט היא בדיוק מה
    // שהשחזור הזה נועד למנוע, ולכן הוא חייב להיות צר יותר מהבעיה שהוא פותר.
    //
    //   1. השורה קצרה **בדיוק** עד עמודת הכמות — כלומר הכמות הייתה העמודה
    //      האחרונה ונדבקה לתא שלפניה. שורת מנהלה בראש המסמך קצרה בהרבה,
    //      ולכן נופלת מהתנאי.
    //   2. המספר סביר ככמות. מספר עוסק מורשה או ברקוד אינו כמות בהזמנה.
    const cells = [...row.cells];
    let mergedFrom = null;

    if (cells[quantityColumn] === undefined && cells.length === quantityColumn) {
      const lastIndex = cells.length - 1;
      const match = String(cells[lastIndex] || "").match(/^(.*[^\d\s])\s+(\d+(?:[.,]\d+)?)$/);
      const value = match ? parseCleanNumber(match[2]) : null;
      if (value !== null && value <= MAX_MERGED_QUANTITY) {
        cells[lastIndex] = match[1].trim();
        mergedFrom = match[2];
      }
    }

    const quantityCell = mergedFrom !== null ? mergedFrom : cells[quantityColumn];

    // שם המוצר נבנה מהתאים שאינם עמודת הכמות — ובלי תאים שהם מספר בלבד.
    // בטבלה ממוספרת המונה יושב בעמודה נפרדת, ובלי הסינון הזה הוא נדבק לשם
    // ("1 חלב טרי") ומרעיל את החיפוש בקטלוג.
    //
    // אותו היגיון חל על שאר עמודות המנהלה של הזמנת רכש: ברקוד, תאריך אספקה
    // ומחיר. בלעדיו השם שהגיע לחיפוש היה
    // "*880025* גבינה לבנה 5% (100 גרם) 09/04/26 ILS 2.95".
    const otherCells = cells.filter(
      (_, i) => i !== quantityColumn && i !== noteColumn
    );
    const textCells = otherCells.filter(
      (c) => parseCleanNumber(c) === null && !isMetadataCell(c)
    );
    const nameCells = textCells.length ? textCells : otherCells;
    const name = stripMetadataTokens(nameCells.join(" "));

    // ההערה של הלקוח ("צבע תכלת בלבד, לא טורקיז") היא הוראה מחייבת למלקט.
    // כשהיא נדבקת לשם היא גם מרעילה את החיפוש וגם הולכת לאיבוד.
    const columnNote = noteColumn === null ? null : (cells[noteColumn] || "").trim() || null;

    const parsedQuantity = parseQuantityWithUnit(quantityCell);
    const quantity = parsedQuantity ? parsedQuantity.quantity : null;

    // שורת כותרת או כותרת מקבצת: התא ה"מספרי" אינו מספר.
    // כך "כמות | כיבוד" ו-"כמות | תחזוקה" נופלות לכאן ולא הופכות למוצר.
    //
    // ההבחנה בין השתיים חשובה: שורה שנראית ככותרת נשמטת בצדק, אבל שורה שיש
    // בה שם שנראה כמוצר ואין בה כמות היא **פריט שאבד**. שתיהן נראו קודם
    // אותו הדבר בדוח, ולכן פריט חסר היה בלתי נראה.
    if (quantity === null) {
      if (name) {
        // ── מתי שורה בלי כמות היא באמת פריט שאבד ──
        //
        // המבחן הוא מבני ולא מילולי: שורת פריט אמיתית **מגיעה עד עמודת
        // הכמות** — יש לה תא שם, פשוט לא מספרי. שורות הכותרת של המסמך
        // ("לכבוד: | כתובת למשלוח:") ושורות הסיכום ("מחיר כולל | 1,235.80")
        // קצרות בהרבה ואינן מגיעות לעמודה הזו בכלל.
        //
        // בלי המבחן הזה כל מסמך היה מייצר ערימת התראות שווא, ואזהרה שמופיעה
        // תמיד היא אזהרה שאיש לא קורא — כלומר הפריט שבאמת אבד נבלע בתוכה.
        // בטבלה בת שתי עמודות המבחן המבני לבדו אינו מספיק — גם "תאריך:
        // 02/08/26 | טלפון: 09-8631220" מגיעה לעמודה השנייה. תווית עם
        // נקודתיים היא שדה מנהלה, לא שם מוצר.
        const looksLikeLabelledField = /\S\s*:/.test(name);

        const quantityCellExists = cells[quantityColumn] !== undefined;
        const isHeaderRow =
          isHeaderCell(cells[quantityColumn]) || isHeaderCell(name) || isSectionCell(name);
        const suspectedItem =
          quantityCellExists &&
          !isHeaderRow &&
          !looksLikeLabelledField &&
          name.length >= 4 &&
          // חייבות להיות אותיות. בשורה "טלפון: | 09-8631220" הנקודתיים יושבות
          // בתא הכמות ולא בשם, ולכן מבחן התווית לא תופס אותה — והמספר היה הופך
          // לשם מוצר לחיפוש.
          /[֐-׿a-z]/i.test(name);

        // שורת פריט בלי כמות = יחידה אחת. עד היום היא רק סומנה כ"ייתכן שפריט
        // לא נקלט" — כלומר הלקוח היה מקבל הזמנה בלי מה שביקש, והאזהרה נחה
        // בשדה שאיש לא רואה. התקרה — ראה MAX_ASSUMED_ITEMS.
        if (suspectedItem && assumedCount < MAX_ASSUMED_ITEMS) {
          assumedCount += 1;
          const { instruction } = extractQualifiers(name);
          items.push({
            rawName: name,
            quantity: 1,
            quantityAssumed: true,
            sourceSku: skuColumn === null ? null : parseSkuCell(cells[skuColumn]),
            unit: null,
            note: [columnNote, instruction].filter(Boolean).join(" | ") || null,
            sourceLine: row.raw.trim(),
          });
          return;
        }

        skipped.push({
          raw: row.raw,
          reason: suspectedItem
            ? "שורה עם שם מוצר אך בלי כמות — מעל תקרת השורות בלי כמות"
            : "אין כמות מספרית — שורת כותרת",
          suspectedItem,
        });
      }
      return;
    }

    if (!name) {
      skipped.push({ raw: row.raw, reason: "אין שם מוצר" });
      return;
    }

    if (isHeaderCell(name) || isSectionCell(name)) {
      skipped.push({ raw: row.raw, reason: "שורת כותרת" });
      return;
    }

    const { instruction } = extractQualifiers(name);

    items.push({
      rawName: name,
      quantity,
      // המק"ט כפי שהוא בהזמנה של הלקוח — מזהה מוצע, לא מחייב. ראה findSkuColumn.
      sourceSku: skuColumn === null ? null : parseSkuCell(cells[skuColumn]),
      // null = יחידות מוצר. ערך אחר ("גרם", "ק\"ג", "מארז") הוא מה שהלקוח כתב,
      // והוא מוצג למלקט. הקוד אינו ממיר משקל לאריזות.
      unit: parsedQuantity.unit,
      note: [columnNote, instruction].filter(Boolean).join(" | ") || null,
      // השורה המקורית — נדרשת כדי להחריג אותה מהערת ההזמנה
      sourceLine: row.raw.trim(),
    });
  });

  // טבלה שאין בה אף כמות מפורשת אינה טבלת הזמנה — ראה אותו נימוק ב-parseLines
  if (!items.some((i) => !i.quantityAssumed)) return null;

  return items.length ? { items, skipped } : null;
};

// שורת רשימה חופשית: "2 מגשי תמרים", "- 3 שקיות פיסטוק", "מגש תמרים x2", "תמרים - 4"
const LINE_PATTERNS = [
  { re: /^[-*•·]?\s*(\d+(?:[.,]\d+)?)\s*[xX*]?\s+(.{2,})$/, qtyFirst: true },
  { re: /^[-*•·]?\s*(.{2,}?)\s*[xX*]\s*(\d+(?:[.,]\d+)?)$/, qtyFirst: false },
  { re: /^[-*•·]?\s*(.{2,}?)\s*[-–:]\s*(\d+(?:[.,]\d+)?)$/, qtyFirst: false },
  // ── "מוצר 24 x" — ה-x שנדד לסוף השורה ──
  //
  // הלקוח כתב "חלב גד 1 ליטר x24", אבל ה-x הוא תו לטיני בתוך שורה עברית,
  // ובחילוץ מ-PDF הוא מוצב מחדש לפי כללי הכיווניות ונוחת בסוף: "חלב גד 1
  // ליטר 24 x". אף אחד מהדפוסים למעלה לא מתאים לצורה הזו, וכל הודעה בפורמט
  // הזה נדחתה כ"לא זוהו שורות פריט" — כלומר הזמנה שלמה שלא נקלטה.
  //
  // ה-x בסוף הוא העוגן שמונע פירוש שגוי: שורה שמסתיימת במספר בלבד ("חלב 3")
  // אינה נתפסת כאן, אלא בדפוס המקף שמעליו.
  { re: /^[-*•·]?\s*(.{2,}?)\s+(\d+(?:[.,]\d+)?)\s*[xX*]$/, qtyFirst: false },
];

/**
 * נפילה: רשימת פריטים שורה-שורה, בלי טבלה.
 * @returns {{items: Array, skipped: Array}|null}
 */
const parseLines = (rows) => {
  const items = [];
  const skipped = [];
  let assumedCount = 0;

  rows.forEach((row) => {
    const line = row.raw.trim();
    if (isBoilerplate(line)) {
      skipped.push({ raw: line, reason: "טקסט פתיחה/סגירה" });
      return;
    }

    for (const { re, qtyFirst } of LINE_PATTERNS) {
      const match = line.match(re);
      if (!match) continue;

      const quantityRaw = qtyFirst ? match[1] : match[2];
      const name = (qtyFirst ? match[2] : match[1]).trim();

      const quantity = Number(String(quantityRaw).replace(",", "."));
      if (!Number.isFinite(quantity) || quantity <= 0) continue;
      if (!name || isHeaderCell(name) || isSectionCell(name)) continue;

      // "קפה 200 גרם" — המספר שייך למידה ולא לכמות. אם השם שנשאר מתחיל
      // ביחידת מידה, הפירוק שגוי ומדלגים על הדפוס הזה.
      // (בלי `\b` — הוא לא עובד אחרי אות עברית; ראה ההערה על BOILERPLATE_PATTERNS)
      if (/^(?:גרם|גר'|ק"ג|קילו|ליטר|מ"ל|יחידות|יח')(?:$|[^֐-׿\w])/.test(name)) continue;

      const { instruction } = extractQualifiers(name);
      items.push({
        rawName: name,
        quantity,
        unit: null,
        note: instruction || null,
        sourceLine: line,
      });
      return;
    }

    // ── שורה בלי כמות = פריט אחד ──
    //
    // "הזמנה נוספת / 3 מגבות נייר / מתקן סבון" — מתקן הסבון נזרק כאן, כי לא
    // הייתה לידו ספרה. הלקוח ביקש מוצר והוא פשוט לא הגיע להזמנה. מי שכותב
    // שורת מוצר בלי מספר מתכוון לאחד.
    //
    // הסכנה ההפוכה היא שורת שיחה שהופכת לפריט ("הזמנה נוספת"). היא נחסמת
    // בשלושה מקומות: כאן נפסלות שורות שאינן נראות כשם מוצר, למטה נדרש שיהיה
    // בהודעה לפחות פריט אחד עם כמות מפורשת, ובהתאמה לקטלוג פריט שכמותו הונחה
    // ולא נמצא לו מוצר חוזר להיות שורה מדולגת במקום להפיל את ההזמנה.
    const wordCount = line.split(/\s+/).filter(Boolean).length;
    const looksLikeItemName =
      // שורה מרובת תאים היא שורת טבלה שהפרסר הטבלאי כבר ויתר עליה (למשל כשלא
      // זוהתה עמודת כמות). לקרוא אותה כשם מוצר אחד פירושו לחפש בקטלוג
      // "כמות<טאב>מוצר" — כלומר גם כותרת הטבלה הופכת לפריט. אותו מבחן משמש
      // ב-extractOrderNote כדי להבדיל שורת טבלה משורת טקסט.
      row.cells.length < 2 &&
      line.length > 2 &&
      wordCount <= MAX_WORDS_IN_ASSUMED_ITEM &&
      /[֐-׿a-z]/i.test(line) && // חייבות להיות אותיות: "0521234567" אינו מוצר
      !/\S\s*:/.test(line) && // "כתובת: ..." — שדה מנהלה, לא מוצר
      !isHeaderCell(line) &&
      !isSectionCell(line) &&
      // אותם דפוסים שמנקים נייר מכתבים מהערת ההזמנה — כתובת, טלפון, ח.פ,
      // "סה\"כ". שימוש חוזר בהם כאן חוסך היוריסטיקה שנייה שתסטה מהראשונה.
      !isDocumentMetadata(line) &&
      assumedCount < MAX_ASSUMED_ITEMS;

    if (looksLikeItemName) {
      assumedCount += 1;
      const { instruction } = extractQualifiers(line);
      items.push({
        rawName: line,
        quantity: 1,
        quantityAssumed: true,
        unit: null,
        note: instruction || null,
        sourceLine: line,
      });
      return;
    }

    if (line.length > 2) {
      skipped.push({ raw: line, reason: "לא זוהתה כמות בשורה" });
    }
  });

  // ── הודעה שכולה שורות בלי כמות אינה הזמנה ──
  //
  // בלי הסייג הזה כל הודעת ווצאפ קצרה ("שניה", "מתי מגיע?") הייתה נכנסת
  // כהזמנה בת פריט אחד. הכמות המפורשת היא מה שמבדיל רשימת קניות משיחה,
  // ולכן ההנחה "כמות 1" מצטרפת להזמנה קיימת ואינה יוצרת אחת.
  //
  // מוחזר null ולא רשימה ריקה: זה הערוץ שאומר לקורא "לא זיהיתי כאן הזמנה",
  // והוא מייצר בעצמו את ההסבר ואת ההבחנה בין שאלה לפורמט לא מוכר.
  if (!items.some((i) => !i.quantityAssumed)) return null;

  return items.length ? { items, skipped } : null;
};

/**
 * הערת ההזמנה: הטקסט החופשי שאינו טבלה ואינו נימוסים.
 * שם נמצאים דברים כמו "הזמנה למחר מוקדם בבוקר" — קריטי למלקט.
 */
// ── שורות שאינן הערה אלא נייר מכתבים ──
//
// הערת ההזמנה מגיעה למי שמלקט, וכל שורה בה היא שורה שהוא צריך לקרוא. מסמך
// עסקי פותח בשם החברה, בכתובתה ובמספר ההזמנה — מידע שכבר קיים במערכת ואינו
// אומר למלקט דבר. בהזמנה שנבדקה כאן ההערה הכילה שש שורות, ורק שתיים מהן היו
// באמת הוראות ("אספקה בין 07:00-11:00", "מוצרי חלב באריזה מקוררת נפרדת").
//
// ארבע שורות רעש לכל שתי שורות תוכן פירושן שאף אחד לא יקרא את ההערה, ואז
// גם ההוראה האמיתית תלך לאיבוד. לכן דווקא כאן ניקוי הוא מה שמשמר מידע.
//
// הסינון הוא של *צורה* ולא של תוכן: כל דפוס כאן מזהה מבנה של שדה מסמך.
// שים לב לגבול המילה: `\b` ב-JavaScript מוגדר מול `\w` שהוא ASCII בלבד, ולכן
// אחרי אות עברית הוא **לעולם לא מתאים**. הניסיון הראשון כאן נכתב עם `\b`,
// והתוצאה הייתה שכל הדפוסים העבריים נכשלו בשקט — שורות הטלפון ומספר ההזמנה
// המשיכו להופיע בהערה כאילו לא נכתב כאן דבר. זו אותה מלכודת שמתועדת למעלה
// ליד BOILERPLATE_PATTERNS.
const AFTER = "(?:$|[^֐-׿\\w])";

const DOCUMENT_METADATA_PATTERNS = [
  /בע["']?מ\s*$/,                                              // "מרכז מזון גולן בע"מ"
  /^(?:רח'|רחוב|שד'|שדרות|ת\.?ד\.?|קומה)\s/,                   // שורת כתובת
  new RegExp(`^(?:הזמנת רכש|הזמנה מספר|הצעת מחיר|חשבונית|תעודת משלוח|קבלה)${AFTER}`),
  new RegExp(`^(?:סה["']?כ|סהכ|מע["']?מ|מחיר כולל|לתשלום|הנחה)${AFTER}`),
  new RegExp(`^(?:אושר ע["']?י|חתימה|בכבוד רב|בברכה)${AFTER}`),
  // "מס." עם נקודה הוא הכתיב הנפוץ בטפסים ("מס. תיק ניכויים"), ובלי הנקודה
  // בתו האופציונלי השורה הזו שרדה את הסינון בהזמנה אמיתית.
  new RegExp(`^(?:עוסק מורשה|ח\\.?פ\\.?|מס[.'"]? ?(?:עוסק|ספק|תיק))${AFTER}`),
  new RegExp(`^(?:טלפון|פקס|נייד|מייל|דוא["']?ל|לידי|מהדורה|תנאי תשלום)${AFTER}`),
  /^ט\.?ל\.?ח\.?$/,                                            // "ט.ל.ח"
  /^(?:email|tel|fax|phone)\b/i,
];

const isDocumentMetadata = (line) => DOCUMENT_METADATA_PATTERNS.some((p) => p.test(line));

const extractOrderNote = (rows, items) => {
  // ההחרגה חייבת להיות לפי *השורה המקורית* ולא לפי שם המוצר: בפורמט רשימה
  // השורה היא "10 חלב 3% תנובה" ואילו שם המוצר הוא "חלב 3% תנובה" בלי הכמות.
  // השוואה לפי השם בלבד לא התאימה לאף שורה, וכל ההזמנה הועתקה להערה —
  // כלומר customer_note של ההזמנה הכיל שוב את כל הפריטים, כזבל למלקט.
  const itemLines = new Set(
    items
      .flatMap((item) => [item.sourceLine, item.rawName])
      .filter(Boolean)
      .map((v) => String(v).trim())
  );

  const noteLines = rows
    .filter((row) => {
      const line = row.raw.trim();
      if (!line || isBoilerplate(line)) return false;
      if (row.cells.length >= 2) return false; // שורת טבלה
      if (itemLines.has(line)) return false;
      if (isHeaderCell(line) || isSectionCell(line)) return false;
      if (isDocumentMetadata(line)) return false;
      // שורה שהיא רק מספר או תו בודד
      if (/^\d+$/.test(line) || line.length < 4) return false;
      // תווית ריקה ("הערות להזמנה:") — הכותרת של ההערה, לא ההערה עצמה.
      // התוכן שמתחתיה נשמר; רק השורה שאין בה דבר מלבד הכותרת מוסרת.
      if (/^[^:]{2,20}:$/.test(line)) return false;
      return true;
    })
    .map((row) => row.raw.trim());

  return noteLines.length ? noteLines.join(" | ").slice(0, 500) : null;
};

// ─────────────────────────────────────────────────────────────
//  "האם יש כאן בכלל ניסיון הזמנה"
// ─────────────────────────────────────────────────────────────
//
// הפרסר לא מצא פריטים. מה שנשאר הוא להכריע מה לעשות עם ההודעה, ולהכרעה הזו
// שתי טעויות אפשריות — ושתיהן יקרות:
//
//   • "זו לא הזמנה" על הזמנה בפורמט שאינו מוכר  →  הזמנה שאבדה בשקט.
//   • "דורש טיפול" על כל הודעת שיחה              →  מסך הקליטה מתמלא ב"שגיאה
//     בקריאה", כל שורה כזו גם שולחת מייל התראה, והמסך שנועד להציל הזמנות הופך
//     לרעש שאיש לא פותח. כלומר גם הטעות הזו מאבדת הזמנות — רק בדרך ארוכה יותר.
//
// המימוש הקודם שאל "האם ההודעה נראית שיחתית", ודרש לשם כך סימן שאלה מפורש.
// בווצאפ רוב השיחה נכתבת בלי סימן שאלה ("בסדר", "אני אשלח אחר כך"), ולכן כמעט
// כל הודעה נפלה לצד ה"דורש טיפול" — אלפי הודעות שיחה בתיבת הטיפול.
//
// לכן הכיוון התהפך: לא "האם זו שיחה" אלא **"האם יש ראיה חיובית להזמנה"**.
// בלי ראיה ההודעה נסגרת בשקט כ-not_an_order; עם ראיה היא עולה לעיני אדם.
// ההנחה שכל הודעה היא הזמנה-בכוח נכונה במייל, שאליו כותבים כדי להזמין, ושגויה
// בווצאפ — שבו מנהלים שיחה, וההזמנה היא המיעוט.

// הודעה בודדת ארוכה מזה אינה שיחה טיפוסית אלא בקשה מפורטת, וכזו נשלחת כדי
// להזמין. הסף נמוך יחסית בכוונה: הזמנה בטקסט חופשי ("תשלחו לי כמה חבילות
// מהתמרים שהיו בפעם הקודמת, לאירוע ביום חמישי…") אינה מכילה כמות מפורשת
// ואינה רשימה, ולכן זה הסימן היחיד שנשאר לה. הודעת שיחה באורך כזה נדירה.
const ORDER_ATTEMPT_MIN_LENGTH = 250;

// שורות תוכן מזה ומעלה, **בתוך הודעה אחת**, הן רשימה ולא משפט.
const ORDER_ATTEMPT_MIN_ROWS = 4;

// מספרים שאינם כמות.
//
// בלי הניכוי הזה "תודה, קיבלתי את 12345" ו-"נדבר ב-14:00" נספרים כראיה להזמנה,
// כלומר בדיוק הרעש שהבדיקה באה למנוע. הניכוי הוא של *צורה*: תאריך, שעה, רצף
// ספרות ארוך (טלפון / מספר הזמנה / ח.פ) וסכום כסף.
const NON_QUANTITY_NUMBER_PATTERNS = [
  // ── תאריך, בשני ניסוחים נפרדים ולא באחד ──
  //
  // הניסוח המאוחד `\d{1,4}[-.\/]\d{1,2}` בלע גם **כמות עשרונית**: "2.5 קילו
  // תמרים" נראה לו כתאריך, הספרות נוכו, והשורה נסגרה בשקט כהודעת שיחה. עסק
  // שמוכר במשקל כותב כמויות כאלה, ולכן הנקודה מחייבת שלושה חלקים כדי להיחשב
  // תאריך, בעוד לוכסן ומקף — שאינם מופיעים בכמות — מספיקים בשניים.
  /\d{1,2}\.\d{1,2}\.\d{2,4}/g, // 4.8.26
  /\d{1,4}[-\/]\d{1,2}(?:[-\/]\d{2,4})?/g, // 04/08/26, 4-8
  /\d{1,2}:\d{2}/g, // שעה
  // רצף של 5 ספרות ומעלה: טלפון, מספר הזמנה, ח.פ. כמות אמיתית קצרה מזה,
  // ולכן "1000 יחידות" שורד ואילו "קיבלתי את הזמנה 12345" מנוכה.
  /\d[\d\-]{4,}/g,
  /\d+(?:[.,]\d+)?\s*(?:₪|ש["']?ח|%)/g, // מחיר או אחוז
];

/**
 * האם נשאר בשורה מספר שיכול להיות כמות, אחרי ניכוי המספרים שאינם כמות.
 *
 * ‏ReDoS: דפוס המחיר מכיל `\d+` ואחריו סיומת שעשויה לא להתאים, ולכן שורה בת
 * עשרות אלפי ספרות הייתה גוררת נסיגה ריבועית. הקריאה מגיעה רק אחרי שנבדק
 * שההודעה קצרה מ-ORDER_ATTEMPT_MIN_LENGTH, אבל התלות הזו שקופה מדי מכדי
 * לסמוך עליה — הקיצוץ כאן הופך את הפונקציה לחסומה בעצמה.
 */
const hasQuantitySignal = (line) => {
  const stripped = NON_QUANTITY_NUMBER_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, " "),
    String(line).slice(0, ORDER_ATTEMPT_MIN_LENGTH * 2)
  );
  if (!/\d/.test(stripped)) return false;
  // מספר לבדו אינו הזמנה — "1" הוא תשובה לסקר. נדרשת מילה לצידו.
  return /[֐-׿A-Za-z]{2,}/.test(stripped);
};

// ── קובץ מצורף הוא ראיה, וגם קובץ שלא ידענו לקרוא ──
//
// לא רק אקסל ו-PDF. הזמנה שנשלחה כצילום של דף, או שהוכתבה כהקלטה קולית, מגיעה
// לצינור בלי מילה אחת של טקסט קריא — ובלי הכלל הזה היא נסגרת בשקט כ"הודעת
// שיחה". זה בדיוק המקרה שהצינור מגן עליו במפורש (ראה textForIngestion
// ב-incomingOrderController), ולכן כל קובץ נחשב ראיה.
//
// היוצאת מן הכלל היא מדבקה: היא לעולם אינה הזמנה, והיא נפוצה מספיק בשיחת
// ווצאפ כדי להחזיר לתיבת הטיפול בדיוק את הרעש שהבדיקה באה למנוע.
//
// ⚠ בלי `\b` אחרי "מדבקה": ‏`\b` ב-JavaScript מוגדר מול `\w` שהוא ASCII בלבד,
// ולכן אחרי אות עברית הוא **לעולם לא מתאים** — הניסוח הראשון כאן נכשל בשקט על
// "מדבקה.webp" ורק בדיקת ה-mimeType הצילה אותו. אותה מלכודת מתועדת ליד
// BOILERPLATE_PATTERNS ו-DOCUMENT_METADATA_PATTERNS.
const STICKER_FILENAME = /^(?:מדבקה|sticker)(?:$|[^֐-׿\w])/i;
// תחילית ולא התאמה מלאה: ווצאפ מוסיפה פרמטרים ("image/webp; codecs=...")
const STICKER_MIME = /^image\/webp/i;

const isOrderEvidenceAttachment = (att = {}) =>
  !STICKER_FILENAME.test(String(att?.filename || "")) &&
  !STICKER_MIME.test(String(att?.mimeType || ""));

/**
 * האם **הודעה בודדת** בנויה כמו הזמנה.
 *
 * ההפרדה להודעות היא העיקר כאן, לא פרט מימוש — ראה looksLikeOrderAttempt.
 */
const isOrderShapedMessage = (message) => {
  const text = String(message || "");
  if (text.length >= ORDER_ATTEMPT_MIN_LENGTH) return true;

  const contentRows = splitRows(text).filter((row) => !isBoilerplate(row.raw.trim()));
  if (contentRows.length >= ORDER_ATTEMPT_MIN_ROWS) return true;

  return contentRows.some((row) => hasQuantitySignal(row.raw));
};

/**
 * ראיה חיובית לכך שההודעה היא ניסיון הזמנה, גם כשלא נקרא ממנה אף פריט.
 *
 * ── למה הבדיקה היא לכל הודעה בנפרד ולא על הטקסט המשורשר ──
 *
 * רשומת ווצאפ אינה הודעה אחת אלא עד 40 הודעות שנצברו מאותו שולח, משורשרות
 * ב-rawText עם שורה חדשה בין כל אחת (ראה collectWhatsappMessage). בדיקה על
 * הטקסט המשורשר סופרת כל *תור בשיחה* כשורה ברשימה, ולכן חמש הודעות של
 * "מה שלומך" / "בסדר גמור" / "שניה" נראות כמו רשימת פריטים בת חמש שורות
 * ועולות לטיפול אנושי — כלומר בדיוק ההצפה שהבדיקה באה למנוע. אותו דבר קורה
 * לסף האורך: עשרים הודעות שיחה קצרות חוצות יחד 250 תווים.
 *
 * הזמנה אמיתית שפוצלה לכמה הודעות אינה נפגעת: היא מכילה כמות מפורשת לפחות
 * באחת מהן, ואז parseLines קורא אותה כהזמנה ולא מגיע לכאן בכלל.
 *
 * @param {Object} input
 * @param {string} input.text - הטקסט המלא (משמש כשאין פירוט הודעות)
 * @param {Array}  [input.rows] - הפלט של splitRows על text, אם כבר חושב
 * @param {Array}  [input.attachments] - סיכומי הקבצים שצורפו
 * @param {string[]} [input.segments] - ההודעות שנצברו, כל אחת בנפרד
 * @returns {boolean}
 */
const looksLikeOrderAttempt = ({ text, rows, attachments, segments } = {}) => {
  if ((attachments || []).some(isOrderEvidenceAttachment)) return true;

  const messages = (segments || []).map((s) => String(s || "")).filter((s) => s.trim());
  if (messages.length) return messages.some(isOrderShapedMessage);

  // אין פירוט הודעות (מייל, הרצה ידנית, או ווצאפ בלי צבירה) — הטקסט הוא ההודעה
  const full = String(text || "");
  if (full.length >= ORDER_ATTEMPT_MIN_LENGTH) return true;

  const contentRows = (rows || splitRows(full)).filter(
    (row) => !isBoilerplate(row.raw.trim())
  );
  if (contentRows.length >= ORDER_ATTEMPT_MIN_ROWS) return true;

  return contentRows.some((row) => hasQuantitySignal(row.raw));
};

/**
 * ניתוח הודעה בפרסר הפנימי.
 *
 * מחזיר את אותו מבנה כמו extractOrder ב-llm.js, כדי להיות תחליף שקוף.
 *
 * @param {Object} input
 * @param {string} input.text - גוף ההודעה (אחרי פירוק MIME והמרת HTML)
 * @param {string} [input.channel]
 * @param {Object} [input.sender]
 * @param {string} [input.subject]
 * @param {Array} [input.attachments] - ראה looksLikeOrderAttempt
 * @param {string[]} [input.segments] - ההודעות שנצברו, כל אחת בנפרד
 * @returns {Object} תוצאת ניתוח בפורמט של extractOrder
 */
const parseOrderText = ({ text, sender = {}, subject, attachments, segments } = {}) => {
  const rows = splitRows(text);

  if (!rows.length) {
    return {
      isOrder: false,
      notAnOrderReason: "ההודעה ריקה",
      certainNotOrder: true,
      customer: emptyCustomer(sender),
      delivery: emptyDelivery(),
      items: [],
      note: null,
      confidence: 0,
      parsedBy: "internal",
      method: "empty",
    };
  }

  // טבלה קודם — היא המבנה המדויק. רשימת שורות היא נפילה.
  const table = parseTable(rows);
  const result = table || parseLines(rows);

  if (!result) {
    // ── הבחנה קריטית כשה-AI כבוי ──
    //
    // ל-LLM יש הבנה סמנטית, ולכן "זו לא הזמנה" ממנו הוא שיפוט אמין. לפרסר
    // דטרמיניסטי אין: "לא מצאתי שורות עם כמות" יכול להיות גם שיחה תמימה
    // וגם **הזמנה אמיתית בפורמט שאינו מוכר לי**.
    //
    // ההכרעה נעשית לפי ראיה חיובית להזמנה ולא לפי "האם זו שיחה" — ההסבר
    // המלא, ומה שלא עבד קודם, נמצא ליד looksLikeOrderAttempt.
    const orderAttempt = looksLikeOrderAttempt({ text, rows, attachments, segments });

    return {
      isOrder: false,
      notAnOrderReason: orderAttempt
        ? "לא זוהו שורות פריט עם כמות — ייתכן שזה פורמט הזמנה שאינו מוכר למערכת"
        : "הודעת שיחה — אין בה פריטים, כמויות או קובץ הזמנה",
      // רק הודעה שיש בה ראיה להזמנה עולה לטיפול אנושי; השאר נסגרת בשקט
      certainNotOrder: !orderAttempt,
      customer: emptyCustomer(sender),
      delivery: emptyDelivery(),
      items: [],
      note: null,
      confidence: 0,
      parsedBy: "internal",
      method: "none",
    };
  }

  const method = table ? "table" : "lines";

  // ביטחון: טבלה עם עמודת כמות עקבית היא קריאה ודאית כמעט. רשימת שורות
  // מסתמכת על דפוסים ולכן פחות.
  const confidence = method === "table" ? 0.95 : 0.8;

  return {
    isOrder: true,
    notAnOrderReason: null,
    certainNotOrder: false,
    customer: emptyCustomer(sender),
    delivery: emptyDelivery(),
    items: result.items,
    note: extractOrderNote(rows, result.items),
    confidence,
    parsedBy: "internal",
    method,
    // לתחקור בדשבורד: מה דולג ולמה
    skippedRows: result.skipped,
    subject: subject || null,
  };
};

// פרטי הלקוח מגיעים מהערוץ (מספר השולח / תיבת השולח) ונפתרים ב-resolveCustomer.
// הפרסר לא מנחש אותם מהטקסט — זה היה מסוכן בדיוק כמו ב-LLM.
const emptyCustomer = (sender) => ({
  name: sender.name || null,
  lastName: null,
  phone: sender.phone || null,
  email: sender.email || null,
  businessName: null,
});

// כתובת: ללקוח עסקי קבוע היא הכתובת השמורה בכרטיס, ו-resolveDelivery נופל אליה.
const emptyDelivery = () => ({
  type: null,
  city: null,
  street: null,
  houseNumber: null,
  apartmentNumber: null,
  floor: null,
  entryCode: null,
  requestedDate: null,
  callOnArrival: null,
});

module.exports = {
  parseOrderText,
  detectQuantityColumn,
  parseTable,
  parseLines,
  splitRows,
  parseCleanNumber,
  extractOrderNote,
  looksLikeOrderAttempt,
  findSkuColumn,
  parseSkuCell,
};

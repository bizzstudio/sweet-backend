// lib/archive-orders/buildArchiveOrders.js
//
// יצירת הזמנות ארכיון מקובץ ההיסטוריה של ההנהח"ש.
//
// הקובץ מגיע כשורות מסמך — שורה אחת לכל מוצר בכל תעודת משלוח — וכאן הן
// מקובצות חזרה למסמכים ונשמרות כהזמנות בסטטוס "הזמנת ארכיון".
//
// ── מה הזמנת ארכיון היא, ומה היא איננה ──
//
// היא תיעוד של מה שכבר קרה: הסחורה יצאה, החשבונית הופקה בהנהח"ש. לכן היבוא
// **אינו** מוריד מלאי, אינו שולח מיילים, אינו מפיק תעודת משלוח ואינו נספר
// בדוחות ההכנסות — כל אלה כבר נעשו, מחוץ למערכת, ועשייתם שוב הייתה מכפילה
// את המספרים. ההחרגה עצמה נשענת על הסטטוס (utils/archiveStatus).
//
// שתי נגיעות מפורשות בצינורות הקיימים, ושתיהן במכוון:
//
//   * ‏logStatusChange **אינו** נקרא. הוא מפעיל את תעודת המשלוח האוטומטית
//     (ראה ההערה שם), כלומר קריאה לו הייתה מייצרת תעודה — ומשם חשבונית —
//     על סחורה שכבר חויבה. ‏statusHistory נכתב ישירות על המסמך במקום.
//
//   * המלאי אינו יורד. ‏handleProductQuantity אינו נקרא.
//
// ── הקיבוץ: מסמך, ורק בהיעדרו תאריך ──
//
// שתי תעודות משלוח באותו יום הן שתי הזמנות ולא אחת, ולכן מספר המסמך קודם
// לתאריך. שורות בלי מספר מסמך מקובצות לפי היום שלהן — זה הקירוב הטוב ביותר
// שאפשר לגזור מהן, והוא מסומן במפורש בהערת המערכת של ההזמנה.
//
// **סוג המסמך הוא חלק מהמפתח.** בהנהח"ש כל סדרה ממוספרת בנפרד, ולכן תעודת
// משלוח 5001 וחשבונית 5001 הן שני מסמכים שונים לגמרי. מיזוגן להזמנה אחת היה
// שופך שורות של מסמך אחד לתוך השני.
//
// ── מה הקיבוץ *אינו* עושה: זיהוי כפילות בין סוגי מסמכים ──
//
// אם הייצוא מכיל גם את תעודת המשלוח וגם את החשבונית שהופקה עליה, אותה סחורה
// מופיעה פעמיים בקובץ — ותהפוך לשתי הזמנות. אין דרך אמינה להסיק מהקובץ אילו
// שתי שורות הן אותה סחורה, וניחוש כאן היה מוחק מסמכים אמיתיים. לכן הפילוח
// לפי סוג מסמך מוחזר לתצוגה המקדימה, ומי שמעלה רואה את הכפילות ומצמצם את
// הייצוא. שתיקה עליה הייתה מכפילה את ההיסטוריה של הלקוח בשקט.

const Order = require("../../models/Order");
const { fetchCatalogBySku, lookupCatalog } = require("../../utils/catalogBySku");
const { normalizeSku } = require("../../utils/customerPriceList");
const { buildCartItem } = require("../order-ingestion/createOrder");
const { nextFreeInvoice } = require("../../utils/invoiceNumber");
const {
  ensureArchiveStatus,
  ARCHIVE_STATUS_HE,
} = require("../../utils/archiveStatus");
const { isSyntheticEmail } = require("../order-ingestion/resolvers");

// ‏buildCartItem בונה שורת עגלה מהמוצר המלא — כותרת, תמונה, קטגוריה, מלאי.
// ברירת המחדל של fetchCatalogBySku מביאה חמישה שדות בלבד, ושורה שנבנתה
// מהם הייתה מוצגת בלי שם ובלי תמונה בכל מסך שקורא את העגלה.
const CATALOG_SELECT =
  "_id sku productId title slug barcode image category prices stock isVatFree purchaseLimit weight";

const MAX_SAMPLES = 200;

// ── תקרות אורך, זהות ל-aggregateRows ──
//
// שני הנתיבים קוראים את **אותן שורות** מאותה בקשה, ותקרה שקיימת באחד ולא
// בשני פירושה ששורה נכנסת לפרופיל ולא לארכיון (או להפך) בלי הסבר.
//
// ‏MAX_DOC_NUMBER_LENGTH אינו קוסמטי: מספר המסמך נכנס ל-archive.sourceKey,
// שעליו יש אינדקס ייחודי. מונגו חוסם מפתח אינדקס מעל 1024 בתים, ומסמך עם
// מספר ארוך מדי היה **נדחה בשמירה** — כלומר מסמך שנכשל בלי סיבה נראית.
const MAX_NAME_LENGTH = 200;
const MAX_SKU_LENGTH = 64;
const MAX_DOC_NUMBER_LENGTH = 64;
const MAX_DOC_TYPE_LENGTH = 64;

// ‏$in ענק הוא מסמך שאילתה ענק — אותו שיקול בדיוק כמו ב-catalogBySku.
const KEY_CHUNK_SIZE = 500;

// ── תקרה על מספר ההזמנות בייבוא אחד ──
//
// כל הזמנה היא שמירה נפרדת עם הקצאת מספר אטומית, ולכן קובץ עם אלפי מסמכים
// הוא אלפי כתיבות בבקשת HTTP אחת. היקף אמיתי: לקוח שמזמין פעמיים בשבוע
// מגיע ל-104 מסמכים בשנה, כלומר שלוש שנים אחורה הן כ-300.
const MAX_ORDERS = 2000;

const isPrimitive = (value) =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const toText = (value) => (isPrimitive(value) ? String(value).trim() : "");

const toNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (!isPrimitive(value)) return null;
  const cleaned = toText(value).replace(/[^\d.,-]/g, "").replace(/,/g, "");
  if (!/\d/.test(cleaned)) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
};

// ‏ISO בלבד, מאותו נימוק בדיוק כמו ב-customerHistoryController.toDate:
// ‏Date.parse **כן** יודע לקרוא "05/06/2026" — בסדר האמריקאי, כלומר 6 במאי
// במקום 5 ביוני. כאן זה חמור אף יותר מאשר בפרופיל: התאריך הזה הופך ל-createdAt
// של ההזמנה, כלומר ליום שבו היא תוצג בכרטיס הלקוח ובכל סינון תאריכים.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]|$)/;

const toDate = (value) => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" || !ISO_DATE_RE.test(value.trim())) return null;
  const time = Date.parse(value.trim());
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  return date.getUTCFullYear() >= 1990 && date.getUTCFullYear() <= 2200 ? date : null;
};

// היום כפי שנכתב בקובץ. ‏UTC ולא שעון מקומי: הקובץ נכתב כשעון-קיר בלי אזור
// זמן, והמפענח בצד האדמין בונה אותו ב-Date.UTC. קריאה בשעון מקומי הייתה
// מזיזה מסמכים של אחרי חצות ליום הקודם ומפצלת תעודה אחת לשתי הזמנות.
const dayKey = (date) => date.toISOString().slice(0, 10);

/* ------------------------------------------------------------------ *
 * קיבוץ השורות למסמכים.
 *
 * טהורה בכוונה — היא מה שגם המסך המקדים וגם היבוא סופרים, ושני מספרים
 * שנגזרו משני קיבוצים שונים הם בדיוק ההפרש שגורם ל"אמרת 14 ונוצרו 12".
 *
 * @returns {{groups: Array, skippedNoDate: number, skippedBadSku: number}}
 * ------------------------------------------------------------------ */
const groupRows = (rows) => {
  const groups = new Map();
  let skippedNoDate = 0;
  let skippedBadSku = 0;

  for (const raw of Array.isArray(rows) ? rows : []) {
    // ‏toText ולא normalizeSku ישירות: normalizeSku הוא String(value) גולמי,
    // ואובייקט בעמודת המק"ט היה הופך ל-"[object Object]" — מפתח שנשמר
    // ב-archive.unmatchedItems ומוצג בהערת המערכת. ‏aggregateRows פוסל אותו
    // כאן בדיוק, ושני הנתיבים חייבים לפסול את אותן שורות.
    const sku = normalizeSku(toText(raw?.sku));
    if (!sku || sku.length > MAX_SKU_LENGTH) {
      skippedBadSku += 1;
      continue;
    }

    const date = toDate(raw?.date);
    const docNumber = toText(raw?.docNumber).slice(0, MAX_DOC_NUMBER_LENGTH);

    // ── שורה בלי תאריך *ובלי* מספר מסמך אינה יכולה להפוך להזמנה ──
    //
    // בפרופיל הרכישות שורה כזו עדיין שווה משהו ("הלקוח קנה את זה"), ולכן שם
    // היא נשמרת. כאן אין לה לא מועד ולא מסמך להשתייך אליו, והמצאת תאריך
    // הייתה יוצרת הזמנה שנראית אמיתית ביום שגוי. היא נספרת ומדווחת.
    if (!date && !docNumber) {
      skippedNoDate += 1;
      continue;
    }

    const docType = toText(raw?.docType).slice(0, MAX_DOC_TYPE_LENGTH);
    const key = docNumber ? `doc:${docType}:${docNumber}` : `day:${dayKey(date)}`;

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        docNumber: docNumber || "",
        docType,
        // ‏byDate מסמן קיבוץ שנעשה בהיעדר מספר מסמך. מוצג בהערת המערכת של
        // ההזמנה, כי הוא ההבדל בין "זו התעודה" ל"אלה כל השורות של אותו יום".
        byDate: !docNumber,
        date,
        lines: [],
      });
    }

    const group = groups.get(key);
    // המוקדם מבין השורות. מסמך שכל שורותיו נושאות את אותו תאריך — הרוב
    // המוחלט — מקבל אותו בדיוק; מסמך מעורב מקבל את תחילתו.
    if (date && (!group.date || date < group.date)) group.date = date;
    // קיבוץ לפי יום אוסף שורות מכמה סוגי מסמכים; הראשון שנראה מייצג
    if (!group.docType && docType) group.docType = docType;

    group.lines.push({
      sku,
      name: toText(raw?.name).slice(0, MAX_NAME_LENGTH),
      quantity: toNumber(raw?.quantity),
      price: toNumber(raw?.price),
    });
  }

  // מסמך שכל שורותיו חסרות תאריך (יש לו מספר, אין לו יום) אינו ניתן לתיארוך.
  const dated = [];
  for (const group of groups.values()) {
    if (group.date) dated.push(group);
    else skippedNoDate += group.lines.length;
  }

  // סדר כרונולוגי, כדי שמספרי ההזמנות שיוקצו יעלו יחד עם התאריכים
  dated.sort((a, b) => a.date - b.date);

  return { groups: dated, skippedNoDate, skippedBadSku };
};

/* ------------------------------------------------------------------ *
 * בניית העגלה של מסמך אחד.
 *
 * המחיר נלקח **מהקובץ** ולא מהקטלוג: זה מה שהלקוח שילם בפועל, בעוד שמחירי
 * הקטלוג במערכת הזו נוצרו משמות המוצרים והם מציין מקום. שורה בלי מחיר בקובץ
 * נופלת למחיר הקטלוג ונספרת בנפרד.
 * ------------------------------------------------------------------ */
const buildGroupCart = (group, catalog) => {
  // אותו מק"ט יכול להופיע פעמיים באותה תעודה. הסכימה כאן ולא בעגלה: שתי
  // שורות של אותו מוצר בעגלה נספרות פעמיים בכל מסך שמסכם לפי מוצר.
  const byProduct = new Map();
  const unmatched = [];
  let missingPrice = 0;
  let assumedQty = 0;
  let creditLines = 0;

  for (const line of group.lines) {
    const product = lookupCatalog(catalog, line.sku);

    // ── כמות שלילית = שורת זיכוי, והיא נשמרת כפי שהיא ──
    //
    // בקובץ ההנהח"ש **יש** שורות זיכוי בכמות שלילית — זה מתועד במפורש
    // ב-aggregateRows, שם הן נספרות כשורה ואינן מקזזות את הכמות המצטברת.
    //
    // כאן הסמנטיקה הפוכה, וחייבת להיות: הזמנת ארכיון היא שחזור **המסמך**,
    // וסכומה חייב להסכים עם המסמך שבהנהח"ש. הגרסה הראשונה כאן כתבה
    // `quantity <= 0 ? 1 : quantity`, כלומר שורת זיכוי של 3 יחידות הפכה
    // ל**הוספה** של יחידה אחת — סחורה שהוחזרה נספרה כסחורה שנמכרה, בשקט,
    // וסכום ההזמנה סטה מהמסמך בכיוון ההפוך.
    //
    // ‏null בלבד נלקח כיחידה אחת, וזו הנחה של המערכת ולכן היא מדווחת.
    // ‏0 מפורש נשאר 0: המצאת יחידה שם היא המצאת סחורה.
    const quantity = line.quantity === null ? 1 : line.quantity;
    if (line.quantity === null) assumedQty += 1;
    if (quantity < 0) creditLines += 1;

    if (!product) {
      unmatched.push({
        sku: line.sku,
        name: line.name || "",
        quantity,
        price: line.price === null ? undefined : line.price,
      });
      continue;
    }

    const id = String(product._id);
    if (!byProduct.has(id)) {
      byProduct.set(id, { product, quantity: 0, lineTotal: 0, priced: false });
    }
    const entry = byProduct.get(id);

    const price = line.price === null ? null : line.price;
    if (price === null) missingPrice += 1;
    else entry.priced = true;

    entry.quantity += quantity;
    entry.lineTotal += (price === null ? product.prices?.price || 0 : price) * quantity;
  }

  const cart = [...byProduct.values()].map(({ product, quantity, lineTotal, priced }) => {
    // המחיר ליחידה נגזר מסכום השורות ולא להפך, כדי ששתי שורות של אותו מוצר
    // במחירים שונים יסתכמו בדיוק לסכום שבמסמך המקורי.
    //
    // ‏!== 0 ולא > 0: כמות שלילית היא זיכוי תקין (הסכום והכמות שניהם
    // שליליים, והמחיר ליחידה יוצא חיובי). רק אפס — מכירה וזיכוי של אותו
    // מוצר באותו מסמך שהתקזזו — היה חילוק באפס.
    const unitPrice = quantity !== 0 ? Number((lineTotal / quantity).toFixed(4)) : 0;
    const item = buildCartItem(product, quantity, undefined, unitPrice);
    // ‏buildCartItem מסמן כל מחיר שנמסר לו כמחיר מחירון. כאן המקור אחר, וללא
    // התיקון הזה ההזמנה הייתה מעידה על עצמה שתומחרה ממחירון הלקוח.
    item.priceSource = priced ? "archive-import" : "catalog";
    item.itemTotal = Number(lineTotal.toFixed(2));
    return item;
  });

  const subTotal = Number(cart.reduce((sum, item) => sum + item.itemTotal, 0).toFixed(2));

  return { cart, unmatched, subTotal, missingPrice, assumedQty, creditLines };
};

const buildUserInfo = (customer) => ({
  name: customer.name,
  lastName: customer.lastName || "",
  email: isSyntheticEmail(customer.email) ? "" : customer.email || "",
  contact: customer.phone || "",
  address: customer.address || {},
  country: "Israel",
  zipCode: customer.address?.postalCode || "",
});

// הערת המערכת היא המקום היחיד שבו מי שפותח את ההזמנה רואה שהיא לא נוצרה
// בחנות — ומה בדיוק ידוע ומה לא.
const buildSystemNote = (
  group,
  { unmatched, missingPrice, assumedQty, creditLines, fileName }
) => {
  const parts = ["[הזמנת ארכיון — יובאה מקובץ היסטוריה, לא נקלטה במערכת]"];

  if (group.docNumber) {
    parts.push(`${group.docType || "מסמך"} ${group.docNumber}`);
  } else {
    parts.push("אין מספר מסמך בקובץ — כל שורות היום קובצו להזמנה אחת");
  }

  if (unmatched.length) {
    const names = unmatched
      .slice(0, 10)
      .map((line) => `${line.sku}${line.name ? ` (${line.name})` : ""}`)
      .join(", ");
    parts.push(
      `${unmatched.length} שורות לא נמצאו בקטלוג ואינן בסכום — ${names}` +
        (unmatched.length > 10 ? " ועוד" : "")
    );
  }

  if (missingPrice) {
    parts.push(`${missingPrice} שורות בלי מחיר בקובץ — נלקח מחיר הקטלוג`);
  }

  if (assumedQty) {
    parts.push(`${assumedQty} שורות בלי כמות בקובץ — נלקחה יחידה אחת`);
  }

  // בלי השורה הזו הזמנה בסכום שלילי נראית כתקלה במקום כמה שהיא — זיכוי
  if (creditLines) {
    parts.push(`${creditLines} שורות זיכוי (כמות שלילית) — נשמרו כפי שהן`);
  }

  if (fileName) parts.push(`קובץ: ${fileName}`);

  return parts.join(" | ");
};

/* ------------------------------------------------------------------ *
 * מפתח מסמך -> מזהה ההזמנה שכבר יובאה עבורו.
 *
 * ── למה שאילתה אחת מראש ולא findOne לכל מסמך ──
 *
 * ‏findOne בלולאה הוא הלוך-ושוב אחד לכל מסמך בקובץ, בתוך בקשת HTTP אחת.
 * בקובץ של שלוש שנים (כ-300 מסמכים) זה 300 שאילתות רק כדי לגלות שאף אחת
 * מהן אינה קיימת — המצב הנפוץ ביותר, כי רוב הייבואים הם ראשונים.
 *
 * ‏select על שני שדות בלבד: המסמכים המלאים נושאים עגלות, ומשיכתן לכאן הייתה
 * מגלגלת מגהבייטים בשביל מפת מפתחות.
 * ------------------------------------------------------------------ */
const fetchExistingByKey = async (keys) => {
  const byKey = new Map();

  for (let i = 0; i < keys.length; i += KEY_CHUNK_SIZE) {
    const chunk = keys.slice(i, i + KEY_CHUNK_SIZE);
    const found = await Order.find({ "archive.sourceKey": { $in: chunk } })
      .select("_id archive.sourceKey")
      .lean();
    found.forEach((order) => {
      const key = order.archive?.sourceKey;
      if (key) byKey.set(key, order._id);
    });
  }

  return byKey;
};

/* ------------------------------------------------------------------ *
 * תצוגה מקדימה — כמה הזמנות ייווצרו, מה טווחן, וכמה מהן כבר קיימות.
 *
 * בלי מספר ה"כבר קיימות" מי שמעלה קובץ חופף אינו יכול לדעת אם הוא עומד
 * ליצור 40 הזמנות חדשות או לעדכן 38 קיימות ולהוסיף 2.
 * ------------------------------------------------------------------ */
const previewArchiveOrders = async ({ customer, rows }) => {
  const { groups: all, skippedNoDate, skippedBadSku } = groupRows(rows);

  // ── החיתוך נעשה **לפני** הספירה, ולא אחריה ──
  //
  // היבוא יוצר לכל היותר MAX_ORDERS מסמכים. תצוגה מקדימה שספרה את כולם
  // הייתה מבטיחה מספר שלא יתקיים — ובדיוק הפער הזה הוא מה שגורם ל"אמרת
  // 2,400 ונוצרו 2,000". מה שנחתך מדווח בנפרד (overLimit) ולא נבלע.
  const groups = all.slice(0, MAX_ORDERS);

  const keys = groups.map((group) => `${customer._id}:${group.key}`);
  const existingKeys = await fetchExistingByKey(keys);

  const willUpdate = keys.filter((key) => existingKeys.has(key)).length;

  // ── הפילוח לפי סוג מסמך ──
  //
  // המספר שאומר אם הייצוא מכיל את אותה סחורה פעמיים (תעודת משלוח + החשבונית
  // שהופקה עליה). ראה ההסבר בראש הקובץ — המערכת אינה מנחשת, היא מציגה.
  const byDocType = new Map();
  groups.forEach((group) => {
    const label = group.docType || "ללא סוג";
    byDocType.set(label, (byDocType.get(label) || 0) + 1);
  });

  return {
    orders: groups.length,
    willCreate: groups.length - willUpdate,
    willUpdate,
    byDocType: [...byDocType.entries()].map(([docType, orders]) => ({ docType, orders })),
    byDocNumber: groups.filter((group) => !group.byDate).length,
    byDateOnly: groups.filter((group) => group.byDate).length,
    skippedNoDate,
    skippedBadSku,
    // כמה מסמכים בקובץ **לא** ייווצרו בגלל התקרה. 0 = הכל נכנס.
    overLimit: all.length - groups.length,
    totalInFile: all.length,
    from: groups.length ? groups[0].date : null,
    to: groups.length ? groups[groups.length - 1].date : null,
  };
};

/* ------------------------------------------------------------------ *
 * כתיבת מסמך אחד — יצירה, או עדכון של מסמך שכבר יובא.
 *
 * ── שני מרוצים, ואותה תשובה לשניהם ──
 *
 * 1. שני אדמינים מייבאים לאותו לקוח באותו רגע. שניהם לא מצאו את המסמך,
 *    שניהם יוצרים, והאינדקס הייחודי על archive.sourceKey דוחה את השני.
 * 2. מספר ההזמנה נתפס בין ההקצאה לשמירה (ייבוא ישיר למונגו שהמונה לא ידע
 *    עליו) — אותה מלכודת שסוגר saveOrder ב-lib/order-ingestion.
 *
 * בשני המקרים מונגו מחזיר 11000, ובניסיון החוזר המצב כבר ברור: המסמך קיים
 * ולכן מתעדכן, או שהמספר הבא בתור פנוי. בלי זה קובץ תקין לגמרי היה מדווח על
 * מסמכים שנכשלו רק בגלל תזמון.
 * ------------------------------------------------------------------ */
const SAVE_ATTEMPTS = 3;

const writeArchiveOrder = async ({ sourceKey, existingId, payload, date }) => {
  for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt++) {
    // בניסיון הראשון נשענים על המפה שנשלפה מראש (fetchExistingByKey), ולכן
    // מסמך חדש — המקרה הנפוץ — אינו עולה שאילתה בכלל.
    //
    // בניסיון חוזר שואלים מחדש **לפי המפתח** ולא לפי המזהה: 11000 פירושו
    // שהמצב במסד השתנה תחתינו, וייתכן שכותב אחר בדיוק יצר את המסמך הזה.
    //
    // ‏findById שמחזיר null (המסמך נמחק בין השליפה לכתיבה) נופל למסלול
    // היצירה, וזו התוצאה הנכונה.
    const existing =
      attempt === 1
        ? existingId
          ? await Order.findById(existingId)
          : null
        : await Order.findOne({ "archive.sourceKey": sourceKey });

    try {
      if (existing) {
        // ‏invoice נשמר: מספר הזמנה שכבר הוצג אינו משתנה בייבוא חוזר.
        Object.assign(existing, payload);

        // ── למה $set ולא השמה רגילה ──
        //
        // מונגוס מגדיר את createdAt כ-immutable (setupTimestamps), ולכן
        // `existing.createdAt = date` על מסמך קיים **נבלע בשקט** — בלי
        // שגיאה ובלי שינוי. בקיבוץ לפי יום התאריך ממילא זהה, אבל מסמך
        // שתאריכו תוקן בהנהח"ש היה נשאר תקוע ביום הישן בלי שום סימן.
        // זו אותה קריאה שמונגוס עצמו משתמש בה כדי לכתוב את השדה.
        existing.$set("createdAt", date, undefined, { overwriteImmutable: true });
        existing.updatedAt = date;

        await existing.save({ timestamps: false });
        return "updated";
      }

      // ‏createdAt מפורש: מונגוס דורס אותו רק כשהוא ריק (setDocumentTimestamps),
      // ולכן השמה כאן שורדת את השמירה — וזו כל הנקודה, ההזמנה חייבת לשבת
      // בתאריך המסמך ולא בתאריך ההעלאה. ‏updatedAt מיושר אליו כדי שדוחות
      // שמסננים לפיו (getDashboardAmount) לא יראו את היבוא כפעילות של היום.
      //
      // ‏timestamps:false מדלג על ה-hook של מונגוס לגמרי; בלעדיו updatedAt
      // היה נדרס לזמן ההעלאה.
      const order = new Order({
        ...payload,
        invoice: await nextFreeInvoice(),
        createdAt: date,
        updatedAt: date,
        // ‏logStatusChange אינו נקרא כאן במכוון — ראה ההסבר בראש הקובץ.
        statusHistory: [
          {
            from: "No Status",
            to: ARCHIVE_STATUS_HE,
            changedAt: date,
            changedBy: "archiveImport",
          },
        ],
      });
      await order.save({ timestamps: false });
      return "created";
    } catch (err) {
      if (err.code !== 11000 || attempt === SAVE_ATTEMPTS) throw err;
      console.warn(
        `[archive] מרוץ על ${sourceKey} — ניסיון ${attempt + 1}/${SAVE_ATTEMPTS}`
      );
    }
  }
};

/* ------------------------------------------------------------------ *
 * היבוא עצמו.
 *
 * ── למה כתיבה-כתיבה ולא דריסה ──
 *
 * פרופיל הרכישות נדרס במלואו בכל יבוא, כי הוא ייצוא של מצב. הזמנה אינה מצב
 * אלא רשומה: מחיקת הזמנות ארכיון שאינן בקובץ הנוכחי הייתה מוחקת מסמכים
 * אמיתיים רק משום שיוצא טווח תאריכים צר יותר. לכן מסמך שכבר יובא מתעדכן
 * במקומו (לפי archive.sourceKey), ומה שאינו בקובץ נשאר.
 * ------------------------------------------------------------------ */
const importArchiveOrders = async ({ customer, rows, fileName, importedBy }) => {
  const status = await ensureArchiveStatus();
  if (!status) throw new Error(`לא ניתן ליצור את הסטטוס "${ARCHIVE_STATUS_HE}"`);

  const { groups, skippedNoDate, skippedBadSku } = groupRows(rows);
  const limited = groups.slice(0, MAX_ORDERS);

  const catalog = await fetchCatalogBySku(
    limited.flatMap((group) => group.lines.map((line) => line.sku)),
    CATALOG_SELECT
  );

  const userInfo = buildUserInfo(customer);
  const importedAt = new Date();

  // מפת המסמכים שכבר יובאו — שאילתה אחת (מנותחת לחלקים) במקום אחת לכל מסמך
  const existingByKey = await fetchExistingByKey(
    limited.map((group) => `${customer._id}:${group.key}`)
  );

  let created = 0;
  let updated = 0;
  let empty = 0;
  // ‏failed נספר בנפרד מ-failures: הרשימה חסומה ב-MAX_SAMPLES, ושימוש
  // ב-failures.length כמונה היה מדווח "200 נכשלו" גם כשנכשלו 900.
  let failed = 0;
  const failures = [];

  for (const group of limited) {
    const { cart, unmatched, subTotal, missingPrice, assumedQty, creditLines } =
      buildGroupCart(group, catalog);

    // מסמך שאף שורה בו אינה בקטלוג. הזמנה ריקה אינה מוסיפה מידע לכרטיס
    // הלקוח — היא רק שורה בסכום 0 שנראית כמו תקלה. היא נספרת (empty),
    // והמק"טים עצמם מדווחים באותה תשובה ב-notInCatalogSamples.
    if (!cart.length) {
      empty += 1;
      continue;
    }

    const sourceKey = `${customer._id}:${group.key}`;
    const archive = {
      docNumber: group.docNumber || undefined,
      docType: group.docType || undefined,
      docDate: group.date,
      sourceKey,
      fileName: fileName || undefined,
      importedBy: importedBy || undefined,
      importedAt,
      unmatchedItems: unmatched.length ? unmatched.slice(0, MAX_SAMPLES) : undefined,
    };

    const payload = {
      user: customer._id,
      cart,
      user_info: userInfo,
      subTotal,
      shippingCost: 0,
      discount: 0,
      offerDiscount: 0,
      total: subTotal,
      paymentMethod: "archive",
      status: status._id,
      systemNote: buildSystemNote(group, {
        unmatched,
        missingPrice,
        assumedQty,
        creditLines,
        fileName,
      }),
      source: "archive",
      archive,
    };

    try {
      const result = await writeArchiveOrder({
        sourceKey,
        existingId: existingByKey.get(sourceKey) || null,
        payload,
        date: group.date,
      });
      if (result === "created") created += 1;
      else updated += 1;
    } catch (err) {
      // מסמך אחד שנכשל אינו מפיל את היבוא כולו: קובץ של שלוש שנים שנעצר
      // באמצע היה משאיר את הלקוח עם חצי ארכיון בלי שום סימן איפה הוא נעצר.
      console.error(
        `[archive] יצירת הזמנת ארכיון ${sourceKey} נכשלה: ${err.message}`
      );
      failed += 1;
      if (failures.length < MAX_SAMPLES) {
        failures.push({
          docNumber: group.docNumber,
          date: group.date,
          message: err.message,
        });
      }
    }
  }

  return {
    created,
    updated,
    empty,
    failed,
    failures,
    skippedNoDate,
    skippedBadSku,
    overLimit: groups.length - limited.length,
    // ‏המק"טים שאינם בקטלוג **אינם** מוחזרים כאן: אותה תשובת HTTP כבר נושאת
    // אותם ב-notInCatalogSamples, שנגזר מכל שורות הקובץ ולא רק מאלה שנכנסו
    // למסמכים. שתי רשימות של אותו דבר בתשובה אחת הן שתי רשימות שיתחילו
    // להיפרד ברגע שאחת מהן תשתנה.
    from: limited.length ? limited[0].date : null,
    to: limited.length ? limited[limited.length - 1].date : null,
  };
};

module.exports = {
  groupRows,
  // מיוצא לבדיקה (script/test-archive-grouping.js): החשבון כאן הוא מה
  // שקובע את סכום ההזמנה, ואין דרך אחרת להריץ עליו בדיקה בלי מסד
  buildGroupCart,
  previewArchiveOrders,
  importArchiveOrders,
  MAX_ORDERS,
};

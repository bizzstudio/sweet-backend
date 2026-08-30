// controller/customerHistoryController.js
//
// היסטוריית הרכישות של לקוח: יבוא מקובץ ההנהח"ש, צפייה, מדידת השפעה ומחיקה.
//
// היבוא הוא **דריסה מלאה** ולא מיזוג, מאותה סיבה כמו במחירון: הקובץ הוא ייצוא
// של מצב ולא אוסף עדכונים. מק"ט שנעלם מהייצוא החדש נעלם גם מהפרופיל.
//
// העמודות מפוענחות בצד האדמין (utils/customerHistoryExcel.js) ומגיעות לכאן
// כשורות מסמך מנורמלות: { rowNumber, sku, name, date, quantity, price, docType }.
// הסיכום למוצר אחד לכל מק"ט נעשה **כאן ולא שם**: מה שהדפדפן שולח אינו נתון
// מהימן, וספירת "כמה פעמים הלקוח קנה" היא בדיוק המספר שקובע אילו שורות יאושרו
// אוטומטית בהזמנות עתידיות.
//
// ── שני דברים נוצרים מאותו קובץ ──
//
// 1. **פרופיל הרכישות** (CustomerPurchaseHistory) — סטטיסטיקה מסוכמת שהצינור
//    משתמש בה כשובר שוויון. נדרס בכל יבוא.
// 2. **הזמנות ארכיון** — שחזור המסמכים עצמם כהזמנות בסטטוס "הזמנת ארכיון",
//    כדי שההיסטוריה תיראה בכרטיס הלקוח כפי שהיא. אופציונלי (createOrders),
//    ומתעדכן במקומו ולא נדרס. ראה lib/archive-orders/buildArchiveOrders.js.

const mongoose = require("mongoose");

const CustomerPurchaseHistory = require("../models/CustomerPurchaseHistory");
const Customer = require("../models/Customer");
const Order = require("../models/Order");
const { fetchCatalogBySku, lookupCatalog } = require("../utils/catalogBySku");
const { normalizeSku } = require("../utils/customerPriceList");
const {
  matchProductByName,
  HISTORY_CANDIDATE_LIMIT,
} = require("../utils/productMatching");
const { findAliasMatch } = require("../utils/productAliases");
const {
  buildPurchaseProfile,
  pickFromHistory,
} = require("../utils/purchaseHistoryRanking");
const {
  extractQualifiers,
  applyQualifiers,
} = require("../lib/order-ingestion/qualifiers");
const {
  previewArchiveOrders,
  importArchiveOrders,
} = require("../lib/archive-orders/buildArchiveOrders");

// ── תקרה לשורות בבקשה אחת ──
//
// היסטוריה נשלחת בבקשה אחת בכוונה: הדריסה חייבת להיות אטומית, וקובץ מפוצל
// לאצוות היה משאיר את הלקוח עם חצי פרופיל — כלומר עם מונה "כמה פעמים קנה"
// שנראה תקין לגמרי אבל נמוך מהאמת, ומכריע לפי חלק מהנתונים.
//
// היקף אמיתי: קובץ הדוגמה הוא 108 שורות לשנה. לקוח כבד עם שלוש שנים אחורה
// מגיע לאלפים בודדים. 50,000 שורות מותירות מרווח גדול ועדיין נכנסות לתקרת
// ‏express.json — שורת היסטוריה קלה משורת מחירון (בלי מחיר קטלוג, בלי סטטוס).
const MAX_ROWS = 50000;

const MAX_NAME_LENGTH = 200;
const MAX_SKU_LENGTH = 64;
const MAX_SAMPLES = 200;

const DEFAULT_VIEW_LIMIT = 100;
const MAX_VIEW_LIMIT = 1000;

// ── כמה שורות תקועות נמדדות בבדיקה המקדימה ──
//
// כל שורה כזו מריצה את מנוע ההתאמה המלא (בניית רגקסים + שאילתות קטלוג), ולכן
// זו הפעולה היקרה ביותר בקובץ הזה. התקרה נמדדה מול המצב בפועל: 20 מתוך 33
// ההזמנות שנכשלו נכשלו על 3 שורות או פחות, כלומר 60 שורות מכסות לקוח כבד.
//
// כשהתקרה נחצתה — **הבדיקה אומרת זאת במפורש** (`truncated`). מספר שנחתך בשקט
// היה נקרא כמדידה מלאה ומרגיע יותר מהמצב.
const MAX_IMPACT_LINES = 60;

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

// ── תאריך: ISO בלבד, ובמפורש ──
//
// הצד הלקוח שולח ISO שנוצר במפענח שיודע שקובץ ההנהח"ש כותב יום/חודש/שנה
// (utils/customerHistoryExcel.parseHistoryDate).
//
// הפורמט נאכף כאן ולא רק מונח, כי `Date.parse` **כן** יודע לקרוא "05/06/2026"
// — בסדר האמריקאי, כלומר 6 במאי במקום 5 ביוני, ועוד באזור הזמן המקומי של
// השרת. לקוח אחר, סקריפט, או יבוא מרוכז שייכתב מחר וישלח את הפורמט הגולמי
// היה מקבל תאריך שגוי **בשקט** — נתון תקין לגמרי, פשוט הפוך, שעליו נשען כל
// דירוג "מה הלקוח קנה לאחרונה".
//
// לכן כל מה שאינו ISO נדחה כ"אין תאריך" ולא "מנורמל" למשהו שנראה תקין. שורה
// בלי תאריך אינה נפסלת — היא רק מאבדת את משקל העדכניות, וספירתן מוחזרת
// בבדיקה המקדימה (`withoutDate`) כדי שהפער ייראה במקום להיבלע.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]|$)/;

const toDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== "string" || !ISO_DATE_RE.test(value.trim())) return null;

  const time = Date.parse(value.trim());
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);

  // תאריך עתידי הוא סימן לפענוח שגוי, לא לרכישה עתידית. הוא נשמר (המידע
  // "הלקוח קנה" עדיין נכון) אבל אינו מקבל משקל עדכניות מנופח — הדירוג חוסם
  // אותו ב-monthsSince. כאן נדחה רק מה שאינו תאריך אפשרי בכלל.
  return date.getUTCFullYear() >= 1990 && date.getUTCFullYear() <= 2200 ? date : null;
};

const normalizeName = (value) =>
  toText(value)
    .toLowerCase()
    .replace(/["'`״׳]/g, "")
    .replace(/\s+/g, " ");

/* ------------------------------------------------------------------ *
 * סיכום שורות המסמך למוצר אחד לכל מק"ט.
 *
 * הקובץ מגיע כשורות מסמך — אותו מק"ט חוזר בכל תעודה שבה נקנה — והצינור צריך
 * "כמה פעמים ומתי לאחרונה". שתי שורות של אותו מק"ט באותה תעודה נספרות כשתיים
 * במכוון: הן שתי שורות הזמנה, וכך הן נראות גם בקובץ המקור (בקובץ הדוגמה
 * "סוכר 1 קג" מופיע פעמיים באותה חשבונית, בשני מחירים).
 * ------------------------------------------------------------------ */
const aggregateRows = (rows) => {
  const bySku = new Map();
  const invalid = [];

  for (const row of rows) {
    // ‏toText מחזיר "" לכל מה שאינו פרימיטיבי, ולכן אובייקט בעמודת המק"ט נופל
    // כאן על "חסר מק\"ט" ואינו הופך ל-"[object Object]" שנשמר כמפתח התאמה.
    const sku = toText(row?.sku);
    const rowNumber = Number(row?.rowNumber) || null;
    const name = toText(row?.name).slice(0, MAX_NAME_LENGTH);

    if (!sku) {
      invalid.push({ rowNumber, sku, name, message: 'חסר מק"ט' });
      continue;
    }
    if (sku.length > MAX_SKU_LENGTH) {
      invalid.push({
        rowNumber,
        sku: sku.slice(0, MAX_SKU_LENGTH),
        name,
        message: 'מק"ט ארוך מדי',
      });
      continue;
    }

    const quantity = toNumber(row?.quantity);
    const price = toNumber(row?.price);
    const date = toDate(row?.date);

    const key = normalizeSku(sku);
    const entry = bySku.get(key) || {
      sku,
      name: name || undefined,
      lines: 0,
      totalQty: 0,
      firstAt: null,
      lastAt: null,
      lastPrice: null,
      minPrice: null,
      maxPrice: null,
    };

    entry.lines += 1;
    // ── כמות שלילית או חסרה ──
    //
    // בקובץ ההנהח"ש יש שורות זיכוי בכמות שלילית. הן **כן** נספרות כשורה
    // (הלקוח נגע במוצר הזה) אבל אינן מקזזות את הכמות המצטברת: totalQty משמש
    // כשובר שוויון בלבד, וסכום שירד למינוס בגלל זיכוי היה מוריד מוצר שוטף
    // אל מתחת למוצר חד-פעמי.
    if (quantity !== null && quantity > 0) entry.totalQty += quantity;

    if (date) {
      if (!entry.firstAt || date < entry.firstAt) entry.firstAt = date;
      if (!entry.lastAt || date > entry.lastAt) {
        entry.lastAt = date;
        // המחיר האחרון הוא זה של התאריך המאוחר ביותר, ולא של השורה האחרונה
        // בקובץ — הקובץ אינו בהכרח ממוין
        if (price !== null) entry.lastPrice = price;
      }
    } else if (price !== null && entry.lastPrice === null) {
      entry.lastPrice = price;
    }

    if (price !== null && price > 0) {
      entry.minPrice = entry.minPrice === null ? price : Math.min(entry.minPrice, price);
      entry.maxPrice = entry.maxPrice === null ? price : Math.max(entry.maxPrice, price);
    }

    // השם נלקח מהמופע הראשון שהיה לו שם — הוא לתצוגה בלבד
    if (!entry.name && name) entry.name = name;

    bySku.set(key, entry);
  }

  // מיון יורד לפי מספר הקניות: התצוגה מראה קודם את מה שהלקוח באמת קונה
  const items = [...bySku.values()].sort(
    (a, b) => b.lines - a.lines || String(a.sku).localeCompare(String(b.sku))
  );

  return { items, invalid };
};

const spanOf = (items) => {
  let from = null;
  let to = null;
  items.forEach((item) => {
    if (item.firstAt && (!from || item.firstAt < from)) from = item.firstAt;
    if (item.lastAt && (!to || item.lastAt > to)) to = item.lastAt;
  });
  return { from, to };
};

const findCustomer = async (customerId) => {
  if (!mongoose.Types.ObjectId.isValid(String(customerId || ""))) return null;
  // ‏+erp במפורש: השדה מוגדר select:false בסכמה, והוא מה שמאפשר לוודא
  // שהקובץ שייך ללקוח הזה (ראה importCustomerHistory)
  //
  // ‏phone ו-address נשלפים בשביל הזמנות הארכיון: הן נבנות מהמסמך הזה
  // (lib/archive-orders/buildArchiveOrders.buildUserInfo), ובלעדיהם כל
  // הזמנה שנוצרת יוצאת עם user_info.contact ריק וכתובת ריקה — כלומר
  // הזמנה שאי אפשר למצוא בחיפוש לפי טלפון, ובלי שום סימן לכך.
  return Customer.findById(customerId)
    .select("_id name lastName email phone address +erp")
    .lean();
};

const customerLabel = (customer) =>
  `${customer?.name || ""} ${customer?.lastName || ""}`.trim();

const readRows = (req) => (Array.isArray(req.body?.rows) ? req.body.rows : []);

const readCustomerNumbers = (req) =>
  [
    ...new Set(
      (Array.isArray(req.body?.customerNumbers) ? req.body.customerNumbers : [])
        .map(toText)
        .filter(Boolean)
    ),
  ];

/**
 * האם הקובץ שייך ללקוח הזה.
 *
 * ── למה זה פונקציה אחת ולא בדיקה בכל נתיב ──
 *
 * הכלל נדרש בשני מקומות: הבדיקה המקדימה מציגה אותו כאזהרה, והיבוא אוכף אותו
 * כחסימה. הניסוח הראשון כתב אותו פעמיים, והשניים נבדלו: הבדיקה סימנה אי-התאמה
 * כשבקובץ יותר ממספר לקוח אחד, והיבוא הסתפק בכך שהמספר שלנו **נמצא ביניהם** —
 * כלומר המסך הזהיר והשרת אישר. שתי הגדרות לאותו מושג הן איך שני מסכים
 * מתחילים להראות מספרים שונים.
 *
 * הכלל: הקובץ חייב להכיל את מספר הלקוח שבכרטיס **ותו לא**. קובץ עם כמה מספרים
 * הוא ייצוא של כמה לקוחות, ושמירת כולו על כרטיס אחד מייחסת לו שורות של אחרים
 * — כלומר בונה פרופיל שמכריע לפי מה שלקוח אחר קונה.
 *
 * @returns {{comparable: boolean, matches: boolean}}
 *          ‏comparable=false כשאין מה להשוות (כרטיס בלי מספר הנהח"ש, או קובץ
 *          בלי עמודת מספר לקוח). זה מצב לגיטימי ואינו חוסם דבר.
 */
const compareCustomerNumbers = (cardNumber, fileNumbers) => {
  if (!cardNumber || fileNumbers.length === 0) {
    return { comparable: false, matches: false };
  }
  return {
    comparable: true,
    matches: fileNumbers.length === 1 && fileNumbers[0] === cardNumber,
  };
};

/* ------------------------------------------------------------------ *
 * הצמדת המק"טים למוצרים בקטלוג.
 *
 * מק"ט שאינו בקטלוג **נשמר בכל זאת**, עם product: null. הוא אינו יכול לשבור
 * שוויון בין מועמדים היום, אבל מוצר שייווצר מחר יימצא דרכו בלי יבוא חוזר
 * (buildPurchaseProfile מחזיק גם מפתח מק"ט). סינון כאן היה מחייב לייבא את
 * ההיסטוריה מחדש אחרי כל מוצר שנוסף לקטלוג.
 * ------------------------------------------------------------------ */
const attachProducts = async (items) => {
  const catalog = await fetchCatalogBySku(items.map((item) => item.sku));

  return items.map((item) => {
    const product = lookupCatalog(catalog, item.sku);
    return { ...item, product: product?._id || null, catalogProduct: product || null };
  });
};

/* ------------------------------------------------------------------ *
 * מדידת ההשפעה: כמה שורות שתקועות **עכשיו** ההיסטוריה הזו הייתה פותרת.
 *
 * זה המספר היחיד שעונה על "האם זה בכלל עוזר". בלעדיו מי שמעלה רואה רק "108
 * שורות נקלטו" — נתון שאינו אומר דבר על התוצאה.
 *
 * המדידה רצה על ההזמנות שנמצאות בסטטוס "שגיאה בקריאה" של הלקוח הזה בלבד,
 * ומריצה עליהן בדיוק את המסלול שהצינור מריץ: ניקוי מזהים, מנוע ההתאמה,
 * ואז pickFromHistory. כל קיצור דרך כאן היה מייצר מספר שאינו מה שיקרה בפועל.
 * ------------------------------------------------------------------ */
const measureImpact = async (customerId, profile) => {
  // ── פרופיל ריק אינו יכול לפתור דבר ──
  //
  // בלי הבדיקה הזו קובץ שאף שורה בו אינה תקינה היה מריץ את מנוע ההתאמה על עד
  // 60 שורות תקועות רק כדי לגלות שאין מה להשוות אליו — עשרות שאילתות קטלוג
  // שהתשובה שלהן ידועה מראש.
  if (!profile?.size) {
    return {
      ordersChecked: 0,
      linesTotal: 0,
      linesChecked: 0,
      truncated: false,
      resolved: 0,
      hinted: 0,
      samples: [],
    };
  }

  // ── הפרדיקט הוא זה של שאר הפרויקט, ולא "הסטטוס הנוכחי" ──
  //
  // "הזמנת שגיאה שטרם נסגרה" מוגדרת בכל שאר הקוד כ-`ingestionError.code`
  // קיים ו-`resolvedAt` ריק (ראה lib/order-ingestion/index.js ו-
  // incomingOrderController). הניסוח הראשון כאן סינן לפי מזהה הסטטוס במקום,
  // ולכן היה סופר גם הזמנה שאדם כבר אישר אם הסטטוס שלה שונה ידנית, ומפספס
  // הזמנה תקועה שהסטטוס שלה הוזז. הגדרה שנייה לאותו מושג היא בדיוק איך שני
  // מסכים מתחילים להראות מספרים שונים.
  const orders = await Order.find({
    user: customerId,
    "ingestionError.code": { $exists: true, $ne: null },
    "ingestionError.resolvedAt": null,
    "ingestionError.unmatchedItems.0": { $exists: true },
  })
    .select("invoice createdAt ingestionError.unmatchedItems")
    .sort({ createdAt: -1 })
    .lean();

  if (!orders.length) {
    return { ordersChecked: 0, linesTotal: 0, linesChecked: 0, resolved: 0, hinted: 0, truncated: false, samples: [] };
  }

  const lines = [];
  for (const order of orders) {
    for (const item of order.ingestionError?.unmatchedItems || []) {
      const rawName = toText(item?.rawName);
      if (rawName) lines.push({ invoice: order.invoice, rawName });
    }
  }

  const linesTotal = lines.length;
  const budget = lines.slice(0, MAX_IMPACT_LINES);

  const measureLine = async (line) => {
    // אותו ניקוי מזהים שהצינור עושה לפני החיפוש — אחרת המדידה תרוץ על שאילתה
    // אחרת מזו שתרוץ באמת
    const qualifiers = extractQualifiers(line.rawName);
    const { cleanName, negations } = qualifiers;
    const searchName = cleanName || line.rawName;

    // שורה שכבר יש עליה הכרעה אנושית אינה "תקועה בגלל היעדר היסטוריה" —
    // ספירתה כרווח של הקובץ הייתה מנפחת את המספר בדיוק במקום שבו הוא נמדד
    if (!negations.length && (await findAliasMatch(searchName, customerId))) return null;

    let match = null;
    try {
      match = await matchProductByName(searchName, {
        requireShown: false,
        requireStock: false,
        alternativesCount: 8,
        // אותם קבועים שהצינור משתמש בהם, מיובאים ולא משוכפלים: המדידה מבטיחה
        // "כך יקרה", ובריכה בגודל אחר הופכת אותה להבטחה שאינה מתקיימת.
        // הבדיקה רצה תמיד במצב "יש היסטוריה" — זו בדיוק השאלה הנבדקת.
        candidateLimit: HISTORY_CANDIDATE_LIMIT,
        poolCount: HISTORY_CANDIDATE_LIMIT,
      });
    } catch {
      // כשל בהתאמה של שורה אחת אינו מבטל את המדידה כולה — הוא רק שורה
      // שאי אפשר לומר עליה דבר
      return null;
    }
    if (!match) return null;

    // ── אותו סינון בדיוק שהצינור מריץ ──
    //
    // בלעדיו המדידה רצה על בריכה רחבה יותר מזו שההיסטוריה תראה בפועל, ולכן
    // מבטיחה יותר שורות נפתרות ממה שייפתר. מספר שמבטיח יתר גרוע ממספר שאינו
    // מוצג: מי שקורא אותו מחליט לפיו אם הקובץ שווה את הזמן.
    const widePool = [
      { product: match.product, score: match.score },
      ...(match.pool || match.alternatives || []).map((alt) => ({
        product: alt,
        score: alt.score,
      })),
    ];
    const pool = applyQualifiers(widePool, qualifiers).keptBeforeSilentDrops.map((k) => ({
      product: k.product,
    }));

    const pick = pickFromHistory(pool, profile);
    if (!pick) return null;

    return {
      invoice: line.invoice,
      rawName: line.rawName,
      tier: pick.tier,
      productTitle: pick.product?.title?.he || pick.product?.title?.en || "",
      sku: pick.product?.sku || null,
    };
  };

  // ── מקביליות חסומה, לא לולאה סדרתית ולא Promise.all ──
  //
  // כל שורה מריצה את מנוע ההתאמה המלא: בניית רגקסים מהטקסט ושאילתות קטלוג.
  // סדרתית זו בקשה של שניות רבות שעלולה להיחתך בפרוקסי לפני שהיא חוזרת;
  // ‏Promise.all על כל השורות פותח עשרות שאילתות כבדות בבת אחת על אותו מסד
  // שמשרת גם את הקליטה בזמן אמת. חלון קטן וקבוע נותן את רוב הזירוז בלי
  // להעמיס — וזו בקשה של מסך ניהול, לא של נתיב חם.
  const CONCURRENCY = 5;
  const results = [];
  for (let i = 0; i < budget.length; i += CONCURRENCY) {
    const batch = await Promise.all(budget.slice(i, i + CONCURRENCY).map(measureLine));
    results.push(...batch.filter(Boolean));
  }

  return {
    ordersChecked: orders.length,
    linesTotal,
    linesChecked: budget.length,
    // ‏truncated אינו קוסמטי: בלעדיו "12 שורות ייפתרו" נקרא כמדידה מלאה
    truncated: linesTotal > budget.length,
    resolved: results.filter((r) => r.tier === "decisive").length,
    hinted: results.filter((r) => r.tier === "hint").length,
    samples: results.slice(0, MAX_SAMPLES),
  };
};

/* ------------------------------------------------------------------ *
 * סיכום לכל הלקוחות — למסך רשימת הלקוחות.
 * מטא-נתונים בלבד (items הוא select:false).
 * ------------------------------------------------------------------ */
const getHistorySummary = async (req, res) => {
  try {
    const docs = await CustomerPurchaseHistory.find({})
      .select("customer itemsCount matchedInCatalog fileName importedAt spanFrom spanTo")
      .lean();

    res.send(
      docs.map((doc) => ({
        customer: String(doc.customer),
        itemsCount: doc.itemsCount || 0,
        matchedInCatalog: doc.matchedInCatalog || 0,
        fileName: doc.fileName || "",
        importedAt: doc.importedAt || null,
        spanFrom: doc.spanFrom || null,
        spanTo: doc.spanTo || null,
      }))
    );
  } catch (err) {
    console.log("getHistorySummary error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/* ------------------------------------------------------------------ *
 * ההיסטוריה של לקוח מסוים, מועשרת בנתוני הקטלוג.
 * ------------------------------------------------------------------ */
const getCustomerHistory = async (req, res) => {
  try {
    const customer = await findCustomer(req.params.customerId);
    if (!customer) return res.status(404).send({ message: "לקוח לא נמצא" });

    const doc = await CustomerPurchaseHistory.findOne({ customer: customer._id })
      .select("+items")
      .lean();

    const meta = {
      customer: String(customer._id),
      customerName: customerLabel(customer),
      customerNumber: customer.erp?.customerNumber || "",
      exists: Boolean(doc),
      itemsCount: doc?.itemsCount || 0,
      matchedInCatalog: doc?.matchedInCatalog || 0,
      spanFrom: doc?.spanFrom || null,
      spanTo: doc?.spanTo || null,
      sourceCustomerNumber: doc?.sourceCustomerNumber || "",
      fileName: doc?.fileName || "",
      importedBy: doc?.importedBy || "",
      importedAt: doc?.importedAt || null,
      updatedAt: doc?.updatedAt || null,
    };

    if (!doc?.items?.length) {
      return res.send({ ...meta, items: [], returned: 0, filtered: 0 });
    }

    const search = normalizeName(req.query?.search);
    const limit = Math.min(
      Math.max(Number(req.query?.limit) || DEFAULT_VIEW_LIMIT, 1),
      MAX_VIEW_LIMIT
    );

    const filtered = search
      ? doc.items.filter(
          (item) =>
            normalizeSku(item.sku).toLowerCase().includes(search) ||
            normalizeName(item.name).includes(search)
        )
      : doc.items;

    const page = filtered.slice(0, limit);
    const catalog = await fetchCatalogBySku(page.map((item) => item.sku));

    res.send({
      ...meta,
      filtered: filtered.length,
      returned: page.length,
      items: page.map((item) => {
        const product = lookupCatalog(catalog, item.sku);
        return {
          sku: item.sku,
          name: item.name || "",
          lines: item.lines || 0,
          totalQty: item.totalQty || 0,
          firstAt: item.firstAt || null,
          lastAt: item.lastAt || null,
          lastPrice: item.lastPrice ?? null,
          minPrice: item.minPrice ?? null,
          maxPrice: item.maxPrice ?? null,
          inCatalog: Boolean(product),
          catalogTitle: product?.title?.he || product?.title?.en || "",
          catalogPrice: product?.prices?.price ?? null,
          catalogStatus: product?.status || null,
        };
      }),
    });
  } catch (err) {
    console.log("getCustomerHistory error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/* ------------------------------------------------------------------ *
 * בדיקה מקדימה: מה ייכנס, מה לא בקטלוג, האם הקובץ שייך ללקוח הזה — וכמה
 * שורות תקועות הוא היה פותר.
 * ------------------------------------------------------------------ */
const checkImportCustomerHistory = async (req, res) => {
  try {
    const customer = await findCustomer(req.params.customerId);
    if (!customer) return res.status(404).send({ message: "לקוח לא נמצא" });

    const rows = readRows(req);
    if (rows.length > MAX_ROWS) {
      return res
        .status(400)
        .send({ message: `ניתן לבדוק עד ${MAX_ROWS} שורות בבקשה אחת` });
    }

    const { items, invalid } = aggregateRows(rows);
    const withProducts = await attachProducts(items);

    // ── האם הקובץ שייך ללקוח הזה ──
    //
    // כאן ההשוואה היא **מידע להחלטה של אדם** ואינה חוסמת; החסימה עצמה נעשית
    // ביבוא. שתיהן קוראות ל-compareCustomerNumbers כדי שלא יוכלו להיפרד.
    const fileNumbers = readCustomerNumbers(req);
    const cardNumber = toText(customer.erp?.customerNumber);
    const { comparable, matches } = compareCustomerNumbers(cardNumber, fileNumbers);
    // ‏null = אי אפשר להשוות, ולא "לא תואם". המסך מבדיל ביניהם.
    const numberMatches = comparable ? matches : null;

    const unknownSkus = [];
    const nameMismatches = [];
    const hiddenProducts = [];
    let matched = 0;
    let unknownCount = 0;
    let nameMismatchCount = 0;
    let hiddenProductCount = 0;

    for (const item of withProducts) {
      const product = item.catalogProduct;
      if (!product) {
        unknownCount += 1;
        if (unknownSkus.length < MAX_SAMPLES) {
          unknownSkus.push({ sku: item.sku, name: item.name || "", lines: item.lines });
        }
        continue;
      }

      matched += 1;
      if (product.status !== "show") {
        hiddenProductCount += 1;
        if (hiddenProducts.length < MAX_SAMPLES) {
          hiddenProducts.push({ sku: item.sku, catalogTitle: product.title?.he || "" });
        }
      }

      // ── אימות שמות ──
      //
      // ההתאמה נעשית לפי מק"ט בלבד, ולכן קובץ שבו עמודה הוזזה ייראה תקין
      // לחלוטין — כל המק"טים קיימים — אבל יבנה פרופיל שבו כל מוצר רשום תחת
      // שם של מוצר אחר. בקובץ תקין הפער כאן הוא אפס עד בודדים (בקובץ הדוגמה:
      // 7 שורות שנבדלות בגרשיים בלבד, שהנרמול כאן מסיר).
      const catalogName = normalizeName(product.title?.he || product.title?.en);
      const fileName = normalizeName(item.name);
      if (fileName && catalogName && fileName !== catalogName) {
        nameMismatchCount += 1;
        if (nameMismatches.length < MAX_SAMPLES) {
          nameMismatches.push({
            sku: item.sku,
            fileName: item.name,
            catalogTitle: product.title?.he || product.title?.en || "",
          });
        }
      }
    }

    const { from, to } = spanOf(withProducts);

    // ── ההשפעה נמדדת על הפרופיל שהקובץ הזה **יבנה**, ולא על מה ששמור ──
    //
    // אין כאן כתיבה למסד: הפרופיל נבנה בזיכרון מהשורות שנשלחו. כך אפשר לראות
    // מה הקובץ ייתן **לפני** שהוא דורס את מה שקיים.
    const profile = buildPurchaseProfile(
      withProducts.map(({ catalogProduct, ...item }) => item)
    );

    let impact = null;
    try {
      impact = await measureImpact(customer._id, profile);
    } catch (err) {
      // המדידה היא מידע, לא נכונות: כשל שלה אינו הופך בדיקה תקינה לשגיאה.
      // ‏null מוצג במסך כ"לא נמדד" ולא כאפס — אפס נקרא כמו "לא יעזור".
      console.log("measureImpact error: ", err);
    }

    const existing = await CustomerPurchaseHistory.findOne({ customer: customer._id })
      .select("itemsCount importedAt")
      .lean();

    // ── תצוגה מקדימה של הזמנות הארכיון ──
    //
    // נמדדת תמיד ולא רק כשהתיבה מסומנת: המספר הזה הוא מה שגורם למי שמעלה
    // לדעת שהאפשרות קיימת ומה היא תעשה בפועל. כשלון בה אינו הופך בדיקה
    // תקינה לשגיאה — היא מידע, לא נכונות.
    let archiveOrders = null;
    try {
      archiveOrders = await previewArchiveOrders({ customer, rows });
    } catch (err) {
      console.log("previewArchiveOrders error: ", err);
    }

    res.send({
      customer: String(customer._id),
      customerName: customerLabel(customer),
      customerNumber: cardNumber,
      fileCustomerNumbers: fileNumbers,
      // ‏null = אי אפשר להשוות (חסר מספר בכרטיס או בקובץ)
      numberMatches,
      received: rows.length,
      products: withProducts.length,
      invalid: invalid.length,
      invalidSamples: invalid.slice(0, MAX_SAMPLES),
      matched,
      unknown: unknownCount,
      unknownSkus,
      nameMismatchCount,
      nameMismatches,
      hiddenProductCount,
      hiddenProducts,
      spanFrom: from,
      spanTo: to,
      overwrites: existing
        ? { itemsCount: existing.itemsCount || 0, importedAt: existing.importedAt || null }
        : null,
      impact,
      archiveOrders,
    });
  } catch (err) {
    console.log("checkImportCustomerHistory error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/* ------------------------------------------------------------------ *
 * היבוא — דריסה מלאה בכתיבה אחת.
 * ------------------------------------------------------------------ */
const importCustomerHistory = async (req, res) => {
  try {
    const customer = await findCustomer(req.params.customerId);
    if (!customer) return res.status(404).send({ message: "לקוח לא נמצא" });

    const rows = readRows(req);
    if (rows.length === 0) {
      return res.status(400).send({ message: "לא נשלחו שורות היסטוריה" });
    }
    if (rows.length > MAX_ROWS) {
      return res
        .status(400)
        .send({ message: `ניתן לייבא עד ${MAX_ROWS} שורות בבקשה אחת` });
    }

    // ── החסימה על לקוח לא תואם ──
    //
    // זו הבדיקה החשובה ביותר בנתיב הזה. היסטוריה של לקוח אחד שנשמרת על כרטיס
    // של אחר אינה נראית כשגיאה בשום מסך: הפרופיל תקין, המק"טים קיימים,
    // והמערכת פשוט מתחילה להכריע את ההזמנות שלו לפי מה ש**לקוח אחר** קונה.
    //
    // החסימה חלה רק כששני המספרים קיימים וסותרים — כרטיס בלי מספר הנהח"ש הוא
    // מצב לגיטימי, ואי אפשר להסיק ממנו דבר. ‏force מאפשר לעקוף במודע, כי יש
    // מקרים אמיתיים (מיזוג כרטיסים, לקוח עם שני מספרים בהנהח"ש).
    const cardNumber = toText(customer.erp?.customerNumber);
    const fileNumbers = readCustomerNumbers(req);
    const { comparable, matches } = compareCustomerNumbers(cardNumber, fileNumbers);

    if (req.body?.force !== true && comparable && !matches) {
      return res.status(409).send({
        message:
          fileNumbers.length > 1
            ? `הקובץ מכיל היסטוריה של כמה לקוחות (${fileNumbers.join(", ")}), ` +
              `והכרטיס הזה הוא ${cardNumber}. שמירת כולו כאן תייחס ללקוח הזה ` +
              "שורות של אחרים."
            : `הקובץ שייך ללקוח ${fileNumbers.join(", ")} ובכרטיס רשום ${cardNumber}. ` +
              "ודא שזה הקובץ הנכון לפני היבוא.",
        code: "customer_number_mismatch",
        cardNumber,
        fileCustomerNumbers: fileNumbers,
      });
    }

    const { items, invalid } = aggregateRows(rows);
    if (items.length === 0) {
      return res.status(400).send({
        message: "לא נמצאה אף שורה תקינה בקובץ",
        invalid: invalid.length,
        invalidSamples: invalid.slice(0, MAX_SAMPLES),
      });
    }

    const withProducts = await attachProducts(items);
    const matchedInCatalog = withProducts.filter((item) => item.product).length;
    const { from, to } = spanOf(withProducts);

    const now = new Date();
    const update = {
      $set: {
        items: withProducts.map((item) => ({
          sku: item.sku,
          product: item.product,
          name: item.name,
          lines: item.lines,
          totalQty: item.totalQty,
          firstAt: item.firstAt,
          lastAt: item.lastAt,
          lastPrice: item.lastPrice,
          minPrice: item.minPrice,
          maxPrice: item.maxPrice,
        })),
        itemsCount: withProducts.length,
        matchedInCatalog,
        spanFrom: from,
        spanTo: to,
        sourceCustomerNumber: fileNumbers.join(", ").slice(0, MAX_NAME_LENGTH),
        fileName: toText(req.body?.fileName).slice(0, MAX_NAME_LENGTH),
        importedBy: req.user?.email || "",
        importedAt: now,
      },
    };

    // ── שני אדמינים שמייבאים לאותו לקוח באותו רגע ──
    //
    // ‏upsert על אינדקס ייחודי אינו אטומי מול תחרות: אם שתי הבקשות לא מצאו
    // מסמך, שתיהן ינסו ליצור אותו ואחת תיפול ב-11000 — כלומר 500 למי שהפסיד,
    // למרות שהקובץ שלו תקין. בניסיון החוזר המסמך כבר קיים והפעולה הופכת
    // לעדכון. האחרון קובע, וזו הסמנטיקה הנכונה לדריסה מלאה.
    let saved;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        saved = await CustomerPurchaseHistory.findOneAndUpdate(
          { customer: customer._id },
          update,
          { new: true, upsert: true, setDefaultsOnInsert: true }
        )
          .select("itemsCount matchedInCatalog importedAt spanFrom spanTo")
          .lean();
        break;
      } catch (err) {
        if (err.code !== 11000 || attempt === 2) throw err;
        console.warn(
          `[history] מרוץ על יצירת ההיסטוריה של ${customer._id} — ניסיון חוזר`
        );
      }
    }

    // ── הזמנות הארכיון ──
    //
    // רצות **אחרי** שהפרופיל נשמר, ולא במקביל: הפרופיל הוא מה שמשפיע על
    // קליטת הזמנות עתידיות, והוא חייב להישמר גם אם שחזור המסמכים נכשל.
    // כשלון כאן מדווח למסך ואינו מבטל יבוא שכבר הצליח — ההפך היה משאיר את
    // מי שמעלה עם הודעת שגיאה על פעולה שחציה בוצעה.
    let archiveOrders = null;
    if (req.body?.createOrders === true) {
      try {
        archiveOrders = await importArchiveOrders({
          customer,
          rows,
          fileName: toText(req.body?.fileName).slice(0, MAX_NAME_LENGTH),
          importedBy: req.user?.email || "",
        });
      } catch (err) {
        console.log("importArchiveOrders error: ", err);
        archiveOrders = { error: err.message };
      }
    }

    const archiveSummary = archiveOrders?.error
      ? ` (יצירת הזמנות הארכיון נכשלה: ${archiveOrders.error})`
      : archiveOrders
        ? `, ונוצרו ${archiveOrders.created} הזמנות ארכיון` +
          (archiveOrders.updated ? ` (${archiveOrders.updated} עודכנו)` : "")
        : "";

    res.send({
      message:
        `ההיסטוריה נשמרה: ${withProducts.length} מוצרים מתוך ${rows.length} שורות` +
        archiveSummary,
      customer: String(customer._id),
      received: rows.length,
      imported: withProducts.length,
      skipped: invalid.length,
      errors: invalid.slice(0, MAX_SAMPLES),
      matchedInCatalog,
      notInCatalog: withProducts.length - matchedInCatalog,
      notInCatalogSamples: withProducts
        .filter((item) => !item.product)
        .slice(0, MAX_SAMPLES)
        .map((item) => ({ sku: item.sku, name: item.name || "" })),
      spanFrom: saved?.spanFrom || from,
      spanTo: saved?.spanTo || to,
      itemsCount: saved?.itemsCount || withProducts.length,
      importedAt: saved?.importedAt || now,
      archiveOrders,
    });
  } catch (err) {
    console.log("importCustomerHistory error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/* ------------------------------------------------------------------ *
 * הסרת ההיסטוריה — הלקוח חוזר להכרעה לפי שם בלבד.
 * ------------------------------------------------------------------ */
const deleteCustomerHistory = async (req, res) => {
  try {
    const customer = await findCustomer(req.params.customerId);
    if (!customer) return res.status(404).send({ message: "לקוח לא נמצא" });

    const result = await CustomerPurchaseHistory.deleteOne({ customer: customer._id });
    if (result.deletedCount === 0) {
      return res.status(404).send({ message: "ללקוח אין היסטוריה שמורה" });
    }

    res.send({
      message: "ההיסטוריה הוסרה. ההזמנות של הלקוח יוכרעו לפי שם המוצר בלבד.",
      customer: String(customer._id),
    });
  } catch (err) {
    console.log("deleteCustomerHistory error: ", err);
    res.status(500).send({ message: err.message });
  }
};

module.exports = {
  getHistorySummary,
  getCustomerHistory,
  checkImportCustomerHistory,
  importCustomerHistory,
  deleteCustomerHistory,
  // מיוצאים לבדיקות
  aggregateRows,
  compareCustomerNumbers,
};

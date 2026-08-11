// controller/customerPriceListController.js
//
// ניהול המחירון הפרטי של לקוח: יבוא מאקסל, צפייה ומחיקה.
//
// היבוא הוא **דריסה מלאה** ולא מיזוג: מחירון הוא הקובץ שהלקוח קיבל, ולכן יבוא
// חדש מחליף את הקודם במלואו. מק"ט שנעלם מהקובץ החדש חוזר למחיר הקטלוג — וזו
// ההתנהגות הנכונה, כי מיזוג היה משאיר מחירים שהלקוח כבר לא אמור לקבל.
//
// העמודות מפוענחות בצד האדמין (utils/customerPriceListExcel.js) ומגיעות לכאן
// כשורות מנורמלות: { rowNumber, sku, name, price }.

const mongoose = require("mongoose");
const CustomerPriceList = require("../models/CustomerPriceList");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const { normalizeSku, numericSkuKey } = require("../utils/customerPriceList");

// תקרה לשורות בבקשה אחת. המחירון נשלח בבקשה אחת בכוונה — הדריסה חייבת להיות
// אטומית, ומחירון מפוצל לאצוות היה משאיר את הלקוח עם חצי מחירון אם אצווה נכשלה.
// הקטלוג כולו הוא כ-4,300 מוצרים, כלומר התקרה רחוקה מכל מחירון אמיתי.
//
// נמדד: 4,320 שורות עם שמות בעברית = 0.55MB, ו-20,000 שורות = 2.55MB — מתחת
// לתקרת `express.json` (4MB). הצד הלקוח בודק את גודל הגוף לפני השליחה כדי
// שקובץ חריג יקבל הודעה מדויקת ולא 413 סתמי.
const MAX_ROWS = 20000;

// תקרה לאורך שם המוצר שנשמר. השם הוא לתצוגה ולאימות בלבד, ותא אקסל יכול להכיל
// אלפי תווים — בלי התקרה שם אחד חריג היה מנפח את המסמך ואת גוף הבקשה
const MAX_NAME_LENGTH = 200;

// כמה שורות מוחזרות בתצוגת המחירון בפאנל הניהול
const DEFAULT_VIEW_LIMIT = 100;
const MAX_VIEW_LIMIT = 1000;

// כמה דוגמאות מפורטות חוזרות בבדיקה המקדימה. התצוגה צריכה להראות *מה* לא
// תואם ולא רק כמה, אבל קובץ פגום לא צריך לייצר תגובה של אלפי שורות
const MAX_SAMPLES = 200;

// תקרה לאורך מק"ט. מק"ט אמיתי הוא מזהה קצר; מחרוזת ארוכה בעמודה הזו היא
// עמודה שהוזזה או תא זבל, ואין טעם לשמור אותה כמפתח התאמה
const MAX_SKU_LENGTH = 64;

// ── רק ערכים פרימיטיביים ──
//
// גוף הבקשה הוא JSON חופשי, וערך שאינו מספר/מחרוזת מגיע לכאן כאובייקט. את זה
// גילתה בדיקת ההזרקה: `{"sku":{"$ne":null}}` עבר, כי `String({$ne:null})` הוא
// "[object Object]" — מחרוזת לא ריקה שעוברת את בדיקת "חסר מק\"ט", ונשמרה
// כמק"ט. האופרטור עצמו לא הגיע למונגו (הוא הומר למחרוזת), אבל שורת זבל כן
// נשמרה — ומכיוון שהיבוא דורס, היא החליפה מחירון תקין. ערך שאינו פרימיטיבי
// נדחה כאן במפורש, ולא "מנורמל" למשהו שנראה תקין.
const isPrimitive = (value) =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const toText = (value) => (isPrimitive(value) ? String(value).trim() : "");

const toPrice = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (!isPrimitive(value)) return null;
  const raw = toText(value);
  const direct = Number(raw);
  if (raw !== "" && Number.isFinite(direct)) return direct;
  // מחרוזת עם סימן מטבע או מפריד אלפים
  const cleaned = raw.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  if (!/\d/.test(cleaned)) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
};

// נרמול שם מוצר להשוואה בין הקובץ לקטלוג (בלי גרשיים ורווחים כפולים)
const normalizeName = (value) =>
  toText(value)
    .toLowerCase()
    .replace(/["'`״׳]/g, "")
    .replace(/\s+/g, " ");

/**
 * סינון השורות שהגיעו: מק"ט ומחיר חיובי הם תנאי סף, ומק"ט כפול בקובץ נלקח
 * מהשורה האחרונה (אותה סמנטיקה כמו ביבוא המוצרים).
 */
const collectValidRows = (rows) => {
  const bySku = new Map();
  const invalid = [];
  let duplicates = 0;

  for (const row of rows) {
    // ‏toText מחזיר "" לכל מה שאינו פרימיטיבי, ולכן אובייקט בעמודת המק"ט נופל
    // כאן על "חסר מק\"ט" ואינו הופך ל-"[object Object]"
    const sku = toText(row?.sku);
    const price = toPrice(row?.price);
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
    if (price === null) {
      invalid.push({ rowNumber, sku, name, message: "חסר מחיר" });
      continue;
    }
    if (price <= 0) {
      // מחיר 0 אינו "חינם" אלא "לא הוגדר" — שורה כזו הייתה מייצרת הזמנה
      // בסך 0 ש"ח בלי שאיש ישים לב
      invalid.push({ rowNumber, sku, name, message: "מחיר אינו חיובי" });
      continue;
    }

    if (bySku.has(sku)) duplicates += 1;
    bySku.set(sku, { sku, price, name: name || undefined, rowNumber });
  }

  return { items: [...bySku.values()], invalid, duplicates };
};

// המק"ט בקטלוג נשמר פעם כמחרוזת ופעם כמספר, ולכן השאילתה סובלת את שתי הצורות
// (אותו שיקול כמו ב-importSkuQuery ב-productController)
const skuQuery = (chunk) => {
  const numeric = chunk.map(Number).filter((num) => Number.isFinite(num));
  return numeric.length > 0
    ? { $or: [{ sku: { $in: chunk } }, { sku: { $in: numeric } }] }
    : { sku: { $in: chunk } };
};

const CHUNK_SIZE = 1000;

/**
 * שליפת המוצרים בקטלוג לפי מק"ט, עם המפתח המספרי כנפילה.
 * מחזירה מסמכים מלאים (שם, סטטוס, מחיר) ולכן מיועדת לקבוצה מוגבלת — העמוד
 * שמוצג במסך, או שורות של יבוא שעובר בדיקת שמות.
 */
const fetchCatalogBySku = async (skus) => {
  const bySku = new Map();
  const numericAliases = new Map();

  for (let i = 0; i < skus.length; i += CHUNK_SIZE) {
    const found = await Product.find(skuQuery(skus.slice(i, i + CHUNK_SIZE)))
      .select("_id sku title status prices.price")
      .lean();

    found.forEach((product) => {
      const sku = normalizeSku(product.sku);
      if (!sku) return;
      bySku.set(sku, product);
      const alias = numericSkuKey(sku);
      if (alias && alias !== sku) numericAliases.set(alias, product);
    });
  }

  for (const [key, product] of numericAliases) {
    if (!bySku.has(key)) bySku.set(key, product);
  }

  return bySku;
};

/**
 * "אילו מק"טים קיימים בקטלוג" — בלי המסמכים עצמם.
 *
 * מופרד מ-fetchCatalogBySku כי הספירה "כמה מהמחירון קיים בקטלוג" נמדדת על
 * **כל** שורות המחירון (יכולות להיות אלפים), ואילו הפרטים נדרשים רק לעמוד
 * המוצג. ‏distinct מחזיר ערכי מק"ט בלבד ולא אלפי מסמכים עם שם ומחיר.
 */
const fetchExistingSkus = async (skus) => {
  const set = new Set();

  for (let i = 0; i < skus.length; i += CHUNK_SIZE) {
    const values = await Product.distinct("sku", skuQuery(skus.slice(i, i + CHUNK_SIZE)));
    values.forEach((value) => {
      const sku = normalizeSku(value);
      if (!sku) return;
      set.add(sku);
      const alias = numericSkuKey(sku);
      if (alias) set.add(alias);
    });
  }

  return set;
};

// חיפוש במפה/בקבוצה: התאמה מדויקת קודמת, והצורה המספרית היא נפילה
const lookupCatalog = (catalogBySku, sku) => {
  if (catalogBySku.has(sku)) return catalogBySku.get(sku);
  const alias = numericSkuKey(sku);
  return alias ? catalogBySku.get(alias) || null : null;
};

const existsInCatalog = (existingSkus, sku) => {
  if (existingSkus.has(sku)) return true;
  const alias = numericSkuKey(sku);
  return Boolean(alias && existingSkus.has(alias));
};

const findCustomer = async (customerId) => {
  if (!mongoose.Types.ObjectId.isValid(customerId)) return null;
  return Customer.findById(customerId).select("_id name lastName email").lean();
};

/* ------------------------------------------------------------------ *
 * יבוא מרוכז: קובץ אחד עם המחירונים של כל הלקוחות
 * ------------------------------------------------------------------ */

// כמה לקוחות בבקשה אחת. הקובץ של ההנהח"ש הוא כ-63,000 שורות ל-685 לקוחות,
// כלומר הוא לא נכנס לבקשה אחת (תקרת express.json היא 4MB). הפיצול נעשה
// **לפי לקוח ולא לפי שורה**: מחירון של לקוח חייב להישלח שלם, אחרת אצווה שנכשלה
// באמצע הייתה משאירה אותו עם חצי מחירון — וכאן הדריסה היא מלאה.
const MAX_BULK_CUSTOMERS = 200;

// מספר לקוח מגיע פעם כמחרוזת ופעם כמספר (אקסל קורא "0552" כ-552), ולכן
// ההתאמה מנסה קודם את הצורה המדויקת ואז את הצורה המספרית — אותו שיקול בדיוק
// כמו במק"ט (numericSkuKey)
const numericCustomerKey = (value) => {
  if (!/^\d+$/.test(value)) return null;
  const num = Number(value);
  return Number.isSafeInteger(num) ? String(num) : null;
};

/**
 * מיפוי מספר לקוח (erp.customerNumber) → מסמך הלקוח.
 * המפתח המספרי נוסף רק כשאין התאמה מדויקת באותו מפתח.
 */
const fetchCustomersByNumber = async (numbers) => {
  const byNumber = new Map();
  const numericAliases = new Map();

  const unique = [...new Set(numbers.filter(Boolean))];
  for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
    const chunk = unique.slice(i, i + CHUNK_SIZE);
    const found = await Customer.find({ "erp.customerNumber": { $in: chunk } })
      .select("_id name lastName erp.customerNumber")
      .lean();

    found.forEach((customer) => {
      const number = toText(customer.erp?.customerNumber);
      if (!number) return;
      byNumber.set(number, customer);
      const alias = numericCustomerKey(number);
      if (alias && alias !== number) numericAliases.set(alias, customer);
    });
  }

  for (const [key, customer] of numericAliases) {
    if (!byNumber.has(key)) byNumber.set(key, customer);
  }

  return byNumber;
};

const lookupCustomer = (byNumber, number) => {
  if (byNumber.has(number)) return byNumber.get(number);
  const alias = numericCustomerKey(number);
  return alias ? byNumber.get(alias) || null : null;
};

const customerLabel = (customer) =>
  `${customer?.name || ""} ${customer?.lastName || ""}`.trim();

const readBulkEntries = (req) =>
  Array.isArray(req.body?.customers) ? req.body.customers : [];

/* ------------------------------------------------------------------ *
 * בדיקה מקדימה ליבוא המרוכז.
 *
 * הבדיקה נעשית על **מטא-נתונים בלבד** — מספרי הלקוח, ורשימת המק"טים
 * הייחודיים עם השם שליד כל אחד — ולא על השורות עצמן: הקובץ המלא אינו נכנס
 * לבקשה אחת, והמחיר עצמו אינו נבדק מול דבר.
 *
 * אימות השמות הוא הבדיקה החשובה כאן, בדיוק כמו ביבוא הבודד: ההתאמה נעשית לפי
 * מק"ט בלבד, ולכן קובץ שבו עמודה הוזזה ייראה תקין לחלוטין — כל המק"טים קיימים —
 * אבל יתמחר כל מוצר במחיר של מוצר אחר, והפעם אצל **כל** הלקוחות בבת אחת.
 * ------------------------------------------------------------------ */

// תקרות לקלט הבדיקה. הבקשה הזו מייצרת שאילתות $in לפי גודל הקלט, ובלי תקרה
// מערך מנופח היה מתורגם לאלפי שאילתות — עומס שמקורו בגוף הבקשה ולא בנתונים
const MAX_CHECK_CUSTOMERS = 5000;
const MAX_CHECK_PRODUCTS = MAX_ROWS;

const checkImportBulkPriceLists = async (req, res) => {
  try {
    const rawNumbers = Array.isArray(req.body?.customerNumbers)
      ? req.body.customerNumbers
      : [];
    if (rawNumbers.length > MAX_CHECK_CUSTOMERS) {
      return res
        .status(400)
        .send({ message: `ניתן לבדוק עד ${MAX_CHECK_CUSTOMERS} לקוחות בבקשה אחת` });
    }

    const numbers = [...new Set(rawNumbers.map(toText).filter(Boolean))];
    if (numbers.length === 0) {
      return res.status(400).send({ message: "לא נשלחו מספרי לקוח" });
    }

    const rawProducts = Array.isArray(req.body?.products) ? req.body.products : [];
    if (rawProducts.length > MAX_CHECK_PRODUCTS) {
      return res
        .status(400)
        .send({ message: `ניתן לבדוק עד ${MAX_CHECK_PRODUCTS} מוצרים בבקשה אחת` });
    }

    // מק"ט כפול ברשימה נלקח מהמופע האחרון, כמו בכל מקום אחר ביבוא
    const productsBySku = new Map();
    rawProducts.forEach((product) => {
      const sku = toText(product?.sku);
      if (!sku || sku.length > MAX_SKU_LENGTH) return;
      productsBySku.set(sku, toText(product?.name).slice(0, MAX_NAME_LENGTH));
    });

    const byNumber = await fetchCustomersByNumber(numbers);

    const matched = [];
    const unknownNumbers = [];
    for (const number of numbers) {
      const customer = lookupCustomer(byNumber, number);
      if (customer) matched.push({ number, customer });
      else if (unknownNumbers.length < MAX_SAMPLES) unknownNumbers.push(number);
    }

    // הספירה מופרדת מהדוגמאות: unknownNumbers חסום ב-MAX_SAMPLES, ודיווח
    // ‏length שלו כספירה היה מרגיע יותר מהמצב האמיתי
    const unknownCount = numbers.length - matched.length;

    // אילו מהלקוחות המותאמים כבר מחזיקים מחירון — כלומר למי היבוא **דורס**
    const existing = await CustomerPriceList.find({
      customer: { $in: matched.map((item) => item.customer._id) },
    })
      .select("customer itemsCount")
      .lean();
    const existingByCustomer = new Map(
      existing.map((list) => [String(list.customer), list.itemsCount || 0])
    );

    const skus = [...productsBySku.keys()];
    const catalogBySku = skus.length > 0 ? await fetchCatalogBySku(skus) : new Map();

    const unknownSkuSamples = [];
    const nameMismatches = [];
    let unknownSkuCount = 0;
    let nameMismatchCount = 0;
    let hiddenProductCount = 0;

    for (const [sku, name] of productsBySku) {
      const product = lookupCatalog(catalogBySku, sku);
      if (!product) {
        unknownSkuCount += 1;
        if (unknownSkuSamples.length < MAX_SAMPLES) unknownSkuSamples.push(sku);
        continue;
      }

      if (product.status !== "show") hiddenProductCount += 1;

      const catalogName = normalizeName(product.title?.he || product.title?.en);
      const fileName = normalizeName(name);
      if (fileName && catalogName && fileName !== catalogName) {
        nameMismatchCount += 1;
        if (nameMismatches.length < MAX_SAMPLES) {
          nameMismatches.push({
            sku,
            fileName: name,
            catalogTitle: product.title?.he || product.title?.en || "",
          });
        }
      }
    }

    res.send({
      customersInFile: numbers.length,
      matched: matched.length,
      unknown: unknownCount,
      unknownNumbers,
      overwrites: existing.length,
      // מי מהלקוחות כבר מחזיק מחירון, לתצוגה מפורטת במסך
      overwriteSamples: matched
        .filter((item) => existingByCustomer.has(String(item.customer._id)))
        .slice(0, MAX_SAMPLES)
        .map((item) => ({
          customerNumber: item.number,
          customerName: customerLabel(item.customer),
          itemsCount: existingByCustomer.get(String(item.customer._id)),
        })),
      matchedSamples: matched.slice(0, MAX_SAMPLES).map((item) => ({
        customerNumber: item.number,
        customerName: customerLabel(item.customer),
      })),
      skus: skus.length,
      skusInCatalog: skus.length - unknownSkuCount,
      unknownSkuCount,
      unknownSkuSamples,
      nameMismatchCount,
      nameMismatches,
      hiddenProductCount,
    });
  } catch (err) {
    console.log("checkImportBulkPriceLists error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/* ------------------------------------------------------------------ *
 * יבוא מרוכז של אצוות לקוחות מתוך קובץ אחד.
 *
 * כל לקוח באצווה מקבל **דריסה מלאה** של המחירון שלו, בדיוק כמו ביבוא הבודד —
 * מחירון הוא הקובץ שהלקוח קיבל. לקוח שאינו בקובץ אינו נגע כלל: היעדרותו מהקובץ
 * אינה "מחירון ריק" אלא פשוט לקוח שלא נכלל בייצוא הזה.
 * ------------------------------------------------------------------ */
const importBulkPriceLists = async (req, res) => {
  try {
    const entries = readBulkEntries(req);
    if (entries.length === 0) {
      return res.status(400).send({ message: "לא נשלחו מחירונים" });
    }
    if (entries.length > MAX_BULK_CUSTOMERS) {
      return res
        .status(400)
        .send({ message: `ניתן לייבא עד ${MAX_BULK_CUSTOMERS} לקוחות בבקשה אחת` });
    }

    const totalRows = entries.reduce(
      (sum, entry) => sum + (Array.isArray(entry?.rows) ? entry.rows.length : 0),
      0
    );
    if (totalRows > MAX_ROWS) {
      return res
        .status(400)
        .send({ message: `ניתן לייבא עד ${MAX_ROWS} שורות בבקשה אחת` });
    }

    const byNumber = await fetchCustomersByNumber(
      entries.map((entry) => toText(entry?.customerNumber))
    );

    // ‏toText ולא String(...): ערך שאינו פרימיטיבי היה נשמר כאן כמחרוזת
    // "[object Object]" במקום להידחות
    const fileName = toText(req.body?.fileName).slice(0, MAX_NAME_LENGTH);
    const importedBy = req.user?.email || "";
    const now = new Date();

    const failures = [];
    // כל המק"טים של האצווה נבדקים בשאילתה אחת ולא פעם ללקוח: לקוחות באותו קובץ
    // חולקים כמעט את אותו קטלוג, ובדיקה ללקוח הייתה מכפילה את אותה שאילתה
    // מאות פעמים
    const batchSkus = new Set();

    // ── דה-דופליקציה לפי הלקוח שנפתר, ולא לפי המספר שנשלח ──
    //
    // שני מספרים שונים יכולים להצביע על אותו לקוח ("0552" ו-552 נפתרים דרך
    // המפתח המספרי), ואותו מספר יכול להישלח פעמיים בגוף בקשה מעוות. שני
    // upsert על אותו לקוח באותה אצווה אינם שגיאה במונגו — הם פשוט נבלעים זה
    // בזה — וכך הדוח דיווח "נשמרו 2" כשבפועל נשמר מסמך אחד, **והמחיר שנשמר
    // נקבע בסדר לא מוגדר**. לכן הכפילות מקובצת כאן: המופע האחרון קובע, כמו
    // שורה כפולה בתוך מחירון, והקיבוץ מדווח.
    const byCustomerId = new Map();
    let collapsed = 0;

    for (const entry of entries) {
      const number = toText(entry?.customerNumber);
      const rows = Array.isArray(entry?.rows) ? entry.rows : [];

      if (!number) {
        failures.push({ customerNumber: "", message: "חסר מספר לקוח" });
        continue;
      }

      const customer = lookupCustomer(byNumber, number);
      if (!customer) {
        failures.push({
          customerNumber: number,
          customerName: toText(entry?.customerName),
          message: "לא נמצא לקוח עם מספר זה",
        });
        continue;
      }

      const { items, invalid, duplicates } = collectValidRows(rows);
      if (items.length === 0) {
        // מחירון בלי שורה תקינה **אינו** דורס את הקיים: קובץ פגום לא יאפס
        // ללקוח את המחירים שלו בשקט
        failures.push({
          customerNumber: number,
          customerName: customerLabel(customer),
          message: "לא נמצאה אף שורה תקינה",
        });
        continue;
      }

      const key = String(customer._id);
      if (byCustomerId.has(key)) collapsed += 1;

      byCustomerId.set(key, {
        customer,
        customerNumber: number,
        items,
        skipped: invalid.length,
        duplicates,
      });
    }

    const prepared = [...byCustomerId.values()];
    prepared.forEach((entry) =>
      entry.items.forEach((item) => batchSkus.add(item.sku))
    );

    const operations = prepared.map((entry) => ({
      updateOne: {
        filter: { customer: entry.customer._id },
        update: {
          $set: {
            items: entry.items.map(({ sku, price, name }) => ({ sku, price, name })),
            itemsCount: entry.items.length,
            fileName,
            importedBy,
            importedAt: now,
          },
        },
        upsert: true,
      },
    }));

    let created = 0;
    let updated = 0;

    if (operations.length > 0) {
      // ── מרוץ על יצירת המסמך ──
      //
      // ‏upsert על אינדקס ייחודי אינו אטומי מול תחרות: אם יבוא אחר (בודד או
      // מרוכז) יוצר את אותו מחירון באותו רגע, אחד מהם נופל ב-11000. בניסיון
      // החוזר המסמך כבר קיים והפעולה הופכת לעדכון. בלי זה אצווה שלמה הייתה
      // חוזרת כ-500, והמסך היה מסמן כנכשלים גם את הלקוחות שכן נשמרו בה.
      //
      // ‏ordered: false — לקוח אחד שנכשל לא עוצר את שאר האצווה
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const result = await CustomerPriceList.bulkWrite(operations, {
            ordered: false,
          });
          created = result.upsertedCount || 0;
          // ‏matchedCount ולא modifiedCount: יבוא חוזר וזהה אינו "משנה" מסמך
          // במונגו, והדוח היה מציג 0 עדכונים למרות שכל המחירונים נכתבו
          updated = result.matchedCount || 0;
          break;
        } catch (err) {
          if (err.code !== 11000 || attempt === 2) throw err;
          console.warn("[priceList] מרוץ על יצירת מחירון באצווה — ניסיון חוזר");
        }
      }
    }

    // ── ספירת המק"טים שאינם בקטלוג אינה חלק מהכתיבה ──
    //
    // היא רצה **אחרי** שהמחירונים כבר נשמרו, ולכן כשל שלה אינו כשל של היבוא.
    // בלי ההפרדה הזו שאילתה שנפלה הייתה מחזירה 500 על יבוא שהצליח, והמסך היה
    // מסמן את כל הלקוחות באצווה כנכשלים — ומזמין יבוא חוזר מיותר.
    let existingSkus = null;
    try {
      if (batchSkus.size > 0) existingSkus = await fetchExistingSkus([...batchSkus]);
    } catch (err) {
      console.log("importBulkPriceLists catalog stats error: ", err);
    }

    let notInCatalog = 0;
    const report = prepared.map((entry) => {
      const missing = existingSkus
        ? entry.items.filter((item) => !existsInCatalog(existingSkus, item.sku)).length
        : null;
      if (missing) notInCatalog += missing;
      return {
        customerNumber: entry.customerNumber,
        customerName: customerLabel(entry.customer),
        customerId: String(entry.customer._id),
        items: entry.items.length,
        skipped: entry.skipped,
        duplicates: entry.duplicates,
        notInCatalog: missing,
      };
    });

    res.send({
      message: `נשמרו מחירונים ל-${report.length} לקוחות`,
      customersReceived: entries.length,
      customersImported: report.length,
      // לקוחות שהופיעו יותר מפעם אחת באותה בקשה ואוחדו לכתיבה אחת
      collapsedDuplicates: collapsed,
      created,
      updated,
      rowsImported: prepared.reduce((sum, entry) => sum + entry.items.length, 0),
      // ‏null כשספירת הקטלוג לא רצה — כדי שהמסך לא יציג 0 שנראה כמו "הכול תקין"
      notInCatalog: existingSkus ? notInCatalog : null,
      failed: failures.length,
      failures: failures.slice(0, MAX_SAMPLES),
      results: report,
    });
  } catch (err) {
    console.log("importBulkPriceLists error: ", err);
    res.status(500).send({ message: err.message });
  }
};

const readRows = (req) => (Array.isArray(req.body?.rows) ? req.body.rows : []);

/* ------------------------------------------------------------------ *
 * סיכום המחירונים של כל הלקוחות — לרשימת הלקוחות בפאנל הניהול.
 * מחזיר רק מטא-נתונים (items הוא select:false), ולכן זו שאילתה קטנה גם
 * כשלמאות לקוחות יש מחירון של אלפי שורות.
 * ------------------------------------------------------------------ */
const getPriceListSummary = async (req, res) => {
  try {
    const lists = await CustomerPriceList.find({})
      .select("customer itemsCount fileName importedAt")
      .lean();

    res.send(
      lists.map((list) => ({
        customer: String(list.customer),
        itemsCount: list.itemsCount || 0,
        fileName: list.fileName || "",
        importedAt: list.importedAt || null,
      }))
    );
  } catch (err) {
    console.log("getPriceListSummary error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/* ------------------------------------------------------------------ *
 * המחירון של לקוח מסוים, מועשר בנתוני הקטלוג.
 * תומך ב-search (מק"ט או שם) וב-limit, כדי שמחירון של אלפי שורות לא ייגרר
 * במלואו למסך.
 * ------------------------------------------------------------------ */
const getCustomerPriceList = async (req, res) => {
  try {
    const customer = await findCustomer(req.params.customerId);
    if (!customer) return res.status(404).send({ message: "לקוח לא נמצא" });

    const list = await CustomerPriceList.findOne({ customer: customer._id })
      .select("+items")
      .lean();

    const meta = {
      customer: String(customer._id),
      customerName: `${customer.name || ""} ${customer.lastName || ""}`.trim(),
      exists: Boolean(list),
      itemsCount: list?.itemsCount || 0,
      fileName: list?.fileName || "",
      importedBy: list?.importedBy || "",
      importedAt: list?.importedAt || null,
      updatedAt: list?.updatedAt || null,
    };

    if (!list?.items?.length) {
      return res.send({ ...meta, items: [], returned: 0, matchedInCatalog: 0 });
    }

    const search = normalizeName(req.query?.search);
    const limit = Math.min(
      Math.max(Number(req.query?.limit) || DEFAULT_VIEW_LIMIT, 1),
      MAX_VIEW_LIMIT
    );

    // המק"ט מושווה בצורתו הקטנה גם הוא, אחרת חיפוש "ab" לא היה מוצא מק"ט "AB-9"
    const filtered = search
      ? list.items.filter(
          (item) =>
            normalizeSku(item.sku).toLowerCase().includes(search) ||
            normalizeName(item.name).includes(search)
        )
      : list.items;

    const page = filtered.slice(0, limit);

    // "כמה מהמחירון קיים בקטלוג" הוא המספר שאומר אם המחירון בכלל יתפוס
    // בהזמנות, ולכן הוא נמדד על **כל** השורות — אבל בשאילתת קיום קלה בלבד.
    // הפרטים (שם, מחיר קטלוג, סטטוס) נשלפים רק עבור העמוד שמוצג.
    const allSkus = list.items.map((item) => normalizeSku(item.sku)).filter(Boolean);
    const [existingSkus, catalogBySku] = await Promise.all([
      fetchExistingSkus(allSkus),
      fetchCatalogBySku(page.map((item) => normalizeSku(item.sku)).filter(Boolean)),
    ]);
    const matchedInCatalog = list.items.filter((item) =>
      existsInCatalog(existingSkus, normalizeSku(item.sku))
    ).length;

    res.send({
      ...meta,
      matchedInCatalog,
      filtered: filtered.length,
      returned: page.length,
      items: page.map((item) => {
        const product = lookupCatalog(catalogBySku, normalizeSku(item.sku));
        return {
          sku: item.sku,
          price: item.price,
          name: item.name || "",
          inCatalog: Boolean(product),
          catalogTitle: product?.title?.he || product?.title?.en || "",
          catalogPrice: product?.prices?.price ?? null,
          catalogStatus: product?.status || null,
        };
      }),
    });
  } catch (err) {
    console.log("getCustomerPriceList error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/* ------------------------------------------------------------------ *
 * בדיקה מקדימה לפני היבוא: מה יתפוס, מה לא קיים בקטלוג, ואיפה השם בקובץ
 * אינו תואם לשם בקטלוג.
 *
 * אי-התאמת שמות היא הבדיקה החשובה כאן: ההתאמה נעשית לפי מק"ט בלבד, ולכן קובץ
 * שבו עמודת המק"ט הוזזה בשורה אחת ייראה תקין לחלוטין — כל המק"טים קיימים — אבל
 * יתמחר כל מוצר במחיר של מוצר אחר.
 * ------------------------------------------------------------------ */
const checkImportCustomerPriceList = async (req, res) => {
  try {
    const customer = await findCustomer(req.params.customerId);
    if (!customer) return res.status(404).send({ message: "לקוח לא נמצא" });

    const rows = readRows(req);
    if (rows.length > MAX_ROWS) {
      return res
        .status(400)
        .send({ message: `ניתן לבדוק עד ${MAX_ROWS} שורות בבקשה אחת` });
    }

    const { items, invalid, duplicates } = collectValidRows(rows);
    const catalogBySku = await fetchCatalogBySku(items.map((item) => item.sku));

    // ── הספירה מופרדת מהדוגמאות ──
    //
    // מערכי הדוגמאות חסומים ב-MAX_SAMPLES כדי שקובץ פגום לא יחזיר אלפי שורות,
    // ולכן `array.length` **אינו** המספר האמיתי. דיווח שלו כספירה הציג "200
    // שמות אינם תואמים" כשבפועל היו 500 — כלומר המסך הרגיע יותר מהמצב.
    const unknownSkus = [];
    const nameMismatches = [];
    const hiddenProducts = [];
    let matched = 0;
    let unknownCount = 0;
    let nameMismatchCount = 0;
    let hiddenProductCount = 0;
    let samePriceCount = 0;

    for (const item of items) {
      const product = lookupCatalog(catalogBySku, item.sku);
      if (!product) {
        unknownCount += 1;
        if (unknownSkus.length < MAX_SAMPLES) {
          unknownSkus.push({ sku: item.sku, name: item.name || "", rowNumber: item.rowNumber });
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

      const catalogName = normalizeName(product.title?.he || product.title?.en);
      const fileName = normalizeName(item.name);
      if (fileName && catalogName && fileName !== catalogName) {
        nameMismatchCount += 1;
        if (nameMismatches.length < MAX_SAMPLES) {
          nameMismatches.push({
            sku: item.sku,
            rowNumber: item.rowNumber,
            fileName: item.name,
            catalogTitle: product.title?.he || product.title?.en || "",
          });
        }
      }

      if (Number(product.prices?.price) === item.price) samePriceCount += 1;
    }

    res.send({
      customer: String(customer._id),
      received: rows.length,
      valid: items.length,
      invalid: invalid.length,
      invalidSamples: invalid.slice(0, MAX_SAMPLES),
      duplicates,
      matched,
      unknown: unknownCount,
      unknownSkus,
      nameMismatchCount,
      nameMismatches,
      hiddenProductCount,
      hiddenProducts,
      samePriceCount,
    });
  } catch (err) {
    console.log("checkImportCustomerPriceList error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/* ------------------------------------------------------------------ *
 * יבוא המחירון — דריסה מלאה של המחירון הקודם בכתיבה אחת.
 * ------------------------------------------------------------------ */
const importCustomerPriceList = async (req, res) => {
  try {
    const customer = await findCustomer(req.params.customerId);
    if (!customer) return res.status(404).send({ message: "לקוח לא נמצא" });

    const rows = readRows(req);
    if (rows.length === 0) {
      return res.status(400).send({ message: "לא נשלחו שורות מחירון" });
    }
    if (rows.length > MAX_ROWS) {
      return res
        .status(400)
        .send({ message: `ניתן לייבא עד ${MAX_ROWS} שורות בבקשה אחת` });
    }

    const { items, invalid, duplicates } = collectValidRows(rows);
    if (items.length === 0) {
      return res.status(400).send({
        message: "לא נמצאה אף שורה תקינה בקובץ",
        invalid: invalid.length,
        invalidSamples: invalid.slice(0, MAX_SAMPLES),
      });
    }

    // שאילתת קיום בלבד — הדיווח צריך רק "כמה מהמק"טים בקטלוג", ולא שם ומחיר
    // של עד 20,000 מוצרים
    const existingSkus = await fetchExistingSkus(items.map((item) => item.sku));
    const unknownSkus = items
      .filter((item) => !existsInCatalog(existingSkus, item.sku))
      .map((item) => item.sku);

    // ── מק"ט שאינו בקטלוג נשמר בכל זאת ──
    //
    // מחירון מגיע מההנהח"ש ויכול להכיל מוצרים שעדיין לא נכנסו לקטלוג. שורה כזו
    // פשוט לא תתפוס עד שהמוצר ייווצר — וזה בדיוק מה שצריך לקרות. סינון שלה
    // כאן היה מחייב לייבא את המחירון מחדש אחרי כל מוצר שנוסף.
    const now = new Date();
    const update = {
      $set: {
        items: items.map(({ sku, price, name }) => ({ sku, price, name })),
        itemsCount: items.length,
        fileName: String(req.body?.fileName || "").slice(0, MAX_NAME_LENGTH),
        importedBy: req.user?.email || "",
        importedAt: now,
      },
    };

    // ── שני אדמינים שמייבאים לאותו לקוח באותו רגע ──
    //
    // ‏upsert על אינדקס ייחודי אינו אטומי מול תחרות: אם שתי הבקשות לא מצאו מסמך,
    // שתיהן ינסו ליצור אותו ואחת תיפול ב-11000 (כלומר 500 למי שהפסיד, למרות
    // שהמחירון שלו תקין). בניסיון החוזר המסמך כבר קיים והפעולה הופכת לעדכון.
    // הניצח האחרון קובע — זו הסמנטיקה הנכונה לדריסה מלאה.
    let saved;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        saved = await CustomerPriceList.findOneAndUpdate(
          { customer: customer._id },
          update,
          { new: true, upsert: true, setDefaultsOnInsert: true }
        )
          .select("itemsCount fileName importedAt")
          .lean();
        break;
      } catch (err) {
        if (err.code !== 11000 || attempt === 2) throw err;
        console.warn(
          `[priceList] מרוץ על יצירת המחירון של ${customer._id} — ניסיון חוזר`
        );
      }
    }

    res.send({
      message: `המחירון נשמר: ${items.length} שורות`,
      customer: String(customer._id),
      received: rows.length,
      imported: items.length,
      skipped: invalid.length,
      duplicates,
      matchedInCatalog: items.length - unknownSkus.length,
      notInCatalog: unknownSkus.length,
      notInCatalogSamples: unknownSkus.slice(0, MAX_SAMPLES),
      errors: invalid.slice(0, MAX_SAMPLES),
      itemsCount: saved?.itemsCount || items.length,
      importedAt: saved?.importedAt || now,
    });
  } catch (err) {
    console.log("importCustomerPriceList error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/* ------------------------------------------------------------------ *
 * הסרת המחירון — הלקוח חוזר למחירי הקטלוג.
 * ------------------------------------------------------------------ */
const deleteCustomerPriceList = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.customerId)) {
      return res.status(400).send({ message: "מזהה לקוח אינו תקין" });
    }

    const result = await CustomerPriceList.deleteOne({
      customer: req.params.customerId,
    });

    if (result.deletedCount === 0) {
      return res.status(404).send({ message: "ללקוח אין מחירון" });
    }

    res.send({ message: "המחירון הוסר — הלקוח חוזר למחירי הקטלוג" });
  } catch (err) {
    console.log("deleteCustomerPriceList error: ", err);
    res.status(500).send({ message: err.message });
  }
};

module.exports = {
  getPriceListSummary,
  getCustomerPriceList,
  checkImportCustomerPriceList,
  importCustomerPriceList,
  deleteCustomerPriceList,
  checkImportBulkPriceLists,
  importBulkPriceLists,
  MAX_ROWS,
  MAX_BULK_CUSTOMERS,
};

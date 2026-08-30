// controller/productController.js
const Product = require("../models/Product");
const {
  barcodeOf,
  findByBarcode,
  isSearchableBarcode,
  MIN_SEARCHABLE_LENGTH,
} = require("../utils/barcode");
const mongoose = require("mongoose");
const Category = require("../models/Category");
const { languageCodes } = require("../utils/data");
const { getAllOffers } = require("./offerController");
const Offer = require("../models/Offer");
const { parseText } = require("../utils/voiceParser");
const { resolveRootCategory } = require("../utils/rootCategory");
// מנוע הדירוג ובניית תנאי החיפוש חולצו ל-utils/productMatching.js כדי שהחיפוש
// הקולי וקליטת ההזמנות מהמייל/ווצאפ ישתמשו באותה לוגיקה בדיוק.
const {
  rankProductsByRelevance,
  buildProductSearchConditions,
} = require("../utils/productMatching");
const { notifyLowStock, getLowStockThreshold } = require("../lib/stock-controller/others");

// בריחה מתווים מיוחדים של regex כדי שקלט משתמש לא ישבור את השאילתה
// (למשל slug שמסתיים ב-"\" גרם ל-"Regular expression is invalid" ולשגיאת 500)
const escapeRegex = (str) => String(str ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const addProduct = async (req, res) => {
  try {
    // Check if the SKU already exists in the database
    const existingProduct = await Product.findOne({ sku: req.body.sku });

    if (existingProduct) {
      // If SKU already exists, throw an error
      return res.status(400).send({ message: "מספר סידורי כבר קיים במערכת, יש להכניס מספר אחר" });
    }

    const newProduct = new Product({
      ...req.body,
      // productId: cname + (count + 1),
      productId: req.body.productId
        ? req.body.productId
        : new mongoose.Types.ObjectId(),
    });

    await newProduct.save();
    res.send(newProduct);
  } catch (err) {
    console.log('addProduct error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

/* ------------------------------------------------------------------ *
 * יבוא מוצרים מקובץ אקסל של ההנהח"ש ("רשימת המוצרים - כל הספקים")
 * העמודות מפוענחות בצד האדמין ונשלחות לכאן כשורות מנורמלות.
 * העדכון הוא לפי מק"ט (sku): מוצר קיים מתעדכן, חדש נוצר. אין מחיקות.
 * ------------------------------------------------------------------ */

const IMPORT_MAX_ROWS = 2000;
// מגבלה על גודל הבדיקה המקדימה כדי שלא תיבנה שאילתת $in ענקית
const CHECK_MAX_VALUES = 20000;

// prices.price בחנות הוא המחיר הסופי שהלקוח משלם - הוא נשלח כמות שהוא
// כ-UnitCost לחשבונית עם דגל IsVatFree, ואין בשום מקום בפרויקט חישוב מע"מ
// על גביו. לכן רק עמודות "כולל מע"מ" יכולות לשמש כמקור מחיר: עמודה ללא
// מע"מ הייתה מתמחרת את כל הקטלוג בחסר בשיעור המע"מ, בלי שאיש ישים לב.
const IMPORT_PRICE_FIELDS = {
  consumerIncVat: "priceIncVat",
  storeIncVat: "storePriceIncVat",
};
const IMPORT_DEFAULT_PRICE_FIELD = "priceIncVat";

// סדר ה-fallback כשהעמודה שנבחרה ריקה/0 - גם כאן רק מחירים כולל מע"מ
const IMPORT_PRICE_FALLBACK = ["priceIncVat", "storePriceIncVat"];

const toImportNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  // ערך שכבר הגיע כמספר עובר כמו שהוא. ניקוי התווים למטה נועד למחרוזות
  // עם סימני מטבע ופסיקים, אבל הוא הורס סימון מדעי שאקסל מייצר לערכים
  // קטנים או גדולים מאוד: 7.1e-15 הפך ל-null ו-1e21 הפך ל-121 בשקט
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value).trim();
  // מחרוזת שכולה מספר תקין (כולל סימון מדעי) נקראת ישירות
  const direct = Number(raw);
  if (raw !== "" && Number.isFinite(direct)) return direct;
  // ניקוי סימני מטבע/אחוז/פסיקים. בלי בדיקת הספרה, ערך שאין בו מספר כלל
  // ("abc", "-", רווחים) היה מנוקה למחרוזת ריקה, ו-Number("") מחזיר 0 - כלומר
  // זבל נשמר כאפס במקום להיחשב ריק, ובניגוד לפענוח בצד האדמין שמחזיר null
  const cleaned = raw.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  if (!/\d/.test(cleaned)) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
};

const toImportString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

// נרמול שם לצורך התאמת קטגוריה קיימת (מסיר גרשיים ורווחים כפולים)
const normalizeImportName = (value) =>
  toImportString(value)
    .toLowerCase()
    .replace(/["'`״׳]/g, "")
    .replace(/\s+/g, " ");

const buildImportSlug = (value) =>
  toImportString(value)
    .toLowerCase()
    .replace(/[()"'`״׳]/g, "")
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const resolveImportPrice = (row, options) => {
  const primaryKey =
    IMPORT_PRICE_FIELDS[options.priceSource] || IMPORT_DEFAULT_PRICE_FIELD;
  const primary = toImportNumber(row[primaryKey]);
  if (primary > 0) return primary;

  if (options.priceFallback) {
    for (const key of IMPORT_PRICE_FALLBACK) {
      const value = toImportNumber(row[key]);
      if (value > 0) return value;
    }
  }
  return 0;
};

const buildErpPayload = (row) => ({
  barcode: toImportString(row.barcode),
  barcode2: toImportString(row.barcode2),
  externalSku: toImportString(row.externalSku),
  supplierSku: toImportString(row.supplierSku),
  unit: toImportString(row.unit),
  supplierName: toImportString(row.supplierName),
  supplierNumber: toImportNumber(row.supplierNumber),
  groupName: toImportString(row.groupName),
  groupCode: toImportNumber(row.groupCode),
  departmentCode: toImportNumber(row.departmentCode),
  cost: toImportNumber(row.cost),
  currency: toImportString(row.currency),
  notes: toImportString(row.notes),
  syncedAt: new Date(),
});

// עם ordered:false מונגוס משמיט שורות שנכשלו בולידציה ומצרף אותן לתוצאה.
// בלי לקרוא אותן היבוא היה מדווח שנוצרו יותר שורות ממה שנכתב בפועל.
const collectValidationErrors = (result, report) => {
  const validationErrors = result?.mongoose?.validationErrors || [];
  validationErrors.forEach((validationError) => {
    report.created = Math.max(0, report.created - 1);
    report.skipped += 1;
    if (report.errors.length < 50) {
      report.errors.push({
        rowNumber: null,
        sku: "",
        name: "",
        message: validationError?.message || "השורה לא עברה ולידציה",
      });
    }
  });
};

// מק"ט מהאקסל הוא מספר, ובמסד יכולים להיות מק"טים שנשמרו כמספר וכמחרוזת.
// חיפוש בשתי הצורות מונע יצירת מוצר כפול למק"ט שכבר קיים.
const importSkuQuery = (skus) => {
  const numeric = skus.map(Number).filter((num) => Number.isFinite(num));
  return numeric.length > 0
    ? { $or: [{ sku: { $in: skus } }, { sku: { $in: numeric } }] }
    : { sku: { $in: skus } };
};

// בדיקה מקדימה לפני היבוא: מה קיים במערכת ואילו קטגוריות חסרות
const checkImportProducts = async (req, res) => {
  try {
    const skus = (Array.isArray(req.body?.skus) ? req.body.skus : [])
      .map((sku) => toImportString(sku))
      .filter(Boolean);
    const groups = (Array.isArray(req.body?.groups) ? req.body.groups : [])
      .map((group) => toImportString(group))
      .filter(Boolean);

    if (skus.length > CHECK_MAX_VALUES || groups.length > CHECK_MAX_VALUES) {
      return res
        .status(400)
        .send({ message: `ניתן לבדוק עד ${CHECK_MAX_VALUES} רשומות בכל בקשה` });
    }

    const existingSkus = [];
    const chunkSize = 1000;
    for (let i = 0; i < skus.length; i += chunkSize) {
      const found = await Product.find(importSkuQuery(skus.slice(i, i + chunkSize)))
        .select("sku")
        .lean();
      found.forEach((product) => existingSkus.push(toImportString(product.sku)));
    }

    const categories = await Category.find({}).select("name").lean();
    const knownNames = new Set();
    categories.forEach((category) => {
      Object.values(category?.name || {}).forEach((value) => {
        if (typeof value === "string" && value.trim()) {
          knownNames.add(normalizeImportName(value));
        }
      });
    });

    const missingGroups = [
      ...new Set(groups.filter((group) => !knownNames.has(normalizeImportName(group)))),
    ];

    res.send({
      existingSkus,
      existingCount: existingSkus.length,
      newCount: skus.length - existingSkus.length,
      missingGroups,
      totalCategories: categories.length,
    });
  } catch (err) {
    console.log("checkImportProducts error: ", err);
    res.status(500).send({ message: err.message });
  }
};

const importProducts = async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const rawOptions = req.body?.options || {};

    if (rows.length === 0) {
      return res.status(400).send({ message: "לא נשלחו שורות לייבוא" });
    }
    if (rows.length > IMPORT_MAX_ROWS) {
      return res
        .status(400)
        .send({ message: `ניתן לשלוח עד ${IMPORT_MAX_ROWS} שורות בכל בקשה` });
    }

    const options = {
      createNew: rawOptions.createNew !== false,
      updateExisting: rawOptions.updateExisting !== false,
      updateName: !!rawOptions.updateName,
      updateCategory: !!rawOptions.updateCategory,
      updatePrices: !!rawOptions.updatePrices,
      updateStock: !!rawOptions.updateStock,
      updateStatus: !!rawOptions.updateStatus,
      zeroNegativeStock: rawOptions.zeroNegativeStock !== false,
      createCategories: rawOptions.createCategories !== false,
      priceFallback: rawOptions.priceFallback !== false,
      priceSource: rawOptions.priceSource || "consumerIncVat",
      // מוצר חדש נכנס מוסתר כברירת מחדל - עד שיוגדרו לו מחיר ותמונה
      newProductStatus: ["show", "hide", "active"].includes(rawOptions.newProductStatus)
        ? rawOptions.newProductStatus
        : "hide",
      defaultCategory: rawOptions.defaultCategory || null,
    };

    const report = {
      received: rows.length,
      created: 0,
      updated: 0,
      skipped: 0,
      duplicates: 0,
      pricesUpdated: 0,
      stockUpdated: 0,
      statusUpdated: 0,
      createdCategories: [],
      errors: [],
    };

    const addError = (row, message) => {
      report.skipped += 1;
      if (report.errors.length < 50) {
        report.errors.push({
          rowNumber: row?.rowNumber || null,
          sku: toImportString(row?.sku),
          name: toImportString(row?.name),
          message,
        });
      }
    };

    // 1. סינון שורות לא תקינות + הסרת מק"טים כפולים בתוך האצווה (האחרון קובע)
    const bySku = new Map();
    for (const row of rows) {
      const sku = toImportString(row?.sku);
      const name = toImportString(row?.name);
      if (!sku) {
        addError(row, 'חסר מק"ט');
        continue;
      }
      if (!name) {
        addError(row, "חסר שם מוצר");
        continue;
      }
      if (bySku.has(sku)) report.duplicates += 1;
      bySku.set(sku, { ...row, sku, name });
    }

    const validRows = [...bySku.values()];
    if (validRows.length === 0) {
      return res.send({ ...report, message: "לא נמצאו שורות תקינות לייבוא" });
    }

    // 2. מפת קטגוריות לפי שם (בכל שפה שמוגדרת בקטגוריה)
    const categories = await Category.find({})
      .select("name slug parentId")
      .lean();
    const categoryByName = new Map();
    const usedSlugs = new Set();
    categories.forEach((category) => {
      if (category.slug) usedSlugs.add(category.slug);
      Object.values(category?.name || {}).forEach((value) => {
        if (typeof value === "string" && value.trim()) {
          const key = normalizeImportName(value);
          if (!categoryByName.has(key)) categoryByName.set(key, category._id);
        }
      });
    });

    // 3. יצירת קטגוריות חסרות מ"שם קבוצה"
    const neededGroups = [
      ...new Set(
        validRows
          .map((row) => toImportString(row.groupName))
          .filter((group) => group && !categoryByName.has(normalizeImportName(group)))
      ),
    ];

    if (options.createCategories && neededGroups.length > 0) {
      // קטגוריית השורש ("Home"): גם דף הקטגוריות באדמין וגם התפריטים בחנות
      // מציגים רק את data[0].children, ולכן קטגוריה שנוצרת בלי parentId
      // נשמרת במסד אבל לא מופיעה בשום מסך
      const root = await resolveRootCategory(categories, usedSlugs);

      for (const group of neededGroups) {
        let slug = buildImportSlug(group) || "category";
        let attempt = 1;
        while (usedSlugs.has(slug)) {
          slug = `${buildImportSlug(group) || "category"}-${++attempt}`;
        }
        usedSlugs.add(slug);

        try {
          const created = await Category.create({
            name: { he: group, en: group },
            description: { he: "", en: "" },
            slug,
            status: "show",
            parentId: String(root._id),
            parentName: root.name,
          });
          categoryByName.set(normalizeImportName(group), created._id);
          report.createdCategories.push(group);
        } catch (categoryErr) {
          // יבוא מקביל יכול היה ליצור את אותה קטגוריה בין הקריאה ליצירה.
          // במקרה כזה משתמשים בקיימת במקום להפיל את כל היבוא
          const existingCategory = await Category.findOne({ slug })
            .select("_id")
            .lean();
          if (!existingCategory) throw categoryErr;
          categoryByName.set(normalizeImportName(group), existingCategory._id);
        }
      }
    }

    if (
      options.defaultCategory &&
      !mongoose.Types.ObjectId.isValid(options.defaultCategory)
    ) {
      return res
        .status(400)
        .send({ message: "קטגוריית ברירת המחדל שנשלחה אינה מזהה תקין" });
    }
    const fallbackCategoryId = options.defaultCategory
      ? new mongoose.Types.ObjectId(options.defaultCategory)
      : null;

    const resolveCategoryId = (row) => {
      const group = toImportString(row.groupName);
      if (group) {
        const found = categoryByName.get(normalizeImportName(group));
        if (found) return found;
      }
      return fallbackCategoryId;
    };

    // 4. שליפת המוצרים הקיימים לפי מק"ט
    const skus = validRows.map((row) => row.sku);
    const existingProducts = [];
    for (let i = 0; i < skus.length; i += 1000) {
      const found = await Product.find(importSkuQuery(skus.slice(i, i + 1000)))
        .select("_id sku slug title prices stock status category categories")
        .lean();
      existingProducts.push(...found);
    }
    const existingBySku = new Map(
      existingProducts.map((product) => [toImportString(product.sku), product])
    );

    // 5. מניעת התנגשות slug עבור מוצרים חדשים
    const newRows = validRows.filter((row) => !existingBySku.has(row.sku));
    const takenSlugs = new Set();
    if (newRows.length > 0) {
      const candidateSlugs = newRows
        .map((row) => buildImportSlug(row.name))
        .filter(Boolean);
      for (let i = 0; i < candidateSlugs.length; i += 1000) {
        const found = await Product.find({ slug: { $in: candidateSlugs.slice(i, i + 1000) } })
          .select("slug")
          .lean();
        found.forEach((product) => takenSlugs.add(product.slug));
      }
    }

    // 6. בניית פעולות הכתיבה
    const operations = [];

    for (const row of validRows) {
      const existing = existingBySku.get(row.sku);
      const price = resolveImportPrice(row, options);
      const rawStock = toImportNumber(row.stock);
      const stock =
        rawStock === null
          ? null
          : options.zeroNegativeStock && rawStock < 0
          ? 0
          : rawStock;

      if (existing) {
        if (!options.updateExisting) continue;

        const set = { erp: buildErpPayload(row) };

        if (options.updateName) {
          set.title = {
            ...(existing.title || {}),
            he: row.name,
            ...(toImportString(row.nameEn) ? { en: toImportString(row.nameEn) } : {}),
          };
        }

        if (options.updateCategory) {
          const categoryId = resolveCategoryId(row);
          if (categoryId) {
            const merged = [
              ...new Set([
                ...(existing.categories || []).map((id) => String(id)),
                String(categoryId),
              ]),
            ];
            set.category = categoryId;
            set.categories = merged.map((id) => new mongoose.Types.ObjectId(id));
          }
        }

        if (options.updatePrices && price > 0) {
          set.prices = {
            ...(existing.prices || {}),
            price,
            originalPrice: price,
          };
          report.pricesUpdated += 1;
        }

        if (options.updateStock && stock !== null) {
          set.stock = stock;
          report.stockUpdated += 1;
        }

        if (options.updateStatus) {
          set.status = row.active === false ? "hide" : "show";
          if (set.status !== existing.status) report.statusUpdated += 1;
        }

        if (!existing.slug) {
          let slug = buildImportSlug(row.name) || row.sku;
          if (takenSlugs.has(slug)) slug = `${slug}-${row.sku}`;
          takenSlugs.add(slug);
          set.slug = slug;
        }

        operations.push({
          updateOne: { filter: { _id: existing._id }, update: { $set: set } },
        });
        report.updated += 1;
        continue;
      }

      if (!options.createNew) continue;

      const categoryId = resolveCategoryId(row);
      if (!categoryId) {
        addError(
          row,
          toImportString(row.groupName)
            ? `הקטגוריה "${row.groupName}" לא קיימת ולא נבחרה קטגוריית ברירת מחדל`
            : "לשורה אין קבוצה ולא נבחרה קטגוריית ברירת מחדל"
        );
        continue;
      }

      let slug = buildImportSlug(row.name) || row.sku;
      if (takenSlugs.has(slug)) slug = `${slug}-${row.sku}`;
      takenSlugs.add(slug);

      const status =
        options.newProductStatus === "active"
          ? row.active === false
            ? "hide"
            : "show"
          : options.newProductStatus;

      operations.push({
        insertOne: {
          document: {
            productId: new mongoose.Types.ObjectId(),
            sku: row.sku,
            barcode: "",
            title: {
              he: row.name,
              en: toImportString(row.nameEn) || row.name,
            },
            // הערות ההנהח"ש נשמרות ב-erp.notes בלבד. הן פנימיות ואסור
            // שיהפכו לתיאור המוצר שמוצג ללקוחות בחנות
            description: { he: "", en: "" },
            slug,
            category: categoryId,
            categories: [categoryId],
            image: [],
            stock: stock === null ? 0 : stock,
            tag: [],
            prices: {
              price,
              originalPrice: price,
              storePrice: price,
              discount: 0,
              offers: [],
            },
            variants: [],
            isCombination: false,
            status,
            isVatFree: row.hasVat === true ? false : true,
            isStoreProduct: false,
            isCartpprod: "",
            purchaseLimit: null,
            weight: "",
            erp: buildErpPayload(row),
          },
        },
      });
      report.created += 1;
      if (price > 0) report.pricesUpdated += 1;
      if (stock !== null) report.stockUpdated += 1;
    }

    // 7. כתיבה לבסיס הנתונים באצוות
    for (let i = 0; i < operations.length; i += 500) {
      const batch = operations.slice(i, i + 500);
      if (batch.length === 0) continue;
      try {
        // ordered: false -> שורה שנכשלת בולידציה של הסכימה מושמטת בשקט
        // והשאר נכתבות. קוראים את השגיאות מהתוצאה כדי שלא ייעלמו מהדוח
        const result = await Product.bulkWrite(batch, { ordered: false });
        collectValidationErrors(result, report);
      } catch (bulkErr) {
        const writeErrors = bulkErr?.writeErrors || [];
        // כשל בשורה בודדת לא מפיל את כל האצווה - bulkWrite עם ordered:false
        // כותב את השאר, ולכן רק מתקנים את הספירה ומדווחים
        writeErrors.forEach((writeError) => {
          const failed = writeError?.err?.op || writeError?.getOperation?.() || {};
          const sku = toImportString(failed.sku || failed?.q?.sku);
          if (failed.insertOne || failed.sku) report.created = Math.max(0, report.created - 1);
          else report.updated = Math.max(0, report.updated - 1);
          report.skipped += 1;
          if (report.errors.length < 50) {
            report.errors.push({
              rowNumber: null,
              sku,
              name: "",
              message: writeError?.errmsg || writeError?.err?.errmsg || "כתיבה נכשלה",
            });
          }
        });
        if (writeErrors.length === 0) throw bulkErr;
      }
    }

    res.send({
      ...report,
      message: `יובאו ${report.created} מוצרים חדשים, עודכנו ${report.updated} מוצרים`,
    });
  } catch (err) {
    console.log("importProducts error: ", err);
    res.status(500).send({ message: err.message });
  }
};

const getShowingProducts = async (req, res) => {
  try {
    const products = await Product.find({
      status: "show",
      isStoreProduct: { $ne: true }
    }).sort({ _id: -1 });
    res.send(products);
    // console.log("products", products);
  } catch (err) {
    console.log('getShowingProducts error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

// מוצרי עגלה להצגה בעמוד checkout (isCartpprod === "yes", עד 4 מוצרים)
const getCartProducts = async (req, res) => {
  try {
    const products = await Product.find({
      status: "show",
      isStoreProduct: { $ne: true },
      isCartpprod: "yes",
    })
      .sort({ _id: -1 })
      .limit(4)
      .lean();
    res.send(products);
  } catch (err) {
    console.log("getCartProducts error:", err);
    res.status(500).send({ message: err.message });
  }
};

const getFacebookFeedCSV = async (req, res) => {
  try {
    const BASE_URL = process.env.STORE_URL; // הדומיין הציבורי שלך (חייב להיות נגיש לפייסבוק)
    const BRAND_NAME = process.env.COMPANY_NAME;

    const products = await Product.find({
      status: 'show',
      isStoreProduct: { $ne: true }
    }).sort({ _id: -1 }).populate({ path: "category", select: "name _id" });

    const headers = [
      'id',
      'title',
      'description',
      'availability',
      'condition',
      'price',
      'link',
      'image_link',
      'brand',
      'item_group_id'
    ];

    const csvRows = [headers.join(',')];

    for (const p of products) {

      const placeholderImage = "https://res.cloudinary.com/ahossain/image/upload/v1655097002/placeholder_kvepfp.png";
      const imageSrc = Array.isArray(p?.image)
        ? (p.image.length > 0 ? p.image[0] : placeholderImage)
        : (p?.image || placeholderImage);

      const row = [
        p.sku || p._id,
        p.title?.he || p.title?.en || '',
        p.description?.he || p.description?.en || p.title?.he + " מקטגוריית " + p.category?.name?.he || p.category?.name?.en || '',
        'in stock', // p.stock > 0 ? 'in stock' : 'out of stock',
        'new',
        `${Number(p.prices?.price || 0).toFixed(2)} ILS`,
        `${BASE_URL}/product/${p.slug || ''}`,
        imageSrc,
        BRAND_NAME,
        p.productId || p._id
      ].map(f => {
        const s = String(f ?? '');
        return s.includes(',') || s.includes('"') || s.includes('\n')
          ? `"${s.replace(/"/g, '""')}"`
          : s;
      });

      csvRows.push(row.join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="facebook-products-feed.csv"'
    );
    res.send('\uFEFF' + csvRows.join('\n'));
  } catch (err) {
    console.error('getFacebookFeedCSV error:', err);
    res.status(500).send({ message: err.message });
  }
};


// קבלת מוצר על פי חיפוש קולי
const findProductByTranscript = async (req, res) => {
  const { transcript } = req.query;
  // console.log('transcript :>> ', transcript);

  if (!transcript) {
    return res.status(400).json({
      message: {
        he: 'לא התקבל טקסט מתמלול',
        en: 'No transcript received'
      }
    });
  }

  /* ─── 1. ניתוח טקסט ─── */
  const { query, quantity, variations } = parseText(transcript);
  // console.log({ query, quantity, variations })

  if (!query) {
    return res.status(400).json({
      message: {
        he: 'לא נמצא שם מוצר בטקסט',
        en: 'No product name found in text'
      }
    });
  }

  /* ─── 2. חיפוש בדאטה־בייס ─── */
  try {
    // יצירת תנאי חיפוש מרובה - כולל ווריאציות צליליות
    const searchConditions = buildProductSearchConditions(query, variations);

    // שינוי מ-findOne ל-find כדי לקבל מספר תוצאות
    const products = await Product.find({
      status: 'show',
      stock: { $gt: 0 },
      ...(req.user?.isCashier ? {} : { isStoreProduct: { $ne: true } }),
      $or: searchConditions
    }).lean().limit(20); // מגביל ל-10 תוצאות למניעת עומס

    if (!products || products.length === 0) {
      return res.status(404).json({
        message: {
          he: `לא נמצא מוצר עבור "${transcript}"`,
          en: `No product found for "${transcript}"`
        }
      });
    }

    // אם יש רק תוצאה אחת - החזר אותה ישירות
    if (products.length === 1) {
      // console.log(`Found single product: "${products[0].title.he}"`);
      return res.json({ product: products[0], quantity });
    }

    // דירוג התוצאות לפי רלוונטיות וסדר מילים
    const queryWords = query.trim().split(/\s+/).filter(word => word.length > 1);
    const rankedProducts = rankProductsByRelevance(products, query, queryWords, variations);

    const bestProduct = rankedProducts[0].product;
    // console.log(`Found best product from ${products.length} results: "${bestProduct.title.he}" (score: ${rankedProducts[0].score})`);

    return res.json({ product: bestProduct, quantity });

  } catch (err) {
    console.error('voice-search error:', err);
    return res.status(500).json({
      message: {
        he: 'התרחשה שגיאה, נסו שוב',
        en: 'An error occurred, please try again'
      }
    });
  }
};

const getAllProducts = async (req, res) => {
  const { title, category, price, page, limit } = req.query;

  let queryObject = {};
  let sortObject = {};
  if (title) {
    const titleQueries = languageCodes.map((lang) => ({
      [`title.${lang}`]: { $regex: escapeRegex(title), $options: "i" },
    }));
    queryObject.$or = titleQueries;
  }

  if (price === "low") {
    sortObject = {
      "prices.originalPrice": 1,
    };
  } else if (price === "high") {
    sortObject = {
      "prices.originalPrice": -1,
    };
  } else if (price === "published") {
    queryObject.status = "show";
  } else if (price === "unPublished") {
    queryObject.status = "hide";
  } else if (price === "status-selling") {
    queryObject.stock = { $gt: 0 };
  } else if (price === "status-out-of-stock") {
    queryObject.stock = { $lt: 1 };
  } else if (price === "date-added-asc") {
    sortObject.createdAt = 1;
  } else if (price === "date-added-desc") {
    sortObject.createdAt = -1;
  } else if (price === "date-updated-asc") {
    sortObject.updatedAt = 1;
  } else if (price === "date-updated-desc") {
    sortObject.updatedAt = -1;
  } else {
    sortObject = { _id: -1 };
  }

  // console.log('sortObject', sortObject);

  if (category) {
    let categoryId;

    // בדיקה האם הקטגוריה היא ObjectId חוקי
    if (mongoose.Types.ObjectId.isValid(category) && category.length === 24) {
      categoryId = new mongoose.Types.ObjectId(category); // חיפוש לפי ObjectId
    } else {
      // חיפוש לפי slug של הקטגוריה
      const foundCategory = await Category.findOne({ slug: category });
      if (foundCategory) {
        categoryId = foundCategory._id;
      } else {
        // אם לא מצאנו קטגוריה, מחזירים תוצאה ריקה
        return res.send({
          products: [],
          totalDoc: 0,
          limits: Number(limit),
          pages: Number(page),
        });
      }
    }

    queryObject.categories = categoryId;
  }

  // page/limit עשויים להגיע ריקים (למשל בורר המוצרים במבצעים שמבקש את כל
  // המוצרים). במקרה כזה Number(undefined) הוא NaN, ו-NaN ב-$skip/$limit
  // באגרגציה זורק שגיאה ומחזיר 500 -> הרשימה חוזרת ריקה. לכן: ערך לא תקין
  // משמעו "ללא דפדוף / החזר הכל".
  const limits = Number(limit) > 0 ? Number(limit) : 0; // 0 = ללא הגבלה
  const pages = Number(page) > 0 ? Number(page) : 1;
  const skip = limits > 0 ? (pages - 1) * limits : 0;

  // ברירת מחדל: מוצרים שהוגדר להם "מספר סדר הופעה" (barcode) מופיעים בראש
  // הקטלוג, ממוספר נמוך לגבוה, ורק אחריהם שאר המוצרים. חל כל עוד לא נבחר
  // מיון מפורש (מחיר / תאריך).
  const explicitSorts = [
    "low",
    "high",
    "date-added-asc",
    "date-added-desc",
    "date-updated-asc",
    "date-updated-desc",
  ];
  const useSerialOrder = !explicitSorts.includes(price);

  try {
    const totalDoc = await Product.countDocuments(queryObject);

    let products;
    if (useSerialOrder) {
      // מיון מספרי לפי barcode עם עדיפות למוצרים שיש להם ערך, תוך שמירה על דפדוף
      const aggregated = await Product.aggregate([
        { $match: queryObject },
        {
          $addFields: {
            // 0 = יש מספר סדר (יופיע ראשון), 1 = אין מספר סדר
            _hasOrder: {
              $cond: [
                { $gt: [{ $strLenCP: { $ifNull: ["$barcode", ""] } }, 0] },
                0,
                1,
              ],
            },
            // הערך המספרי של מספר הסדר לצורך מיון מהקטן לגדול
            _orderNum: {
              $convert: {
                input: "$barcode",
                to: "double",
                onError: Number.MAX_SAFE_INTEGER,
                onNull: Number.MAX_SAFE_INTEGER,
              },
            },
          },
        },
        { $sort: { _hasOrder: 1, _orderNum: 1, _id: -1 } },
        ...(skip > 0 ? [{ $skip: skip }] : []),
        ...(limits > 0 ? [{ $limit: limits }] : []),
        { $unset: ["_hasOrder", "_orderNum"] },
      ]);

      // אכלוס הקטגוריות על תוצאות ה-aggregation (Mongoose תומך בכך על אובייקטים רגילים)
      products = await Product.populate(aggregated, [
        { path: "category", select: "_id name" },
        { path: "categories", select: "_id name" },
      ]);
    } else {
      let findQuery = Product.find(queryObject)
        .populate({ path: "category", select: "_id name" })
        .populate({ path: "categories", select: "_id name" })
        .sort(sortObject);
      if (limits > 0) {
        findQuery = findQuery.skip(skip).limit(limits);
      }
      products = await findQuery;
    }

    res.send({
      products,
      totalDoc,
      limits,
      pages,
    });
  } catch (err) {
    console.log('getAllProducts error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

// רשימת קטלוג רזה לבוררי מוצרים (הצעות מחיר, מחירונים).
// getAllProducts מחזיר את המסמך המלא — תמונות, תיאורים, וריאציות — וזה
// מיותר ואיטי כשצריך רק לבחור מק"ט מתוך 4,320 מוצרים. כאן חוזרים רק שלושת
// השדות שהבורר מציג, ללא דפדוף, כדי שהחיפוש יתבצע בדפדפן (כ-320KB).
//
// אין סינון לפי status: כל הקטלוג מוסתר כרגע בחזית, והצעת מחיר אינה תלויה
// בכך. גם isStoreProduct לא מסונן, כדי שהבורר יציע בדיוק את מה שהתמחור
// (lib/billing/pricing) יודע לתמחר.
const getProductsLite = async (req, res) => {
  try {
    const products = await Product.find({
      sku: { $exists: true, $nin: [null, ""] },
    })
      // erp.barcode הוא הברקוד שמודפס על התעודות והחשבוניות (ראה
      // utils/barcode.js). הוא מגיע לבורר כדי שאפשר יהיה גם לחפש לפיו
      // וגם להציג אותו לצד השם.
      .select("sku title prices.price erp.barcode")
      .lean();

    // Collator אחד לכל המיון; localeCompare לכל השוואה בונה אותו מחדש
    const collator = new Intl.Collator("he");
    const items = products
      .map((p) => ({
        sku: String(p.sku),
        barcode: barcodeOf(p) || "",
        name: p.title?.he || p.title?.en || String(p.sku),
        price: Number(p.prices?.price) || 0,
      }))
      .sort((a, b) => collator.compare(a.name, b.name));

    res.send({ products: items, total: items.length });
  } catch (err) {
    console.log("getProductsLite error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/**
 * חיפוש מוצר לפי ברקוד — מה שקורה כשמקלידים או סורקים ברקוד בשורת מסמך.
 *
 * מחזיר מערך ולא מוצר בודד בכוונה: הברקוד אינו ייחודי במסד (7 קבוצות
 * כפולות), ובחירה שקטה של אחד מהם הייתה מכניסה לתעודה את המוצר הלא נכון.
 * המסך מציג בורר כשחוזר יותר מאחד.
 */
const getProductByBarcode = async (req, res) => {
  try {
    const code = String(req.params.barcode || "").trim();
    if (!isSearchableBarcode(code)) {
      return res.status(400).send({
        message: `"${code}" אינו ברקוד תקין — נדרשות לפחות ${MIN_SEARCHABLE_LENGTH} ספרות`,
      });
    }

    const products = await findByBarcode(code);
    res.send({ barcode: code, products, total: products.length });
  } catch (err) {
    console.log("getProductByBarcode error: ", err);
    res.status(500).send({ message: err.message });
  }
};

const getProductBySlug = async (req, res) => {
  // console.log("slug", req.params.slug);
  try {
    const product = await Product.findOne({
      slug: req.params.slug,
      isStoreProduct: { $ne: true }
    });
    res.send(product);
  } catch (err) {
    console.log('getProductBySlug error: ', err);
    res.status(500).send({
      message: `Slug problem, ${err.message}`,
    });
  }
};

const getProductById = async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
    })
      .populate({ path: "category", select: "_id, name" })
      .populate({ path: "categories", select: "_id name" });

    res.send(product);
  } catch (err) {
    console.log('getProductById error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

// כרטיס מוצר מלא למסך "צפייה במוצר" באדמין: שדות החנות יחד עם נתוני
// ההנהח"ש מיבוא האקסל. erp מוגדר select:false במודל וצריך לבקש אותו במפורש -
// בלי זה אין שום מסך שמציג את הברקוד, הספק, העלות ושאר הנתונים מהקובץ.
// שימו לב: select("+erp") על השדה כולו עובד, select("+erp.x") על תת-שדה לא.
const getProductDetails = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
      .select("+erp")
      .populate({ path: "category", select: "_id name" })
      .populate({ path: "categories", select: "_id name" })
      .lean();

    if (!product) {
      return res.status(404).send({ message: "מוצר לא נמצא" });
    }

    res.send(product);
  } catch (err) {
    console.log("getProductDetails error: ", err);
    // מזהה שאינו ObjectId תקין מפיל את findById ב-CastError. בלי ההפרדה הזו
    // הפאנל היה מציג שגיאת שרת פנימית עם נוסח של mongoose במקום "מוצר לא נמצא"
    if (err?.name === "CastError") {
      return res.status(404).send({ message: "מוצר לא נמצא" });
    }
    res.status(500).send({
      message: err.message,
    });
  }
};

// שדות ההנהח"ש שניתן לערוך ידנית בפאנל. syncedAt לא נכלל בכוונה - הוא מסמן
// מתי הנתונים הגיעו מהאקסל, ועריכה ידנית לא אמורה לשנות אותו
const ERP_EDITABLE_TEXT = [
  "barcode",
  "barcode2",
  "externalSku",
  "supplierSku",
  "unit",
  "supplierName",
  "groupName",
  "currency",
  "notes",
];
const ERP_EDITABLE_NUMBER = [
  "supplierNumber",
  "groupCode",
  "departmentCode",
  "cost",
];

// ממזג את שדות ההנהח"ש שנשלחו מהטופס לתוך הערכים הקיימים. שדה שלא נשלח
// נשאר כפי שהוא, כדי שטופס חלקי לא ימחק נתונים שהגיעו מהאקסל
const mergeErpPayload = (existing, incoming) => {
  const merged = { ...(existing || {}) };
  ERP_EDITABLE_TEXT.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(incoming, field)) {
      merged[field] = toImportString(incoming[field]);
    }
  });
  ERP_EDITABLE_NUMBER.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(incoming, field)) {
      // toImportNumber מחזיר null לערך ריק - מספר ריק נשמר כחסר ולא כאפס
      merged[field] = toImportNumber(incoming[field]);
    }
  });
  return merged;
};

const updateProduct = async (req, res) => {
  // console.log('req.body: ', req.body)
  // console.log('update product')
  // console.log('variant',req.body.variants)
  try {
    // select("+erp") הכרחי: השדה מוגדר select:false, ובלעדיו mongoose לא טוען
    // אותו והשמירה הייתה מוחקת את נתוני ההנהח"ש מהמוצר
    const product = await Product.findById(req.params.id).select("+erp");
    // console.log("product", product);

    if (product) {
      // Check if the new SKU already exists in the database (excluding the current product)
      const existingProduct = await Product.findOne({ sku: req.body.sku, _id: { $ne: req.params.id } });

      if (existingProduct) {
        // If SKU already exists, throw an error
        return res.status(400).send({ message: "מספר סידורי כבר קיים במערכת, יש להכניס מספר אחר" });
      }

      // Proceed with updating the product
      product.title = { ...product.title, ...req.body.title };
      product.description = {
        ...product.description,
        ...req.body.description,
      };

      product.productId = req.body.productId;
      product.sku = req.body.sku;
      product.barcode = req.body.barcode;
      product.slug = req.body.slug;
      product.categories = req.body.categories;
      product.category = req.body.category;
      product.show = req.body.show;
      product.isCombination = req.body.isCombination;
      product.variants = req.body.variants;
      product.stock = req.body.stock;
      product.prices = req.body.prices;
      product.image = req.body.image;
      product.tag = req.body.tag;
      product.isVatFree = req.body.isVatFree;
      product.isStoreProduct = req.body.isStoreProduct;
      // הסרה מהחנות — סטטוס המוצר (show/hide). מסומן בטופס = "hide" = לא מוצג בחנות
      if (req.body.hasOwnProperty("status")) product.status = req.body.status;
      if (req.body.hasOwnProperty("isCartpprod")) product.isCartpprod = req.body.isCartpprod;
      product.purchaseLimit = req.body.purchaseLimit;
      if (req.body.hasOwnProperty("weight")) product.weight = req.body.weight;

      // נתוני ההנהח"ש נערכים ידנית מהפאנל. שים לב: יבוא אקסל הבא של אותו
      // מק"ט ידרוס את הערכים האלה בחזרה לערכי הקובץ
      if (req.body.erp && typeof req.body.erp === "object") {
        product.erp = mergeErpPayload(
          product.erp ? product.erp.toObject() : {},
          req.body.erp
        );
      }

      await product.save();

      // בדיקת מלאי נמוך גם בעדכון ידני של המוצר (לא חוסם את התגובה)
      const threshold = await getLowStockThreshold();
      await notifyLowStock(product, threshold);

      res.send({ data: product, message: "Product updated successfully!" });
    } else {
      res.status(404).send({
        message: "Product Not Found!",
      });
    }
  } catch (err) {
    console.log('updateProduct error: ', err);
    res.status(404).send(err.message);
  }
};

const updateProductPrice = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    // console.log("product", product);

    if (product) {
      product.prices.originalPrice = req.body.price;
      product.prices.price = req.body.price;
      product.prices.storePrice = req.body.storePrice;

      await product.save();
      res.send({ data: product, message: "Product price updated successfully!" });
    } else {
      res.status(404).send({
        message: "Product Not Found!",
      });
    }
  } catch (err) {
    console.log('updateProductPrice error: ', err);
    res.status(404).send(err.message);
  }
};

const updateManyProducts = async (req, res) => {
  try {
    const updatedData = {};
    for (const key of Object.keys(req.body)) {
      if (
        req.body[key] !== "[]" &&
        Object.entries(req.body[key]).length > 0 &&
        req.body[key] !== req.body.ids
      ) {
        // console.log('req.body[key]', typeof req.body[key]);
        updatedData[key] = req.body[key];
      }
    }

    // console.log("updated data", updatedData);

    await Product.updateMany(
      { _id: { $in: req.body.ids } },
      {
        $set: updatedData,
      },
      {
        multi: true,
      }
    );
    res.send({
      message: "Products update successfully!",
    });
  } catch (err) {
    console.log('updateManyProducts error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const updateStatus = async (req, res) => {
  try {
    const newStatus = req.body.status;
    console.log('newStatus', newStatus);

    await Product.updateOne(
      { _id: req.params.id },
      {
        $set: {
          status: newStatus,
        },
      }
    );

    res.status(200).send({
      message: `Product ${newStatus} Successfully!`,
    });
  } catch (err) {
    console.log('updateStatus error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const deleteProduct = async (req, res) => {
  try {
    await Product.deleteOne({ _id: req.params.id });
    res.status(200).send({
      message: "Product Deleted Successfully!",
    });
  } catch (err) {
    console.log('deleteProduct error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

// ערך המיון שמקבל ברקוד שאינו מספרי. גדול מכל ברקוד EAN-13 בן 13 ספרות,
// ולכן אינו יכול להתנגש בברקוד אמיתי.
const BARCODE_SORT_LAST = 99999999999999;

const getShowingStoreProducts = async (req, res) => {
  try {
    const queryObject = {};

    // הוספת תנאי לסינון מוצרים שהמלאי שלהם אינו 0
    // queryObject.stock = { $ne: 0 };

    // הוספת תנאי לסינון מוצרים שהם לא מוצרי חנות
    queryObject.isStoreProduct = { $ne: true };

    // פרמטרים מ-req.query אינם בהכרח מחרוזות. מנתח השאילתות של Express (qs
    // במצב extended) הופך ‎?category[$ne]=null לאובייקט ‎{ $ne: null }, וערך
    // כפול (‎?sku=a&sku=b) למערך. אובייקט כזה זלג עד כה היישר לתוך
    // ‎Category.findOne({ slug: category }) — כלומר אופרטור Mongo מוזרק מבחוץ
    // ובורר קטגוריה שרירותית תוך עקיפת ההתאמה ל-slug. אימות בכניסה, במקום אחד,
    // מנטרל את כל הווקטורים האלה לפני שהערך נוגע בשאילתה.
    const asQueryString = (value) => (typeof value === "string" ? value.trim() : "");

    const category = asQueryString(req.query.category);
    const title = asQueryString(req.query.title);
    const slug = asQueryString(req.query.slug);
    const sku = asQueryString(req.query.sku);
    const sortParam = asQueryString(req.query.sort);

    queryObject.status = "show";

    // עימוד ומיון בצד השרת עבור דפדוף בקטגוריה.
    //
    // עד כאן הענף של category/title החזיר limit(100) קשיח, ולכן קטגוריה כמו
    // "מזון" (3,590 מוצרים) הציגה בחנות 100 מוצרים בלבד — כל השאר לא היו
    // נגישים בשום מסלול. החזרת הכל אינה פתרון: המערך המלא נשלח פעמיים בעמוד
    // (HTML של SSR + JSON של ההידרציה) ומגיע ל-3MB+ לקטגוריה אחת.
    //
    // העימוד הוא opt-in: בלי page/limit בשאילתה ההתנהגות זהה לקודם, כדי שדף
    // הבית והחיפוש שקוראים לאותו endpoint לא ישתנו.
    //
    // התנאי מוגבל בכוונה לענף של title/category — רק הוא יודע לעמד. בלי ההגבלה
    // קריאה כמו ‎?slug=x&page=1 הייתה מדלגת על המיון העברי בסוף הפונקציה
    // ומחזירה totalProducts=0 לצד רשימת מוצרים מלאה.
    const isPaginated =
      Boolean(title || category) &&
      (req.query.page !== undefined || req.query.limit !== undefined);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const skip = (page - 1) * limit;
    let totalProducts = 0;

    // המיון חייב לרוץ על כל הקטגוריה ולא על העמוד שהתקבל, אחרת "מהזול ליקר"
    // ממיין 48 מוצרים אקראיים. שמות הערכים תואמים ל-SortDropdown בחנות.
    //
    // ‎"title.he" כשובר-שוויון בכל מיון הוא שחזור מדויק של ההתנהגות הקודמת:
    // הרשימה הגיעה מהשרת ממוינת אלפביתית, ו-Array.prototype.sort של הדפדפן
    // יציב — כך ששוויון במפתח הראשי השאיר את הסדר האלפביתי. בלי זה 4,289
    // המוצרים שאין להם שדה sales היו מקבלים סדר שרירותי לפי ‎_id.
    const sortStage = (() => {
      switch (sortParam) {
        case "Low":
          return { "prices.price": 1, "title.he": 1, _id: 1 };
        case "High":
          return { "prices.price": -1, "title.he": 1, _id: 1 };
        case "Alphabetical":
          return { "title.he": 1, _id: 1 };
        // "Popular" הוא ברירת המחדל: קודם מוצרים עם ברקוד לפי הברקוד המספרי
        // (הברקוד משמש כאן כסדר התצוגה בחנות), ואחריהם השאר לפי מכירות.
        default:
          return { hasBarcode: -1, barcodeNumber: 1, sales: -1, "title.he": 1, _id: 1 };
      }
    })();

    // רק "Popular" זקוק לשדות מחושבים (hasBarcode/barcodeNumber) ולכן רק הוא
    // חייב aggregation. שאר המיונים רצים ב-find, שאינו מממש את כל הקטגוריה
    // בזיכרון לפני ה-skip/limit.
    const needsComputedSort = !["Low", "High", "Alphabetical"].includes(sortParam);

    // collation עברי — נבדק מול localeCompare('he') ומחזיר סדר זהה. בלעדיו
    // המיון הוא לפי בייטים, ואז שמות באנגלית ("HAPPY HOUR") נדחפים לפני א'.
    const HE_COLLATION = { locale: "he" };

    // חיפוש לפי קטגוריה
    if (category) {
      let categoryId;

      // בדיקה האם הקטגוריה היא ObjectId חוקי.
      // ההמרה ל-ObjectId חובה ולא קוסמטית: Product.find ממיר מחרוזת לבדו לפי
      // הסכימה, אבל aggregate (המסלול של העימוד) אינו ממיר — ומחרוזת ב-$in
      // פשוט לא תתאים לאף מסמך, כלומר קטגוריה ריקה בלי שגיאה.
      if (mongoose.Types.ObjectId.isValid(category) && category.length === 24) {
        categoryId = new mongoose.Types.ObjectId(category);
      } else {
        // חיפוש לפי slug של הקטגוריה
        const foundCategory = await Category.findOne({ slug: category });

        if (foundCategory) {
          categoryId = foundCategory._id; // אם מצאנו קטגוריה, נשתמש ב-ObjectId שלה
        } else {
          // אם לא מצאנו קטגוריה לפי הslug, להחזיר מוצרים ריקים
          return res.send({
            products: [],
            popularProducts: [],
            relatedProducts: [],
            discountedProducts: [],
            productsWithOffers: [],
            totalProducts: 0,
          });
        }
      }

      // שימוש בקטגוריה שנמצאה כדי להוסיף אותה לשאילתת החיפוש
      queryObject.categories = {
        $in: [categoryId],
      };
    }

    if (title) {
      const titleQueries = languageCodes.map((lang) => ({
        [`title.${lang}`]: { $regex: escapeRegex(title), $options: "i" },
      }));

      queryObject.$or = titleQueries;
    }

    if (slug) {
      queryObject.slug = { $regex: escapeRegex(slug), $options: "i" };
    }

    if (sku) {
      queryObject.sku = sku;
    }

    let products = [];
    let popularProducts = [];
    let discountedProducts = [];
    let productsWithOffers = [];
    let relatedProducts = [];

    if (slug) {
      products = await Product.find(queryObject)
        .populate({ path: "category", select: "name _id" })
        .sort({ _id: -1 })
        .limit(100);
      relatedProducts = await Product.find({
        category: products[0]?.category,
        stock: { $ne: 0 },
        isStoreProduct: { $ne: true }
      }).populate({ path: "category", select: "_id name" });
    } else if (sku) {
      products = await Product.find({
        sku,
        isStoreProduct: { $ne: true }
      }).populate({ path: "category" });
    } else if (title || category) {
      if (isPaginated) {
        totalProducts = await Product.countDocuments(queryObject);

        if (needsComputedSort) {
          // barcodeNumber/hasBarcode אינם קיימים במסמך, ולכן המיון "Popular"
          // מחייב aggregation שמחשב אותם לפני ה-sort. הברקוד נשמר כמחרוזת (וגם
          // כמחרוזת ריקה), וההמרה עוברת דרך $convert עם onError/onNull כי ערך
          // לא מספרי זורק. היעד הוא long ולא int בכוונה: ברקוד EAN-13 אמיתי
          // חורג מ-int32, ו-int היה מפיל אותו ל-onError כלומר מאבד את הסדר.
          products = await Product.aggregate([
            { $match: queryObject },
            {
              $addFields: {
                hasBarcode: {
                  $cond: [
                    { $in: [{ $ifNull: ["$barcode", ""] }, ["", null]] },
                    0,
                    1,
                  ],
                },
                barcodeNumber: {
                  $convert: {
                    input: "$barcode",
                    to: "long",
                    // סנטינל גדול מכל ברקוד EAN-13 (13 ספרות) — ברקוד שאינו
                    // מספרי נדחף לסוף קבוצת בעלי-הברקוד ולא מתנגש בערך אמיתי
                    onError: BARCODE_SORT_LAST,
                    onNull: BARCODE_SORT_LAST,
                  },
                },
              },
            },
            { $sort: sortStage },
            { $skip: skip },
            { $limit: limit },
            { $project: { hasBarcode: 0, barcodeNumber: 0 } },
          ])
            .collation(HE_COLLATION)
            // הגנה לעתיד: $sort על קטגוריה גדולה מתבצע בזיכרון, ובלי הדגל
            // חריגה ממגבלת 100MB מפילה את הבקשה כולה במקום לגלוש לדיסק.
            .allowDiskUse(true);

          products = await Product.populate(products, {
            path: "category",
            select: "name _id",
          });
        } else {
          products = await Product.find(queryObject)
            .collation(HE_COLLATION)
            .sort(sortStage)
            .skip(skip)
            .limit(limit)
            .populate({ path: "category", select: "name _id" });
        }
      } else {
        products = await Product.find(queryObject)
          .populate({ path: "category", select: "name _id" })
          .sort({ _id: -1 })
          .limit(100);
      }
    } else {
      // קודם כל נביא מוצרים עם barcode
      const barcodeQuery = { ...queryObject, barcode: { $exists: true, $ne: null, $ne: "" } };
      let productsWithBarcode = await Product.find(barcodeQuery)
        .populate({ path: "category", select: "name _id" })
        .lean(); // משתמשים ב-lean() כדי לקבל אובייקטים רגילים למיון

      // מיון מוצרים עם barcode לפי המספר שמופיע בברקוד (מהקטן לגדול)
      productsWithBarcode = productsWithBarcode
        .map(product => {
          // חילוץ המספר מהברקוד
          const barcodeNumber = parseInt(product.barcode) || 0;
          return { ...product, barcodeNumber };
        })
        .sort((a, b) => a.barcodeNumber - b.barcodeNumber)
        .map(({ barcodeNumber, ...product }) => product); // הסרת השדה הזמני

      const barcodeCount = productsWithBarcode.length;
      const targetLimit = 20;

      if (barcodeCount < targetLimit) {
        // אם אין 20 מוצרים עם barcode, נשלים לפי sales
        const remainingCount = targetLimit - barcodeCount;
        
        // שאילתה למוצרים ללא barcode (או עם barcode ריק)
        const noBarcodeQuery = { ...queryObject };
        // הוספת תנאי barcode - אם יש $or קיים, נשתמש ב-$and
        if (noBarcodeQuery.$or) {
          noBarcodeQuery.$and = [
            { $or: noBarcodeQuery.$or },
            {
              $or: [
                { barcode: { $exists: false } },
                { barcode: null },
                { barcode: "" }
              ]
            }
          ];
          delete noBarcodeQuery.$or;
        } else {
          noBarcodeQuery.$or = [
            { barcode: { $exists: false } },
            { barcode: null },
            { barcode: "" }
          ];
        }

        // נביא מוצרים לפי sales שלא כבר יש להם barcode
        const productsBySales = await Product.find(noBarcodeQuery)
          .populate({ path: "category", select: "name _id" })
          .sort({ sales: -1 })
          .limit(remainingCount)
          .lean();

        // שילוב התוצאות: קודם מוצרים עם barcode, אחר כך לפי sales
        popularProducts = [...productsWithBarcode, ...productsBySales];
      } else {
        // אם יש 20 או יותר מוצרים עם barcode, נקח רק את הראשונים
        popularProducts = productsWithBarcode.slice(0, targetLimit);
      }

      // חיפוש קטגוריית מבצעים לפי slug
      const offersCategory = await Category.findOne({ slug: "offers" });

      if (offersCategory) {
        discountedProducts = await Product.find({
          isStoreProduct: { $ne: true },
          status: "show",
          categories: { $in: [offersCategory._id] }
        })
          .populate({ path: "category", select: "name _id" })
          .sort({ _id: -1 })
          .limit(20);
      } else {
        // אם לא נמצאה קטגוריית מבצעים, מחזירים מוצרים עם הנחה
        discountedProducts = await Product.find({
          isStoreProduct: { $ne: true },
          $or: [
            {
              $and: [
                { isCombination: true },
                {
                  variants: {
                    $elemMatch: {
                      discount: { $gt: "0.00" },
                    },
                  },
                },
              ],
            },
            {
              $and: [
                { isCombination: false },
                {
                  $expr: {
                    $gt: [{ $toDouble: "$prices.discount" }, 0],
                  },
                },
              ],
            },
          ],
        })
          .populate({ path: "category", select: "name _id" })
          .sort({ _id: -1 })
          .limit(20);
      }

      const offers = await Offer.find().populate({ path: "products" });

      productsWithOffers = offers.flatMap((offer) => offer.products)
        .filter(p => p.stock > 0 && p.isStoreProduct !== true);

      // סינון כפילויות
      productsWithOffers = productsWithOffers.filter(
        (product, index, self) =>
          index === self.findIndex((p) => p._id.toString() === product._id.toString())
      );
    }

    // 'hide' מיון המוצרים לפי כותרת בעברית והסרת מוצרים שבסטטוס
    //
    // בעימוד המיון כבר נעשה ב-DB על כל הקטגוריה. מיון חוזר כאן היה מסדר מחדש
    // רק את 48 המוצרים של העמוד הנוכחי ומבטל בפועל את בחירת המיון של הלקוח.
    products = products.filter(p => p.status == "show");
    if (!isPaginated) {
      products = products.sort((a, b) => a.title.he.localeCompare(b.title.he, 'he'));
    }
    popularProducts = popularProducts.filter(p => p.status == "show")
    // .sort((a, b) => a.title.he.localeCompare(b.title.he, 'he'));
    relatedProducts = relatedProducts.filter(p => p.status == "show")
      .sort((a, b) => a.title.he.localeCompare(b.title.he, 'he'));
    discountedProducts = discountedProducts.filter(p => p.status == "show")
      .sort((a, b) => a.title.he.localeCompare(b.title.he, 'he'));
    productsWithOffers = productsWithOffers.filter(p => p.status == "show")
      .sort((a, b) => a.title.he.localeCompare(b.title.he, 'he'));

    // console.log(popularProducts.map(p => p.title.he.split('').reverse().join('')))

    res.send({
      products,
      popularProducts,
      relatedProducts,
      discountedProducts,
      productsWithOffers,
      // נשלח תמיד; בלי עימוד הערך הוא אורך התוצאה בפועל, כדי שהצרכן לא יצטרך
      // לדעת באיזה מצב הוא נמצא.
      totalProducts: isPaginated ? totalProducts : products.length,
      page: isPaginated ? page : 1,
      limit: isPaginated ? limit : products.length,
    });
  } catch (err) {
    console.log('getShowingStoreProducts error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const deleteManyProducts = async (req, res) => {
  try {
    const cname = req.cname;
    // console.log("deleteMany", cname, req.body.ids);

    await Product.deleteMany({ _id: req.body.ids });

    res.send({
      message: `Products Delete Successfully!`,
    });
  } catch (err) {
    console.log('deleteManyProducts error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

module.exports = {
  addProduct,
  importProducts,
  checkImportProducts,
  getAllProducts,
  getProductsLite,
  getProductByBarcode,
  getShowingProducts,
  getCartProducts,
  getFacebookFeedCSV,
  findProductByTranscript,
  getProductById,
  getProductDetails,
  getProductBySlug,
  updateProduct,
  updateProductPrice,
  updateManyProducts,
  updateStatus,
  deleteProduct,
  deleteManyProducts,
  getShowingStoreProducts,
};

// controller/groupPriceListController.js
//
// מחירונים קבוצתיים: מחירון אחד מאקסל, עם שם, שמשויכים אליו כמה לקוחות.
// הכלל שלפיו הוא גובר על המחירון הפרטי יושב ב-utils/customerPriceList.js —
// כאן רק הניהול: יצירה, עדכון, שיוך לקוחות ומחיקה.
//
// קובץ המחירון הוא אותו קובץ כמו במחירון פרטי (מק"ט, שם המוצר, מחיר), ולכן
// הסינון והבדיקה מול הקטלוג משותפים עם customerPriceListController. גם כאן
// העלאת קובץ היא **דריסה מלאה** של שורות המחירון.

const mongoose = require("mongoose");
const GroupPriceList = require("../models/GroupPriceList");
const Customer = require("../models/Customer");
const { normalizeSku } = require("../utils/customerPriceList");
const {
  MAX_ROWS,
  MAX_NAME_LENGTH,
  MAX_SAMPLES,
  DEFAULT_VIEW_LIMIT,
  MAX_VIEW_LIMIT,
  toText,
  normalizeName,
  collectValidRows,
  analyzeImportRows,
  fetchCatalogBySku,
  fetchExistingSkus,
  lookupCatalog,
  existsInCatalog,
} = require("./customerPriceListController");

const MAX_GROUP_NAME_LENGTH = 80;

// תקרה למספר הלקוחות בבקשה. מספר הלקוחות כולו הוא מאות, כך שהתקרה רחוקה מכל
// קבוצה אמיתית — היא קיימת כדי שגוף בקשה מנופח לא יתורגם לשאילתת $in ענקית
const MAX_GROUP_CUSTOMERS = 5000;

const isId = (value) =>
  typeof value === "string" && mongoose.Types.ObjectId.isValid(value);

const readRows = (req) => (Array.isArray(req.body?.rows) ? req.body.rows : []);

/**
 * מזהי הלקוחות שנשלחו, אחרי סינון: רק מזהים תקינים של לקוחות שקיימים.
 * מזהה של לקוח שנמחק בינתיים נזרק בשקט — הוא לא סיבה להכשיל את השמירה.
 */
const resolveCustomerIds = async (raw) => {
  const ids = [...new Set((Array.isArray(raw) ? raw : []).filter(isId))];
  if (ids.length === 0) return [];
  const found = await Customer.find({ _id: { $in: ids } }).select("_id").lean();
  return found.map((customer) => customer._id);
};

/**
 * הוצאת הלקוחות מכל קבוצה אחרת — לקוח שייך לקבוצה אחת לכל היותר.
 * @returns {Promise<number>} כמה קבוצות אחרות השתנו
 */
const detachFromOtherGroups = async (customerIds, keepGroupId) => {
  if (customerIds.length === 0) return 0;
  const filter = { customers: { $in: customerIds } };
  if (keepGroupId) filter._id = { $ne: keepGroupId };
  const result = await GroupPriceList.updateMany(filter, {
    $pull: { customers: { $in: customerIds } },
  });
  return result.modifiedCount || 0;
};

const duplicateNameMessage = (name) =>
  `כבר קיים מחירון קבוצתי בשם "${name}". יש לבחור שם אחר.`;

const summarize = (group) => ({
  _id: String(group._id),
  name: group.name,
  itemsCount: group.itemsCount || 0,
  customers: (group.customers || []).map(String),
  customersCount: (group.customers || []).length,
  fileName: group.fileName || "",
  importedBy: group.importedBy || "",
  importedAt: group.importedAt || null,
  updatedAt: group.updatedAt || null,
});

/* ------------------------------------------------------------------ *
 * כל המחירונים הקבוצתיים — מטא-נתונים ומזהי הלקוחות, בלי שורות המחירון.
 * משמש גם את רשימת הלקוחות (לאיזו קבוצה כל לקוח שייך) וגם את כרטיס הלקוח.
 * ------------------------------------------------------------------ */
const getGroupPriceLists = async (req, res) => {
  try {
    const groups = await GroupPriceList.find({}).sort({ name: 1 }).lean();
    res.send(groups.map(summarize));
  } catch (err) {
    console.log("getGroupPriceLists error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/* ------------------------------------------------------------------ *
 * מחירון קבוצתי אחד: השורות (מועשרות בנתוני הקטלוג) והלקוחות המשויכים.
 * תומך ב-search וב-limit כמו תצוגת המחירון הפרטי.
 * ------------------------------------------------------------------ */
const getGroupPriceList = async (req, res) => {
  try {
    if (!isId(req.params.id)) {
      return res.status(404).send({ message: "המחירון הקבוצתי לא נמצא" });
    }
    const group = await GroupPriceList.findById(req.params.id).select("+items").lean();
    if (!group) return res.status(404).send({ message: "המחירון הקבוצתי לא נמצא" });

    const search = normalizeName(req.query?.search);
    const limit = Math.min(
      Math.max(Number(req.query?.limit) || DEFAULT_VIEW_LIMIT, 1),
      MAX_VIEW_LIMIT
    );

    const items = group.items || [];
    const filtered = search
      ? items.filter(
          (item) =>
            normalizeSku(item.sku).toLowerCase().includes(search) ||
            normalizeName(item.name).includes(search)
        )
      : items;
    const page = filtered.slice(0, limit);

    const [existingSkus, catalogBySku] = await Promise.all([
      fetchExistingSkus(items.map((item) => normalizeSku(item.sku)).filter(Boolean)),
      fetchCatalogBySku(page.map((item) => normalizeSku(item.sku)).filter(Boolean)),
    ]);

    res.send({
      ...summarize(group),
      matchedInCatalog: items.filter((item) =>
        existsInCatalog(existingSkus, normalizeSku(item.sku))
      ).length,
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
        };
      }),
    });
  } catch (err) {
    console.log("getGroupPriceList error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/* ------------------------------------------------------------------ *
 * בדיקה מקדימה של קובץ מול הקטלוג — לפני יצירה או החלפת מחירון.
 * ------------------------------------------------------------------ */
const checkImportGroupPriceList = async (req, res) => {
  try {
    const rows = readRows(req);
    if (rows.length > MAX_ROWS) {
      return res
        .status(400)
        .send({ message: `ניתן לבדוק עד ${MAX_ROWS} שורות בבקשה אחת` });
    }
    res.send(await analyzeImportRows(rows));
  } catch (err) {
    console.log("checkImportGroupPriceList error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/**
 * שורות המחירון מתוך גוף הבקשה, מוכנות לשמירה.
 * @returns {{error?: object, set?: object, report?: object}}
 */
const buildItemsUpdate = async (req) => {
  const rows = readRows(req);
  if (rows.length > MAX_ROWS) {
    return { error: { message: `ניתן לייבא עד ${MAX_ROWS} שורות בבקשה אחת` } };
  }

  const { items, invalid, duplicates } = collectValidRows(rows);
  if (items.length === 0) {
    return {
      error: {
        message: "לא נמצאה אף שורה תקינה בקובץ",
        invalid: invalid.length,
        invalidSamples: invalid.slice(0, MAX_SAMPLES),
      },
    };
  }

  // מק"ט שאינו בקטלוג נשמר בכל זאת — אותו שיקול כמו במחירון הפרטי: הוא יתפוס
  // ברגע שהמוצר ייווצר
  const existingSkus = await fetchExistingSkus(items.map((item) => item.sku));
  const unknownSkus = items
    .filter((item) => !existsInCatalog(existingSkus, item.sku))
    .map((item) => item.sku);

  return {
    set: {
      items: items.map(({ sku, price, name }) => ({ sku, price, name })),
      itemsCount: items.length,
      fileName: toText(req.body?.fileName).slice(0, MAX_NAME_LENGTH),
      importedBy: req.user?.email || "",
      importedAt: new Date(),
    },
    report: {
      received: rows.length,
      imported: items.length,
      skipped: invalid.length,
      duplicates,
      matchedInCatalog: items.length - unknownSkus.length,
      notInCatalog: unknownSkus.length,
      notInCatalogSamples: unknownSkus.slice(0, MAX_SAMPLES),
    },
  };
};

/* ------------------------------------------------------------------ *
 * יצירת מחירון קבוצתי: {name, rows, fileName, customers}
 * ------------------------------------------------------------------ */
const createGroupPriceList = async (req, res) => {
  try {
    const name = toText(req.body?.name).slice(0, MAX_GROUP_NAME_LENGTH);
    if (!name) return res.status(400).send({ message: "יש לתת שם למחירון הקבוצתי" });

    if (readRows(req).length === 0) {
      return res.status(400).send({ message: "לא נשלחו שורות מחירון" });
    }
    if ((req.body?.customers || []).length > MAX_GROUP_CUSTOMERS) {
      return res.status(400).send({ message: "יותר מדי לקוחות בבקשה אחת" });
    }

    if (await GroupPriceList.exists({ name })) {
      return res.status(400).send({ message: duplicateNameMessage(name) });
    }

    const built = await buildItemsUpdate(req);
    if (built.error) return res.status(400).send(built.error);

    const customers = await resolveCustomerIds(req.body?.customers);

    let group;
    try {
      group = await GroupPriceList.create({ name, customers, ...built.set });
    } catch (err) {
      // שני אדמינים שיצרו את אותו שם באותו רגע
      if (err.code === 11000) {
        return res.status(400).send({ message: duplicateNameMessage(name) });
      }
      throw err;
    }

    // רק אחרי שהקבוצה נוצרה: הוצאה מוקדמת הייתה משאירה את הלקוחות בלי אף
    // קבוצה אם היצירה נכשלה
    const movedFromGroups = await detachFromOtherGroups(customers, group._id);

    res.send({
      message: `המחירון הקבוצתי "${name}" נשמר: ${built.report.imported} שורות, ${customers.length} לקוחות`,
      group: summarize(group.toObject()),
      movedFromGroups,
      ...built.report,
    });
  } catch (err) {
    console.log("createGroupPriceList error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/* ------------------------------------------------------------------ *
 * עדכון מחירון קבוצתי: {name?, customers?, rows?, fileName?}
 *
 * כל שדה שלא נשלח נשאר כמו שהוא — אפשר לשנות רק את רשימת הלקוחות בלי לגעת
 * במחירים, או להעלות קובץ חדש בלי לגעת בלקוחות. `customers` שנשלח הוא הרשימה
 * המלאה, לא תוספת.
 * ------------------------------------------------------------------ */
const updateGroupPriceList = async (req, res) => {
  try {
    if (!isId(req.params.id)) {
      return res.status(404).send({ message: "המחירון הקבוצתי לא נמצא" });
    }
    const existing = await GroupPriceList.findById(req.params.id).select("_id name").lean();
    if (!existing) return res.status(404).send({ message: "המחירון הקבוצתי לא נמצא" });

    const set = {};
    let report = null;

    if (req.body?.name !== undefined) {
      const name = toText(req.body.name).slice(0, MAX_GROUP_NAME_LENGTH);
      if (!name) return res.status(400).send({ message: "יש לתת שם למחירון הקבוצתי" });
      if (await GroupPriceList.exists({ name, _id: { $ne: existing._id } })) {
        return res.status(400).send({ message: duplicateNameMessage(name) });
      }
      set.name = name;
    }

    if (readRows(req).length > 0) {
      const built = await buildItemsUpdate(req);
      if (built.error) return res.status(400).send(built.error);
      Object.assign(set, built.set);
      report = built.report;
    }

    let customers = null;
    if (req.body?.customers !== undefined) {
      if (!Array.isArray(req.body.customers)) {
        return res.status(400).send({ message: "רשימת הלקוחות אינה תקינה" });
      }
      if (req.body.customers.length > MAX_GROUP_CUSTOMERS) {
        return res.status(400).send({ message: "יותר מדי לקוחות בבקשה אחת" });
      }
      customers = await resolveCustomerIds(req.body.customers);
      set.customers = customers;
    }

    if (Object.keys(set).length === 0) {
      return res.status(400).send({ message: "לא נשלח שום שינוי" });
    }

    let group;
    try {
      group = await GroupPriceList.findByIdAndUpdate(
        existing._id,
        { $set: set },
        { new: true }
      ).lean();
    } catch (err) {
      if (err.code === 11000) {
        return res.status(400).send({ message: duplicateNameMessage(set.name) });
      }
      throw err;
    }
    if (!group) return res.status(404).send({ message: "המחירון הקבוצתי לא נמצא" });

    const movedFromGroups = customers
      ? await detachFromOtherGroups(customers, group._id)
      : 0;

    res.send({
      message: `המחירון הקבוצתי "${group.name}" עודכן`,
      group: summarize(group),
      movedFromGroups,
      ...(report || {}),
    });
  } catch (err) {
    console.log("updateGroupPriceList error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/* ------------------------------------------------------------------ *
 * מחיקת מחירון קבוצתי — הלקוחות חוזרים למחירון הפרטי שלהם ולקטלוג.
 * ------------------------------------------------------------------ */
const deleteGroupPriceList = async (req, res) => {
  try {
    if (!isId(req.params.id)) {
      return res.status(404).send({ message: "המחירון הקבוצתי לא נמצא" });
    }
    const result = await GroupPriceList.deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) {
      return res.status(404).send({ message: "המחירון הקבוצתי לא נמצא" });
    }
    res.send({
      message: "המחירון הקבוצתי נמחק — הלקוחות חוזרים למחירון הפרטי ולמחירי הקטלוג",
    });
  } catch (err) {
    console.log("deleteGroupPriceList error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/* ------------------------------------------------------------------ *
 * שיוך לקוח אחד — מכרטיס הלקוח: {groupId} (ריק/null = בלי מחירון קבוצתי).
 * ------------------------------------------------------------------ */
const setCustomerGroup = async (req, res) => {
  try {
    const { customerId } = req.params;
    if (!isId(customerId) || !(await Customer.exists({ _id: customerId }))) {
      return res.status(404).send({ message: "לקוח לא נמצא" });
    }

    const groupId = req.body?.groupId;
    if (!groupId) {
      await detachFromOtherGroups([new mongoose.Types.ObjectId(customerId)], null);
      return res.send({
        message: "הלקוח הוסר מהמחירון הקבוצתי",
        customer: customerId,
        group: null,
      });
    }

    if (!isId(groupId)) {
      return res.status(404).send({ message: "המחירון הקבוצתי לא נמצא" });
    }

    // קודם ההוספה ורק אז ההוצאה מהקבוצה הקודמת: אם הקבוצה החדשה נמחקה
    // בינתיים, הלקוח נשאר בקבוצה שהיה בה ולא נופל בין הכיסאות
    const group = await GroupPriceList.findByIdAndUpdate(
      groupId,
      { $addToSet: { customers: customerId } },
      { new: true }
    ).lean();
    if (!group) return res.status(404).send({ message: "המחירון הקבוצתי לא נמצא" });

    await detachFromOtherGroups([new mongoose.Types.ObjectId(customerId)], group._id);

    res.send({
      message: `הלקוח שויך למחירון הקבוצתי "${group.name}"`,
      customer: customerId,
      group: { _id: String(group._id), name: group.name, itemsCount: group.itemsCount || 0 },
    });
  } catch (err) {
    console.log("setCustomerGroup error: ", err);
    res.status(500).send({ message: err.message });
  }
};

module.exports = {
  getGroupPriceLists,
  getGroupPriceList,
  checkImportGroupPriceList,
  createGroupPriceList,
  updateGroupPriceList,
  deleteGroupPriceList,
  setCustomerGroup,
};

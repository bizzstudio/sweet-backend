// controller/productAliasController.js
//
// "איך הלקוח הזה קורא למוצרים" — צפייה ועריכה של ההכרעות שנשמרו (ProductAlias)
// מתוך כרטיס הלקוח.
//
// ── למה צריך מסך כזה ──
//
// עד כאן הכרעה נוצרה רק מתוך הזמנה שנעצרה, ולא הייתה דרך לחזור אליה. מנהלת
// המשרד פרשה "חד פעמי סכו"ם וצלחות" למזלגות, סכינים וכפות, ואחר כך רצתה
// להוסיף סוג סכו"ם — ולא היה איפה. האפשרות היחידה הייתה לחכות שהלקוח יכתוב
// את השורה שוב, ושהיא תיעצר שוב, כדי להכריע מחדש. אליאס שנשמר בטעות (מוצר
// שגוי שנכנס מאז בביטחון מלא לכל הזמנה) לא היה ניתן לתיקון כלל.
//
// ── מה אפשר כאן, ומה לא ──
//
// אפשר לשנות את רשימת המוצרים (להוסיף, להסיר, לקבוע כמות) ולמחוק אליאס.
// אי אפשר לשנות את הטקסט או את ההיקף: הם מה שהאליאס *הוא* — השם שהלקוח כותב
// ואצל מי. ההכרעות הכלל-מערכתיות אינן מוצגות כאן, כי עריכה שלהן מכרטיס של
// לקוח אחד הייתה משנה בשקט מה נשלח לכל השאר.

const mongoose = require("mongoose");

const ProductAlias = require("../models/ProductAlias");
const Product = require("../models/Product");
const {
  aliasEntries,
  updateAliasProducts,
  resolveProductList,
} = require("../utils/productAliases");

// אליאס במסד → מה שהמסך צריך. ‏byId — כל המוצרים של כל האליאסים, שנשלפו יחד.
const toView = (alias, byId) => ({
  _id: alias._id,
  sourceName: alias.sourceName || alias.key,
  ignore: Boolean(alias.ignore),
  hits: alias.hits || 0,
  lastUsedAt: alias.lastUsedAt || null,
  createdBy: alias.createdBy || null,
  updatedAt: alias.updatedAt || null,
  products: aliasEntries(alias).map(({ product, quantity }) => {
    const full = byId.get(String(product));
    return {
      productId: product,
      sku: full?.sku || null,
      title: full?.title?.he || full?.title?.en || "",
      quantity,
      // ‏missing: מוצר שנמחק מהקטלוג. הקליטה מתעלמת אז מהאליאס כולו (ראה
      // findAliasMatch), ומי שמסתכל כאן צריך לדעת שזו הסיבה שהשורה נעצרת
      missing: !full,
      hidden: Boolean(full && full.status !== "show"),
      stock: full?.stock ?? null,
    };
  }),
});

const asId = (value, res, message) => {
  if (mongoose.Types.ObjectId.isValid(String(value || ""))) return true;
  res.status(400).send({ message });
  return false;
};

/**
 * GET /api/product-aliases/customer/:customerId
 *
 * ההכרעות שנשמרו ללקוח הזה, האחרונות שנגעו בהן ראשונות.
 */
const getCustomerAliases = async (req, res) => {
  try {
    if (!asId(req.params.customerId, res, "מזהה לקוח לא תקין")) return;

    const aliases = await ProductAlias.find({ customer: req.params.customerId })
      .sort({ updatedAt: -1 })
      .lean();

    // שליפה אחת לכל המוצרים של כל האליאסים, לא אחת לכל אליאס
    const ids = [...new Set(aliases.flatMap((a) => aliasEntries(a).map((e) => String(e.product))))];
    const products = ids.length
      ? await Product.find({ _id: { $in: ids } }).select("title sku stock status").lean()
      : [];
    const byId = new Map(products.map((p) => [String(p._id), p]));

    res.send({ aliases: aliases.map((alias) => toView(alias, byId)) });
  } catch (err) {
    console.log("getCustomerAliases error: ", err);
    res.status(400).send({ message: err.message });
  }
};

/**
 * PUT /api/product-aliases/:id
 * body: { products: [{ productId | sku, quantity }] }
 *
 * מחליף את רשימת המוצרים של האליאס. ‏quantity ריק = כמו בשורה.
 */
const updateAlias = async (req, res) => {
  try {
    if (!asId(req.params.id, res, "מזהה לא תקין")) return;

    const existing = await ProductAlias.findById(req.params.id).select("customer").lean();
    if (!existing) return res.status(404).send({ message: "ההכרעה לא נמצאה — אולי נמחקה" });

    // ראה "מה אפשר כאן" למעלה: הכרעה כלל-מערכתית אינה נערכת מכרטיס של לקוח
    if (!existing.customer) {
      return res.status(400).send({ message: "זו הכרעה לכל הלקוחות — אי אפשר לערוך אותה מכאן" });
    }

    const products = await resolveProductList(req.body?.products);
    // רשימה ריקה אינה "אין מוצרים" אלא מחיקה — ולמחיקה יש כפתור משלה, עם אישור
    if (!products.length) return res.status(400).send({ message: "לא נבחר מוצר" });

    const alias = await updateAliasProducts(req.params.id, products);
    if (!alias) return res.status(404).send({ message: "ההכרעה לא נמצאה — אולי נמחקה" });

    const loaded = await Product.find({ _id: { $in: aliasEntries(alias).map((e) => e.product) } })
      .select("title sku stock status")
      .lean();
    res.send({
      message: `נשמר: "${alias.sourceName || alias.key}" ייקרא כ-${
        products.length > 1 ? `${products.length} מוצרים` : "המוצר שנבחר"
      }`,
      alias: toView(alias, new Map(loaded.map((p) => [String(p._id), p]))),
    });
  } catch (err) {
    console.log("updateAlias error: ", err);
    res.status(400).send({ message: err.message });
  }
};

/**
 * DELETE /api/product-aliases/:id
 *
 * מחיקת הכרעה. מהפעם הבאה השורה עוברת שוב במנוע ההתאמה הרגיל, ואם הוא אינו
 * בטוח — נעצרת לאדם, שיכריע מחדש.
 */
const deleteAlias = async (req, res) => {
  try {
    if (!asId(req.params.id, res, "מזהה לא תקין")) return;

    const existing = await ProductAlias.findById(req.params.id).select("customer").lean();
    if (!existing) return res.status(404).send({ message: "ההכרעה לא נמצאה — אולי כבר נמחקה" });
    if (!existing.customer) {
      return res.status(400).send({ message: "זו הכרעה לכל הלקוחות — אי אפשר למחוק אותה מכאן" });
    }

    await ProductAlias.deleteOne({ _id: req.params.id });
    res.send({ message: "ההכרעה נמחקה" });
  } catch (err) {
    console.log("deleteAlias error: ", err);
    res.status(400).send({ message: err.message });
  }
};

module.exports = {
  getCustomerAliases,
  updateAlias,
  deleteAlias,
};

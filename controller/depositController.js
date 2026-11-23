// controller/depositController.js
//
// שיוך מוצרי משקה למוצר הפיקדון שלהם — מסך "פיקדונות" באדמין.
// החישוב עצמו בתעודה: lib/billing/deposits.js

const mongoose = require("mongoose");
const Product = require("../models/Product");
const { clearDepositCache } = require("../lib/billing/deposits");
const { titleOf, isDepositTitle, depositKind, suggestFor } = require("../lib/billing/depositSuggestions");

const MAX_ITEMS = 2000;

/**
 * GET /products/deposits
 * מוצרי הפיקדון, וכל שאר המוצרים עם השיוך הקיים וההצעה לשיוך.
 */
const getDepositSetup = async (req, res) => {
  try {
    const products = await Product.find({})
      .select("_id sku title status deposit prices.price isVatFree")
      .lean();

    const depositProducts = products
      .filter((p) => isDepositTitle(titleOf(p)))
      .map((p) => ({
        _id: p._id,
        sku: p.sku,
        title: titleOf(p),
        price: p.prices?.price ?? null,
        isVatFree: Boolean(p.isVatFree),
        status: p.status,
        kind: depositKind(titleOf(p)),
      }));

    // מוצר פיקדון אחד לכל סוג. כשיש שניים מאותו סוג — ההצעה לא בוחרת
    // ביניהם, ומי שמאשר בוחר ביד.
    const byKind = {};
    for (const d of depositProducts) {
      if (!d.kind) continue;
      byKind[d.kind] = byKind[d.kind] === undefined ? d._id : null;
    }

    const depositIds = new Set(depositProducts.map((d) => String(d._id)));
    const rows = [];
    for (const p of products) {
      if (depositIds.has(String(p._id))) continue;
      const s = suggestFor(titleOf(p));
      const current = p.deposit?.product
        ? { product: p.deposit.product, perUnit: p.deposit.perUnit || 1 }
        : null;
      // שאר הקטלוג נשלח גם הוא, כדי שאפשר יהיה לשייך משקה שהזיהוי לפי שם
      // פספס (המסך מציג אותו רק בחיפוש)
      rows.push({
        _id: p._id,
        sku: p.sku,
        title: titleOf(p),
        status: p.status,
        current,
        suggestion: s
          ? { kind: s.kind, depositProductId: byKind[s.kind] || null, perUnit: s.perUnit, reason: s.reason }
          : null,
      });
    }
    rows.sort((a, b) => a.title.localeCompare(b.title, "he"));

    res.send({ depositProducts, rows });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

/**
 * PUT /products/deposits
 * body.items: [{ productId, depositProductId (null = הסרה), perUnit }]
 */
const saveDeposits = async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).send({ message: "לא נשלחו שורות" });
    if (items.length > MAX_ITEMS) {
      return res.status(400).send({ message: `עד ${MAX_ITEMS} שורות בשמירה אחת` });
    }

    const isId = (v) => v && mongoose.Types.ObjectId.isValid(String(v));
    const bad = items.filter(
      (i) => !isId(i.productId) || (i.depositProductId && !isId(i.depositProductId))
    );
    if (bad.length) return res.status(400).send({ message: "מזהה מוצר לא תקין" });

    const targetIds = [...new Set(items.filter((i) => i.depositProductId).map((i) => String(i.depositProductId)))];
    const targets = await Product.find({ _id: { $in: targetIds } }).select("_id title").lean();
    if (targets.length !== targetIds.length) {
      return res.status(400).send({ message: "מוצר פיקדון לא נמצא" });
    }
    const notDeposit = targets.filter((t) => !isDepositTitle(titleOf(t)));
    if (notDeposit.length) {
      return res.status(400).send({
        message: `"${titleOf(notDeposit[0])}" אינו מוצר פיקדון (אין "פיקדון" בשם)`,
      });
    }

    const ops = [];
    for (const i of items) {
      if (i.depositProductId && String(i.depositProductId) === String(i.productId)) {
        return res.status(400).send({ message: "מוצר לא יכול להיות הפיקדון של עצמו" });
      }
      if (!i.depositProductId) {
        ops.push({ updateOne: { filter: { _id: i.productId }, update: { $unset: { deposit: "" } } } });
        continue;
      }
      const perUnit = Number(i.perUnit) || 1;
      if (!Number.isInteger(perUnit) || perUnit < 1 || perUnit > 100) {
        return res.status(400).send({ message: "כמות פיקדונות ביחידה חייבת להיות מספר שלם בין 1 ל-100" });
      }
      ops.push({
        updateOne: {
          filter: { _id: i.productId },
          update: { $set: { deposit: { product: i.depositProductId, perUnit } } },
        },
      });
    }

    const result = await Product.bulkWrite(ops, { ordered: false });
    clearDepositCache();
    res.send({
      message: `נשמרו ${result.modifiedCount} מוצרים`,
      modified: result.modifiedCount,
    });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

/**
 * POST /products/deposits/open-notes   body: { apply: boolean }
 * בלי apply — תצוגה מקדימה בלבד.
 */
const applyToOpenNotes = async (req, res) => {
  try {
    const { addDepositsToOpenNotes } = require("../lib/billing/deliveryNotes");
    const apply = req.body?.apply === true;
    const result = await addDepositsToOpenNotes({ dryRun: !apply });
    res.send({ ...result, applied: apply });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

module.exports = { getDepositSetup, saveDeposits, applyToOpenNotes };

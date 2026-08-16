// lib/billing/quotes.js
//
// הפקת הצעות מחיר. המסמך נבנה ומודפס אצלנו ואינו נשלח ל-iCount, כמו
// תעודת משלוח — הצעת מחיר אינה מסמך מס ולכן אין סיבה שתיכנס לספרים.
//
// המחירים נקבעים דרך lib/billing/pricing (מחירון הלקוח → מחיר קטלוג),
// אלא אם נשלח מחיר מפורש לשורה.

const Counter = require("../../models/Counter");
const Quote = require("../../models/Quote");
const Customer = require("../../models/Customer");
const { priceItemsForCustomer, priceQuality } = require("./pricing");

const COUNTER_ID = "quote";
const FIRST_NUMBER = 5000;

/** מספר רץ להצעות. אותו מנגנון אטומי כמו בהזמנות ובתעודות. */
const nextNumber = async () => {
  const existing = await Counter.findById(COUNTER_ID).select("_id").lean();
  if (!existing) {
    const highest = await Quote.findOne().sort({ number: -1 }).select("number").lean();
    await Counter.updateOne(
      { _id: COUNTER_ID },
      { $setOnInsert: { seq: Math.max(highest?.number || 0, FIRST_NUMBER - 1) } },
      { upsert: true }
    ).catch((err) => {
      if (err.code !== 11000) throw err;
    });
  }

  const counter = await Counter.findByIdAndUpdate(
    COUNTER_ID,
    { $inc: { seq: 1 } },
    { new: true }
  );
  if (!counter) throw new Error("הקצאת מספר הצעת מחיר נכשלה");
  return counter.seq;
};

/**
 * יצירת הצעת מחיר.
 *
 * @param {object} p
 * @param {string} p.customerId
 * @param {Array<{sku, quantity, unitPrice?}>} p.items - unitPrice אופציונלי;
 *        בלעדיו המחיר נקבע לפי מחירון הלקוח או הקטלוג
 * @param {number} [p.validDays]
 * @param {number} [p.discount]
 * @param {string} [p.notes]
 * @param {string} [p.createdBy]
 */
const create = async ({
  customerId,
  items,
  validDays = 30,
  discount = 0,
  notes,
  createdBy,
}) => {
  if (!items?.length) throw new Error("הצעת מחיר חייבת לכלול לפחות שורה אחת");

  const customer = await Customer.findById(customerId).select("+erp").lean();
  if (!customer) throw new Error("הלקוח לא נמצא");

  // תמחור אוטומטי לשורות שלא הגיע להן מחיר מפורש
  const priced = await priceItemsForCustomer(customerId, items);
  const finalItems = priced.map((row, i) => {
    const override = items[i]?.unitPrice;
    // 0 מפורש הוא החלטה לגיטימית (מוצר מתנה), ולכן הבדיקה היא על undefined
    // ולא על falsy
    if (override === undefined || override === null || override === "") return row;

    const unitPrice = Number(override);
    return {
      ...row,
      unitPrice,
      lineTotal: Number((unitPrice * row.quantity).toFixed(2)),
      priceSource: "manual",
    };
  });

  const unknown = finalItems.filter((i) => i.unknownProduct);
  if (unknown.length) {
    throw new Error(
      `מק"טים שאינם קיימים בקטלוג: ${unknown.map((i) => i.sku).join(", ")}`
    );
  }

  const subTotal = Number(finalItems.reduce((s, i) => s + i.lineTotal, 0).toFixed(2));
  const total = Number((subTotal - discount).toFixed(2));

  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + validDays);

  const erp = customer.erp || {};
  const quote = await Quote.create({
    number: await nextNumber(),
    customer: customer._id,
    customerSnapshot: {
      name: [customer.name, customer.lastName].filter(Boolean).join(" ").trim(),
      customerNumber: erp.customerNumber,
      contactPerson: erp.contactPerson,
    },
    items: finalItems.map((i) => ({
      productId: i.productId,
      sku: i.sku,
      name: i.name,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      lineTotal: i.lineTotal,
      isVatFree: i.isVatFree,
      category: i.category,
      priceSource: i.priceSource || i.source,
    })),
    subTotal,
    discount,
    total,
    validUntil,
    notes,
    createdBy,
  });

  return { quote, quality: priceQuality(finalItems) };
};

/**
 * סימון הצעה כמאושרת.
 *
 * לא יוצר הזמנה אוטומטית: ההזמנה נבנית במסך ההזמנות עם כתובת, מועד אספקה
 * ובדיקת מלאי, ואף אחד מהם אינו חלק מההצעה. השדה convertedOrder נועד
 * לקישור ידני אחרי שההזמנה נוצרה.
 */
const accept = async (quoteId, { orderId } = {}) => {
  const quote = await Quote.findById(quoteId);
  if (!quote) throw new Error("הצעת המחיר לא נמצאה");
  if (quote.status === "accepted") return quote;

  quote.status = "accepted";
  if (orderId) quote.convertedOrder = orderId;
  await quote.save();
  return quote;
};

const reject = async (quoteId, reason) => {
  const quote = await Quote.findById(quoteId);
  if (!quote) throw new Error("הצעת המחיר לא נמצאה");

  quote.status = "rejected";
  if (reason) quote.notes = [quote.notes, `סיבת דחייה: ${reason}`].filter(Boolean).join("\n");
  await quote.save();
  return quote;
};

module.exports = { create, accept, reject };

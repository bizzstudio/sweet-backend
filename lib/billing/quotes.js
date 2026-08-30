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
const {
  priceItemsForCustomer,
  priceQuality,
  discountPercentFor,
  discountAmount,
} = require("./pricing");
const deliveryNotes = require("./deliveryNotes");
const monthlyBilling = require("./monthlyBilling");

const COUNTER_ID = "quote";
const FIRST_NUMBER = 5000;

// תוקף ההצעה, בימים. הגבול העליון אינו כלל עסקי אלא הגנה: validDays ענק
// מייצר Date לא תקין, ו-mongoose נופל עליו בשמירה עם שגיאת cast סתומה
// במקום הודעה שאפשר להבין.
const MAX_VALID_DAYS = 3650;

const clampValidDays = (days) => {
  const value = Number(days);
  if (!Number.isFinite(value) || value <= 0) return 30;
  return Math.min(Math.floor(value), MAX_VALID_DAYS);
};

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

  // אותה בנייה כמו בתעודת משלוח — כולל הברקוד ושם הקטגוריה — כדי שהמרה
  // של ההצעה לתעודה לא תצטרך לתמחר מחדש ולא תאבד שדות.
  // requirePrice: false — הצעה עם שורה בלי מחיר עדיין ניתנת לשמירה; המסך
  // חוסם אותה, וההפקה לתעודה תדרוש מחיר.
  const { items: finalItems, priced } = await deliveryNotes.buildPricedItems(
    customerId,
    items,
    { requirePrice: false }
  );

  // מקור המחיר לכל שורה. שורה שהוזן לה מחיר מפורש מסומנת "manual" ולא
  // לפי מה שהתמחור מצא — אחרת אי אפשר לדעת בדיעבד אם המחיר בהצעה נקבע
  // ביד או נלקח מהמחירון, וזו בדיוק השאלה שנשאלת כשלקוח חולק על מחיר.
  const overriddenSkus = new Set(
    items
      .filter((i) => i?.unitPrice !== undefined && i?.unitPrice !== null && i?.unitPrice !== "")
      .map((i) => String(i.sku || "").trim())
      .filter(Boolean)
  );
  const sourceBySku = new Map(priced.map((p) => [String(p.sku), p.source]));
  const sourceFor = (sku) =>
    overriddenSkus.has(String(sku)) ? "manual" : sourceBySku.get(String(sku)) || "catalog";

  const subTotal = Number(finalItems.reduce((s, i) => s + i.lineTotal, 0).toFixed(2));

  // ההנחה הקבועה של הלקוח, על מה שנשאר אחרי ההנחה שהוקלדה בטופס
  const manualDiscount = Number(discount) || 0;
  if (manualDiscount < 0) throw new Error("הנחה לא יכולה להיות שלילית");

  const discountPercent = await discountPercentFor(customer);
  const customerDiscount = discountAmount(
    Math.max(0, subTotal - manualDiscount),
    discountPercent
  );
  const totalDiscount = Number((manualDiscount + customerDiscount).toFixed(2));

  if (totalDiscount > subTotal) {
    throw new Error(
      `ההנחה (${totalDiscount}) גדולה מסכום ההצעה (${subTotal.toFixed(2)})`
    );
  }

  const total = Number((subTotal - totalDiscount).toFixed(2));

  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + clampValidDays(validDays));

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
      barcode: i.barcode,
      name: i.name,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      lineTotal: i.lineTotal,
      isVatFree: i.isVatFree,
      category: i.category,
      categoryName: i.categoryName,
      priceSource: sourceFor(i.sku),
    })),
    subTotal,
    discount: totalDiscount,
    discountPercent: customerDiscount > 0 ? discountPercent : 0,
    customerDiscount,
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

/**
 * שכפול הצעת מחיר — "עוד אחת בדיוק כמו זו".
 *
 * כמו בתעודת משלוח: השורות מועתקות עם המחירים שבהן ולא מתומחרות מחדש.
 * מה שכן מתחדש הוא התוקף — הצעה שהועתקה היום תקפה מהיום.
 */
const duplicate = async (quoteId, { validDays = 30, createdBy } = {}) => {
  const source = await Quote.findById(quoteId).lean();
  if (!source) throw new Error("הצעת המחיר לא נמצאה");
  if (!source.items?.length) throw new Error("אי אפשר להעתיק הצעה בלי שורות");

  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + clampValidDays(validDays));

  const quote = await Quote.create({
    number: await nextNumber(),
    customer: source.customer,
    customerSnapshot: source.customerSnapshot,
    items: source.items.map((i) => ({ ...i })),
    subTotal: source.subTotal,
    discount: source.discount,
    discountPercent: source.discountPercent || 0,
    customerDiscount: source.customerDiscount || 0,
    total: source.total,
    validUntil,
    notes: source.notes,
    createdBy,
  });

  return quote;
};

/**
 * המרת הצעת מחיר למסמך שמחייב — תעודת משלוח, או חשבונית מס.
 *
 * זה מה שקורה כשהלקוח אישר: הסחורה יוצאת, וההצעה הופכת למסמך. השורות
 * עוברות כמו שהן, כולל המחירים שסוכמו — הצעה שהתקבלה היא הסכם, ותמחור
 * מחדש לפי המחירון של היום היה משנה אותו בשקט.
 *
 * target:
 *   deliveryNote — תעודת משלוח ידנית, שתיסגר לחשבונית בסוף החודש (ברירת מחדל)
 *   invoice      — תעודה + חשבונית מס מיד. ללקוח שמקבל חשבונית לכל משלוח,
 *                  או כשההזמנה הזו נסגרת בפני עצמה
 *
 * ההצעה מסומנת "אושרה" בסיום. ההמרה חוסמת הצעה שכבר הומרה — הצעה אחת
 * שהפכה לשתי תעודות היא חיוב כפול על אותה סחורה.
 *
 * @returns {Promise<{quote, note, invoices: Array}>}
 */
const convert = async (quoteId, { target = "deliveryNote", issuedBy } = {}) => {
  if (!["deliveryNote", "invoice"].includes(target)) {
    throw new Error(`יעד המרה לא מוכר: "${target}"`);
  }

  const quote = await Quote.findById(quoteId);
  if (!quote) throw new Error("הצעת המחיר לא נמצאה");
  if (!quote.items?.length) throw new Error("אין בהצעה שורות להמרה");
  if (quote.status === "rejected") {
    throw new Error(`הצעה ${quote.number} סומנה כנדחתה — יש להחזיר אותה לפעילה לפני הפקה`);
  }
  if (quote.convertedNote) {
    throw new Error(
      `הצעה ${quote.number} כבר הומרה לתעודת משלוח ${quote.convertedNoteNumber}. ` +
        `להפקה נוספת יש להעתיק את ההצעה.`
    );
  }

  // ההנחה שכבר חושבה על ההצעה מועברת כהנחה ידנית לתעודה, בלי החלק
  // שההנחה הקבועה של הלקוח יצרה — createManual מוסיף אותו בעצמו, ובלי
  // ההפרדה הזו הוא היה יורד פעמיים.
  const manualDiscount = Math.max(
    0,
    Number((Number(quote.discount || 0) - Number(quote.customerDiscount || 0)).toFixed(2))
  );

  // מפתח הייחודיות נגזר מההצעה עצמה ואינו מגיע מהמסך.
  //
  // מפתח מהמסך מגן רק מפני לחיצה כפולה על אותו כפתור. הסכנה האמיתית היא
  // שתי לחיצות נפרדות (או שני מסכים פתוחים) שכל אחת נושאת מפתח משלה,
  // ואז נוצרות שתי תעודות על אותה סחורה. הבדיקה שלמעלה על convertedNote
  // סוגרת את רוב החלון אבל לא את כולו — בין createManual ל-save.
  //
  // מפתח קבוע להצעה הופך את זה לבלתי אפשרי ברמת המסד: האינדקס הייחודי
  // על idempotencyKey מחזיר את התעודה הקיימת במקום ליצור שנייה.
  const { note, created } = await deliveryNotes.createManual({
    customerId: String(quote.customer),
    items: quote.items.map((i) => ({
      sku: i.sku,
      quantity: i.quantity,
      // המחיר מההצעה גובר על המחירון: ההצעה היא מה שסוכם עם הלקוח
      unitPrice: i.unitPrice,
    })),
    discount: manualDiscount,
    notes: [quote.notes, `הופקה מהצעת מחיר ${quote.number}`].filter(Boolean).join("\n"),
    issuedBy,
    idempotencyKey: `quote:${quote._id}`,
  });

  // created=false = התעודה כבר נוצרה בניסיון קודם שנפל אחרי היצירה
  // ולפני השמירה. משלימים את הקישור במקום ליצור עוד אחת.
  if (!created) {
    console.warn(
      `[quotes] הצעה ${quote.number} כבר הפיקה את תעודה ${note.number} — משלים את הקישור`
    );
  }

  quote.status = "accepted";
  quote.convertedNote = note._id;
  quote.convertedNoteNumber = note.number;
  await quote.save();

  if (target !== "invoice") return { quote, note, invoices: [] };

  // חשבונית מיד. אם היא נכשלת התעודה כבר קיימת ונשארת פתוחה — היא תיאסף
  // בסגירת החודש, ולכן זו אינה שגיאה שמצדיקה למחוק את מה שכבר נוצר.
  try {
    const billed = await monthlyBilling.billNotesNow({
      customerId: String(quote.customer),
      noteIds: [String(note._id)],
    });
    return { quote, note, invoices: billed.invoices || [] };
  } catch (err) {
    const error = new Error(
      `תעודת משלוח ${note.number} נוצרה, אך הפקת החשבונית נכשלה: ${err.message}. ` +
        `התעודה נשארה פתוחה ותיאסף בסגירת החודש.`
    );
    error.note = note;
    throw error;
  }
};

module.exports = { create, accept, reject, duplicate, convert };

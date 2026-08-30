// models/Quote.js
//
// הצעת מחיר. נבנית ומופקת אצלנו בלבד ואינה נשלחת ל-iCount — בדיוק כמו
// תעודת משלוח (החלטת הלקוחה, 14/08/26).
//
// זה אפשרי כי הצעת מחיר אינה מסמך מס: היא לא נכנסת לספרים, לא מדווחת,
// וניתנת לעריכה ולמחיקה. מה שנשלח ללקוח הוא הדפסה/PDF מהמערכת.
//
// ל-iCount נכנסת רק החשבונית החודשית, ומולה הקבלה והזיכוי.

const mongoose = require("mongoose");

const QuoteItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: false },
    sku: { type: String, required: false },
    // הברקוד של מנוע. ראה DeliveryNote ו-utils/barcode.js
    barcode: { type: String, required: false },
    name: { type: String, required: true },
    quantity: { type: Number, required: true },
    // ללא מע"מ, כמו בכל המערכת
    unitPrice: { type: Number, required: true },
    lineTotal: { type: Number, required: true },
    isVatFree: { type: Boolean, default: false },
    category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: false },
    // נשמר כדי שהמרה לתעודת משלוח לא תאבד את הקטגוריה שהחשבונית מפוצלת לפיה
    categoryName: { type: String, required: false },
    // מאיפה הגיע המחיר — "customerPriceList" / "catalog" / "missing".
    // נשמר כדי שאפשר יהיה לדעת בדיעבד אם הצעה נשענה על מחיר מוסכם או על
    // מחיר קטלוג, בלי לנחש לפי התאריך.
    priceSource: { type: String, required: false },
  },
  { _id: false }
);

const quoteSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true, unique: true },

    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    customerSnapshot: {
      name: { type: String, required: false },
      customerNumber: { type: String, required: false },
      contactPerson: { type: String, required: false },
    },

    items: {
      type: [QuoteItemSchema],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "הצעת מחיר חייבת לכלול לפחות שורה אחת",
      },
    },

    subTotal: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    // כמו בתעודת משלוח: האחוז שהיה בתוקף בהפקה, והסכום שהוא ייצר
    discountPercent: { type: Number, default: 0 },
    customerDiscount: { type: Number, default: 0 },
    total: { type: Number, required: true },

    validUntil: { type: Date, required: false },
    notes: { type: String, required: false },

    // open = נשלחה וממתינה | accepted = הלקוח אישר | rejected = נדחתה |
    // expired = פג התוקף. expired נגזר מ-validUntil ולא נשמר אוטומטית —
    // רק סימון ידני, כדי שהצעה שהלקוח אישר באיחור לא תיחסם.
    status: {
      type: String,
      enum: ["open", "accepted", "rejected", "expired"],
      default: "open",
    },

    // ההזמנה שנוצרה מההצעה, אם התקבלה
    convertedOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: false,
    },

    // תעודת המשלוח שהופקה מההצעה בלחיצת כפתור.
    //
    // נשמר כדי לחסום הפקה שנייה מאותה הצעה: הצעה אחת שהפכה לשתי תעודות
    // היא חיוב כפול על אותה סחורה, וזו טעות שמתגלה רק בסוף החודש.
    convertedNote: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DeliveryNote",
      required: false,
    },
    convertedNoteNumber: { type: Number, required: false },

    createdBy: { type: String, required: false },
  },
  { timestamps: true }
);

// המסך מציג הצעות של לקוח לפי סטטוס, וממיין לפי מספר יורד
quoteSchema.index({ customer: 1, status: 1 });
quoteSchema.index({ number: -1 });

const Quote = mongoose.model("Quote", quoteSchema);

Quote.on("index", (err) => {
  if (!err) return;
  console.error(
    `[Quote] בניית אינדקס נכשלה: ${err.message}\n` +
      `        אם מדובר ב-number — יש כפילויות בנתונים.`
  );
});

module.exports = Quote;

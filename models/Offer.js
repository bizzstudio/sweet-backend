// models/Offer.js
const mongoose = require("mongoose");

const offerSchema = new mongoose.Schema(
  {
    name: { type: Object, required: true },
    description: { type: Object, required: false },
    image: { type: String, required: false },       // URL לתמונת מבצע

    // סוג המבצע
    type: {
      type: String,
      enum: [
        "BUNDLE_PRICE", // קנה X פריטים מקבוצה וקבל מחיר Y כולל (מה שיש לך היום)
        "THRESHOLD_GET_ITEM", // קנה מעל סכום X וקבל מוצר Y במחיר Z
        "BUY_X_GET_Y", // קנה כמות X של מוצר Y וקבל מוצר Z במחיר A
        "THRESHOLD_DISCOUNT", // קנה מעל סכום X וקבל הנחה באחוזים או סכום קבוע
        "WELCOME_GIFT", // מתנת ברוכים הבאים לנרשמים חדשים
      ],
      required: true,
      default: "BUNDLE_PRICE",
    },
    isActive: { type: Boolean, default: true },
    startsAt: { type: Date, required: false },
    endsAt: { type: Date, required: false },
    oncePerCustomer: { type: Boolean, default: false }, // "תקף פעם אחת ללקוח"
    forNewCustomersOnly: { type: Boolean, default: false }, // "מבצע ללקוחות חדשים בלבד"
    // false = מבצע בלעדי (ללא כפל עם מבצעים אחרים על אותם מוצרים); ברירת מחדל true
    allowStackingWithOtherOffers: { type: Boolean, default: true },

    // ===== מבצע קיים (Bundle) =====
    // קונה כמות X (quantity) מתוך רשימת מוצרים (products) במחיר כולל Y (price)
    quantity: {
      type: Number,
      required: function () { return this.type === "BUNDLE_PRICE"; },
    },
    price: {
      type: Number,
      required: function () { return this.type === "BUNDLE_PRICE"; },
    },
    products: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
      },
    ],

    // ===== קנה מעל סכום X, קבל מוצר Y במחיר Z / הנחה באחוזים או סכום קבוע =====
    thresholdAmount: {
      type: Number,
      required: function () { return this.type === "THRESHOLD_GET_ITEM" || this.type === "THRESHOLD_DISCOUNT"; },
    },
    rewardProduct: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: function () {
        const needsReward =
          this.type === "THRESHOLD_GET_ITEM" ||
          this.type === "BUY_X_GET_Y" ||
          this.type === "WELCOME_GIFT";
        if (!needsReward) return false;
        return !this.rewardProducts || this.rewardProducts.length === 0;
      },
    },
    // מוצרי מתנה לבחירה — אם יותר מאחד, הלקוח בוחר מתנה
    rewardProducts: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
      },
    ],
    rewardPrice: {
      type: Number,
      required: function () {
        return this.type === "THRESHOLD_GET_ITEM" || this.type === "BUY_X_GET_Y";
      },
      // לדוגמה: 0 = חינם, או 1 ש"ח, וכו'
    },
    rewardQuantity: {
      type: Number,
      default: 1,
    },

    // ===== קנה כמות X של מוצר Y, קבל מוצר Z במחיר A =====
    triggerProduct: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: function () { return this.type === "BUY_X_GET_Y"; },
    },
    triggerQuantity: {
      type: Number,
      required: function () { return this.type === "BUY_X_GET_Y"; },
    },

    // ===== קנה מעל סכום מסויים, קבל הנחה באחוזים או סכום קבוע =====
    // thresholdAmount כבר קיים למעלה (משותף עם THRESHOLD_GET_ITEM)
    discountType: {
      type: String,
      enum: ["percentage", "fixed"], // אחוזים או סכום קבוע
      required: function () { return this.type === "THRESHOLD_DISCOUNT"; },
    },
    discountValue: {
      type: Number,
      required: function () { return this.type === "THRESHOLD_DISCOUNT"; },
      // לדוגמה: 10% או 10 ש"ח (תלוי בסוג ההנחה)
    },
  }
);

const Offer = mongoose.model("Offer", offerSchema);
module.exports = Offer;
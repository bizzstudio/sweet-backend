// models/Product.js
const mongoose = require("mongoose");

// נתוני ההנהלת חשבונות מיבוא האקסל ("רשימת המוצרים - כל הספקים").
// מוחזק בנפרד כדי שהיבוא לא ידרוך על שדות החנות (למשל barcode שהוא מספר סידורי)
const ProductErpSchema = new mongoose.Schema(
  {
    barcode: { type: String, required: false },
    barcode2: { type: String, required: false },
    externalSku: { type: String, required: false },
    supplierSku: { type: String, required: false },
    unit: { type: String, required: false },
    supplierName: { type: String, required: false },
    supplierNumber: { type: Number, required: false },
    groupName: { type: String, required: false },
    groupCode: { type: Number, required: false },
    departmentCode: { type: Number, required: false },
    cost: { type: Number, required: false },
    currency: { type: String, required: false },
    notes: { type: String, required: false },
    syncedAt: { type: Date, required: false },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    productId: {
      type: String,
      required: false,
    },
    sku: {
      type: String,
      required: false,
      unique: true,
    },

    // משמש כאן לסדר הופעה בחנות
    barcode: {
      type: String,
      required: false,
    },

    title: {
      type: Object,
      required: true,
    },
    description: {
      type: Object,
      required: false,
    },
    slug: {
      type: String,
      required: true,
    },
    categories: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Category",
        required: true,
      },
    ],
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    image: {
      type: Array,
      required: false,
    },
    stock: {
      type: Number,
      required: false,
    },

    sales: {
      type: Number,
      required: false,
    },

    tag: [String],
    prices: {
      originalPrice: {
        type: Number,
        required: true,
      },
      price: {
        type: Number,
        required: true,
      },
      storePrice: {
        type: Number,
        required: false,
      },
      discount: {
        type: Number,
        required: false,
      },
      offers: [
        {
          name: {
            type: String,
            // required: true,
          },
          quantity: {
            type: Number,
            required: true,
          },
          price: {
            type: Number,
            required: true,
          },
        },
      ],
    },
    variants: [{}],
    isCombination: {
      type: Boolean,
      required: true,
    },

    status: {
      type: String,
      default: "show",
      enum: ["show", "hide"],
    },
    isVatFree: {
      type: Boolean,
      required: true,
      default: true,
    },
    isStoreProduct: {
      type: Boolean,
      default: false,
    },
    isCartpprod: {
      type: String,
      default: "",
    },
    purchaseLimit: {
      type: Number,
      required: false,
      default: null,
    },
    weight: {
      type: String,
      required: false,
    },

    // נתוני ההנהח"ש מיבוא האקסל. select: false כדי שעלויות ושמות ספקים
    // לא ייצאו בתגובות של החנות - שאילתה שצריכה אותם מבקשת אותם במפורש
    // ב-select("... erp"). שימו לב: select("+erp.x") על תת-שדה לא עובד.
    erp: {
      type: ProductErpSchema,
      required: false,
      select: false,
    },
  },
  {
    timestamps: true,
  }
);

const Product = mongoose.model("Product", productSchema);
module.exports = Product;
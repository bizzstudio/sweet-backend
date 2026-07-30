// models/Product.js
const mongoose = require("mongoose");

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
  },
  {
    timestamps: true,
  }
);

const Product = mongoose.model("Product", productSchema);
module.exports = Product;
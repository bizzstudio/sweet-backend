const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema(
  {
    title: {
      type: Object,
      required: false,
    },
    logo: {
      type: String,
      required: false,
    },
    couponCode: {
      type: String,
      required: true,
      unique: true,
    },
    startTime: {
      type: Date,
      required: false,
      validate: {
        validator: function (value) {
          return !this.endTime || value < this.endTime;
        },
        message: 'startTime must be before endTime',
      },
    },
    endTime: {
      type: Date,
      required: false,
      validate: {
        validator: function (value) {
          return !this.startTime || value > this.startTime;
        },
        message: 'endTime must be after startTime',
      },
    },
    discountType: {
      type: Object,
      // לא נדרש עבור קופון הרשמה (מוצר חינם) — נדרש רק לקופון רגיל (אחוז/סכום קבוע)
      required: function () {
        return !this.freeProduct;
      },
    },
    // קופון הרשמה: מוצר שמתווסף לעגלה בחינם (₪0). קיומו מסמן שזהו קופון מסוג מוצר-חינם.
    freeProduct: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: false,
    },
    // מעקב מימוש פר-לקוח — לאכיפת "פעם אחת לכל לקוח" בקופון הרשמה ובקופון רגיל עם oncePerCustomer
    usedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Customer',
      },
    ],
    // קופון תקף פעם אחת לכל לקוח (כמו במבצעים)
    oncePerCustomer: {
      type: Boolean,
      default: false,
    },
    minimumAmount: {
      type: Number,
      required: false,
    },
    productType: {
      type: String,
      required: false,
    },
    status: {
      type: String,
      lowercase: true,
      enum: ['show', 'hide'],
      default: 'show',
    },
    isUsed: {
      type: Boolean,
      required: true,
      default: false,
    },
    timesIsUsed: {
      type: Number,
      required: true,
      default: 0,
    }
  },
  {
    timestamps: true,
  }
);

// module.exports = couponSchema;

const Coupon = mongoose.model('Coupon', couponSchema);
module.exports = Coupon;

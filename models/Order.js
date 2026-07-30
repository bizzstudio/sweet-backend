// models/Order.js
const mongoose = require("mongoose");
// const AutoIncrement = require("mongoose-sequence")(mongoose); // הסר שורה זו

const CitySchema = new mongoose.Schema({
  _id: {
    type: Number,
    required: false,
  },
  city_code: {
    type: Number,
    required: false,
  },
  city_name_he: {
    type: String,
    required: true,
  },
  city_name_en: {
    type: String,
    required: false,
  },
  region_code: {
    type: Number,
    required: false,
  },
  region_name: {
    type: String,
    required: false,
  },
  PIBA_bureau_code: {
    type: Number,
    required: false,
  },
  PIBA_bureau_name: {
    type: String,
    required: false,
  },
  Regional_Council_code: {
    type: Number,
    required: false,
  },
  Regional_Council_name: {
    type: String,
    required: false,
  }
}, { _id: false, strict: false }); // Allows additional fields

const orderSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    invoice: {
      type: Number,
      required: false,
    },
    cart: [{}],
    user_info: {
      name: {
        type: String,
        required: false,
      },
      lastName: {
        type: String,
        required: false,
      },
      email: {
        type: String,
        required: false,
      },
      contact: {
        type: String,
        required: false,
      },
      address: {
        city: {
          type: CitySchema,
          required: false,
        },
        street: {
          type: String,
          required: false,
        },
        houseNumber: {
          type: String,
          required: false,
        },
        apartmentNumber: {
          type: String,
          required: false,
        },
        floor: {
          type: String,
          required: false,
        },
        entryCode: {
          type: String,
          required: false,
        },
        postalCode: {
          type: String,
          required: false,
        }
      },
      country: {
        type: String,
        required: false,
      },
      zipCode: {
        type: String,
        required: false,
      },
    },
    subTotal: {
      type: Number,
      required: true,
    },
    shippingCost: {
      type: Number,
      required: true,
    },
    discount: {
      type: Number,
      required: true,
      default: 0,
    },
    offerDiscount: {
      type: Number,
      required: false,
      default: 0,
    },
    total: {
      type: Number,
      required: true,
    },
    coupon: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      required: false,
    },
    shippingOption: {
      type: String,
      required: false,
    },
    paymentMethod: {
      type: String,
      required: true,
      default: "card",
    },
    status: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Status",
      required: true,
    },
    // היסטוריית שינויים בסטטוס
    statusHistory: [
      {
        from: { type: String, required: false }, // שם הסטטוס הקודם
        to: { type: String, required: false },   // שם הסטטוס החדש
        changedAt: { type: Date, default: Date.now }, // זמן השינוי
        changedBy: { type: String, required: false }, // פונקציה שביצעה את השינוי
      },
    ],
    customer_note: {
      type: String,
      required: false,
    },
    actualMelaket: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Status", // נניח שהמלקט הוא חלק מהסכמה Status
      required: false,
    },
    resFromLion: {
      type: Object,
      required: false,
    },
    // Customer satisfaction between 1-3
    customerSatisfaction: {
      type: Number,
      required: false,
      min: 1,
      max: 3,
    },
    // Bonus - If customer satisfaction is 1, the order total is multiplied by 0.04
    bonus: {
      type: Number,
      required: false,
    },
    // האם השליח צריך ליצור קשר או להניח ליד הדלת - שדה בוליאני
    callOnArrival: {
      type: Boolean,
    },
    // רשימת מבצעים שנוצלו בהזמנה (למעקב אחר oncePerCustomer)
    usedOfferIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "Offer",
    }],
    // נתוני עסקת Cardcom שנשמרים מה-Webhook לצורך החזר עתידי
    cardInfo: {
      type: Object,
      required: false,
    },
    // מידע על החזר כספי (Refund)
    refund: {
      requested: { type: Boolean, default: false },
      success: { type: Boolean, default: false },
      refundedAt: { type: Date, default: null },
      responseCode: { type: Number, default: null },
      rawResponse: { type: Object, default: null },
      errorMessage: { type: String, default: null },
    },
    // זכאות לקופון "לקנייה הבאה" — מי ששילם דמי משלוח ולא הגיע לסף המשלוח החינם.
    // נקבע ביצירת ההזמנה; הקופון עצמו מונפק ב-WebHook רק לאחר תשלום מוצלח.
    shippingRewardEligible: {
      type: Boolean,
      default: false,
    },
    // קוד הקופון האוטומטי שהונפק ללקוח לקנייה הבאה (מוזרם ב-WebHook)
    rewardCouponCode: {
      type: String,
      required: false,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// הסר את הפלגין AutoIncrement:
// orderSchema.plugin(AutoIncrement, {
//   inc_field: "invoice",
//   start_seq: 10000,
// });

// 2) Hooks לחישוב בונוס
// pre-save
orderSchema.pre("save", function (next) {
  // חישוב הבונוס אם המסמך חדש או אחד השדות הרלוונטיים השתנה
  if (
    this.isNew ||
    this.isModified("customerSatisfaction") ||
    this.isModified("total") ||
    this.isModified("shippingCost")
  ) {
    if (this.customerSatisfaction === 1) {
      this.bonus = (this.total - this.shippingCost) * 0.04;
    } else {
      this.bonus = 0;
    }
  }
  next();
});

// pre-findOneAndUpdate
orderSchema.pre("findOneAndUpdate", async function (next) {
  const update = this.getUpdate();

  // אם אחד השדות המשפיעים על הבונוס מתעדכן
  if (
    update.customerSatisfaction !== undefined ||
    update.total !== undefined ||
    update.shippingCost !== undefined
  ) {
    // שולפים את המסמך המקורי
    const docToUpdate = await this.model.findOne(this.getQuery());
    const customerSatisfaction =
      update.customerSatisfaction ?? docToUpdate.customerSatisfaction;
    const total = update.total ?? docToUpdate.total;
    const shippingCost = update.shippingCost ?? docToUpdate.shippingCost;

    if (customerSatisfaction === 1) {
      update.bonus = (total - shippingCost) * 0.04;
    } else {
      update.bonus = 0;
    }
  }

  next();
});

// pre-updateOne
orderSchema.pre("updateOne", async function (next) {
  const update = this.getUpdate();

  if (
    update.customerSatisfaction !== undefined ||
    update.total !== undefined ||
    update.shippingCost !== undefined
  ) {
    // שולפים את המסמך המקורי
    const docToUpdate = await this.model.findOne(this.getQuery());
    const customerSatisfaction =
      update.customerSatisfaction ?? docToUpdate.customerSatisfaction;
    const total = update.total ?? docToUpdate.total;
    const shippingCost = update.shippingCost ?? docToUpdate.shippingCost;

    if (customerSatisfaction === 1) {
      update.bonus = (total - shippingCost) * 0.04;
    } else {
      update.bonus = 0;
    }
  }

  next();
});

// 3) יוצרים את המודל
const Order = mongoose.model("Order", orderSchema);

module.exports = Order;
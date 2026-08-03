// models/Customer.js
const mongoose = require("mongoose");

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

// נתוני ההנהלת חשבונות מיבוא האקסל ("רשימת לקוחות"). מוחזק בנפרד כדי שהיבוא
// לא ידרוך על פרטי הלקוח בחנות, ושומר גם את הערכים הגולמיים מהקובץ
const CustomerErpSchema = new mongoose.Schema(
  {
    customerNumber: { type: String, required: false },
    contactPerson: { type: String, required: false },
    notes: { type: String, required: false },
    idNumber: { type: String, required: false },
    active: { type: Boolean, required: false },
    points: { type: Number, required: false },
    discountPercent: { type: Number, required: false },
    cumulativePurchase: { type: Number, required: false },
    credit: { type: Number, required: false },
    openingBalance: { type: Number, required: false },
    agent: { type: String, required: false },
    customerType: { type: String, required: false },
    priceLevel: { type: Number, required: false },
    paymentTerms: { type: Number, required: false },
    rawEmail: { type: String, required: false },
    rawAddress: { type: String, required: false },
    rawCity: { type: String, required: false },
    mobile: { type: String, required: false },
    landline: { type: String, required: false },
    birthDate: { type: Date, required: false },
    openDate: { type: Date, required: false },
    lastPurchaseAt: { type: Date, required: false },
    syncedAt: { type: Date, required: false },
  },
  { _id: false }
);

const customerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    lastName: {
      type: String,
      // required: true,
    },
    image: {
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
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
    },
    phone: {
      type: String,
      required: false,
    },
    password: {
      type: String,
      required: false,
    },
    inBlackList: { // האם הלקוח לא רוצה לקבל הודעות סקר
      type: Boolean,
      default: false,
    },
    isCashier: {
      type: Boolean,
      default: false,
    },
    welcomeGift: {
      isUsed: {
        type: Boolean,
        default: false,
      },
      offerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Offer",
        required: false,
      },
      sku: {
        type: String,
        required: false,
      },
    },

    // מעקב אחר מבצעי"פעם אחת ללקוח" שנוצלו
    redeemedOffers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Offer",
      }
    ],
    // האם הלקוח רשום לאתר (יש לו סיסמה)
    isRegistered: {
      type: Boolean,
      default: false,
    },
    // האם כבר הונפק ללקוח קופון "לקנייה הבאה" — הטבה חד-פעמית לכל לקוח
    shippingRewardIssued: {
      type: Boolean,
      default: false,
    },

    // נתוני ההנהח"ש מיבוא האקסל. select: false כדי שיתרות והערות פנימיות
    // לא ייצאו בתגובות רגילות - היבוא מבקש אותם במפורש.
    erp: {
      type: CustomerErpSchema,
      required: false,
      select: false,
    },
  },
  {
    timestamps: true,
  }
);

// אינדקס קטן אם תרצה לבדוק מהר האם לקוח ניצל Offer מסוים
customerSchema.index({ _id: 1, redeemedOffers: 1 });

// התאמת לקוח מיבוא האקסל נעשית לפי מספר הלקוח בהנהח"ש
customerSchema.index({ "erp.customerNumber": 1 });

// חיפוש לפי טלפון קורה בכניסה ב-SMS, בזיהוי כפילויות בהרשמה וביבוא האקסל
// (שם נבנית שאילתת $in גדולה). בלי אינדקס כל אחד מהם סורק את כל האוסף.
customerSchema.index({ phone: 1 });

const Customer = mongoose.model("Customer", customerSchema);

module.exports = Customer;
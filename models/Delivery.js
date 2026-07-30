const mongoose = require('mongoose');

const DaySchema = new mongoose.Schema({
  value: {
    type: String,
    required: true,
    enum: [1, 2, 3, 4, 5, 6, 7],
  },
  name: {
    type: String,
    required: true,
    enum: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  }
}, { _id: false });

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

CitySchema.pre('save', function(next) {
  // לקצץ רווחים מיותרים בכל השדות הרלוונטיים
  this.city_name_he = this.city_name_he.trim();
  if (this.city_name_en) this.city_name_en = this.city_name_en.trim();
  if (this.region_name) this.region_name = this.region_name.trim();
  if (this.PIBA_bureau_name) this.PIBA_bureau_name = this.PIBA_bureau_name.trim();
  if (this.Regional_Council_name) this.Regional_Council_name = this.Regional_Council_name.trim();
  next();
});

// סכמה ליעדי משלוח שהאדמין מגדיר
const DeliverySchema = new mongoose.Schema({
  city: {
    type: CitySchema,
    required: true,
  },
  price: {
    type: Number,
    required: true,
    min: 0, // מוסיף וולידציה שמחיר לא יכול להיות פחות מ-0
  },
  /** סכום מינימלי בעגלה (לפני משלוח) עבור יעד זה */
  minimumOrder: {
    type: Number,
    default: 150,
    min: 0,
  },
  days: {
    type: [DaySchema],
    default: [], // מגדיר ערך ברירת מחדל לרשימה
  },
  /** האם המשלוח ליעד זה מגיע פעם בשבועיים */
  biweekly: {
    type: Boolean,
    default: false,
  }
}, { timestamps: true });

const Delivery = mongoose.model('Delivery', DeliverySchema);
module.exports = Delivery;
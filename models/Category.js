// models/Category.js
const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema(
  {
    name: {
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
      unique: true,
      index: true,
      trim: true,
      lowercase: true,
    },
    parentId: {
      type: String,
      required: false,
    },
    parentName: {
      type: String,
      required: false,
    },
    id: {
      type: String,
      required: false,
    },
    icon: {
      type: String,
      required: false,
    },
    coloredIcon: {
      type: String,
      required: false,
    },
    status: {
      type: String,
      lowercase: true,
      enum: ['show', 'hide'],
      default: 'show',
    },

    // סחורה שנשקלת בפועל ולכן אינה נכנסת לתעודת המשלוח האוטומטית.
    //
    // ההזמנה נקלטת עם המשקל שהלקוח *הזמין*, אבל מה שנמסר בפועל נקבע על
    // המשקל ביום האריזה. תעודה אוטומטית על השורות האלה הייתה מחייבת בסוף
    // החודש לפי המשקל המוזמן — כלומר לפי מספר שאיש לא שקל.
    //
    // לכן שורות של קטגוריה כזו נשארות מחוץ לתעודה האוטומטית, ועליהן מוציאים
    // תעודה ידנית עם המשקל האמיתי. החשבונית החודשית נבנית מהתעודות, ולכן
    // היא מחייבת את המשקל שהוזן ידנית.
    //
    // הדגל יורש לקטגוריות הבנות (ראו lib/billing/manualItems) — מספיק לסמן
    // את "פירות וירקות" ולא כל תת-קטגוריה בנפרד.
    requiresManualNote: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// module.exports = categorySchema;

const Category = mongoose.model('Category', categorySchema);
module.exports = Category;

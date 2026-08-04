// models/Counter.js
//
// מונים מתמידים לשדות רצים (מספר הזמנה וכו').
//
// למה קולקציה משלנו ולא הקולקציה "counters" של mongoose-sequence: הפלאגין הזה
// (בשימוש ב-CashierOrder) מחזיק סכמה משלו עם אינדקס ייחודי על (id, reference_value),
// ומקצה את המספר רק דרך hook של save. אנחנו צריכים להקצות מספר בקוד, מכל מסלול
// יצירה, ולכן מנהלים מונה נפרד בקולקציה "app_counters".

const mongoose = require("mongoose");

const counterSchema = new mongoose.Schema(
  {
    // מזהה המונה, למשל "order_invoice"
    _id: { type: String, required: true },
    // המספר האחרון שהוקצה בפועל
    seq: { type: Number, required: true },
  },
  { versionKey: false, timestamps: true }
);

module.exports = mongoose.model("Counter", counterSchema, "app_counters");

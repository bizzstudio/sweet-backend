// models/Status.js
const mongoose = require("mongoose");

const statusSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    heName: {
      type: String,
      required: true,
    },
    phone: {
      type: String,
      required: true,
    },
    color: {
      type: String,
      required: true,
      default: "#212121",
    },
    isActive: {
      type: Boolean,
      required: true,
      default: true,
    },
    password: {
      type: String,
      required: false,
      select: false
    },
    // שם משתמש להתחברות לאפליקציית הליקוט. אופציונלי בכוונה: מלקטים
    // ותיקים נוצרו לפני השדה הזה וממשיכים להתחבר לפי טלפון.
    // הייחודיות נאכפת ב-statusController ולא באינדקס unique, כדי לא
    // להוסיף אינדקס על collection קיים שברוב רשומותיו (סטטוסי הזמנה)
    // אין שדה כזה בכלל — אינדקס כזה היה נכשל על ערכי null כפולים.
    username: {
      type: String,
      required: false,
      trim: true,
    },
    // ה-collection הזה מחזיק שני סוגי רשומות: סטטוסי הזמנה (Pending,
    // Delivered...) ומלקטים. הדגל מסמן מלקטים במפורש. רשומות שנוצרו
    // לפני כן מזוהות לפי phone לא ריק — ראה isMelaketRecord.
    isMelaket: {
      type: Boolean,
      required: false,
    },
  },
  {
    timestamps: true,
  }
);

const Status = mongoose.model("Status", statusSchema);

module.exports = Status;
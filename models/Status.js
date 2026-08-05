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
    // לא required: מאז שההתחברות לליקוט עברה לשם משתמש, מלקט יכול להיווצר
    // בלי טלפון. כשהוא היה required, new Status({ phone: "" }).save() נכשל
    // בוולידציה — ולכן init-db ו-ingestionStatus יוצרים סטטוסים ב-upsert,
    // שלא מפעיל ולידטורים.
    //
    // בכוונה בלי default: "": במונגוס 8 setDefaultsOnInsert פעיל כברירת
    // מחדל, וערך ברירת מחדל היה מוסיף phone גם ל-IngestionError שנוצר
    // ב-upsert. הדשבורד מזהה מלקטים ב-{ phone: { $exists: true } }, כך
    // שהזמנות שבורות היו נכנסות לסכימת ההכנסות.
    phone: {
      type: String,
      required: false,
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
    // לפני כן מזוהות לפי phone לא ריק — ראה getAllMelaketim.
    isMelaket: {
      type: Boolean,
      required: false,
    },
  },
  {
    timestamps: true,
  }
);

// הבדיקה בקונטרולר לבדה היא TOCTOU: שתי בקשות מקבילות עם אותו שם משתמש
// היו עוברות שתיהן. האינדקס סוגר את החלון ברמת מסד הנתונים.
//
// partialFilterExpression מגביל אותו לרשומות שבהן username הוא מחרוזת,
// ולכן סטטוסי ההזמנות — שאין להם את השדה כלל — לא נכנסים לאינדקס ולא
// מתנגשים זה בזה. אינדקס unique רגיל היה נכשל עליהם.
statusSchema.index(
  { username: 1 },
  { unique: true, partialFilterExpression: { username: { $type: "string" } } }
);

const Status = mongoose.model("Status", statusSchema);

module.exports = Status;
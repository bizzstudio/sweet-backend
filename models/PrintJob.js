// models/PrintJob.js
//
// תור ההדפסה. כל רשומה כאן היא "מסמך אחד שצריך לצאת מהמדפסת".
//
// למה תור ולא הדפסה ישירה: השרת יושב בענן (srv2) והמדפסת יושבת במשרד.
// אין ביניהם שום קשר ישיר, ואי אפשר לפתוח מהשרת חיבור למדפסת. הפתרון הוא
// היפוך הכיוון — סוכן קטן שרץ על המחשב שליד המדפסת מושך משימות מהשרת
// (print-agent/), מוריד את ה-PDF ומדפיס אותו מקומית. השרת רק כותב לתור.
//
// הדפסה מהדפדפן (window.print) לא יכולה לענות על הדרישה "יודפס מיד":
// דפדפן אינו מדפיס בלי אדם שלוחץ, ובלילה או כשההזמנה נקלטת מווצאפ אין
// אדם מול המסך.
//
// המצב הוא מכונת מצבים קטנה:
//
//   pending   → הסוכן עוד לא לקח
//   printing  → הסוכן תפס את המשימה (lockedAt נחתם)
//   printed   → יצא מהמדפסת
//   failed    → נכשל MAX_ATTEMPTS פעמים, דורש טיפול ידני
//   cancelled → התעודה בוטלה לפני שהנייר יצא
//
// משימה שנתקעה ב-printing (המחשב כובה באמצע, הסוכן קרס) חוזרת ל-pending
// אוטומטית אחרי STALE_LOCK_MS — ראו controller/printJobController.

const mongoose = require("mongoose");

const printJobSchema = new mongoose.Schema(
  {
    // סוג המסמך. enum ולא מחרוזת חופשית כדי שהקונטרולר יידע לאיזה מודל
    // לפנות. כרגע רק תעודת משלוח; הצעת מחיר תיכנס כאן כשיוחלט שגם היא
    // מודפסת אוטומטית.
    docType: {
      type: String,
      enum: ["deliveryNote"],
      required: true,
    },
    docId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },

    // מספר המסמך, משוכפל לצורך לוגים וזיהוי בלי join. המסמך עצמו יכול
    // להימחק, והרישום בתור עדיין צריך להיות קריא.
    docNumber: { type: Number, required: false },

    status: {
      type: String,
      // cancelled נכנס כשהתעודה בוטלה בזמן שהמשימה עוד המתינה. הרשומה
      // נשארת ולא נמחקת — "למה התעודה הזו לא יצאה מהמדפסת" היא שאלה
      // שנשאלת, ומחיקה הייתה מוחקת גם את התשובה.
      enum: ["pending", "printing", "printed", "failed", "cancelled"],
      default: "pending",
    },
    attempts: { type: Number, default: 0 },
    lockedAt: { type: Date, default: null },
    printedAt: { type: Date, default: null },
    lastError: { type: String, default: null },

    // מי הזמין את ההדפסה — "אוטומטי" או מייל המשתמש שלחץ "הדפס שוב".
    // נשמר כי "למה יצאו שתי תעודות" היא שאלה שנשאלת, והתשובה היא כאן.
    requestedBy: { type: String, required: false },
  },
  { timestamps: true }
);

// מסמך אחד = הדפסה אחת. שתי קריאות במקביל (יצירה אוטומטית שרצה במקביל
// להפקה ידנית מהמסך) לא ייצרו שני ניירות.
//
// זו הסיבה שהוספת משימה נעשית ב-findOneAndUpdate עם upsert ולא ב-create:
// הדפסה חוזרת מכוונת מאפסת את הרשומה הקיימת, ולא מוסיפה שנייה לצידה.
printJobSchema.index({ docType: 1, docId: 1 }, { unique: true });

// השאילתה של הסוכן, כל 10 שניות. בלי האינדקס הזה כל polling סורק את כל
// היסטוריית ההדפסות.
printJobSchema.index({ status: 1, createdAt: 1 });

const PrintJob = mongoose.model("PrintJob", printJobSchema);

// כמו ב-DeliveryNote: אינדקס ייחודי שלא נבנה בגלל כפילויות קיימות היה
// משאיר את השרת רץ בלי ההגנה, בשקט.
PrintJob.on("index", (err) => {
  if (!err) return;
  console.error(
    `[PrintJob] בניית אינדקס נכשלה: ${err.message}\n` +
      `        ההגנה מפני הדפסה כפולה חסרה.`
  );
});

module.exports = PrintJob;

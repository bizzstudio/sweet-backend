// models/CustomerPriceList.js
//
// מחירון פרטי ללקוח: מק"ט → מחיר. מסמך אחד לכל לקוח, שנדרס במלואו בכל יבוא
// אקסל חדש — מחירון הוא קובץ שהלקוח מקבל, ולא אוסף עדכונים מצטבר.
//
// המחירון הוא **שכבת דריסה חלקית**: מק"ט שמופיע בו נמכר במחיר שכתוב בו, וכל
// מק"ט אחר נמכר במחיר ברירת המחדל של הקטלוג (prices.price). לקוח בלי מסמך כאן
// משלם את מחירי הקטלוג במלואם — אין "מחירון ריק" שחוסם מכירה.
//
// המחיר נשמר כמות שהוא, כולל מע"מ, כמו prices.price בקטלוג: הוא נשלח כ-UnitCost
// לחשבונית ואין בפרויקט חישוב מע"מ על גביו (ראה productController).

const mongoose = require("mongoose");

const PriceListItemSchema = new mongoose.Schema(
  {
    // מזהה ההתאמה מול הקטלוג. טקסט ולא מספר בכוונה — קריאה כמספר הייתה הורסת
    // אפסים מובילים ("007" -> 7) ומק"טים שאינם מספריים
    sku: { type: String, required: true },
    price: { type: Number, required: true },
    // שם המוצר כפי שהופיע בקובץ הלקוח. אינו משמש להתאמה (ההתאמה לפי מק"ט
    // בלבד) אלא לאימות: מק"ט שהשם שלו אינו תואם לשם בקטלוג מסומן בתצוגה
    // המקדימה, כדי שקובץ עם עמודות שהוזזו ייתפס לפני היבוא ולא אחריו
    name: { type: String, required: false },
  },
  { _id: false }
);

const customerPriceListSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      unique: true,
    },

    // ‏select: false כדי שמסמך של אלפי שורות לא ייגרר בשאילתות סיכום (רשימת
    // הלקוחות שואלת רק "יש מחירון וכמה שורות"). שאילתה שצריכה את השורות
    // מבקשת אותן במפורש ב-select("+items")
    items: {
      type: [PriceListItemSchema],
      default: [],
      select: false,
    },

    // נגזר מ-items באותה כתיבה, כדי שאפשר יהיה להציג "כמה שורות" בלי לטעון אותן
    itemsCount: { type: Number, default: 0 },

    fileName: { type: String, required: false },
    importedBy: { type: String, required: false },
    importedAt: { type: Date, required: false },
  },
  {
    timestamps: true,
  }
);

const CustomerPriceList = mongoose.model("CustomerPriceList", customerPriceListSchema);

module.exports = CustomerPriceList;

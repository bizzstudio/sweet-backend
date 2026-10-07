// models/CustomerBalanceEntry.js
//
// תנועה ביתרת הלקוח — כסף שנשאר לזכותו אצלנו, או חוב שנשאר ממנו.
//
// לקוח שהעביר 1,000 ₪ על חשבונית של 800 ₪ השאיר אצלנו 200 ₪. הקבלה
// ב-iCount נושאת את הסכום, אבל אצלנו לא היה מקום שזוכר אותו: החשבונית
// סומנה "שולמה" וההפרש נעלם. התנועות כאן הן המקום הזה.
//
// היתרה אינה שדה על הלקוח אלא סכום התנועות. שדה מצטבר היה מתרחק מהאמת
// בכל כתיבה שנכשלה באמצע, ולא היה אפשר לענות על "מאיפה ה-200 האלה".
// ללקוח יש עשרות תנועות לכל היותר, והסיכום שלהן זול.
//
// delta חיובי = לזכות הלקוח. שלילי = לחובתו.

const mongoose = require("mongoose");

const KINDS = [
  // קבלה שהופקה על חשבונית: delta = מה שהתקבל פחות סכום החשבונית
  "payment",
  // חשבונית שנסגרה כולה מיתרת הזכות, בלי קבלה
  "fromBalance",
  // חשבונית ששולמה ובוטלה בזיכוי — מה ששולם עליה חוזר לזכות הלקוח
  "invoiceCancelled",
  // חשבונית זיכוי שהופקה מתעודת זיכוי
  "creditInvoice",
  // תיקון ידני מכרטיס הלקוח
  "manual",
];

const customerBalanceEntrySchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },

    // תנועה שנוצרה מול חשבון הדמו של iCount. אותו עיקרון כמו billing.demo
    // על תעודת המשלוח (lib/billing/ledger.js): היתרה האמיתית לא סופרת
    // תנועות דמו לעולם. ניקוי: scripts/billing-demo-reset.js
    demo: { type: Boolean, default: false },

    kind: { type: String, enum: KINDS, required: true },
    delta: { type: Number, required: true },

    // הסכום שנרשם על הקבלה, וסכום החשבוניות שהיא סגרה. נשמרים לצד delta
    // כדי שהתנועה תסביר את עצמה: "התקבלו 1,000 על חשבונית של 800".
    received: { type: Number, required: false },
    invoiceTotal: { type: Number, required: false },
    // מאיפה הגיע סכום החשבונית: icount (המחייב) או estimate (האומדן
    // מהתעודות, כש-iCount לא היה זמין ברגע הרישום)
    totalSource: { type: String, enum: ["icount", "estimate"], required: false },

    // החשבוניות שהתנועה נוגעת להן, עם הסכום של כל אחת. הסכום נדרש כדי
    // להחזיר ללקוח בדיוק את מה שנסגר אם החשבונית תבוטל בהמשך.
    invoices: [
      {
        docNum: { type: String, required: true },
        total: { type: Number, required: false },
        _id: false,
      },
    ],

    receiptDocNum: { type: String, required: false },
    creditDocNum: { type: String, required: false },
    reason: { type: String, required: false },
    createdBy: { type: String, required: false },
  },
  { timestamps: true }
);

customerBalanceEntrySchema.index({ customer: 1, demo: 1, createdAt: 1 });
customerBalanceEntrySchema.index({ receiptDocNum: 1 }, { sparse: true });

const CustomerBalanceEntry = mongoose.model("CustomerBalanceEntry", customerBalanceEntrySchema);

module.exports = CustomerBalanceEntry;
module.exports.KINDS = KINDS;

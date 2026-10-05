// models/CreditNote.js
//
// תעודת משלוח זיכוי — סחורה שחזרה מהלקוח, או סכום שמגיע לו בחזרה.
//
// כמו תעודת משלוח והצעת מחיר, המסמך נבנה ומודפס אצלנו. הוא אינו מסמך מס:
// מסמך המס הוא חשבונית הזיכוי שמופקת ממנו ב-iCount, והתעודה היא הצילום
// שממנו היא נבנית — בדיוק היחס שבין תעודת משלוח לחשבונית.
//
// קולקציה נפרדת מ-DeliveryNote ולא kind נוסף עליה, בכוונה: כל מסלולי
// החיוב (סגירת חודש, חיוב מיידי, רשימת החשבוניות, הדוחות) שולפים תעודות
// משלוח ומחייבים עליהן. תעודת זיכוי שיושבת באותה קולקציה הייתה מחויבת
// ללקוח כסחורה בכל מקום שבו מישהו שכח לסנן אותה.
//
// הסכומים נשמרים חיוביים. "זיכוי" הוא סוג המסמך ולא סימן המספר — כך גם
// ב-iCount, שמקבל שורות חיוביות במסמך מסוג refund.

const mongoose = require("mongoose");

const CreditNoteItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: false },
    // שורה חופשית ("הפרש מחיר", "פיצוי") אינה מוצר ואין לה מק"ט
    sku: { type: String, required: false },
    barcode: { type: String, required: false },
    name: { type: String, required: true },
    quantity: { type: Number, required: true },
    // ללא מע"מ, כמו בכל המערכת
    unitPrice: { type: Number, required: true },
    lineTotal: { type: Number, required: true },
    isVatFree: { type: Boolean, default: false },
    category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: false },
    categoryName: { type: String, required: false },
  },
  { _id: false }
);

// מצב ההפקה של חשבונית הזיכוי. מופיע פעמיים — בספרים האמיתיים ובכיס
// הדמו — מאותה סיבה כמו ב-DeliveryNote (ראה lib/billing/ledger.js)
const creditDocFields = {
  claimToken: { type: String, required: false },
  claimedAt: { type: Date, required: false },
  creditDocNum: { type: String, required: false },
  creditDocUrl: { type: String, required: false },
  creditDocEmailedTo: { type: String, default: null },
  // החשבונית שהזיכוי מקושר אליה ב-iCount (based_on). ריק = זיכוי שאינו
  // מקושר לחשבונית מסוימת
  originalDocNum: { type: String, required: false },
  billedAt: { type: Date, required: false },
};

const creditNoteSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true, unique: true },

    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    customerSnapshot: {
      name: { type: String, required: false },
      customerNumber: { type: String, required: false },
      vatId: { type: String, required: false },
      address: { type: String, required: false },
      city: { type: String, required: false },
      contactPerson: { type: String, required: false },
      contactPhone: { type: String, required: false },
    },

    items: {
      type: [CreditNoteItemSchema],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "תעודת זיכוי חייבת לכלול לפחות שורה אחת",
      },
    },

    subTotal: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    discountPercent: { type: Number, default: 0 },
    customerDiscount: { type: Number, default: 0 },
    total: { type: Number, required: true },

    // סיבת הזיכוי. מודפסת על התעודה ועל חשבונית הזיכוי
    reason: { type: String, required: true },
    notes: { type: String, required: false },

    issuedAt: { type: Date, default: Date.now },
    issuedBy: { type: String, required: false },

    // מונע שתי תעודות משליחה כפולה של אותו טופס
    idempotencyKey: { type: String, required: false },

    billing: {
      // open     = התעודה קיימת, חשבונית זיכוי עוד לא הופקה
      // billing  = נתפסה להפקה (ההגנה מפני חשבונית זיכוי כפולה)
      // billed   = הופקה חשבונית זיכוי
      // cancelled = בוטלה לפני שהופקה חשבונית
      status: {
        type: String,
        enum: ["open", "billing", "billed", "cancelled"],
        default: "open",
      },
      ...creditDocFields,
      cancelReason: { type: String, required: false },
      cancelledAt: { type: Date, required: false },

      demo: {
        status: {
          type: String,
          enum: ["open", "billing", "billed"],
          required: false,
        },
        ...creditDocFields,
      },
    },
  },
  { timestamps: true }
);

creditNoteSchema.index({ customer: 1, "billing.status": 1 });
creditNoteSchema.index({ number: -1 });
creditNoteSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
// רשימת החשבוניות מצרפת לכל חשבונית את הזיכויים שמקושרים אליה
creditNoteSchema.index({ "billing.originalDocNum": 1 }, { sparse: true });

const CreditNote = mongoose.model("CreditNote", creditNoteSchema);

CreditNote.on("index", (err) => {
  if (!err) return;
  console.error(
    `[CreditNote] בניית אינדקס נכשלה: ${err.message}\n` +
      `        אם מדובר ב-number — יש כפילויות בנתונים.`
  );
});

module.exports = CreditNote;

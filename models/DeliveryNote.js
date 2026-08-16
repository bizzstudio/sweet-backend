// models/DeliveryNote.js
//
// תעודת משלוח. נוצרת על כל הזמנה שיוצאת ללקוח, ובסוף החודש כל התעודות
// הפתוחות של אותו לקוח נסגרות לחשבונית אחת ב-iCount.
//
// שני סוגים (ראו השדה kind):
//
//   auto   — מההזמנה. השורות שנמכרות ביחידות, בכמות שההזמנה אומרת.
//   manual — מוקלדת ביד. סחורה שנשקלת (פירות וירקות), שההזמנה נקלטה עם
//            המשקל המבוקש שלה אבל נמסרה במשקל שנשקל בפועל.
//
// זו הסיבה שהחשבונית החודשית מחייבת את המשקל האמיתי: היא נבנית מהתעודות,
// והמשקל שנשקל נכנס דרך התעודה הידנית.
//
// למה ישות נפרדת ולא שדות על ההזמנה:
//
//   1. התעודה היא צילום מצב. ההזמנה ממשיכה להשתנות אחריה (סטטוס, הערות,
//      ואפילו עריכת פריטים), והמסמך שנמסר ללקוח חייב להישאר מה שנמסר.
//      החשבונית בסוף החודש נבנית מהתעודות, ולכן היא לא מושפעת משינוי
//      מאוחר בהזמנה.
//   2. מספר רץ עצמאי. מספר ההזמנה שלנו (Order.invoice) הוא מספר פנימי;
//      תעודת המשלוח היא מסמך שיוצא ללקוח וצריכה סדרה משלה.
//   3. חיוב. "מה עוד לא חויב" היא שאילתה על התעודות. על ההזמנה זה היה
//      מתערבב עם סטטוסים לוגיסטיים שאין להם קשר לחיוב.
//
// התעודה נשארת אצלנו בלבד ואינה נשלחת ל-iCount (החלטה של הלקוחה, 13/08/26) —
// ב-iCount נכנסת רק החשבונית החודשית.

const mongoose = require("mongoose");

// שורה בתעודה. מועתקת מהעגלה ולא מוחזקת כ-ref למוצר, מאותה סיבה שהתעודה
// היא צילום מצב: שינוי מחיר או שם מוצר אסור שישנה תעודה שכבר נמסרה.
const DeliveryNoteItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: false },
    sku: { type: String, required: false },
    barcode: { type: String, required: false },
    name: { type: String, required: true },

    quantity: { type: Number, required: true },
    // מחיר ליחידה לפני מע"מ. המערכת עובדת כולה ללא מע"מ (מקור: קובץ
    // המחירון "מחירוני לקוח ללא מעמ"), והמע"מ מתווסף רק על החשבונית.
    unitPrice: { type: Number, required: true },
    lineTotal: { type: Number, required: true },

    // מוצרים פטורי מע"מ (פירות וכד'). חייב להישמר ברמת השורה ולא ברמת
    // המסמך — תעודה אחת יכולה לערבב שורות חייבות ופטורות.
    isVatFree: { type: Boolean, default: false },

    // נשמר כדי לאפשר פיצול החשבונית החודשית לפי קטגוריה
    category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: false },
    categoryName: { type: String, required: false },
  },
  { _id: false }
);

const deliveryNoteSchema = new mongoose.Schema(
  {
    // מספר רץ. מוקצה ב-utils/deliveryNoteNumber במונה אטומי, לא כאן.
    number: {
      type: Number,
      required: true,
      unique: true,
    },

    // איך הופקה התעודה:
    //
    //   auto   — מההזמנה, על השורות שנמכרות ביחידות. נוצרת אוטומטית במעבר
    //            ל"נמסר" ומכילה בדיוק את מה שההזמנה אומרת.
    //   manual — הוקלדה ביד, על סחורה שנשקלת (פירות וירקות). הכמות בה היא
    //            המשקל שנשקל בפועל ולא המשקל שהוזמן, ולכן היא זו שקובעת
    //            את החיוב בסוף החודש.
    //
    // ההפרדה נשמרת על התעודה ולא נגזרת מ-issuedBy או מקיום order: תעודה
    // אוטומטית שהופקה ביד מהמסך היא עדיין אוטומטית, ותעודה ידנית שקושרה
    // להזמנה היא עדיין ידנית.
    kind: {
      type: String,
      enum: ["auto", "manual"],
      default: "auto",
    },

    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      // תעודה ידנית יכולה לעמוד בפני עצמה: משלוח פירות שאין מולו הזמנה
      // במערכת עדיין צריך להגיע לחשבונית החודשית.
      required: function () {
        return this.kind !== "manual";
      },
    },

    // מספר התעודה מהפנקס הידני, אם הסחורה יצאה עם פתק נייר לפני שהוקלדה.
    // זה מה שמאפשר להצליב מול מה שהלקוח החזיק ביד כשקיבל את הסחורה.
    manualReference: { type: String, required: false },

    // מפתח ייחודיות שנשלח מהמסך. שתי שליחות של אותו טופס (לחיצה כפולה,
    // רענון, חיבור שנפל וניסה שוב) נושאות אותו מפתח, והאינדקס הייחודי
    // מוודא שרק אחת מהן תיצור תעודה.
    //
    // נחוץ דווקא לתעודה הידנית: על האוטומטית מגן האינדקס על order, אבל
    // תעודה ידנית *כן* יכולה להיות שנייה לאותה הזמנה (משלוח פירות מפוצל),
    // ולכן אין עליה אילוץ אחר. בלי זה לחיצה כפולה = חיוב כפול בסוף החודש.
    idempotencyKey: { type: String, required: false },
    // מספר ההזמנה, משוכפל לצורך תצוגה וחיפוש בלי join
    orderNumber: { type: Number, required: false },

    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    // צילום פרטי הלקוח בזמן המסירה
    customerSnapshot: {
      name: { type: String, required: false },
      customerNumber: { type: String, required: false },
      vatId: { type: String, required: false },
      address: { type: String, required: false },
      city: { type: String, required: false },
      contactPerson: { type: String, required: false },
    },

    items: {
      type: [DeliveryNoteItemSchema],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "תעודת משלוח חייבת לכלול לפחות שורה אחת",
      },
    },

    // סכומים לפני מע"מ
    subTotal: { type: Number, required: true },
    shippingCost: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    total: { type: Number, required: true },

    issuedAt: { type: Date, default: Date.now },
    issuedBy: { type: String, required: false },

    // מצב החיוב של התעודה מול iCount
    billing: {
      // open = ממתינה לחיוב | billing = נתפסה על ידי ריצת סגירת חודש שרצה
      // כרגע | billed = חויבה | cancelled = בוטלה לפני חיוב.
      //
      // המצב billing קיים כדי שסגירת חודש תוכל "לתפוס" תעודות בפעולה
      // אטומית אחת לפני שהיא פונה ל-iCount. בלעדיו שתי ריצות במקביל (או
      // לחיצה כפולה על הכפתור) היו קוראות את אותן תעודות פתוחות ומפיקות
      // שתי חשבוניות על אותו חיוב.
      status: {
        type: String,
        enum: ["open", "billing", "billed", "cancelled"],
        default: "open",
      },
      // מזהה הריצה שתפסה את התעודה. משמש לשחרור התפיסה אם ההפקה נכשלה,
      // ולזיהוי תעודות שנתקעו במצב billing אחרי קריסה.
      claimToken: { type: String, required: false },
      claimedAt: { type: Date, required: false },
      // מספר החשבונית ב-iCount שסגרה את התעודה
      icountDocNum: { type: String, required: false },
      icountDocType: { type: String, required: false },
      // הקישור למסמך עצמו ב-iCount.
      //
      // חייב להישמר ולא רק להיות מוחזר בתשובה: בלעדיו הקישור קיים רק
      // בשנייה שאחרי ההפקה, ומי שסגר את המסך צריך להיכנס ל-iCount
      // ולחפש לפי מספר. עם הפקה אוטומטית בלילה אף אחד לא רואה את
      // התשובה ההיא בכלל.
      icountDocUrl: { type: String, required: false },
      billedAt: { type: Date, required: false },
      // החודש שאליו שויכה התעודה, בפורמט YYYY-MM. נקבע לפי issuedAt, אבל
      // נשמר בנפרד כדי שאפשר יהיה לשייך ידנית תעודה מאחרת לחודש הקודם.
      billingMonth: { type: String, required: false },
      // הסיבה לביטול, אם בוטלה
      cancelReason: { type: String, required: false },

      // התשלום שסגר את החשבונית של התעודה.
      //
      // נשמר כאן ולא בישות נפרדת כי אין לנו ניהול חשבוניות משלנו —
      // החשבונית חיה ב-iCount, והתעודה היא הדבר היחיד אצלנו שמצביע
      // עליה. בלי זה "מי חייב לי כסף" לא ניתן לענייה: כל חשבונית
      // שעבר מועד הפירעון שלה הייתה נראית כלא משולמת לנצח.
      receiptDocNum: { type: String, required: false },
      receiptDocUrl: { type: String, required: false },
      paidAt: { type: Date, required: false },

      // היסטוריית הזיכויים של התעודה.
      //
      // זיכוי מנקה את icountDocNum ומחזיר את התעודה למצב פתוח, ולכן בלי
      // הרישום הזה עקבות הזיכוי נמחקות לגמרי — ואי אפשר לענות על "למה
      // התעודה הזו חויבה פעמיים" או למצוא את מסמך הזיכוי. חשבונית זיכוי
      // היא מסמך מס, וחייב להישאר לה תיעוד.
      credits: [
        {
          creditDocNum: { type: String, required: false },
          creditDocUrl: { type: String, required: false },
          originalDocNum: { type: String, required: false },
          reason: { type: String, required: false },
          creditedAt: { type: Date, default: Date.now },
          _id: false,
        },
      ],
    },

    notes: { type: String, required: false },
  },
  { timestamps: true }
);

// השאילתה המרכזית של סגירת החודש: כל התעודות הפתוחות של לקוח בחודש נתון.
deliveryNoteSchema.index({ customer: 1, "billing.status": 1, "billing.billingMonth": 1 });

// חיפוש תעודה לפי מספר במסך האדמין
deliveryNoteSchema.index({ number: -1 });

// הזמנה אחת = תעודה אוטומטית אחת. שתי קריאות מקבילות (לחיצה כפולה על
// "הפק תעודה", או המסלול האוטומטי שרץ במקביל לידני) לא ייצרו שתי תעודות.
//
// partialFilterExpression ולא unique על השדה: תעודות ידניות *כן* יכולות
// להיות כמה לאותה הזמנה — משלוח פירות יוצא לפעמים בשתי פעימות — ואילוץ
// גורף היה חוסם את המקרה הזה. עליהן מגן idempotencyKey.
deliveryNoteSchema.index(
  { order: 1 },
  { unique: true, partialFilterExpression: { kind: "auto" } }
);

// מפתח הייחודיות של הטופס הידני. sparse: רוב התעודות (וכל הישנות) בלעדיו.
deliveryNoteSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

// "מה עוד לא הוקלד" — תעודות ידניות של הזמנה מסוימת
deliveryNoteSchema.index({ order: 1, kind: 1 });

const DeliveryNote = mongoose.model("DeliveryNote", deliveryNoteSchema);

// כמו ב-Order: אם האינדקס הייחודי לא נבנה בגלל כפילויות קיימות, השרת היה
// ממשיך לרוץ בלי ההגנה בשקט. חייבים לדעת.
DeliveryNote.on("index", (err) => {
  if (!err) return;
  console.error(
    `[DeliveryNote] בניית אינדקס נכשלה: ${err.message}\n` +
      `        אם מדובר ב-number או ב-order — יש כפילויות בנתונים.\n` +
      `        המערכת ממשיכה לעבוד, אבל ההגנה מפני תעודה כפולה חסרה.`
  );
});

module.exports = DeliveryNote;

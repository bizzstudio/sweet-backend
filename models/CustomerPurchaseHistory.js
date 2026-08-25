// models/CustomerPurchaseHistory.js
//
// מה הלקוח קנה בפועל, מיוצא ההנהח"ש. מסמך אחד לכל לקוח, שנדרס במלואו בכל
// יבוא — היסטוריה היא ייצוא של מצב, לא אוסף עדכונים מצטבר.
//
// ── למה זה לא ProductAlias ──
//
// ‏ProductAlias הוא **הכרעה של אדם**: מפתח אחד, מוצר אחד, אינדקס ייחודי שאוכף
// זאת. מה שנשמר כאן הוא **ראיה סטטיסטית** עם משקלים — כמה פעמים, מתי לאחרונה,
// באיזו כמות. אלה שני דברים שונים, ומיזוגם היה מאפשר לסטטיסטיקה שנגזרה
// ממכונה לדרוס פסיקה מפורשת של אדם. זה בדיוק הכשל ש-ProductAlias מזהיר מפניו.
//
// הפרדה נוספת שנובעת מכך: היסטוריה **לעולם אינה כלל-מערכתית**. מה שלקוח אחד
// קונה אינו ראיה למה שלקוח אחר מתכוון.
//
// ── למה מסמך אחד ללקוח ולא אוסף שורות ──
//
// אותו שיקול כמו ב-CustomerPriceList: הנפח חסום (לקוח טיפוסי — עשרות מק"טים,
// לקוח כבד — מאות), הקריאה בצינור הקליטה היא של כל השורות יחד, והדריסה חייבת
// להיות אטומית. יבוא שנכשל באמצע אצווה היה משאיר את הלקוח עם חצי היסטוריה,
// כלומר עם פרופיל שנראה תקין ומכריע לפי חלק מהנתונים.

const mongoose = require("mongoose");

// שורה אחת = מוצר אחד, מסוכם על פני כל המסמכים שבקובץ. הקובץ מגיע כשורות
// מסמך (אותו מק"ט חוזר ב-13 תעודות משלוח), והסיכום נעשה ביבוא: הצינור צריך
// "כמה פעמים ומתי לאחרונה", ולא את שורות המקור.
const PurchaseHistoryItemSchema = new mongoose.Schema(
  {
    // מזהה ההתאמה מול הקטלוג. טקסט ולא מספר בכוונה — קריאה כמספר הורסת אפסים
    // מובילים ("007" -> 7) ומק"טים שאינם מספריים.
    sku: { type: String, required: true },

    // המוצר בקטלוג, אם נמצא ביבוא. null = המק"ט אינו בקטלוג (עדיין).
    // השורה נשמרת גם אז: מוצר שייווצר מחר יימצא דרך המק"ט בלי יבוא חוזר.
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: false,
      default: null,
    },

    // השם כפי שהופיע בקובץ ההנהח"ש. אינו משמש להתאמה (ההתאמה לפי מק"ט בלבד)
    // אלא לתצוגה ולאימות: מק"ט ששמו בקובץ רחוק מהשם בקטלוג מסמן עמודה שהוזזה.
    name: { type: String, required: false },

    // כמה שורות מסמך נשאו את המק"ט הזה. זה מונה ה"כמה פעמים הלקוח הזמין",
    // והוא מה שמפריד בין מוצר שוטף לרכישה חד-פעמית.
    lines: { type: Number, default: 1 },
    totalQty: { type: Number, default: 0 },

    firstAt: { type: Date, required: false },
    // התאריך שדירוג הרלוונטיות נשען עליו (ראה utils/purchaseHistoryRanking)
    lastAt: { type: Date, required: false },

    // המחירים ששולמו בפועל. אינם מתמחרים דבר — התמחור עובר דרך
    // utils/customerPriceList ותו לא. הם נשמרים כי הם התשובה לשאלה "האם
    // המחיר בקטלוג בכלל קרוב למה שהלקוח משלם", ובלעדיהם היבוא זורק את המידע
    // היחיד על מחירים אמיתיים שיש בקובץ.
    lastPrice: { type: Number, required: false },
    minPrice: { type: Number, required: false },
    maxPrice: { type: Number, required: false },
  },
  { _id: false }
);

const customerPurchaseHistorySchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      unique: true,
    },

    // ‏select: false מאותה סיבה כמו במחירון: מסך רשימת הלקוחות שואל "יש
    // היסטוריה וכמה שורות", ואסור שהוא יגרור מאות שורות לכל לקוח. מי שצריך
    // את השורות מבקש אותן ב-select("+items").
    items: {
      type: [PurchaseHistoryItemSchema],
      default: [],
      select: false,
    },

    // נגזרים מ-items באותה כתיבה, כדי שאפשר יהיה להציג מצב בלי לטעון שורות
    itemsCount: { type: Number, default: 0 },
    // כמה מהם נמצאו בקטלוג. הפער בין השניים הוא מה שאומר כמה הפרופיל שווה:
    // שורה בלי מוצר אינה יכולה לשבור שוויון בין מועמדים.
    matchedInCatalog: { type: Number, default: 0 },

    // טווח התאריכים שהקובץ מכסה. מוצג למי שמעלה, כי היסטוריה בת חודש והיסטוריה
    // בת שנתיים הן שני דברים שונים לגמרי מבחינת מה שאפשר להסיק מהן.
    spanFrom: { type: Date, required: false },
    spanTo: { type: Date, required: false },

    // מספר הלקוח בהנהח"ש כפי שהופיע **בקובץ**, ולא כפי שהוא בכרטיס. זה מה
    // שמאפשר לזהות בדיעבד קובץ שהועלה ללקוח הלא נכון — הכשל הסביר ביותר
    // בהעלאה פר-לקוח, ושתיקה עליו מרעילה את ההזמנות של הלקוח בשקט.
    sourceCustomerNumber: { type: String, required: false },

    fileName: { type: String, required: false },
    importedBy: { type: String, required: false },
    importedAt: { type: Date, required: false },
  },
  { timestamps: true }
);

const CustomerPurchaseHistory = mongoose.model(
  "CustomerPurchaseHistory",
  customerPurchaseHistorySchema
);

module.exports = CustomerPurchaseHistory;

// models/IncomingOrder.js
//
// כל הודעה שנכנסת מהמייל או מווצאפ נרשמת כאן — גם אם הפכה להזמנה, גם אם נכשלה,
// וגם אם התברר שהיא בכלל לא הזמנה. זה גם יומן ביקורת (audit) וגם מנגנון מניעת
// כפילויות: externalId ייחודי לכל הודעה, כך שאותה הודעה לא תיצור שתי הזמנות.

const mongoose = require("mongoose");

// קודי הכשל המוכרים. מיוצאים כדי שהצינור יוכל לנרמל מולם כל שגיאה שנתפסת:
// שגיאת Mongo מגיעה עם code מספרי (11000) ושגיאת רשת עם code כמו "ETIMEDOUT",
// ובלי נרמול הם היו נכשלים בוולידציית ה-enum — כלומר רשומת הכשל *לא* הייתה
// נשמרת בכלל, וזו בדיוק הרשומה שאמורה למנוע אובדן הזמנה.
const INCOMING_ORDER_ERROR_CODES = [
  "llm_failed",           // ה-LLM לא החזיר תשובה תקינה
  "no_items",             // לא זוהו פריטים בהודעה
  "items_unmatched",      // פריטים שלא נמצאו בקטלוג
  "low_confidence",       // ביטחון נמוך מהסף
  "customer_unresolved",  // אין דרך לזהות/ליצור לקוח (חסר טלפון ומייל)
  "address_unresolved",   // משלוח מבוקש אבל אין עיר מוכרת ביעדי המשלוח
  "below_minimum",        // מתחת למינימום ההזמנה ליעד
  "out_of_stock",         // אין מלאי מספיק
  "order_create_failed",  // כשל טכני ביצירת ההזמנה (וגם ברירת המחדל לכל קוד לא מוכר)
  // ── הזמנה שיושבת מעבר לקישור (פלטפורמות כמו Zestt) ──
  "platform_login_required",     // הקישור נפתח אבל הדף דרש התחברות לפלטפורמה
  "link_unreadable",             // הקישור לא נפתח, נחסם, או שלא היה בו טקסט
  "platform_customer_unmapped",  // ההזמנה נקראה, אבל לא ידוע איזה לקוח שלנו זה
];

// פריט שזוהה בהודעה + מה הוא הותאם אליו בקטלוג
const matchedItemSchema = new mongoose.Schema(
  {
    // הטקסט המקורי כפי שהלקוח כתב ("2 קילו מג'הול גדול")
    rawName: { type: String, required: false },
    // הכמות שנקבעה בסוף (מה-LLM או מהטקסט)
    quantity: { type: Number, required: false, default: 1 },
    // הלקוח לא כתב כמות והונח 1. מוצג בדשבורד, כי זו הנחה של המערכת ולא
    // משהו שהלקוח ביקש — ומי שמאשר את ההזמנה צריך לדעת שזה מה שהונח.
    quantityAssumed: { type: Boolean, required: false, default: false },
    // יחידת מדידה שהלקוח ציין, אם ציין (ק"ג / שקית / מארז ...)
    unit: { type: String, required: false },
    // הערה לפריט ("בלי גרעינים", "טרי")
    note: { type: String, required: false },

    // המוצר שהותאם בקטלוג
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: false,
    },
    productTitle: { type: String, required: false }, // snapshot לתצוגה בדשבורד
    sku: { type: String, required: false },
    unitPrice: { type: Number, required: false },

    // ביטחון ההתאמה 0..1 ואיך הוכרעה
    confidence: { type: Number, required: false, default: 0 },
    matchScore: { type: Number, required: false },
    // 'catalog' = הוכרע ע"י מנוע ההתאמה, 'llm' = הוכרע ע"י ה-LLM מבין מועמדים
    decidedBy: { type: String, required: false },
    // המערכת בחרה את המוצר מבין כמה מועמדים כמעט זהים במקום להעביר את השורה
    // לאדם (ראה autoPick ב-resolvers). שדה נפרד ולא תת-מחרוזת של decidedBy:
    // זו הכרעה של המנוע שהמסך חייב לסמן, בדיוק כמו quantityAssumed, ומסך
    // שמחפש אותה בתוך מחרוזת חופשית נשבר בשקט ברגע שמנסחים אותה מחדש.
    autoPicked: { type: Boolean, required: false, default: false },

    // חלופות שנשקלו — קריטי לתחקור טעות זיהוי
    alternatives: { type: Array, required: false, default: [] },

    // סיבת כשל אם הפריט לא הותאם
    failReason: { type: String, required: false },
  },
  { _id: false }
);

const incomingOrderSchema = new mongoose.Schema(
  {
    // ── מקור ההודעה ──
    channel: {
      type: String,
      required: true,
      enum: ["email", "whatsapp", "manual"],
    },
    // מזהה ההודעה במקור (Gmail messageId / מזהה הודעת ווצאפ).
    // ייחודי — מונע יצירת אותה הזמנה פעמיים אם הסריקה רצה שוב.
    externalId: {
      type: String,
      required: true,
      unique: true,
    },
    sender: {
      name: { type: String, required: false },
      phone: { type: String, required: false },   // מנורמל ל-05XXXXXXXX
      email: { type: String, required: false, lowercase: true },
      raw: { type: String, required: false },     // "שם <mail@dom>" / JID של ווצאפ
    },
    subject: { type: String, required: false },   // מייל בלבד
    rawText: { type: String, required: true },    // גוף ההודעה כפי שהתקבל
    attachments: { type: Array, required: false, default: [] },
    receivedAt: { type: Date, required: false, default: Date.now },

    // ── צבירת הודעות המשך ──
    //
    // הודעות נוספות מאותו שולח מצטרפות לרשומה הזו במקום ליצור רשומה חדשה.
    // ‏rawText מחזיק את כולן משורשרות — זה מה שהפרסר קורא בסוף.
    messages: {
      type: [
        {
          externalId: { type: String },  // מזהה ההודעה במקור — מונע צירוף כפול
          text: { type: String },
          receivedAt: { type: Date },
          _id: false,
        },
      ],
      required: false,
      default: undefined,
    },
    // מתי מותר להתחיל לעבד. כל הודעה חדשה דוחה אותו קדימה, כלומר הספירה היא
    // של *שקט* מהשולח ולא של זמן מההודעה הראשונה.
    processAfter: { type: Date, required: false },
    lastMessageAt: { type: Date, required: false },

    // ── הזמנה שיושבת מעבר לקישור ──
    //
    // פלטפורמת הזמנות שולחת מייל בלי שורות הזמנה: כותרת, פרטי לקוח, וכפתור
    // "לצפייה בהזמנה". השורות נמצאות רק מעבר לכפתור, ולכן הצינור פותח את
    // הקישור בדפדפן שרץ בשרת ומוסיף את הטקסט שמצא ל-rawText.
    //
    // ‏links נשמר גם כשלא נפתח דבר — הוא מה שמאפשר למסך להציע "פתח בפלטפורמה"
    // ולמי שמאשר פלטפורמה לראות לאן הקישור מוביל לפני שהוא מאשר.
    links: {
      type: [
        {
          url: { type: String },
          host: { type: String },
          anchor: { type: String },   // טקסט הכפתור — "לצפייה בהזמנה"
          score: { type: Number },    // ניקוד הזיהוי, ראה lib/link-follower/extractLinks
          reason: { type: String },   // למה נבחר — לתחקור זיהוי שגוי
          _id: false,
        },
      ],
      required: false,
      default: undefined,
    },

    // תוצאת הפתיחה בפועל. נשמרת גם בכשל — היא ההסבר שהמסך מציג.
    linkFollow: {
      attempted: { type: Boolean, required: false },
      url: { type: String, required: false },
      host: { type: String, required: false },
      finalUrl: { type: String, required: false },  // אחרי הפניות
      title: { type: String, required: false },
      chars: { type: Number, required: false },     // כמה טקסט נקרא מהדף
      ok: { type: Boolean, required: false },
      code: { type: String, required: false },
      error: { type: String, required: false },
      loginRequired: { type: Boolean, required: false },
      blocked: { type: Boolean, required: false },
      followedAt: { type: Date, required: false },
      // צילום מסך מכווץ (data URI). לעיני אדם בלבד — הפרסר קורא טקסט.
      // **מוחרג במפורש משליפת הרשימה** בקונטרולר: 20 רשומות עם צילום כל אחת
      // הן תשובה של מגה-בייטים למסך שמציג שורות.
      screenshot: { type: String, required: false },
    },

    // הפלטפורמה שההודעה הגיעה ממנה, אם זוהתה
    platform: {
      ref: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "OrderPlatform",
        required: false,
      },
      key: { type: String, required: false },   // zestt.io
      name: { type: String, required: false },  // "Zestt"
      status: { type: String, required: false },
    },

    // ── תוצאת העיבוד ──
    status: {
      type: String,
      required: true,
      enum: [
        // ── ממתינה להודעות המשך (ווצאפ בלבד) ──
        //
        // לקוח בווצאפ מפצל הזמנה לכמה הודעות ("היי" / "3 מגבות נייר" / "מתקן
        // סבון"), וכל הודעה שנקראה בנפרד ייצרה הזמנה נפרדת. בסטטוס הזה ההודעות
        // נצברות לרשומה אחת, והעיבוד מתחיל רק אחרי חלון של שקט מהשולח.
        "collecting",
        "received",       // נקלטה, עוד לא עובדה
        "order_created",  // הפכה להזמנה בהצלחה
        "failed",         // העיבוד נכשל — דורש טיפול אנושי
        "not_an_order",   // ההודעה אינה הזמנה (שאלה, ספאם, תשובת סקר)
        "ignored",        // סומנה ידנית כלא רלוונטית
        // השולח אינו לקוח במערכת ולכן ההודעה לא נקראה כלל.
        // סטטוס נפרד ולא "ignored" בכוונה: ייתכן שזו הזמנה אמיתית מלקוח חדש,
        // ואסור שהיא תיבלע יחד עם מה שסומן ידנית כלא רלוונטי.
        "unknown_sender",
        // ── פלטפורמת הזמנות שטרם אושרה ──
        //
        // מייל שהגיע מ-no-reply@ של פלטפורמה, עם קישור להזמנה בגוף. זה אינו
        // "שולח לא מוכר": שם הפעולה הנכונה היא "צור לקוח מהשולח הזה", וכאן
        // היא הייתה יוצרת כרטיס לקוח בשם הפלטפורמה ומצמידה אליו את ההזמנות
        // של כל המסעדות. הפעולה הנכונה כאן היא "אשר את הפלטפורמה" — פעם אחת
        // לפלטפורמה, ולא פעם אחת לכל לקוח.
        "platform_pending",
      ],
      default: "received",
    },

    // הפלט הגולמי של ה-LLM — נשמר כמו שהוא לצורך תחקור וכיול הפרומפט
    parsed: { type: Object, required: false },

    // הפריטים שזוהו + ההתאמה שלהם לקטלוג
    matchedItems: { type: [matchedItemSchema], required: false, default: [] },

    // מה נפתר בפועל: לקוח, כתובת, סוג משלוח
    resolved: {
      customer: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Customer",
        required: false,
      },
      customerWasCreated: { type: Boolean, required: false, default: false },
      shippingOption: { type: String, required: false }, // "1" איסוף / "2" משלוח
      city: { type: String, required: false },
      deliveryPrice: { type: Number, required: false },
    },

    // ביטחון כולל: המינימום מבין ביטחון הפריטים (החוליה החלשה קובעת)
    confidence: { type: Number, required: false, default: 0 },

    // ההזמנה שנוצרה, אם נוצרה
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: false,
    },
    invoice: { type: Number, required: false }, // snapshot לחיפוש נוח

    // ── טיפול בכשלים ──
    error: { type: String, required: false },
    // קוד כשל מכני לסינון בדשבורד
    errorCode: {
      type: String,
      required: false,
      enum: [...INCOMING_ORDER_ERROR_CODES, null],
      default: null,
    },
    attempts: { type: Number, required: false, default: 0 },
    // יומן שלבי העיבוד — מאפשר לראות בדיוק איפה נעצר
    logs: {
      type: [
        {
          at: { type: Date, default: Date.now },
          step: { type: String },
          message: { type: String },
          _id: false,
        },
      ],
      required: false,
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

// חיפושים נפוצים בדשבורד: לפי סטטוס+תאריך, ולפי ערוץ
incomingOrderSchema.index({ status: 1, createdAt: -1 });
incomingOrderSchema.index({ channel: 1, createdAt: -1 });
incomingOrderSchema.index({ "sender.phone": 1 });
// שליפת הרשומות שחלון השקט שלהן נגמר — רצה כל דקה, חייבת להיות זולה
incomingOrderSchema.index({ status: 1, processAfter: 1 });
// מניעת צירוף כפול של אותה הודעה לרשומה פתוחה
incomingOrderSchema.index({ "messages.externalId": 1 });

// ── מניעת הזמנה כפולה מאותו קישור ──
//
// ‏externalId מגן מפני עיבוד כפול של אותה **הודעה**, אבל פלטפורמה שולחת
// לפעמים שתי הודעות על אותה הזמנה (התראה + תזכורת), וכל אחת היא הודעה
// אחרת עם אותו קישור בדיוק. בלי הבדיקה הזו התוצאה היא שתי הזמנות זהות
// במערכת — כלומר סחורה שנשלחת פעמיים. חלקי: רק לרשומות שבהן נפתח קישור.
incomingOrderSchema.index(
  { "linkFollow.url": 1, status: 1 },
  { partialFilterExpression: { "linkFollow.url": { $exists: true } } }
);

// ── רשומת צבירה אחת בלבד לכל מספר ──
//
// ה-webhook עונה מיד וממשיך לעבד ברקע, ולכן שתי הודעות שנשלחו ברצף מעובדות
// במקביל. בלי האינדקס הזה שתיהן מצאו "אין רשומה פתוחה" ויצרו אחת כל אחת —
// כלומר בדיוק הפיצול לשתי הזמנות שהצבירה נועדה למנוע. נמדד: 5 הודעות
// במקביל ייצרו 3 רשומות.
//
// המסנן החלקי הוא מה שמאפשר את זה: הייחודיות חלה **רק** על רשומות שממתינות,
// ולכן לאותו מספר יכולות להיות אינספור רשומות שכבר עובדו, כמו תמיד.
//
// המפתח הוא (טלפון, סטטוס) ולא טלפון בלבד, כי על "sender.phone" לבדו כבר יש
// אינדקס — ומונגו דוחה שני אינדקסים באותו מפתח (IndexKeySpecsConflict).
// אותו אינדקס משרת גם את שאילתת הצירוף, שמחפשת בדיוק לפי שני השדות האלה.
incomingOrderSchema.index(
  { "sender.phone": 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "collecting" } }
);

const IncomingOrder = mongoose.model("IncomingOrder", incomingOrderSchema);

module.exports = IncomingOrder;
module.exports.INCOMING_ORDER_ERROR_CODES = INCOMING_ORDER_ERROR_CODES;

// models/OrderPlatform.js
//
// פלטפורמת הזמנות ששולחת לנו מייל עם קישור במקום הזמנה בגוף ההודעה.
//
// ── למה צריך רשומה כזו בכלל ──
//
// אי אפשר לדעת מראש דרך איזו פלטפורמה לקוח יזמין. לכן המערכת לא מחזיקה
// רשימה שמישהו צריך למלא — היא **רושמת בעצמה** כל שולח חדש שנראה כמו
// פלטפורמת הזמנות, ומציגה אותו במסך. מרגע שהוא אושר פעם אחת, כל ההזמנות
// דרכו נקראות לבד.
//
// ── מה מזהה פלטפורמה ──
//
// המפתח הוא **דומיין השולח** (zestt.io), ולא הדומיין שהקישור מוביל אליו
// (app.zester.co.il). הסיבה: בשלב שבו צריך להחליט אם לקרוא את ההודעה בכלל,
// הדבר היחיד שידוע הוא ממי היא הגיעה. הדומיינים שהקישורים מובילים אליהם
// נאספים לתוך linkHosts, כי אליהם מוצמד הסשן.
//
// ── מיפוי הלקוחות ──
//
// במייל של פלטפורמה השולח הוא no-reply@, ולא הלקוח. הלקוח מזוהה מתוך גוף
// ההודעה — "ROOMS בסר פתח תקווה (633) מס' 77521-942". המיפוי הזה נעשה פעם
// אחת לכל לקוח בפלטפורמה, ונשמר כאן: מספר הלקוח *אצלם* ← כרטיס הלקוח *אצלנו*.

const mongoose = require("mongoose");

// סיומות שאינן דומיין רשום בפני עצמן. בלעדיהן "zestt.co.il" היה מקוצר
// ל-"co.il" — כלומר אישור של פלטפורמה אחת היה פותח את כל הדומיינים
// הישראליים. זו לא אופטימיזציה, זו גדר.
const MULTI_LABEL_SUFFIXES = new Set([
  "co.il", "org.il", "net.il", "ac.il", "gov.il", "muni.il", "k12.il", "idf.il",
  "co.uk", "org.uk", "com.au", "co.nz", "com.br",
]);

/**
 * דומיין השולח כמפתח פלטפורמה.
 *
 * ‏orders@mail.zestt.io ו-no-reply@zestt.io הם אותה פלטפורמה, ולכן המפתח
 * הוא הדומיין הרשום ולא ה-host המלא. אחרת כל תת-דומיין חדש שלהם היה מופיע
 * כפלטפורמה חדשה שדורשת אישור מחדש.
 */
const platformKeyOf = (emailOrHost) => {
  if (!emailOrHost) return null;
  const raw = String(emailOrHost).toLowerCase().trim();
  const host = raw.includes("@") ? raw.slice(raw.lastIndexOf("@") + 1) : raw;
  const labels = host.replace(/^\[|\]$/g, "").split(".").filter(Boolean);
  if (labels.length < 2) return null;

  const lastTwo = labels.slice(-2).join(".");
  const take = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join(".") || null;
};

// מיפוי לקוח: המזהה שלו בפלטפורמה ← הכרטיס אצלנו
const customerMapSchema = new mongoose.Schema(
  {
    // כל המזהים שראינו לאותו לקוח: מספר ספק, מספר סניף, שם עסק מנורמל.
    // מערך ולא שדה אחד, כי אותה מסעדה מופיעה במיילים שונים פעם במספר
    // ופעם בשם, ואנחנו רוצים להתאים לפי מה שיש בהודעה שהגיעה.
    keys: { type: [String], required: true, default: [] },
    // השם כפי שהוא מופיע אצלם — לתצוגה במסך המיפוי
    externalName: { type: String, required: false },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    mappedAt: { type: Date, default: Date.now },
    mappedBy: { type: String, required: false },
    orderCount: { type: Number, default: 0 },
  },
  { _id: false }
);

const orderPlatformSchema = new mongoose.Schema(
  {
    // דומיין השולח — zestt.io
    key: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // שם לתצוגה. נלקח מכותרת הדף או משם השולח, וניתן לעריכה.
    name: { type: String, required: false },

    // הדומיינים שהקישורים הובילו אליהם — app.zester.co.il.
    // אליהם מוצמד הסשן, ורק אליהם.
    linkHosts: { type: [String], required: false, default: [] },

    // ── מצב ──
    //
    // pending  — נראתה, טרם אושרה. הודעות ממנה **אינן** נקראות והקישור
    //            **אינו** נפתח. זו ברירת המחדל, בכוונה: פתיחת קישור ממייל
    //            שאיש לא אימת היא פעולה של השרת שלנו בשם שולח לא מזוהה.
    // approved — אושרה. הודעות ממנה נקראות והקישור נפתח.
    // blocked  — נדחתה במפורש. לא תופיע יותר במסך "פלטפורמות חדשות".
    status: {
      type: String,
      required: true,
      enum: ["pending", "approved", "blocked"],
      default: "pending",
    },

    // האם הדף שלה דרש התחברות בפועל. נקבע מהניסיון ולא מהצהרה.
    requiresLogin: { type: Boolean, default: false },

    // ── סשן ──
    //
    // הפלטפורמה דורשת התחברות אחת, לא אחת לכל לקוח. מה שנשמר כאן זה מה
    // שמאפשר לדפדפן שלנו להיות "מחובר" בפתיחה הבאה.
    //
    // אזהרה מודעת: קוקיז וטוקנים כאן הם מפתחות לחשבון אצלם, בטקסט גלוי
    // במסד — באותה החלטה שנעשתה על plainPassword בכרטיס הלקוח. מי שיש לו
    // גישה למסד יש לו גם את הסשן.
    session: {
      cookies: { type: Array, required: false, default: [] },
      localStorage: { type: Object, required: false },
      origin: { type: String, required: false },
      savedAt: { type: Date, required: false },
      savedBy: { type: String, required: false },
      // מתי הסשן נמצא לא תקף בפעם האחרונה — לתצוגה "צריך להתחבר מחדש"
      expiredAt: { type: Date, required: false },
    },

    // ── פרטי התחברות לפלטפורמה ──
    //
    // נשמרים כדי שסשן שפג יתחדש **לבד**. בלעדיהם כל פקיעה של סשן — וסשן פג
    // כל כמה ימים — הייתה עוצרת את קליטת ההזמנות עד שאדם מבחין ומתחבר שוב.
    //
    // הסיסמה נשמרת בטקסט גלוי, באותה החלטה מודעת שנעשתה על plainPassword
    // בכרטיס הלקוח: אין דרך "להצפין" סוד שהשרת עצמו חייב לקרוא כדי להשתמש
    // בו, והצפנה עם מפתח שיושב באותו שרת היא הצפנה למראית עין. השדה אופציונלי
    // — מי שמעדיף להתחבר ידנית פעם בכמה ימים פשוט לא ממלא אותו.
    login: {
      url: { type: String, required: false },        // דף ההתחברות
      username: { type: String, required: false },
      password: { type: String, required: false },
      // שדות טופס, למקרה שהזיהוי האוטומטי לא מצא אותם. ברוב הפלטפורמות
      // אין צורך: דף התחברות רגיל הוא שדה מייל, שדה סיסמה וכפתור.
      usernameSelector: { type: String, required: false },
      passwordSelector: { type: String, required: false },
      submitSelector: { type: String, required: false },
      lastLoginAt: { type: Date, required: false },
      lastLoginError: { type: String, required: false },
    },

    // מזהה הלקוח אצלם ← כרטיס הלקוח אצלנו
    customerMap: { type: [customerMapSchema], required: false, default: [] },

    // ── מונים ──
    // הם התשובה ל"מי בכלל שולח לי ככה" בלי שאיש יצטרך לנחש.
    stats: {
      seen: { type: Number, default: 0 },          // מיילים שהגיעו ממנה
      followed: { type: Number, default: 0 },      // קישורים שנפתחו בהצלחה
      ordersRead: { type: Number, default: 0 },    // הזמנות שנקראו במלואן
      failed: { type: Number, default: 0 },
      firstSeenAt: { type: Date, required: false },
      lastSeenAt: { type: Date, required: false },
      lastError: { type: String, required: false },
      lastErrorAt: { type: Date, required: false },
    },

    // קישור לדוגמה מההודעה האחרונה — כדי שמי שמאשר יראה לאן זה מוביל
    lastLinkSample: { type: String, required: false },
    lastSubjectSample: { type: String, required: false },
    approvedAt: { type: Date, required: false },
    approvedBy: { type: String, required: false },
    notes: { type: String, required: false },
  },
  { timestamps: true }
);

// שליפת "מה ממתין לאישור" למסך — השאילתה הנפוצה היחידה מלבד לפי key
orderPlatformSchema.index({ status: 1, "stats.lastSeenAt": -1 });
// התאמת קישור לפלטפורמה שהסשן שלה שמור
orderPlatformSchema.index({ linkHosts: 1 });

const OrderPlatform = mongoose.model("OrderPlatform", orderPlatformSchema);

module.exports = OrderPlatform;
module.exports.platformKeyOf = platformKeyOf;

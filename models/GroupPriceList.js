// models/GroupPriceList.js
//
// מחירון קבוצתי: מחירון אחד (מק"ט → מחיר) שמשויכים אליו כמה לקוחות.
//
// ── מה הוא עושה למחיר ──
//
// מחירון קבוצתי **גובר על המחירון הפרטי של הלקוח**: מק"ט שמופיע בו נמכר לכל
// חברי הקבוצה במחיר שכתוב בו, גם אם במחירון הפרטי של הלקוח כתוב מחיר אחר.
// מק"ט שאינו במחירון הקבוצתי ממשיך כרגיל — מחירון פרטי אם יש, ואחריו הקטלוג.
// הכלל עצמו ממומש במקום אחד: utils/customerPriceList.js.
//
// ── למה השיוך יושב כאן ולא בכרטיס הלקוח ──
//
// מסמך הלקוח נכתב מכמה מסלולים (עריכה, יבוא אקסל, הרשמה בחנות), ושדה שיוך
// בתוכו היה נדרס או נשכח באחד מהם. כאן השיוך נכתב ממסלול אחד בלבד, ומחיקת
// קבוצה אינה משאירה לקוחות שמצביעים על מחירון שכבר לא קיים.
//
// לקוח שייך לקבוצה אחת לכל היותר — אחרת שני מחירונים קבוצתיים היו מתחרים על
// אותו מק"ט בלי כלל שמכריע ביניהם. האכיפה בקונטרולר: שיוך לקבוצה מסיר את
// הלקוח מכל קבוצה אחרת.

const mongoose = require("mongoose");

const PriceListItemSchema = new mongoose.Schema(
  {
    // טקסט ולא מספר — אותו שיקול כמו במחירון הפרטי (אפסים מובילים)
    sku: { type: String, required: true },
    price: { type: Number, required: true },
    // שם המוצר מהקובץ. לאימות ולתצוגה בלבד, ההתאמה לפי מק"ט
    name: { type: String, required: false },
  },
  { _id: false }
);

const groupPriceListSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },

    customers: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Customer" }],
      default: [],
      // כל תמחור שואל "לאיזו קבוצה הלקוח שייך"
      index: true,
    },

    // ‏select: false — אותו שיקול כמו ב-CustomerPriceList: רשימת הקבוצות
    // צריכה רק "כמה שורות", לא את השורות
    items: {
      type: [PriceListItemSchema],
      default: [],
      select: false,
    },

    itemsCount: { type: Number, default: 0 },

    fileName: { type: String, required: false },
    importedBy: { type: String, required: false },
    importedAt: { type: Date, required: false },
  },
  {
    timestamps: true,
  }
);

const GroupPriceList = mongoose.model("GroupPriceList", groupPriceListSchema);

module.exports = GroupPriceList;

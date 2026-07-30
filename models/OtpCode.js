// models/OtpCode.js
const mongoose = require("mongoose");

// קוד אימות חד-פעמי לכניסה בטלפון.
// נשמר לפי מספר קנוני (05XXXXXXXX), ונמחק אוטומטית בתפוגה (TTL index).
const otpCodeSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      unique: true, // מסמך אחד לכל מספר — מונע מרוץ בין שתי בקשות קוד במקביל
    },
    code: {
      type: String,
      required: true,
    },
    attempts: {
      type: Number,
      default: 0, // כמה ניסיונות אימות שגויים בוצעו
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    // מתי נשלח הקוד בפועל. לא נסמכים על updatedAt לחישוב ההמתנה בין שליחות,
    // כי כל ניסיון אימות שגוי שומר את המסמך ומקדם אותו - וכך טעות הקלדה אחת
    // (או ניסיון זדוני) הייתה מאריכה את ההמתנה של הלקוח בעוד דקה
    sentAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

// מחיקה אוטומטית של המסמך כאשר expiresAt עובר (MongoDB TTL)
otpCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const OtpCode = mongoose.model("OtpCode", otpCodeSchema);

module.exports = OtpCode;

// utils/phone.js — נרמול מספרי טלפון ישראליים לצורך התחברות ב-SMS

// מחזיר את המספר בפורמט מקומי קנוני: 05XXXXXXXX (10 ספרות)
// מקבל כל צורה: 0521234567 / 521234567 / 972521234567 / +972-52-123-4567
function canonicalPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^0-9]/g, ""); // רק ספרות
  const last9 = digits.slice(-9);                      // 9 הספרות האחרונות (בלי אפס/972)
  if (last9.length !== 9) return null;                 // מספר לא תקין
  return "0" + last9;                                  // 05XXXXXXXX
}

// בדיקת תקינות בסיסית של נייד ישראלי (מתחיל ב-05 ואורך 10)
function isValidIsraeliMobile(phone) {
  const c = canonicalPhone(phone);
  return !!c && /^05\d{8}$/.test(c);
}

// כל הווריאציות האפשריות של המספר — לחיפוש לקוח קיים שנשמר בפורמט אחר
function phoneVariations(phone) {
  const digits = String(phone || "").replace(/[^0-9]/g, "");
  const last9 = digits.slice(-9);
  if (last9.length !== 9) return digits ? [digits] : [];
  return [
    "0" + last9,     // 05XXXXXXXX
    "972" + last9,   // 972XXXXXXXXX
    "+972" + last9,  // +972XXXXXXXXX
    last9,           // XXXXXXXXX
    digits,          // כפי שהוקלד
  ];
}

module.exports = {
  canonicalPhone,
  isValidIsraeliMobile,
  phoneVariations,
};

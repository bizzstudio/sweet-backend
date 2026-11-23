// utils/phone.js — נרמול מספרי טלפון ישראליים (כניסה ב-SMS, זיהוי שולח בקליטת הזמנות)

// הספרות של המספר בלי קידומת המדינה ובלי האפס המוביל.
//
// נייד ומספרי 07X הם 9 ספרות. קו נייח (02/03/04/08/09) הוא 8 ספרות בלבד —
// ולקחת ממנו "9 הספרות האחרונות" גוררת את האפס פנימה: 039114190 הפך
// ל-0039114190. כך לקוח שמזמין בווצאפ ממספר נייח לא נמצא לפי הטלפון שבכרטיס
// שלו, ונפתח לו כרטיס כפול (פתאל/ROOMS, 22/11/2026).
function nationalDigits(phone) {
  const digits = String(phone || "").replace(/[^0-9]/g, "");
  if (!digits) return null;

  let rest = digits.replace(/^00/, "");
  if (rest.startsWith("972")) rest = rest.slice(3);
  rest = rest.replace(/^0+/, "");
  if (rest.length === 8 && /^[23489]/.test(rest)) return rest; // קו נייח

  const last9 = digits.slice(-9);
  return last9.length === 9 ? last9 : null;
}

// מחזיר את המספר בפורמט מקומי קנוני: 05XXXXXXXX (נייד) או 0XXXXXXXX (נייח)
// מקבל כל צורה: 0521234567 / 521234567 / 972521234567 / +972-52-123-4567 / 03-9114190
function canonicalPhone(phone) {
  const national = nationalDigits(phone);
  return national ? "0" + national : null;
}

// בדיקת תקינות בסיסית של נייד ישראלי (מתחיל ב-05 ואורך 10)
function isValidIsraeliMobile(phone) {
  const c = canonicalPhone(phone);
  return !!c && /^05\d{8}$/.test(c);
}

// כל הווריאציות האפשריות של המספר — לחיפוש לקוח קיים שנשמר בפורמט אחר.
// פורמט שלא מופיע כאן (רווחים, סוגריים) נמצא בחיפוש הגמיש של findCustomersByPhone.
function phoneVariations(phone) {
  const digits = String(phone || "").replace(/[^0-9]/g, "");
  const national = nationalDigits(phone);
  if (!national) return digits ? [digits] : [];

  const variations = [
    "0" + national,    // 05XXXXXXXX / 0XXXXXXXX
    "972" + national,  // 972XXXXXXXXX
    "+972" + national, // +972XXXXXXXXX
    national,          // בלי אפס
    digits,            // כפי שהוקלד
  ];
  if (national.length === 8) {
    variations.push(
      "0" + national[0] + "-" + national.slice(1), // 03-9114190
      "00" + national // הצורה השגויה שהנרמול הישן שמר לקו נייח
    );
  } else {
    variations.push("0" + national.slice(0, 2) + "-" + national.slice(2)); // 052-1234567
  }
  return [...new Set(variations)];
}

// ביטוי שמוצא את הספרות של המספר גם כשהוקלדו עם מקפים, רווחים או סוגריים.
// התוצאות חייבות אימות נוסף מול canonicalPhone — הביטוי מעוגן לסוף בלבד.
function looseDigitsRegex(phone) {
  const national = nationalDigits(phone);
  if (!national) return null;
  return new RegExp(national.split("").join("\\D*") + "\\D*$");
}

module.exports = {
  canonicalPhone,
  isValidIsraeliMobile,
  phoneVariations,
  looseDigitsRegex,
};

// הוספת עברית לתוויות האזור האישי בהגדרות החנות.
//
// כל 170 שדות הטקסט ב-storeCustomizationSetting הגיעו מהתבנית המקורית עם
// אנגלית וגרמנית בלבד. showingTranslateValue מחפש את המפתח "he" ובהיעדרו
// נופל ל-"en" — ולכן האזור האישי הוצג באנגלית.
//
// הסקריפט מוסיף "he" לשדות שהאזור האישי משתמש בהם בפועל, ואינו נוגע ב-en/de
// ולא בשדות של עמודי החנות (שממילא חסומים כרגע).
require("dotenv").config();
const { connectDB } = require("../config/db");
const Setting = require("../models/Setting");

// תוויות הכרטיסים נשמרות קצרות כדי שיישבו בשורה אחת בכרטיס הצר
const HEBREW = {
  dashboard: {
    dashboard_title: "האזור האישי",
    total_order: "סה״כ הזמנות",
    pending_order: "ממתינות",
    processing_order: "בטיפול",
    complete_order: "הושלמו",
    recent_order: "הזמנות אחרונות",
    my_order: "ההזמנות שלי",
    update_profile: "עדכון פרטים",
    change_password: "שינוי סיסמה",
    full_name: "שם פרטי",
    // שדה שלא היה קיים כלל בתבנית. נוצר עם en כדי שיישאר עקבי עם שאר
    // השדות (הפאנל מציג ועורך לפי שפה)
    last_name: { he: "שם משפחה", en: "Last Name" },
    address: "כתובת",
    user_phone: "טלפון",
    user_email: "כתובת אימייל",
    update_button: "שמירת השינויים",
    current_password: "סיסמה נוכחית",
    new_password: "סיסמה חדשה",
    print_button: "הדפסת חשבונית",
    download_button: "הורדת חשבונית",
    invoice_message_first: "תודה רבה",
    invoice_message_last: "ההזמנה שלך התקבלה!",
  },
  navbar: {
    logout: "התנתקות",
  },
  checkout: {
    discount: "הנחה",
  },
};

(async () => {
  await connectDB();

  const doc = await Setting.findOne({ name: "storeCustomizationSetting" });
  if (!doc) {
    console.log("לא נמצא מסמך storeCustomizationSetting - לא בוצע שינוי");
    process.exit(1);
  }

  let added = 0;
  let replaced = 0;

  for (const [section, labels] of Object.entries(HEBREW)) {
    if (!doc.setting[section]) doc.setting[section] = {};

    for (const [key, value] of Object.entries(labels)) {
      // ערך יכול להיות מחרוזת עברית, או אובייקט מלא לשדה שנוצר מאפס
      const isObject = typeof value === "object";
      const he = isObject ? value.he : value;
      const current = doc.setting[section][key];

      // שדה שאינו אובייקט תרגום (או שאינו קיים) נוצר מחדש
      if (!current || typeof current !== "object") {
        doc.setting[section][key] = isObject ? { ...value } : { he };
        added += 1;
        console.log(`+ ${section}.${key} = ${he}   (שדה חדש)`);
        continue;
      }

      // שדה קיים שחסרות בו שפות שהוגדרו כאן (למשל en לשדה שנוצר קודם)
      if (isObject) {
        for (const [lng, text] of Object.entries(value)) {
          if (lng !== "he" && !current[lng]) current[lng] = text;
        }
      }

      if (current.he === he) continue;

      const before = current.he;
      current.he = he;
      if (before) {
        replaced += 1;
        console.log(`~ ${section}.${key}: ${before} -> ${he}`);
      } else {
        added += 1;
        console.log(`+ ${section}.${key} = ${he}   (היה: ${current.en})`);
      }
    }
  }

  // setting הוא שדה Mixed - בלי markModified מונגוס לא מזהה שינוי מקונן
  doc.markModified("setting");
  await doc.save();

  console.log(`\nנוספו ${added} תרגומים, הוחלפו ${replaced}.`);
  process.exit(0);
})();

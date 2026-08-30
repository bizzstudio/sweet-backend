// scripts/set-business-phone.js
//
// קביעת מספר הטלפון והווטסאפ של העסק בכל המקומות שבהם הוא מוצג.
//
// המספר יושב בכמה מקומות שונים, וחלקם נשארו מהתבנית שממנה הפרויקט שוכפל
// (מספרים בכווית ובסינגפור). מי שמעדכן רק אחד מהם מגלה את השאר חודשים
// אחרי, מלקוח שהתקשר למספר שגוי:
//
//   globalSetting.contact              — הכותרת של כל תעודת משלוח, הצעת
//                                        מחיר וריכוז תעודות שאנחנו מדפיסים
//   navbar.phone / navbar.phone_number — שורת הקשר בראש החנות
//   footer.bottom_contact              — פוטר החנות
//   footer.block4_phone                — פוטר החנות
//   contact_us.call_box_phone          — עמוד "צור קשר"
//
// navbar.phone_number נכתב לצד navbar.phone בכוונה: החנות קוראת את
// phone_number (layout/navbar/NavBarTop.js) ואילו במסד היה שמור phone —
// ולכן המספר פשוט לא הופיע שם כלל.
//
//   node scripts/set-business-phone.js 050-4447055           תצוגה בלבד
//   node scripts/set-business-phone.js 050-4447055 --apply   כתיבה
//
// ⚠️ הווטסאפ בחזית החנות אינו כאן: הוא משתנה סביבה בזמן בנייה
//    (NEXT_PUBLIC_CUSTOMER_SERVICE ב-sweet-store/.env.production), ודורש
//    בנייה מחדש של החנות.
//
// ⚠️ scripts/sync-company-details.js מושך את globalSetting.contact מכרטיס
//    החברה ב-iCount. אם המספר שם עדיין הישן, הרצה שלו תחזיר אותו — יש
//    לעדכן גם את הכרטיס ב-iCount.

require("dotenv").config();
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");
// argv.slice(2) ולא חיפוש בכל argv: argv[0] הוא הנתיב ל-node, ובהתקנת
// nvm הוא מכיל ספרות (‏.../v24.18.1/bin/node) ונתפס כמספר טלפון
const raw = process.argv.slice(2).find((a) => !a.startsWith("-") && /\d/.test(a));

if (!raw) {
  console.error('שימוש: node scripts/set-business-phone.js 050-4447055 [--apply]');
  process.exit(1);
}

/** ספרות בלבד, לבדיקות תקינות. */
const digits = String(raw).replace(/\D/g, "");

if (digits.length < 9 || digits.length > 10) {
  console.error(`"${raw}" אינו נראה כמספר טלפון ישראלי (${digits.length} ספרות)`);
  process.exit(1);
}

// הצורה שמוצגת: כפי שהוקלד, כדי שהמספר על המסמך ייראה כמו שהלקוחה כתבה אותו
const display = String(raw).trim();

// הצורה הבינלאומית לקישורי wa.me — 972 במקום ה-0 המוביל
const international = `972${digits.replace(/^0/, "")}`;

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const settings = mongoose.connection.db.collection("settings");

  const global = await settings.findOne({ name: "globalSetting" });
  const store = await settings.findOne({ name: "storeCustomizationSetting" });

  if (!global) {
    console.error("לא נמצאו הגדרות globalSetting במסד");
    process.exit(1);
  }

  const globalChanges = {};
  const storeChanges = {};
  const rows = [];

  const plan = (label, currentValue, path, target, bag) => {
    const before = String(currentValue ?? "").trim();
    rows.push([label, before || "(ריק)", target]);
    if (before !== target) bag[path] = target;
  };

  plan("מסמכים (contact)", global.setting?.contact, "setting.contact", display, globalChanges);

  if (store) {
    const s = store.setting || {};
    plan("ראש החנות", s.navbar?.phone, "setting.navbar.phone", display, storeChanges);
    plan(
      "ראש החנות (השדה שנקרא בפועל)",
      s.navbar?.phone_number,
      "setting.navbar.phone_number",
      display,
      storeChanges
    );
    plan("פוטר", s.footer?.bottom_contact, "setting.footer.bottom_contact", display, storeChanges);
    plan("פוטר (בלוק)", s.footer?.block4_phone, "setting.footer.block4_phone", display, storeChanges);
    plan(
      "צור קשר (עברית)",
      s.contact_us?.call_box_phone?.he,
      "setting.contact_us.call_box_phone.he",
      display,
      storeChanges
    );
    plan(
      "צור קשר (אנגלית)",
      s.contact_us?.call_box_phone?.en,
      "setting.contact_us.call_box_phone.en",
      display,
      storeChanges
    );
  }

  console.log(`\nמספר חדש: ${display}   (לווטסאפ: ${international})\n`);
  console.log("מקום".padEnd(32), "| נוכחי".padEnd(26), "| חדש");
  console.log("─".repeat(84));
  for (const [label, before, after] of rows) {
    const mark = before === after ? "=" : "→";
    console.log(label.padEnd(32), "|", before.padEnd(24), mark, after);
  }

  const total = Object.keys(globalChanges).length + Object.keys(storeChanges).length;

  if (!total) {
    console.log("\nאין מה לעדכן — כל המקומות כבר נושאים את המספר הזה.");
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    console.log(`\n${total} שדות ישתנו. להרצה אמיתית: --apply`);
    await mongoose.disconnect();
    return;
  }

  if (Object.keys(globalChanges).length) {
    await settings.updateOne({ name: "globalSetting" }, { $set: globalChanges });
  }
  if (Object.keys(storeChanges).length) {
    await settings.updateOne({ name: "storeCustomizationSetting" }, { $set: storeChanges });
  }

  console.log(`\n✅ ${total} שדות עודכנו.`);
  console.log(
    "\nנשאר לעשות ידנית:\n" +
      `  1. sweet-store/.env.production → NEXT_PUBLIC_CUSTOMER_SERVICE=${international}\n` +
      "     ואז בנייה מחדש של החנות (המשתנה נצרב בזמן הבנייה).\n" +
      "  2. כרטיס החברה ב-iCount — אחרת sync-company-details.js יחזיר את המספר הישן.\n" +
      "  3. באדמין: רענון עם ניקוי מטמון (Ctrl+Shift+R) — ההגדרות נשמרות במטמון בדפדפן."
  );

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

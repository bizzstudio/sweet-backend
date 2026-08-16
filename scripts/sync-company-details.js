// scripts/sync-company-details.js
//
// מילוי פרטי החברה בהגדרות המערכת מתוך כרטיס החברה ב-iCount.
//
// למה זה נחוץ: תעודת משלוח והצעת מחיר מודפסות אצלנו, והכותרת שלהן נבנית
// מ-globalSetting. השדות vat_number ו-address היו ריקים, כלומר המסמכים
// יצאו בלי ח.פ וכתובת — פרטים שחייבים להופיע על מסמך שיוצא ללקוח.
//
// iCount הוא מקור האמת לפרטים האלה: הם הוזנו שם לצורך דיווח לרשויות
// ולכן הם הנוסח הרשמי.
//
//   node scripts/sync-company-details.js           תצוגה בלבד
//   node scripts/sync-company-details.js --apply   כתיבה
//
// ⚠️ shop_name אינו נגזר מכאן בכוונה. הוא שם המותג שמוצג בחנות
//    ("המתוקים של בני"), והשם המשפטי שונה ממנו ("המתוקיה של בני בע"מ").
//    company_name הוא זה שמופיע על מסמכים, ולכן רק הוא מתעדכן.

require("dotenv").config();
const mongoose = require("mongoose");
const { call } = require("../lib/icount/client");

const APPLY = process.argv.includes("--apply");

const clean = (v) => String(v ?? "").trim();

(async () => {
  const res = await call("company/info");
  const info = res.company_info || res.info || res;

  const street = clean(info.addressStreet_he || info.addressStreet);
  const num = clean(info.addressNum);
  const city = clean(info.addressCity_he || info.addressCity);
  // מיקוד "0" ב-iCount משמעותו "לא הוזן", ואסור שיודפס כ-0 על מסמך
  const zip = clean(info.addressZip) === "0" ? "" : clean(info.addressZip);

  const address = [[street, num].filter(Boolean).join(" "), city, zip]
    .filter(Boolean)
    .join(", ");

  const updates = {
    company_name: clean(info.businessName_he || info.businessName),
    vat_number: clean(info.vat_id),
    address,
    contact: clean(info.mobile || info.phone),
    email: clean(info.email),
  };

  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const settings = mongoose.connection.db.collection("settings");
  const current = await settings.findOne({ name: "globalSetting" });

  if (!current) {
    console.error("לא נמצאו הגדרות globalSetting במסד");
    process.exit(1);
  }

  console.log("שדה".padEnd(16), "| נוכחי".padEnd(28), "| חדש");
  console.log("─".repeat(80));

  const changes = {};
  for (const [key, value] of Object.entries(updates)) {
    const before = clean(current.setting?.[key]);
    // לא דורסים ערך קיים בערך ריק מ-iCount
    if (!value) continue;
    if (before === value) continue;

    changes[`setting.${key}`] = value;
    console.log(
      key.padEnd(16),
      "|",
      (before || "(ריק)").padEnd(26),
      "|",
      value
    );
  }

  if (!Object.keys(changes).length) {
    console.log("\nאין מה לעדכן — ההגדרות כבר תואמות ל-iCount");
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    console.log(`\n${Object.keys(changes).length} שדות ישתנו. להרצה אמיתית: --apply`);
    await mongoose.disconnect();
    return;
  }

  await settings.updateOne({ name: "globalSetting" }, { $set: changes });
  console.log(`\n✅ ${Object.keys(changes).length} שדות עודכנו.`);
  console.log(
    "   שימי לב: ההגדרות נשמרות במטמון בדפדפן. כדי לראות את השינוי באדמין\n" +
      "   יש לרענן עם ניקוי מטמון (Ctrl+Shift+R)."
  );

  await mongoose.disconnect();
})().catch((err) => {
  console.error("שגיאה:", err.message);
  process.exit(1);
});

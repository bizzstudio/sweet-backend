// עדכון נכסי המותג בהגדרות החנות.
//
// שלושת הערכים האלה נשארו מהתבנית המקורית שממנה שוכפל הפרויקט והצביעו על
// קבצים של חנות אחרת ב-cloudinary (הלוגו שם לבן וחסר מידות, ולכן לא נראה
// בכלל על רקע בהיר). הערכים החדשים הם קבצי המותג שכבר יושבים ב-public/logo
// ותואמים לברירות המחדל שמוגדרות ב-sweet-store/src/utils/storeCustomizationSetting.js
require("dotenv").config();
const { connectDB } = require("../config/db");
const Setting = require("../models/Setting");

const UPDATES = [
  { path: ["navbar", "logo"], value: "/logo/logo-mark.png" },
  { path: ["footer", "block4_logo"], value: "/logo/logo-mark.png" },
  { path: ["seo", "favicon"], value: "/logo/logo-square.png" },
];

(async () => {
  await connectDB();

  const doc = await Setting.findOne({ name: "storeCustomizationSetting" });
  if (!doc) {
    console.log("לא נמצא מסמך storeCustomizationSetting - לא בוצע שינוי");
    process.exit(1);
  }

  for (const { path, value } of UPDATES) {
    const [group, key] = path;
    if (!doc.setting[group]) doc.setting[group] = {};
    console.log(
      `${group}.${key}:\n  לפני: ${doc.setting[group][key]}\n  אחרי: ${value}`
    );
    doc.setting[group][key] = value;
  }

  // setting הוא שדה Mixed - בלי markModified מונגוס לא מזהה שינוי מקונן
  doc.markModified("setting");
  await doc.save();

  console.log("\nההגדרות עודכנו.");
  process.exit(0);
})();

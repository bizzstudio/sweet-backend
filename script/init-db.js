// script/init-db.js
// אתחול מסד נתונים חדש ונקי לפרויקט "המתוקים של בני".
//
// הסקריפט מתחבר למסד שמוגדר ב-MONGO_URI + MONGO_DB_NAME, מוודא שהוא ריק,
// יוצר את כל האינדקסים לפי המודלים, ומזריע רק את המינימום ההכרחי כדי
// שהאדמין והחנות יעלו: הגדרות, מטבע, שפה ומשתמש אדמין אחד.
//
// שימוש:
//   npm run db:init                 -- אתחול מסד חדש (נכשל אם יש בו נתונים)
//   npm run db:init -- --force      -- מאתחל גם אם יש נתונים (לא מוחק, רק מוסיף/מעדכן)
//   npm run db:init -- --reset      -- מוחק את כל הקולקציות במסד היעד ואז מאתחל
//
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const RESET = args.includes("--reset");

const MONGO_URI = process.env.MONGO_URI;

// שם המסד יכול להגיע מ-MONGO_DB_NAME או מהנתיב שבתוך ה-URI (MONGO_DB_NAME גובר).
const dbNameFromUri = (uri) => {
  if (!uri) return undefined;
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
};

const MONGO_DB_NAME = process.env.MONGO_DB_NAME || dbNameFromUri(MONGO_URI);

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@sweets.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "12345678";
const ADMIN_NAME = process.env.ADMIN_NAME || "מנהל ראשי";
const SHOP_NAME = process.env.SHOP_NAME || "המתוקים של בני";

// טוען את כל המודלים כדי שכל הסכמות והאינדקסים יירשמו במונגוס
const loadModels = () => {
  const modelsDir = path.join(__dirname, "..", "models");
  fs.readdirSync(modelsDir)
    .filter((f) => f.endsWith(".js"))
    .forEach((f) => require(path.join(modelsDir, f)));
};

const globalSetting = {
  name: "globalSetting",
  setting: {
    number_of_image_per_product: "5",
    shop_name: SHOP_NAME,
    address: "",
    company_name: SHOP_NAME,
    vat_number: "",
    post_code: "",
    contact: "",
    email: ADMIN_EMAIL,
    website: "",
    default_currency: "₪",
    default_time_zone: "Asia/Jerusalem",
    default_date_format: "DD/MM/YYYY",
    receipt_size: "80-mm",
  },
};

const currencies = [
  { name: "Shekel", symbol: "₪", status: "show" },
  { name: "Dollar", symbol: "$", status: "hide" },
];

const languages = [
  { name: "Hebrew", iso_code: "he", flag: "IL", status: "show" },
  { name: "English", iso_code: "en", flag: "US", status: "hide" },
];

// הסטטוסים שהקוד מחפש לפי שם (orderController) — בלעדיהם זרימת ההזמנות לא עובדת
const statuses = [
  { name: "Pending", heName: "ממתין", color: "#f59e0b" },
  { name: "Processing", heName: "בטיפול", color: "#3b82f6" },
  { name: "Likut", heName: "ליקוט", color: "#8b5cf6" },
  { name: "Delivered", heName: "נמסרה", color: "#10b981" },
  { name: "Cancel", heName: "בוטלה", color: "#ef4444" },
];

const run = async () => {
  if (!MONGO_URI) {
    console.error("שגיאה: MONGO_URI לא מוגדר ב-.env");
    process.exit(1);
  }
  if (!MONGO_DB_NAME) {
    console.error(
      "שגיאה: לא נמצא שם מסד נתונים — הוסף MONGO_DB_NAME ל-.env או שם מסד בנתיב של MONGO_URI, למשל: MONGO_DB_NAME=sweets_benny"
    );
    process.exit(1);
  }

  loadModels();

  await mongoose.connect(MONGO_URI, { dbName: MONGO_DB_NAME });
  const db = mongoose.connection;
  console.log(`מחובר ל-${db.host} | מסד נתונים: ${db.name}`);

  // בדיקת בטיחות: לא דורסים מסד קיים בטעות
  const existing = await db.db.listCollections().toArray();
  const nonEmpty = [];
  for (const c of existing) {
    const count = await db.collection(c.name).countDocuments();
    if (count > 0) nonEmpty.push(`${c.name} (${count})`);
  }

  if (nonEmpty.length) {
    if (RESET) {
      console.log(`מוחק ${existing.length} קולקציות מ-${db.name}...`);
      for (const c of existing) await db.collection(c.name).drop();
    } else if (!FORCE) {
      console.error(
        `\nעצירה: המסד "${db.name}" כבר מכיל נתונים:\n  ${nonEmpty.join(
          "\n  "
        )}\n\nזה כנראה לא מסד חדש. אפשרויות:\n  • שנה את MONGO_DB_NAME ל-שם שלא קיים\n  • הרץ עם --reset כדי למחוק את התוכן שלו\n  • הרץ עם --force כדי להמשיך בלי למחוק`
      );
      await mongoose.disconnect();
      process.exit(1);
    }
  }

  // יצירת כל האינדקסים לפי המודלים
  const modelNames = mongoose.modelNames();
  for (const name of modelNames) {
    await mongoose.model(name).syncIndexes();
  }
  console.log(`נוצרו אינדקסים עבור ${modelNames.length} מודלים`);

  const Setting = mongoose.model("Setting");
  const Currency = mongoose.model("Currency");
  const Language = mongoose.model("Language");
  const Admin = mongoose.model("Admin");

  // הגדרות: globalSetting חדש, ו-storeCustomizationSetting/storeSetting
  // מבוססים על ברירות המחדל של התבנית (החנות לא עולה בלעדיהם).
  const templateSettings = require("../utils/settings");
  const storeSettings = templateSettings.filter((s) => s.name !== "globalSetting");

  for (const doc of [globalSetting, ...storeSettings]) {
    await Setting.updateOne(
      { name: doc.name },
      { $setOnInsert: doc },
      { upsert: true }
    );
  }
  console.log(`הגדרות: ${1 + storeSettings.length} מסמכים`);

  for (const c of currencies) {
    await Currency.updateOne({ name: c.name }, { $setOnInsert: c }, { upsert: true });
  }
  console.log(`מטבעות: ${currencies.length}`);

  for (const l of languages) {
    await Language.updateOne({ iso_code: l.iso_code }, { $setOnInsert: l }, { upsert: true });
  }
  console.log(`שפות: ${languages.length}`);

  const Status = mongoose.model("Status");
  for (const s of statuses) {
    await Status.updateOne(
      { name: s.name },
      { $setOnInsert: { ...s, phone: "", isActive: true } },
      { upsert: true }
    );
  }

  // "שגיאה בקריאה" — הזמנות שנקלטו מהמייל/ווצאפ ולא נקראו במלואן.
  // נזרע בנפרד ובמכוון *בלי* השדה phone: הדשבורד מזהה מלקטים ב-
  // `Status.find({ phone: { $exists: true } })`, וחמשת הסטטוסים למעלה נזרעים
  // עם phone:"" ולכן נכללים בסכימת ההכנסות. סטטוס בלי השדה נשאר מחוץ לחישוב,
  // וזה נדרש כי לסכום של הזמנה שבורה אין מה לחפש בדוחות.
  // (ראה utils/ingestionStatus.js — שם אותה רשומה נוצרת גם בזמן ריצה)
  await Status.updateOne(
    { name: "IngestionError" },
    {
      $setOnInsert: {
        name: "IngestionError",
        heName: "שגיאה בקריאה",
        color: "#dc2626",
        isActive: true,
      },
    },
    { upsert: true }
  );
  console.log(`סטטוסים: ${statuses.length + 1}`);

  const adminExists = await Admin.findOne({ email: ADMIN_EMAIL.toLowerCase() });
  if (adminExists) {
    console.log(`אדמין קיים כבר: ${ADMIN_EMAIL} (לא שונה)`);
  } else {
    await Admin.create({
      name: { he: ADMIN_NAME, en: ADMIN_NAME },
      email: ADMIN_EMAIL.toLowerCase(),
      password: bcrypt.hashSync(ADMIN_PASSWORD),
      role: "Super Admin",
      status: "Active",
      joiningData: new Date(),
    });
    console.log(`נוצר אדמין: ${ADMIN_EMAIL}`);
    if (!process.env.ADMIN_PASSWORD) {
      console.log("שים לב: נעשה שימוש בסיסמת ברירת מחדל 12345678 — החלף אותה מיד.");
    }
  }

  console.log(`\nהמסד "${db.name}" מוכן.`);
  await mongoose.disconnect();
  process.exit(0);
};

run().catch(async (err) => {
  console.error("אתחול המסד נכשל:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

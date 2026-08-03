// script/create-admin.js
// יצירת משתמש אדמין במסד הנתונים הפעיל (לפי MONGO_URI / MONGO_DB_NAME).
//
// שימוש:
//   node script/create-admin.js --email=you@example.com --password=סיסמה --name="שם" [--role="Super Admin"]
//   npm run admin:create -- --email=... --password=...
//
// אם המשתמש כבר קיים — הסיסמה, השם והתפקיד שלו יעודכנו.
//
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const Admin = require("../models/Admin");

const arg = (key) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${key}=`));
  return hit ? hit.slice(key.length + 3) : undefined;
};

const email = (arg("email") || process.env.ADMIN_EMAIL || "").toLowerCase().trim();
const password = arg("password") || process.env.ADMIN_PASSWORD;
const name = arg("name") || process.env.ADMIN_NAME || email.split("@")[0];
const role = arg("role") || "Super Admin";

const run = async () => {
  if (!email || !password) {
    console.error("שימוש: node script/create-admin.js --email=... --password=... [--name=...] [--role=...]");
    process.exit(1);
  }

  await mongoose.connect(
    process.env.MONGO_URI,
    process.env.MONGO_DB_NAME ? { dbName: process.env.MONGO_DB_NAME } : {}
  );
  console.log(`מחובר למסד: ${mongoose.connection.name}`);

  const existing = await Admin.findOne({ email });
  const doc = {
    name: { he: name, en: name },
    email,
    password: bcrypt.hashSync(password),
    role,
    status: "Active",
  };

  if (existing) {
    await Admin.updateOne({ _id: existing._id }, { $set: doc });
    console.log(`עודכן אדמין קיים: ${email} (${role})`);
  } else {
    await Admin.create({ ...doc, joiningData: new Date() });
    console.log(`נוצר אדמין: ${email} (${role})`);
  }

  await mongoose.disconnect();
  process.exit(0);
};

run().catch(async (err) => {
  console.error("יצירת האדמין נכשלה:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

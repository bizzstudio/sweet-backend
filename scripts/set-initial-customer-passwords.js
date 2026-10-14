// scripts/set-initial-customer-passwords.js
//
// נותן סיסמה ראשונית לכל לקוח שאין לו סיסמה, ומפיק אקסל עם שם, מייל, טלפון
// וסיסמה לכל הלקוחות (גם למי שכבר הייתה לו סיסמה — עם הסיסמה הקיימת).
//
// לקוח שכבר יש לו סיסמה לא נדרס. הסיסמה נשמרת גם מוצפנת וגם כטקסט גלוי
// (plainPassword), בדיוק כמו setCustomerPassword() ב-customerController.
//
// ההתחברות לחנות היא לפי customer.email, ולכן לקוחות מיבוא ההנהח"ש מתחברים
// עם הכתובת הפנימית ‎<...>@import.local — היא מופיעה בעמודת "מייל להתחברות".
//
// הרצה:  node scripts/set-initial-customer-passwords.js [--dry] [--out file.xlsx]
require("dotenv").config();
const crypto = require("crypto");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const XLSX = require("xlsx");

const DRY = process.argv.includes("--dry");
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx > -1 ? process.argv[outIdx + 1] : "customer-passwords.xlsx";

// בלי תווים שמתבלבלים בהקלדה (0/O, 1/l/I)
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const generatePassword = (length = 8) =>
  Array.from({ length }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const Customers = mongoose.connection.collection("customers");

  const customers = await Customers.find(
    {},
    {
      projection: {
        name: 1, lastName: 1, email: 1, contactEmail: 1, phone: 1, erp: 1,
        password: 1, plainPassword: 1,
      },
    }
  ).sort({ name: 1 }).toArray();

  const rows = [];
  const updates = [];
  for (const c of customers) {
    let password = c.plainPassword;
    // סיסמה שנקבעה לפני שנוסף plainPassword קיימת רק מוצפנת - אין מה להציג
    let status = c.plainPassword ? "סיסמה קיימת" : "סיסמה קיימת (לא ידועה)";
    if (!c.password) {
      password = generatePassword();
      status = "סיסמה חדשה";
      updates.push({
        updateOne: {
          // התנאי על password מונע דריסה אם הלקוח קבע סיסמה בזמן הריצה
          filter: { _id: c._id, password: { $in: [null, ""] } },
          update: { $set: { password: bcrypt.hashSync(password), plainPassword: password } },
        },
      });
    }
    const internalEmail = /@import\.local$/i.test(c.email || "");
    rows.push({
      "מספר לקוח": c.erp?.customerNumber || "",
      "שם לקוח": [c.name, c.lastName].filter(Boolean).join(" "),
      "מייל להתחברות": c.email || "",
      "מייל ליצירת קשר": c.contactEmail || (internalEmail ? "" : c.email || ""),
      "טלפון": c.phone || c.erp?.mobile || c.erp?.landline || "",
      "סיסמה": password || "",
      "סטטוס": status,
    });
  }

  console.log(`לקוחות: ${customers.length}, סיסמאות חדשות: ${updates.length}`);

  if (!DRY && updates.length) {
    const res = await Customers.bulkWrite(updates, { ordered: false });
    console.log(`עודכנו: ${res.modifiedCount}`);
    if (res.modifiedCount !== updates.length) {
      console.warn("שים לב: חלק מהלקוחות לא עודכנו (כנראה קבעו סיסמה בזמן הריצה)");
    }
  }

  const sheet = XLSX.utils.json_to_sheet(rows);
  sheet["!cols"] = [10, 32, 32, 32, 14, 12, 12].map((wch) => ({ wch }));
  sheet["!views"] = [{ RTL: true }];
  const book = XLSX.utils.book_new();
  book.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(book, sheet, "סיסמאות לקוחות");
  XLSX.writeFile(book, OUT);
  console.log(`${DRY ? "(הרצה יבשה) " : ""}נכתב: ${OUT}`);

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

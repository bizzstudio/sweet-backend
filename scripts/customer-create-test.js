// scripts/customer-create-test.js
//
// בדיקת "הוספת לקוח" מהפאנל (POST /customer/create → createCustomerByAdmin).
// אינה נוגעת במסד: הפעולות של Customer ו-Admin מוחלפות בזיכרון, ו-save רק
// מריץ את הולידציה של הסכימה ושומר את המסמך בצד לבדיקה.
//
// הרצה: node scripts/customer-create-test.js

const Customer = require("../models/Customer");
const Admin = require("../models/Admin");
const { createCustomerByAdmin } = require("../controller/customerController");

// מצב "המסד" לבדיקה הנוכחית
let existingNumbers = new Set();
let registeredPhones = new Set();
let staffRole = "Admin";
let duplicateKeyOnSave = false;
let saved = null;

Customer.exists = async (query) =>
  existingNumbers.has(query["erp.customerNumber"]) ? { _id: "x" } : null;
Customer.findOne = (query) => ({
  select: async () =>
    (query.phone?.$in || []).some((phone) => registeredPhones.has(phone))
      ? { _id: "other" }
      : null,
});
Customer.prototype.save = async function save() {
  const error = this.validateSync();
  if (error) throw error;
  if (duplicateKeyOnSave) throw Object.assign(new Error("E11000"), { code: 11000 });
  saved = this.toObject();
  return this;
};
Admin.findOne = () => ({
  select: () => ({
    lean: async () => (staffRole ? { role: staffRole, status: "Active" } : null),
  }),
});

const run = async (body) => {
  const out = {};
  const res = {
    status(code) {
      out.status = code;
      return this;
    },
    send(payload) {
      out.body = payload;
      return this;
    },
  };
  saved = null;
  await createCustomerByAdmin({ user: { email: "staff@test.local" }, body }, res);
  return out;
};

let passed = 0;
let failed = 0;
const check = (name, condition, hint = "") => {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${hint ? ` — ${hint}` : ""}`);
  }
};

const reset = () => {
  existingNumbers = new Set();
  registeredPhones = new Set();
  staffRole = "Admin";
  duplicateKeyOnSave = false;
};

(async () => {
  reset();

  // ── הרשאות ──
  staffRole = "Driver";
  let r = await run({ name: "x", customerNumber: "1" });
  check("נהג אינו רשאי להוסיף לקוח", r.status === 403 && !saved);
  staffRole = null;
  r = await run({ name: "x", customerNumber: "1" });
  check("משתמש שאינו בטבלת הצוות נדחה", r.status === 403 && !saved);
  reset();

  // ── שדות חובה וולידציה ──
  r = await run({ customerNumber: "1" });
  check("בלי שם — 400", r.status === 400 && !saved);
  r = await run({ name: "x", email: "a@b.co.il" });
  check("בלי מספר לקוח — 400, גם כשיש מייל", r.status === 400 && !saved);
  r = await run({ name: { $gt: "" }, customerNumber: "1" });
  check("שם שאינו מחרוזת נדחה ולא נשמר כ-[object Object]", r.status === 400 && !saved);
  r = await run({ name: "x", customerNumber: "1", email: "not-an-email" });
  check("מייל פגום נדחה", r.status === 400 && !saved);
  r = await run({ name: "x", customerNumber: "1", email: "erp-9@import.local" });
  check("מזהה פנימי אינו מתקבל כמייל ראשי", r.status === 400 && !saved);
  r = await run({ name: "x", customerNumber: "1", contactEmail: "bad" });
  check("מייל איש קשר פגום נדחה", r.status === 400 && !saved);
  r = await run({ name: "x", customerNumber: "1", password: "123" });
  check("סיסמה קצרה נדחית", r.status === 400 && !saved);

  // ── כפילויות ──
  existingNumbers.add("100");
  r = await run({ name: "x", customerNumber: " 100 " });
  check("מספר לקוח קיים (גם עם רווחים) נדחה ב-409", r.status === 409 && !saved);
  reset();

  registeredPhones.add("0501234567");
  r = await run({ name: "x", customerNumber: "2", phone: "050-1234567", password: "123456" });
  check("נייד של לקוח רשום חוסם לקוח עם סיסמה", r.status === 409 && !saved);
  r = await run({ name: "x", customerNumber: "2", phone: "050-1234567" });
  check("אותו נייד מותר ללקוח בלי סיסמה (לא נכנס ב-SMS)", r.status === 201);
  reset();

  duplicateKeyOnSave = true;
  r = await run({ name: "x", customerNumber: "3" });
  check(
    "התנגשות על המזהה הפנימי מוסברת כמספר לקוח ולא כמייל",
    r.status === 409 && r.body.message.includes("מספר לקוח 3")
  );
  r = await run({ name: "x", customerNumber: "3", email: "a@b.co.il" });
  check("התנגשות על מייל שהוקלד מוסברת כמייל", r.status === 409 && r.body.message.includes("האימייל"));
  reset();

  // ── יצירה תקינה ──
  r = await run({
    name: " מאפיית כהן ",
    customerNumber: 555,
    phone: "050-123-4567",
    address: "הרצל 5",
    city: "חיפה",
    contactPerson: "דנה",
    idNumber: "514000000",
  });
  check("יצירה תקינה מחזירה 201 ומזהה", r.status === 201 && !!r.body._id);
  check("השם נשמר מקוצץ", saved?.name === "מאפיית כהן");
  check("מספר לקוח מספרי נשמר כמחרוזת", saved?.erp?.customerNumber === "555");
  check("בלי מייל — מזהה פנימי כמו ביבוא", saved?.email === "erp-555@import.local");
  check("נייד מנורמל לכניסה ב-SMS", saved?.phone === "0501234567");
  check("הנייד הגולמי נשמר ב-erp", saved?.erp?.mobile === "050-123-4567");
  check("עיר וכתובת נשמרו", saved?.address?.city?.city_name_he === "חיפה" && saved?.address?.street === "הרצל 5");
  check("ח.פ ואיש קשר נשמרו ב-erp", saved?.erp?.idNumber === "514000000" && saved?.erp?.contactPerson === "דנה");
  check("הלקוח פעיל ואינו רשום לחנות", saved?.erp?.active === true && saved?.isRegistered === false);
  check("אין סיסמה כשלא הוזנה", !saved?.password && !saved?.plainPassword);
  check("לא נוצר contactEmail ריק", !("contactEmail" in (saved || {})));

  r = await run({
    name: "y",
    customerNumber: "6",
    email: "Office@Shop.co.il",
    contactEmail: "office@shop.co.il",
    password: "123456",
  });
  check("מייל ראשי נשמר באותיות קטנות", saved?.email === "office@shop.co.il");
  check("מייל איש קשר זהה לראשי אינו נשמר פעמיים", !saved?.contactEmail);
  check("סיסמה נשמרת מוצפנת וגלויה, והלקוח מסומן רשום",
    saved?.plainPassword === "123456" && saved?.password !== "123456" && saved?.isRegistered === true);

  r = await run({ name: "z", customerNumber: "7", isCashier: true, inBlackList: true, billing: { mode: "perDelivery" } });
  check("שדות שאינם בטופס (קופאי, חיוב) מתעלמים", saved?.isCashier === false && saved?.inBlackList === false && !saved?.billing?.mode);

  console.log(`\n${passed} עברו, ${failed} נכשלו`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

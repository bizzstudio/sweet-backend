// scripts/billing-email-audit.js
//
// מי יקבל את החשבונית שלו במייל ומי לא. קריאה בלבד — אינה משנה דבר ואינה
// פונה ל-iCount.
//
// המסמכים נשלחים לכתובת שרשומה בכרטיס הלקוח, ולכן לקוח בלי כתובת תקינה
// מקבל חשבונית שקיימת רק ב-iCount. הרשימה כאן היא מה שצריך לתקן.
//
// הרצה:  node scripts/billing-email-audit.js
//        node scripts/billing-email-audit.js --csv > emails.csv

require("dotenv").config();
const mongoose = require("mongoose");
const Customer = require("../models/Customer");
const { billingEmailOf, isDeliverableEmail } = require("../lib/icount/clients");

const asCsv = process.argv.includes("--csv");

const run = async () => {
  // אותו fallback כמו בשאר הסקריפטים — סביבה שמגדירה רק MONGODB_URI
  // הייתה נכשלת כאן בשגיאת חיבור סתומה
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const customers = await Customer.find({})
    .select("+erp name lastName email phone billing")
    .lean();

  const rows = customers.map((c) => {
    const email = billingEmailOf(c);
    return {
      number: c.erp?.customerNumber || "",
      name: [c.name, c.lastName].filter(Boolean).join(" ").trim(),
      email,
      phone: c.erp?.mobile || c.phone || "",
      ok: isDeliverableEmail(email),
      // כתובת שכבר סונכרנה ל-iCount ושונה ממה שאצלנו תתעדכן שם אוטומטית
      // בהפקה הבאה, אבל שווה לראות את הפער
      inIcount: c.billing?.icountSyncedEmail || "",
    };
  });

  const bad = rows.filter((r) => !r.ok);

  if (asCsv) {
    console.log("מספר לקוח,שם,מייל,טלפון,תקין");
    for (const r of rows) {
      console.log(`${r.number},"${r.name}","${r.email}","${r.phone}",${r.ok ? "כן" : "לא"}`);
    }
  } else {
    console.log(`\nסה"כ לקוחות: ${rows.length}`);
    console.log(`יקבלו חשבונית במייל: ${rows.length - bad.length}`);
    console.log(`לא יקבלו — צריך לתקן מייל: ${bad.length}\n`);

    if (bad.length) {
      console.log("─".repeat(78));
      for (const r of bad) {
        console.log(
          `${String(r.number).padEnd(8)} ${r.name.slice(0, 34).padEnd(35)} ` +
            `${(r.email || "— אין —").padEnd(28)} ${r.phone}`
        );
      }
      console.log("─".repeat(78));
      console.log("\nלייצוא לאקסל: node scripts/billing-email-audit.js --csv > emails.csv");
    }

    const drifted = rows.filter((r) => r.ok && r.inIcount && r.inIcount !== r.email);
    if (drifted.length) {
      console.log(
        `\n${drifted.length} לקוחות שהמייל אצלם שונה ממה שרשום ב-iCount — ` +
          `הכרטיס יתעדכן אוטומטית בהפקה הבאה.`
      );
    }
  }

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

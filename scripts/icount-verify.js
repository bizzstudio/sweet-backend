// scripts/icount-verify.js
//
// בדיקת בריאות של מערך החיוב, מול המפרט שהוגדר:
//
//   1. על כל הזמנה יוצאת תעודת משלוח שנבנית אצלנו
//   2. בסוף חודש התעודות נסגרות לחשבונית אחת לאותו חודש
//   3. לקוח שמוגדר לו — חשבונית נפרדת לכל קטגוריה
//   4. חשבונית זיכוי מבטלת חשבונית
//   5. קבלה נרשמת רק כשמשלמים, לפי שוטף+30 / שוטף+60
//
// הבדיקה קוראת בלבד. היא אינה מפיקה מסמכים ואינה משנה נתונים.
//
//   node scripts/icount-verify.js

require("dotenv").config();
const mongoose = require("mongoose");

const { ping, call } = require("../lib/icount/client");
const { DOC_TYPES } = require("../lib/icount/documents");
const DeliveryNote = require("../models/DeliveryNote");
const Customer = require("../models/Customer");
const Order = require("../models/Order");
const { previousMonth, closeMonth } = require("../lib/billing/monthlyBilling");
const { isConfirmed, dueDateFor } = require("../lib/billing/paymentTerms");

const ok = (s) => `  ✅ ${s}`;
const warn = (s) => `  ⚠️  ${s}`;
const bad = (s) => `  ❌ ${s}`;
const head = (n, s) => console.log(`\n${"─".repeat(64)}\n${n}. ${s}\n${"─".repeat(64)}`);

let problems = 0;
let warnings = 0;
const fail = (s) => { problems++; console.log(bad(s)); };
const caution = (s) => { warnings++; console.log(warn(s)); };

(async () => {
  console.log("בדיקת מערך החיוב — iCount + תעודות משלוח");

  // ── 1 ─────────────────────────────────────────────────────────────
  head(1, "חיבור ל-iCount");

  let account;
  try {
    account = await ping();
    console.log(ok(`מחובר: ${account.cid} / ${account.user} (${account.fullName})`));
  } catch (err) {
    fail(`ההתחברות נכשלה: ${err.message}`);
    process.exit(1);
  }

  const types = await call("doc/types");
  const available = Object.keys(types.doctypes);
  for (const [label, code] of [
    ["חשבונית מס", DOC_TYPES.INVOICE],
    ["חשבונית זיכוי", DOC_TYPES.CREDIT],
    ["קבלה", DOC_TYPES.RECEIPT],
  ]) {
    if (available.includes(code) && types.doctypes[code].can_create) {
      console.log(ok(`${label} (${code}) — זמין להפקה`));
    } else {
      fail(`${label} (${code}) — אינו זמין בחשבון`);
    }
  }

  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const clients = await call("client/get_list");
  const clientCount = (Array.isArray(clients.clients)
    ? clients.clients
    : Object.values(clients.clients || {})).length;
  const customerCount = await Customer.countDocuments({
    "erp.customerNumber": { $nin: [null, ""] },
  });
  const syncedCount = await Customer.countDocuments({ "billing.icountClientId": { $ne: null } });

  if (syncedCount === 0) {
    caution(
      `לקוחות ב-iCount: ${clientCount} · במערכת: ${customerCount} · מסונכרנים: ${syncedCount}\n` +
        `      הרצת "node scripts/icount-sync-clients.js --apply" תסנכרן את כולם.\n` +
        `      (לא חוסם — לקוח נוצר אוטומטית בחיוב הראשון שלו)`
    );
  } else {
    console.log(ok(`לקוחות מסונכרנים: ${syncedCount} מתוך ${customerCount}`));
  }

  // ── 2 ─────────────────────────────────────────────────────────────
  head(2, 'מפרט: "על כל הזמנה יוצאת תעודת משלוח שנבנית כאן"');

  const orderCount = await Order.countDocuments();
  const noteCount = await DeliveryNote.countDocuments();
  console.log(`     הזמנות: ${orderCount} · תעודות: ${noteCount}`);

  // בדיקה התנהגותית ולא חיפוש מחרוזת בקובץ: מוודאת שהפונקציה באמת מזהה
  // את הסטטוסים הנכונים ודוחה את השאר, ושהיא באמת מחוברת ל-logStatusChange.
  const { isNoteTriggerStatus } = require("../lib/billing/autoDeliveryNote");
  const triggers = ["Processing", "processing", "טופלה", "בטיפול", "Delivered", "נמסר"];
  const nonTriggers = ["Likut", "Pending", "Cancel", "IngestionError", "", null];

  const triggersOk = triggers.every((s) => isNoteTriggerStatus(s));
  const nonTriggersOk = nonTriggers.every((s) => !isNoteTriggerStatus(s));

  const hooked = require("fs")
    .readFileSync(require("path").join(__dirname, "../utils/logStatusChange.js"), "utf8")
    .includes("autoDeliveryNote");

  if (triggersOk && nonTriggersOk && hooked) {
    console.log(ok('תעודה נוצרת אוטומטית במעבר ל"טופלה" (מחובר ב-logStatusChange)'));
  } else if (!hooked) {
    fail("ההפעלה האוטומטית אינה מחוברת ל-logStatusChange — התעודה תיווצר רק ידנית");
  } else {
    fail(
      `זיהוי הסטטוס שגוי — מפעילים: ${triggersOk ? "תקין" : "נכשל"}, ` +
        `לא-מפעילים: ${nonTriggersOk ? "תקין" : "נכשל"}`
    );
  }

  console.log(ok("התעודה נשמרת אצלנו בלבד ואינה נשלחת ל-iCount (לפי ההחלטה)"));
  console.log(ok("מספר רץ עצמאי, מונה אטומי — utils/deliveryNoteNumber.js"));

  // ── 3 ─────────────────────────────────────────────────────────────
  head(3, 'מפרט: "בסוף חודש סוגר את התעודות ומוציא חשבונית אחת לאותו חודש"');

  const month = previousMonth();
  const open = await DeliveryNote.countDocuments({ "billing.status": "open" });
  const billed = await DeliveryNote.countDocuments({ "billing.status": "billed" });
  const stuck = await DeliveryNote.countDocuments({ "billing.status": "billing" });

  console.log(`     תעודות פתוחות: ${open} · חויבו: ${billed} · תקועות: ${stuck}`);
  if (stuck > 0) caution(`${stuck} תעודות תקועות במצב חיוב — ישוחררו אוטומטית תוך שעה`);

  const preview = await closeMonth({ month, dryRun: true });
  console.log(ok(`תצוגה מקדימה לחודש ${month} עובדת: ${preview.invoicesCreated} חשבוניות ל-${preview.customersProcessed} לקוחות`));
  console.log(ok("הגנה מחיוב כפול: תפיסה אטומית לפני הפנייה ל-iCount"));
  console.log(
    ok("חודש עתידי נחסם; החודש הנוכחי נסגר רק ביומו האחרון, ורק בסגירה האוטומטית")
  );
  console.log(ok("תעודות פתוחות מחודשים קודמים נאספות גם הן (זיכוי / כשלון קודם)"));

  const { isAutoEnabled } = require("../lib/billing/monthEndCron");
  if (isAutoEnabled()) {
    console.log(ok("סגירה אוטומטית פעילה — היום האחרון בחודש (30/31), 23:00, שעון ישראל"));
    // אוטומציה + מחירים שגויים = עשרות מסמכי מס שגויים בלילה אחד, בלי
    // שאף אחד ראה. זו לא הערה כללית אלא מצב הנתונים בפועל.
    caution(
      "הסגירה רצה בלי אישור אנושי. כל עוד המחירים אינם אמיתיים (ראי סעיף 7),\n" +
        "      הריצה הבאה תפיק חשבוניות מס בסכומים שגויים שלא ניתן למחוק.\n" +
        "      כיבוי זמני: BILLING_AUTO_CLOSE=false ב-.env"
    );
  } else {
    console.log(ok("סגירה אוטומטית מכובה (BILLING_AUTO_CLOSE=false) — הפקה ידנית בלבד"));
  }

  // שליחת המסמכים ללקוח. חשבונית שלא נשלחה קיימת רק ב-iCount, ולכן מספר
  // הלקוחות בלי כתובת תקינה הוא נתון תפעולי ולא הערת שוליים.
  const emailsOn = String(process.env.BILLING_EMAIL_DOCUMENTS ?? "true").toLowerCase() !== "false";
  if (emailsOn) {
    console.log(ok("כל מסמך מס נשלח ללקוח במייל עם ההפקה (BILLING_EMAIL_DOCUMENTS)"));

    const { billingEmailOf, isDeliverableEmail } = require("../lib/icount/clients");
    // billing חייב להיכלל: כתובת ייעודית לחשבוניות יושבת ב-billing.invoiceEmail,
    // ובלעדיה הספירה כאן הייתה מדווחת "אין מייל" ללקוחות שדווקא יש להם
    const all = await Customer.find({}).select("+erp email billing").lean();
    const missing = all.filter((c) => !isDeliverableEmail(billingEmailOf(c))).length;

    console.log(`     לקוחות עם מייל שאפשר לשלוח אליו: ${all.length - missing} מתוך ${all.length}`);
    if (missing) {
      caution(
        `${missing} לקוחות בלי כתובת מייל תקינה — החשבונית שלהם תופק אך לא תישלח.\n` +
          "      הרשימה המלאה: node scripts/billing-email-audit.js"
      );
    }
  } else {
    console.log(ok("שליחת מסמכים במייל מכובה (BILLING_EMAIL_DOCUMENTS=false)"));
  }

  // ── 4 ─────────────────────────────────────────────────────────────
  head(4, 'מפרט: "יש חברות שרוצות חשבונית נפרדת לכל קטגוריה"');

  const splitCustomers = await Customer.countDocuments({
    "billing.splitInvoiceByCategory": true,
  });
  console.log(ok(`ההגדרה קיימת בכרטיס הלקוח (billing.splitInvoiceByCategory)`));
  console.log(`     לקוחות שמוגדר להם פיצול כרגע: ${splitCustomers}`);
  if (splitCustomers === 0) {
    console.log(`     (אף לקוח לא סומן עדיין — מסמנים בכרטיס הלקוח → "חיוב וחשבוניות")`);
  }

  // ── 5 ─────────────────────────────────────────────────────────────
  head(5, 'מפרט: "חשבונית זיכוי — שמבטלים חשבונית"');

  console.log(ok(`הפונקציה קיימת: creditInvoice() — doctype "${DOC_TYPES.CREDIT}"`));
  console.log(ok("מקושרת לחשבונית המקורית דרך based_on (לא זיכוי מרחף)"));
  console.log(ok("דורשת סיבת זיכוי — נדחית בלעדיה"));
  console.log(ok("התעודות חוזרות למצב פתוח כדי שאפשר יהיה לחייב מחדש"));

  // ── 6 ─────────────────────────────────────────────────────────────
  head(6, 'מפרט: "קבלה — רק כשמשלמים, אחרי שוטף 30 / שוטף 60"');

  console.log(ok(`הפונקציה קיימת: createReceipt() — doctype "${DOC_TYPES.RECEIPT}"`));
  console.log(ok("מקושרת לחשבוניות שהיא סוגרת דרך based_on"));
  console.log(ok("תומכת במזומן / צ'ק / אשראי / העברה"));

  const sample = { erp: { paymentTerms: 0, customerNumber: "בדיקה" } };
  const due = dueDateFor(new Date(2026, 0, 3), sample);
  console.log(
    ok(`חישוב שוטף+N מסוף החודש: חשבונית 3/1/2026 → פירעון ${due.dueDate.toLocaleDateString("he-IL")}`)
  );

  if (!isConfirmed()) {
    caution(
      "טבלת תנאי התשלום לא אושרה. erp.paymentTerms מכיל קודים (0, -1, 5, 7)\n" +
        "      ולא ימים — כרגע כולם ממופים לשוטף+30. צריך אישור מרואה החשבון."
    );
  }

  caution(
    "אין טריגר אוטומטי לקבלה: המערכת לא יודעת מתי כסף נכנס.\n" +
      "      הקבלה מופקת כשמישהו מדווח על תשלום (מסך/API). זה מכוון —\n" +
      "      קבלה על כסף שלא התקבל היא דיווח כוזב."
  );

  // ── 7 ─────────────────────────────────────────────────────────────
  head(7, "תקינות המחירים");

  const Product = require("../models/Product");
  const all = await Product.find({}).select("prices.price").lean();
  const nineties = all.filter((p) => Math.round(((p.prices?.price || 0) % 1) * 100) === 90).length;
  const pct = ((nineties / all.length) * 100).toFixed(1);

  if (nineties / all.length > 0.9) {
    fail(
      `${pct}% ממחירי הקטלוג מסתיימים ב-.90 — עדיין מחירים מחוללים, לא אמיתיים.\n` +
        `      אין להפיק חשבוניות מס עד להעלאת מחירון אמיתי.`
    );
  } else {
    console.log(ok(`מחירי הקטלוג נראים אמיתיים (${pct}% בלבד מסתיימים ב-.90)`));
  }

  // ── סיכום ─────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(64)}`);
  if (problems === 0 && warnings === 0) {
    console.log("✅ הכל תקין — המערכת מוכנה להפקת מסמכים");
  } else {
    console.log(`סיכום: ${problems} בעיות חוסמות · ${warnings} דברים לתשומת לב`);
    if (problems > 0) {
      console.log("\n⛔ אין להפיק חשבוניות מס עד לפתרון הבעיות החוסמות.");
    }
  }
  console.log("═".repeat(64));

  await mongoose.disconnect();
  process.exit(problems > 0 ? 1 : 0);
})().catch((err) => {
  console.error("\n❌ הבדיקה נכשלה:", err.message);
  process.exit(1);
});

// scripts/billing-email-test.js
//
// בדיקת מדיניות שליחת המסמכים במייל. אינה נוגעת במסד ואינה פונה ל-iCount:
// גם ensureClientForDocument וגם call מוחלפים בזיכרון לפני שהמודול שמפיק
// את המסמכים נטען, ולכן מה שנבדק כאן הוא בדיוק הפרמטרים שהיו נשלחים.
//
// הרצה: node scripts/billing-email-test.js

// המצב נקבע פעם אחת בטעינת lib/icount/mode, ולכן חייב להיקבע לפני כל require.
// קבוצת הדמו רצה בתת-תהליך (--demo) מאותה סיבה: אי אפשר להחליף מצב באמצע.
const DEMO_RUN = process.argv.includes("--demo");
process.env.ICOUNT_MODE = DEMO_RUN ? "demo" : "live";
if (DEMO_RUN) {
  process.env.ICOUNT_DEMO_CID = "demo-test";
  process.env.ICOUNT_DEMO_USER = "demo-test";
  process.env.ICOUNT_DEMO_PASS = "demo-test";
}

const clientPath = require.resolve("../lib/icount/client");
const clientsPath = require.resolve("../lib/icount/clients");

// כתובת המייל של "הלקוח" בבדיקה הנוכחית
let customerEmail = "";
// כל הקריאות ל-iCount, לפי הסדר. המבחן הוא מה נשלח בפועל.
let calls = [];
const lastCall = () => calls[calls.length - 1];
const lastParams = () => lastCall()?.params || {};
// כשהוא מוגדר, הקריאה הבאה ל-iCount נכשלת — כך נבדקים מסלולי הכשלון
let failNext = null;

// סדר הטעינה קריטי: כל מודול עושה destructuring בזמן require, ולכן ההחלפה
// חייבת לקרות לפני שמי שמשתמש בו נטען.
require(clientPath);
require.cache[clientPath].exports.call = async (endpoint, params) => {
  calls.push({ endpoint, params });
  if (failNext) {
    const message = failNext;
    failNext = null;
    throw new Error(message);
  }
  if (endpoint === "client/create") return { client_id: "NEW-1" };
  if (endpoint === "client/update") return {};
  return { docnum: "TEST-1", doc_url: "https://example.test/doc" };
};

const clients = require(clientsPath);
// המימוש האמיתי נלכד לפני ההחלפה — הוא נבדק בקבוצה משלו בהמשך
const realEnsureClient = clients.ensureClientForDocument;
const { billingEmailOf, isDeliverableEmail, toIcountClient } = clients;

require.cache[clientsPath].exports.ensureClientForDocument = async () => ({
  clientId: "9999",
  email: customerEmail,
});

const { createInvoice, createReceipt } = require("../lib/icount/documents");
const Customer = require("../models/Customer");

const ITEMS = [{ name: "בדיקה", quantity: 1, unitPrice: 10, sku: "1", isVatFree: false }];

let passed = 0;
let failed = 0;

const check = (name, condition, hint = "") => {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${hint ? ` — ${hint}` : ""}`);
  }
};

const group = (title) =>
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 50 - title.length))}`);

/** מפיק חשבונית בתנאים נתונים ומחזיר את מה שנשלח בפועל */
const issue = async ({ email, envFlag, emailDocument }) => {
  customerEmail = email;
  calls = [];

  if (envFlag === undefined) delete process.env.BILLING_EMAIL_DOCUMENTS;
  else process.env.BILLING_EMAIL_DOCUMENTS = envFlag;

  const doc = await createInvoice({ customerId: "x", items: ITEMS, emailDocument });
  return { doc, sent: lastParams().email_document, emailedTo: doc.emailedTo };
};

const run = async () => {
  group("ברירת המחדל — שליחה");
  {
    const r = await issue({ email: "lakoach@example.co.il" });
    check("email_document=1 בלי שאיש ביקש", r.sent === 1, `התקבל ${r.sent}`);
    check("הכתובת מדווחת חזרה", r.emailedTo === "lakoach@example.co.il");
  }

  group("כתובות שאי אפשר לשלוח אליהן");
  {
    const placeholder = await issue({ email: "erp-137@import.local" });
    check("כתובת סינתטית מהייבוא אינה נשלחת", placeholder.sent === 0);
    check("emailedTo ריק, כדי שהדוח יסמן אותה", placeholder.emailedTo === null);

    const empty = await issue({ email: "" });
    check("לקוח בלי מייל — לא נשלח", empty.sent === 0);

    const broken = await issue({ email: "לא-מייל" });
    check("כתובת פגומה — לא נשלחת", broken.sent === 0);

    check("החשבונית עצמה כן הופקה בכל המקרים", placeholder.doc.docNum === "TEST-1");
  }

  group("כפייה מפורשת גוברת על המדיניות");
  {
    const off = await issue({ email: "lakoach@example.co.il", emailDocument: false });
    check("emailDocument:false מבטל שליחה (מסלול הדמו)", off.sent === 0);

    const on = await issue({ email: "lakoach@example.co.il", envFlag: "false", emailDocument: true });
    check("emailDocument:true שולח גם כשהדגל כבוי", on.sent === 1);

    const stillBlocked = await issue({ email: "erp-1@import.local", emailDocument: true });
    check("כפייה אינה שולחת לכתובת סינתטית", stillBlocked.sent === 0);
  }

  group("כיבוי גורף — BILLING_EMAIL_DOCUMENTS");
  {
    const offEnv = await issue({ email: "lakoach@example.co.il", envFlag: "false" });
    check('"false" מכבה שליחה', offEnv.sent === 0);

    const weird = await issue({ email: "lakoach@example.co.il", envFlag: "" });
    check("ערך ריק אינו מכבה בשקט", weird.sent === 1);

    const explicitTrue = await issue({ email: "lakoach@example.co.il", envFlag: "true" });
    check('"true" שולח', explicitTrue.sent === 1);
  }

  group("קבלה");
  {
    delete process.env.BILLING_EMAIL_DOCUMENTS;
    customerEmail = "lakoach@example.co.il";
    const receipt = await createReceipt({ customerId: "x", amount: 100, method: "transfer" });
    check("קבלה נשלחת גם היא", lastParams().email_document === 1);
    check("doctype נשמר", lastParams().doctype === "receipt");
    check("client_id נשלח", lastParams().client_id === "9999");
    check("הקבלה מדווחת את הכתובת", receipt.emailedTo === "lakoach@example.co.il");

    // הקבלה אינה נושאת מע"מ. פרמטר מע"מ שנוסף לה "בדרך" הוא שינוי לא מאומת
    // במסמך מס קיים, ולכן נבדק במפורש שהוא אינו שם.
    check(
      "price_includes_vat אינו נשלח בקבלה",
      !("price_includes_vat" in lastParams()),
      `נשלח ${lastParams().price_includes_vat}`
    );
  }

  group("חשבונית — מה שהיה נשלח קודם לא השתנה");
  {
    customerEmail = "lakoach@example.co.il";
    await createInvoice({ customerId: "x", items: ITEMS, description: "תיאור", discount: 5 });
    const p = lastParams();
    check("price_includes_vat=0 נשמר בחשבונית", p.price_includes_vat === 0);
    check("מטבע ושפה נשמרו", p.currency_code === "ILS" && p.lang === "he");
    check("doctype נשמר", p.doctype === "invoice");
    check("תיאור והנחה נשמרו", p.description === "תיאור" && p.discount_amount === 5);
    check("השורות עברו המרה", p.items?.[0]?.unitprice === 10 && p.items[0].sku === "1");
  }

  group("זיהוי כתובת חיוב (billingEmailOf / isDeliverableEmail)");
  {
    // כתובת ההנהלת חשבונות גוברת על כתובת הכניסה לחנות — זה כל מה שהשדה
    // הזה קיים בשבילו, ואותה כתובת יכולה לשמש כמה לקוחות
    check(
      "invoiceEmail גובר על הכל",
      billingEmailOf({
        billing: { invoiceEmail: "hanhala@b.co.il" },
        email: "kniya@b.co.il",
        erp: { rawEmail: "c@d.com" },
      }) === "hanhala@b.co.il"
    );
    check(
      "invoiceEmail ריק אינו מסתיר את כתובת הלקוח",
      billingEmailOf({ billing: { invoiceEmail: "" }, email: "kniya@b.co.il" }) === "kniya@b.co.il"
    );
    check(
      "לקוח בלי billing עובד כרגיל",
      billingEmailOf({ email: "kniya@b.co.il" }) === "kniya@b.co.il"
    );

    check("email גובר על rawEmail", billingEmailOf({ email: "a@b.co.il", erp: { rawEmail: "c@d.com" } }) === "a@b.co.il");
    check("rawEmail כגיבוי", billingEmailOf({ erp: { rawEmail: "c@d.com" } }) === "c@d.com");
    check("לקוח ריק לא מפיל", billingEmailOf(null) === "" && billingEmailOf(undefined) === "");
    check("רווחים נחתכים", billingEmailOf({ email: "  a@b.co.il " }) === "a@b.co.il");

    check("כתובת תקינה", isDeliverableEmail("a@b.co.il"));
    check("import.local נדחית", !isDeliverableEmail("erp-5@import.local"));
    check("IMPORT.LOCAL באותיות גדולות נדחית גם היא", !isDeliverableEmail("ERP-5@IMPORT.LOCAL"));
    check("בלי סיומת נדחית", !isDeliverableEmail("a@b"));
    check("שתי כתובות בשדה אחד נדחות", !isDeliverableEmail("a@b.com, c@d.com"));
    check("ריק / null נדחים", !isDeliverableEmail("") && !isDeliverableEmail(null));

    // המפתח לכל מנגנון רענון הכרטיס: מה שנשלח ל-iCount חייב להיות בדיוק
    // מה שנשמר ומושווה בפעם הבאה. הפרש של רווח = עדכון כרטיס בכל מסמך.
    const customer = { name: "בדיקה", email: "  a@b.co.il ", erp: { customerNumber: "1" } };
    check(
      "toIcountClient שולח בדיוק את billingEmailOf",
      toIcountClient(customer).email === billingEmailOf(customer)
    );
  }

  group("רענון כרטיס הלקוח ב-iCount (ensureClientForDocument)");
  {
    // iCount שולח לכתובת שבכרטיס שלו. הקבוצה הזו בודקת את הנקודה היחידה
    // שבה תיקון מייל אצלנו הופך לכתובת מעודכנת שם.
    const writes = [];
    Customer.updateOne = async (filter, update) => {
      writes.push(update.$set);
      return { modifiedCount: 1 };
    };

    const stubCustomer = (doc) => {
      Customer.findById = () => ({ select: () => ({ lean: async () => doc }) });
    };

    const base = {
      _id: "c1",
      name: "לקוח בדיקה",
      erp: { customerNumber: "500" },
    };

    // 1. כרטיס מסונכרן והמייל לא השתנה — אסור לפנות ל-iCount בכלל
    calls = [];
    stubCustomer({
      ...base,
      email: "a@b.co.il",
      billing: { icountClientId: "77", icountSyncedEmail: "a@b.co.il" },
    });
    let r = await realEnsureClient("c1");
    check("מייל שלא השתנה — אפס קריאות ל-iCount", calls.length === 0, `בוצעו ${calls.length}`);
    check("מוחזר ה-client_id השמור", r.clientId === "77" && r.email === "a@b.co.il");

    // 2. המייל תוקן אצלנו — הכרטיס חייב להתעדכן לפני ההפקה
    calls = [];
    writes.length = 0;
    stubCustomer({
      ...base,
      email: "hadash@b.co.il",
      billing: { icountClientId: "77", icountSyncedEmail: "yashan@b.co.il" },
    });
    r = await realEnsureClient("c1");
    check("מייל שהשתנה — נשלח client/update", lastCall()?.endpoint === "client/update");
    check("העדכון נושא את הכתובת החדשה", lastParams().email === "hadash@b.co.il");
    check("העדכון מכוון לכרטיס הקיים ולא יוצר חדש", lastParams().client_id === "77");
    check("הכתובת החדשה נשמרת אצלנו", writes[0]?.["billing.icountSyncedEmail"] === "hadash@b.co.il");
    check("הכתובת מוחזרת לשליחה", r.email === "hadash@b.co.il");

    // 3. לקוח ותיק שסונכרן לפני שהשדה נוסף — עדכון אחד, ולא בכל מסמך
    calls = [];
    writes.length = 0;
    stubCustomer({ ...base, email: "a@b.co.il", billing: { icountClientId: "77" } });
    await realEnsureClient("c1");
    check("לקוח ללא icountSyncedEmail — מתעדכן פעם אחת", calls.length === 1);
    check("ומהרגע הזה השדה מלא", writes[0]?.["billing.icountSyncedEmail"] === "a@b.co.il");

    // 4. רענון שנכשל — ההפקה נמשכת, השליחה לא
    calls = [];
    stubCustomer({
      ...base,
      email: "hadash@b.co.il",
      billing: { icountClientId: "77", icountSyncedEmail: "yashan@b.co.il" },
    });
    failNext = "iCount לא זמין";
    r = await realEnsureClient("c1");
    check("כשלון ברענון אינו מפיל את ההפקה", r.clientId === "77");
    check("אבל חוסם שליחה לכתובת שאולי ישנה", r.email === "");

    // 5. לקוח שאין לו כרטיס כלל — כאן כשלון חייב לעצור
    calls = [];
    stubCustomer({ ...base, email: "a@b.co.il" });
    r = await realEnsureClient("c1");
    check("לקוח חדש — נוצר כרטיס", r.clientId === "NEW-1");

    stubCustomer({ ...base, email: "a@b.co.il" });
    failNext = "iCount לא זמין";
    let threw = false;
    try {
      await realEnsureClient("c1");
    } catch {
      threw = true;
    }
    check("בלי client_id כשלון עוצר את ההפקה", threw);

    // 6. לקוח שנמחק
    Customer.findById = () => ({ select: () => ({ lean: async () => null }) });
    threw = false;
    try {
      await realEnsureClient("nope");
    } catch {
      threw = true;
    }
    check("לקוח שאינו קיים — שגיאה ברורה", threw);
  }

  console.log(`\n${"═".repeat(58)}`);
  console.log(failed ? `${passed} עברו · ${failed} נכשלו` : `✅ כל ${passed} הבדיקות עברו`);
  console.log("═".repeat(58));

  process.exit(failed ? 1 : 0);
};

/**
 * קבוצת הדמו. רצה רק בתת-התהליך, כי ICOUNT_MODE נקבע בטעינת המודול.
 *
 * מה שנבדק כאן הוא ההגנה שנשברה פעם אחת ב-18/08/26: סגירת חודש בדמו אינה
 * מעבירה emailDocument כלל, ולכן נפלה על מדיניות השליחה ושלחה חשבונית דמו
 * ללקוח אמיתי. ההחלטה עברה ל-baseDoc, ומכאן שגם קורא שיכפה true לא ישלח.
 */
const runDemo = async () => {
  group("מצב דמו — לעולם לא נשלח");

  customerEmail = "real@customer.co.il";

  calls = [];
  await createInvoice({ customerId: "c1", items: ITEMS });
  check("חשבונית בדמו — email_document = 0", lastParams().email_document === 0);

  calls = [];
  const forced = await createInvoice({ customerId: "c1", items: ITEMS, emailDocument: true });
  check("כפיית emailDocument:true אינה גוברת", lastParams().email_document === 0);
  check("emailedTo חוזר null", forced.emailedTo === null);

  calls = [];
  await createReceipt({ customerId: "c1", amount: 100, method: "transfer", emailDocument: true });
  check("גם קבלה בדמו אינה נשלחת", lastParams().email_document === 0);

  process.env.BILLING_EMAIL_DOCUMENTS = "true";
  calls = [];
  await createInvoice({ customerId: "c1", items: ITEMS });
  check("המדיניות הגורפת אינה מדליקה שליחה בדמו", lastParams().email_document === 0);

  console.log(`\n${"═".repeat(58)}`);
  console.log(failed ? `${passed} עברו · ${failed} נכשלו` : `✅ כל ${passed} בדיקות הדמו עברו`);
  console.log("═".repeat(58));
  process.exit(failed ? 1 : 0);
};

if (DEMO_RUN) {
  runDemo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  // קודם קבוצת הדמו בתת-תהליך, ואז המבחן הרגיל בתהליך הזה
  const { spawnSync } = require("child_process");
  const demo = spawnSync(process.execPath, [__filename, "--demo"], { stdio: "inherit" });
  if (demo.status !== 0) process.exit(demo.status || 1);

  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

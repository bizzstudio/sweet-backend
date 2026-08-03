// script/test-ingestion.js
//
// הרצת הזמנה אמיתית דרך כל צינור הקליטה, מהטרמינל, מול ה-DB האמיתי.
// זה הכלי לכיול המערכת על הזמנות אמיתיות לפני שמפעילים את הקליטה בפועל.
//
// שימוש:
//   npm run ingest:test -- --text "היי, 2 מגשי תמרים ושקית פיסטוק להרצל 5 תל אביב, 0521234567"
//   npm run ingest:test -- --file ./orders/example1.txt
//   npm run ingest:test -- --file ./example.txt --real     # ליצור הזמנה באמת
//
// כברירת מחדל רץ ב-dry-run: קורא, מתאים לקטלוג, פותר לקוח וכתובת — אבל *לא*
// יוצר הזמנה ולא מוריד מלאי. להוספת --real כדי ליצור הזמנה אמיתית.

require("dotenv").config();
const fs = require("fs");
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const { ingestMessage } = require("../lib/order-ingestion");

const argv = process.argv.slice(2);
const getArg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const text = getArg("text") || (getArg("file") ? fs.readFileSync(getArg("file"), "utf8") : null);
const phone = getArg("phone") || "0500000000";
const email = getArg("email");
const channel = getArg("channel") || "manual";
const isReal = hasFlag("real");

if (!text || !text.trim()) {
  console.error(`
חסר טקסט הזמנה.

  npm run ingest:test -- --text "2 מגשי תמרים להרצל 5 תל אביב 0521234567"
  npm run ingest:test -- --file ./example.txt

אפשרויות:
  --text <טקסט>      טקסט ההזמנה
  --file <נתיב>      קריאת ההזמנה מקובץ
  --phone <מספר>     טלפון השולח (ברירת מחדל 0500000000)
  --email <כתובת>    מייל השולח
  --channel <ערוץ>   manual (ברירת מחדל) / whatsapp / email
  --real             ליצור הזמנה אמיתית (ברירת המחדל: dry-run)
`);
  process.exit(1);
}

const line = (char = "─") => console.log(char.repeat(64));

const run = async () => {
  await connectDB();
  // connectDB תופס שגיאות חיבור ורק מדפיס אותן, ולכן בודקים בעצמנו — אחרת
  // הסקריפט היה נופל בשאילתה הראשונה עם שגיאה לא מובנת.
  if (mongoose.connection.readyState !== 1) {
    console.error("\nאין חיבור למסד הנתונים. בדוק את MONGO_URI ב-.env.\n");
    process.exit(1);
  }

  line("═");
  console.log(isReal ? "מצב: יצירת הזמנה אמיתית" : "מצב: הרצה יבשה (לא נוצרת הזמנה)");
  console.log(`ערוץ: ${channel} | טלפון: ${phone}${email ? ` | מייל: ${email}` : ""}`);
  line("═");
  console.log(text.trim());
  line("═");

  const started = Date.now();

  const doc = await ingestMessage({
    channel,
    externalId: `test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    text,
    sender: { phone, email, name: getArg("name") },
    dryRun: !isReal,
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  // ── מה ה-LLM הבין ──
  console.log("\n▸ מה נקרא מההודעה:");
  if (doc.parsed) {
    console.log(`  זו הזמנה: ${doc.parsed.isOrder ? "כן" : `לא — ${doc.parsed.notAnOrderReason}`}`);
    console.log(`  ביטחון החילוץ: ${doc.parsed.confidence}`);
    const c = doc.parsed.customer || {};
    console.log(
      `  לקוח: ${[c.name, c.lastName].filter(Boolean).join(" ") || "—"}` +
        `${c.phone ? ` | טלפון ${c.phone}` : ""}${c.email ? ` | מייל ${c.email}` : ""}` +
        `${c.businessName ? ` | עסק: ${c.businessName}` : ""}`
    );
    const d = doc.parsed.delivery || {};
    console.log(
      `  משלוח: ${d.type || "לא צוין"}` +
        `${d.city ? ` | ${d.city}` : ""}${d.street ? `, ${d.street} ${d.houseNumber || ""}` : ""}` +
        `${d.requestedDate ? ` | מועד: ${d.requestedDate}` : ""}`
    );
    if (doc.parsed.note) console.log(`  הערה: ${doc.parsed.note}`);
  } else {
    console.log("  (החילוץ לא הושלם)");
  }

  // ── התאמה לקטלוג ──
  console.log("\n▸ התאמה לקטלוג:");
  if (!doc.matchedItems?.length) {
    console.log("  (אין פריטים)");
  } else {
    doc.matchedItems.forEach((item) => {
      if (item.product) {
        const pct = Math.round((item.confidence || 0) * 100);
        const flag = pct >= 90 ? "✓" : "~";
        console.log(
          `  ${flag} "${item.rawName}" → ${item.productTitle} ` +
            `| כמות ${item.quantity}${item.unit ? ` (${item.unit})` : ""} ` +
            `| ${item.unitPrice} ₪ ליחידה | ביטחון ${pct}% (${item.decidedBy})`
        );
      } else {
        console.log(`  ✗ "${item.rawName}" → ${item.failReason}`);
        if (item.alternatives?.length) {
          console.log(
            `      מועמדים שנשקלו: ${item.alternatives
              .map((a) => a.title?.he || a.title?.en)
              .filter(Boolean)
              .join(" | ")}`
          );
        }
      }
    });
  }

  // ── תוצאה ──
  console.log("\n▸ תוצאה:");
  console.log(`  סטטוס: ${doc.status}`);
  console.log(`  ביטחון כולל: ${doc.confidence}`);
  if (doc.resolved?.customer) {
    console.log(
      `  לקוח במערכת: ${doc.resolved.customer}` +
        `${doc.resolved.customerWasCreated ? " (נוצר חדש)" : " (קיים)"}`
    );
  }
  if (doc.resolved?.city) {
    // deliveryPrice ריק כשלא מנוהלים יעדי משלוח — אז דמי המשלוח הם 0
    const price = Number(doc.resolved.deliveryPrice) || 0;
    console.log(`  יעד משלוח: ${doc.resolved.city} (דמי משלוח ${price} ₪)`);
  }
  if (doc.invoice) console.log(`  נוצרה הזמנה: ${doc.invoice}`);
  if (doc.error) console.log(`  שגיאה: ${doc.error} [${doc.errorCode}]`);

  console.log("\n▸ שלבי העיבוד:");
  (doc.logs || []).forEach((l) => console.log(`  ${l.step}: ${l.message}`));

  console.log(`\nזמן ריצה: ${elapsed} שניות`);
  console.log(`רשומת IncomingOrder: ${doc._id}`);
  line("═");

  await mongoose.connection.close();
  process.exit(doc.status === "failed" ? 1 : 0);
};

run().catch(async (err) => {
  console.error("\nכשל בהרצה:", err.message);
  console.error(err.stack);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});

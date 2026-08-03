// script/check-pdfs.js
//
// בדיקת קליטה מקצה לקצה על קבצי PDF אמיתיים: קריאה → פרסור → התאמה לקטלוג.
//
// הרצה:   npm run pdf:check -- ./exemple
//         npm run pdf:check -- ./exemple -v      (כולל מה הותאם לכל פריט)
//         npm run pdf:check -- ~/Downloads/order.pdf
//
// ── למה זה קיים ──
//
// pdf:test עוצר אחרי הפרסור ומראה מה חולץ מהקובץ. הוא לא אומר מה יקרה
// *בפועל* — כלומר כמה פריטים יימצאו בקטלוג וכמה ייפלו לטיפול ידני. זו השאלה
// היחידה שחשובה כשמסתכלים על קובץ חדש מלקוח חדש.
//
// הכלי הזה לא כותב כלום: אין הזמנה, אין לקוח, אין נגיעה במלאי.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const { extractPdfText } = require("../lib/pdf-reader");
const { parseOrderText } = require("../lib/order-ingestion/tableParser");
const { resolveItems } = require("../lib/order-ingestion/resolvers");

const args = process.argv.slice(2);
const VERBOSE = args.includes("-v") || args.includes("--verbose");
const target = args.find((a) => !a.startsWith("-"));

if (!target) {
  console.error("\nשימוש: npm run pdf:check -- <קובץ.pdf | תיקייה> [-v]\n");
  process.exit(1);
}

const collectFiles = (input) => {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) {
    console.error(`\nלא נמצא: ${resolved}\n`);
    process.exit(1);
  }
  if (fs.statSync(resolved).isDirectory()) {
    return fs
      .readdirSync(resolved)
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .sort()
      .map((f) => path.join(resolved, f));
  }
  return [resolved];
};

const pad = (v, n) => String(v ?? "-").padEnd(n);

const run = async () => {
  const files = collectFiles(target);
  if (!files.length) {
    console.error("\nלא נמצאו קבצי PDF.\n");
    process.exit(1);
  }

  const dbName = process.env.MONGO_DB_NAME;
  await mongoose.connect(process.env.MONGO_URI, dbName ? { dbName } : {});

  const results = [];

  for (const file of files) {
    const row = { name: path.basename(file) };
    try {
      const extracted = await extractPdfText(fs.readFileSync(file));
      row.readable = extracted.readable;

      if (!extracted.readable) {
        row.note = extracted.reason || "לא קריא";
        results.push(row);
        continue;
      }

      const parsed = parseOrderText({
        text: extracted.text,
        sender: { email: "check@local" },
        subject: row.name,
      });

      row.method = parsed.method;
      row.extracted = (parsed.items || []).length;

      // שורות שנראות כפריט אך לא נקלטו — הסימן לפריט שאבד בשקט
      row.suspect = (parsed.skippedRows || []).filter((s) => s.suspectedItem);

      if (!parsed.isOrder) {
        row.note = parsed.notAnOrderReason;
        results.push(row);
        continue;
      }

      const { items, unmatched } = await resolveItems(parsed.items, {
        contextText: extracted.text,
      });

      row.matched = items.length;
      row.unmatched = unmatched.length;
      row.items = items;
      row.fails = unmatched;
    } catch (err) {
      row.note = `שגיאה: ${err.message}`;
    }
    results.push(row);
  }

  console.log(
    "\n" + pad("קובץ", 34) + pad("קריא", 7) + pad("שיטה", 8) + pad("חולצו", 8) +
    pad("הותאמו", 9) + "לטיפול ידני"
  );
  console.log("─".repeat(84));

  results.forEach((r) => {
    console.log(
      pad(r.name.slice(0, 33), 34) + pad(r.readable, 7) + pad(r.method, 8) +
      pad(r.extracted, 8) + pad(r.matched, 9) + pad(r.unmatched, 6) +
      (r.note ? "  " + r.note : "")
    );
  });

  // שורות חשודות קודם — פריט שנשמט בשקט חמור יותר מפריט שהגיע לאדם
  const suspects = results.flatMap((r) => (r.suspect || []).map((s) => ({ file: r.name, s })));
  if (suspects.length) {
    console.log(`\n⚠ שורות שנראות כפריט אך לא נקלטו (${suspects.length}):`);
    suspects.forEach(({ file, s }) => console.log(`   [${file}] ${s.raw}`));
  }

  const fails = results.flatMap((r) => (r.fails || []).map((f) => ({ file: r.name, f })));
  if (fails.length) {
    console.log(`\nפריטים שעוברים לטיפול ידני (${fails.length}):`);
    fails.forEach(({ file, f }) => console.log(`   [${file}] "${f.rawName}" — ${f.failReason}`));
  }

  if (VERBOSE) {
    results.forEach((r) => {
      if (!r.items?.length) return;
      console.log(`\n── ${r.name} ──`);
      r.items.forEach((i) =>
        console.log(
          `   ${pad(i.quantity, 6)} | ${pad(i.confidence, 6)} | ${pad(i.decidedBy, 26)} | ` +
          `${i.rawName}  →  ${i.product.title?.he}`
        )
      );
    });
  }

  console.log("");
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

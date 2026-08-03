// script/test-pdf.js
//
// בדיקה מה נקרא מקובץ PDF, בלי DB ובלי ליצור הזמנה.
//
// הרצה:   npm run pdf:test -- ./exemple/order.pdf
//         npm run pdf:test -- ./exemple            (כל ה-PDF בתיקייה)
//
// מדפיס את הטקסט שחולץ ואת הפריטים שהפרסר הפנימי הוציא ממנו — כלומר בדיוק
// מה שהיה נכנס להזמנה אילו הקובץ היה מגיע במייל.

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const { extractPdfText } = require("../lib/pdf-reader");
const { parseOrderText } = require("../lib/order-ingestion/tableParser");

const target = process.argv[2];

if (!target) {
  console.error("\nשימוש: npm run pdf:test -- <קובץ.pdf | תיקייה>\n");
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
      .map((f) => path.join(resolved, f));
  }
  return [resolved];
};

const run = async () => {
  const files = collectFiles(target);

  if (!files.length) {
    console.error("\nלא נמצאו קבצי PDF.\n");
    process.exit(1);
  }

  for (const file of files) {
    console.log("\n" + "═".repeat(74));
    console.log(path.basename(file));
    console.log("═".repeat(74));

    try {
      const result = await extractPdfText(fs.readFileSync(file));

      console.log(`עמודים: ${result.pages}   קריא: ${result.readable ? "כן" : "לא"}`);
      if (result.reason) console.log(`הערה: ${result.reason}`);

      if (!result.readable) {
        console.log("\nהקובץ הזה יגיע ל\"הזמנות שגויות\" ויחכה לאדם. זו ההתנהגות הנכונה —");
        console.log("עדיף הזמנה שממתינה מאשר הזמנה שגויה.\n");
        continue;
      }

      console.log("\n── הטקסט שחולץ (20 שורות ראשונות) ──");
      result.text.split("\n").slice(0, 20).forEach((line, i) => {
        console.log(String(i + 1).padStart(3) + " | " + line.replace(/\t/g, " │ "));
      });

      const parsed = parseOrderText({
        text: result.text,
        sender: { email: "test@example.com" },
        subject: path.basename(file),
      });

      console.log("\n── מה שהפרסר הוציא ──");
      console.log(`זוהה כהזמנה: ${parsed.isOrder}   ביטחון: ${parsed.confidence}   פריטים: ${(parsed.items || []).length}`);

      (parsed.items || []).forEach((item) => {
        console.log(
          `   ${String(item.quantity).padStart(6)} ${(item.unit || "יח").padEnd(6)} | ${item.rawName}` +
            (item.note ? `   [הערה: ${item.note}]` : "")
        );
      });

      if (parsed.reason) console.log(`   סיבה: ${parsed.reason}`);
      if (parsed.orderNote) console.log(`   הערת הזמנה: ${parsed.orderNote}`);
    } catch (err) {
      console.log(`שגיאה: ${err.message}`);
    }
  }

  console.log("");
  process.exit(0);
};

run();

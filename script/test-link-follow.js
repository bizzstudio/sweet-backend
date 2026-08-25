// script/test-link-follow.js
//
// בדיקת המסלול "ההזמנה נמצאת מעבר לקישור", מהטרמינל, **בלי לגעת במסד**.
//
// זה הכלי לכיול פלטפורמה חדשה: הוא עונה על שלוש השאלות שקובעות אם היא
// תעבוד אוטומטית, ועושה זאת לפני שמאשרים אותה ולפני שמייל אמיתי נכנס.
//
//   1. איזה קישור במייל זוהה כהזמנה (ומה *לא* זוהה — פוטר, הסרה מתפוצה).
//   2. האם הדף נפתח בלי התחברות, או שהוא דורש סשן.
//   3. מה הפרסר שלנו קורא מהטקסט שמעבר לקישור — כמה פריטים, ובאיזה ביטחון.
//
// שימוש:
//   npm run link:test -- --url "https://app.zester.co.il/#/orders/7667033?token=..."
//   npm run link:test -- --eml ./mail.eml          # מייל שמור: חילוץ + פתיחה + ניתוח
//   npm run link:test -- --eml ./mail.eml --no-follow    # חילוץ בלבד
//   npm run link:test -- --url "..." --shot /tmp/order.jpg
//
// אין כאן חיבור למסד, אין רשומה, אין הזמנה. אפשר להריץ על שרת חי בלי חשש.

require("dotenv").config();
const fs = require("fs");

const { followOrderLink } = require("../lib/link-follower");
const { closeBrowser } = require("../lib/headless-browser");
const { parseOrderText } = require("../lib/order-ingestion/tableParser");
const { extractPlatformRefs } = require("../lib/order-ingestion/platforms");

const argv = process.argv.slice(2);
const getArg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const url = getArg("url");
const emlPath = getArg("eml");
const shotPath = getArg("shot");
const skipFollow = hasFlag("no-follow");

if (!url && !emlPath) {
  console.error(`
חסר קישור או מייל.

  npm run link:test -- --url "https://app.zester.co.il/#/orders/123?token=abc"
  npm run link:test -- --eml ./mail.eml

אפשרויות:
  --url <כתובת>    פתיחת קישור בודד
  --eml <נתיב>     מייל שמור (RFC822) — חילוץ הקישור מתוכו ואז פתיחה
  --shot <נתיב>    שמירת צילום המסך של הדף לקובץ
  --no-follow      חילוץ הקישורים בלבד, בלי לפתוח דפדפן
`);
  process.exit(1);
}

const line = (char = "─") => console.log(char.repeat(72));

const showParse = (text, label) => {
  const parsed = parseOrderText({ text, channel: "email" });
  line();
  console.log(`ניתוח ${label}:`);
  console.log(`  זוהתה כהזמנה: ${parsed.isOrder ? "כן" : "לא"}${parsed.method ? ` (${parsed.method})` : ""}`);
  if (!parsed.isOrder) console.log(`  הסיבה: ${parsed.notAnOrderReason || "לא צוין"}`);
  console.log(`  ביטחון: ${parsed.confidence ?? "—"}`);
  console.log(`  פריטים: ${parsed.items?.length || 0}`);
  (parsed.items || []).slice(0, 25).forEach((item, i) => {
    console.log(`   ${String(i + 1).padStart(2)}. ${item.quantity ?? "?"} × ${item.rawName}${item.unit ? ` [${item.unit}]` : ""}`);
  });
  if ((parsed.items || []).length > 25) console.log(`   ... ועוד ${parsed.items.length - 25}`);
  return parsed;
};

(async () => {
  let target = url;
  let emailText = "";
  let emailSubject = "";

  // ── מייל שמור: חילוץ הקישור מתוכו ──
  if (emlPath) {
    const { parseImapMessage } = require("../lib/imap-reader/parseMessage");
    const raw = fs.readFileSync(emlPath);
    const parsed = await parseImapMessage(raw);

    emailText = parsed.text || "";
    emailSubject = parsed.subject || "";

    line("═");
    console.log(`מייל: ${emailSubject}`);
    console.log(`שולח: ${parsed.sender?.raw || parsed.sender?.email || "—"}`);
    line("═");
    console.log(emailText.slice(0, 800) || "(אין טקסט)");

    line();
    console.log(`קישורים שזוהו כהזמנה (${parsed.links?.length || 0}):`);
    (parsed.links || []).forEach((link, i) => {
      console.log(`  ${i + 1}. [${link.score}] ${link.url}`);
      console.log(`      טקסט הכפתור: "${link.anchor || "—"}"`);
      console.log(`      למה: ${link.reason}`);
    });
    if (!parsed.links?.length) {
      console.log("  אין. הודעה כזו לא תפתח דפדפן — היא תיקרא כמו כל מייל אחר.");
    }

    const refs = extractPlatformRefs({ subject: emailSubject, text: emailText });
    line();
    console.log("מזהי הלקוח שזוהו במייל (למיפוי חד-פעמי):");
    console.log(`  מספרים: ${refs.refs.join(" / ") || "—"}`);
    console.log(`  שמות:   ${refs.names.join(" / ") || "—"}`);

    // מה הפרסר קורא מהמייל **לפני** פתיחת הקישור. זו נקודת ההשוואה: אם כאן
    // אפס פריטים ואחרי הפתיחה יש פריטים — המנגנון עשה בדיוק את עבודתו.
    if (emailText.trim()) showParse(emailText, "המייל עצמו (לפני פתיחת הקישור)");

    target = parsed.links?.[0]?.url || null;
    if (!target) {
      console.log("\nאין קישור לפתוח. סוף.");
      return;
    }
  }

  if (skipFollow) {
    console.log("\n‏--no-follow: לא נפתח דפדפן.");
    return;
  }

  line("═");
  console.log(`פותח בדפדפן: ${target}`);
  line("═");

  const started = Date.now();
  const result = await followOrderLink({ url: target, screenshot: Boolean(shotPath) || true });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`  נלקח: ${seconds} שניות`);
  console.log(`  הצליח: ${result.ok ? "כן" : "לא"}`);
  console.log(`  קוד: ${result.code || "—"}`);
  console.log(`  כתובת סופית: ${result.finalUrl || "—"}`);
  console.log(`  כותרת הדף: ${result.title || "—"}`);
  console.log(`  תווים שנקראו: ${result.chars}`);
  if (result.blocked) console.log(`  ⛔ נחסם: ${result.error}`);
  if (result.loginRequired) {
    console.log(`  🔑 דורש התחברות: ${result.error}`);
    console.log(`     → צריך לשמור סשן אחד לפלטפורמה. אחרי זה הכול אוטומטי.`);
  } else if (!result.ok) {
    console.log(`  ✗ ${result.error}`);
  }

  if (shotPath && result.screenshot) {
    const base64 = result.screenshot.split(",")[1];
    fs.writeFileSync(shotPath, Buffer.from(base64, "base64"));
    console.log(`  צילום מסך נשמר: ${shotPath}`);
  }

  if (result.text) {
    line();
    console.log("הטקסט שנקרא מהדף (600 תווים ראשונים):");
    console.log(result.text.slice(0, 600));

    // בדיוק מה שהצינור יעשה: המייל + תוכן הדף, ואז ניתוח
    const combined = emailText
      ? `${emailText}\n\n──── תוכן הדף שמעבר לקישור (${result.host}) ────\n${result.text}`
      : result.text;
    showParse(combined, "מה שהצינור יראה (מייל + תוכן הדף)");
  }

  line("═");
  console.log(
    result.ok
      ? "הדף נקרא. אם הניתוח למעלה מצא פריטים — הפלטפורמה הזו תעבוד אוטומטית."
      : "הדף לא נקרא. הפירוט למעלה אומר מה חסר."
  );
})()
  .catch((err) => {
    console.error("\nכשל:", err.message);
    console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeBrowser();
  });

// script/test-conversation-filter.js
//
// בדיקת ההכרעה "שיחה או ניסיון הזמנה" — הרצה: npm run ingest:filter-test
//
// ── למה זה קיים כסקריפט ולא כהערה ──
//
// ההכרעה הזו היא שיווי משקל בין שתי טעויות שעולות ביוקר: הזמנה שנסגרת בשקט
// מצד אחד, והצפת "הזמנות שגויות" בהודעות שיחה מצד שני. כל שינוי בהיוריסטיקה
// מזיז את שתיהן יחד, ובלי הסוללה הזו אי אפשר לדעת לאיזה כיוון.
//
// אין תלות במסד ואין תלות ברשת — הפרסר דטרמיניסטי, ולכן הבדיקה מיידית.
//
// שלוש התוצאות האפשריות:
//   order  — נקראה כהזמנה מלאה
//   human  — לא נקראה, אבל יש ראיה להזמנה → "הזמנות שגויות", מייל התראה
//   quiet  — נסגרה בשקט כ-not_an_order

const { parseOrderText, looksLikeOrderAttempt } = require("../lib/order-ingestion/tableParser");

let passed = 0;
const failures = [];

const verdictOf = (result) =>
  result.isOrder ? "order" : result.certainNotOrder ? "quiet" : "human";

const check = (label, input, expected) => {
  const verdict = verdictOf(parseOrderText({ sender: {}, ...input }));
  if (verdict === expected) {
    passed += 1;
    console.log(`  ✓ ${verdict.padEnd(6)} ${label}`);
    return;
  }
  failures.push(`${label} — ציפינו "${expected}", התקבל "${verdict}"`);
  console.log(`  ✗ ${verdict.padEnd(6)} ${label}   (ציפינו ${expected})`);
};

const survives = (label, run) => {
  try {
    run();
    passed += 1;
    console.log(`  ✓ שרד   ${label}`);
  } catch (err) {
    failures.push(`${label} — נזרקה שגיאה: ${err.message}`);
    console.log(`  ✗ קרס   ${label}: ${err.message}`);
  }
};

const section = (title) => console.log(`\n── ${title} ──`);

// קובץ מצורף בפורמט שהצינור מייצר (ראה summary ב-lib/attachment-reader)
const file = (filename, mimeType, read = false) => [{ filename, mimeType, read, size: 1 }];

// ─────────────────────────────────────────────────────────────

section("הודעת שיחה בודדת נסגרת בשקט");
check("משפט בלי סימן שאלה", { text: "ולא שולח את זה כהודעה אחת" }, "quiet");
check("שאלה", { text: "מתי מגיע המשלוח" }, "quiet");
check("נימוס", { text: "תודה רבה!" }, "quiet");
check("מילה אחת", { text: "שניה" }, "quiet");
check("הודעה ריקה", { text: "   " }, "quiet");

section("מספרים שאינם כמות אינם ראיה");
check("שעה", { text: "שלחתי לך את זה ב-14:00 אתמול" }, "quiet");
check("תאריך עם לוכסנים", { text: "נדבר ב-04/08/26 בבוקר" }, "quiet");
check("תאריך מלא עם נקודות", { text: "נפגשים 4.8.26 בבוקר" }, "quiet");
check("מספר הזמנה", { text: "קיבלתי את הזמנה 12345 תודה" }, "quiet");
check("טלפון", { text: "תתקשרי אליי 0523383369" }, "quiet");
check("סכום כסף", { text: "אפשר לשלם 250 ₪ במזומן?" }, "quiet");

// עסק שמוכר במשקל כותב "2.5 קילו". דפוס תאריך רחב מדי בלע את זה וסגר את
// ההודעה בשקט, ולכן הנקודה מחייבת שלושה חלקים כדי להיחשב תאריך.
section("כמות עשרונית אינה תאריך");
check("קילו עם נקודה", { text: "2.5 קילו תמרים" }, "human");
check("קילו עם פסיק", { text: "1,5 קילו מג׳הול" }, "human");
check("משקל בגרמים", { text: "300 גרם קפה" }, "human");

// רשומת ווצאפ היא עד 40 הודעות משורשרות. ספירה על הטקסט המשורשר סופרת תורות
// שיחה כשורות ברשימה — ראה looksLikeOrderAttempt.
section("שיחה שנצברה אינה רשימה");
const chat = ["מה שלומך", "בסדר גמור", "אני אשלח אחר כך", "שניה", "עובד"];
check("5 תורות שיחה", { text: chat.join("\n"), segments: chat }, "quiet");
const longChat = Array(20).fill("בסדר גמור אחלה תודה");
check("20 תורות שחוצות יחד 250 תווים", { text: longChat.join("\n"), segments: longChat }, "quiet");
const withOrder = ["מה שלומך", "בסדר", "3 ארגזי תמרים", "2 שקיות פיסטוק"];
check("שיחה + הזמנה בפורמט מוכר", { text: withOrder.join("\n"), segments: withOrder }, "order");
const withList = ["היי", "מגבות נייר\nסבון כלים\nנייר טואלט\nשקיות"];
check("רשימה בתוך הודעה אחת בצבירה", { text: withList.join("\n"), segments: withList }, "human");

section("ראיה להזמנה עולה לטיפול אנושי");
check("כמות באמצע שורה", { text: "צריך 3 ארגזי תמרים" }, "human");
check("4 שורות בהודעה אחת", { text: "מגבות נייר\nסבון כלים\nנייר טואלט\nשקיות" }, "human");
check("הודעה ארוכה מ-250 תווים", { text: "א".repeat(260) }, "human");

// הזמנה שצולמה כדף או שהוכתבה בהקלטה מגיעה בלי טקסט קריא כלל.
section("קובץ מצורף הוא ראיה בפני עצמו");
check("תמונה", { text: "[ללא טקסט קריא]", attachments: file("תמונה.jpeg", "image/jpeg") }, "human");
check("הקלטה קולית", { text: "[ללא טקסט קריא]", attachments: file("הקלטה.ogg", "audio/ogg") }, "human");
check("אקסל", { text: "היי", attachments: file("הזמנה.xlsx", "application/vnd.ms-excel", true) }, "human");
check("PDF", { text: "היי", attachments: file("הזמנה.pdf", "application/pdf", true) }, "human");

// ⚠ הבדיקה על שם הקובץ בלבד היא מה שתופס מדבקה שהגיעה בלי mimeType. הניסוח
// הראשון השתמש ב-`\b` אחרי אות עברית — שאינו מתאים לעולם ב-JavaScript — ולכן
// נכשל בשקט, ורק בדיקת ה-mimeType הסתירה את התקלה.
section("מדבקה אינה ראיה");
check("לפי שם בלבד", { text: "חחח", attachments: file("מדבקה.webp", "") }, "quiet");
check("mimeType עם פרמטרים", { text: "חחח", attachments: file("מדבקה.webp", "image/webp; codecs=vp8") }, "quiet");
check("sticker באנגלית", { text: "lol", attachments: file("sticker.webp", "") }, "quiet");
check("מדבקה יחד עם תמונה", {
  text: "חחח",
  attachments: [...file("מדבקה.webp", "image/webp"), ...file("תמונה.jpeg", "image/jpeg")],
}, "human");

// זיהוי רשימה לפי פסיקים נבדק ונזנח: הוא תפס גם משפטי שיחה, כלומר החזיר את
// ההצפה. הכיסוי הזה מתועד כמכוון ב-ORDER-INGESTION.md.
section("פסיקים בשיחה אינם רשימת פריטים");
check("משפט עם שני פסיקים", { text: "כן, אני יודעת, זה מה שאמרתי" }, "quiet");
check("ברכה עם פסיקים", { text: "היי, מה נשמע, הכל טוב" }, "quiet");

section("רגרסיה: פורמטי הזמנה ממשיכים להיקרא");
check("טבלה", { text: "6\tחלב טרי 1 ליטר\n4\tחלב דל לקטוז\n2\tקוטג' 5%" }, "order");
check("טבלה עם כותרת", { text: "כמות | מוצר\n6 | חלב\n4 | לחם\n2 | ביצים" }, "order");
check("רשימת שורות", { text: "היי\n3 מגבות נייר\nמתקן סבון\n2 שקיות פיסטוק\nתודה" }, "order");
check("סימון x", { text: "חלב x3\nלחם x2" }, "order");
check("מקפים", { text: "- 3 שקיות פיסטוק\n- 2 מגשי תמרים" }, "order");

section("קלט חריג אינו מפיל את הצינור");
survives("בלי ארגומנטים", () => parseOrderText());
survives("text=null", () => parseOrderText({ text: null, sender: {} }));
survives("attachments=null", () => parseOrderText({ text: "היי", attachments: null, sender: {} }));
survives("segments=null", () => parseOrderText({ text: "היי", segments: null, sender: {} }));
survives("segments עם ערכים ריקים", () =>
  parseOrderText({ text: "היי", segments: [null, undefined, ""], sender: {} })
);
survives("קובץ בלי שדות", () => parseOrderText({ text: "היי", attachments: [{}, null], sender: {} }));
survives("looksLikeOrderAttempt בלי ארגומנטים", () => looksLikeOrderAttempt());

// דפוס המחיר מכיל `\d+` שעלול לא להתאים בסופו, כלומר נסיגה ריבועית על שורה
// שכולה ספרות. ‏hasQuantitySignal מקצץ את הקלט כדי שזה יהיה חסום.
section("ReDoS — שורה שכולה ספרות");
const digits = "9".repeat(100_000);
for (const [label, run] of [
  ["דרך parseOrderText", () => parseOrderText({ text: digits, sender: {} })],
  ["ישירות ל-looksLikeOrderAttempt", () => looksLikeOrderAttempt({ text: digits, segments: [digits] })],
]) {
  const startedAt = process.hrtime.bigint();
  run();
  const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
  if (ms < 1000) {
    passed += 1;
    console.log(`  ✓ ${ms.toFixed(0)}ms   ${label}`);
  } else {
    failures.push(`${label} — ${ms.toFixed(0)}ms`);
    console.log(`  ✗ ${ms.toFixed(0)}ms   ${label}`);
  }
}

// ─────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(58)}`);
console.log(`עברו: ${passed}   נכשלו: ${failures.length}`);

if (failures.length) {
  console.log("\nכשלונות:");
  failures.forEach((failure) => console.log(`  • ${failure}`));
  process.exit(1);
}

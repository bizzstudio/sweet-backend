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

// ── חתימת מייל אינה שורת פריט ──
//
// הרגרסיה שהסוללה הזו מגנה עליה נמדדה על נתוני אמת: הדפוס `שם [-–:] מספר`
// ראה במקף שבתוך מספר הטלפון מפריד בין שם לכמות, ולכן "Mobile:
// +972-54-9765334" נכנס להזמנה כפריט "Mobile: +972-54" בכמות 9,765,334.
// שמונה הזמנות נפלו מזה, וארבע מהן לא היו הזמנות בכלל אלא תשובת "תודה"
// שהחתימה מתחתיה הפכה אותה להזמנה עם מוצר.
//
// שתי הטענות נבדקות בנפרד: ששורת החתימה אינה פריט, ושהפריטים האמיתיים
// שלצידה כן נקראו.
section("חתימת מייל אינה שורת פריט");

const itemsOf = (text) => (parseOrderText({ text, sender: {}, segments: [text] }) || {}).items || [];

const noSignatureItem = (label, signatureLine) => {
  const text = `שלום\n3 מגבות נייר\n2 מתקן סבון\n\nבברכה\nישראל ישראלי\n${signatureLine}`;
  const items = itemsOf(text);
  // "דלף" = פריט שנחתך מתוך שורת החתימה, או כמות בסדר גודל של מספר טלפון.
  // שורת השם ("ישראל ישראלי") אינה נבדקת כאן: היא נכנסת ככמות מונחת, ופריט
  // מונח שאין לו התאמה בקטלוג חוזר להיות שורה מדולגת ואינו מפיל את ההזמנה.
  const leaked = items.filter(
    (item) => signatureLine.includes(item.rawName) || item.quantity > 10000
  );
  const kept = items.filter((item) => /מגבות נייר|מתקן סבון/.test(item.rawName)).length;

  if (!leaked.length && kept === 2) {
    passed += 1;
    console.log(`  ✓ נקי   ${label}`);
    return;
  }
  const detail = leaked.length
    ? `נקלט כפריט: ${leaked.map((i) => `${i.quantity}×${i.rawName}`).join(", ")}`
    : `הפריטים האמיתיים אבדו (${kept} מתוך 2)`;
  failures.push(`${label} — ${detail}`);
  console.log(`  ✗ דלף   ${label}: ${detail}`);
};

noSignatureItem("Mobile עם קידומת בינלאומית", "Mobile: +972-54-9765334");
noSignatureItem("Phone", "Phone: +972-073-2617410");
noSignatureItem("Cell phone", "Cell phone: +972-542-258-551");
noSignatureItem("Office phone", "Office phone: +972-73-239-7600");
noSignatureItem("תווית בת אות אחת", "T: 073-2527602");
noSignatureItem("פקס בת אות אחת", "F: +972-3-9212187");
noSignatureItem("שתי תוויות בשורה אחת", "Mobile +972-50-8277454, Office +972-3-6383030");
noSignatureItem("טלפון בלי תווית", "054-8084464");
noSignatureItem("טלפון עברי", "טלפון: 03-5497368");
noSignatureItem("כתובת מייל", "Email: sigalit.tiri@aman.co.il<mailto:sigalit.tiri@aman.co.il>");
noSignatureItem("אתר", "https://www.aman.co.il");
noSignatureItem("שורת סיכום", 'סה"כ - 1235');

// שם מוצר לטיני נשאר קריא — הקטלוג מכיל "NO TUCH" ו-"MAX-HD 50F"
check("שם מוצר לטיני", { text: "מתקן לנייר NO TUCH - 3\nשדכן MAX-HD 50F - 2" }, "order");

section("כמות בסדר גודל של טלפון אינה כמות");
{
  const items = itemsOf("היי\nמגבות נייר - 9765334\n3 מתקן סבון");
  const absurd = items.filter((item) => item.quantity > 10000);
  if (!absurd.length) {
    passed += 1;
    console.log("  ✓ נקי   שורה עם מספר בן 7 ספרות");
  } else {
    failures.push(`שורה עם מספר בן 7 ספרות — נקלטה כמות ${absurd[0].quantity}`);
    console.log(`  ✗ דלף   שורה עם מספר בן 7 ספרות: כמות ${absurd[0].quantity}`);
  }
}

// ── תשובה קצרה עם חתימה עדיין עולה לאדם, ובכוונה ──
//
// היא כבר לא הופכת להזמנה עם מוצר, אבל היא כן ממשיכה להופיע ב"הזמנות שגויות":
// ניכוי החתימה ממדד האורך נמדד על 220 הודעות אמיתיות והזיז עשר מהן לסגירה
// שקטה, ביניהן הודעת ביטול הזמנה. ראה הנימוק המלא ליד isOrderShapedMessage.
section("חתימה עדיין נספרת כראיה — האיזון לא הוזז");
check(
  "תשובה קצרה עם חתימה ארוכה",
  {
    text: [
      "סבבה",
      "תודה",
      "Larisa Rozenboim",
      "Head accountant, Novolog Group",
      "T: 073-2527602",
      "novolog.co.il",
    ].join("\n"),
  },
  "human"
);

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
// ── קלט ארוך אינו מפיל את מנוע ההתאמה ──
//
// ‏createApostropheIgnoringRegex מוסיפה קבוצה לכל תו, וכל ווריאציה צליליות
// הופכת ל-5 תנאי חיפוש. בלי חסמים נמדד ש-5,000 תווים מפילים את **התהליך
// כולו** ב-OOM, כלומר את כל השרת ולא רק את הבקשה. שני נתיבים מגיעים לשם:
// שורת פריט במייל של לקוח, ו-GET /api/products/voice-search — נתיב ציבורי
// שהמידלוור שלו אינו חוסם.
//
// הבדיקה כאן אינה נוגעת במסד: parseText ו-buildProductSearchConditions הן
// פונקציות טהורות, ובהן בדיוק היה הפיצוץ.
// ── מה שאחרי ברכת הסיום הוא חתימה ──
//
// לקוחה בשם "מיכל" שחותמת על המייל שלה קיבלה להזמנה "עגלת פינוי +מיכל 130
// ליטר" בביטחון 0.85, ו-"גלית" קיבלה "פח פדל עם רגלית". שם פרטי הוא שורה
// קצרה בלי כמות, כלומר בדיוק מה שנקרא כ"פריט אחד" — וההזמנה נכנסה ל"טופלה"
// עם מוצר שאיש לא ביקש, כולל הורדת מלאי ותעודת משלוח.
section("שורה אחרי ברכת סיום אינה פריט");

const itemNames = (text, channel) =>
  ((parseOrderText({ text, channel, sender: {}, segments: [text] }) || {}).items || []).map(
    (i) => i.rawName
  );

const signatureCheck = (label, text, channel, shouldContain) => {
  const names = itemNames(text, channel);
  const has = names.some((n) => n.includes(shouldContain.needle));
  if (has === shouldContain.expected) {
    passed += 1;
    console.log(`  ✓ ${label}`);
    return;
  }
  const what = shouldContain.expected ? "היה צריך להיקרא" : "לא היה צריך להיקרא";
  failures.push(`${label} — "${shouldContain.needle}" ${what}. נקרא: ${JSON.stringify(names)}`);
  console.log(`  ✗ ${label} — נקרא: ${JSON.stringify(names)}`);
};

signatureCheck(
  "שם פרטי בחתימה אינו מוצר",
  "היי:\n3 מגבות נייר\nתודה!\nמיכל",
  "email",
  { needle: "מיכל", expected: false }
);
signatureCheck(
  "תפקיד בחתימה אינו מוצר",
  "שלום,\n4 מגבות נייר\nתודה רבה\nגלית\nמנהלת משרד",
  "email",
  { needle: "מנהלת משרד", expected: false }
);
// הסייג שמונע מהכלל לבלוע הזמנה: כמות מפורשת גוברת על מיקום השורה
signatureCheck(
  "כמות מפורשת אחרי הסיום עדיין נקראת",
  "היי\n3 מגבות נייר\nתודה\nאה שכחתי, 2 מתקן סבון",
  "email",
  { needle: "מתקן סבון", expected: true }
);
// ── ווצאפ פטור ──
// שם אין חתימות, ויש בדיוק את הדפוס ההפוך: הודעות נצברות ל-rawText אחד, ולכן
// "תודה" בהודעה אחת ו-"מתקן סבון" בהבאה נראים כמו חתימה — בעוד שזו שיחה.
signatureCheck(
  "בווצאפ הכלל אינו חל",
  "היי\n3 מגבות נייר\nתודה\nמתקן סבון",
  "whatsapp",
  { needle: "מתקן סבון", expected: true }
);
// ברכת *פתיחה* אינה מסמנת חתימה — אחרת כל ההזמנה הייתה נחתכת בשורה הראשונה
signatureCheck(
  "ברכת פתיחה אינה חותכת את ההזמנה",
  "בוקר טוב\n3 מגבות נייר\nמתקן סבון",
  "email",
  { needle: "מתקן סבון", expected: true }
);

// ── תשובת Outlook: החתימה מעל, ההזמנה מתחתיה ──
//
// מייל אמיתי בקורפוס נפתח ב-"בברכה" — תשובה שבה החתימה המצוטטת יושבת בראש
// והזמנה מלאה מתחתיה. הניסוח הראשון של הכלל לקח את ברכת הסיום הראשונה, סימן
// את כל המייל כחתימה, ומחק את ההערה במלואה — כולל **כתובת המשלוח**.
//
// לכן הגבול נסרק מהסוף ומתקבל רק אם מה שאחריו קצר דיו כדי להיות חתימה.
section("ברכת סיום בראש המייל אינה חתימה");
{
  const topPosted = [
    "בברכה",
    "דורית גולדמן",
    "טלפון: 03-7539701",
    "שלום רב,",
    "נא לשלוח לנו את המוצרים הבאים ליום שני",
    'משלוח למעלות אבא הלל 12, קומה 15, ר"ג',
    "3 מגבות נייר",
    "2 מתקן סבון",
    "1 נייר טואלט",
    "4 סבון ידיים",
    "2 מטליות",
    "1 שקיות אשפה",
    "3 כוסות חד פעמי",
    "2 צלחות חד פעמי",
    "1 סכום חד פעמי",
  ].join("\n");

  const parsed = parseOrderText({ text: topPosted, channel: "email", sender: {}, segments: [topPosted] }) || {};
  const note = parsed.note || "";
  const keptAddress = note.includes("אבא הלל 12");
  const keptItems = (parsed.items || []).length >= 8;

  if (keptAddress && keptItems) {
    passed += 1;
    console.log("  ✓ כתובת המשלוח וההזמנה נשמרו");
  } else {
    failures.push(
      `תשובת Outlook — כתובת: ${keptAddress ? "נשמרה" : "אבדה"}, פריטים: ${(parsed.items || []).length}`
    );
    console.log(`  ✗ כתובת: ${keptAddress ? "נשמרה" : "אבדה"} | פריטים: ${(parsed.items || []).length}`);
  }
}

// ── החתימה גם לא עוברת להערת ההזמנה ──
//
// זו הטעות הקלה ביותר כאן: לחסום את החתימה מרשימת הפריטים ובכך רק *להעביר*
// אותה להערה שהמלקט קורא. הערה שרובה נייר מכתבים היא הערה שאיש לא קורא, ואז
// גם ההוראה האמיתית שבתוכה הולכת לאיבוד.
section("החתימה אינה מגיעה להערת ההזמנה");
{
  const orderWithSignature = [
    "היי, להזמין למחר:",
    "3 מגבות נייר",
    "לשלוח אחרי 14:00 בבקשה",
    "תודה!",
    "מיכל כהן",
    "מנהלת משרד",
    "חברת בונים בית",
  ].join("\n");

  const noteOf = (channel) =>
    (parseOrderText({ text: orderWithSignature, channel, sender: {}, segments: [orderWithSignature] }) || {})
      .note || "";

  const emailNote = noteOf("email");
  const noSignature = !/מיכל|מנהלת משרד|בונים בית/.test(emailNote);
  const keptInstruction = emailNote.includes("לשלוח אחרי 14:00");

  if (noSignature && keptInstruction) {
    passed += 1;
    console.log("  ✓ ההערה מכילה את ההוראה בלבד");
  } else {
    failures.push(`הערת ההזמנה — התקבל: ${JSON.stringify(emailNote)}`);
    console.log(`  ✗ הערת ההזמנה: ${JSON.stringify(emailNote)}`);
  }

  // ההוראה חייבת לשרוד גם בווצאפ, שבו הכלל אינו חל
  if (noteOf("whatsapp").includes("לשלוח אחרי 14:00")) {
    passed += 1;
    console.log("  ✓ ההוראה נשמרת גם בווצאפ");
  } else {
    failures.push(`הערת ווצאפ — התקבל: ${JSON.stringify(noteOf("whatsapp"))}`);
    console.log(`  ✗ הערת ווצאפ: ${JSON.stringify(noteOf("whatsapp"))}`);
  }
}

section("קלט ארוך אינו מפיל את מנוע ההתאמה");
{
  const { parseText } = require("../utils/voiceParser");
  const { buildProductSearchConditions } = require("../utils/productMatching");

  for (const [label, input] of [
    ["מילה בת 5,000 תווים", "א".repeat(5000)],
    ["מילה בת 200,000 תווים", "א".repeat(200000)],
    ["אותיות מתחלפות בלבד", "אעהאעהאעה".repeat(500)],
    ["טקסט אמיתי ארוך", "קפה טורקי עלית 200 גרם באריזה אדומה בבקשה ".repeat(50)],
  ]) {
    const startedAt = process.hrtime.bigint();
    let conditions = -1;
    try {
      const { query, variations } = parseText(input);
      conditions = buildProductSearchConditions(query, variations).length;
    } catch (err) {
      failures.push(`${label} — זרק: ${err.message}`);
      console.log(`  ✗ קרס   ${label}: ${err.message.slice(0, 50)}`);
      continue;
    }
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;

    // התקרה על מספר התנאים היא העיקר: היא מה שחוסם גם את הזיכרון וגם את
    // העומס על מונגו, ולא רק את זמן הריצה של התהליך הזה.
    if (ms < 1000 && conditions <= 2000) {
      passed += 1;
      console.log(`  ✓ ${ms.toFixed(0)}ms   ${label} (${conditions} תנאים)`);
    } else {
      failures.push(`${label} — ${ms.toFixed(0)}ms, ${conditions} תנאים`);
      console.log(`  ✗ ${ms.toFixed(0)}ms   ${label} (${conditions} תנאים)`);
    }
  }
}

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

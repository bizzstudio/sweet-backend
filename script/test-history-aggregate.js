// script/test-history-aggregate.js
//
// בדיקת סיכום שורות המסמך למוצרים — הרצה: npm run history:aggregate-test
//
// ── למה זה נבדק בנפרד ──
//
// ‏aggregateRows הוא המקום שבו קובץ ההנהח"ש הופך למונה "כמה פעמים הלקוח קנה",
// והמונה הזה הוא מה שקובע אילו שורות הזמנה יאושרו אוטומטית. טעות כאן אינה
// נראית בשום מסך: הפרופיל תקין, המק"טים קיימים, והספירה פשוט שגויה.
//
// הפונקציה טהורה ולכן הבדיקה אינה נוגעת במסד (טעינת הקונטרולר רק רושמת מודלים).

require("dotenv").config();

const {
  aggregateRows,
  compareCustomerNumbers,
} = require("../controller/customerHistoryController");

let passed = 0;
const failures = [];

const check = (label, actual, expected) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    passed += 1;
    console.log(`  ✓ ${label}`);
    return;
  }
  failures.push(`${label} — ציפינו ${JSON.stringify(expected)}, התקבל ${JSON.stringify(actual)}`);
  console.log(`  ✗ ${label}\n      ציפינו: ${JSON.stringify(expected)}\n      התקבל:  ${JSON.stringify(actual)}`);
};

const section = (title) => console.log(`\n── ${title} ──`);

const row = (over = {}) => ({
  rowNumber: 1,
  sku: "83",
  name: "קפה טורקי עלית 200 גר",
  date: "2026-06-30T10:41:00.000Z",
  quantity: 15,
  price: 19.8,
  docType: "חשבונית מס",
  ...over,
});

const only = (rows) => aggregateRows(rows).items[0];

// ───────────────────────────────────────────────────────────────

section("סיכום שורות מסמך למוצר");

// הקובץ הוא רשימת שורות מסמך: אותו מק"ט חוזר בכל תעודה שבה נקנה
const summed = only([
  row({ rowNumber: 5, date: "2025-09-15T11:21:00.000Z", price: 18.4, quantity: 4 }),
  row({ rowNumber: 6, date: "2026-06-30T10:41:00.000Z", price: 19.8, quantity: 15 }),
]);
check("מספר הקניות נספר", summed.lines, 2);
check("הכמויות מצטברות", summed.totalQty, 19);
check("התאריך הראשון הוא המוקדם", summed.firstAt.toISOString(), "2025-09-15T11:21:00.000Z");
check("התאריך האחרון הוא המאוחר", summed.lastAt.toISOString(), "2026-06-30T10:41:00.000Z");
check("טווח המחירים נשמר", [summed.minPrice, summed.maxPrice], [18.4, 19.8]);

// ── המחיר האחרון לפי התאריך, לא לפי סדר השורות ──
//
// קובץ ההנהח"ש אינו ממוין בהכרח. לקיחת "השורה האחרונה בקובץ" הייתה מציגה
// מחיר ישן כמחיר הנוכחי של הלקוח.
check(
  "המחיר האחרון נלקח מהתאריך המאוחר גם כשהוא ראשון בקובץ",
  only([
    row({ date: "2026-06-30T10:41:00.000Z", price: 19.8 }),
    row({ date: "2025-09-15T11:21:00.000Z", price: 18.4 }),
  ]).lastPrice,
  19.8
);

check(
  "מוצרים שונים אינם מתמזגים",
  aggregateRows([row({ sku: "83" }), row({ sku: "39", name: "חלב" })]).items.length,
  2
);

// המיון קובע מה מוצג ראשון במסך — "מה הלקוח באמת קונה"
check(
  "המיון הוא לפי מספר הקניות, יורד",
  aggregateRows([
    row({ sku: "39", name: "חלב" }),
    row({ sku: "83" }),
    row({ sku: "83" }),
  ]).items.map((i) => i.sku),
  ["83", "39"]
);

section("כמויות חריגות");

// שורת זיכוי בכמות שלילית: הלקוח כן נגע במוצר, אבל הקיזוז אינו מוריד את
// המונה — סכום ששוקע למינוס היה מדרג מוצר שוטף מתחת למוצר חד-פעמי
const credit = only([row({ quantity: 10 }), row({ quantity: -10 })]);
check("שורת זיכוי נספרת כשורה", credit.lines, 2);
check("אבל אינה מקזזת את הכמות", credit.totalQty, 10);
check("כמות חסרה אינה מפילה את השורה", only([row({ quantity: undefined })]).lines, 1);

section("מחירים");

check("מחיר 0 אינו נכנס לטווח", only([row({ price: 0 })]).minPrice, null);
check(
  "מחיר כמחרוזת עם מפריד אלפים נקרא",
  only([row({ price: "1,319.38" })]).maxPrice,
  1319.38
);

section("תאריכים");

// ‏Date.parse קורא "05/06/2026" בסדר האמריקאי — 6 במאי במקום 5 ביוני, ועוד
// באזור הזמן של השרת. פורמט שאינו ISO נדחה כ"אין תאריך" ולא "מנורמל"
check("פורמט dd/mm גולמי נדחה ואינו מתהפך", only([row({ date: "05/06/2026" })]).lastAt, null);
check("תאריך מחוץ לטווח שפוי נדחה", only([row({ date: "1800-01-01" })]).lastAt, null);
check("מספר סידורי גולמי נדחה", only([row({ date: 46203 })]).lastAt, null);
check("שורה בלי תאריך נשמרת", only([row({ date: undefined })]).lines, 1);
check(
  "ובלי תאריך המחיר עדיין נלקח",
  only([row({ date: undefined, price: 7.5 })]).lastPrice,
  7.5
);

section("שורות פסולות");

check("שורה בלי מק\"ט נפסלת", aggregateRows([row({ sku: "" })]).items.length, 0);
check(
  "והסיבה מדווחת עם מספר השורה",
  aggregateRows([row({ rowNumber: 12, sku: "" })]).invalid[0].message,
  'חסר מק"ט'
);
check(
  "מק\"ט ארוך מדי נפסל",
  aggregateRows([row({ sku: "x".repeat(65) })]).invalid[0].message,
  'מק"ט ארוך מדי'
);

// ── הזרקה דרך גוף הבקשה ──
//
// גוף הבקשה הוא JSON חופשי. בלי בדיקת פרימיטיביות `String({$ne:null})` הוא
// "[object Object]" — מחרוזת לא ריקה שעוברת את "חסר מק\"ט" ונשמרת כמפתח
// התאמה, ומכיוון שהיבוא דורס היא מחליפה פרופיל תקין.
const injected = aggregateRows([row({ sku: { $ne: null } })]);
check("מק\"ט שאינו פרימיטיבי נפסל", injected.items.length, 0);
check("ואינו הופך ל-[object Object]", injected.invalid[0].sku, "");
check(
  "כמות שאינה פרימיטיבית אינה מזהמת את הסכום",
  only([row({ quantity: { $gt: 0 } })]).totalQty,
  0
);

section("גבולות");

check("קלט ריק אינו קורס", aggregateRows([]).items.length, 0);
check(
  "שם ארוך נחתך ל-200 תווים",
  only([row({ name: "א".repeat(500) })]).name.length,
  200
);
check(
  "השם נלקח מהמופע הראשון שהיה לו שם",
  only([row({ name: "" }), row({ name: "קפה טורקי" })]).name,
  "קפה טורקי"
);

// ───────────────────────────────────────────────────────────────

section("שיוך הקובץ ללקוח");

// הכלל הזה הוא ההגנה היחידה מפני הכשל שאינו נראה בשום מסך: היסטוריה של לקוח
// אחד שנשמרת על כרטיס של אחר. הפרופיל ייראה תקין לגמרי, והמערכת תתחיל להכריע
// את ההזמנות שלו לפי מה שלקוח אחר קונה.
const cmp = (card, file) => {
  const r = compareCustomerNumbers(card, file);
  return r.comparable ? (r.matches ? "תואם" : "לא תואם") : "אין השוואה";
};

check("מספר זהה", cmp("755", ["755"]), "תואם");
check("מספר שונה", cmp("755", ["999"]), "לא תואם");
// קובץ עם כמה מספרים הוא ייצוא של כמה לקוחות. הניסוח הראשון הסתפק בכך
// שהמספר שלנו נמצא ביניהם — כלומר ייחס לכרטיס הזה שורות של אחרים.
check("קובץ עם כמה לקוחות אינו תואם גם כשאנחנו ביניהם", cmp("755", ["755", "999"]), "לא תואם");
check("כרטיס בלי מספר הנהח\"ש — אין מה להשוות", cmp("", ["755"]), "אין השוואה");
check("קובץ בלי עמודת מספר לקוח — אין מה להשוות", cmp("755", []), "אין השוואה");
check("שניהם חסרים", cmp("", []), "אין השוואה");

// ───────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
if (failures.length) {
  console.log(`נכשלו ${failures.length} בדיקות מתוך ${passed + failures.length}:`);
  failures.forEach((f) => console.log(`  • ${f}`));
  process.exit(1);
}
console.log(`כל ${passed} הבדיקות עברו.`);

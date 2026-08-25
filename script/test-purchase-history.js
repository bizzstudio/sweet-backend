// script/test-purchase-history.js
//
// בדיקת שובר השוויון "מה הלקוח קונה בפועל" — הרצה: npm run history:test
//
// ── למה זה קיים כסקריפט, ולמה בלי מסד ──
//
// ההיסטוריה נכנסת לצינור כדי לאשר שורות אוטומטית, כלומר טעות כאן מכניסה מוצר
// שגוי להזמנה בלי שאיש יעצור אותה. מה שמפריד בין "המערכת יודעת" ל"המערכת
// מנחשת" הוא בדיוק הגבול בין decisive ל-hint, וזה מה שנבדק כאן.
//
// ‏pickFromHistory היא פונקציה טהורה: היא מקבלת מועמדים ופרופיל ומחזירה הכרעה.
// לכן הבדיקה אינה נוגעת במסד ואינה תלויה בשעון — הזמן מוזרק. בדיקה שתלויה
// בקטלוג הייתה מודדת את מנוע ההתאמה במקום את כללי ההכרעה.

const {
  buildPurchaseProfile,
  pickFromHistory,
  FRESH_MONTHS,
  REPEAT_LINES,
  DOMINANCE_RATIO,
} = require("../utils/purchaseHistoryRanking");

let passed = 0;
const failures = [];

const check = (label, actual, expected) => {
  if (actual === expected) {
    passed += 1;
    console.log(`  ✓ ${label}`);
    return;
  }
  failures.push(`${label} — ציפינו "${expected}", התקבל "${actual}"`);
  console.log(`  ✗ ${label}\n      ציפינו: ${expected}\n      התקבל:  ${actual}`);
};

const section = (title) => console.log(`\n── ${title} ──`);

// שעון קבוע. בלי זה בדיקת "לפני 7 חודשים" הייתה משנה תוצאה עם הזמן, וכשל
// היה מופיע חודשים אחרי השינוי שגרם לו.
const NOW = Date.parse("2026-08-25T00:00:00Z");
const monthsAgo = (n) => new Date(NOW - n * 30.44 * 24 * 60 * 60 * 1000);

// מוצרים סינתטיים: לבדיקה הזו חשוב רק המזהה והמק"ט, לא התוכן
const product = (id, title, sku) => ({ _id: id, title: { he: title }, sku });

const COLA_CANS = product("aaa1", "פחיות קולה זירו 24 יח", "1201");
const COLA_1L = product("aaa2", 'קוקה קולה זירו 1 ליטר', "1202");
const COLA_15 = product("aaa3", "קוקה קולה זירו לימון 1.5 ליטר", "1203");

const pool = (...products) => products.map((p, i) => ({ product: p, score: 1000 - i }));

const tierOf = (result) => (result ? result.tier : "אין אות");
const chosenOf = (result) => (result ? result.product.title.he : "—");

// ───────────────────────────────────────────────────────────────

section("אין אות");

check(
  "פרופיל ריק אינו מכריע",
  tierOf(pickFromHistory(pool(COLA_CANS, COLA_1L), buildPurchaseProfile([]), { now: NOW })),
  "אין אות"
);

check(
  "אף מועמד אינו בהיסטוריה",
  tierOf(
    pickFromHistory(
      pool(COLA_CANS, COLA_1L),
      buildPurchaseProfile([{ sku: "9999", product: "zzz9", lines: 5, lastAt: monthsAgo(1) }]),
      { now: NOW }
    )
  ),
  "אין אות"
);

check(
  "בלי פרופיל כלל (לקוח בלי היסטוריה) אינו קורס",
  tierOf(pickFromHistory(pool(COLA_CANS), null, { now: NOW })),
  "אין אות"
);

// ───────────────────────────────────────────────────────────────

section("פגיעה יחידה");

const singleHit = (lines, lastAt) =>
  pickFromHistory(
    pool(COLA_CANS, COLA_1L, COLA_15),
    buildPurchaseProfile([{ sku: "1202", product: "aaa2", lines, lastAt }]),
    { now: NOW }
  );

check("מוצר שוטף (5 קניות, החודש) מכריע", tierOf(singleHit(5, monthsAgo(0.5))), "decisive");

check(
  `קנייה חד-פעמית טרייה (בתוך ${FRESH_MONTHS} חודשים) מכריעה`,
  tierOf(singleHit(1, monthsAgo(FRESH_MONTHS - 1))),
  "decisive"
);

check(
  "קנייה חד-פעמית מלפני שנתיים אינה מכריעה",
  tierOf(singleHit(1, monthsAgo(24))),
  "hint"
);

check(
  `קנייה ישנה אך חוזרת (${REPEAT_LINES} קניות) מכריעה`,
  tierOf(singleHit(REPEAT_LINES, monthsAgo(24))),
  "decisive"
);

check("המוצר שנבחר הוא זה שבהיסטוריה", chosenOf(singleHit(5, monthsAgo(1))), "קוקה קולה זירו 1 ליטר");

check(
  "פריט בלי תאריך וקנייה אחת אינו מכריע",
  tierOf(singleHit(1, null)),
  "hint"
);

// ───────────────────────────────────────────────────────────────

section("שתי פגיעות — כאן נמצא הגבול המסוכן");

const twoHits = (linesA, monthsA, linesB, monthsB) =>
  pickFromHistory(
    pool(COLA_CANS, COLA_1L, COLA_15),
    buildPurchaseProfile([
      { sku: "1201", product: "aaa1", lines: linesA, lastAt: monthsAgo(monthsA) },
      { sku: "1202", product: "aaa2", lines: linesB, lastAt: monthsAgo(monthsB) },
    ]),
    { now: NOW }
  );

check(
  `שליטה ברורה (12 מול 1) מכריעה`,
  tierOf(twoHits(12, 1, 1, 1)),
  "decisive"
);

check("ובוחרת את השולט", chosenOf(twoHits(12, 1, 1, 1)), "פחיות קולה זירו 24 יח");

check(
  "שני מוצרים שהלקוח באמת קונה (5 מול 4) אינם מוכרעים",
  tierOf(twoHits(5, 1, 4, 1)),
  "hint"
);

check(
  `בדיוק על הסף (פי ${DOMINANCE_RATIO}) מכריע`,
  tierOf(twoHits(3 * REPEAT_LINES, 1, REPEAT_LINES, 1)),
  "decisive"
);

check(
  "מוצר ישן עם הרבה קניות מול מוצר טרי — הדעיכה מקרבת ביניהם",
  tierOf(twoHits(9, 36, 3, 0.5)),
  "hint"
);

// ───────────────────────────────────────────────────────────────

section("התאמה לפי מק\"ט כשאין קישור למוצר");

check(
  "שורה בלי product נתפסת לפי המק\"ט",
  chosenOf(
    pickFromHistory(
      pool(COLA_CANS, COLA_15),
      buildPurchaseProfile([{ sku: "1203", product: null, lines: 4, lastAt: monthsAgo(1) }]),
      { now: NOW }
    )
  ),
  "קוקה קולה זירו לימון 1.5 ליטר"
);

check(
  "מק\"ט עם אפס מוביל בקטלוג מתאים למק\"ט המספרי בהיסטוריה",
  chosenOf(
    pickFromHistory(
      pool(product("bbb1", "מוצר מאופס", "0077"), COLA_CANS),
      buildPurchaseProfile([{ sku: "77", product: null, lines: 4, lastAt: monthsAgo(1) }]),
      { now: NOW }
    )
  ),
  "מוצר מאופס"
);

// ───────────────────────────────────────────────────────────────

section("יציבות — אותה שאלה, אותה תשובה");

// ── למה זה נבדק ──
//
// מועמד שחוזר פעמיים בבריכה נספר פעם אחת בלבד. בלי הדה-דופליקציה הוא היה
// נראה כשני מוצרים שונים שנמצאים שניהם בהיסטוריה — כלומר הכרעה ודאית הייתה
// הופכת ל"התלבטות", בדיוק הפוך מהאמת.
check(
  "מועמד כפול בבריכה אינו הופך הכרעה להתלבטות",
  tierOf(
    pickFromHistory(
      [...pool(COLA_1L, COLA_CANS), { product: COLA_1L, score: 900 }],
      buildPurchaseProfile([{ sku: "1202", product: "aaa2", lines: 5, lastAt: monthsAgo(1) }]),
      { now: NOW }
    )
  ),
  "decisive"
);

// שני מועמדים זהים לחלוטין בסטטיסטיקה: בלי שובר שוויון מפורש הבחירה הייתה
// נקבעת לפי סדר השליפה מהמסד, כלומר אותה הזמנה יכולה לבחור מוצר אחר בהרצה
// חוזרת. שם המוצר בהודעה לעובד היה משתנה בין רענון לרענון.
const identicalProfile = buildPurchaseProfile([
  { sku: "1201", product: "aaa1", lines: 3, lastAt: monthsAgo(2) },
  { sku: "1202", product: "aaa2", lines: 3, lastAt: monthsAgo(2) },
]);

check(
  "תיקו מלא מוכרע באותה דרך בשני סדרי קלט",
  chosenOf(pickFromHistory(pool(COLA_CANS, COLA_1L), identicalProfile, { now: NOW })),
  chosenOf(pickFromHistory(pool(COLA_1L, COLA_CANS), identicalProfile, { now: NOW }))
);

check("ותיקו מלא אינו מכריע", tierOf(pickFromHistory(pool(COLA_CANS, COLA_1L), identicalProfile, { now: NOW })), "hint");

check(
  "תאריך עתידי אינו מנפח משקל מעבר להיום",
  tierOf(
    pickFromHistory(
      pool(COLA_CANS, COLA_1L),
      buildPurchaseProfile([
        { sku: "1201", product: "aaa1", lines: 2, lastAt: new Date(NOW + 400 * 24 * 3600 * 1000) },
        { sku: "1202", product: "aaa2", lines: 2, lastAt: monthsAgo(0) },
      ]),
      { now: NOW }
    )
  ),
  "hint"
);

// ───────────────────────────────────────────────────────────────

section("בניית הפרופיל");

// שני מק"טים בקובץ שמצביעים על אותו מוצר בקטלוג — קורה גם בגלל כפילויות
// בקטלוג וגם בגלל הנפילה המספרית ("77" מול "0077"). דריסה במקום מיזוג הייתה
// מורידה לקוח שקנה 9 פעמים ל-3, כלומר הכרעה ודאית הופכת לרמז.
const mergedProfile = buildPurchaseProfile([
  { sku: "1201", product: "aaa1", lines: 6, lastAt: monthsAgo(4) },
  { sku: "01201", product: "aaa1", lines: 3, lastAt: monthsAgo(1) },
]);

check("שתי שורות לאותו מוצר מתמזגות למונה אחד", mergedProfile.byProduct.get("aaa1").lines, 9);
check(
  "והתאריך האחרון הוא המאוחר מבין השניים",
  Math.round(mergedProfile.byProduct.get("aaa1").lastAt.getTime() / 1000),
  Math.round(monthsAgo(1).getTime() / 1000)
);
check("וספירת המוצרים אינה נכפלת", mergedProfile.size, 1);

// ‏bySku מחזיק גם מפתחות מספריים כנפילה, ולכן גודלו אינו מספר המוצרים.
// המספר הזה מוצג ביומן הקליטה, ומספר מנופח שם קורא כמו פרופיל עשיר יותר.
check(
  "ספירה נכונה גם כשיש מפתח מספרי נוסף",
  buildPurchaseProfile([{ sku: "0077", product: null, lines: 2, lastAt: monthsAgo(1) }]).size,
  1
);

check(
  "תאריך פגום מטופל כחסר ולא כ-Invalid Date",
  buildPurchaseProfile([{ sku: "1", product: "p1", lines: 1, lastAt: "לא תאריך" }])
    .byProduct.get("p1").lastAt,
  null
);

// ───────────────────────────────────────────────────────────────

section('התרחיש האמיתי: "פרכיות"');

// ששת המועמדים שנמדדו בהזמנה אמיתית, בהפרש נקודה אחת מתוך 18,428 — המקרה
// שבגללו המנגנון נבנה. אחד מהם נמצא בהיסטוריה של הלקוח.
const CRACKERS = [
  product("c1", "פרכיות אורז דקות", "3001"),
  product("c2", "פרכיות אורז מלא", "3002"),
  product("c3", "פרכיות תירס", "3003"),
  product("c4", "פרכיות כוסמין", "3004"),
  product("c5", "פרכיות אורז שוקולד", "3005"),
  product("c6", "פרכיות דגנים", "3006"),
];

const crackers = pickFromHistory(
  CRACKERS.map((p, i) => ({ product: p, score: 18428 - i })),
  buildPurchaseProfile([
    { sku: "3003", product: "c3", lines: 6, lastAt: monthsAgo(1), name: "פרכיות תירס" },
    { sku: "39", product: "milk", lines: 5, lastAt: monthsAgo(1) },
  ]),
  { now: NOW }
);

check("נבחר המוצר שהלקוח קונה", chosenOf(crackers), "פרכיות תירס");
check("וההכרעה ודאית", tierOf(crackers), "decisive");
check(
  "ההסבר לעובד מזכיר את המוצר ואת מספר הפעמים",
  crackers.reason.includes("פרכיות תירס") && crackers.reason.includes("6 פעמים"),
  true
);

// ───────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
if (failures.length) {
  console.log(`נכשלו ${failures.length} בדיקות מתוך ${passed + failures.length}:`);
  failures.forEach((f) => console.log(`  • ${f}`));
  process.exit(1);
}
console.log(`כל ${passed} הבדיקות עברו.`);

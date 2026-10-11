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
  coversAllWords,
  coversRequest,
  sameName,
  sharesProductWord,
  assortedOf,
  closestOwnProducts,
  guessStrength,
  FRESH_MONTHS,
  SINGLE_HIT_MAX_MONTHS,
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

// ── קנייה בודדת בלי מתחרה: חלון רחב ──
//
// נמדד בהזמנה אמיתית: "קלסר" — 15 בקטלוג, הלקוח קנה בדיוק אחד מהם, פעם אחת,
// לפני 8.7 חודשים. הכלל הישן (חצי שנה) החזיר רמז, השורה נשארה ב-0.53,
// ו**כל ההזמנה** נפלה — כי הביטחון הכולל הוא המינימום מבין הפריטים.
//
// ‏FRESH_MONTHS כויל על מכולת (חלב, קפה — שבועי). ציוד משרדי נקנה פעם בשנה.
check(
  "קנייה בודדת לפני 8.7 חודשים מכריעה (המקרה שנמדד)",
  tierOf(singleHit(1, monthsAgo(8.7))),
  "decisive"
);
check(
  `קנייה בודדת בגבול (${SINGLE_HIT_MAX_MONTHS} חודשים) עדיין מכריעה`,
  tierOf(singleHit(1, monthsAgo(SINGLE_HIT_MAX_MONTHS - 0.5))),
  "decisive"
);
check(
  "אבל קנייה בודדת עתיקה — לא",
  tierOf(singleHit(1, monthsAgo(SINGLE_HIT_MAX_MONTHS + 6))),
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

// ── והגבול: החלון הרחב חל **רק** כשאין מתחרה ──
//
// ברגע שהלקוח קנה שני מועמדים מהבריכה, יש ראיה שהוא בוחר ביניהם — וחד-פעמיות
// ישנה חייבת להיות טרייה כדי לגבור. אחרת קנייה אקראית מלפני שנה הייתה מנצחת
// מוצר שהוא קונה עכשיו.
check(
  `שני מועמדים: חד-פעמית מלפני ${FRESH_MONTHS + 3} חודשים אינה מכריעה`,
  tierOf(twoHits(1, FRESH_MONTHS + 3, 1, 1)),
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

section("שורה בלי כמות: האם היא בכלל שם מוצר");

// ── מה נשמר כאן ──
//
// שורה בלי כמות היא ניחוש של הפרסר שמדובר בפריט, ובאותו ניחוש נכנסות גם
// שורות כתובת. נמדד: "הרצל 5 בני ברק" קיבל 0.47 ו-"קומה 3 דירה 12" קיבל 0.6,
// בעוד "מגבות נייר" — מוצר אמיתי — ירד ל-0.53. ביטחון אינו יכול להפריד.
//
// מה שכן מפריד: שם מוצר **מתאר** את המוצר. אם כלל זה ייחלש, שורת כתובת
// תיכנס להזמנה כפריט ותצא במשלוח בלי שאיש ביקש אותה.
const titled = (he) => ({ title: { he } });

check(
  '"קפה טורקי" מתארת את המוצר',
  coversAllWords("קפה טורקי", titled("קפה טורקי עלית 200 גר")),
  true
);
check('מילה אחת מספיקה', coversAllWords("בננות", titled('בננות 1 ק"ג')), true);
check(
  "שורת כתובת אינה מתארת מוצר",
  coversAllWords("קומה 3 דירה 12", titled("עוגיות בקופסה 500 גר")),
  false
);
check(
  "וגם לא כתובת שהתאימה למוצר זבל בקטלוג",
  coversAllWords(
    "הרצל 5 בני ברק",
    titled("שכירות חודש 08/25 עבור נכס ברחוב בן גוריון 19")
  ),
  false
);
check(
  "מילה שהלקוח כתב ואינה בשם המוצר פוסלת",
  coversAllWords("קפה טורקי גדול", titled("קפה טורקי עלית 200 גר")),
  false
);
// מילה שלמה ולא substring — אחרת "תה" היה נחשב מופיע בתוך "פתה"
check("התאמה היא של מילה שלמה", coversAllWords("תה", titled("לחם פתה")), false);
check("גרשיים אינם משנים", coversAllWords('סוכר 1 קג', titled('סוכר 1 ק"ג בשקית')), true);
check("טקסט ריק אינו עובר", coversAllWords("", titled("קפה")), false);
check("מוצר בלי שם אינו עובר", coversAllWords("קפה", {}), false);

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

section('רגרסיה: "קלסר" — המוצר שנחתך מחוץ לחלון');

// ── מה קרה בפועל ──
//
// לקוח כתב "6 קלסר". בקטלוג 15 מוצרי קלסר, והמוצר שהוא קונה (2053) דורג
// במקום 11. חלון החלופות היה 9, ולכן הוא נחתך — וההיסטוריה מעולם לא ראתה
// אותו. השורה הגיעה לטיפול ידני למרות שהתשובה הייתה בקובץ.
//
// ההפרש שהכריע: 12024.2 מול 12026.4 — 2.2 נקודות מתוך 12,026, כלומר 0.02%
// שמקורו בקנס אורך שם. זה רעש, ולא הבדל שמצדיק חיתוך.
//
// הבדיקה מריצה את מנוע הדירוג האמיתי על 15 השמות האמיתיים.
const { rankProductsByRelevance } = require("../utils/productMatching");

const BINDERS = [
  ["51", "קלסר גב 8 משרדי צבעוני 1 יח' (ח')"],
  ["718", "קלסר פרה גב 8 משרדי 1 יח' (ח')"],
  ["796", "קלסר גב 5 משרדי פרה 1 יחידה"],
  ["1506", "קלסר חצי פוליו רחב"],
  ["2053", "קלסר משרדי פרה גב 8 גדול 1 יח"], // זה שהלקוח קונה
  ["3726", "קלסר חצי שקוף 1 יח'"],
  ["3794", "קלסר משרדי עבה גב 8 מפלסטיק  1 יח'"],
  ["3899", "קלסר משרדי דק  גב 5 מפלסטיק 1 יח'"],
  ["3981", "קלסר משרדי גב 8 צבעוני פלסטיק"],
  ["4007", "קלסר גב 3 פרה 1 יחידה"],
  ["4103", "קלסר חצי פוליו רחב צבעוני"],
  ["4177", "קלסר/ תיק טבעות דק פלסטיק"],
  ["4290", "קלסר גב 5 משרדי צבעוני(ח')"],
  ["3153", "קלסר גב 5 משרדי 1 יח' (ח')"],
  ["3279", "קלסר חצי שקוף צבעוני 1 יחידה(ח')"],
];

const binderRanked = rankProductsByRelevance(
  BINDERS.map(([sku, he]) => ({ _id: sku, sku, title: { he } })),
  "קלסר",
  ["קלסר"],
  []
);

// הפרופיל: הלקוח קנה את 2053 פעם אחת, לפני חודשיים
const binderProfile = buildPurchaseProfile([
  { sku: "2053", product: "2053", lines: 1, lastAt: monthsAgo(2) },
]);

const poolOf = (size) => binderRanked.slice(0, size).map((r) => ({ product: r.product }));

check(
  "המוצר של הלקוח אינו במקומות הראשונים",
  binderRanked.findIndex((r) => r.product.sku === "2053") + 1,
  11
);

// זה מה שהיה קורה לפני התיקון: חלון של 9 (מוביל + 8 חלופות)
check("חלון של 9 מפספס אותו לגמרי", tierOf(pickFromHistory(poolOf(9), binderProfile, { now: NOW })), "אין אות");

// וזה מה שקורה עכשיו
const binderPick = pickFromHistory(poolOf(20), binderProfile, { now: NOW });
check("הבריכה המלאה מוצאת אותו", chosenOf(binderPick), "קלסר משרדי פרה גב 8 גדול 1 יח");
check("וההכרעה ודאית — קנייה אחת אך עדכנית", tierOf(binderPick), "decisive");

// ── ולמה זה לא הופך את המנגנון לרשלני ──
//
// בריכה רחבה יכולה גם להוריד הכרעה לרמז, כשמתגלה שהלקוח קונה **כמה** מהם.
// זו התוצאה הנכונה: החלון הצר נתן ביטחון שגוי, כי הוא הסתיר מתחרה אמיתי.
check(
  "כשגם מוצר שני בבריכה נקנה — יורד לרמז, ולא מכריע בטעות",
  tierOf(
    pickFromHistory(
      poolOf(20),
      buildPurchaseProfile([
        { sku: "2053", product: "2053", lines: 1, lastAt: monthsAgo(2) },
        { sku: "1506", product: "1506", lines: 1, lastAt: monthsAgo(2) },
      ]),
      { now: NOW }
    )
  ),
  "hint"
);

// ───────────────────────────────────────────────────────────────

section("רגרסיה: כלל השתיקה מוחק בדיוק את מה שההיסטוריה יודעת");

// ── מה נמדד ──
//
// ‏applyQualifiers מסיים בכלל של שתיקה: "הלקוח לא כתב 50 יח, מכאן שלא רצה
// 50 יח". אצל לקוח אמיתי הכלל הזה מחק בדיוק את המוצרים שהוא קונה בקביעות:
//
//     "כפיות"      21 מועמדים → 6    (הכפיות שהוא קונה 4 פעמים נמחקו)
//     "נייר טואלט" 27 → 8
//     "כוסות"      91 → 2
//
// בכל השלושה ההיסטוריה החזירה "אין אות" — לא כי לא ידעה, אלא כי המוצר סולק
// לפני שהגיעה אליו. לכן היא עובדת מול keptBeforeSilentDrops.
const {
  applyQualifiers,
  extractQualifiers,
  withoutPlainWords,
} = require("../lib/order-ingestion/qualifiers");

const SPOONS = [
  { _id: "s1", sku: "1308", title: { he: "כפיות ח.פעמי שקוף קשיח 50 יח" } },
  { _id: "s2", sku: "380", title: { he: "כפיות חד פעמי 100 יח" } },
  { _id: "s3", sku: "s3", title: { he: "כפיות מתכת" } },
];

const spoonRes = applyQualifiers(
  SPOONS.map((p, i) => ({ product: p, score: 1000 - i })),
  extractQualifiers("כפיות")
);

check("כלל השתיקה אכן מסלק את בעלות המניין", spoonRes.kept.length, 1);
check("והבריכה שלפניו שומרת את כולן", spoonRes.keptBeforeSilentDrops.length, 3);

const spoonProfile = buildPurchaseProfile([
  { sku: "1308", product: "s1", lines: 4, lastAt: monthsAgo(2) },
]);

check(
  "מול kept — ההיסטוריה עיוורת",
  tierOf(pickFromHistory(spoonRes.kept.map((k) => ({ product: k.product })), spoonProfile, { now: NOW })),
  "אין אות"
);
check(
  "מול keptBeforeSilentDrops — היא מזהה",
  chosenOf(
    pickFromHistory(
      spoonRes.keptBeforeSilentDrops.map((k) => ({ product: k.product })),
      spoonProfile,
      { now: NOW }
    )
  ),
  "כפיות ח.פעמי שקוף קשיח 50 יח"
);

// ── והגבול שלא נפרץ ──
//
// כלל השתיקה הוא ניחוש, ולכן ההיסטוריה גוברת עליו. שלילה מפורשת אינה ניחוש —
// היא המשפט היחיד שהלקוח טרח לכתוב — והיא מסננת **לפני** נקודת החיתוך.
const negRes = applyQualifiers(
  SPOONS.map((p, i) => ({ product: p, score: 1000 - i })),
  extractQualifiers("כפיות (לא 50 יח)")
);
check(
  "שלילה מפורשת מסלקת גם מהבריכה שלפני כלל השתיקה",
  negRes.keptBeforeSilentDrops.some((k) => k.product._id === "s1"),
  false
);
check(
  "וההיסטוריה אינה מחזירה את מה שנשלל",
  tierOf(
    pickFromHistory(
      negRes.keptBeforeSilentDrops.map((k) => ({ product: k.product })),
      spoonProfile,
      { now: NOW }
    )
  ),
  "אין אות"
);

// ── ולמה זה לא הופך את המנגנון לרשלני ──
//
// כשהלקוח קונה **גם** את המניין השני, שתי הפגיעות מבטלות זו את זו והשורה
// חוזרת לאדם — בדיוק מה שקורה אצלו במציאות ב-"כפיות" (50 יח פי 4, 100 יח פי 2).
check(
  "שני מניינים שהלקוח קונה — רמז ולא הכרעה",
  tierOf(
    pickFromHistory(
      spoonRes.keptBeforeSilentDrops.map((k) => ({ product: k.product })),
      buildPurchaseProfile([
        { sku: "1308", product: "s1", lines: 4, lastAt: monthsAgo(2) },
        { sku: "380", product: "s2", lines: 2, lastAt: monthsAgo(2) },
      ]),
      { now: NOW }
    )
  ),
  "hint"
);

// ───────────────────────────────────────────────────────────────

section("נעילה: השליפה הקלה לא תדליף מסמך חלקי לעגלה");

// ── מה נשמר כאן ──
//
// בשליפה רחבה נמשכים מסמכים מפורייקטדים (בלי description/image/prices), והמוביל
// נשלף מחדש במלואו. הקוד שמעלינו מזהה "מסמך רזה" בדיוק לפי `prices === undefined`
// (ראה resolvers), ולכן ברגע ש-prices ייכנס לפרויקציה מסמך חלקי ייראה מלא —
// וייכנס לעגלה בלי מחיר, בלי slug ובלי תמונה. כשל שקט לחלוטין.
const matcherSource = require("fs").readFileSync(
  require("path").join(__dirname, "../utils/productMatching.js"),
  "utf8"
);
const lightSelect = /const LIGHT_SELECT = "([^"]+)"/.exec(matcherSource)?.[1] || "";

check("הפרויקציה הקלה אינה כוללת prices", lightSelect.split(" ").includes("prices"), false);
check("אך כוללת את מה שהדירוג צריך", lightSelect.split(" ").includes("title"), true);
check("ואת מה שהשוואת המק\"ט צריכה", lightSelect.split(" ").includes("sku"), true);
// השליפה הרחבה נדלקת רק מעל ברירת המחדל — לקוח בלי היסטוריה אינו נוגע בה
check(
  "השליפה הקלה מותנית בחריגה מברירת המחדל",
  /candidateLimit > DEFAULT_CANDIDATE_LIMIT/.test(matcherSource),
  true
);
check(
  "והמוביל נשלף מחדש במלואו",
  /if \(lightFetch\) \{[\s\S]{0,120}Product\.findById/.test(matcherSource),
  true
);

// ───────────────────────────────────────────────────────────────

section("ההגנה מפני שורות שיחה: כיסוי, לא רשימה שחורה");

// ── למה זו ההגנה ──
//
// רשימת מילות מילוי תמיד תהיה חלקית, וכל מילה שנשכחה מפילה **הזמנה שלמה**
// (הביטחון הכולל הוא המינימום מבין הפריטים). ביטחון אינו יכול להחליף אותה:
// נמדד על הקטלוג האמיתי — "מה נשמע" 0.6, "סבבה גמור" 0.6, "נו טוב" 0.6,
// מול "מגבות נייר" 0.53 ו-"קלסר" 0.53. הטווחים חופפים לחלוטין.
//
// ‏coversAllWords מפריד: 60 ביטויי שיחה מול הקטלוג המלא → אחד בלבד מכוסה;
// 67 שמות מוצר אמיתיים → אף אחד לא נפסל.
const MINI_CATALOG = [
  "מגבות נייר ביתי שישייה",
  "עוגיות בקופסה 500 גר' פלסטיק 26 טעמים",
  "מכסה לכוסות OZ8 נייר 100 יח",
  "קלסר משרדי פרה גב 8 גדול 1 יח",
  "חלב טרי בקרטון 1 ליטר 3% טרה/תנובה",
  'בוטנים "סבבה" עלית',
  "נקניקיות עוף טוב",
  "גבינת עיזים מה עז צוריאל 9%",
].map((he) => ({ title: { he } }));

const covered = (text) => MINI_CATALOG.some((p) => coversAllWords(text, p));

// שלוש אלה הן המסוכנות: הן מקבלות ביטחון **גבוה** משם מוצר אמיתי, כי הן
// חולקות מילה אחת עם מוצר בקטלוג. הכיסוי דורש את **כל** המילים.
check('"מה נשמע" אינה מכוסה (למרות "מה עז")', covered("מה נשמע"), false);
check('"סבבה גמור" אינה מכוסה (למרות "סבבה")', covered("סבבה גמור"), false);
check('"נו טוב" אינה מכוסה (למרות "עוף טוב")', covered("נו טוב"), false);
check('"שכחתי" אינה מכוסה', covered("שכחתי"), false);
check('"תני לי לבדוק" אינה מכוסה', covered("תני לי לבדוק"), false);

// והצד השני — אלה חייבות לעבור
check('"מגבות נייר" מכוסה', covered("מגבות נייר"), true);
check('"עוגיות בקופסה" מכוסה', covered("עוגיות בקופסה"), true);
check('"מכסה לכוסות" מכוסה', covered("מכסה לכוסות"), true);
check('"קלסר" מכוסה', covered("קלסר"), true);
check('"חלב טרי" מכוסה', covered("חלב טרי"), true);

// ───────────────────────────────────────────────────────────────

section("אותו מוצר, מילים אחרות");

// ── מה נשמר כאן ──
//
// לקוח מזמין בשפה שלו והקטלוג כתוב בשפת ההנהח"ש. אלה **אינן עמימות** — זה
// אותו מוצר בדיוק — ובלי הנרמול כל אחת נראית כשורה שאינה מתארת מוצר ומגיעה
// לאדם. נמדד: 17 מתוך 18 ניסוחים חופשיים נכנסים, ו-0 מתוך 30 ביטויי שיחה.
const CATALOG_SAMPLE = [
  "חלב טרי בקרטון 1 ליטר 3% טרה/תנובה",
  'סוכר 1 ק"ג בשקית',
  "עוגיות בקופסה 500 גר' פלסטיק 26 טעמים",
  "קפה טורקי עלית 200 גר",
  "מגבות נייר ביתי שישייה",
  "ביצים 30 יח",
].map((he) => ({ title: { he } }));

const anyCovers = (text) => CATALOG_SAMPLE.some((p) => coversAllWords(text, p));

check('"חלב 3 אחוז" ↔ "חלב טרי 3%"', anyCovers("חלב 3 אחוז"), true);
check('"סוכר קילו" ↔ \'סוכר 1 ק"ג\'', anyCovers("סוכר קילו"), true);
check('"עוגיות בקופסא" ↔ "בקופסה" (כתיב)', anyCovers("עוגיות בקופסא"), true);
check('"קפה טורקי 200 גרם" ↔ "200 גר"', anyCovers("קפה טורקי 200 גרם"), true);
check('"מגבות נייר שישיה" ↔ "שישייה"', anyCovers("מגבות נייר שישיה"), true);
check('"ביצים 30 יחידות" ↔ "30 יח"', anyCovers("ביצים 30 יחידות"), true);

// ── והגבול: הנרמול אינו הופך שיחה למוצר ──
//
// הוא מוחל על **שני** הצדדים, ולכן מילה שאינה בקטלוג אינה הופכת פתאום לקיימת.
["מה נשמע", "סבבה גמור", "תני לי לבדוק", "שכחתי", "נו טוב"].forEach((line) =>
  check(`"${line}" עדיין אינה מוצר`, anyCovers(line), false)
);

// מפרט שבאמת אינו בקטלוג ממשיך להגיע לאדם — הנרמול אינו ממציא התאמות
check('"נס קפה צנצנת" — "צנצנת" באמת לא בקטלוג', anyCovers("נס קפה צנצנת"), false);

// ───────────────────────────────────────────────────────────────

section('"רגיל" — בקשה מפורשת לגרסה הבסיסית (04/10/26)');

{
  // #140225: 683 מול 519 — ההיסטוריה לא הכריעה כי שתי הגרסאות בבריכה
  const P = (id, he) => ({ product: { _id: id, title: { he } }, score: 10 });
  const milkPool = [
    P("cafe", "חלב לקפה"),
    P("goat", "חלב עיזים"),
    P("plain", "חלב טרי בקרטון 1 ליטר 3% טרה/תנובה"),
    P("soy", "חלב סוייה טרי מגוון סוגים"),
    P("lact", "חלב דל לקטוז/נטול לקטוז 1 ליטר"),
  ];
  const recent = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const milkProfile = {
    byProduct: new Map([
      ["plain", { lines: 683, totalQty: 683, lastAt: recent }],
      ["soy", { lines: 519, totalQty: 519, lastAt: recent }],
      ["lact", { lines: 189, totalQty: 189, lastAt: recent }],
    ]),
    bySku: new Map(),
  };
  const plainPool = applyQualifiers(milkPool, extractQualifiers("חלב רגיל")).keptBeforeSilentDrops;
  check("בלי הסינון — רמז בלבד", pickFromHistory(milkPool, milkProfile).tier, "hint");
  const decided = pickFromHistory(plainPool, milkProfile);
  check('"חלב רגיל" — ההיסטוריה מכריעה', decided && `${decided.tier}:${decided.product._id}`, "decisive:plain");
  // הכיסוי המלא נשאר קפדני — אחרת הבחירה האוטומטית הייתה מכניסה "חלב לקפה"
  // ללקוח בלי היסטוריה. רק מבחן ההיסטוריה מקבל את השם בלי "רגיל".
  check('"חלב רגיל" אינו מכוסה ב"חלב לקפה"', coversAllWords("חלב רגיל", milkPool[0].product), false);
  check('בלי "רגיל" — מכוסה ב"חלב טרי 3%"', coversAllWords(withoutPlainWords("חלב רגיל"), milkPool[2].product), true);
  check("withoutPlainWords אינו פוגע במילה שמכילה רגיל", withoutPlainWords("חלב רגילות טרי"), "חלב טרי");

  const soyKept = applyQualifiers(
    [P("s1", "חלב סויה ביו עמיד"), P("s2", "חלב סויה בטעם וניל")],
    extractQualifiers("חלב סויה רגיל")
  ).kept.map((k) => k.product._id);
  check('"חלב סויה רגיל" שומר סויה ופוסל טעם', soyKept.join(","), "s1");

  const catalogPlain = applyQualifiers(
    [P("n", "גבינה צהובה נועם רגיל/לייט 360"), P("l", "גבינה צהובה לייט 9%")],
    extractQualifiers("גבינה צהובה רגילה")
  ).kept.map((k) => k.product._id);
  check('מוצר שנושא "רגיל" בשמו אינו נפסל', catalogPlain.join(","), "n");
}

// ───────────────────────────────────────────────────────────────

section('"חלב 3%" — המידה חסרה בחלון הצר וקיימת בבריכה הרחבה (11/10/26)');

{
  // 11 הזמנות אמת נפלו כאן: החלון הצר לא מכיל אף חלב 3%, המידה סומנה "אינה
  // בקטלוג", וזה חסם את ההיסטוריה — אף שהמוצר קיים והלקוח קנה אותו 972 פעמים.
  // resolvers נשען על שתי העובדות שנבדקות כאן: הבריכה הרחבה אינה מדווחת
  // אי-התאמה, ומי ששרד בה נושא את המידה.
  const P = (id, he) => ({ product: { _id: id, title: { he } }, score: 10 });
  const narrow = [P("cafe", "חלב לקפה"), P("goat", "חלב עיזים"), P("gad", "חלב גד 1 ליטר")];
  const wide = [
    ...narrow,
    P("fresh3", "חלב טרי בקרטון 1 ליטר 3% טרה/תנובה"),
    P("fresh1", "חלב טרי בקרטון 1 ליטר 1% טרה/תנובה"),
    P("homo", "חלב הומוגני 3% / 1% מועשר שטראוס בקבוק"),
  ];
  const recent = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const profile = {
    byProduct: new Map([
      ["fresh3", { lines: 972, totalQty: 972, lastAt: recent }],
      ["fresh1", { lines: 598, totalQty: 598, lastAt: recent }],
      ["homo", { lines: 12, totalQty: 12, lastAt: recent }],
    ]),
    bySku: new Map(),
  };
  const qualifiers = extractQualifiers("חלב 3%");

  check("בחלון הצר המידה חסרה", applyQualifiers(narrow, qualifiers).sizeMismatch, true);

  const wideResult = applyQualifiers(wide, qualifiers);
  check("בבריכה הרחבה היא נמצאת", wideResult.sizeMismatch, false);
  check(
    "מי ששרד נושא 3% — ה-1% נפסל",
    wideResult.keptBeforeSilentDrops.map((k) => k.product._id).sort().join(","),
    "fresh3,homo"
  );

  const decided = pickFromHistory(wideResult.keptBeforeSilentDrops, profile);
  check("ההיסטוריה מכריעה על החלב שהוא קונה", decided && `${decided.tier}:${decided.product._id}`, "decisive:fresh3");

  // מידה שבאמת אינה בקטלוג ממשיכה לעצור גם ברחבה
  check(
    '"חלב 5%" — אין כזה גם ברחבה',
    applyQualifiers(wide, extractQualifiers("חלב 5%")).sizeMismatch,
    true
  );
}

// ───────────────────────────────────────────────────────────────

section("מי שנושא את כל מה שהלקוח ביקש גובר על מי שחולק איתו מילה (11/10/26)");

{
  const P = (id, he) => ({ product: { _id: id, title: { he } }, score: 10 });
  const recent = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const profileOf = (entries) => ({
    byProduct: new Map(entries.map(([id, lines]) => [id, { lines, totalQty: lines, lastAt: recent }])),
    bySku: new Map(),
  });
  // אוצר המילים של הקטלוג: מה שנמצא בו הוא מילה תקינה ולא שגיאת כתיב
  const vocabulary = new Map(
    ["קינדר", "אצבעות", "קארד", "לימונים", "לימונית", "שלישיות", "שישיות", "כוסות"].map((w) => [w, 5])
  );
  const decide = (text, pool, profile) => {
    const r = pickFromHistory(pool, profile, { requestText: text, vocabulary });
    return r ? `${r.tier}:${r.product._id}${r.coversRequest ? "+covers" : ""}` : "אין אות";
  };

  // מתחרה שחולק מילת אריזה בלבד אינו מתחרה
  const kinder = [P("fingers", "אצבעות קינדר אריזה כפולה"), P("cards", "קינדר קארד"), P("bueno", "שוקולד קינדר בואנו זוגות")];
  const kinderProfile = profileOf([["fingers", 15], ["cards", 16], ["bueno", 13]]);
  check("בלי הטקסט — שלושה קינדר, רמז בלבד", pickFromHistory(kinder, kinderProfile).tier, "hint");
  check('"קינדר קארדס" — רק אחד נושא את שתי המילים', decide("קינדר קארדס", kinder, kinderProfile), "decisive:cards+covers");
  check('"קינדל אצבעות- חבילה" — שגיאת כתיב ומילת אריזה', decide("קינדל אצבעות- חבילה", kinder, kinderProfile), "decisive:fingers+covers");

  // מילה אחת שהמוצר אינו נושא משאירה את השורה לאדם
  const cups = [P("cold", "כוסות שתיה קרה 100 יח"), P("milk", "חלב טרי בקרטון 1 ליטר 3% טרה/תנובה")];
  const cupsProfile = profileOf([["cold", 121], ["milk", 974]]);
  check('"כוסות שתייה חמה" אינו "קרה"', coversRequest("קרטון כוסות שתייה חמה", cups[0].product), false);
  check("ולכן אין הכרעה לפי הכיסוי", decide("קרטון כוסות שתייה חמה", cups, cupsProfile), "decisive:milk");

  // "קרטון" הוא מכפלה ולא יחידת מכירה — שורה כזו אינה מכוסה
  check('"3 קרטונים" נשאר לאדם', coversRequest("בייגלה - 3 קרטונים", { title: { he: "בייגלה שטוחים" } }), false);
  check('"חבילה" כן מכוסה', coversRequest("בייגלה - חבילה", { title: { he: "בייגלה שטוחים" } }), true);

  // ניסוחים שמבחן הכיסוי המדויק הפיל
  check('"ולואיזה" מול "לואיזה"', coversRequest("תה לימונית לואיזה – חבילה", { title: { he: "תה ירוק לימונית ולואיזה" } }), true);

  // מספר שאינו בשם המוצר הוא כמות שלא נקראה או מידה אחרת — לא מכוסה
  check('"חלב רגיל 3% 50" — ה-50 אינו בשם', coversRequest("חלב 3% 50", { title: { he: "חלב טרי בקרטון 1 ליטר 3% טרה/תנובה" } }), false);
  check('"חלב 3%" כן', coversRequest("חלב 3%", { title: { he: "חלב טרי בקרטון 1 ליטר 3% טרה/תנובה" } }), true);

  // שגיאת כתיב מתוקנת רק למילה שאינה בקטלוג, ורק כשיש אוצר מילים
  const tea = { title: { he: "תה ירוק לימונית ולואיזה" } };
  check('"לימונים" אינם "לימונית"', coversRequest("לימונים", tea, { vocabulary }), false);
  check('"שלישיות" אינן "שישיות"', coversRequest("נייר סופרה שלישיות", { title: { he: "נייר סופרה שישיות" } }, { vocabulary }), false);
  check("בלי אוצר מילים אין תיקון כתיב", coversRequest("קינדל אצבעות", kinder[0].product), false);

  // מוצר שחולק עם השורה רק מידה אינו מכריע
  const knives = [P("tea", "תה ויסוצקי 1.5 גר 100 יח"), P("cupsx", "כוסות שתייה קרה 100 יח")];
  const r = pickFromHistory(knives, profileOf([["tea", 696], ["cupsx", 4]]), {
    requestText: "סכינים חד פעמי 100 יח' בז'",
    vocabulary,
  });
  check("תה אינו ראיה לסכינים", `${r.tier}:${r.related}`, "decisive:false");

  // מילת גודל אינה קשר: "שקיות אשפה גדולות" מול "מסטיק בקופסה גדולה"
  const T = (he) => ({ title: { he } });
  check("גודל משותף אינו קשר", sharesProductWord("חב' שקיות פח אשפה גדולות", T("מסטיק מאסט/אורביט בקופסה גדולה"), { vocabulary }), false);
  check("יחיד מול רבים הוא קשר", sharesProductWord("נקטרינות", T('נקטרינה 1 ק"ג'), { vocabulary }), true);

  // יחיד/רבים — שלוש צורות בלבד
  check('"בננה" ↔ "בננות"', coversRequest("3 קילו בננה", T('בננות 3 ק"ג')), true);
  check('"לימונים" ↔ "לימון"', coversRequest("לימונים", T('לימון 1 ק"ג')), true);
  check('"חלב" אינו "חלבה"', coversRequest("חלב", T("חלבה לייט")), false);

  // אותו שם: גם שם המוצר אינו אומר דבר שהלקוח לא כתב
  check('"פסטרמה דק דק" — אותו שם', sameName("פסטרמה דק דק", T("פסטרמה  דק דק 120 גר'")), true);
  check('"3 קילו בננה" — אותו שם', sameName("3 קילו בננה", T('בננות 3 ק"ג')), true);
  check('"תפוח ירוק" אינו "תה ירוק תפוח וקינמון"', sameName("תפוח ירוק", T("תה ירוק תפוח וקינמון")), false);
  check('"קיסמים" אינם "קיסמים לניקוי אוזנים מעץ"', sameName("קיסמים", T("קיסמים לניקוי אוזנים מעץ")), false);
  check('"מי עדן" אינו "מעדן באדי"', sameName("מי עדן", T("מעדן באדי מגוון טעמים")), false);
  check('"עגבניה" אינה "עגבניות שרי"', sameName("עגבניה- 2 קילו", T('עגבניות שרי 2 ק"ג')), false);

  // מוצר "מגוון סוגים": הגרסה שהלקוח כתב היא הוראה למלקט
  const soy = T("חלב סויה טרי מגוון סוגים");
  check('"חלב סויה ללא סוכר" ← מגוון סוגים', assortedOf("חלב סויה ללא סוכר", soy), true);
  check('"חלב סויה במתיקות מופחתת"', assortedOf("חלב סויה במתיקות מופחתת", soy), true);
  check('"חלב" לבדו אינו חלב סויה', assortedOf("חלב", soy), false);
  check('"חלב סויה 12" — המספר הוא כמות שלא נקראה', assortedOf("חלב סויה 12", soy), false);
  check("מוצר רגיל אינו מגוון", assortedOf("חלב סויה ללא סוכר", T("חלב סויה ביו עמיד")), false);
  check('"עוגיות מן חמאה" ← עוגיות מן סוגים שונים', assortedOf("עוגיות מן חמאה", T("עוגיות מן סוגים שונים")), true);
  check('"לחם חום" ← לחם קל/מלא סוגים שונים', assortedOf("לחם חום", T("לחם קל/מלא סוגים שונים")), true);

  // המוצר של הלקוח שהכי קרוב למה שכתב
  const ids = (list) => list.map((c) => c.product._id).join(",");
  const own = [
    { _id: "goat", title: { he: "גבינת עיזים למריחה" } },
    { _id: "gad", title: { he: "חלב גד 1 ליטר" } },
    { _id: "cold", title: { he: "כוסות שתיה קרה 100 יח" } },
    { _id: "hot", title: { he: "כוסות חם 50 יחידות קאפס" } },
    { _id: "bags", title: { he: "שקיות אשפה 75*90" } },
    { _id: "milk", title: { he: "חלב טרי בקרטון 1 ליטר 3% טרה/תנובה" } },
    { _id: "bagel", title: { he: "בייגלה שטוחים" } },
  ];
  check('"גבינת עיזים של גד" ← גבינת העיזים היחידה שלו', ids(closestOwnProducts("גבינת עיזים של גד", own)), "goat");
  check('"כוסות שתייה חמה" — יש לו גם כוסות חם, נשאר לאדם', ids(closestOwnProducts("כוסות שתייה חמה", own)), "");
  check('"שקיות שקופות" — מילה אחת משותפת אינה מספיקה', ids(closestOwnProducts("שקיות שקופות", own)), "");
  check('"קרטון בייגלה" — שאלה של כמות', ids(closestOwnProducts("קרטון בייגלה", own)), "");
  check('"בייגלה" — שורה של מילה אחת', ids(closestOwnProducts("בייגלה", own)), "bagel");
  check('"גבינת עיזים 12" — מספר שלא נקרא', ids(closestOwnProducts("גבינת עיזים 12", own)), "");

  // מה שנמדד כבחירה שגויה נשאר לאדם
  const own2 = [
    { _id: "zero6", title: { he: "קוקה קולה ZERO 1.5 ליטר שישיה" } },
    { _id: "red", title: { he: "נס קפה טסטר צוייס אדום 200 גר" } },
    { _id: "winter", title: { he: "תה חליטת חורף גינגר ודבש" } },
    { _id: "lemon", title: { he: "תה ירוק לימונית ולואיזה" } },
    { _id: "forks", title: { he: "מזלגות חד פעמי בז'/שקוף קשיח 50 יח" } },
    { _id: "juice", title: { he: "מיץ תפוחים סחוט טבעי 2 ליטר" } },
  ];
  check('"קוקה קולה בקבוק קטן" אינו שישיית זירו', ids(closestOwnProducts("קוקה קולה בקבוק קטן", own2)), "");
  check('"נטול קפאין" אינו האדום', ids(closestOwnProducts("נס קפה טסטר צויס נטול קפאין", own2)), "");
  check('"חליטת תה לימונית" — יש לו תה לימונית אחר', ids(closestOwnProducts("חליטת תה לימונית ליאוזה", own2)), "");
  check('"שקיות שקופות" אינן מזלגות שקופים', ids(closestOwnProducts("שקיות שקופות", own2)), "");
  check("שני מוצרים בשורה אחת", ids(closestOwnProducts("תפוח ירוק * 2 תפוח אדום", own2)), "");

  // ניסוחים של היום (11/10/26)
  const own3 = [
    { _id: "syrup", title: { he: "סירופ ויטמינציק 1 ליטר" } },
    { _id: "tp", title: { he: "נייר טואלט מולט 48 גלילים" } },
    { _id: "uht", title: { he: "חלב עמיד סוייה" } },
    { _id: "turk", title: { he: "קפה טורקי עלית 200 גר" } },
    { _id: "eden", title: { he: "מי עדן/נביעות 1.5 ליטר שישיה" } },
  ];
  const vocab3 = new Map([["ויטמינציק", 3], ["פטל", 12], ["ניר", 80], ["טואלט", 20], ["קפה", 90]]);
  check('"פטל ויטמינציק" ← הסירופ היחיד שלו', ids(closestOwnProducts("פטל ויטמינציק", own3, { vocabulary: vocab3 })), "syrup");
  check('"מארז נייר טואלט זול" ← נייר הטואלט שלו', ids(closestOwnProducts("מארז נייר טואלט זול", own3, { vocabulary: vocab3 })), "tp");
  check('"קפה שחור" הוא קפה טורקי', coversRequest("קפה שחור", own3[3]), true);
  check('"שישיית מי עדן"', coversRequest("שישיית מי עדן", own3[4]), true);
  const vocab4 = new Map([["מיקס", 3], ["חסות", 6], ["ברכה", 3], ["גדול", 200], ["טחינה", 20]]);
  check('"מיקס חסות" אינו שוקולד מיקס', ids(closestOwnProducts("חבילות מיקס חסות (כל מיני סוגים)", [{ _id: "c", title: { he: "שוקולד מיקס מיני סניקרס" } }], { vocabulary: vocab4 })), "");
  check('"טחינה הר ברכה גדול" אינה חצי קילו', ids(closestOwnProducts("טחינה הר ברכה גדול", [{ _id: "h", title: { he: "טחינה גולמית הר ברכה 1/2 קילו" } }], { vocabulary: vocab4 })), "");
  check("מותג לטיני מפורש נשאר לאדם", ids(closestOwnProducts("טוש שחור staedtler", [{ _id: "s", title: { he: "טוש דק שחור/כחול/אדום שארפי 1 יחידה" } }])), "");
  // אותו מוצר בשם אחר — נבדק מול אקסל ההיסטוריה (11/10/26)
  check('"נייר כסף" הוא נייר אלומיניום', coversRequest("נייר כסף", { title: { he: "נייר אלומיניום קצר" } }), true);
  check('"נייר ידיים" הוא נייר צץ רץ', coversRequest("נייר ידיים", { title: { he: "נייר צץ רץ" } }), true);
  check('"פלפלים אדומים" הם גמבה אדומה', coversRequest("פלפלים אדומים", { title: { he: "גמבה אדומה 1 קילו" } }), true);
  check('"פלפלים אדומים" אינם פלפל שחור', coversRequest("פלפלים אדומים", { title: { he: "פלפל שחור בצנצנת" } }), false);
  check('"נפוליאון" מול "נפולאון" שבאקסל', ids(closestOwnProducts("גבינת נפוליאון חלקה", [{ _id: "n", title: { he: "גבינת שמנת 30%/16% נפולאון/טוסקנה תנובה" } }])), "n");
  check('"ג׳ייקובס" הוא גקובס', coversRequest("ג׳ייקובס", { title: { he: "נס קפה גקובס 200 גר" } }), true);
  check('"חלב" עדיין אינו "חלבה"', coversRequest("חלב", { title: { he: "חלבה" } }), false);
  check('"חב טישו" ← הטישו שלו', ids(closestOwnProducts("חב טישו", [{ _id: "t", title: { he: "נייר טישו לאף מילוי חוגלה" } }])), "t");

  check("עוגיות מילקה אינן שוקולד מילקה", assortedOf("עוגיות שוקולד ציפ שחורות של מילקה", T("שוקולד מילקה 100 גר' טעמים שונים")), false);
  check('"1ק"ג לימון"', coversRequest('1ק"ג לימון', { title: { he: 'לימון 1 ק"ג' } }), true);
  check('"חצי קילו" מול "1/2 קילו"', coversRequest("טחינה גולמית הר ברכה חצי קילו", { title: { he: "טחינה גולמית הר ברכה 1/2 קילו" } }), true);

  // והגבול: מילים קצרות אינן מתוקנות, ושיחה אינה מוצר
  check('"חם" אינו "קר"', coversRequest("כוסות חם", { title: { he: "כוסות קר" } }), false);
  check('"תה" אינו "תות"', coversRequest("תה", { title: { he: "ריבת תות" } }), false);
  check('"1 יח\'" אינה מכוסה על ידי דבר', coversRequest("1 יח'", { title: { he: "שורש גינגר 1 יח" } }), false);
  check("כתובת אינה מוצר", coversRequest("קומה 3 דירה 12", { title: { he: "עוגיות בקופסה 500 גר" } }), false);
}

// ───────────────────────────────────────────────────────────────

section('ניחוש במצב "הכול נכנס" — מה שנמדד כשגוי אינו ניחוש (11/10/26)');

{
  const T = (he) => ({ title: { he } });
  const vocabulary = new Map([["נוטלה", 2], ["גקובס", 2], ["שקדים", 14], ["ניר", 80], ["קפסולות", 6], ["נמס", 5], ["כוסות", 40], ["פלפל", 9], ["חלב", 41], ["טואלט", 20]]);
  const g = (text, he) => guessStrength(text, T(he), { vocabulary }) > 0;

  check('"שקית שקדים" אינה חלב שקדים', g("שקית שקדים 1 מכל סוג", "חלב שקדים/שיבולת שועל טרי"), false);
  check('"פלפלים אדומים" אינם פלפל שחור', g("פלפלים אדומים", "פלפל שחור בצנצנת"), false);
  check('"קפסולות למדיח" אינן קפסולות לקפה', g("קפסולות למדיח ג'ל", "קפסולות עלית למכונת קפה 1 יחידה"), false);
  check('"נייר כסף גדול" אינו נייר טואלט', g("נייר כסף גדול", "נייר טואלט מולט 48 גלילים"), false);
  check('"כוסות שתיה חמה" אינן קרה', g("קרטון כוסות שתיה חמה", "כוסות שתיה קרה 100 יח"), false);
  check('"נמס עלית" אינו מרק נמס', g("נמס עלית", "מרק נמס בכוס קנור זוג"), false);
  check('"חלב רגיל 3% 50" — כמות שלא נקראה', g("חלב רגיל 3% 50", "חלב טרי בקרטון 1 ליטר 3% טרה/תנובה"), false);

  check('"נוטלה 400 גרם" ← ממרח נוטלה 400', g("נוטלה 400 גרם", "ממרח שוקולד נוטלה 400 גר"), true);
  check('"ג׳ייקובס" ← נס קפה גקובס', g("גקובס", "נס קפה גקובס בשקית"), true);
  check('"נייר טואלט" ← נייר טואלט מולט', g("נייר טואלט", "נייר טואלט מולט 48 גלילים"), true);
  check('"חלב רגיל" ← חלב טרי', g("חלב רגיל", "חלב טרי בקרטון 1 ליטר 3% טרה/תנובה"), true);
}

// ───────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
if (failures.length) {
  console.log(`נכשלו ${failures.length} בדיקות מתוך ${passed + failures.length}:`);
  failures.forEach((f) => console.log(`  • ${f}`));
  process.exit(1);
}
console.log(`כל ${passed} הבדיקות עברו.`);

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
const { applyQualifiers, extractQualifiers } = require("../lib/order-ingestion/qualifiers");

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

console.log(`\n${"─".repeat(50)}`);
if (failures.length) {
  console.log(`נכשלו ${failures.length} בדיקות מתוך ${passed + failures.length}:`);
  failures.forEach((f) => console.log(`  • ${f}`));
  process.exit(1);
}
console.log(`כל ${passed} הבדיקות עברו.`);

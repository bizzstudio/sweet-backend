// script/test-archive-grouping.js
//
// בדיקת קיבוץ שורות ההיסטוריה למסמכים — הרצה: npm run archive:group-test
//
// ── למה זה קיים ──
//
// הקיבוץ קובע **כמה הזמנות ייווצרו ובאיזה תאריך**, וכל טעות בו שקטה: ההזמנות
// נראות תקינות לגמרי, פשוט לא במספר הנכון או לא ביום הנכון. שלוש הנקודות
// שנבדקות כאן הן בדיוק אלה שאין להן סימן במסך:
//
//   1. שתי תעודות באותו יום = שתי הזמנות, לא אחת.
//   2. התאריך נקרא כ-ISO ולא דרך Date.parse — "05/06/2026" היה נקרא כ-6 במאי.
//   3. גבול היום הוא UTC ולא שעון השרת — מסמך מ-23:30 חייב להישאר ביומו.
//
// הבדיקה טהורה ואינה נוגעת במסד.

const {
  groupRows,
  buildGroupCart,
} = require("../lib/archive-orders/buildArchiveOrders");

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
  console.log(
    `  ✗ ${label}\n      ציפינו: ${JSON.stringify(expected)}\n      התקבל:  ${JSON.stringify(actual)}`
  );
};

const row = (over) => ({
  sku: "1001",
  name: "מוצר",
  date: "2026-06-05T10:41:00.000Z",
  quantity: 2,
  price: 12.5,
  ...over,
});

// ── 1. שתי תעודות באותו יום ──
console.log("\nקיבוץ לפי מספר מסמך:");
{
  const { groups } = groupRows([
    row({ docNumber: "5001" }),
    row({ docNumber: "5001", sku: "1002" }),
    row({ docNumber: "5002" }),
  ]);
  check("שתי תעודות באותו יום = שתי הזמנות", groups.length, 2);
  check("שורות התעודה הראשונה", groups.find((g) => g.docNumber === "5001").lines.length, 2);
  check("אף אחת מהן אינה מקובצת לפי יום", groups.some((g) => g.byDate), false);
}

// ── 2. שורות בלי מספר מסמך ──
console.log("\nקיבוץ לפי יום בהיעדר מספר מסמך:");
{
  const { groups } = groupRows([
    row({ docNumber: undefined }),
    row({ docNumber: undefined, sku: "1002" }),
    row({ docNumber: undefined, date: "2026-06-06T08:00:00.000Z" }),
  ]);
  check("שני ימים = שתי הזמנות", groups.length, 2);
  check("מסומנות כקיבוץ לפי יום", groups.every((g) => g.byDate), true);
}

// ── 3. גבול היום הוא UTC ──
//
// שעון ישראל מקדים את UTC, ולכן קריאה בשעון מקומי הייתה מזיזה מסמך מ-23:30
// ליום הבא ומפצלת יום אחד לשתי הזמנות.
console.log("\nגבול היום:");
{
  const { groups } = groupRows([
    row({ docNumber: undefined, date: "2026-06-05T00:05:00.000Z" }),
    row({ docNumber: undefined, date: "2026-06-05T23:30:00.000Z", sku: "1002" }),
  ]);
  check("00:05 ו-23:30 של אותו יום = הזמנה אחת", groups.length, 1);
  check("התאריך הוא המוקדם מבין השורות", groups[0].date.toISOString(), "2026-06-05T00:05:00.000Z");
}

// ── 4. תאריך שאינו ISO נדחה ──
//
// ‏Date.parse **כן** קורא את "05/06/2026" — בסדר האמריקאי, כלומר 6 במאי.
// שורה כזו הייתה מייצרת הזמנה בחודש הלא נכון בלי שום סימן.
console.log("\nתאריך שאינו ISO:");
{
  const { groups, skippedNoDate } = groupRows([
    row({ docNumber: undefined, date: "05/06/2026 10:41" }),
  ]);
  check("אינו הופך להזמנה", groups.length, 0);
  check("ונספר כשורה בלי תאריך", skippedNoDate, 1);
}

// שורה עם מספר מסמך אבל בלי תאריך תקין אינה ניתנת לתיארוך, והמסמך כולו נופל
{
  const { groups, skippedNoDate } = groupRows([row({ docNumber: "5003", date: undefined })]);
  check("מסמך שכל שורותיו בלי תאריך אינו הופך להזמנה", groups.length, 0);
  check("שורותיו נספרות", skippedNoDate, 1);
}

// ── 5. סוג המסמך הוא חלק מהמפתח ──
//
// בהנהח"ש כל סדרה ממוספרת בנפרד. בלי הסוג במפתח, תעודת משלוח 5001 והחשבונית
// שהופקה עליה היו נשפכות להזמנה אחת — עגלה אחת עם כל הסחורה פעמיים.
console.log("\nסוג המסמך:");
{
  const { groups } = groupRows([
    row({ docNumber: "5001", docType: "תעודת משלוח" }),
    row({ docNumber: "5001", docType: "חשבונית" }),
  ]);
  check("אותו מספר בשני סוגי מסמך = שתי הזמנות", groups.length, 2);
  check(
    "כל אחת עם שורה אחת",
    groups.map((g) => g.lines.length),
    [1, 1]
  );
}

// (מיון כרונולוגי)
//
// מספרי ההזמנות מוקצים בסדר היצירה, ולכן הסדר כאן הוא מה שקובע שהמספרים
// יעלו יחד עם התאריכים.
console.log("\nסדר:");
{
  const { groups } = groupRows([
    row({ docNumber: "9", date: "2026-06-10T08:00:00.000Z" }),
    row({ docNumber: "7", date: "2026-01-02T08:00:00.000Z" }),
    row({ docNumber: "8", date: "2026-03-05T08:00:00.000Z" }),
  ]);
  check("כרונולוגי", groups.map((g) => g.docNumber), ["7", "8", "9"]);
}

// ── 7. שורות פסולות ──
//
// שני הנתיבים (פרופיל הרכישות והארכיון) קוראים את אותן שורות, ולכן הם
// חייבים לפסול את אותן שורות. ‏aggregateRows פוסל מק"ט לא-פרימיטיבי ומק"ט
// ארוך מ-64; ‏groupRows חייב לעשות את אותו הדבר, אחרת שורה נכנסת לאחד ולא
// לשני בלי הסבר — ומק"ט "[object Object]" נשמר על ההזמנה.
console.log("\nשורות פסולות:");
{
  const { groups, skippedBadSku } = groupRows([
    row({ sku: "" }),
    row({ sku: {} }),
    row({ sku: "1".repeat(65) }),
    row({ docNumber: "5004" }),
  ]);
  check('שורה בלי מק"ט, אובייקט, וארוך מדי — כולן נפסלות', skippedBadSku, 3);
  check("ואינן מונעות מהשאר להיווצר", groups.length, 1);
}

// ── 8. שורת זיכוי ──
//
// הבאג שהיה כאן: `quantity <= 0 ? 1 : quantity` הפך זיכוי של 3 יחידות
// ל**הוספה** של יחידה אחת. בקובץ ההנהח"ש יש שורות כאלה (מתועד ב-
// aggregateRows), ולכן זו הייתה סטייה שקטה בסכום, בכיוון ההפוך.
console.log("\nכמויות:");
{
  const { groups } = groupRows([
    row({ docNumber: "6001", quantity: -3 }),
    row({ docNumber: "6001", sku: "1002", quantity: undefined }),
    row({ docNumber: "6001", sku: "1003", quantity: 0 }),
  ]);
  check(
    "כמות שלילית, חסרה ואפס נשמרות כפי שהן (null = חסרה)",
    groups[0].lines.map((l) => l.quantity),
    [-3, null, 0]
  );
}

// ── 9. תקרות אורך ──
//
// מספר המסמך נכנס ל-archive.sourceKey שעליו יש אינדקס ייחודי. מונגו חוסם
// מפתח אינדקס מעל 1024 בתים, ומספר ארוך מדי היה מפיל את השמירה.
console.log("\nתקרות אורך:");
{
  const { groups } = groupRows([
    row({ docNumber: "9".repeat(200), name: "א".repeat(500) }),
  ]);
  check("מספר מסמך נחתך ל-64", groups[0].docNumber.length, 64);
  check("שם נחתך ל-200", groups[0].lines[0].name.length, 200);
}

// ── 10. מיון כרונולוגי ──

// ── 11. חשבון העגלה ──
//
// זה המספר שמופיע על ההזמנה, והוא חייב להסכים עם המסמך שבהנהח"ש.
console.log("\nחשבון העגלה:");

const product = (id, price) => ({
  _id: id,
  sku: id,
  title: { he: `מוצר ${id}` },
  prices: { price, originalPrice: price },
});

const catalogOf = (...products) => new Map(products.map((p) => [p.sku, p]));

{
  // שתי שורות של אותו מוצר בשני מחירים — כך זה מופיע בקובץ הדוגמה
  // ("סוכר 1 קג" פעמיים באותה חשבונית). הסכום חייב להיות המדויק,
  // והמחיר ליחידה נגזר ממנו ולא להפך.
  const group = {
    docNumber: "1",
    lines: [
      { sku: "A", name: "", quantity: 2, price: 10 },
      { sku: "A", name: "", quantity: 3, price: 12 },
    ],
  };
  const { cart, subTotal } = buildGroupCart(group, catalogOf(product("A", 99)));
  check("שתי שורות של אותו מוצר מתמזגות לשורה אחת", cart.length, 1);
  check("הכמות מסתכמת", cart[0].quantity, 5);
  check("הסכום מדויק (2×10 + 3×12)", subTotal, 56);
  check("המחיר ליחידה נגזר מהסכום", cart[0].price, 11.2);
  check("מחיר הקטלוג אינו משמש כשיש מחיר בקובץ", cart[0].prices.price, 11.2);
}

{
  // שורת זיכוי לבדה — סכום שלילי, וזה הנתון הנכון
  const group = { docNumber: "2", lines: [{ sku: "A", name: "", quantity: -3, price: 50 }] };
  const { cart, subTotal, creditLines } = buildGroupCart(
    group,
    catalogOf(product("A", 99))
  );
  check("כמות שלילית נשמרת", cart[0].quantity, -3);
  check("הסכום שלילי", subTotal, -150);
  check("ונספרת כשורת זיכוי", creditLines, 1);
}

{
  // מכירה וזיכוי של אותו מוצר באותו מסמך — התקזזו לאפס.
  // בלי ההגנה על חילוק באפס זה היה NaN על ההזמנה.
  const group = {
    docNumber: "3",
    lines: [
      { sku: "A", name: "", quantity: 3, price: 50 },
      { sku: "A", name: "", quantity: -3, price: 50 },
    ],
  };
  const { cart, subTotal } = buildGroupCart(group, catalogOf(product("A", 99)));
  check("כמות מתקזזת לאפס", cart[0].quantity, 0);
  check("בלי חילוק באפס", cart[0].price, 0);
  check("והסכום אפס", subTotal, 0);
}

{
  // מק"ט שאינו בקטלוג — אינו בעגלה, אינו בסכום, ומדווח בנפרד
  const group = {
    docNumber: "4",
    lines: [
      { sku: "A", name: "קיים", quantity: 1, price: 10 },
      { sku: "Z", name: "לא קיים", quantity: 5, price: 20 },
    ],
  };
  const { cart, subTotal, unmatched } = buildGroupCart(
    group,
    catalogOf(product("A", 99))
  );
  check("רק המוצר שנמצא נכנס לעגלה", cart.length, 1);
  check("הסכום אינו כולל את מה שלא נמצא", subTotal, 10);
  check("והוא מדווח", unmatched.map((u) => u.sku), ["Z"]);
}

{
  // שורה בלי מחיר — נופלת למחיר הקטלוג ומדווחת
  const group = { docNumber: "5", lines: [{ sku: "A", name: "", quantity: 2, price: null }] };
  const { subTotal, missingPrice } = buildGroupCart(group, catalogOf(product("A", 7.5)));
  check("מחיר הקטלוג משמש כנפילה", subTotal, 15);
  check("והנפילה מדווחת", missingPrice, 1);
}

{
  // שורה בלי כמות — יחידה אחת, וההנחה מדווחת
  const group = { docNumber: "6", lines: [{ sku: "A", name: "", quantity: null, price: 8 }] };
  const { cart, subTotal, assumedQty } = buildGroupCart(group, catalogOf(product("A", 99)));
  check("כמות חסרה = יחידה אחת", cart[0].quantity, 1);
  check("הסכום לפי מחיר הקובץ", subTotal, 8);
  check("וההנחה מדווחת", assumedQty, 1);
}

// ───────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
if (failures.length) {
  console.log(`נכשלו ${failures.length} בדיקות מתוך ${passed + failures.length}:`);
  failures.forEach((f) => console.log(`  • ${f}`));
  process.exit(1);
}
console.log(`כל ${passed} הבדיקות עברו.`);

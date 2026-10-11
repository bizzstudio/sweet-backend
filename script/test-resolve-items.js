// script/test-resolve-items.js
//
// בדיקת resolveItems בלי מסד — הרצה: npm run ingest:resolve-test
//
// ── למה זה קיים ──
//
// כל שאר בדיקות הקליטה בודקות את הפרסר או פונקציות טהורות. ההחלטות עצמן —
// מה נכנס להזמנה, מה נעצר לאדם ומה יורד להערה — מתקבלות ב-resolveItems, והוא
// נשען על מנוע ההתאמה ועל המסד. כאן מנוע ההתאמה, האליאסים ואוצר המילים
// מוחלפים בתחליפים, כך שאפשר לבדוק את הלוגיקה של resolveItems עצמה.
//
// התחליפים מוצבים על אובייקט ה-exports **לפני** ש-resolvers נטען, כי הוא
// מפרק אותם (destructuring) בזמן הטעינה.

const productMatching = require("../utils/productMatching");
const productAliases = require("../utils/productAliases");
const catalogVocabulary = require("../utils/catalogVocabulary");
const manualItems = require("../lib/billing/manualItems");

// ── קטלוג מדומה ──
const product = (id, he, sku = id) => ({
  _id: id,
  sku,
  title: { he },
  status: "show",
  stock: null,
  prices: { price: 10 },
});

const CATALOG = {
  milkCafe: product("milkCafe", "חלב לקפה"),
  milkPlain: product("milkPlain", "חלב טרי בקרטון 1 ליטר 3% טרה/תנובה"),
  milkSoy: product("milkSoy", "חלב סוייה טרי מגוון סוגים"),
  milkLact: product("milkLact", "חלב דל לקטוז/נטול לקטוז 1 ליטר"),
  colaPack: product("colaPack", "פחיות קולה זירו 24 יח"),
  bamba: product("bamba", "במבה אוסם"),
  rent: product("rent", "שכירות חודש 08/25 עבור נכס ברחוב בן גוריון 19 בני-ברק"),
  fruit6: product("fruit6", "פירות 6 קילו"),
  fruit8: product("fruit8", "פירות 8 קילו"),
  // category "produce" היא הקטגוריה הנשקלת (ראה manualNoteCategoryIds למטה)
  banana: { ...product("banana", "בננות 5.5 קילו"), category: "produce", prices: { price: 55 } },
  bananaYogurt: product("bananaYogurt", "יוגורט בננות 150 גרם"),
  cheese: product("cheese", "גבינה צהובה נועם 360 גר'"),
};

// searchName → תוצאת מנוע ההתאמה
const MATCHES = {
  "חלב רגיל": {
    product: CATALOG.milkCafe,
    score: 100,
    confidence: 0.47,
    alternatives: [CATALOG.milkPlain, CATALOG.milkSoy, CATALOG.milkLact].map((p) => ({
      ...p,
      score: 99,
    })),
  },
  "פחיות קולה": { product: CATALOG.colaPack, score: 100, confidence: 0.95, alternatives: [] },
  "במבה": { product: CATALOG.bamba, score: 100, confidence: 0.95, alternatives: [] },
  "כנרת": { product: CATALOG.rent, score: 40, confidence: 0.47, alternatives: [] },
  "מעדנים פירות": {
    product: CATALOG.fruit6,
    score: 50,
    confidence: 0.47,
    alternatives: [{ ...CATALOG.fruit8, score: 49 }],
  },
};

// המשקל נשאר בשם שנשלח לחיפוש, ולכן הוא חלק מהמפתח
MATCHES["1.5 קילו בננות"] = {
  product: CATALOG.banana,
  score: 100,
  confidence: 0.53,
  alternatives: [{ ...CATALOG.bananaYogurt, score: 99 }],
};
MATCHES["בננות"] = { product: CATALOG.banana, score: 100, confidence: 0.95, alternatives: [] };
MATCHES["גבינה צהובה 500 גרם נועם"] = {
  product: CATALOG.cheese,
  score: 100,
  confidence: 0.97,
  alternatives: [],
};

const apple5 = { ...product("apple5", "תפוחים 5 קילו"), category: "produce" };
const apple12 = { ...product("apple12", "תפוחים 12 קילו"), category: "produce" };
MATCHES["1.5 קילו תפוחים"] = {
  product: apple5,
  score: 100,
  confidence: 0.53,
  alternatives: [{ ...apple12, score: 99 }],
};
MATCHES["3 קילו בננות"] = {
  product: { ...CATALOG.banana, stock: 1 },
  score: 100,
  confidence: 0.53,
  alternatives: [],
};

// שליפת הקטגוריות של חלופות — מוחזרת מהקטלוג המדומה במקום מהמסד
const Product = require("../models/Product");
Product.find = ({ _id }) => {
  const all = [...Object.values(CATALOG), apple5, apple12];
  const found = all.filter((p) => _id.$in.includes(p._id));
  const query = { select: () => query, lean: async () => found };
  return query;
};

manualItems.manualNoteCategoryIds = async () => new Set(["produce"]);

productMatching.matchProductByName = async (name) => {
  const hit = MATCHES[name];
  return hit ? { quantityFromText: null, query: name, pool: hit.alternatives, ...hit } : null;
};
productAliases.findAliasMatch = async () => null;
productAliases.recordAliasHit = () => {};
catalogVocabulary.getCatalogVocabulary = async () =>
  new Map([
    ["חלב", 41],
    ["פירות", 50],
    ["מעדנים", 5],
    ["במבה", 6],
    ["קולה", 12],
    ["פחיות", 20],
  ]);

const { resolveItems } = require("../lib/order-ingestion/resolvers");
const { buildPurchaseProfile } = require("../utils/purchaseHistoryRanking");

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

const recent = new Date(Date.now() - 30 * 24 * 3600 * 1000);
const milkHistory = buildPurchaseProfile([
  { product: "milkPlain", sku: "milkPlain", lines: 683, totalQty: 683, lastAt: recent },
  { product: "milkSoy", sku: "milkSoy", lines: 519, totalQty: 519, lastAt: recent },
  { product: "milkLact", sku: "milkLact", lines: 189, totalQty: 189, lastAt: recent },
]);

const run = async () => {
  section('"רגיל" + היסטוריה (#140225)');
  {
    const { items, unmatched } = await resolveItems(
      [{ rawName: "חלב רגיל", quantity: 2, quantityFromTrailing: true }],
      { historyProfile: milkHistory, customerId: "c1" }
    );
    check("נכנס להזמנה", [items.length, unmatched.length], [1, 0]);
    check("נבחר החלב שהלקוח קונה", items[0]?.product?._id, "milkPlain");
    check("הכמות נשמרה", items[0]?.quantity, 2);
    check("ההכרעה מתועדת כהיסטוריה", /היסטוריה/.test(items[0]?.decidedBy || ""), true);
  }
  {
    // בלי היסטוריה אין מי שיכריע — נשאר לאדם (לא מנחשים)
    const { items, unmatched } = await resolveItems([{ rawName: "חלב רגיל", quantity: 2 }], {});
    // לפני התיקון "חלב לקפה" נבחר כאן אוטומטית — 50 יחידות נכנסו להזמנה בלי
    // שאיש בחר. השורה חייבת להגיע לאדם.
    check("בלי היסטוריה: נעצר לאדם ולא נבחר אוטומטית", [items.length, unmatched.length], [0, 1]);
  }

  section('"N יח" מול מארז של N');
  {
    const { items } = await resolveItems(
      [{ rawName: "פחיות קולה", quantity: 24, countUnit: true }],
      {}
    );
    check("24 יח מול מארז 24 → מארז אחד", items[0]?.quantity, 1);
    check("ההחלטה כתובה בהערה למלקט", /מארז אחד/.test(items[0]?.note || ""), true);
  }
  {
    const { items } = await resolveItems([{ rawName: "במבה", quantity: 3, countUnit: true }], {});
    check("3 יח במבה (לא מארז) → 3", items[0]?.quantity, 3);
  }
  {
    // בלי סימון countUnit ("24 פחיות קולה") אין תיקון
    const { items } = await resolveItems([{ rawName: "פחיות קולה", quantity: 24 }], {});
    check("כמות רגילה מול מארז אינה משתנה", items[0]?.quantity, 24);
  }

  section("כמות שהוסקה מצורת הרשימה");
  {
    const { items, unmatched, dropped } = await resolveItems(
      [{ rawName: "כנרת", quantity: 13, quantityFromTrailing: true }],
      {}
    );
    check("כתובת שנראתה כרשימה יורדת להערה ולא מפילה את ההזמנה", [items.length, unmatched.length, dropped.length], [0, 0, 1]);
  }
  {
    const { unmatched, dropped } = await resolveItems(
      [{ rawName: "כנרת", quantity: 13 }],
      {}
    );
    check("אותה שורה עם כמות מפורשת — נעצרת לאדם כמו קודם", [unmatched.length, dropped.length], [1, 0]);
  }
  {
    const { items, unmatched, dropped } = await resolveItems(
      [{ rawName: "מעדנים פירות", quantity: 4, quantityFromTrailing: true }],
      {}
    );
    check(
      "שורת מוצר עמומה מרשימה אינה נעלמת להערה",
      dropped.length === 0 && items.length + unmatched.length === 1,
      true
    );
  }

  section("סחורה במשקל");
  {
    const { items, unmatched } = await resolveItems(
      [{ rawName: "1.5 קילו בננות", quantity: 1, quantityAssumed: true }],
      {}
    );
    check("1.5 קילו מתוך ארגז 5.5 נכנס להזמנה", [items.length, unmatched.length], [1, 0]);
    check("הכמות היא החלק היחסי מהארגז", items[0]?.quantity, 0.273);
    check("המשקל שהתבקש כתוב למלקט", /1\.5 קילו/.test(items[0]?.note || ""), true);
    check("אינו מסומן ככמות שהונחה", items[0]?.quantityAssumed, false);
    // "יוגורט בננות 150 גרם" נושא משקל ואת המילה, אבל אינו סחורה נשקלת
    check("מוצר ארוז בשם דומה אינו נחשב ארגז מתחרה", items[0]?.autoPicked, undefined);
    check("הסימון הפנימי אינו יוצא", "weightAsk" in (items[0] || {}), false);
  }
  {
    const { items } = await resolveItems([{ rawName: "בננות", quantity: 8, unit: 'ק"ג' }], {});
    check('8 ק"ג בעמודת הכמות → 1.455 ארגזים ולא 8', items[0]?.quantity, 1.455);
    check("היחידה נבלעה בהמרה", items[0]?.unit, null);
  }
  {
    const { items } = await resolveItems([{ rawName: "בננות", quantity: 2 }], {});
    check("כמות בלי משקל נשארת מספר ארגזים", items[0]?.quantity, 2);
  }
  {
    // סחורה ארוזה: מידה שאין היא מוצר שאין, לא 1.39 אריזות
    const { items, unmatched } = await resolveItems(
      [{ rawName: "גבינה צהובה 500 גרם נועם", quantity: 1 }],
      {}
    );
    check("מוצר ארוז במידה אחרת עדיין נעצר לאדם", [items.length, unmatched.length], [0, 1]);
  }
  {
    const { items, unmatched } = await resolveItems(
      [{ rawName: "1.5 קילו תפוחים", quantity: 1, quantityAssumed: true }],
      {}
    );
    check("שני ארגזים באותו שם — נעצר לאדם ולא נבחר אוטומטית", [items.length, unmatched.length], [0, 1]);
    check("הסיבה מציגה את שני הארגזים", /5 קילו.*12 קילו/.test(unmatched[0]?.failReason || ""), true);
  }
  {
    // 3 ק"ג מתוך ארגז 5.5 הם 0.545 ארגז — מלאי של ארגז אחד מספיק
    const { items, unmatched } = await resolveItems(
      [{ rawName: "3 קילו בננות", quantity: 1, quantityAssumed: true }],
      {}
    );
    check("המלאי נבדק מול החלק המומר", [items.length, unmatched.length, items[0]?.quantity], [1, 0, 0.545]);
  }
};

run()
  .catch((err) => {
    failures.push(`חריגה: ${err.stack || err.message}`);
    console.log(err);
  })
  .finally(() => {
    console.log(`\n${"─".repeat(50)}`);
    if (failures.length) {
      console.log(`נכשלו ${failures.length} בדיקות מתוך ${passed + failures.length}:`);
      failures.forEach((f) => console.log(`  • ${f}`));
      process.exit(1);
    }
    console.log(`כל ${passed} הבדיקות עברו.`);
    process.exit(0);
  });

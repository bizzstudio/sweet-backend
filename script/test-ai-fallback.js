// script/test-ai-fallback.js
//
// בדיקת שלב ה-AI של הקליטה בלי רשת ובלי מסד — הרצה: npm run ingest:ai-test
//
// ── למה זה קיים ──
//
// כל קריאה למודל עולה כסף, ולכן הכללים נבדקים כאן על תשובות שהוקלטו מהמדידה
// של 12/10/26 (52 הזמנות אמת). כל מקרה כאן הוא טעות שהמודל עשה בפועל, או
// תשובה נכונה שהבודק פסל בטעות. fetch מוחלף בתחליף: שום דבר לא יוצא החוצה.

const productMatching = require("../utils/productMatching");
const productAliases = require("../utils/productAliases");
const catalogVocabulary = require("../utils/catalogVocabulary");
const manualItems = require("../lib/billing/manualItems");
const packSizes = require("../utils/packSizes");
const Product = require("../models/Product");

// ── קטלוג מדומה והיסטוריה של לקוח אחד ──
const product = (id, he) => ({
  _id: id,
  sku: id,
  title: { he },
  status: "show",
  stock: null,
  prices: { price: 10 },
});
const CATALOG = {
  sweetener: product("sweetener", "ממתיק 700 יח לחיץ פטנט"),
  water: product("water", "מים מינרלים בקבוק אישי"),
  napkins: product("napkins", "מפיות מקופלות"),
  nutella: product("nutella", "ממרח שוקולד נוטלה 400 גר"),
  hidden: { ...product("hidden", "ריבת תות 340 גר"), status: "hide" },
};

Product.find = ({ _id }) => {
  const found = Object.values(CATALOG).filter((p) => _id.$in.includes(p._id));
  const query = { select: () => query, lean: async () => found, catch: () => query };
  query.then = (resolve) => resolve(found);
  return query;
};
Product.findById = (id) => ({ lean: async () => CATALOG[id] || null });

manualItems.manualNoteCategoryIds = async () => new Set();
productMatching.matchProductByName = async (name) =>
  name === "מפיות מקופלות"
    ? { quantityFromText: null, query: name, pool: [], product: CATALOG.napkins, score: 100, confidence: 0.97, alternatives: [] }
    : null;
productAliases.findAliasMatch = async () => null;
productAliases.recordAliasHit = () => {};
const savedAliases = [];
productAliases.saveAlias = async (alias) => savedAliases.push(alias);
catalogVocabulary.getCatalogVocabulary = async () => new Map([["מפיות", 9], ["מים", 30]]);
packSizes.getPackSizes = async () => ({ bySku: new Map([["water", 24]]), byTitle: new Map() });

// ── המודל המדומה ──
const modelCalls = [];
let modelAnswers = [];
global.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  modelCalls.push(body);
  const next = modelAnswers.shift();
  if (next instanceof Error) throw next;
  const lines = typeof next === "function" ? next(body) : next || [];
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ lines }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  };
};
process.env.OPENAI_API_KEY = "test-key-not-real";

const { verifyAnswer, resolveOpenLines, looksLikeTwoProducts } = require("../lib/order-ingestion/aiFallback");
const { resolveItems } = require("../lib/order-ingestion/resolvers");
const { buildPurchaseProfile } = require("../utils/purchaseHistoryRanking");

let passed = 0;
const failures = [];
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1;
    console.log(`  ✓ ${label}`);
    return;
  }
  failures.push(`${label} — ציפינו ${JSON.stringify(expected)}, התקבל ${JSON.stringify(actual)}`);
  console.log(`  ✗ ${label}\n      ציפינו: ${JSON.stringify(expected)}\n      התקבל:  ${JSON.stringify(actual)}`);
};
const section = (title) => console.log(`\n── ${title} ──`);

// שורה כפי שהצינור מעביר אותה, ותשובת מודל
const line = (raw, qty = 1, extra = {}) => ({ source: raw, raw, qty, assumed: false, status: "open", ...extra });
const owned = (title, n = 50, pack = null) => ({ title, n, ago: 1, pack });
const pick = (title, quantity, extra = {}) => ({
  i: 0,
  kind: "product",
  product: 0,
  title,
  quantity,
  packs: null,
  sure: true,
  reason: "",
  ...extra,
});
// [אושר?, כמות] — מה שחשוב בכל מקרה
const verdictOf = (ln, title, quantity, { n = 50, pack = null, history = [], ...extra } = {}) => {
  const chosen = owned(title, n, pack);
  const verdict = verifyAnswer(ln, pick(title, quantity, extra), chosen, [chosen, ...history]);
  return verdict.ok ? ["אושר", verdict.quantity] : ["נפסל"];
};

const run = async () => {
  section("מילים שונות לאותו מוצר — מאושר");
  check("סוכרזית → ממתיק", verdictOf(line("סוכרזית", 1, { assumed: true }), "ממתיק פטנט 700 יח לחיץ", 1), ["אושר", 1]);
  check("נייר ידיים 10 → צץ רץ", verdictOf(line("נייר ידיים", 10), "נייר צץ רץ", 10), ["אושר", 10]);
  check("קפה שחור → קפה טורקי", verdictOf(line("קפה שחור", 10), "קפה טורקי עלית 200 גר", 10), ["אושר", 10]);
  check("7 פטל → סירופ (הטעם הוא שם המוצר)", verdictOf(line("פטל", 7), "סירופ ויטמינציק 1 ליטר", 7), ["אושר", 7]);

  section("מוצר דומה שאינו מה שהתבקש — נפסל");
  check("גבינת שמנת 5% מול 30%/16%", verdictOf(line("גבינת שמנת חלקה 5%", 1), "גבינת שמנת 30%/16% נפולאון/טוסקנה תנובה", 1), ["נפסל"]);
  check("יוגורט ביו 1.8% מול 2.8%/1.7%", verdictOf(line("יוגורט ביו 1.8%", 1, { assumed: true }), "יוגורט טבעי ביו מולר2.8%/1.7%", 1), ["נפסל"]);
  check("מריר 90 אחוז מול טבלה רגילה", verdictOf(line("מריר 90 אחוז", 1), "שוקולד ספלנדיט מריר/חלב טבלה", 1), ["נפסל"]);
  check("כוסות שתיה חמה מול קרה", verdictOf(line("כוסות שתיה חמה", 2), "כוסות שתיה קרה 100 יח", 2), ["נפסל"]);
  check("כפיות מול כפות", verdictOf(line("כפיות קשיח בז'", 80), "כפות חד פעמי קשיח בז' 50 יחי", 80), ["נפסל"]);
  check("קפסולות וניל מול קפסולות קפה", verdictOf(line("קפסולות וניל", 1), "קפסולות עלית למכונת קפה 1 יח", 1), ["נפסל"]);
  check("נס קפה מול קפה טורקי", verdictOf(line("נס קפה גדול", 1), "קפה עלית 1 ק\"ג מוסדי", 1), ["נפסל"]);
  check("שלישיות מול שישיות", verdictOf(line("נייר סופרא – 3 שלישיות", 3), "נייר סופרה גליל קרפ שישיות", 3), ["נפסל"]);
  check("קפה 1 ק\"ג מול 200 גר, גם כשהכמות היא 1", verdictOf(line("שקית קפה שחור 1 ק\"ג", 1), "קפה טורקי עלית 200 גר", 1), ["נפסל"]);
  check("טעם במוצר מגוון טעמים — מאושר", verdictOf(line("קורנפלקס פיטנס שוקולד", 1), "קונפלקס פיטנס טעמים שונים", 1), ["אושר", 1]);

  section("אותו מוצר באריזה שהשתנתה");
  check("נוטלה 350 גרם → 400 גר", verdictOf(line("נוטלה 350 גרם", 6), "ממרח שוקולד נוטלה 400 גר", 6), ["אושר", 6]);
  check("קרקר 900 גר → 1 קילו", verdictOf(line("קרקר זהב 900 גר'", 1), "קרקר זהב אוסם 1 קילו", 1), ["אושר", 1]);
  check("200 גר מול 250 גר הם גדלים שונים", verdictOf(line("גבינה 200 גר", 2), "גבינה לבנה 250 גר", 2), ["נפסל"]);
  check("2 מלוח אינו 2 מ\"ל", verdictOf(line("עוגיות בקופסה - 2 מלוח", 2), "עוגיות בקופסה  500 גר' פלסטיק  26 טעמים", 2), ["אושר", 2]);

  section("כמות");
  check("מלפפונים 4 קילו", verdictOf(line("מלפפונים 4 קילו", 4), "מלפפון 1 ק\"ג", 4), ["אושר", 4]);
  check("1.5 קילו בננות", verdictOf({ ...line("בננות", 1), source: "1.5 קילו בננות" }, "בננות 1 ק\"ג", 1.5), ["אושר", 1.5]);
  check("כמות שהמודל המציא", verdictOf(line("חלב", 4), "חלב טרי בקרטון 1 ליטר 3% טרה/תנובה", 12), ["נפסל"]);
  check("כמות חסרה", verdictOf(line("עגבניות 5 יח", 5), "עגבניות  1 ק\"ג", null), ["נפסל"]);

  section("קרטון, שישייה, שרוול");
  check("קרטון מים: 24", verdictOf(line("קרטון בקבוקי מים", 1), "מים מינרלים בקבוק אישי", 1000, { pack: 24 }), ["אושר", 24]);
  check("2 ארגז סודה: 48", verdictOf(line("2 ארגז בקבוקי סודה", 2), "בקבוקי סודה זכוכית בקבוק אישי 250 מ\"ל", 2, { pack: 24 }), ["אושר", 48]);
  check("קרטון בלי גודל ידוע — לאדם", verdictOf(line("קרטון בייגלה", 1, { assumed: true }), "בייגלה שטוחים", 20), ["נפסל"]);
  check("בייגלה - 3 קרטונים בלי גודל ידוע", verdictOf(line("בייגלה - 3 קרטונים", 3), "בייגלה שטוחים", 3), ["נפסל"]);
  check("3 שישיות של מוצר בודד: 18", verdictOf(line("סודה 1.5 ליטר - 3 שישיות", 3), "סודה 1.5 ליטר", 3), ["אושר", 18]);
  check("שישייה כשהמוצר הוא השישייה: 1", verdictOf(line("שישיית קולה זירו", 2), "קוקה קולה ZERO 1.5 ליטר שישיה", 2), ["אושר", 2]);
  check("שישיית סודה מול \"6 יח\": 1", verdictOf(line("שישיית סודה", 1), "סודה שוופס 6 יח 1.5 ליטר", 1), ["אושר", 1]);
  check("2 שרוולים מול \"50 יח\": 2", verdictOf(line("כוסות - 2 שרוולים", 2), "כוסות OZ12 חם נייר 50 יח", 2), ["אושר", 2]);
  check("24 בקבוקים מול שישיה: 4", verdictOf(line("24 בקבוקים של מים", 24), "מיים אישי ספורט עם פקק שישיה", 4), ["אושר", 4]);

  section("גדול / קטן");
  const hummus1kg = owned("סלט חומוס אחלה 1 ק\"ג");
  check("חומוס קטן כשיש שני גדלים: הקטן", verdictOf(line("חומוס קטן", 1), "סלט חומוס אחלה 400 גר'", 1, { history: [hummus1kg] }), ["אושר", 1]);
  check("חומוס גדול מול הקטן שבהם — נפסל", verdictOf(line("חומוס גדול", 1), "סלט חומוס אחלה 400 גר'", 1, { history: [hummus1kg] }), ["נפסל"]);
  check("מוצר יחיד כזה אצל הלקוח", verdictOf(line("ניילון נצמד גדול", 1), "ניילון נצמד", 1, { history: [owned("אשפענק ניילון 75-85")] }), ["אושר", 1]);
  check("בקבוק אישי הוא הבקבוק הקטן", verdictOf(line("קרטון בקבוקי מים קטנים", 1), "מים מינרלים בקבוק אישי", 24, { pack: 24, history: [owned("מים מינרלים 1.5 ליטר")] }), ["אושר", 24]);

  section("מוצר שנקנה פעם-פעמיים");
  check("השורה קוראת לו בשמו", verdictOf(line("חלב שיבולת שועל אלטרנטיב", 1), "חלב שקדים/שיבולת שועל טרי", 1, { n: 2 }), ["אושר", 1]);
  check("השורה אינה קוראת לו בשמו", verdictOf(line("קליק ירוק", 2), "קינדר עוגיות", 2, { n: 1 }), ["נפסל"]);
  check("ניחוש בלי שם משותף", verdictOf(line("קליק ירוק", 2), "קינדר עוגיות", 2, { sure: false }), ["נפסל"]);

  section("שורה שאינה מוצר");
  const kind = (ln, answerKind) => verifyAnswer(ln, { i: 0, kind: answerKind, product: -1, title: "", quantity: null, packs: null, sure: true, reason: "" }, null).ok;
  check("כותרת קטגוריה", kind(line("חלב ותחליפים", 1, { assumed: true }), "not_product"), true);
  check("שורה עם כמות אינה \"לא מוצר\"", kind(line("צלחות חד פעמיות", 200), "not_product"), false);
  check("\"5 חב'\" היא כמות של השורה שמעל", kind(line("5 חב'", 5), "quantity_of_previous"), true);
  check("\"לימונים 10 יחידות\" אינה כמות של השורה שמעל", kind(line("לימונים 10 יחידות", 10), "quantity_of_previous"), false);

  section("שני מוצרים בשורה אחת");
  check("א + ב", looksLikeTwoProducts("מלפפון בייבי+ גמבה בייבי"), true);
  check("שם-מספר-שם-מספר", looksLikeTwoProducts("ממרח נוטלה 1 ממרח שחר 1"), true);
  check("כוכבית כפולה", looksLikeTwoProducts("* 2 תפוח ירוק * 2 תפוח אדום"), true);
  check("משקל ואז כמות אינם שני מוצרים", looksLikeTwoProducts("קפה שחור עלית 200 גרם 1"), false);
  check("אחוז ואז כמות אינם שני מוצרים", looksLikeTwoProducts("מריר 90 אחוז 1"), false);

  section("סיבוב שני: תשובה שנפסלה חוזרת למודל עם הסיבה");
  {
    const history = [owned("קפה טורקי עלית 200 גר"), owned("קפה עלית 1 ק\"ג מוסדי"), owned("תפוחים אדומים 1 ק\"ג")];
    const lines = [line("שקית קפה שחור 1 ק\"ג", 1), line("מיץ לימון", 2), line("טוש שחור", 1)];
    modelCalls.length = 0;
    modelAnswers = [
      [
        pick("קפה טורקי עלית 200 גר", 1, { i: 0, product: 0 }),
        // טעות ספירה: המספר מצביע על מוצר אחר מהשם
        pick("מיץ לימון משומר", 2, { i: 1, product: 2 }),
        pick("", null, { i: 2, product: -1 }),
      ],
      [pick("קפה עלית 1 ק\"ג מוסדי", 1, { i: 0, product: 1 }), pick("", null, { i: 1, product: -1 })],
    ];
    const decisions = await resolveOpenLines({ lines, history });
    check("שתי קריאות למודל", modelCalls.length, 2);
    check("\"אין ברשימה\" אינו חוזר למודל", /שורה 2/.test(modelCalls[1].messages[3].content), false);
    check("התיקון התקבל", [decisions[0].decision, decisions[0].product.title, decisions[0].quantity], ["accept", "קפה עלית 1 ק\"ג מוסדי", 1]);
    check("מה שאין ברשימה נשאר פתוח", [decisions[1].decision, decisions[2].decision], ["open", "open"]);
  }
  {
    modelCalls.length = 0;
    modelAnswers = [[pick("ממרח שוקולד נוטלה 400 גר", 1, { i: 0, product: 0 })]];
    const decisions = await resolveOpenLines({
      lines: [{ ...line("ממרח נוטלה 1 ממרח שחר", 1), source: "ממרח נוטלה 1 ממרח שחר 1" }],
      history: [owned("ממרח שוקולד נוטלה 400 גר")],
    });
    check("שני מוצרים ותשובה אחת — השורה נשארת פתוחה", decisions[0].decision, "open");
  }
  {
    modelCalls.length = 0;
    const decisions = await resolveOpenLines({ lines: [line("סוכרזית")], history: [] });
    check("לקוח בלי היסטוריה: אין קריאה למודל", [decisions.length, modelCalls.length], [0, 0]);
  }

  section("בתוך הצינור (resolveItems)");
  const recent = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const profile = buildPurchaseProfile(
    ["sweetener", "water", "napkins", "nutella", "hidden"].map((id, i) => ({
      product: id,
      sku: id,
      lines: 100 - i,
      totalQty: 300,
      lastAt: recent,
    }))
  );
  // הרשימה שהמודל רואה ממוינת לפי מספר הקניות, ולכן זה גם סדר המספרים שלה
  const INDEX = { sweetener: 0, water: 1, napkins: 2, nutella: 3, hidden: 4 };
  const order = [
    { rawName: "סוכרזית", quantity: 3 },
    { rawName: "קרטון בקבוקי מים", quantity: 1 },
    { rawName: "מפיות מקופלות", quantity: 1, quantityAssumed: true },
    { rawName: "5 חב'", quantity: 5 },
    { rawName: "טוש שחור", quantity: 2 },
  ];
  {
    process.env.INGESTION_AI_FALLBACK = "false";
    modelCalls.length = 0;
    const { unmatched } = await resolveItems(order, { historyProfile: profile, customerId: "c1" });
    check("המתג כבוי: אין קריאה למודל, והשורות נעצרות כמו קודם", [modelCalls.length, unmatched.length > 0], [0, true]);
  }
  {
    process.env.INGESTION_AI_FALLBACK = "true";
    modelCalls.length = 0;
    savedAliases.length = 0;
    modelAnswers = [
      (body) => {
        const prompt = body.messages[1].content;
        const at = (text) => Number(prompt.split("\n").find((row) => row.includes(`? ${text}`)).split(".")[0]);
        return [
          pick(CATALOG.sweetener.title.he, 3, { i: at("סוכרזית"), product: INDEX.sweetener }),
          pick(CATALOG.water.title.he, 1000, { i: at("קרטון בקבוקי מים"), product: INDEX.water, packs: 1 }),
          { i: at("5 חב'"), kind: "quantity_of_previous", product: -1, title: "", quantity: 5, packs: null, sure: true, reason: "" },
          pick("", null, { i: at("טוש שחור"), product: -1 }),
        ];
      },
    ];
    const { items, unmatched } = await resolveItems(order, { historyProfile: profile, customerId: "c1" });
    const byName = (name) => items.find((item) => item.rawName === name);
    check("קריאה אחת למודל להזמנה", modelCalls.length, 1);
    check("סוכרזית נכנסה כממתיק ×3", [byName("סוכרזית")?.product?._id, byName("סוכרזית")?.quantity], ["sweetener", 3]);
    check("ההערה למלקט מציגה מה הלקוח כתב", /הלקוח כתב: "סוכרזית"/.test(byName("סוכרזית")?.note || ""), true);
    check("קרטון מים: 24 יחידות, לא מה שהמודל כתב", byName("קרטון בקבוקי מים")?.quantity, 24);
    check("\"5 חב'\" הפכה לכמות של המפיות", [byName("מפיות מקופלות")?.quantity, Boolean(byName("5 חב'"))], [5, false]);
    check("מה שאין בהיסטוריה נשאר לאדם, עם הסיבה", [unmatched.map((u) => u.rawName), /AI: אין ברשימת הלקוח/.test(unmatched[0]?.failReason || "")], [["טוש שחור"], true]);
    check("הפריטים בסדר שבו הלקוח כתב", items.map((item) => item.rawName), ["סוכרזית", "קרטון בקבוקי מים", "מפיות מקופלות"]);
    check("ההכרעה נשמרה ללקוח — רק זו שהאליאס ישחזר", savedAliases.map((a) => [a.rawName, a.productId, a.customerId, a.createdBy]), [["סוכרזית", "sweetener", "c1", "ai-history"]]);
  }
  {
    modelCalls.length = 0;
    modelAnswers = [[pick(CATALOG.hidden.title.he, 1, { i: 0, product: INDEX.hidden })]];
    const { items, unmatched } = await resolveItems([{ rawName: "ריבה", quantity: 1 }], { historyProfile: profile, customerId: "c1" });
    check("מוצר מוסתר בקטלוג אינו נכנס", [items.length, /מוסתר/.test(unmatched[0]?.failReason || "")], [0, true]);
  }
  {
    modelAnswers = [new Error("network down")];
    const { items, unmatched } = await resolveItems([{ rawName: "סוכרזית", quantity: 3 }], { historyProfile: profile, customerId: "c1" });
    check("תקלה ברשת אינה מפילה את הקליטה", [items.length, unmatched.length], [0, 1]);
  }
  {
    modelCalls.length = 0;
    const { unmatched } = await resolveItems([{ rawName: "סוכרזית", quantity: 3 }], { historyProfile: null, customerId: "c2" });
    check("לקוח בלי היסטוריה: אין קריאה למודל", [modelCalls.length, unmatched.length], [0, 1]);
  }

  section("גודל קרטון מהזמנות העבר");
  const { packSizeFrom } = jestFreeRequire();
  check("מים: 24", packSizeFrom([[24, 395], [48, 201], [72, 63], [96, 39], [12, 29], [6, 28], [1, 20]]), 24);
  check("48 נפוץ מ-24, אבל הקרטון הוא 24", packSizeFrom([[48, 122], [24, 117], [72, 53], [120, 39], [96, 33]]), 24);
  check("פחיות שמוזמנות גם בשישיות: 24", packSizeFrom([[24, 459], [48, 220], [6, 46], [12, 30]]), 24);
  check("נייר A4: 5", packSizeFrom([[5, 262], [10, 166], [15, 69], [25, 62], [20, 58], [2, 12]]), 5);
  check("כפיות 5/10/20 מתוך הרגל: אין", packSizeFrom([[10, 194], [20, 132], [5, 107], [2, 82], [40, 72], [30, 71], [1, 60], [3, 55], [4, 50], [6, 40]]), null);
  check("בייגלה: אין", packSizeFrom([[2, 490], [1, 472], [10, 266], [3, 246], [5, 235], [12, 176]]), null);
  check("מעט מדי שורות: אין", packSizeFrom([[24, 10], [48, 5]]), null);
};

// packSizes כבר נטען למעלה (עם getPackSizes מוחלף); הכלל עצמו לא הוחלף
function jestFreeRequire() {
  return packSizes;
}

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

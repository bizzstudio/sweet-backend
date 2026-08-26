// script/test-history-pipeline.js
//
// בדיקת האינטגרציה של "מה הלקוח קונה בפועל" בצינור הקליטה —
// הרצה: npm run history:pipeline-test
//
// ── מה זה בודק, ומה נבדק במקום אחר ──
//
// ‏script/test-purchase-history.js בודק את **כללי ההכרעה** (מתי decisive ומתי
// hint) כפונקציה טהורה, בלי מסד. הקובץ הזה בודק את מה שאי אפשר לבדוק שם:
// **סדר הקדימויות בתוך resolveItems**. אליאס גובר על היסטוריה, מק"ט גובר,
// שלילה מפורשת מבטלת, ובדיקת הזמינות ממשיכה לעצור. כל אחד מאלה הוא גבול
// שאם ייפרץ, המערכת תכניס מוצר שגוי להזמנה בשקט.
//
// ── מה הוא כותב למסד ──
//
// כמעט כלום. הפרופיל מוזרק ישירות ל-resolveItems ולכן רוב הבדיקות אינן נוגעות
// במסד בכלל. מה שכן נכתב: אליאס אחד ומסמך היסטוריה אחד, שניהם על **מזהה לקוח
// סינתטי** שאינו קיים במערכת, ושניהם נמחקים ב-finally — גם כשבדיקה נכשלת
// באמצע. השדה היחיד שנוגע בנתון אמיתי הוא מלאי של מוצר אחד, שמוחזר לערכו.

require("dotenv").config();
const mongoose = require("mongoose");

const Order = require("../models/Order");
const Product = require("../models/Product");
const ProductAlias = require("../models/ProductAlias");
const CustomerPurchaseHistory = require("../models/CustomerPurchaseHistory");
const { saveAlias } = require("../utils/productAliases");
const { buildPurchaseProfile } = require("../utils/purchaseHistoryRanking");
const { getCustomerPurchaseProfile } = require("../utils/customerPurchaseHistory");
const { resolveItems, AUTO_ACCEPT_CONFIDENCE } = require("../lib/order-ingestion/resolvers");

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

const CUSTOMER = new mongoose.Types.ObjectId();

// פרופיל היסטוריה בזיכרון. הוא נבנה מאותן שורות בדיוק שהיבוא שומר, ולכן
// הבדיקה עוברת באותו נתיב כמו הרצה אמיתית — בלי לכתוב למסד.
const profileOf = (entries) =>
  buildPurchaseProfile(
    entries.map(({ product, lines = 5, monthsAgo = 1 }) => ({
      sku: product.sku,
      product: product._id,
      name: product.title?.he,
      lines,
      totalQty: lines * 3,
      lastAt: new Date(Date.now() - monthsAgo * 30 * 24 * 3600 * 1000),
    }))
  );

const run = (rawName, historyProfile = null) =>
  resolveItems([{ rawName, quantity: 3 }], { customerId: CUSTOMER, historyProfile });

const describe = (result) => {
  if (result.items.length) {
    const item = result.items[0];
    return `${item.product.title?.he} [${item.decidedBy}]`;
  }
  if (result.unmatched.length) return "לא זוהה";
  return "נשמט";
};

/**
 * מציאת שורה שתקועה **באמת** היום.
 *
 * הבדיקה חייבת לרוץ על עמימות אמיתית ולא על עמימות מבוימת: שם מומצא היה בודק
 * שהקוד רץ, ולא שהוא פותר את מה שהוא נבנה לפתור. לכן החיפוש מתחיל מהשורות
 * שנכשלו בהזמנות אמיתיות, ובוחר את הראשונה שגם היום נשארת לא מזוהה ויש לה
 * לפחות שני מועמדים זמינים.
 */
const findStuckLine = async () => {
  const orders = await Order.find({ "ingestionError.unmatchedItems.0": { $exists: true } })
    .select("ingestionError.unmatchedItems")
    .limit(60)
    .lean();

  const names = [
    ...new Set(
      orders
        .flatMap((o) => o.ingestionError?.unmatchedItems || [])
        .map((i) => String(i?.rawName || "").trim())
        .filter((n) => n.length > 2 && n.length < 60)
    ),
  ];

  for (const rawName of names) {
    const result = await run(rawName);
    const miss = result.unmatched[0];
    if (!miss || (miss.alternatives || []).length < 1) continue;

    // המועמדים חייבים להיות ניתנים להזמנה, אחרת הבדיקה תמדוד את בדיקת
    // הזמינות במקום את ההיסטוריה
    const ids = [
      ...(miss.product ? [miss.product._id] : []),
      ...(miss.alternatives || []).map((a) => a._id),
    ];
    const usable = await Product.find({
      _id: { $in: ids },
      stock: { $gt: 5 },
      "prices.price": { $gt: 0 },
    })
      .limit(3)
      .lean();

    if (usable.length >= 2) return { rawName, candidates: usable };
  }

  return null;
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000 });

  const stuck = await findStuckLine();
  if (!stuck) {
    console.log(
      "לא נמצאה שורה תקועה עם שני מועמדים זמינים — אין על מה להריץ את הבדיקה.\n" +
        "זה יכול להיות מצב תקין (אין הזמנות שנכשלו), ולכן אין כאן כשל."
    );
    await mongoose.disconnect();
    process.exit(0);
  }

  const { rawName, candidates } = stuck;
  const [first, second] = candidates;
  console.log(`\nשורה תקועה שנבחרה: "${rawName}"`);
  console.log(`  מועמד א: ${first.title?.he} (${first.sku})`);
  console.log(`  מועמד ב: ${second.title?.he} (${second.sku})`);

  const savedStock = first.stock;
  const createdAliases = [];

  try {
    section("בסיס: בלי היסטוריה");
    check("השורה נשארת לא מזוהה", describe(await run(rawName)), "לא זוהה");

    section("היסטוריה ודאית מכריעה");
    const withFirst = await run(rawName, profileOf([{ product: first }]));
    check(
      "המוצר שהלקוח קונה נבחר",
      describe(withFirst),
      `${first.title?.he} [catalog+היסטוריה]`
    );
    check(
      "הביטחון מגיע לסף הקבלה",
      (withFirst.items[0]?.confidence || 0) >= AUTO_ACCEPT_CONFIDENCE,
      true
    );

    // ── זו הבדיקה שמפרידה בין דירוג מחדש לבין "הגברת ביטחון" ──
    //
    // אילו ההיסטוריה רק הייתה מרימה את הביטחון של המועמד המוביל, שתי ההרצות
    // היו מחזירות את אותו מוצר. כאן היא חייבת לבחור מוצר **אחר**.
    section("היסטוריה בוחרת מבין המועמדים, לא מרימה את המוביל");
    check(
      "מועמד אחר נבחר כשהוא זה שבהיסטוריה",
      describe(await run(rawName, profileOf([{ product: second }]))),
      `${second.title?.he} [catalog+היסטוריה]`
    );

    section("שני מוצרים שהלקוח קונה — לא מכריעים");
    const both = await run(
      rawName,
      profileOf([
        { product: first, lines: 4 },
        { product: second, lines: 4 },
      ])
    );
    check("השורה נשארת לאדם", describe(both), "לא זוהה");
    check(
      "אבל ההסבר כולל את מה שהלקוח קנה",
      (both.unmatched[0]?.failReason || "").includes("הלקוח הזמין בעבר"),
      true
    );

    section("אליאס גובר על היסטוריה");
    createdAliases.push(
      (await saveAlias({ rawName, productId: second._id, customerId: CUSTOMER }))._id
    );
    const aliased = await run(rawName, profileOf([{ product: first }]));
    check(
      "ההכרעה האנושית היא שחלה",
      (aliased.items[0]?.decidedBy || "").startsWith("alias"),
      true
    );
    check(
      "והמוצר הוא זה שאדם בחר",
      aliased.items[0]?.product?.title?.he,
      second.title?.he
    );
    await ProductAlias.deleteMany({ customer: CUSTOMER });

    section("שלילה מפורשת מבטלת את ההיסטוריה");
    // הסייג נכתב דווקא כי הפעם הלקוח רוצה משהו אחר מהרגיל. מה שהוא נהג לקנות
    // אינו יכול לבטל את המשפט היחיד שהוא טרח לכתוב.
    const negated = await run(
      `${rawName} (לא ${first.title?.he})`,
      profileOf([{ product: first }])
    );
    check(
      "המוצר שנשלל אינו נכנס להזמנה",
      String(negated.items[0]?.product?._id || "") === String(first._id),
      false
    );

    section("שורה בלי כמות: נדרשת לתאר את המוצר");
    // ‏"קפה טורקי" בלי כמות היא הצורה הנפוצה להזמין בווצאפ וחייבת לעבוד.
    // שורת כתובת שנקראה בטעות כפריט — לא.
    const assumedRun = (text) =>
      resolveItems([{ rawName: text, quantity: 1, quantityAssumed: true }], {
        customerId: CUSTOMER,
        historyProfile: profileOf([{ product: first }]),
      });

    const entered = (result) =>
      String(result.items[0]?.product?._id || "") === String(first._id);

    // הטקסט שמתאר את המוצר במדויק — כל מילה בו נמצאת בשם המוצר
    check("שורה שמתארת את המוצר נכנסת", entered(await assumedRun(first.title?.he)), true);

    // ── שורת כתובת ──
    //
    // הטקסט אינו מתאר את המוצר, ולכן גם אם ההתאמה מצאה אותו והלקוח קונה אותו
    // בקביעות — הוא לא ייכנס. זה מה שמונע מכתובת לצאת במשלוח כפריט.
    check(
      "שורת כתובת אינה נכנסת גם כשהמוצר בהיסטוריה",
      entered(await assumedRun("קומה 3 דירה 12 הרצל בני ברק")),
      false
    );

    section("בדיקת הזמינות ממשיכה לעצור");
    // ההיסטוריה עונה על "לאיזה מוצר התכוונו", לא על "אפשר לספק אותו".
    await Product.updateOne({ _id: first._id }, { $set: { stock: 0 } });
    check(
      "מוצר שאזל אינו נכנס גם כשההיסטוריה ודאית",
      String(
        (await run(rawName, profileOf([{ product: first }]))).items[0]?.product?._id || ""
      ) === String(first._id),
      false
    );
    await Product.updateOne({ _id: first._id }, { $set: { stock: savedStock } });

    section("שליפת הפרופיל מהמסד");
    await CustomerPurchaseHistory.create({
      customer: CUSTOMER,
      items: [
        {
          sku: first.sku,
          product: first._id,
          name: first.title?.he,
          lines: 6,
          totalQty: 18,
          lastAt: new Date(),
        },
      ],
      itemsCount: 1,
      matchedInCatalog: 1,
    });
    const loaded = await getCustomerPurchaseProfile(CUSTOMER);
    check("הפרופיל נטען", Boolean(loaded), true);
    check(
      "והוא מכריע בדיוק כמו פרופיל שנבנה בזיכרון",
      describe(await run(rawName, loaded)),
      `${first.title?.he} [catalog+היסטוריה]`
    );

    check(
      "לקוח בלי היסטוריה מקבל null ולא פרופיל ריק",
      await getCustomerPurchaseProfile(new mongoose.Types.ObjectId()),
      null
    );
  } finally {
    // ניקוי ב-finally: בדיקה שנכשלה באמצע אסורה להשאיר נתונים במסד אמיתי,
    // ובוודאי לא מוצר עם מלאי 0 שלא היה כזה
    await ProductAlias.deleteMany({ _id: { $in: createdAliases } });
    await ProductAlias.deleteMany({ customer: CUSTOMER });
    await CustomerPurchaseHistory.deleteMany({ customer: CUSTOMER });
    await Product.updateOne({ _id: first._id }, { $set: { stock: savedStock } });
  }

  console.log(`\n${"═".repeat(58)}`);
  console.log(`עברו: ${passed}   נכשלו: ${failures.length}`);
  if (failures.length) {
    console.log("\nכשלונות:");
    failures.forEach((f) => console.log(`  • ${f}`));
  }

  await mongoose.disconnect();
  process.exit(failures.length ? 1 : 0);
})().catch(async (err) => {
  console.error("שגיאה:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

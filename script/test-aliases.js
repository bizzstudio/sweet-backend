// script/test-aliases.js
//
// בדיקת מנגנון הלימוד "איך הלקוח קורא למוצר" — הרצה: npm run alias:test
//
// ── למה זה קיים כסקריפט ──
//
// אליאס עוקף את מנוע ההתאמה ונכנס להזמנה בביטחון מלא. זו בדיוק ההתנהגות
// הרצויה — ובדיוק הסיבה שטעות כאן יקרה: היא מכניסה מוצר שגוי להזמנה בשקט,
// בלי שאיש יעצור אותה. חמש ההתנהגויות שנבדקות כאן הן מה שמפריד בין "המערכת
// זוכרת" לבין "המערכת מנחשת בביטחון".
//
// בניגוד ל-ingest:filter-test, הבדיקה הזו **דורשת מסד**: אליאס הוא רשומה,
// והשאלה הנבדקת היא איך היא משתלבת בצינור. היא יוצרת רשומות זמניות ומוחקת
// אותן בסוף, גם כשהיא נכשלת באמצע.

require("dotenv").config();
const mongoose = require("mongoose");

const Product = require("../models/Product");
const ProductAlias = require("../models/ProductAlias");
const { saveAlias } = require("../utils/productAliases");
const { resolveItems } = require("../lib/order-ingestion/resolvers");

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

// שם חסר משמעות בכוונה. הניסוח הראשון כאן היה "בדיקת אליאס זמנית", ומנוע
// ההתאמה מצא לו בקטלוג את "בדיקת קורונה" לפי המילה "בדיקת" — כלומר הבדיקה
// מדדה את מנוע ההתאמה במקום את האליאס. שם ללא אף מילה אמיתית מבודד אותה.
const TEST_NAME = "קסדרלימ טרפוזין ולכביצי";

const resolveOne = (rawName, customerId) =>
  resolveItems([{ rawName, quantity: 3 }], { customerId });

const describe = (result) => {
  if (result.items.length) {
    const item = result.items[0];
    return `${item.product.title?.he} [${item.decidedBy}]`;
  }
  if (result.unmatched.length) return "לא זוהה";
  return "נשמט";
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000 });

  // שני מוצרים אמיתיים ושונים מהקטלוג — התוכן שלהם לא משנה, רק שהם קיימים
  // ושיש להם מלאי, כדי שהבדיקה תמדוד את האליאס ולא את בדיקת הזמינות.
  const [productA, productB] = await Product.find({ stock: { $gt: 10 } })
    .limit(2)
    .lean();

  if (!productA || !productB) {
    console.log("אין בקטלוג שני מוצרים עם מלאי — אי אפשר להריץ את הבדיקה");
    await mongoose.disconnect();
    process.exit(1);
  }

  const customer = new mongoose.Types.ObjectId();
  const otherCustomer = new mongoose.Types.ObjectId();
  const created = [];

  try {
    section("בלי אליאס");
    check(
      "שם שאינו בקטלוג אינו מזוהה",
      describe(await resolveOne(TEST_NAME, customer)),
      "לא זוהה"
    );

    section("אליאס כלל-מערכתי");
    created.push(
      (await saveAlias({ rawName: TEST_NAME, productId: productA._id, customerId: null }))._id
    );
    check(
      "חל על לקוח כלשהו",
      describe(await resolveOne(TEST_NAME, otherCustomer)),
      `${productA.title?.he} [alias(כללי)]`
    );

    section("אליאס של הלקוח גובר");
    created.push(
      (await saveAlias({ rawName: TEST_NAME, productId: productB._id, customerId: customer }))._id
    );
    check(
      "הלקוח מקבל את המוצר שהוכרע עבורו",
      describe(await resolveOne(TEST_NAME, customer)),
      `${productB.title?.he} [alias(לקוח)]`
    );
    check(
      "לקוח אחר ממשיך לקבל את הכלל-מערכתי",
      describe(await resolveOne(TEST_NAME, otherCustomer)),
      `${productA.title?.he} [alias(כללי)]`
    );

    section("הכרעה חוזרת מחליפה, לא מכפילה");
    await saveAlias({ rawName: TEST_NAME, productId: productA._id, customerId: customer });
    check(
      "רשומה אחת לכל (שם, לקוח)",
      await ProductAlias.countDocuments({ customer }),
      1
    );
    check(
      "ההכרעה החדשה היא שחלה",
      describe(await resolveOne(TEST_NAME, customer)),
      `${productA.title?.he} [alias(לקוח)]`
    );

    // ── שלילה מפורשת מבטלת את האליאס ──
    //
    // "X (לא Y)" הוא בקשה מסויגת, והסייג נכתב דווקא כי הפעם הלקוח רוצה משהו
    // אחר מהרגיל. אליאס אינו יודע דבר על הסייג, ולהחיל אותו פירושו להתעלם
    // מהמשפט היחיד שהלקוח טרח לכתוב.
    section("שלילה מפורשת מבטלת את האליאס");
    // הטענה היא "לא דרך האליאס", ולא "לא זוהה כלל": אחרי שהאליאס בוטל, מנוע
    // ההתאמה הרגיל ממשיך לעבוד ועשוי למצוא מועמד לגיטימי. מה שאסור הוא שהמוצר
    // שהוכרע יחזור מהדלת האחורית.
    const negated = await resolveOne(`${TEST_NAME} (לא ${productA.title?.he})`, customer);
    check(
      "לא נכנס להזמנה דרך האליאס",
      (negated.items[0]?.decidedBy || "").startsWith("alias"),
      false
    );

    // ── האליאס אינו עוקף בדיקת זמינות ──
    //
    // הוא עונה על "לאיזה מוצר התכוונו", לא על "אפשר לספק אותו". מוצר שאזל
    // חייב להמשיך להיעצר, אחרת ההזמנה יוצאת עם פריט שאין.
    section("זמינות עדיין נבדקת");
    await Product.updateOne({ _id: productA._id }, { $set: { stock: 0 } });
    check(
      "מוצר שאזל נעצר גם דרך אליאס",
      describe(await resolveOne(TEST_NAME, customer)),
      "לא זוהה"
    );
    await Product.updateOne({ _id: productA._id }, { $set: { stock: productA.stock } });
  } finally {
    // הניקוי ב-finally: בדיקה שנכשלה באמצע אסור שתשאיר אליאסים במסד אמיתי
    await ProductAlias.deleteMany({ _id: { $in: created } });
    await ProductAlias.deleteMany({ customer: { $in: [customer, otherCustomer] } });
    await Product.updateOne({ _id: productA._id }, { $set: { stock: productA.stock } });
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

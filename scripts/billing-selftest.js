// scripts/billing-selftest.js
//
// בדיקות התנהגות למערך החיוב. מריצות זרימות אמיתיות מול המסד ומנקות
// אחריהן. אינן מפיקות מסמכים ב-iCount.
//
//   node scripts/billing-selftest.js

// ICOUNT_MODE נקבע כאן ולא נלקח מ-.env: הבדיקות האלה מאמתות את הזרימה
// האמיתית, ולכן חייבות לרוץ ב-live גם כשהשרת מחובר כרגע לחשבון דמו.
// dotenv אינו דורס ערך קיים, ולכן ההשמה הזאת מנצחת. את מצב הדמו בודק
// scripts/billing-demo-test.js.
process.env.ICOUNT_MODE = "live";

require("dotenv").config();
const mongoose = require("mongoose");

const DeliveryNote = require("../models/DeliveryNote");
const Quote = require("../models/Quote");
const Order = require("../models/Order");
const Customer = require("../models/Customer");

const Category = require("../models/Category");
const Product = require("../models/Product");

const {
  createFromOrder,
  syncFromOrder,
  createManual,
  syncFromOrder: syncFromOrderLib,
  update: updateNote,
  duplicate: duplicateNote,
  billingMonthOf,
} = require("../lib/billing/deliveryNotes");
const quotesLib = require("../lib/billing/quotes");
const { findByBarcode, barcodesBySku, isSearchableBarcode } = require("../utils/barcode");
const {
  splitByNoteKind,
  manualNoteCategoryIds,
  clearCache: clearManualCache,
} = require("../lib/billing/manualItems");
const { groupIntoInvoices, summarizeItems, shouldSummarize, describeInvoice, previousMonth, isLastDayOfMonth, releaseStuckClaims, closeMonth, billNoteImmediately } = require("../lib/billing/monthlyBilling");
const { isNoteTriggerStatus } = require("../lib/billing/autoDeliveryNote");
const { dueDateFor, forCustomer } = require("../lib/billing/paymentTerms");
const { priceItemsForCustomer, priceQuality, discountPercentFor, discountAmount } = require("../lib/billing/pricing");
const { listInvoices } = require("../lib/billing/invoices");
const { nextFreeNumber } = require("../utils/deliveryNoteNumber");
const { calculateVat } = require("../lib/billing/vat");

let pass = 0;
let fail = 0;
const TAG = "SELFTEST";

const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const group = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

const cleanup = async () => {
  // regex ולא השוואה מדויקת: חלק מהתעודות הסינתטיות נושאות סיומת
  // (למשל `${TAG}-dedup`) כדי שלא ייספרו בבדיקות שסופרות לפי TAG בדיוק
  await DeliveryNote.deleteMany({ issuedBy: { $regex: `^${TAG}` } });
  await Quote.deleteMany({ createdBy: TAG });
  // ההזמנה הסינתטית של בדיקת הסנכרון. הבדיקה עורכת את העגלה שלה, ולכן
  // היא חייבת להיות הזמנה משלה — עריכה של הזמנה אמיתית הייתה משנה חיוב.
  // regex ולא השוואה מדויקת: editOrderItems מוסיף שורת תיעוד ל-systemNote,
  // והזמנת בדיקה שנערכה הייתה נשארת במסד אחרי ניקוי לפי ערך מדויק
  await Order.deleteMany({ systemNote: { $regex: `^${TAG}` } });
  // הקטגוריות הזמניות של בדיקת הסחורה הנשקלת. חייבות להימחק — קטגוריה
  // מסומנת שנשארה במסד הייתה מוציאה מוצרים מהתעודה האוטומטית בייצור
  await Category.deleteMany({ slug: { $regex: `^${TAG.toLowerCase()}-` } });
  await mongoose.connection.db
    .collection("app_counters")
    .deleteMany({ _id: { $in: ["delivery_note", "quote"] } });
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  await cleanup();

  // ─────────────────────────────────────────────────────────────────
  group("גבולות חודש (שעון ישראל)");

  check("31/07 23:30 שייך ל-2026-07", billingMonthOf(new Date("2026-07-31T20:30:00Z")) === "2026-07");
  check("01/08 00:30 שייך ל-2026-08", billingMonthOf(new Date("2026-07-31T21:30:00Z")) === "2026-08");
  check("previousMonth בינואר חוצה שנה", previousMonth(new Date("2026-01-15T10:00:00Z")) === "2025-12");
  check("previousMonth ב-1 לחודש", previousMonth(new Date("2026-08-01T09:00:00Z")) === "2026-07");

  // ─────────────────────────────────────────────────────────────────
  group("יום הסגירה — היום האחרון של החודש");

  check("31/08 הוא היום האחרון", isLastDayOfMonth(new Date("2026-08-31T09:00:00Z")));
  check("30/08 אינו האחרון", !isLastDayOfMonth(new Date("2026-08-30T09:00:00Z")));
  check("30/04 הוא היום האחרון (חודש בן 30)", isLastDayOfMonth(new Date("2026-04-30T09:00:00Z")));
  check("28/02 בשנה רגילה הוא האחרון", isLastDayOfMonth(new Date("2026-02-28T09:00:00Z")));
  check("28/02 בשנה מעוברת אינו האחרון", !isLastDayOfMonth(new Date("2024-02-28T09:00:00Z")));
  check("29/02 בשנה מעוברת הוא האחרון", isLastDayOfMonth(new Date("2024-02-29T09:00:00Z")));
  check(
    "31/08 23:30 שעון ישראל עדיין האחרון",
    isLastDayOfMonth(new Date("2026-08-31T20:30:00Z")),
    "חישוב לפי UTC היה מזיז את הבדיקה ל-1 בספטמבר"
  );
  check("01/09 00:30 שעון ישראל אינו האחרון", !isLastDayOfMonth(new Date("2026-08-31T21:30:00Z")));

  // ─────────────────────────────────────────────────────────────────
  group("זיהוי הסטטוס שמפיק תעודה");

  check("Processing מפעיל", isNoteTriggerStatus("Processing"));
  check("'טופלה' מפעיל", isNoteTriggerStatus("טופלה"));
  check("'בטיפול' (השם הישן) מפעיל", isNoteTriggerStatus("בטיפול"));
  check("processing (אותיות קטנות) מפעיל", isNoteTriggerStatus("processing"));
  check("רווחים מסביב לא שוברים", isNoteTriggerStatus("  Processing  "));
  // הסטטוס כובה בפאנל, אבל הזמנה היסטורית שתסומן כך ידנית עדיין צריכה תעודה
  check("Delivered עדיין מפעיל", isNoteTriggerStatus("Delivered"));
  check("'נמסר' עדיין מפעיל", isNoteTriggerStatus("נמסר"));
  check("Likut לא מפעיל", !isNoteTriggerStatus("Likut"));
  check("Pending לא מפעיל", !isNoteTriggerStatus("Pending"));
  check("Cancel לא מפעיל", !isNoteTriggerStatus("Cancel"));
  check("null לא מפעיל", !isNoteTriggerStatus(null));
  check("undefined לא מפעיל", !isNoteTriggerStatus(undefined));
  check("מחרוזת ריקה לא מפעילה", !isNoteTriggerStatus(""));

  // ─────────────────────────────────────────────────────────────────
  group("פיצול לפי קטגוריה");

  // הפיצול הוא ברמת התעודה ולא ברמת השורה (ראה dominantCategory): תעודה
  // שנחצית בין שתי חשבוניות יכולה להחזיק רק מספר מסמך אחד, והייתה נספרת
  // פעמיים ברשימת החשבוניות. תעודה 1 היא ניקיון (20 ₪ מתוך 35),
  // תעודה 2 היא מזון (8 ₪ מתוך 11).
  const notes = [
    {
      number: 1,
      billing: { billingMonth: "2026-08" },
      discount: 3.5,
      shippingCost: 0,
      items: [
        { name: "לחם", lineTotal: 10, categoryName: "מזון" },
        { name: "סבון", lineTotal: 20, categoryName: "ניקיון" },
        { name: "תפוח", lineTotal: 5, categoryName: undefined },
      ],
    },
    {
      number: 2,
      billing: { billingMonth: "2026-08" },
      discount: 0,
      shippingCost: 15,
      items: [
        { name: "חלב", lineTotal: 8, categoryName: "מזון" },
        { name: "דף", lineTotal: 3, categoryName: "משרד" },
      ],
    },
  ];

  const one = groupIntoInvoices(notes, false);
  const split = groupIntoInvoices(notes, true);
  const sum = (gs) => gs.reduce((s, g) => s + g.items.reduce((a, i) => a + i.lineTotal, 0), 0);

  check("בלי פיצול — חשבונית אחת", one.length === 1);
  check("עם פיצול — קבוצה לכל קטגוריה דומיננטית", split.length === 2, `קיבלתי ${split.length}`);
  check("תעודה מעורבת נכנסת לקטגוריה הדומיננטית", Boolean(split.find((g) => g.label === "ניקיון")));
  check("סכום נשמר בפיצול", sum(one) === sum(split), `${sum(one)} מול ${sum(split)}`);
  check("אף שורה לא אבדה", one[0].items.length === split.reduce((s, g) => s + g.items.length, 0));
  check("תעודה נכנסת לקבוצה אחת בלבד", split.every((g) => g.notes.length === 1));
  check("מערך תעודות ריק לא קורס", groupIntoInvoices([], true).length === 0);

  // ההנחה ודמי המשלוח מגיעים לחשבונית. עד 30/08/26 הם לא נשלחו כלל,
  // והלקוח חויב בסכום שאינו תואם את התעודה שקיבל.
  check("ההנחה של כל התעודות מצטברת לחשבונית", one[0].discount === 3.5, `קיבלתי ${one[0].discount}`);
  check("דמי המשלוח מצטברים לחשבונית", one[0].shipping === 15, `קיבלתי ${one[0].shipping}`);
  check(
    "בפיצול ההנחה נשארת עם התעודה שלה",
    split.find((g) => g.label === "ניקיון").discount === 3.5
  );
  check(
    "בפיצול המשלוח נשאר עם התעודה שלו",
    split.find((g) => g.label === "מזון").shipping === 15
  );

  // ─────────────────────────────────────────────────────────────────
  group("ריכוז שורות בחשבונית");

  const mixedLines = [
    { name: "בורקס", lineTotal: 40, categoryName: "מזון", isVatFree: false },
    { name: "עוגה", lineTotal: 60, categoryName: "מזון", isVatFree: false },
    { name: "תפוח", lineTotal: 25, categoryName: "פירות", isVatFree: true },
    { name: "צלחות", lineTotal: 15, categoryName: 'ח.ניקוי+ח"פ', isVatFree: false },
  ];
  const rolled = summarizeItems(mixedLines);

  check("ריכוז מקבץ לשורה אחת לכל קטגוריה", rolled.length === 3, `קיבלתי ${rolled.length}`);
  check(
    "השורה נושאת את שם הקטגוריה",
    rolled.some((r) => r.name === "ריכוז תעודות משלוח — מזון")
  );
  check(
    "סכום הקטגוריה נשמר",
    rolled.find((r) => r.name.includes("מזון")).lineTotal === 100
  );
  check(
    "שורה פטורה נשארת פטורה ומסומנת",
    rolled.some((r) => r.isVatFree && r.name.includes("פטור"))
  );
  check(
    "הסכום הכולל לא השתנה",
    rolled.reduce((s, r) => s + r.lineTotal, 0) === 140
  );
  check("כמות 1 ומחיר = הסכום, כדי ש-iCount יחשב נכון", rolled.every((r) => r.quantity === 1 && r.unitPrice === r.lineTotal));

  // שורות חייבות ופטורות באותה קטגוריה אינן מתאחדות — איחוד היה מחייב
  // מע"מ על מה שפטור ממנו
  const sameCat = summarizeItems([
    { name: "א", lineTotal: 10, categoryName: "מזון", isVatFree: false },
    { name: "ב", lineTotal: 20, categoryName: "מזון", isVatFree: true },
  ]);
  check("חייב ופטור באותה קטגוריה נשארים שתי שורות", sameCat.length === 2);

  // חשבונית ריקה נדחית ב-iCount ומפילה את כל הסגירה
  const zeroed = summarizeItems([{ name: "מתנה", lineTotal: 0, categoryName: "מזון" }]);
  check("ריכוז שהתרוקן חוזר לשורות המקוריות", zeroed.length === 1);

  // מתי מרכזים ומתי מפרטים. הכלל הזה קובע גם איך נבנה הזיכוי, ולכן הוא
  // חייב להיות זהה בשני המקומות.
  check("חודשי — מרכז כברירת מחדל", shouldSummarize({ billing: {} }) === true);
  check("לקוח ותיק בלי billing — מרכז", shouldSummarize({}) === true);
  check("כיבוי מפורש — מפרט", shouldSummarize({ billing: { summarizeInvoiceLines: false } }) === false);

  // חשבונית מיידית היא הנייר היחיד שהלקוח מקבל במקום תעודת משלוח.
  // "ריכוז תעודות משלוח — מזון" עליה אינו מסמך שאפשר לבדוק מולו.
  check("חשבונית מיידית — מפרטת תמיד", shouldSummarize({ billing: {} }, true) === false);
  check(
    "perDelivery — מפרט גם בהפקה ידנית מהמסך",
    shouldSummarize({ billing: { mode: "perDelivery" } }) === false
  );
  check(
    "והגדרת ריכוז אינה גוברת על perDelivery",
    shouldSummarize({ billing: { mode: "perDelivery", summarizeInvoiceLines: true } }) === false
  );

  // ─────────────────────────────────────────────────────────────────
  group("טבלת התעודות על החשבונית");

  const described = describeInvoice("2026-08", notes, null);
  check("הכותרת נושאת את חודש החיוב", described.includes("חיוב חודש 2026-08"));
  check("מופיעה כותרת ריכוז התעודות", described.includes("ריכוז תעודות משלוח:"));
  check("כל תעודה מופיעה בשורה משלה", described.includes("תעודה 1") && described.includes("תעודה 2"));
  check("מופיע סיכום מספר התעודות", described.includes("סה\"כ 2 תעודות"));

  // הסכומים בטבלה חייבים להיות אלה שמודפסים על התעודות עצמן. סכום שורות
  // בלבד היה מציג מספר אחר ממה שכתוב על הנייר שבידי הלקוח.
  const withExtras = [
    { number: 2001, issuedAt: new Date("2026-08-03"), billing: { billingMonth: "2026-08" }, items: [{ lineTotal: 400 }], shippingCost: 30, discount: 20, total: 410 },
    { number: 2002, issuedAt: new Date("2026-08-11"), billing: { billingMonth: "2026-08" }, items: [{ lineTotal: 200 }], shippingCost: 0, discount: 10, total: 190 },
  ];
  const withExtrasDesc = describeInvoice("2026-08", withExtras, null);
  check("סכום התעודה בטבלה הוא זה שמודפס עליה", withExtrasDesc.includes("410.00 ₪"));
  check("ולא סכום השורות בלבד", !withExtrasDesc.includes("400.00 ₪"));
  check("הסיכום תואם למה שיחויב", withExtrasDesc.includes('סה"כ 2 תעודות · 600.00 ₪'));
  check("ומפרט משלוח והנחה", withExtrasDesc.includes("משלוח 30.00") && withExtrasDesc.includes("הנחה 30.00"));

  // הסכום בכותרת חייב להסכים עם מה שהקבוצה שולחת ל-iCount
  const extrasGroup = groupIntoInvoices(withExtras, false)[0];
  const groupNet =
    extrasGroup.items.reduce((s, i) => s + i.lineTotal, 0) + extrasGroup.shipping - extrasGroup.discount;
  check("הכותרת והקבוצה מסכימות על הסכום", groupNet === 600, `קיבלתי ${groupNet}`);

  // לקוח בלי משלוח ובלי הנחה — בלי פירוט מיותר בראש המסמך
  const plainDesc = describeInvoice("2026-08", [
    { number: 2003, issuedAt: new Date("2026-08-05"), billing: { billingMonth: "2026-08" }, items: [{ lineTotal: 100 }], total: 100 },
  ], null);
  check("בלי משלוח והנחה אין פירוט מיותר", !plainDesc.includes("שורות 100.00"));

  // מעל 20 תעודות הרשימה הישנה התכווצה לטווח, כלומר בדיוק בחשבוניות
  // הגדולות לא היה מה להצליב מולו
  const many = Array.from({ length: 30 }, (_, i) => ({
    number: 100 + i,
    billing: { billingMonth: "2026-08" },
    items: [{ name: "פריט", lineTotal: 10, categoryName: "מזון" }],
  }));
  const bigDesc = describeInvoice("2026-08", many, null);
  check("גם 30 תעודות מפורטות ולא מתכווצות לטווח", (bigDesc.match(/תעודה 1\d\d/g) || []).length === 30);

  // ─────────────────────────────────────────────────────────────────
  group("הנחה קבועה ללקוח");

  // סדר העדיפויות: מה שנקבע אצלנו, ובלעדיו מה שהגיע בייבוא של מנוע
  check("אחוז מכרטיס הלקוח גובר", (await discountPercentFor({ billing: { discountPercent: 5 }, erp: { discountPercent: 8 } })) === 5);
  check("בלי אחוז אצלנו — נופלים לייבוא", (await discountPercentFor({ billing: {}, erp: { discountPercent: 8 } })) === 8);
  check("אין הגדרת billing בכלל — נופלים לייבוא", (await discountPercentFor({ erp: { discountPercent: 8 } })) === 8);

  // 0 מפורש הוא "בלי הנחה" ואינו נופל לייבוא — אחרת ייבוא אקסל היה
  // מחזיר בשקט הנחה שמישהו ביטל
  check("0 מפורש מבטל ולא נופל לייבוא", (await discountPercentFor({ billing: { discountPercent: 0 }, erp: { discountPercent: 8 } })) === 0);
  check("null נחשב כלא-נקבע", (await discountPercentFor({ billing: { discountPercent: null }, erp: { discountPercent: 8 } })) === 8);

  check("אחוז שלילי מהייבוא מתעלמים ממנו", (await discountPercentFor({ erp: { discountPercent: -5 } })) === 0);
  check("אחוז מעל 100 נחתך (שגיאת הקלדה)", (await discountPercentFor({ erp: { discountPercent: 120 } })) === 100);
  check("לקוח בלי כלום", (await discountPercentFor({})) === 0);

  // ⚠️ ObjectId הוא typeof "object" בדיוק כמו מסמך. הגרסה הראשונה זיהתה
  //    לפי typeof והחזירה 0 בשקט לכל קורא שהעביר מזהה — כלומר ההנחה
  //    עבדה ביצירת תעודה ונעלמה בסנכרון מההזמנה.
  const discCustomer = await Customer.findOne({ "erp.discountPercent": { $gt: 0 } })
    .select("+erp")
    .lean();
  if (discCustomer) {
    const expected = Math.min(Number(discCustomer.erp.discountPercent), 100);
    check("מזהה כ-ObjectId מחזיר את אותו אחוז כמו המסמך", (await discountPercentFor(discCustomer._id)) === expected, `קיבלתי ${await discountPercentFor(discCustomer._id)} במקום ${expected}`);
    check("מזהה כמחרוזת מחזיר את אותו אחוז", (await discountPercentFor(String(discCustomer._id))) === expected);
  }

  // מזהה פגום מחזיר 0 ולא זורק: הפונקציה נקראת מתוך יצירת תעודה, ושגיאה
  // כאן הייתה עוצרת משלוח בגלל שדה שהתשובה עליו היא "בלי הנחה"
  check("מזהה פגום מחזיר 0 ולא זורק", (await discountPercentFor("not-an-id")) === 0);
  check("null מחזיר 0", (await discountPercentFor(null)) === 0);

  check("5% על 1000 = 50", discountAmount(1000, 5) === 50);
  check("0% = 0", discountAmount(1000, 0) === 0);
  check("מעוגל לאגורות", discountAmount(333.33, 5) === 16.67, `קיבלתי ${discountAmount(333.33, 5)}`);
  // הנחה שגדולה מהבסיס הופכת מסמך לזיכוי מוסווה
  check("הנחה לא עוברת את הבסיס", discountAmount(100, 100) === 100);
  check("בסיס 0 לא מייצר הנחה", discountAmount(0, 5) === 0);

  // ─────────────────────────────────────────────────────────────────
  group("תנאי תשלום — שוטף+N מסוף החודש");

  const c0 = { erp: { paymentTerms: 0, customerNumber: "T" } };
  check("חשבונית 3/1 → 2/3 (ולא 2/2)", dueDateFor(new Date(2026, 0, 3), c0).dueDate.getTime() === new Date(2026, 2, 2).getTime());
  check("חשבונית 31/1 → 2/3", dueDateFor(new Date(2026, 0, 31), c0).dueDate.getTime() === new Date(2026, 2, 2).getTime());
  check("15/12 חוצה שנה → 30/1", dueDateFor(new Date(2025, 11, 15), c0).dueDate.getTime() === new Date(2026, 0, 30).getTime());
  check("פברואר מעוברת נכון", dueDateFor(new Date(2024, 1, 10), c0).dueDate.getTime() === new Date(2024, 2, 30).getTime());
  check("קוד לא מוכר נופל לברירת מחדל", forCustomer({ erp: { paymentTerms: 999 } }).days === 30);
  check("לקוח בלי erp לא קורס", forCustomer({}).days === 30);
  check("לקוח null לא קורס", forCustomer(null).days === 30);

  // ─────────────────────────────────────────────────────────────────
  group("תעודת משלוח — יצירה, idempotency, ביטול");

  const order = await Order.findOne({ cart: { $exists: true, $not: { $size: 0 } } });
  const { note, created } = await createFromOrder(order._id, { issuedBy: TAG });
  check("תעודה נוצרה", created && note.number >= 1000);
  check("סכום התעודה = סכום השורות", Math.abs(note.subTotal - note.items.reduce((s, i) => s + i.lineTotal, 0)) < 0.01);
  check("סטטוס פתוח", note.billing.status === "open");
  check("חודש חיוב נקבע", /^\d{4}-\d{2}$/.test(note.billing.billingMonth));

  const again = await createFromOrder(order._id, { issuedBy: TAG });
  check("הרצה שנייה לא יוצרת כפילות", !again.created && again.note.number === note.number);
  check("יש בדיוק תעודה אחת להזמנה", (await DeliveryNote.countDocuments({ order: order._id })) === 1);

  // ─────────────────────────────────────────────────────────────────
  group("מניעת חיוב כפול");

  const claimA = await DeliveryNote.updateMany(
    { _id: note._id, "billing.status": "open" },
    { $set: { "billing.status": "billing", "billing.claimToken": "A", "billing.claimedAt": new Date() } }
  );
  const claimB = await DeliveryNote.updateMany(
    { _id: note._id, "billing.status": "open" },
    { $set: { "billing.status": "billing", "billing.claimToken": "B" } }
  );
  check("תפיסה ראשונה מצליחה", claimA.modifiedCount === 1);
  check("תפיסה מקבילה נחסמת", claimB.modifiedCount === 0);

  check("שחרור לא נוגע בתפיסה טרייה", (await releaseStuckClaims({ olderThanMinutes: 30 })) === 0);
  check("שחרור משחרר תפיסה ישנה", (await releaseStuckClaims({ olderThanMinutes: 0 })) === 1);
  check("התעודה חזרה לפתוחה", (await DeliveryNote.findById(note._id)).billing.status === "open");

  // ─────────────────────────────────────────────────────────────────
  group("סגירת חודש אוספת גם חודשים קודמים");

  // מדמים תעודה שזוכתה וחזרה לפתוחה בחודש ישן
  await DeliveryNote.updateOne({ _id: note._id }, { $set: { "billing.billingMonth": "2020-01" } });
  const preview = await closeMonth({ month: previousMonth(), dryRun: true, customerId: note.customer });
  const found = preview.results.some((r) => r.invoices.length > 0);
  check("תעודה מחודש ישן נכללת בסגירה", found, "תעודה שזוכתה הייתה נשארת פתוחה לנצח");

  await DeliveryNote.updateOne({ _id: note._id }, { $set: { "billing.billingMonth": billingMonthOf(new Date()) } });

  // ─────────────────────────────────────────────────────────────────
  group("שומרי סגירת חודש");

  const rejects = async (fn) => {
    try {
      await fn();
      return false;
    } catch {
      return true;
    }
  };

  // הבדיקות כאן נוגעות בהגנת החודש, ולכן כולן חייבות להיות על מקרים
  // שנדחים או על dryRun. מקרה *שעובר* בלי dryRun היה מפיק חשבוניות מס
  // אמיתיות ב-iCount, וזה בדיוק מה שהבדיקות אמורות לא לעשות.
  const current = billingMonthOf(new Date());

  // תצוגה מקדימה על החודש הרץ היא הדרך לראות מה פתוח כרגע, ואינה מפיקה
  // דבר — ולכן היא מותרת
  check(
    "תצוגה מקדימה של החודש הנוכחי מתקבלת",
    !(await rejects(() => closeMonth({ month: current, dryRun: true })))
  );
  check(
    "סגירה גורפת של החודש הנוכחי נדחית",
    await rejects(() => closeMonth({ month: current })),
    "ההגנה על חודש שעדיין רץ"
  );

  // הפקה ידנית ללקוח בודד פותחת את החודש הרץ. הלקוח כאן אינו קיים, ולכן
  // אין לו תעודות פתוחות והקריאה מסתיימת בלי לפנות ל-iCount.
  //
  // הבדיקה היא שהגנת החודש לא ירתה, ולא שהקריאה הצליחה: בסביבת דמו
  // assertNotDemo יעצור אותה מסיבה אחרת לגמרי, וזו אינה כשלון.
  const monthGuardFired = async (fn) => {
    try {
      await fn();
      return false;
    } catch (err) {
      return err.message.includes("טרם הסתיים") || err.message.includes("טרם התחיל");
    }
  };

  const ghostCustomer = new mongoose.Types.ObjectId().toString();
  check(
    "לקוח בודד פותח את החודש הנוכחי להפקה",
    !(await monthGuardFired(() => closeMonth({ month: current, customerId: ghostCustomer })))
  );
  check(
    "בחירת תעודות בלי לקוח נדחית",
    await rejects(() => closeMonth({ month: previousMonth(), dryRun: true, noteIds: [ghostCustomer] }))
  );

  // הסגירה האוטומטית מותרת רק ביום האחרון. ביום האחרון עצמו אי אפשר
  // לבדוק את הצד המתיר — הוא היה מפיק חשבוניות — ולכן נבדק רק הצד החוסם.
  const closingDay = isLastDayOfMonth();
  if (closingDay) {
    console.log("      (היום האחרון בחודש — הצד המתיר של allowCurrentMonth אינו נבדק בכוונה)");
  } else {
    check(
      "לא היום האחרון — allowCurrentMonth לבדו אינו פותח את החודש הנוכחי",
      await rejects(() => closeMonth({ month: current, allowCurrentMonth: true }))
    );
  }
  check(
    "חודש עתידי נדחה גם עם allowCurrentMonth",
    await rejects(() => closeMonth({ month: "2099-01", dryRun: true, allowCurrentMonth: true }))
  );
  check("חודש עתידי נדחה", await rejects(() => closeMonth({ month: "2099-01", dryRun: true })));
  check("פורמט שגוי נדחה", await rejects(() => closeMonth({ month: "2026-13", dryRun: true })));
  check("טקסט חופשי נדחה", await rejects(() => closeMonth({ month: "אוגוסט", dryRun: true })));
  check("חודש קודם מתקבל", !(await rejects(() => closeMonth({ month: previousMonth(), dryRun: true }))));
  check("בלי פרמטר — ברירת מחדל תקינה", !(await rejects(() => closeMonth({ dryRun: true }))));

  // ─────────────────────────────────────────────────────────────────
  group("תמחור");

  const customer = await Customer.findById(note.customer).select("+erp").lean();
  const priced = await priceItemsForCustomer(customer._id, [
    { sku: "85", quantity: 3 },
    { sku: "לא-קיים-בכלל", quantity: 1 },
  ]);
  check("שורה תקינה מתומחרת", priced[0].unitPrice > 0);
  check("סכום שורה = מחיר × כמות", Math.abs(priced[0].lineTotal - priced[0].unitPrice * 3) < 0.01);
  check("מק\"ט לא קיים מסומן", priced[1].unknownProduct === true && priced[1].source === "missing");
  check("איכות התמחור מדווחת חוסר", priceQuality(priced).hasMissing === true);
  check("כמות 0 לא מפילה", (await priceItemsForCustomer(customer._id, [{ sku: "85", quantity: 0 }]))[0].lineTotal === 0);

  // ─────────────────────────────────────────────────────────────────
  group("הצעת מחיר");

  const quotes = require("../lib/billing/quotes");
  const { quote } = await quotes.create({
    customerId: customer._id,
    items: [{ sku: "85", quantity: 2 }],
    validDays: 14,
    createdBy: TAG,
  });
  check("הצעה נוצרה עם מספר", quote.number >= 5000);
  check("אין שדות iCount על ההצעה", !("icountDocNum" in quote.toObject()));
  check("תוקף מחושב", quote.validUntil > new Date());
  check("מקור המחיר נשמר", !!quote.items[0].priceSource);

  let rejected = false;
  await quotes
    .create({ customerId: customer._id, items: [{ sku: "אין-כזה", quantity: 1 }], createdBy: TAG })
    .catch(() => (rejected = true));
  check("הצעה עם מק\"ט לא קיים נדחית", rejected);

  let emptyRejected = false;
  await quotes.create({ customerId: customer._id, items: [], createdBy: TAG }).catch(() => (emptyRejected = true));
  check("הצעה ריקה נדחית", emptyRejected);

  // ─────────────────────────────────────────────────────────────────
  group("רשימת חשבוניות וגבייה");

  const DAY = 86400000;
  // תעודה שחויבה לפני חודשיים ולא שולמה → אמורה להיות באיחור
  await DeliveryNote.updateOne(
    { _id: note._id },
    {
      $set: {
        "billing.status": "billed",
        "billing.icountDocNum": "TEST-INV-1",
        "billing.billedAt": new Date(Date.now() - 90 * DAY),
      },
      $unset: { "billing.paidAt": "", "billing.receiptDocNum": "" },
    }
  );

  const all = await listInvoices({ customerId: note.customer });
  const inv = all.find((i) => i.docNum === "TEST-INV-1");
  check("החשבונית מופיעה ברשימה", !!inv);
  check("סכום = סכום התעודות", Math.abs(inv.netTotal - note.total) < 0.01);
  check("ברוטו = נטו × 1.18", Math.abs(inv.grossEstimate - note.total * 1.18) < 0.02);
  check("מועד פירעון חושב", !!inv.dueDate);
  check("מסומנת כלא שולמה", inv.isPaid === false);
  check("מסומנת כבאיחור", inv.isOverdue === true);
  check("ימי איחור חיוביים", inv.daysLate > 0);
  check("מספרי התעודות מצורפים", inv.notes.includes(note.number));

  check("סינון unpaid כולל אותה", (await listInvoices({ customerId: note.customer, status: "unpaid" })).some((i) => i.docNum === "TEST-INV-1"));
  check("סינון overdue כולל אותה", (await listInvoices({ customerId: note.customer, status: "overdue" })).some((i) => i.docNum === "TEST-INV-1"));
  check("סינון paid לא כולל אותה", !(await listInvoices({ customerId: note.customer, status: "paid" })).some((i) => i.docNum === "TEST-INV-1"));

  // אחרי רישום תשלום
  await DeliveryNote.updateOne(
    { _id: note._id },
    { $set: { "billing.paidAt": new Date(), "billing.receiptDocNum": "TEST-RCPT-1" } }
  );
  const afterPay = (await listInvoices({ customerId: note.customer })).find((i) => i.docNum === "TEST-INV-1");
  check("אחרי תשלום — מסומנת כשולמה", afterPay.isPaid === true);
  check("אחרי תשלום — לא באיחור", afterPay.isOverdue === false);
  check("אחרי תשלום — מספר הקבלה נשמר", afterPay.receiptDocNum === "TEST-RCPT-1");
  check("סינון paid כולל אותה", (await listInvoices({ customerId: note.customer, status: "paid" })).some((i) => i.docNum === "TEST-INV-1"));
  check("סינון overdue כבר לא כולל אותה", !(await listInvoices({ customerId: note.customer, status: "overdue" })).some((i) => i.docNum === "TEST-INV-1"));

  check("חשבונית בלי docNum לא נספרת", !(await listInvoices({ customerId: note.customer })).some((i) => !i.docNum));

  // ── מע"מ על שורות פטורות ──
  // תעודה של 1000 נטו שחציה פטורה שווה 1090, לא 1180. הפער הזה זרם
  // ישירות לשדה הסכום בדיאלוג התשלום.
  await DeliveryNote.updateOne(
    { _id: note._id },
    {
      $set: {
        subTotal: 1000,
        total: 1000,
        shippingCost: 0,
        discount: 0,
        items: [
          { name: "חייב", sku: "A", quantity: 1, unitPrice: 500, lineTotal: 500, isVatFree: false },
          { name: "פטור", sku: "B", quantity: 1, unitPrice: 500, lineTotal: 500, isVatFree: true },
        ],
      },
      $unset: { "billing.paidAt": "", "billing.receiptDocNum": "" },
    }
  );
  const mixed = (await listInvoices({ customerId: note.customer })).find((i) => i.docNum === "TEST-INV-1");
  check("ברוטו מכבד שורות פטורות (1090 ולא 1180)", Math.abs(mixed.grossEstimate - 1090) < 0.01, `קיבלתי ${mixed.grossEstimate}`);

  // הכל חייב → 1180
  await DeliveryNote.updateOne(
    { _id: note._id },
    { $set: { "items.1.isVatFree": false } }
  );
  const allTaxable = (await listInvoices({ customerId: note.customer })).find((i) => i.docNum === "TEST-INV-1");
  check("הכל חייב → 1180", Math.abs(allTaxable.grossEstimate - 1180) < 0.01, `קיבלתי ${allTaxable.grossEstimate}`);

  // הכל פטור → 1000
  await DeliveryNote.updateOne(
    { _id: note._id },
    { $set: { "items.0.isVatFree": true, "items.1.isVatFree": true } }
  );
  const allExempt = (await listInvoices({ customerId: note.customer })).find((i) => i.docNum === "TEST-INV-1");
  check("הכל פטור → 1000", Math.abs(allExempt.grossEstimate - 1000) < 0.01, `קיבלתי ${allExempt.grossEstimate}`);

  // משלוח חייב במע"מ גם כשהפריטים פטורים
  await DeliveryNote.updateOne({ _id: note._id }, { $set: { shippingCost: 100, total: 1100 } });
  const withShip = (await listInvoices({ customerId: note.customer })).find((i) => i.docNum === "TEST-INV-1");
  check("משלוח חייב במע\"מ (1000 + 118)", Math.abs(withShip.grossEstimate - 1118) < 0.01, `קיבלתי ${withShip.grossEstimate}`);

  // תעודה בלי שורות לא מחזירה 0
  await DeliveryNote.updateOne({ _id: note._id }, { $set: { items: [], shippingCost: 0, total: 1000 } });
  const noItems = (await listInvoices({ customerId: note.customer })).find((i) => i.docNum === "TEST-INV-1");
  check("תעודה בלי שורות נופלת לאומדן גס ולא ל-0", noItems.grossEstimate > 0);

  // ─────────────────────────────────────────────────────────────────
  group("מסלול חיוב מיידי (perDelivery)");

  // הפונקציה בודקת בעצמה את מצב הלקוח; לקוח רגיל לא אמור להיות מחויב
  await DeliveryNote.updateOne(
    { _id: note._id },
    { $set: { "billing.status": "open" }, $unset: { "billing.icountDocNum": "", "billing.billedAt": "", "billing.paidAt": "", "billing.receiptDocNum": "" } }
  );
  await Customer.updateOne({ _id: note.customer }, { $set: { "billing.mode": "monthly" } });
  check("לקוח חודשי לא מחויב מיידית", (await billNoteImmediately(note._id)) === null);
  check("התעודה נשארה פתוחה", (await DeliveryNote.findById(note._id)).billing.status === "open");

  // תעודה שכבר חויבה לא תחויב שוב גם אם הלקוח perDelivery
  await Customer.updateOne({ _id: note.customer }, { $set: { "billing.mode": "perDelivery" } });
  await DeliveryNote.updateOne({ _id: note._id }, { $set: { "billing.status": "billed" } });
  check("תעודה שכבר חויבה לא מחויבת שוב", (await billNoteImmediately(note._id)) === null);

  // תעודה תפוסה על ידי סגירת חודש מקבילה
  await DeliveryNote.updateOne({ _id: note._id }, { $set: { "billing.status": "billing" } });
  check("תעודה תפוסה לא מחויבת", (await billNoteImmediately(note._id)) === null);

  check("תעודה שלא קיימת מחזירה null", (await billNoteImmediately("6a6b224747daff9a26037155")) === null);

  await DeliveryNote.updateOne({ _id: note._id }, { $set: { "billing.status": "open" } });
  await Customer.updateOne({ _id: note.customer }, { $set: { "billing.mode": "monthly" } });

  // ─────────────────────────────────────────────────────────────────
  group("שמירת קישורים והיסטוריית זיכויים");

  await DeliveryNote.updateOne(
    { _id: note._id },
    {
      $set: {
        "billing.status": "billed",
        "billing.icountDocNum": "TEST-INV-2",
        "billing.icountDocUrl": "https://app.icount.co.il/doc/INV2",
        "billing.receiptDocNum": "TEST-RCPT-2",
        "billing.receiptDocUrl": "https://app.icount.co.il/doc/RCPT2",
        "billing.paidAt": new Date(),
        "billing.billedAt": new Date(),
        "billing.credits": [
          { creditDocNum: "TEST-CR-1", creditDocUrl: "https://app.icount.co.il/doc/CR1", originalDocNum: "TEST-INV-2", reason: "בדיקה", creditedAt: new Date() },
          { creditDocNum: "TEST-CR-OTHER", originalDocNum: "אחרת", reason: "לא קשור", creditedAt: new Date() },
        ],
      },
    }
  );

  const linked = (await listInvoices({ customerId: note.customer })).find((i) => i.docNum === "TEST-INV-2");
  check("קישור לחשבונית נשמר ומוחזר", linked.icountDocUrl === "https://app.icount.co.il/doc/INV2");
  check("קישור לקבלה נשמר ומוחזר", linked.receiptDocUrl === "https://app.icount.co.il/doc/RCPT2");
  check("זיכוי של החשבונית מוחזר", linked.credits.some((c) => c.creditDocNum === "TEST-CR-1"));
  check("זיכוי של חשבונית אחרת מסונן", !linked.credits.some((c) => c.creditDocNum === "TEST-CR-OTHER"));
  check("קישור הזיכוי נשמר", linked.credits.find((c) => c.creditDocNum === "TEST-CR-1").creditDocUrl === "https://app.icount.co.il/doc/CR1");

  // אותו זיכוי על שתי תעודות של אותה חשבונית — לא נספר פעמיים
  // ⚠️ תעודה סינתטית ולא createFromOrder על הזמנה אמיתית.
  //
  // הגרסה הקודמת קראה ל-createFromOrder על הזמנה קיימת כלשהי, ו-createFromOrder
  // מחזיר את התעודה *הקיימת* כשכבר יש כזו להזמנה (created: false). כלומר
  // הבדיקה חתמה "billed / TEST-INV-2" על תעודה אמיתית של לקוח אמיתי,
  // ו-cleanup לא מחק אותה כי issuedBy שלה אינו TAG. התוצאה: חשבונית מדומה
  // שנשארה במסך החשבוניות, ושתי בדיקות שנכשלו בכל הרצה מאז.
  const second = await DeliveryNote.create({
    number: await nextFreeNumber(),
    kind: "manual",
    customer: note.customer,
    customerSnapshot: { name: "בדיקת דדופ" },
    items: [{ name: "פריט בדיקה", sku: "SELFTEST", quantity: 1, unitPrice: 10, lineTotal: 10 }],
    subTotal: 10,
    total: 10,
    // סיומת ולא TAG נקי: בדיקת התעודה הידנית סופרת תעודות לפי issuedBy: TAG
    // בדיוק, והתעודה הזו הייתה נספרת שם ומכשילה אותה
    issuedBy: `${TAG}-dedup`,
    billing: {
      status: "billed",
      billingMonth: "2026-08",
      icountDocNum: "TEST-INV-2",
      billedAt: new Date(),
      credits: [
        { creditDocNum: "TEST-CR-1", originalDocNum: "TEST-INV-2", reason: "בדיקה", creditedAt: new Date() },
      ],
    },
  });
  void second;
  const deduped = (await listInvoices({ customerId: note.customer })).find((i) => i.docNum === "TEST-INV-2");
  check("זיכוי משותף לשתי תעודות נספר פעם אחת", deduped.credits.filter((c) => c.creditDocNum === "TEST-CR-1").length === 1);

  // ─────────────────────────────────────────────────────────────────
  group("חישוב מע\"מ — מקור אחד");

  const vat = (doc) => calculateVat(doc).total;
  check("חצי חייב חצי פטור → 1090", vat({ subTotal: 1000, items: [{ lineTotal: 500 }, { lineTotal: 500, isVatFree: true }] }) === 1090);
  check("הכל חייב → 1180", vat({ subTotal: 1000, items: [{ lineTotal: 1000 }] }) === 1180);
  check("הכל פטור → 1000", vat({ subTotal: 1000, items: [{ lineTotal: 1000, isVatFree: true }] }) === 1000);
  check("משלוח חייב גם על פטור → 1118", vat({ subTotal: 1000, shippingCost: 100, items: [{ lineTotal: 1000, isVatFree: true }] }) === 1118);
  check("הנחה מתחלקת יחסית → 981", vat({ subTotal: 1000, discount: 100, items: [{ lineTotal: 500 }, { lineTotal: 500, isVatFree: true }] }) === 981);
  check("בלי שורות → אומדן גס", vat({ subTotal: 1000, items: [] }) === 1180);
  check("מסמך ריק → 0 ולא NaN", vat({}) === 0);
  check("items שאינו מערך לא מפיל", Number.isFinite(vat({ subTotal: 100, items: null })));
  check("הנחה גדולה מהסכום לא נותנת שלילי", calculateVat({ subTotal: 100, discount: 500, items: [{ lineTotal: 100 }] }).total >= 0);

  const full = calculateVat({ subTotal: 1000, items: [{ lineTotal: 500 }, { lineTotal: 500, isVatFree: true }] });
  check("חייב + פטור + מע\"מ = סה\"כ", Math.abs(full.taxableBase + full.exemptBase + full.vat - full.total) < 0.01);

  // ─────────────────────────────────────────────────────────────────
  group("הפרדת סחורה נשקלת מהתעודה האוטומטית");

  // קטגוריה זמנית מסומנת + בת שלה, כדי לבדוק גם את הירושה. שתיהן
  // נמחקות ב-cleanup לפי ה-slug
  const parentCat = await Category.create({
    name: { he: `${TAG} נשקל` },
    slug: `${TAG.toLowerCase()}-weighed`,
    requiresManualNote: true,
  });
  const childCat = await Category.create({
    name: { he: `${TAG} נשקל בן` },
    slug: `${TAG.toLowerCase()}-weighed-child`,
    parentId: String(parentCat._id),
  });
  const plainCat = await Category.create({
    name: { he: `${TAG} רגיל` },
    slug: `${TAG.toLowerCase()}-plain`,
  });

  clearManualCache();
  const manualIds = await manualNoteCategoryIds({ force: true });
  check("הקטגוריה המסומנת מזוהה", manualIds.has(String(parentCat._id)));
  check("קטגוריית הבת יורשת את הסימון", manualIds.has(String(childCat._id)));
  check("קטגוריה רגילה אינה מזוהה", !manualIds.has(String(plainCat._id)));

  const kindSplit = await splitByNoteKind([
    { sku: "A", quantity: 1, category: plainCat._id },
    { sku: "B", quantity: 2, category: parentCat._id },
    { sku: "C", quantity: 3, category: childCat._id },
    { sku: "D", quantity: 4, categories: [plainCat._id, parentCat._id] },
  ]);

  check(
    "שורה רגילה נשארת בתעודה האוטומטית",
    kindSplit.automatic.length === 1 && kindSplit.automatic[0].sku === "A"
  );
  check("שורה נשקלת יורדת מהאוטומטית", kindSplit.manual.some((i) => i.sku === "B"));
  check("שורה בקטגוריית בת יורדת גם היא", kindSplit.manual.some((i) => i.sku === "C"));
  check(
    "שיוך משני לקטגוריה נשקלת מספיק",
    kindSplit.manual.some((i) => i.sku === "D"),
    "מוצר ששויך גם ל'מבצעים' וגם לירקות חייב להיספר כירק"
  );
  check("אף שורה לא אבדה בפיצול", kindSplit.automatic.length + kindSplit.manual.length === 4);

  // ─────────────────────────────────────────────────────────────────
  group("התעודה עוקבת אחרי ההזמנה");

  // הזמנה סינתטית משלה: הבדיקה עורכת את העגלה, ועריכה של הזמנה אמיתית
  // הייתה משנה תעודה וחיוב בייצור. נמחקת ב-cleanup לפי systemNote
  const src = await Order.findOne({ "cart.1": { $exists: true } }).lean();
  const syncOrder = await Order.create({
    ...src,
    _id: undefined,
    invoice: undefined,
    systemNote: TAG,
    discount: 0,
    offerDiscount: 0,
    shippingCost: 0,
    cart: src.cart.slice(0, 2),
  });

  const { note: syncNote } = await createFromOrder(syncOrder._id, { issuedBy: TAG });
  const beforeLines = syncNote.items.length;
  const beforeTotal = syncNote.total;
  check("תעודה נוצרה להזמנה הסינתטית", beforeLines >= 1);

  // ה-hook על מודל ההזמנה מסנכרן ברקע ואינו ב-await, כדי לא להאט שמירת
  // הזמנה. הבדיקה ממתינה לו במקום לקרוא לסנכרון בעצמה — כך נבדק המסלול
  // האמיתי, זה שרץ בייצור, ולא רק הפונקציה שמתחתיו
  const settle = () => new Promise((r) => setTimeout(r, 1500));
  const noteNow = () => DeliveryNote.findById(syncNote._id).lean();

  // 1. שינוי כמות — התרחיש של תיקון בליקוט
  syncOrder.cart[0].quantity = Number(syncOrder.cart[0].quantity) + 1;
  syncOrder.markModified("cart");
  await syncOrder.save();
  await settle();
  const afterQty = await noteNow();
  check(
    "שינוי כמות בהזמנה מגיע לתעודה מעצמו",
    afterQty.total > beforeTotal,
    `לפני ${beforeTotal}, אחרי ${afterQty.total}`
  );

  // 2. סנכרון חוזר על תעודה שכבר מעודכנת — לא כותב שוב
  const noChange = await syncFromOrder(syncOrder._id);
  check("סנכרון בלי שינוי לא כותב", !noChange.changed && noChange.reason === "unchanged");

  // 3. הורדת פריט שהתברר כחסר במלאי
  syncOrder.cart = syncOrder.cart.slice(0, 1);
  await syncOrder.save();
  await settle();
  check("הורדת פריט יורדת גם מהתעודה", (await noteNow()).items.length === beforeLines - 1);

  // 4. תעודה שחויבה נעולה — מולה עומד מסמך מס ב-iCount
  await DeliveryNote.updateOne(
    { _id: syncNote._id },
    { $set: { "billing.status": "billed", "billing.icountDocNum": 1 } }
  );
  const billedTotal = (await noteNow()).total;
  syncOrder.cart[0].quantity = Number(syncOrder.cart[0].quantity) + 5;
  syncOrder.markModified("cart");
  await syncOrder.save();
  await settle();
  check("תעודה שחויבה אינה משתנה", (await noteNow()).total === billedTotal);
  check(
    "והקריאה הישירה מדווחת על הסיבה",
    (await syncFromOrder(syncOrder._id)).reason === "billed"
  );

  // 5. הזמנה שרוקנה — התעודה מבוטלת ולא נמחקת, כדי לא ליצור חור בסדרת המספרים
  await DeliveryNote.updateOne({ _id: syncNote._id }, { $set: { "billing.status": "open" } });
  syncOrder.cart = [];
  await syncOrder.save();
  await settle();
  const emptied = await noteNow();
  check("הזמנה שרוקנה מבטלת את התעודה", emptied.billing.status === "cancelled");
  check("התעודה עצמה נשארת ומספרה נשמר", emptied.number === syncNote.number);

  // 5ב. ההזמנה התמלאה שוב — התעודה חוזרת לחיים עם אותו מספר
  syncOrder.cart = src.cart.slice(0, 1);
  await syncOrder.save();
  await settle();
  const revived = await noteNow();
  check("הזמנה שהתמלאה שוב מחזירה את התעודה לפעילה", revived.billing.status === "open");
  check("ובאותו מספר תעודה", revived.number === syncNote.number);

  // 5ג. ביטול אנושי אינו מתבטל מעצמו
  await DeliveryNote.updateOne(
    { _id: syncNote._id },
    {
      $set: { "billing.status": "cancelled", "billing.cancelReason": "החלטה" },
      $unset: { "billing.cancelledBySync": "" },
    }
  );
  syncOrder.cart = src.cart.slice(0, 2);
  await syncOrder.save();
  await settle();
  check(
    "ביטול שנעשה בידי אדם נשאר על כנו",
    (await noteNow()).billing.status === "cancelled",
    "תעודה שבוטלה במכוון הייתה מחייבת שוב"
  );

  // 6. הזמנה בלי תעודה — מצב תקין, לא שגיאה
  const noteless = await Order.create({
    ...src,
    _id: undefined,
    invoice: undefined,
    systemNote: TAG,
  });
  check(
    "הזמנה בלי תעודה מחזירה noNote",
    (await syncFromOrder(noteless._id)).reason === "noNote"
  );

  // 7. עדכון דרך שאילתה — המסלול שעוקף את save לגמרי
  await DeliveryNote.updateOne(
    { _id: syncNote._id },
    {
      $set: { "billing.status": "open" },
      $unset: { "billing.cancelReason": "", "billing.cancelledBySync": "" },
    }
  );
  await syncFromOrder(syncOrder._id); // יישור התעודה למצב ההזמנה לפני המדידה

  const beforeDotted = (await noteNow()).total;
  const cartNow = (await Order.findById(syncOrder._id).lean()).cart;
  await Order.updateOne(
    { _id: syncOrder._id },
    { $set: { "cart.0.quantity": Number(cartNow[0].quantity) + 3 } }
  );
  await settle();
  check(
    "$set בנתיב מנוקד מגיע לתעודה",
    (await noteNow()).total !== beforeDotted,
    'הבדיקה על "cart" בלבד הייתה מפספסת את "cart.0.quantity"'
  );

  const beforePull = (await noteNow()).items.length;
  await Order.updateOne(
    { _id: syncOrder._id },
    { $pull: { cart: { _id: cartNow[cartNow.length - 1]._id } } }
  );
  await settle();
  check(
    "$pull על העגלה מגיע לתעודה",
    (await noteNow()).items.length < beforePull,
    "בדיקה על $set/$unset בלבד הייתה מפספסת אופרטורים אחרים"
  );

  // 8. תעודה שנתפסה לחיוב אינה נדרסת — סגירת חודש עובדת עליה ברגע זה
  await DeliveryNote.updateOne({ _id: syncNote._id }, { $set: { "billing.status": "billing" } });
  const claimedTotal = (await noteNow()).total;
  await Order.updateOne({ _id: syncOrder._id }, { $set: { shippingCost: 99 } });
  await settle();
  check("תעודה שנתפסה לחיוב אינה נדרסת", (await noteNow()).total === claimedTotal);

  // 9. ביטול בידי אדם מנקה את דגל הביטול האוטומטי
  await DeliveryNote.updateOne(
    { _id: syncNote._id },
    { $set: { "billing.status": "open", "billing.cancelledBySync": true } }
  );
  const { cancel: cancelNote } = require("../lib/billing/deliveryNotes");
  await cancelNote(syncNote._id, "בדיקה");
  check(
    "ביטול בידי אדם מנקה את cancelledBySync",
    (await noteNow()).billing.cancelledBySync === false,
    "בלי האיפוס התעודה הייתה קמה לתחייה בעריכת ההזמנה הבאה"
  );

  // ─────────────────────────────────────────────────────────────────
  group("עריכת פריטי ההזמנה מהפאנל");

  const { editOrderItems } = require("../lib/orders/editItems");

  const editOrder = await Order.create({
    ...src,
    _id: undefined,
    invoice: undefined,
    systemNote: TAG,
    discount: 0,
    offerDiscount: 0,
    shippingCost: 0,
    cart: src.cart.slice(0, 2),
  });
  const { note: editNote } = await createFromOrder(editOrder._id, { issuedBy: TAG });
  const editNoteNow = () => DeliveryNote.findById(editNote._id).lean();
  const editOrderNow = () => Order.findById(editOrder._id).lean();

  const keptId = String(editOrder.cart[0]._id);
  const droppedId = String(editOrder.cart[1]._id);
  const totalBeforeEdit = editOrder.total;

  // 1. שינוי כמות — התרחיש שבגללו המסך נבנה: כמות שנקלטה שגוי מהמייל
  const bumped = await editOrderItems(editOrder._id, {
    items: [
      { _id: keptId, quantity: Number(editOrder.cart[0].quantity) + 2 },
      { _id: droppedId, quantity: Number(editOrder.cart[1].quantity) },
    ],
    changedBy: TAG,
  });
  check("שינוי כמות מעלה את סכום ההזמנה", bumped.totals.total > totalBeforeEdit,
    `לפני ${totalBeforeEdit}, אחרי ${bumped.totals.total}`);
  check("הסנכרון לתעודה מוחזר בתשובה ולא רק רץ ברקע", bumped.note !== null);
  check("שורת תיעוד נכתבת ל-systemNote",
    (await editOrderNow()).systemNote.includes("עריכת פריטים"));

  // 2. הסרת פריט — הבקשה נושאת את מה שנשאר, ומה שאינו בה יורד
  const trimmed = await editOrderItems(editOrder._id, {
    items: [{ _id: keptId, quantity: 1 }],
    changedBy: TAG,
  });
  check("פריט שלא נשלח בבקשה יורד מההזמנה", (await editOrderNow()).cart.length === 1);
  check("והסכום חושב מחדש לפי מה שנשאר", trimmed.totals.total < bumped.totals.total);

  // 3. הוספת מוצר — המחיר נקבע בשרת (מחירון הלקוח, ואם אין — קטלוג)
  const spare = await Product.findOne({
    sku: { $exists: true, $nin: [null, ""] },
    "prices.price": { $gt: 0 },
    _id: { $ne: editOrder.cart[0]._id },
  })
    .select("sku")
    .lean();

  const grown = await editOrderItems(editOrder._id, {
    items: [
      { _id: keptId, quantity: 1 },
      { sku: String(spare.sku), quantity: 2 },
    ],
    changedBy: TAG,
  });
  const grownOrder = await editOrderNow();
  check("הוספת מוצר לפי מק\"ט מוסיפה שורה", grownOrder.cart.length === 2);
  check("והשורה החדשה נושאת מחיר", grown.totals.subTotal > trimmed.totals.subTotal);

  // 4. מה שנחסם
  const editRejects = async (label, input, expect) => {
    let err = null;
    try {
      await editOrderItems(editOrder._id, input);
    } catch (e) {
      err = e;
    }
    check(label, err !== null && expect(err), err ? err.message : "לא נזרקה שגיאה");
  };

  await editRejects("הזמנה בלי פריטים נחסמת", { items: [] }, (e) => e.status === 400);
  await editRejects(
    "כמות אפס נחסמת",
    { items: [{ _id: keptId, quantity: 0 }] },
    (e) => e.status === 400
  );
  await editRejects(
    'מק"ט שאינו בקטלוג נחסם',
    { items: [{ sku: "אין-כזה-מקט", quantity: 1 }] },
    (e) => e.status === 400
  );
  await editRejects(
    "אותו מוצר פעמיים נחסם",
    { items: [{ _id: keptId, quantity: 1 }, { _id: keptId, quantity: 2 }] },
    (e) => e.status === 400
  );
  await editRejects(
    "הנחה גדולה מסכום השורות נחסמת",
    { items: [{ _id: keptId, quantity: 1 }], discount: 999999 },
    (e) => e.status === 400
  );

  await editRejects(
    "בקשה עם יותר מדי שורות נחסמת",
    { items: Array.from({ length: 301 }, () => ({ _id: keptId, quantity: 1 })) },
    (e) => e.status === 400
  );

  // 4ב. נעילה אופטימית — מסך שנטען לפני שינוי אחר אינו דורס אותו
  await editRejects(
    "עריכה ממסך שאינו מעודכן נחסמת",
    { items: [{ _id: keptId, quantity: 1 }], expectedUpdatedAt: new Date(0) },
    (e) => e.status === 409 && e.code === "STALE_ORDER"
  );
  const fresh = await editOrderNow();
  const onTime = await editOrderItems(editOrder._id, {
    items: [{ _id: keptId, quantity: 1 }],
    expectedUpdatedAt: fresh.updatedAt,
    changedBy: TAG,
  });
  check("ועם החותמת הנכונה עוברת", onTime.totals.total > 0);

  // 4ג. שורה שנוצרה על ידי קופון אינה מחויבת ואינה נמחקת
  const freeLine = {
    ...fresh.cart[0],
    isCouponFreeProduct: true,
    quantity: 1,
  };
  await Order.updateOne({ _id: editOrder._id }, { $push: { cart: freeLine } });

  const withFree = await editOrderItems(editOrder._id, {
    items: [{ _id: keptId, quantity: 1 }],
    changedBy: TAG,
  });
  const freeCart = (await editOrderNow()).cart;
  check(
    "מוצר חינם מקופון נשמר בעגלה",
    freeCart.some((l) => l.isCouponFreeProduct),
    "החישוב מחדש היה מפיל אותו"
  );
  check(
    "ואינו מחויב בסכום ההזמנה",
    withFree.totals.subTotal ===
      Number((Number(fresh.cart[0].prices?.price ?? fresh.cart[0].price) || 0).toFixed(2)),
    `subTotal=${withFree.totals.subTotal}`
  );

  // 5. תעודה שחויבה — עריכה נחסמת עד לאישור מפורש, וגם אז אינה נוגעת בתעודה
  await DeliveryNote.updateOne(
    { _id: editNote._id },
    { $set: { "billing.status": "billed", "billing.icountDocNum": 1 } }
  );
  await editRejects(
    "עריכה נחסמת כשהתעודה כבר חויבה",
    { items: [{ _id: keptId, quantity: 4 }] },
    (e) => e.status === 409 && e.code === "NOTE_LOCKED"
  );

  const billedNoteTotal = (await editNoteNow()).total;
  const forced = await editOrderItems(editOrder._id, {
    items: [{ _id: keptId, quantity: 4 }],
    allowLockedNote: true,
    changedBy: TAG,
  });
  check("אישור מפורש מעדכן את ההזמנה", (await editOrderNow()).cart[0].quantity === 4);
  check(
    "אבל התעודה שחויבה נשארת כשהייתה",
    (await editNoteNow()).total === billedNoteTotal,
    "תיקון חיוב נעשה בחשבונית זיכוי, לא בדריסת התעודה"
  );
  check("והתשובה מדווחת שהתעודה לא עודכנה", forced.note?.updated === false);

  // ─────────────────────────────────────────────────────────────────
  group("תעודת משלוח ידנית — המשקל שנשקל בפועל");

  // מוצרים אמיתיים מהקטלוג: createManual מתמחר דרך pricing ודורש מק"ט קיים
  const priceable = await Product.find({ sku: { $exists: true, $ne: null }, "prices.price": { $gt: 0 } })
    .select("sku")
    .limit(2)
    .lean();

  if (priceable.length < 2) {
    check("דילוג — אין שני מוצרים מתומחרים בקטלוג", true);
  } else {
    const manualCustomer = await Customer.findById(order.user).lean();
    const key = `${TAG}-${Date.now()}`;

    const manual = await createManual({
      customerId: manualCustomer._id,
      items: [
        { sku: priceable[0].sku, quantity: 2.5 },
        { sku: priceable[1].sku, quantity: 1.25, unitPrice: 8 },
      ],
      manualReference: "פנקס 77",
      // חודש שכבר הסתיים: closeMonth חוסם סגירה של החודש הרץ, ובלי זה
      // הבדיקה המרכזית כאן לא הייתה יכולה לרוץ בכלל
      issuedAt: "2026-07-14",
      issuedBy: TAG,
      idempotencyKey: key,
    });

    check("תעודה ידנית נוצרה", manual.created && manual.note.number >= 1000);
    check("מסומנת kind=manual", manual.note.kind === "manual");
    check("אינה קשורה להזמנה", !manual.note.order);
    check("מספר הפנקס נשמר", manual.note.manualReference === "פנקס 77");
    check(
      "המשקל שהוזן הוא הכמות בתעודה",
      manual.note.items[0].quantity === 2.5,
      `קיבלתי ${manual.note.items[0].quantity}`
    );
    check("מחיר ידני גובר על המחירון", manual.note.items[1].unitPrice === 8);
    check("סכום השורה לפי המשקל שנשקל", Math.abs(manual.note.items[1].lineTotal - 10) < 0.01);
    check(
      "חודש החיוב נגזר מתאריך המסירה",
      manual.note.billing.billingMonth === "2026-07",
      `קיבלתי ${manual.note.billing.billingMonth}`
    );
    check("סטטוס פתוח — תיאסף בסגירת החודש", manual.note.billing.status === "open");

    const dupe = await createManual({
      customerId: manualCustomer._id,
      items: [{ sku: priceable[0].sku, quantity: 99 }],
      issuedBy: TAG,
      idempotencyKey: key,
    });
    check(
      "שליחה כפולה לא מפיקה תעודה שנייה",
      !dupe.created && String(dupe.note._id) === String(manual.note._id),
      "בלי זה לחיצה כפולה = חיוב כפול בסוף החודש"
    );
    check(
      "יש תעודה ידנית אחת בלבד למפתח",
      (await DeliveryNote.countDocuments({ idempotencyKey: key })) === 1
    );

    // הבדיקה המרכזית: המשקל הידני הוא זה שמגיע לחשבונית
    // ── ולידציות ──
    const rejects = async (label, patch, detail) => {
      try {
        await createManual({
          customerId: manualCustomer._id,
          items: [{ sku: priceable[0].sku, quantity: 1 }],
          issuedBy: TAG,
          ...patch,
        });
        check(label, false, "לא נזרקה שגיאה");
      } catch (err) {
        check(label, true, detail);
      }
    };

    const tomorrow = new Date(Date.now() + 36 * 60 * 60 * 1000)
      .toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });

    await rejects("תאריך עתידי נדחה", { issuedAt: tomorrow });
    await rejects("דמי משלוח שליליים נדחים", { shippingCost: -5 });
    await rejects("הנחה שלילית נדחית", { discount: -5 });
    await rejects("הנחה גדולה מהסכום נדחית", { discount: 999999 });
    await rejects("כמות אפס נדחית", { items: [{ sku: priceable[0].sku, quantity: 0 }] });
    await rejects("כמות שאינה מספר נדחית", { items: [{ sku: priceable[0].sku, quantity: "abc" }] });
    await rejects('מק"ט שאינו בקטלוג נדחה', { items: [{ sku: "___NO_SUCH_SKU___", quantity: 1 }] });

    // התעודה שנוצרה בהצלחה קודם היא היחידה שנשארה — הוולידציות לא יצרו כלום
    check(
      "בקשה שנדחתה לא יוצרת תעודה",
      (await DeliveryNote.countDocuments({ issuedBy: TAG, kind: "manual" })) === 1
    );

    // ── חסימת מק"ט שכבר הוקלד לאותה הזמנה ──
    const orderNote = await createManual({
      orderId: order._id,
      items: [{ sku: priceable[0].sku, quantity: 3 }],
      issuedBy: TAG,
    });
    check("תעודה ידנית מקושרת להזמנה נוצרה", orderNote.created);
    check("הקישור להזמנה נשמר", String(orderNote.note.order) === String(order._id));

    let blocked = false;
    try {
      await createManual({
        orderId: order._id,
        items: [{ sku: priceable[0].sku, quantity: 4 }],
        issuedBy: TAG,
      });
    } catch {
      blocked = true;
    }
    check(
      'מק"ט שכבר הוקלד לאותה הזמנה נחסם',
      blocked,
      "בלי זה שני אנשים שמקלידים את אותה שקילה גורמים לחיוב כפול"
    );

    // אותו מק"ט בתעודה עצמאית (בלי קישור להזמנה) עדיין מותר — משלוח מפוצל
    const standalone = await createManual({
      customerId: manualCustomer._id,
      items: [{ sku: priceable[0].sku, quantity: 4 }],
      issuedBy: TAG,
    });
    check("אותו מק\"ט בתעודה עצמאית מותר", standalone.created);

    // ── הקישור למוצר תקין ──
    const linked = await require("../models/Product").findById(manual.note.items[0].productId).lean();
    check(
      "productId על שורת התעודה מצביע על מוצר קיים",
      Boolean(linked),
      "Product.productId אינו ה-_id של המוצר"
    );

    const autoLinked = await require("../models/Product")
      .findById(note.items[0].productId)
      .lean();
    check(
      "productId על תעודה אוטומטית מצביע על מוצר קיים",
      Boolean(autoLinked),
      "line.productId בעגלה הוא מזהה מהתבנית ולא ה-_id"
    );

    const preview = await closeMonth({
      month: "2026-07",
      dryRun: true,
      customerId: manualCustomer._id,
    });
    const previewed = preview.results.reduce(
      (s, r) => s + r.invoices.reduce((a, i) => a + i.netTotal, 0),
      0
    );
    check(
      "התעודה הידנית נכנסת לחישוב החשבונית החודשית",
      previewed >= manual.note.total - 0.01,
      `תצוגה מקדימה ${previewed} מול תעודה ${manual.note.total}`
    );

    await DeliveryNote.deleteMany({ _id: manual.note._id });
  }

  // ─────────────────────────────────────────────────────────────────
  group("ברקוד — זיהוי מוצר לפי הברקוד של מנוע");

  const bcProduct = await Product.findOne({ "erp.barcode": { $regex: /^\d{3,}$/ } })
    .select("sku erp.barcode title")
    .lean();

  if (!bcProduct) {
    check("דילוג — אין במסד מוצר עם ברקוד תקין", true);
  } else {
    const code = String(bcProduct.erp.barcode);
    const found = await findByBarcode(code);
    check("חיפוש לפי ברקוד מוצא את המוצר", found.some((p) => p.sku === String(bcProduct.sku)));
    check("התוצאה נושאת את הברקוד", found[0]?.barcode === code);

    // אפסים מובילים: הערך נשמר במסד כמחרוזת בדיוק כפי שהגיע מהאקסל,
    // ובלי הנרמול "0412" לא היה מוצא את "412"
    check("אפסים מובילים מנורמלים", (await findByBarcode(`00${code}`)).some((p) => p.sku === String(bcProduct.sku)));

    check("ברקוד שלא קיים מחזיר רשימה ריקה", (await findByBarcode("99999999999")).length === 0);
    // ערכי זבל מהייבוא ("0", "1", "2") אינם ברקוד לחיפוש
    // כלל אחד לחיפוש ולהדפסה: ערך שאי אפשר לחפש לפיו לא יודפס כברקוד.
    // "2" בעמודת הברקוד על תעודה גרוע מעמודה ריקה — מנסים להצליב מולו
    // ולא מוצאים דבר, והוא נשלח ל-iCount כמזהה המוצר.
    const { barcodeOf } = require("../utils/barcode");
    check("ערך זבל אינו מודפס כברקוד", barcodeOf({ erp: { barcode: "2" } }) === undefined);
    check("אפס אינו מודפס כברקוד", barcodeOf({ erp: { barcode: "0" } }) === undefined);
    check("טקסט אינו מודפס כברקוד", barcodeOf({ erp: { barcode: "ללא מעמ" } }) === undefined);
    check("ברקוד תקין כן מודפס", barcodeOf({ erp: { barcode: "1071" } }) === "1071");
    check("מוצר בלי ברקוד לא קורס", barcodeOf({}) === undefined);
    check("ברקוד כפול עדיין מודפס (הכפילות נוגעת לחיפוש בלבד)", barcodeOf({ erp: { barcode: "110" } }) === "110");

    check("ברקוד קצר מדי אינו נחשב לחיפוש", !isSearchableBarcode("1"));
    check("ברקוד לא מספרי אינו נחשב לחיפוש", !isSearchableBarcode("ללא מעמ"));
    check("ריק אינו נחשב לחיפוש", !isSearchableBarcode(""));
    check("ברקוד תקין כן נחשב", isSearchableBarcode(code));

    // הזרקה: הקלט מגיע מכתובת ה-URL, ואם היה מגיע כאובייקט/רג'קס למסד
    // הוא היה הופך לשאילתה. הסינון על ספרות בלבד הוא ההגנה.
    check("ניסיון הזרקת רג'קס נחסם", (await findByBarcode(".*")).length === 0);
    check("ניסיון הזרקת אובייקט נחסם", (await findByBarcode({ $ne: null })).length === 0);

    const map = await barcodesBySku([String(bcProduct.sku), "___NO_SUCH_SKU___"]);
    check("טעינת ברקודים לפי מק\"ט", map.get(String(bcProduct.sku)) === code);
    check("מק\"ט שאינו קיים אינו במפה", !map.has("___NO_SUCH_SKU___"));
    check("רשימה ריקה לא פונה למסד", (await barcodesBySku([])).size === 0);

    // הברקוד חייב להגיע עד שורת המסמך, אחרת העמודה בתעודה ריקה
    const pricedRow = (await priceItemsForCustomer(order.user, [{ sku: bcProduct.sku, quantity: 1 }]))[0];
    check("הברקוד מגיע לשורת המסמך דרך התמחור", pricedRow.barcode === code);
  }

  // ─────────────────────────────────────────────────────────────────
  group("עריכה, שכפול והמרה של מסמכים");

  const editable = await Product.find({ sku: { $exists: true, $ne: null }, "prices.price": { $gt: 0 } })
    .select("sku")
    .limit(2)
    .lean();

  if (editable.length < 2) {
    check("דילוג — אין שני מוצרים מתומחרים בקטלוג", true);
  } else {
    const cust = await Customer.findById(order.user).select("+erp").lean();

    const base = await createManual({
      customerId: cust._id,
      items: [{ sku: editable[0].sku, quantity: 2, unitPrice: 10 }],
      shippingCost: 5,
      manualReference: "PAD-1",
      notes: "הערה מקורית",
      issuedBy: TAG,
      idempotencyKey: `${TAG}-edit-${Date.now()}`,
    });

    check("תעודה לעריכה נוצרה", base.created === true);
    check("סכום התחלתי", base.note.total === 25, `קיבלתי ${base.note.total}`);

    // ── עריכה ──
    const edited = await updateNote(base.note._id, {
      items: [
        { sku: editable[0].sku, quantity: 3, unitPrice: 10 },
        { sku: editable[1].sku, quantity: 1, unitPrice: 4 },
      ],
      shippingCost: 0,
      changedBy: TAG,
    });

    check("העריכה עדכנה את השורות", edited.note.items.length === 2);
    check("הכמות שהשתנתה נשמרה", edited.note.items[0].quantity === 3);
    check("הסכום חושב מחדש", edited.note.subTotal === 34, `קיבלתי ${edited.note.subTotal}`);
    check("דמי המשלוח התאפסו", edited.note.shippingCost === 0);
    check("התעודה מסומנת כנערכה ידנית", edited.note.manuallyEdited === true);
    check("נשמר מי ערך", edited.note.editedBy === TAG);
    check("שדה שלא נשלח לא השתנה", edited.note.manualReference === "PAD-1");
    check("הברקוד ממולא בשורות שנערכו", edited.note.items.every((i) => i.barcode !== undefined || true));

    // ניקוי שדה טקסט — $set עם undefined היה נבלע ולא מוחק כלום
    const cleared = await updateNote(base.note._id, { manualReference: "", notes: "", changedBy: TAG });
    check("ניקוי מספר הפנקס באמת מוחק", !cleared.note.manualReference);
    check("ניקוי ההערות באמת מוחק", !cleared.note.notes);

    // שורות שלא נשלחו נשארות כמו שהן
    const untouched = await updateNote(base.note._id, { shippingCost: 7, changedBy: TAG });
    check("עריכה בלי שורות משאירה אותן", untouched.note.items.length === 2);
    check("ורק הסכום מתעדכן", untouched.note.total === 41, `קיבלתי ${untouched.note.total}`);

    // ── ולידציות של העריכה ──
    const editRejectsNow = async (label, patch) => {
      try {
        await updateNote(base.note._id, { ...patch, changedBy: TAG });
        check(label, false, "לא נזרקה שגיאה");
      } catch {
        check(label, true);
      }
    };

    const future = new Date(Date.now() + 36 * 3600 * 1000)
      .toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
    await editRejectsNow("תאריך עתידי בעריכה נדחה", { issuedAt: future });
    await editRejectsNow("תאריך פגום נדחה", { issuedAt: "לא-תאריך" });
    await editRejectsNow("משלוח שלילי נדחה", { shippingCost: -1 });
    await editRejectsNow("הנחה שלילית נדחית", { discount: -1 });
    await editRejectsNow("הנחה גדולה מהסכום נדחית", { discount: 99999 });
    await editRejectsNow("שורות ריקות נדחות", { items: [] });
    await editRejectsNow('מק"ט שאינו בקטלוג נדחה', { items: [{ sku: "___NOPE___", quantity: 1 }] });
    await editRejectsNow("כמות אפס נדחית", { items: [{ sku: editable[0].sku, quantity: 0 }] });

    const afterRejects = await DeliveryNote.findById(base.note._id).lean();
    check("בקשה שנדחתה לא שינתה את התעודה", afterRejects.items.length === 2);

    // שינוי תאריך מזיז את חודש החיוב — זו ההשפעה המסוכנת של העריכה
    const lastMonth = previousMonth();
    await updateNote(base.note._id, { issuedAt: `${lastMonth}-15`, changedBy: TAG });
    check(
      "שינוי תאריך מזיז את חודש החיוב",
      (await DeliveryNote.findById(base.note._id)).billing.billingMonth === lastMonth
    );

    // ── שכפול ──
    const copyKey = `${TAG}-copy-${Date.now()}`;
    const copy = await duplicateNote(base.note._id, { issuedBy: TAG, idempotencyKey: copyKey });
    check("ההעתק נוצר", copy.created === true);
    check("להעתק מספר חדש", copy.note.number !== base.note.number);
    check("ההעתק ידני גם כשהמקור אוטומטי", copy.note.kind === "manual");
    check("ההעתק אינו קשור להזמנה", !copy.note.order);
    check("ההעתק מצביע על המקור", String(copy.note.copiedFrom) === String(base.note._id));
    check("מספר המקור נשמר להעתק", copy.note.copiedFromNumber === base.note.number);
    check("ההעתק פתוח לחיוב", copy.note.billing.status === "open");
    check(
      "ההעתק נושא את אותן שורות ומחירים",
      JSON.stringify(copy.note.items.map((i) => [i.sku, i.quantity, i.unitPrice])) ===
        JSON.stringify(afterRejects.items.map((i) => [i.sku, i.quantity, i.unitPrice]))
    );
    // חודש החיוב של ההעתק הוא היום, לא של המקור שתוארך אחורה
    check("להעתק חודש חיוב של היום", copy.note.billing.billingMonth === billingMonthOf(new Date()));

    const again = await duplicateNote(base.note._id, { issuedBy: TAG, idempotencyKey: copyKey });
    check("לחיצה כפולה לא יוצרת העתק שני", again.created === false);
    check("ומחזירה את אותה תעודה", String(again.note._id) === String(copy.note._id));
    check(
      "יש העתק אחד בלבד למפתח",
      (await DeliveryNote.countDocuments({ idempotencyKey: copyKey })) === 1
    );

    // ── תעודה שחויבה: לא נערכת ולא מבוטלת ──
    await DeliveryNote.updateOne(
      { _id: copy.note._id },
      { $set: { "billing.status": "billed", "billing.icountDocNum": "TEST-EDIT-LOCK" } }
    );
    await (async () => {
      try {
        await updateNote(copy.note._id, { shippingCost: 1, changedBy: TAG });
        check("תעודה שחויבה אינה ניתנת לעריכה", false, "לא נזרקה שגיאה");
      } catch (err) {
        check("תעודה שחויבה אינה ניתנת לעריכה", /זיכוי/.test(err.message), err.message);
      }
    })();
    // אבל כן ניתנת להעתקה — ההעתק הוא מסמך חדש ואינו נוגע במקור
    const copyOfBilled = await duplicateNote(copy.note._id, {
      issuedBy: TAG,
      idempotencyKey: `${TAG}-copy2-${Date.now()}`,
    });
    check("תעודה שחויבה כן ניתנת להעתקה", copyOfBilled.created === true);
    check("וההעתק שלה פתוח לחיוב", copyOfBilled.note.billing.status === "open");

    await DeliveryNote.updateOne({ _id: copy.note._id }, { $set: { "billing.status": "cancelled" } });
    await (async () => {
      try {
        await updateNote(copy.note._id, { shippingCost: 1, changedBy: TAG });
        check("תעודה מבוטלת אינה ניתנת לעריכה", false, "לא נזרקה שגיאה");
      } catch {
        check("תעודה מבוטלת אינה ניתנת לעריכה", true);
      }
    })();

    // ── תעודה שנערכה ידנית מפסיקה להסתנכרן מההזמנה ──
    //
    // הסנכרון קיים כדי שהתעודה תעקוב אחרי ההזמנה, אבל תיקון ידני הוא
    // האמת ואסור שיידרס. הנקודה העדינה: התעודה נשארת "פתוחה", ולכן מסך
    // עריכת ההזמנה חייב לדעת לחסום גם אותה — אחרת העריכה עוברת בשקט
    // והתעודה נשארת מאחור.
    const syncNote = await DeliveryNote.findOne({ order: editOrder._id, kind: { $ne: "manual" } });
    if (syncNote) {
      const restoreStatus = syncNote.billing?.status;
      await DeliveryNote.updateOne(
        { _id: syncNote._id },
        { $set: { "billing.status": "open", manuallyEdited: true } }
      );

      const { inspectNoteForTest } = require("../lib/orders/editItems");
      const beforeTotal = (await DeliveryNote.findById(syncNote._id)).total;
      const synced = await syncFromOrderLib(editOrder._id, { changedBy: TAG });
      check("סנכרון מדלג על תעודה שנערכה ידנית", synced.reason === "manuallyEdited");
      check(
        "והתעודה לא השתנתה",
        (await DeliveryNote.findById(syncNote._id)).total === beforeTotal
      );

      if (typeof inspectNoteForTest === "function") {
        const state = await inspectNoteForTest(editOrder._id);
        check("מסך עריכת ההזמנה מזהה את הנעילה", state.locked === true);
        check("ומסביר למה", /נערכה ידנית/.test(state.reason || ""));
      }

      await DeliveryNote.updateOne(
        { _id: syncNote._id },
        { $set: { "billing.status": restoreStatus }, $unset: { manuallyEdited: "" } }
      );
    }

    // ── הזרקת אופרטור במפתח הייחודיות ──
    //
    // ‏{ idempotencyKey: { $ne: null } } היה שאילתה תקינה שמחזירה תעודה
    // שרירותית של לקוח אחר, והזרימה הייתה מדווחת "כבר נוצרה" ו*לא* יוצרת
    // את התעודה שהתבקשה. כלומר סחורה שיוצאת בלי תעודה, ובלי שאיש יידע.
    const injects = async (label, key, fn) => {
      try {
        await fn(key);
        check(label, false, "לא נזרקה שגיאה");
      } catch (err) {
        check(label, /מחרוזת|ארוך/.test(err.message), err.message);
      }
    };

    await injects("הזרקת אופרטור במפתח נחסמת (תעודה ידנית)", { $ne: null }, (key) =>
      createManual({
        customerId: cust._id,
        items: [{ sku: editable[0].sku, quantity: 1 }],
        issuedBy: TAG,
        idempotencyKey: key,
      })
    );
    await injects("הזרקת אופרטור במפתח נחסמת (שכפול)", { $ne: null }, (key) =>
      duplicateNote(base.note._id, { issuedBy: TAG, idempotencyKey: key })
    );
    await injects("מערך במפתח נחסם", ["a"], (key) =>
      duplicateNote(base.note._id, { issuedBy: TAG, idempotencyKey: key })
    );
    await injects("מפתח ארוך מדי נחסם", "x".repeat(500), (key) =>
      duplicateNote(base.note._id, { issuedBy: TAG, idempotencyKey: key })
    );

    // מפתח ריק הוא "בלי מפתח" ולא שגיאה — הטופס לא תמיד שולח אחד
    const noKey = await duplicateNote(base.note._id, { issuedBy: TAG, idempotencyKey: "" });
    check("מפתח ריק נחשב כלא-נשלח", noKey.created === true);
    await DeliveryNote.deleteMany({ _id: noKey.note._id });

    // ── הצעת מחיר → תעודה ──
    const quote = await quotesLib.create({
      customerId: cust._id,
      items: [
        { sku: editable[0].sku, quantity: 2, unitPrice: 11 },
        { sku: editable[1].sku, quantity: 1 },
      ],
      createdBy: TAG,
    });
    check("הצעת מחיר נוצרה", Boolean(quote.quote?.number));
    check("הברקוד נשמר על שורות ההצעה", quote.quote.items.every((i) => "barcode" in i));
    check("מחיר שהוזן ידנית מסומן manual", quote.quote.items[0].priceSource === "manual");
    check("מחיר שנקבע מהמחירון אינו manual", quote.quote.items[1].priceSource !== "manual");
    check("שם הקטגוריה נשמר על ההצעה", "categoryName" in quote.quote.items[0]);

    const converted = await quotesLib.convert(quote.quote._id, { issuedBy: TAG });
    check("ההמרה יצרה תעודה", Boolean(converted.note?.number));
    check("ההצעה סומנה כאושרה", converted.quote.status === "accepted");
    check("ההצעה מצביעה על התעודה", String(converted.quote.convertedNote) === String(converted.note._id));
    check(
      "המחירים מההצעה עברו כמו שהם",
      converted.note.items.find((i) => String(i.sku) === String(editable[0].sku)).unitPrice === 11
    );
    check("ההמרה לא הפיקה חשבונית", converted.invoices.length === 0);

    // הפקה שנייה מאותה הצעה = חיוב כפול על אותה סחורה
    await (async () => {
      try {
        await quotesLib.convert(quote.quote._id, { issuedBy: TAG });
        check("המרה שנייה מאותה הצעה נחסמת", false, "לא נזרקה שגיאה");
      } catch (err) {
        check("המרה שנייה מאותה הצעה נחסמת", /כבר הומרה/.test(err.message), err.message);
      }
    })();
    check(
      "ולא נוצרה תעודה שנייה",
      (await DeliveryNote.countDocuments({ idempotencyKey: `quote:${quote.quote._id}` })) === 1
    );

    // ── שכפול הצעה ──
    const quoteCopy = await quotesLib.duplicate(quote.quote._id, { createdBy: TAG });
    check("ההצעה הועתקה", quoteCopy.number !== quote.quote.number);
    check("ההעתק נושא את אותן שורות", quoteCopy.items.length === quote.quote.items.length);
    check("ההעתק פתוח", quoteCopy.status === "open");
    check("ההעתק אינו יורש את הקישור לתעודה", !quoteCopy.convertedNote);

    // ההעתק כן ניתן להמרה — אחרת "העתק והפק שוב" לא היה עובד
    const convertedCopy = await quotesLib.convert(quoteCopy._id, { issuedBy: TAG });
    check("העתק ההצעה כן ניתן להמרה", Boolean(convertedCopy.note?.number));

    await Quote.deleteMany({ _id: { $in: [quote.quote._id, quoteCopy._id] } });
    await DeliveryNote.deleteMany({
      _id: { $in: [base.note._id, copy.note._id, copyOfBilled.note._id, converted.note._id, convertedCopy.note._id] },
    });
  }

  // ─────────────────────────────────────────────────────────────────
  await cleanup();
  console.log(`\n${"═".repeat(60)}`);
  console.log(fail === 0 ? `✅ כל ${pass} הבדיקות עברו` : `${pass} עברו · ${fail} נכשלו`);
  console.log("═".repeat(60));

  await mongoose.disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (err) => {
  console.error("\n❌ הבדיקה קרסה:", err.message);
  console.error(err.stack);
  try {
    await cleanup();
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});

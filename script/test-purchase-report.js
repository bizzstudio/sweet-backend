// script/test-purchase-report.js
//
// בדיקת דוח הרכישות (lib/billing/purchaseReport) — הרצה: npm run report:test
//
// ── למה בלי מסד ──
//
// מה שנבדק כאן הוא כללי הצבירה: מה נספר, מה מסונן החוצה, ואיך נראים
// הסכומים. בדיקה מול המסד האמיתי הייתה מודדת את הנתונים שבמסד באותו יום
// ולא את הכללים, ולכן DeliveryNote.find מוחלף כאן בתעודות בזיכרון.
//
// מה שאינו נבדק כאן: המיון עצמו (נעשה במסד) ומנוע השאילתות — הסטאב מיישם
// את התנאים שהדוח בונה, ולכן טעות בשם שדה תיתפס, אך לא טעות בסמנטיקה של
// אופרטור מונגו.
//
// מצב דמו נבדק בתת-תהליך: ICOUNT_MODE נקרא פעם אחת בעליית התהליך
// (lib/icount/mode.js), ולכן אי אפשר להחליף אותו באמצע ריצה.

const { execFileSync } = require("child_process");

// מזהים באורך ObjectId תקין: הדוח שולף מספרי לקוח ושמות קטגוריה לפי מזהה,
// ומזהה שאינו תקין מסונן שם בכוונה (הוא היה מפיל את השאילתה ב-CastError).
// מזהי צעצוע כמו "c1" היו גורמים לבדיקה לעקוף בדיוק את המסלול הזה
const C1 = "a1a1a1a1a1a1a1a1a1a1a101";
const C2 = "a1a1a1a1a1a1a1a1a1a1a102";
const CAT1 = "b2b2b2b2b2b2b2b2b2b2b201";
const CAT2 = "b2b2b2b2b2b2b2b2b2b2b202";

process.env.ICOUNT_MODE = process.env.ICOUNT_MODE || "live";
const DEMO_CHILD = process.env.REPORT_TEST_DEMO === "1";

const DeliveryNote = require("../models/DeliveryNote");
const Order = require("../models/Order");
const Status = require("../models/Status");
const Customer = require("../models/Customer");
const Category = require("../models/Category");

const notes = [
  {
    _id: "n1", number: 101, kind: "auto", issuedAt: new Date("2026-08-05T09:00:00Z"),
    total: 100, customer: C1, customerSnapshot: { name: "טבולה", customerNumber: "553" },
    orderNumber: 5001, billing: { status: "open" },
    items: [
      { name: "עוגיות", barcode: "111", quantity: 2, lineTotal: 60, categoryName: "כיבוד" },
      { name: "תפוח", barcode: "222", quantity: 4, lineTotal: 40, categoryName: "פירות" },
    ],
  },
  {
    _id: "n2", number: 102, kind: "manual", issuedAt: new Date("2026-08-20T09:00:00Z"),
    total: 50, customer: C1, customerSnapshot: { name: "טבולה", customerNumber: "553" },
    billing: { status: "billed", icountDocNum: "9001" },
    items: [{ name: "תפוח", barcode: "222", quantity: 5, lineTotal: 50, categoryName: "פירות" }],
  },
  {
    _id: "n3", number: 103, kind: "auto", issuedAt: new Date("2026-08-21T09:00:00Z"),
    total: 20, customer: C2, customerSnapshot: { name: "לקוח ב", customerNumber: "77" },
    billing: { status: "open" },
    items: [{ name: "עוגיות", barcode: "111", quantity: 1, lineTotal: 20, categoryName: "כיבוד" }],
  },
  {
    // תעודה מחוץ לטווח
    _id: "n4", number: 104, kind: "auto", issuedAt: new Date("2026-07-01T09:00:00Z"),
    total: 999, customer: C2, customerSnapshot: { name: "לקוח ב" },
    billing: { status: "open" }, items: [],
  },
  {
    // מבוטלת — אינה רכישה, ואסור שתיספר
    _id: "n5", number: 105, kind: "auto", issuedAt: new Date("2026-08-22T09:00:00Z"),
    total: 500, customer: C2, customerSnapshot: { name: "לקוח ב" },
    billing: { status: "cancelled" }, items: [],
  },
  {
    // תעודה ישנה מלפני שהשדה kind קיים: היא אוטומטית, וסינון "מהזמנה"
    // חייב לכלול אותה. שורה בלי ברקוד מקובצת לפי השם
    _id: "n6", number: 106, issuedAt: new Date("2026-08-23T09:00:00Z"),
    total: 30, customer: C2, customerSnapshot: { name: "לקוח ב", customerNumber: "77" },
    billing: {},
    items: [{ name: "לחם", quantity: 3, lineTotal: 30 }],
  },
];

// סטאב ל-find: מיישם את התנאים שהדוח בונה, בלי מונגו
let lastQuery = null;
const matches = (note, query) => {
  for (const [field, cond] of Object.entries(query)) {
    const value = field.split(".").reduce((acc, part) => acc?.[part], note);
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if (cond.$ne !== undefined && value === cond.$ne) return false;
      if (Array.isArray(cond.$nin) && cond.$nin.some((v) => String(v) === String(value))) return false;
      if (Array.isArray(cond.$in) && !cond.$in.some((v) => String(v) === String(value))) return false;
      if (cond.$gte !== undefined && !(value >= cond.$gte)) return false;
      if (cond.$lte !== undefined && !(value <= cond.$lte)) return false;
    } else if (String(value) !== String(cond)) {
      return false;
    }
  }
  return true;
};

DeliveryNote.find = (query) => {
  lastQuery = query;
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    lean: async () => notes.filter((note) => matches(note, query)),
  };
  return chain;
};

// ── מקור ההזמנות ──
const STATUSES = [
  { _id: "s1", heName: "נמסרה" },
  { _id: "s2", heName: "בוטלה" },
  { _id: "s3", heName: "שגיאה בקריאה" },
];

const orders = [
  {
    _id: "o1", invoice: 5001, createdAt: new Date("2026-08-10T09:00:00Z"), total: 200,
    user: C1, user_info: { name: "טבולה", lastName: "" }, status: "s1",
    cart: [
      { title: { he: "עוגיות" }, sku: "111", barcode: "", quantity: 2, itemTotal: 120, category: CAT1 },
      { title: { he: "תפוח" }, sku: "222", quantity: 4, itemTotal: 80, category: CAT2 },
    ],
  },
  {
    // אותו לקוח, הזמנה שנייה — נבדק שהצבירה מאחדת אותן
    _id: "o2", invoice: 5002, createdAt: new Date("2026-08-12T09:00:00Z"), total: 50,
    user: C1, user_info: { name: "טבולה", lastName: "" }, status: "s3",
    cart: [{ title: { he: "תפוח" }, sku: "222", quantity: 5, itemTotal: 50, category: CAT2 }],
  },
  {
    // מבוטלת — אינה רכישה
    _id: "o3", invoice: 5003, createdAt: new Date("2026-08-13T09:00:00Z"), total: 900,
    user: C2, user_info: { name: "לקוח ב" }, status: "s2", cart: [],
  },
  {
    // מחוץ לטווח
    _id: "o4", invoice: 5004, createdAt: new Date("2026-07-01T09:00:00Z"), total: 700,
    user: C2, user_info: { name: "לקוח ב" }, status: "s1", cart: [],
  },
  {
    // שורה ישנה בלי itemTotal — הסכום מחושב ממחיר × כמות
    _id: "o5", invoice: 5005, createdAt: new Date("2026-08-14T09:00:00Z"), total: 30,
    user: C2, user_info: { name: "לקוח ב" }, status: "s1",
    cart: [{ title: { he: "לחם" }, quantity: 3, price: 10 }],
  },
];

const stubFind = (model, rows, mapQuery = (q) => q) => {
  model.find = (query) => {
    lastQuery = mapQuery(query);
    const chain = {
      select: () => chain,
      sort: () => chain,
      limit: () => chain,
      lean: async () => rows.filter((row) => matches(row, query)),
    };
    return chain;
  };
};

stubFind(Order, orders);
stubFind(Status, STATUSES, (q) => q);
Customer.find = () => ({
  select: () => ({ lean: async () => [{ _id: C1, erp: { customerNumber: "553" } }] }),
});
Category.find = () => ({
  select: () => ({
    lean: async () => [
      { _id: CAT1, name: { he: "כיבוד" } },
      { _id: CAT2, name: { he: "פירות" } },
    ],
  }),
});

const { customerPurchaseReport } = require("../lib/billing/purchaseReport");

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "✓" : "✗"} ${label}${
      ok ? "" : ` — קיבלנו ${JSON.stringify(actual)} במקום ${JSON.stringify(expected)}`
    }`
  );
};

const RANGE = { from: "2026-08-01", to: "2026-08-31" };
const NOTES = { ...RANGE, source: "notes" };

(async () => {
  if (DEMO_CHILD) {
    // הביטול נרשם תמיד ב-billing.status, גם כשהחיוב עצמו רץ בכיס הדמו.
    // סינון דרך ledger.f היה מחזיר במצב דמו גם תעודות שבוטלו
    await customerPurchaseReport(NOTES);
    check("במצב דמו: הביטול מסונן מ-billing.status", lastQuery["billing.status"], {
      $ne: "cancelled",
    });
    check("במצב דמו: אין סינון על כיס הדמו", lastQuery["billing.demo.status"], undefined);
    process.exit(failures ? 1 : 0);
  }

  const r = await customerPurchaseReport(NOTES);
  check("הביטול מסונן מ-billing.status", lastQuery["billing.status"], { $ne: "cancelled" });
  check("שני לקוחות", r.totals.customers, 2);
  check("ארבע תעודות (בלי המבוטלת ובלי שמחוץ לטווח)", r.totals.notes, 4);
  check('סה"כ', r.totals.total, 200);
  check("הלקוח הגדול ראשון", r.customers[0].customerNumber, "553");
  check(
    "תעודות הלקוח",
    r.customers[0].notes.map((n) => n.number).sort(),
    [101, 102]
  );
  check("סטטוס תעודה בלי billing נחשב פתוחה", r.customers[1].notes.find((n) => n.number === 106).status, "open");
  check("תעודה בלי kind מסומנת אוטומטית", r.customers[1].notes.find((n) => n.number === 106).kind, "auto");
  check("שלושה מוצרים שונים", r.products.length, 3);
  check("תפוח: כמות מצטברת", r.products.find((p) => p.name === "תפוח").quantity, 9);
  check("עוגיות: שני לקוחות", r.products.find((p) => p.name === "עוגיות").customersCount, 2);
  check("שורה בלי ברקוד מקובצת לפי שם", r.products.find((p) => p.name === "לחם").total, 30);
  check("הדוח אינו חתוך", r.truncated, false);

  const one = await customerPurchaseReport({ ...NOTES, customerId: C2 });
  check("סינון ללקוח אחד", one.totals.notes, 2);
  check(
    "המוצרים מצטמצמים ללקוח",
    one.products.map((p) => p.name).sort(),
    ["לחם", "עוגיות"]
  );

  const manual = await customerPurchaseReport({ ...NOTES, kind: "manual" });
  check("סינון לתעודות ידניות", manual.totals.notes, 1);

  const auto = await customerPurchaseReport({ ...NOTES, kind: "auto" });
  check("סינון ל'מהזמנה' כולל תעודה ישנה בלי kind", auto.totals.notes, 3);

  const cancelled = await customerPurchaseReport({ ...NOTES, includeCancelled: true });
  check("אפשר לכלול מבוטלות במפורש", cancelled.totals.notes, 5);

  const noRange = await customerPurchaseReport({ source: "notes" });
  check("בלי טווח תאריכים נכללות כל התעודות", noRange.totals.notes, 5);
  check("תאריך פסול אינו הופך לסינון שקט", (await customerPurchaseReport({ source: "notes", from: "לא-תאריך" })).from, null);

  // ── מקור: הזמנות ──
  const o = await customerPurchaseReport({ ...RANGE });
  check("ברירת המחדל היא הזמנות", o.source, "orders");
  check("הזמנות: שני לקוחות", o.totals.customers, 2);
  check("הזמנות: מבוטלת ומחוץ לטווח אינן נספרות", o.totals.notes, 3);
  check("הזמנות: סכום", o.totals.total, 280);
  check("הזמנות: מספר הלקוח נשלף מכרטיס הלקוח", o.customers[0].customerNumber, "553");
  check("הזמנות: שם המוצר נלקח מהעברית", o.products.find((p) => p.name === "עוגיות")?.total, 120);
  check("הזמנות: שם הקטגוריה נפתר ממזהה", o.products.find((p) => p.name === "תפוח")?.categoryName, "פירות");
  check("הזמנות: שורה בלי itemTotal מחושבת ממחיר × כמות", o.products.find((p) => p.name === "לחם")?.total, 30);
  check("הזמנות: סטטוס מוצג בשם", o.customers[0].notes[0].statusLabel !== null, true);
  check("הזמנות: הזמנה שנקלטה חלקית מסומנת", o.flagged, 1);
  check("הזמנות: הסימון נספר גם ברמת הלקוח", o.customers.find((c) => c.customerNumber === "553").flaggedCount, 1);
  check("הזמנות: סינון ללקוח אחד", (await customerPurchaseReport({ ...RANGE, customerId: C2 })).totals.notes, 1);
  check("מקור לא מוכר נופל להזמנות", (await customerPurchaseReport({ ...RANGE, source: "אחר" })).source, "orders");

  // ── חוזה ה-HTTP ──
  //
  // הבקר הוא מה שהמסך מדבר איתו: אימות שנשבר שם מחזיר 500 עם stack trace
  // או — גרוע מכך — דוח לא מסונן שנראה בדיוק כמו דוח מסונן
  const { getCustomerPurchaseReport } = require("../controller/billingController");

  const call = async (query) => {
    const captured = {};
    const res = {
      status(code) {
        captured.status = code;
        return res;
      },
      send(body) {
        captured.status = captured.status || 200;
        captured.body = body;
        return res;
      },
    };
    await getCustomerPurchaseReport({ query }, res);
    return captured;
  };

  check("הבקר מחזיר דוח תקין", (await call({ ...RANGE })).status, 200);
  check("מקור לא מוכר נדחה", (await call({ source: "אחר" })).status, 400);
  check("סוג תעודה עם מקור הזמנות נדחה", (await call({ source: "orders", kind: "manual" })).status, 400);
  check("סוג תעודה עם מקור תעודות מתקבל", (await call({ source: "notes", kind: "manual" })).status, 200);
  check("מזהה לקוח פסול נדחה", (await call({ customer: "לא-מזהה" })).status, 400);
  check("תאריך פסול נדחה", (await call({ from: "31/08/2026" })).status, 400);
  check("טווח הפוך נדחה", (await call({ from: "2026-08-31", to: "2026-08-01" })).status, 400);
  check("סוג תעודה לא מוכר נדחה", (await call({ kind: "אחר" })).status, 400);
  check(
    "פרמטר כפול (מערך) אינו עוקף את האימות",
    (await call({ from: ["2026-08-01", "2026-08-02"] })).status,
    400
  );
  check("הדוח מוחזר עם המפתחות שהמסך מצפה להם",
    Object.keys((await call({ ...RANGE })).body).sort(),
    ["customers", "flagged", "flaggedLabel", "from", "limit", "products", "source", "to", "totals", "truncated"]);

  // מצב דמו — תת-תהליך, כי ICOUNT_MODE נקרא פעם אחת בעלייה
  try {
    const out = execFileSync(process.execPath, [__filename], {
      env: { ...process.env, ICOUNT_MODE: "demo", REPORT_TEST_DEMO: "1" },
      encoding: "utf8",
    });
    process.stdout.write(out);
  } catch (err) {
    process.stdout.write(err.stdout || "");
    failures += 1;
  }

  if (failures) {
    console.log(`\n${failures} בדיקות נכשלו`);
    process.exit(1);
  }
  console.log("\nכל הבדיקות עברו");
})();

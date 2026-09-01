// lib/billing/purchaseReport.js
//
// דוח רכישות לקוחות: "מה כל לקוח קנה, ובאילו מסמכים".
//
// ── שני מקורות, ולמה שניהם נחוצים ──
//
//   orders — ההזמנות. כל מה שהלקוח הזמין, מהיום הראשון. זה המקור שבו יש
//            היסטוריה מלאה, וזו התשובה ל"מה הם קנו".
//   notes  — תעודות המשלוח. רק מה שנמסר בפועל ונכנס לחיוב, כולל המשקל
//            שנשקל בתעודה הידנית. זו התשובה ל"על מה חייבנו".
//
// דוח שנבנה על תעודות בלבד היה מדויק אבל כמעט ריק: התעודות נוצרות רק מאז
// שמסלול החיוב נכנס לאוויר, וההזמנות שקדמו לו — הרוב המוחלט — אינן
// מיוצגות בהן. דוח שנבנה על הזמנות בלבד היה מראה את מה שהוזמן ולא את מה
// שנמסר. לכן המסך בוחר, והתשובה אומרת במפורש מה נספר.
//
// שני החתכים זהים בשני המקורות:
//   customers — שורה לכל לקוח, עם המסמכים שלו (כותרות בלבד)
//   products  — מה נקנה, מקובץ לפי מוצר, על פני כל מה שנכנס לסינון
//
// שורות המסמך עצמן אינן נשלחות למסך: מסמך בודד נפתח במסך שלו, ופירוט
// המוצרים כבר עונה על "מה קנו". כך הדוח נשאר בקשה אחת קטנה.

const mongoose = require("mongoose");
const DeliveryNote = require("../../models/DeliveryNote");
const Order = require("../../models/Order");
const Status = require("../../models/Status");
const Customer = require("../../models/Customer");
const Category = require("../../models/Category");
const ledger = require("./ledger");
const { israelDay } = require("./deliveryNotes");

const DAY_MS = 24 * 60 * 60 * 1000;

// תקרה על מספר המסמכים שנקראים בבקשה אחת. טווח של שנים על מסד גדול היה
// שולף הכל לזיכרון; עדיף להחזיר דוח חתוך *ולומר* שהוא חתוך
const MAX_DOCS = 5000;

const SOURCES = ["orders", "notes"];

// הזמנה שבוטלה אינה רכישה. הזיהוי לפי שם הסטטוס בעברית ולא לפי מזהה, כי
// המזהים נוצרים בכל מסד מחדש (script/init-db) ואינם קבועים
const CANCELLED_STATUS = "בוטלה";

// הזמנה שהקליטה האוטומטית לא הצליחה לקרוא במלואה. היא נכללת בדוח — היא
// הזמנה אמיתית של לקוח אמיתי — אבל נספרת גם בנפרד, כי ייתכן שחלק
// מהשורות שלה חסרות והסכום שלה חלקי
const FAILED_INGEST_STATUS = "שגיאה בקריאה";

const isDayString = (value) => {
  const day = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
};

const round2 = (n) => Number((Number(n) || 0).toFixed(2));

/*
 * תנאי הטווח לשאילתה.
 *
 * הטווח הוא ימים בשעון ישראל, אבל השדה במסד הוא רגע ב-UTC ושעון השרת
 * אינו ידוע. השאילתה לוקחת יום עודף בכל צד כדי לא לחתוך מסמך בקצה היום,
 * והסינון המדויק נעשה אחר כך על היום הישראלי — כמו בדוח הקבלות.
 */
const dateRangeQuery = (fromDay, toDay) => {
  if (!fromDay && !toDay) return null;
  const range = {};
  if (fromDay) {
    range.$gte = new Date(new Date(`${fromDay}T00:00:00.000Z`).getTime() - DAY_MS);
  }
  if (toDay) {
    range.$lte = new Date(new Date(`${toDay}T00:00:00.000Z`).getTime() + 2 * DAY_MS);
  }
  return range;
};

/** האם המסמך נופל בתוך הימים שנבחרו, לפי שעון ישראל. */
const inDayRange = (date, fromDay, toDay) => {
  if (!fromDay && !toDay) return true;
  if (!date) return false;
  const day = israelDay(new Date(date));
  if (fromDay && day < fromDay) return false;
  if (toDay && day > toDay) return false;
  return true;
};

// מפתח הקיבוץ של מוצר. הברקוד הוא מה שהלקוחה מצליבה מולו, אבל שורות
// ישנות נשמרו בלעדיו — ואז השם הוא המפתח היחיד שיש. קיבוץ לפי productId
// לבדו לא מספיק: הוא ריק בשורות שהוקלדו ידנית
const productKey = (item) =>
  String(item?.barcode || item?.sku || item?.productId || item?.name || "—")
    .trim()
    .toLowerCase();

/*
 * צובר את שני החתכים.
 *
 * מקבל מסמכים מנורמלים ("מסמך" עם items ו-summary), כדי ששני המקורות
 * ייצאו בדיוק באותו מבנה — אחרת המסך היה צריך להכיר שניים.
 */
const aggregate = (documents) => {
  const byCustomer = new Map();
  const byProduct = new Map();
  let grandTotal = 0;

  for (const doc of documents) {
    const key = String(doc.customerId || "—");
    if (!byCustomer.has(key)) {
      byCustomer.set(key, {
        customerId: doc.customerId || null,
        name: doc.customerName || "—",
        customerNumber: doc.customerNumber || null,
        notesCount: 0,
        itemsCount: 0,
        total: 0,
        flaggedCount: 0,
        notes: [],
      });
    }
    const row = byCustomer.get(key);
    const items = Array.isArray(doc.items) ? doc.items : [];

    row.notesCount += 1;
    row.itemsCount += items.length;
    row.total += doc.total;
    if (doc.flagged) row.flaggedCount += 1;
    row.notes.push(doc.summary);

    grandTotal += doc.total;

    for (const item of items) {
      const pKey = productKey(item);
      if (!byProduct.has(pKey)) {
        byProduct.set(pKey, {
          key: pKey,
          name: item?.name || "—",
          barcode: item?.barcode || null,
          sku: item?.sku || null,
          categoryName: item?.categoryName || null,
          quantity: 0,
          total: 0,
          // כמה לקוחות קנו את המוצר — מה שהופך את החתך הזה לדוח ולא
          // לרשימת שורות. Set ולא מונה: אותו לקוח קונה בכמה מסמכים
          customers: new Set(),
          notesCount: 0,
        });
      }
      const product = byProduct.get(pKey);
      product.quantity += Number(item?.quantity) || 0;
      product.total += Number(item?.lineTotal) || 0;
      product.customers.add(key);
      product.notesCount += 1;
    }
  }

  const customers = [...byCustomer.values()]
    .map((row) => ({ ...row, total: round2(row.total) }))
    .sort((a, b) => b.total - a.total);

  const products = [...byProduct.values()]
    .map(({ customers: buyers, ...product }) => ({
      ...product,
      quantity: round2(product.quantity),
      total: round2(product.total),
      customersCount: buyers.size,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    customers,
    products,
    totals: {
      customers: customers.length,
      notes: documents.length,
      total: round2(grandTotal),
    },
  };
};

/** מספרי הלקוחות בהנהח"ש, למסמכים שאינם נושאים אותם בעצמם. */
const customerNumbers = async (ids) => {
  const valid = [...new Set(ids.filter(Boolean).map(String))].filter((id) =>
    mongoose.Types.ObjectId.isValid(id)
  );
  if (!valid.length) return new Map();

  const rows = await Customer.find({ _id: { $in: valid } })
    .select("erp.customerNumber")
    .lean();
  return new Map(rows.map((c) => [String(c._id), c.erp?.customerNumber || null]));
};

/** שמות הקטגוריות לשורות ההזמנה, שנושאות מזהה בלבד. */
const categoryNames = async (ids) => {
  const valid = [...new Set(ids.filter(Boolean).map(String))].filter((id) =>
    mongoose.Types.ObjectId.isValid(id)
  );
  if (!valid.length) return new Map();

  const rows = await Category.find({ _id: { $in: valid } }).select("name").lean();
  return new Map(rows.map((c) => [String(c._id), c.name?.he || c.name?.en || null]));
};

// ---------- מקור: תעודות משלוח ----------

const fromDeliveryNotes = async ({ customerId, fromDay, toDay, kind, includeCancelled }) => {
  const query = {};
  if (customerId) query.customer = customerId;

  // תעודות ישנות נוצרו לפני שהשדה kind קיים והן כולן אוטומטיות. סינון על
  // "auto" חייב לכלול גם אותן — אותו כלל כמו במסך התעודות (getDeliveryNotes)
  if (kind === "auto") query.kind = { $ne: "manual" };
  else if (kind === "manual") query.kind = "manual";

  // תעודה שבוטלה אינה רכישה. הביטול נרשם תמיד ב-billing.status ולא בכיס
  // הדמו — ביטול תעודה אינו פעולת חיוב — ולכן הסינון כאן אינו עובר דרך
  // ledger.f, בדיוק כמו הסינון "בוטלה" במסך התעודות
  if (!includeCancelled) query["billing.status"] = { $ne: "cancelled" };

  const range = dateRangeQuery(fromDay, toDay);
  if (range) query.issuedAt = range;

  const rows = ledger.normalizeAll(
    await DeliveryNote.find(query)
      .select(
        "number kind issuedAt total customer customerSnapshot items billing manualReference orderNumber"
      )
      // מיון לפי issuedAt בלבד — בדיוק כמו האינדקס שבמודל. הוספת number
      // כשובר שוויון הייתה מחזירה את המיון להיות חוסם בזיכרון
      .sort({ issuedAt: -1 })
      .limit(MAX_DOCS + 1)
      .lean()
  );

  const truncated = rows.length > MAX_DOCS;
  const documents = [];

  for (const note of truncated ? rows.slice(0, MAX_DOCS) : rows) {
    if (!inDayRange(note.issuedAt, fromDay, toDay)) continue;

    const items = Array.isArray(note.items) ? note.items : [];
    documents.push({
      customerId: note.customer ? String(note.customer) : null,
      customerName: note.customerSnapshot?.name || "—",
      customerNumber: note.customerSnapshot?.customerNumber || null,
      total: Number(note.total) || 0,
      flagged: false,
      items,
      summary: {
        _id: String(note._id),
        number: note.number,
        kind: note.kind || "auto",
        issuedAt: note.issuedAt || null,
        total: round2(note.total),
        itemCount: items.length,
        orderNumber: note.orderNumber || null,
        manualReference: note.manualReference || null,
        status: note.billing?.status || "open",
        statusLabel: null,
        icountDocNum: note.billing?.icountDocNum || null,
        flagged: false,
      },
    });
  }

  return { documents, truncated };
};

// ---------- מקור: הזמנות ----------

const fromOrders = async ({ customerId, fromDay, toDay }) => {
  const statuses = await Status.find({}).select("heName").lean();
  const statusName = new Map(statuses.map((s) => [String(s._id), s.heName]));
  const cancelledIds = statuses
    .filter((s) => s.heName === CANCELLED_STATUS)
    .map((s) => s._id);

  const query = {};
  if (customerId) query.user = customerId;
  if (cancelledIds.length) query.status = { $nin: cancelledIds };

  const range = dateRangeQuery(fromDay, toDay);
  if (range) query.createdAt = range;

  const rows = await Order.find(query)
    .select("invoice createdAt total user user_info cart status")
    .sort({ createdAt: -1 })
    .limit(MAX_DOCS + 1)
    .lean();

  const truncated = rows.length > MAX_DOCS;
  const kept = (truncated ? rows.slice(0, MAX_DOCS) : rows).filter((order) =>
    inDayRange(order.createdAt, fromDay, toDay)
  );

  // שני ה-lookup נעשים פעם אחת על כל מה שנשאר, ולא שורה-שורה: מספר הלקוח
  // אינו נשמר על ההזמנה, ושורת ההזמנה נושאת מזהה קטגוריה בלבד
  const [numbers, categories] = await Promise.all([
    customerNumbers(kept.map((o) => o.user)),
    categoryNames(kept.flatMap((o) => (o.cart || []).map((i) => i?.category))),
  ]);

  const documents = kept.map((order) => {
    const cart = Array.isArray(order.cart) ? order.cart : [];
    const label = statusName.get(String(order.status)) || null;
    const flagged = label === FAILED_INGEST_STATUS;

    const items = cart.map((item) => ({
      // שם המוצר בהזמנה נשמר רב-לשוני, בניגוד לשורת התעודה
      name: item?.title?.he || item?.title?.en || item?.title || item?.name || "—",
      barcode: item?.barcode || null,
      sku: item?.sku || null,
      productId: item?.productId || item?.id || null,
      categoryName: categories.get(String(item?.category)) || null,
      quantity: Number(item?.quantity) || 0,
      // itemTotal הוא מה שההזמנה עצמה חישבה. החישוב מהמחיר הוא גיבוי
      // לשורות ישנות שנשמרו בלעדיו
      lineTotal:
        item?.itemTotal === undefined || item?.itemTotal === null
          ? (Number(item?.price) || 0) * (Number(item?.quantity) || 0)
          : Number(item.itemTotal) || 0,
    }));

    return {
      customerId: order.user ? String(order.user) : null,
      customerName:
        `${order.user_info?.name || ""} ${order.user_info?.lastName || ""}`.trim() || "—",
      customerNumber: numbers.get(String(order.user)) || null,
      total: Number(order.total) || 0,
      flagged,
      items,
      summary: {
        _id: String(order._id),
        number: order.invoice || null,
        kind: "order",
        issuedAt: order.createdAt || null,
        total: round2(order.total),
        itemCount: items.length,
        orderNumber: order.invoice || null,
        manualReference: null,
        status: null,
        statusLabel: label,
        icountDocNum: null,
        // הזמנה שהקליטה לא קראה במלואה: המסך מסמן אותה, כדי שסכום חלקי
        // לא ייקרא כסכום מלא
        flagged,
      },
    };
  });

  return { documents, truncated };
};

/**
 * @param {object} [opts]
 * @param {string} [opts.source]      - "orders" (ברירת מחדל) או "notes"
 * @param {string} [opts.customerId]  - סינון ללקוח אחד
 * @param {string} [opts.from]        - תאריך מ- (YYYY-MM-DD, כולל)
 * @param {string} [opts.to]          - תאריך עד (YYYY-MM-DD, כולל)
 * @param {string} [opts.kind]        - "auto" | "manual" — לתעודות בלבד
 * @param {boolean} [opts.includeCancelled] - לכלול תעודות שבוטלו
 */
const customerPurchaseReport = async ({
  source = "orders",
  customerId,
  from,
  to,
  kind,
  includeCancelled = false,
} = {}) => {
  const fromDay = isDayString(from) ? from : null;
  const toDay = isDayString(to) ? to : null;
  const useSource = SOURCES.includes(source) ? source : "orders";

  const { documents, truncated } =
    useSource === "notes"
      ? await fromDeliveryNotes({ customerId, fromDay, toDay, kind, includeCancelled })
      : await fromOrders({ customerId, fromDay, toDay });

  return {
    source: useSource,
    from: fromDay,
    to: toDay,
    ...aggregate(documents),
    // הזמנות שהקליטה האוטומטית לא קראה במלואן. הן נכללות בדוח, אבל
    // נספרות גם בנפרד כדי שאפשר יהיה לדעת כמה מהמספרים נשענים על
    // קריאה חלקית
    flagged: documents.filter((d) => d.flagged).length,
    flaggedLabel: FAILED_INGEST_STATUS,
    // הדוח נחתך בתקרה: המסך אומר את זה במפורש, כדי שסכום חלקי לא ייקרא
    // כסכום מלא
    truncated,
    limit: MAX_DOCS,
  };
};

module.exports = { customerPurchaseReport, isDayString, SOURCES };

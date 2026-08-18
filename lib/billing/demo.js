// lib/billing/demo.js
//
// הפקת מסמכי הדגמה מול חשבון הדמו של iCount.
//
// כל הפונקציות כאן מפיקות מסמך אמיתי — אבל בחשבון אחר, שאינו הספרים של
// העסק. המחיר של "אמיתי" הוא שרואים בדיוק את המסמך שהלקוחה תראה: אותם
// שדות, אותו חישוב מע"מ, אותו PDF.
//
// הכלל היחיד שאסור להפר: הקובץ הזה **לא כותב דבר למסד**.
//
//   סגירת חודש רגילה מסמנת תעודות כ-billed, ותעודה שסומנה כך לא תחויב
//   שוב לעולם. אם היינו מסמנים אותן מול חשבונית דמו, הלקוחה הייתה מגלה
//   את זה רק בסוף החודש — בסכום חסר בחשבונית האמיתית. לכן ההדגמה קוראת
//   תעודות ולקוחות בלבד, ולעולם לא מעדכנת אותם.
//
// גם ההפך מוגן: assertDemo חוסם את כל הפונקציות האלה כשהמערכת מחוברת
// לחשבון האמיתי, כדי שכפתור "הפקת דמו" לא יפיק חשבונית מס בספרים.

const DeliveryNote = require("../../models/DeliveryNote");
const Customer = require("../../models/Customer");
const {
  createInvoice,
  createCreditNote,
  createReceipt,
  getDocument,
  DOC_TYPES,
} = require("../icount/documents");
const { assertDemo } = require("../icount/mode");
const { calculateVat } = require("./vat");

/**
 * סל הדגמה קבוע, לשימוש כשלא בוחרים תעודת משלוח.
 *
 * שתי שורות חייבות ואחת פטורה — בכוונה: זה מה שמראה שהמע"מ מחושב ברמת
 * השורה ולא על המסמך, וזו הנקודה שהכי קשה להאמין לה בלי לראות מסמך.
 */
const SAMPLE_ITEMS = [
  { name: "מארז שוקולד — הדגמה", sku: "DEMO-001", quantity: 3, unitPrice: 25, lineTotal: 75, isVatFree: false },
  { name: "סוכריות ג'לי — הדגמה", sku: "DEMO-002", quantity: 10, unitPrice: 8.5, lineTotal: 85, isVatFree: false },
  { name: "תפוחים — הדגמה (פטור ממע\"מ)", sku: "DEMO-003", quantity: 5, unitPrice: 6, lineTotal: 30, isVatFree: true },
];

// המסמכים שהופקו בהרצה הנוכחית. הזיכרון הזה הוא מה שמאפשר לזכות מסמך או
// לרשום עליו קבלה בלי שהדפדפן יצטרך לשלוח בחזרה שורות וסכומים — ובלי
// שנצטרך לשמור מסמכי הדגמה במסד. מת בריסטארט, וזה בסדר: אז מפיקים חדש.
const issued = new Map();
const MAX_TRACKED = 200;

const remember = (doc) => {
  if (issued.size >= MAX_TRACKED) issued.delete(issued.keys().next().value);
  issued.set(String(doc.docNum), doc);
};

/** מחזיר מסמך דמו שהופק בהרצה הזאת, או זורק הודעה מובנת. */
const recall = (docNum) => {
  const doc = issued.get(String(docNum));
  if (!doc) {
    throw new Error(
      `חשבונית הדמו ${docNum} אינה מוכרת בהרצה הנוכחית (כנראה השרת עלה מחדש). ` +
        "יש להפיק חשבונית דמו חדשה ולפעול עליה."
    );
  }
  return doc;
};

const netOf = (items) =>
  Number(items.reduce((s, i) => s + Number(i.lineTotal || 0), 0).toFixed(2));

/**
 * לקוחות שאפשר להפיק להם הדגמה — כלומר כאלה שיש להם מספר לקוח בהנהח"ש,
 * שהוא מפתח ההתאמה מול iCount. בלעדיו הסנכרון נכשל וההדגמה לא תרוץ.
 *
 * מחזיר גם את המספר הכולל: בורר שמראה 100 מתוך 769 בלי לומר זאת נראה
 * בדיוק כמו בורר שמראה את כולם.
 *
 * @returns {Promise<{customers: Array, total: number}>}
 */
const listDemoCustomers = async (limit = 100) => {
  const query = { "erp.customerNumber": { $exists: true, $ne: "" } };
  const [customers, total] = await Promise.all([
    Customer.find(query).select("+erp name lastName").sort({ name: 1 }).limit(limit).lean(),
    Customer.countDocuments(query),
  ]);

  return {
    total,
    customers: customers.map((c) => ({
      _id: String(c._id),
      name: [c.name, c.lastName].filter(Boolean).join(" ").trim(),
      customerNumber: c.erp?.customerNumber,
      vatId: c.erp?.idNumber || null,
    })),
  };
};

/**
 * תעודות משלוח אחרונות, כמקור אפשרי להדגמה.
 *
 * גם תעודות שכבר חויבו מופיעות: ההדגמה אינה נוגעת בהן, והן דווקא המקור
 * המעניין — שורות אמיתיות עם מחירים אמיתיים.
 */
const listDemoSources = async (limit = 30) => {
  const notes = await DeliveryNote.find({})
    .select("number customer customerSnapshot items subTotal total issuedAt billing.status")
    .sort({ number: -1 })
    .limit(limit)
    .lean();

  return notes.map((n) => ({
    _id: String(n._id),
    number: n.number,
    customerName: n.customerSnapshot?.name || "—",
    itemCount: n.items?.length || 0,
    total: n.total,
    issuedAt: n.issuedAt,
    status: n.billing?.status,
  }));
};

/**
 * חשבונית מס הדגמה.
 *
 * @param {object} p
 * @param {string} [p.deliveryNoteId] - להפיק על בסיס תעודה קיימת (לא משנה אותה)
 * @param {string} [p.customerId]     - הלקוח, כשלא נבחרה תעודה
 * @returns {Promise<object>} המסמך שנוצר, כולל קישור ואומדן מע"מ
 */
const issueDemoInvoice = async ({ deliveryNoteId, customerId } = {}) => {
  assertDemo("הפקת חשבונית דמו");

  let items = SAMPLE_ITEMS;
  let description = "חשבונית הדגמה — נוצרה ממסך הדמו";
  let sourceNote = null;

  if (deliveryNoteId) {
    // lean() — קריאה בלבד. אין כאן save, updateOne או כל דבר שנוגע בתעודה.
    const note = await DeliveryNote.findById(deliveryNoteId).lean();
    if (!note) throw new Error(`תעודת משלוח ${deliveryNoteId} לא נמצאה`);
    if (!note.items?.length) throw new Error(`בתעודה ${note.number} אין שורות`);

    items = note.items;
    customerId = note.customer;
    sourceNote = note.number;
    description = `חשבונית הדגמה — על בסיס תעודת משלוח ${note.number}`;
  }

  if (!customerId) throw new Error("יש לבחור לקוח או תעודת משלוח להדגמה");

  const customer = await Customer.findById(customerId).select("+erp name lastName").lean();
  if (!customer) throw new Error(`לקוח ${customerId} לא נמצא`);

  const doc = await createInvoice({
    customerId,
    items,
    description,
    // אף פעם לא שולחים מייל מהדמו. חשבונית הדגמה שמגיעה ללקוח אמיתי היא
    // בדיוק סוג הטלפון שאי אפשר לתקן אחר כך.
    emailDocument: false,
  });

  const result = {
    ...doc,
    demo: true,
    customerId: String(customerId),
    customerName: [customer.name, customer.lastName].filter(Boolean).join(" ").trim(),
    sourceNote,
    items: items.map((i) => ({
      name: i.name,
      sku: i.sku || null,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      lineTotal: i.lineTotal,
      isVatFree: !!i.isVatFree,
    })),
    // אומדן שלנו. הסכום המחייב מגיע מ-iCount ב-fetchDemoTotal.
    estimate: calculateVat({ items, subTotal: netOf(items) }),
  };

  remember(result);
  return result;
};

/** הסכומים כפי ש-iCount עצמו מחזיר אותם — לאימות מול האומדן שלנו. */
const fetchDemoTotal = async (docNum) => {
  assertDemo("קריאת מסמך דמו");
  const doc = await getDocument(DOC_TYPES.INVOICE, docNum);

  return {
    docNum: String(docNum),
    totalBeforeVat: Number(doc.totalsum ?? 0),
    vat: Number(doc.totalvat ?? 0),
    totalWithVat: Number(doc.totalwithvat ?? doc.doc_total ?? 0),
  };
};

/**
 * זיכוי של חשבונית הדגמה. השורות נלקחות מהמסמך שהופק, לא מהדפדפן.
 */
const issueDemoCredit = async ({ docNum, reason } = {}) => {
  assertDemo("הפקת זיכוי דמו");
  const original = recall(docNum);

  const doc = await createCreditNote({
    customerId: original.customerId,
    originalDocNum: String(docNum),
    items: original.items,
    reason: reason || "הדגמה",
    emailDocument: false,
  });

  return { ...doc, demo: true, creditedDocNum: String(docNum) };
};

/**
 * קבלה על חשבונית הדגמה.
 *
 * הסכום נקרא מ-iCount ולא מהאומדן שלנו — אותה החלטה כמו בזרימה האמיתית:
 * קבלה על סכום שונה מהחשבונית משאירה פער בכרטסת, וההדגמה אמורה להראות
 * את ההתנהגות הנכונה ולא גרסה מקוצרת שלה.
 */
const issueDemoReceipt = async ({ docNum, method = "transfer", amount } = {}) => {
  assertDemo("הפקת קבלת דמו");
  const original = recall(docNum);

  let sum = Number(amount);
  if (!(sum > 0)) {
    const totals = await fetchDemoTotal(docNum);
    sum = totals.totalWithVat;
  }
  if (!(sum > 0)) throw new Error("לא ניתן היה לקבוע את סכום החשבונית לקבלה");

  const doc = await createReceipt({
    customerId: original.customerId,
    amount: sum,
    method,
    forInvoices: [String(docNum)],
    emailDocument: false,
  });

  return { ...doc, demo: true, amount: sum, forInvoice: String(docNum) };
};

module.exports = {
  SAMPLE_ITEMS,
  listDemoCustomers,
  listDemoSources,
  issueDemoInvoice,
  issueDemoCredit,
  issueDemoReceipt,
  fetchDemoTotal,
};

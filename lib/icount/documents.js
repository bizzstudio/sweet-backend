// lib/icount/documents.js
//
// הפקת מסמכים ב-iCount: חשבונית מס, חשבונית זיכוי וקבלה.
//
// טיפול במע"מ — הנחת היסוד של כל הקובץ:
//
//   כל המחירים במערכת הם *ללא* מע"מ. מקור: קובץ המחירון של הלקוחה נושא
//   את הכותרת "מחירוני לקוח ללא מעמ", וההזמנות לא מבצעות שום חישוב מע"מ
//   (total = subTotal + משלוח - הנחה). לכן שולחים ל-iCount מחירים נטו
//   ומבקשים ממנו להוסיף מע"מ.
//
//   החריג הוא שורות פטורות (377 מוצרים מסומנים isVatFree — פירות וכד').
//   הפטור הוא ברמת השורה ולא ברמת המסמך, ולכן כל שורה נושאת דגל משלה.

const { call, IcountError } = require("./client");
const { ensureClientId } = require("./clients");

// סוגי המסמכים כפי שהם מוגדרים בחשבון (אומת מול doc/types ב-13/08/26)
const DOC_TYPES = {
  INVOICE: "invoice", // חשבונית מס
  INVOICE_RECEIPT: "invrec", // חשבונית מס קבלה
  RECEIPT: "receipt", // קבלה
  CREDIT: "refund", // חשבונית זיכוי
};

// הצעת מחיר (doctype "offer") אינה כאן בכוונה: היא נבנית ומודפסת אצלנו
// ואינה נשלחת ל-iCount, כמו תעודת משלוח. ל-iCount נכנסים רק מסמכי המס.

/**
 * המרת שורות שלנו לשורות iCount.
 *
 * iCount מצפה למחיר ליחידה ולכמות ומחשב את השורה בעצמו. לא שולחים lineTotal
 * מחושב — אם היה הפרש עיגול בינינו לביניהם, המסמך היה מציג סכום שלא מסתדר
 * עם השורות שלו.
 */
const toIcountItems = (items) =>
  items.map((item) => ({
    description: item.name,
    quantity: item.quantity,
    unitprice: item.unitPrice,
    // 0 = השורה חייבת במע"מ, 1 = פטורה. iCount מוסיף את המע"מ בעצמו
    // על השורות החייבות.
    vat_exempt: item.isVatFree ? 1 : 0,
    // מק"ט מוצג על המסמך ומאפשר ללקוח להצליב מול תעודת המשלוח.
    // שם השדה הוא sku ולא catalog_num — אומת מול doc/info ב-13/08/26,
    // כששלחנו catalog_num והשדה חזר ריק.
    sku: item.sku || undefined,
  }));

/**
 * בסיס משותף לכל מסמך: לקוח, מע"מ, שפה ומטבע.
 */
const baseDoc = async (customerId, { emailDocument = false } = {}) => ({
  client_id: await ensureClientId(customerId),
  // המחירים שאנחנו שולחים אינם כוללים מע"מ — iCount יוסיף אותו.
  // (ההפך היה גורם לו לחלץ מע"מ אחורה ולהקטין את ההכנסה ב-15.25%)
  price_includes_vat: 0,
  currency_code: "ILS",
  lang: "he",
  // שליחת המסמך במייל היא פעולה חיצונית בלתי הפיכה. ברירת המחדל היא לא
  // לשלוח — ההפקה והשליחה הן שתי החלטות נפרדות, ובחלק מהלקוחות המייל
  // שבמערכת הוא מייל מזויף מהיבוא (erp-N@import.local).
  email_document: emailDocument ? 1 : 0,
});

/**
 * נרמול תשובת iCount למבנה אחיד. השדות שלהם משתנים מעט בין סוגי מסמכים,
 * ואין סיבה שכל קורא יתמודד עם זה.
 */
const normalizeResult = (res, doctype) => ({
  doctype,
  docNum: String(res.docnum ?? res.doc_number ?? ""),
  docId: res.doc_id ? String(res.doc_id) : undefined,
  url: res.doc_url || res.pdf_link || undefined,
  total: res.doc_total ?? undefined,
  raw: res,
});

/**
 * חשבונית מס.
 *
 * @param {object} p
 * @param {string} p.customerId
 * @param {Array}  p.items        - שורות בפורמט של DeliveryNote.items
 * @param {string} [p.description] - טקסט חופשי בראש המסמך
 * @param {number} [p.discount]    - הנחה בשקלים, לפני מע"מ
 * @param {boolean} [p.emailDocument]
 */
const createInvoice = async ({
  customerId,
  items,
  description,
  discount = 0,
  emailDocument = false,
}) => {
  if (!items?.length) throw new IcountError("אי אפשר להפיק חשבונית בלי שורות");

  const params = {
    ...(await baseDoc(customerId, { emailDocument })),
    doctype: DOC_TYPES.INVOICE,
    items: toIcountItems(items),
  };

  if (description) params.description = description;
  if (discount > 0) params.discount_amount = discount;

  const res = await call("doc/create", params);
  return normalizeResult(res, DOC_TYPES.INVOICE);
};

/**
 * חשבונית זיכוי — ביטול חשבונית שהופקה.
 *
 * based_on מקשר את הזיכוי לחשבונית המקורית ב-iCount. בלעדיו נוצר זיכוי
 * "מרחף" שרואה החשבון צריך להתאים ידנית.
 *
 * @param {object} p
 * @param {string} p.customerId
 * @param {string} p.originalDocNum - מספר החשבונית שמזוכה
 * @param {Array}  p.items          - מה מזוכה. ברוב המקרים כל שורות המקור
 * @param {string} [p.reason]
 */
const createCreditNote = async ({
  customerId,
  originalDocNum,
  items,
  reason,
  emailDocument = false,
}) => {
  if (!items?.length) throw new IcountError("אי אפשר להפיק חשבונית זיכוי בלי שורות");
  if (!originalDocNum) {
    throw new IcountError("חשבונית זיכוי חייבת להצביע על מספר החשבונית המקורית");
  }

  const params = {
    ...(await baseDoc(customerId, { emailDocument })),
    doctype: DOC_TYPES.CREDIT,
    items: toIcountItems(items),
    // הקישור לחשבונית המקורית
    based_on: [{ doctype: DOC_TYPES.INVOICE, docnum: originalDocNum }],
    description: reason
      ? `זיכוי בגין חשבונית ${originalDocNum} — ${reason}`
      : `זיכוי בגין חשבונית ${originalDocNum}`,
  };

  const res = await call("doc/create", params);
  return normalizeResult(res, DOC_TYPES.CREDIT);
};

// אמצעי התשלום כפי ש-iCount מצפה לקבל אותם
const PAYMENT_TYPES = {
  cash: 1,
  check: 2,
  creditcard: 3,
  transfer: 4,
};

/**
 * קבלה — נרשמת כשהתשלום נכנס בפועל, לפי תנאי השוטף של הלקוח.
 *
 * @param {object} p
 * @param {string} p.customerId
 * @param {number} p.amount            - הסכום שהתקבל, כולל מע"מ
 * @param {string} p.method            - cash | check | creditcard | transfer
 * @param {string[]} [p.forInvoices]   - מספרי החשבוניות שהתשלום סוגר
 * @param {object} [p.details]         - פרטי הצ'ק/העברה: bank, branch, account, checkNum, date
 */
const createReceipt = async ({
  customerId,
  amount,
  method = "transfer",
  forInvoices = [],
  details = {},
  emailDocument = false,
}) => {
  if (!(amount > 0)) throw new IcountError("סכום הקבלה חייב להיות חיובי");

  const paymentType = PAYMENT_TYPES[method];
  if (!paymentType) {
    throw new IcountError(
      `אמצעי תשלום לא מוכר: "${method}". אפשרויות: ${Object.keys(PAYMENT_TYPES).join(", ")}`
    );
  }

  const payment = { payment_type: paymentType, payment_sum: amount };

  if (method === "check") {
    payment.cheque_num = details.checkNum;
    payment.cheque_bank = details.bank;
    payment.cheque_branch = details.branch;
    payment.cheque_account = details.account;
    payment.cheque_date = details.date;
  }
  if (method === "transfer") {
    payment.transfer_bank = details.bank;
    payment.transfer_branch = details.branch;
    payment.transfer_account = details.account;
  }

  const params = {
    // קבלה אינה נושאת מע"מ (has_vat=false ב-doc/types) — הסכום שנרשם בה
    // הוא הסכום שהתקבל בפועל, כולל המע"מ שכבר חויב בחשבונית.
    client_id: await ensureClientId(customerId),
    currency_code: "ILS",
    lang: "he",
    email_document: emailDocument ? 1 : 0,
    doctype: DOC_TYPES.RECEIPT,
    payments: [payment],
  };

  if (forInvoices.length) {
    params.based_on = forInvoices.map((docnum) => ({
      doctype: DOC_TYPES.INVOICE,
      docnum,
    }));
    params.description = `תשלום בגין חשבוניות ${forInvoices.join(", ")}`;
  }

  const res = await call("doc/create", params);
  return normalizeResult(res, DOC_TYPES.RECEIPT);
};

/**
 * שליפת מסמך קיים — לתצוגה באדמין ולאימות אחרי הפקה.
 */
const getDocument = async (doctype, docNum) => {
  const res = await call("doc/info", { doctype, docnum: docNum });
  return res.doc_info || res;
};

module.exports = {
  DOC_TYPES,
  PAYMENT_TYPES,
  createInvoice,
  createCreditNote,
  createReceipt,
  getDocument,
  toIcountItems,
};

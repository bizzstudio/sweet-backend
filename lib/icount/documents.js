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
const { ensureClientForDocument, isDeliverableEmail } = require("./clients");
const { isDemoMode } = require("./mode");

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

// כל מסמך מס נשלח ללקוח במייל ברגע ההפקה — אוטומטית בסוף חודש, ידנית
// באמצע חודש, או מיידית ללקוח perDelivery. זו הגדרת הלקוחה מ-17/08/26.
//
// כיבוי גורף: BILLING_EMAIL_DOCUMENTS=false ב-.env, בלי שינוי קוד. רק "false"
// מפורש מכבה — ערך חסר לא אמור להשתיק בשקט שליחה שהתבקשה.
const autoEmailEnabled = () =>
  String(process.env.BILLING_EMAIL_DOCUMENTS ?? "true").toLowerCase() !== "false";

/**
 * בסיס משותף לכל מסמך: לקוח, שפה, מטבע והחלטת השליחה במייל.
 *
 * מע"מ אינו כאן בכוונה — הוא רלוונטי למסמכים עם שורות ולא לקבלה, ופרמטר
 * מיותר שנשלח למסמך שלא מכיר אותו הוא הימור על התנהגות של צד שלישי.
 *
 * @param {boolean} [emailDocument] - כפייה מפורשת. undefined = לפי המדיניות
 * @returns {Promise<{params: object, emailedTo: string|null}>}
 */
const baseDoc = async (customerId, emailDocument) => {
  const { clientId, email } = await ensureClientForDocument(customerId);

  // מצב דמו לא שולח, נקודה. לא המדיניות ולא כפייה מפורשת של קורא כלשהו
  // גוברות על זה: מסמך שנוצר בחשבון הדמו שנשלח ללקוח אמיתי הוא חשבונית
  // שהוא יראה ולא ימצא בספרים, וזה טלפון שאי אפשר לתקן.
  //
  // ההחלטה יושבת כאן ולא אצל הקוראים כי כאן היא נקודה אחת. סגירת החודש
  // בדמו לא מעבירה emailDocument בכלל — היא נופלת על ברירת המחדל, ולכן
  // בדיקה בצד הקורא הייתה מפספסת בדיוק את המסלול שהכי חשוב להגן עליו.
  const wantEmail = isDemoMode() ? false : (emailDocument ?? autoEmailEnabled());
  // כתובת סינתטית מהייבוא (erp-N@import.local) או כתובת פגומה — לא שולחים.
  // iCount היה מדווח על שליחה מוצלחת והמסמך היה נעלם, ואיש לא היה יודע
  // שהלקוח לא קיבל את החשבונית שלו.
  const emailedTo = wantEmail && isDeliverableEmail(email) ? email : null;

  if (wantEmail && !emailedTo) {
    console.warn(
      `[billing] ללקוח ${customerId} אין כתובת מייל שאפשר לשלוח אליה ` +
        `(${email || "ריק"}) — המסמך יופק אך לא יישלח`
    );
  }

  return {
    params: {
      client_id: clientId,
      currency_code: "ILS",
      lang: "he",
      // iCount שולח לכתובת שרשומה בכרטיס הלקוח שלו. ensureClientForDocument
      // כבר דאג שהיא מעודכנת לפני השורה הזו.
      email_document: emailedTo ? 1 : 0,
    },
    emailedTo,
  };
};

// המחירים שאנחנו שולחים אינם כוללים מע"מ — iCount יוסיף אותו.
// (ההפך היה גורם לו לחלץ מע"מ אחורה ולהקטין את ההכנסה ב-15.25%)
// רק למסמכים עם שורות: חשבונית וזיכוי.
const VAT_ON_TOP = { price_includes_vat: 0 };

/**
 * נרמול תשובת iCount למבנה אחיד. השדות שלהם משתנים מעט בין סוגי מסמכים,
 * ואין סיבה שכל קורא יתמודד עם זה.
 *
 * emailedTo הוא הכתובת שאליה נשלח המסמך, או null אם לא נשלח — הקוראים
 * מדווחים עליו כדי שלקוח בלי מייל תקין לא ייעלם בשקט.
 */
const normalizeResult = (res, doctype, emailedTo = null) => ({
  doctype,
  docNum: String(res.docnum ?? res.doc_number ?? ""),
  docId: res.doc_id ? String(res.doc_id) : undefined,
  url: res.doc_url || res.pdf_link || undefined,
  total: res.doc_total ?? undefined,
  emailedTo,
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
 * @param {boolean} [p.emailDocument] - undefined = לפי המדיניות (שליחה)
 */
const createInvoice = async ({
  customerId,
  items,
  description,
  discount = 0,
  emailDocument,
}) => {
  if (!items?.length) throw new IcountError("אי אפשר להפיק חשבונית בלי שורות");

  const { params: base, emailedTo } = await baseDoc(customerId, emailDocument);
  const params = {
    ...base,
    ...VAT_ON_TOP,
    doctype: DOC_TYPES.INVOICE,
    items: toIcountItems(items),
  };

  if (description) params.description = description;
  if (discount > 0) params.discount_amount = discount;

  const res = await call("doc/create", params);
  return normalizeResult(res, DOC_TYPES.INVOICE, emailedTo);
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
  emailDocument,
}) => {
  if (!items?.length) throw new IcountError("אי אפשר להפיק חשבונית זיכוי בלי שורות");
  if (!originalDocNum) {
    throw new IcountError("חשבונית זיכוי חייבת להצביע על מספר החשבונית המקורית");
  }

  const { params: base, emailedTo } = await baseDoc(customerId, emailDocument);
  const params = {
    ...base,
    ...VAT_ON_TOP,
    doctype: DOC_TYPES.CREDIT,
    items: toIcountItems(items),
    // הקישור לחשבונית המקורית
    based_on: [{ doctype: DOC_TYPES.INVOICE, docnum: originalDocNum }],
    description: reason
      ? `זיכוי בגין חשבונית ${originalDocNum} — ${reason}`
      : `זיכוי בגין חשבונית ${originalDocNum}`,
  };

  const res = await call("doc/create", params);
  return normalizeResult(res, DOC_TYPES.CREDIT, emailedTo);
};

// אמצעי התשלום, כפי ש-iCount באמת מצפה לקבל אותם.
//
// זה לא מערך payments עם payment_type ו-payment_sum. ה-API מצפה לבלוק
// נפרד לכל אמצעי, בשם משלו, ברמה העליונה של הבקשה. הגרסה הקודמת שלחה
// payments:[{payment_type, payment_sum}], ו-iCount ענה "יש לבחור אמצעי
// תשלום אחד לפחות · סכום ששולם: 0" — כלומר בלע את המערך בשקט וייצר
// קבלה על 0. אומת מול ה-API ב-18/08/26, כולל קריאה חוזרת ב-doc/info.
//
// שמות תת-השדות אומתו באותה דרך: מה שחזר ב-doc/info הוא מה שנקלט.
// בצ'ק השדה הוא number ולא num.
const dropEmpty = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""));

const PAYMENT_BLOCKS = {
  cash: (sum) => ({ cash: { sum } }),

  transfer: (sum, d) => ({
    banktransfer: dropEmpty({
      sum,
      bank: d.bank,
      branch: d.branch,
      account: d.account,
      date: d.date,
    }),
  }),

  check: (sum, d) => ({
    cheques: [
      dropEmpty({
        sum,
        number: d.checkNum,
        bank: d.bank,
        branch: d.branch,
        account: d.account,
        date: d.date,
      }),
    ],
  }),

  creditcard: (sum, d) => ({
    cc: dropEmpty({
      sum,
      card_type: d.cardType,
      card_number: d.cardNumber,
      exp_month: d.expMonth,
      exp_year: d.expYear,
      confirmation_code: d.confirmationCode,
    }),
  }),
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
  emailDocument,
}) => {
  if (!(amount > 0)) throw new IcountError("סכום הקבלה חייב להיות חיובי");

  const buildPayment = PAYMENT_BLOCKS[method];
  if (!buildPayment) {
    throw new IcountError(
      `אמצעי תשלום לא מוכר: "${method}". אפשרויות: ${Object.keys(PAYMENT_BLOCKS).join(", ")}`
    );
  }

  const { params: base, emailedTo } = await baseDoc(customerId, emailDocument);

  // הקבלה חייבת שורה, למרות שהיא "רק" תיעוד של כסף שנכנס: doc/types מחזיר
  // has_items=true עבור receipt, ובלי שורה iCount דוחה את המסמך —
  // "missing_items". אומת מול שני החשבונות ב-18/08/26.
  //
  // שורה אחת בסכום המלא, ולא שורה לכל חשבונית: הקבלה מתעדת תקבול אחד,
  // ופיצול שלו לשורות היה יוצר מסמך שנראה כאילו שולמו סכומים נפרדים.
  // הפירוט של אילו חשבוניות נסגרו יושב ב-based_on ובתיאור.
  const label = forInvoices.length
    ? `תשלום בגין חשבוניות ${forInvoices.join(", ")}`
    : "תשלום על חשבון";

  const params = {
    ...base,
    // קבלה אינה נושאת מע"מ (has_vat=false ב-doc/types) — הסכום שנרשם בה
    // הוא הסכום שהתקבל בפועל, כולל המע"מ שכבר חויב בחשבונית. ולכן גם
    // price_includes_vat אינו נשלח כאן: הפרמטרים של הקבלה זהים למה שנשלח
    // לפני הוספת השליחה במייל, פרט ל-email_document עצמו.
    doctype: DOC_TYPES.RECEIPT,
    items: [{ description: label, quantity: 1, unitprice: amount }],
    ...buildPayment(amount, details),
  };

  if (forInvoices.length) {
    params.based_on = forInvoices.map((docnum) => ({
      doctype: DOC_TYPES.INVOICE,
      docnum,
    }));
    params.description = label;
  }

  const res = await call("doc/create", params);
  return normalizeResult(res, DOC_TYPES.RECEIPT, emailedTo);
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
  PAYMENT_BLOCKS,
  createInvoice,
  createCreditNote,
  createReceipt,
  getDocument,
  toIcountItems,
  // המסכים צריכים להציג את מצב ברירת המחדל של השליחה במייל. תיבת סימון
  // שמנחשת "כן" בזמן שהמדיניות כבויה הייתה מדליקה שליחה שמישהו כיבה בכוונה.
  autoEmailEnabled,
};

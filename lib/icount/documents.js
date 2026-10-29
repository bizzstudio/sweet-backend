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
    // הברקוד שלנו (מנוע) מודפס על המסמך ומאפשר ללקוח להצליב מול תעודת
    // המשלוח. עד 30/08/26 נשלח כאן המק"ט, אבל ההצלבה בעסק נעשית לפי
    // הברקוד — הוא מה שמופיע על התעודה ועל המדף — ולכן הוא קודם.
    // המק"ט נשאר כגיבוי למוצר שאין לו ברקוד בקטלוג.
    //
    // שם השדה הוא sku ולא catalog_num — אומת מול doc/info ב-13/08/26,
    // כששלחנו catalog_num והשדה חזר ריק.
    sku: item.barcode || item.sku || undefined,
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
  const { clientId, email, details = {} } = await ensureClientForDocument(customerId);
  const clientAddress = [details.address, details.contactLine].filter(Boolean).join(", ");

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
      // הכתובת, איש הקשר והטלפון — בתיבת "לכבוד" שבראש המסמך (בקשת הלקוחה,
      // 19/10/2026). iCount לא מעתיק אותם מהכרטיס למסמך, ולמסמך אין שדה
      // טלפון או איש קשר; client_address הוא השדה היחיד שמודפס שם, בשורה
      // אחת אחרי "כתובת:" (שבירת שורה מודפסת כפסיק). אומת בדמו, חשבונית 2015
      ...(clientAddress ? { client_address: clientAddress } : {}),
    },
    emailedTo,
  };
};

/**
 * שליחת מסמך שכבר הופק במייל, דרך doc/email.
 *
 * עד 29/10/2026 נשלח ב-doc/create הפרמטר email_document, ש-iCount אינו
 * מכיר (השם שלו הוא send_email) — ולקוחות לא קיבלו את החשבוניות, בזמן
 * שאצלנו נרשם שנשלחו. doc/email מחזיר email_status לכל כתובת, ולכן
 * emailedTo נרשם רק אחרי ש-iCount ענה על השליחה.
 *
 * לעולם לא זורק: המסמך כבר קיים בספרים, וזריקה כאן הייתה משאירה את
 * התעודות בלי סימון החשבונית — ואז הרצה חוזרת מחייבת פעמיים.
 *
 * @returns {Promise<{emailedTo: string|null, emailError: string|null}>}
 */
const sendByEmail = async (doctype, docNum, address) => {
  if (!address) return { emailedTo: null, emailError: null };
  try {
    const res = await call("doc/email", {
      doctype,
      docnum: docNum,
      email_to: address,
      // ללקוח הולך המקור, לא העתק
      orig: true,
    });
    // מבנה הערך שבתוך email_status אינו מתועד. כל מה שאינו false או
    // הודעת שגיאה נחשב שליחה, והערך הגולמי נרשם בלוג לבדיקה.
    const status = res?.email_status?.[address];
    console.log(
      `[billing] ${doctype} ${docNum} → ${address} · email_status: ${JSON.stringify(res?.email_status ?? null)}`
    );
    if (status === false || /error|fail|invalid|שגיא/i.test(JSON.stringify(status ?? ""))) {
      return { emailedTo: null, emailError: `iCount דיווח: ${JSON.stringify(status)}` };
    }
    return { emailedTo: address, emailError: null };
  } catch (err) {
    console.error(`[billing] ⚠️ ${doctype} ${docNum} הופק אך השליחה ל-${address} נכשלה: ${err.message}`);
    return { emailedTo: null, emailError: err.message };
  }
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
const normalizeResult = (res, doctype, { emailedTo = null, emailError = null } = {}) => ({
  doctype,
  docNum: String(res.docnum ?? res.doc_number ?? ""),
  docId: res.doc_id ? String(res.doc_id) : undefined,
  url: res.doc_url || res.pdf_link || undefined,
  total: res.doc_total ?? undefined,
  emailedTo,
  emailError,
  raw: res,
});

/** doc/create ואחריו השליחה במייל — מה שכל שלושת סוגי המסמכים עושים */
const createAndSend = async (params, doctype, emailTo) => {
  const res = await call("doc/create", params);
  const docNum = String(res.docnum ?? res.doc_number ?? "");
  return normalizeResult(res, doctype, await sendByEmail(doctype, docNum, emailTo));
};

/**
 * חשבונית מס.
 *
 * @param {object} p
 * @param {string} p.customerId
 * @param {Array}  p.items        - שורות בפורמט של DeliveryNote.items
 * @param {string} [p.description] - טקסט חופשי. נשלח כ-hwc ומודפס מתחת לסיכום
 *        ולא בראש המסמך: השדה description שנשלח עד 19/10/2026 נבלע בשקט —
 *        לא נשמר ב-doc/info ולא הודפס (אומת בדמו, חשבוניות 2013–2014)
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

  if (description) params.hwc = description;
  // השם הוא discount (help/methods/doc/create). עד 29/10/2026 נשלח כאן
  // discount_amount, ש-iCount בלע בשקט — כל חשבונית יצאה בלי ההנחה
  // (נתגלה בחשבונית 2170: 8,292.22 במקום 7,628.85)
  if (discount > 0) params.discount = discount;

  return createAndSend(params, DOC_TYPES.INVOICE, emailedTo);
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
 * @param {string} [p.description]  - הטקסט החופשי (hwc), במקום זה שנבנה מ-reason
 * @param {boolean} [p.unlinked]    - זיכוי שאינו מקושר לחשבונית (תעודת זיכוי
 *        על סחורה שעוד לא חויבה, או זיכוי כללי). חייב להישלח במפורש:
 *        ביטול חשבונית בלי based_on הוא טעות ולא ברירת מחדל
 */
const createCreditNote = async ({
  customerId,
  originalDocNum,
  items,
  reason,
  description,
  discount = 0,
  emailDocument,
  unlinked = false,
}) => {
  if (!items?.length) throw new IcountError("אי אפשר להפיק חשבונית זיכוי בלי שורות");
  if (!originalDocNum && !unlinked) {
    throw new IcountError("חשבונית זיכוי חייבת להצביע על מספר החשבונית המקורית");
  }

  const { params: base, emailedTo } = await baseDoc(customerId, emailDocument);
  const params = {
    ...base,
    ...VAT_ON_TOP,
    doctype: DOC_TYPES.CREDIT,
    items: toIcountItems(items),
    hwc:
      description ||
      (reason
        ? `זיכוי בגין חשבונית ${originalDocNum} — ${reason}`
        : `זיכוי בגין חשבונית ${originalDocNum}`),
  };

  // הקישור לחשבונית המקורית
  if (originalDocNum) {
    params.based_on = [{ doctype: DOC_TYPES.INVOICE, docnum: originalDocNum }];
  }

  // ההנחה חייבת להופיע גם בזיכוי. בלעדיה הזיכוי גדול מהחשבונית שהוא
  // מבטל, והלקוח מקבל בחזרה יותר ממה שחויב.
  if (discount > 0) params.discount = discount;

  return createAndSend(params, DOC_TYPES.CREDIT, emailedTo);
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
    params.hwc = label;
  }

  return createAndSend(params, DOC_TYPES.RECEIPT, emailedTo);
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
  sendByEmail,
  toIcountItems,
  // המסכים צריכים להציג את מצב ברירת המחדל של השליחה במייל. תיבת סימון
  // שמנחשת "כן" בזמן שהמדיניות כבויה הייתה מדליקה שליחה שמישהו כיבה בכוונה.
  autoEmailEnabled,
};

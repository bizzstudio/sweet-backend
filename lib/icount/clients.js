// lib/icount/clients.js
//
// סנכרון כרטיסי הלקוחות שלנו אל iCount. אי אפשר להפיק מסמך ללקוח שאינו
// קיים שם, ולכן זה התנאי המקדים לכל השאר.
//
// מפתח ההתאמה הוא custom_client_id = erp.customerNumber (מספר הלקוח בהנהח"ש).
// למה דווקא הוא:
//
//   - הוא קיים אצל כל 769 הלקוחות, ייחודי, ולא משתנה.
//   - הוא כבר המפתח שבו משתמש יבוא האקסל, ולכן שתי המערכות מדברות באותה שפה.
//   - התאמה לפי שם הייתה נשברת על רווח כפול או על "בע\"מ" מול "בעמ";
//     התאמה לפי ח.פ הייתה מפספסת את 159 הלקוחות שאין להם.
//
// המשמעות: הסנכרון idempotent. הרצה שנייה מעדכנת את מה שכבר קיים במקום
// ליצור כפילויות — וזה קריטי, כי לקוח כפול ב-iCount מפצל את הכרטסת שלו.

const { call, IcountError } = require("./client");
const { isDemoMode } = require("./mode");
const Customer = require("../../models/Customer");

// מיפוי לקוח → client_id בחשבון הדמו, בזיכרון התהליך בלבד.
//
// billing.icountClientId במסד שייך לחשבון האמיתי. אותו מספר בחשבון הדמו
// הוא לקוח אחר לגמרי (או לא קיים) — כתיבה שלו למסד הייתה שולחת חשבונית
// אמיתית ללקוח הלא נכון ברגע שחוזרים ל-live. לכן הזיכרון, שמת בריסטארט:
// המחיר הוא חיפוש אחד נוסף מול iCount, וזה זול לעומת מה שהוא מונע.
//
// הערך הוא {clientId, email} ולא מזהה בלבד: המייל שנרשם בכרטיס נשמר לצדו
// כדי שגם בדמו נדע אם צריך לרענן את הכרטיס, בלי להישען על
// billing.icountSyncedEmail שמתאר את החשבון האמיתי.
const demoClientIds = new Map();

// כתובת החיוב של הלקוח, לפי סדר עדיפות:
//
//   billing.invoiceEmail — כתובת ההנהלת חשבונות, כשהוגדרה במפורש. גוברת,
//                          כי לקוח יכול להיכנס לחנות בכתובת אחת ולרצות
//                          שהחשבוניות יגיעו לרואה החשבון.
//   email                — כתובת הכניסה לחנות, ברירת המחדל.
//   erp.rawEmail         — מה שהגיע מהאקסל של ההנהח"ש, גיבוי אחרון ללקוח
//                          שנוצר בייבוא ומעולם לא נכנס לחנות.
const billingEmailOf = (customer) =>
  String(
    customer?.billing?.invoiceEmail || customer?.email || customer?.erp?.rawEmail || ""
  ).trim();

// לקוחות שהגיעו מהייבוא בלי מייל קיבלו כתובת סינתטית (erp-N@import.local),
// כי השדה חובה במסד. היא נראית ככתובת תקינה אבל אין מאחוריה תיבה: חשבונית
// שתישלח אליה תיעלם בשקט. הבדיקה חוסמת אותה, ואת כל מה שאינו כתובת בכלל.
const PLACEHOLDER_EMAIL_DOMAIN = /@import\.local$/i;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const isDeliverableEmail = (email) =>
  Boolean(email) && EMAIL_SHAPE.test(email) && !PLACEHOLDER_EMAIL_DOMAIN.test(email);

/**
 * המרת לקוח שלנו למבנה של iCount.
 *
 * ה-ERP הוא מקור האמת לפרטי החיוב (כתובת, ח.פ, איש קשר) ולא פרטי החנות:
 * הכתובת בחנות היא כתובת המשלוח שהלקוח הזין, וזו לא בהכרח הכתובת שצריכה
 * להופיע על חשבונית.
 */
const toIcountClient = (customer) => {
  const erp = customer.erp || {};
  const address = customer.address || {};

  const payload = {
    // מפתח ההתאמה — חייב להישלח בכל עדכון, אחרת iCount ייצור כרטיס חדש
    custom_client_id: erp.customerNumber,

    client_name: (customer.name || "").trim(),
    // ח.פ / ע.מ / ת.ז. iCount מוותר עליו, אבל בלעדיו לא ניתן להפיק
    // חשבונית מס תקינה ללקוח עסקי.
    vat_id: erp.idNumber || "",

    // דרך billingEmailOf ולא ישירות: מה שנשלח לכרטיס חייב להיות בדיוק מה
    // שנשמר ב-icountSyncedEmail ומושווה בהפקה הבאה. חישוב שני, שונה ולו
    // ברווח מוביל, היה מזהה "שינוי" בכל מסמך ודוחף עדכון כרטיס מיותר לנצח.
    email: billingEmailOf(customer),
    home_phone: erp.landline || customer.phone || "",
    mobile: erp.mobile || customer.phone || "",

    home_street: erp.rawAddress || address.street || "",
    home_city: erp.rawCity || address.city?.city_name_he || "",
    home_zip: address.postalCode || "",
    home_country: "IL",

    contactperson: erp.contactPerson || "",
  };

  // שם משפחה קיים רק אצל לקוחות פרטיים; אצל עסקים הוא ריק והשם המלא
  // כבר יושב ב-name.
  if (customer.lastName) {
    payload.client_name = `${payload.client_name} ${customer.lastName}`.trim();
  }

  // erp.notes מגיע מהאקסל ולפעמים מכיל הערות פנימיות. נשלח רק אם יש בו משהו,
  // כדי לא לדרוס הערות שנרשמו ידנית ב-iCount בערך ריק.
  if (erp.notes) payload.notes = erp.notes;

  // הנחה קבועה שסוכמה עם הלקוח — נשמרת בכרטיס כדי שגם הפקה ידנית ב-iCount
  // תיקח אותה בחשבון ולא רק ההפקה האוטומטית שלנו.
  if (erp.discountPercent > 0) payload.ptor_percent = erp.discountPercent;

  return payload;
};

/**
 * איתור לקוח קיים ב-iCount לפי מספר הלקוח בהנהח"ש.
 * מחזיר client_id או null.
 */
const findClientId = async (customerNumber) => {
  try {
    const res = await call("client/info", { custom_client_id: customerNumber });
    return res.client_info?.client_id || res.client_id || null;
  } catch (err) {
    // "לא נמצא" היא תשובה לגיטימית ולא תקלה — הלקוח פשוט טרם סונכרן
    if (err instanceof IcountError && /not_found|no_such_client|client_not_found/.test(err.reason || "")) {
      return null;
    }
    throw err;
  }
};

/**
 * יוצר או מעדכן לקוח ב-iCount, ושומר את ה-client_id אצלנו.
 *
 * @param {object} customer - מסמך Customer (חייב לכלול erp — כלומר נשלף עם select('+erp'))
 * @returns {Promise<{clientId: string, action: 'created'|'updated'}>}
 */
const syncCustomer = async (customer) => {
  const customerNumber = customer.erp?.customerNumber;
  if (!customerNumber) {
    throw new IcountError(
      `ללקוח "${customer.name}" אין מספר לקוח בהנהח"ש — אי אפשר לסנכרן ל-iCount`
    );
  }
  if (!customer.name?.trim()) {
    throw new IcountError(`ללקוח ${customerNumber} אין שם — iCount ידחה את הכרטיס`);
  }

  const demo = isDemoMode();
  const payload = toIcountClient(customer);
  const cachedId = demo
    ? demoClientIds.get(String(customer._id))?.clientId
    : customer.billing?.icountClientId;
  const existingId = cachedId || (await findClientId(customerNumber));

  let clientId;
  let action;

  if (existingId) {
    await call("client/update", { ...payload, client_id: existingId });
    clientId = existingId;
    action = "updated";
  } else {
    const res = await call("client/create", payload);
    clientId = res.client_id;
    action = "created";
  }

  if (demo) {
    demoClientIds.set(String(customer._id), { clientId: String(clientId), email: payload.email || "" });
  } else {
    // כתיבה ממוקדת ולא customer.save(): המסמך נשלף עם select('+erp') ושמירה
    // מלאה שלו הייתה מסכנת שדות אחרים בכתיבה מקבילה מזרימת ההזמנות.
    await Customer.updateOne(
      { _id: customer._id },
      {
        $set: {
          "billing.icountClientId": String(clientId),
          "billing.icountSyncedAt": new Date(),
          // מה שבאמת נרשם בכרטיס — זו הכתובת שאליה iCount ישלח את המסמכים
          "billing.icountSyncedEmail": payload.email || "",
        },
      }
    );
  }

  return { clientId: String(clientId), action, demo };
};

/**
 * מחזיר את ה-client_id של לקוח ואת הכתובת שרשומה בכרטיס שלו ב-iCount.
 * זו הפונקציה שהפקת המסמכים קוראת — היא לא צריכה לדעת אם הלקוח כבר קיים.
 *
 * @returns {Promise<{clientId: string, email: string}>} email — הכתובת שהיא
 *          *מאומתת* ככתובת שבכרטיס. מחרוזת ריקה פירושה "לא ידוע מה בכרטיס",
 *          ומי שקורא לא ישלח מסמך במייל במצב הזה.
 */
const ensureClientForDocument = async (customerId) => {
  const customer = await Customer.findById(customerId).select("+erp").lean();
  if (!customer) throw new IcountError(`לקוח ${customerId} לא נמצא במערכת`);

  const email = billingEmailOf(customer);
  const demo = isDemoMode();

  // במצב דמו ה-id השמור שייך לחשבון אחר ואסור להשתמש בו
  const cached = demo
    ? demoClientIds.get(String(customer._id))
    : customer.billing?.icountClientId
      ? {
          clientId: customer.billing.icountClientId,
          email: customer.billing.icountSyncedEmail || "",
        }
      : null;

  // כרטיס מסונכרן אינו נדחף שוב — חוץ ממקרה אחד: המייל השתנה אצלנו.
  // iCount שולח את המסמך לכתובת שבכרטיס שלו, ולכן תיקון מייל במערכת חייב
  // להגיע לשם *לפני* ההפקה; אחרת החשבונית נשלחת לכתובת הישנה והלקוח לא
  // מקבל דבר. לקוח שסונכרן לפני שהשדה הזה נוסף ייכנס לעדכון אחד ויחיד.
  if (cached && cached.email === email) return { clientId: cached.clientId, email };

  // אין client_id כלל — בלי סנכרון אין למי להפיק, וכשלון כאן חייב לעצור.
  if (!cached) {
    const { clientId } = await syncCustomer(customer);
    return { clientId, email };
  }

  // יש client_id ורק רענון הכרטיס נכשל. חוסם את *השליחה* ולא את ההפקה:
  // ביטול החשבונית בגלל כשלון רשת בעדכון כרטיס היה משאיר לקוח בלי חיוב
  // בסגירת חודש שרצה בלילה, ושליחה בכל זאת הייתה שולחת לכתובת הישנה.
  try {
    const { clientId } = await syncCustomer(customer);
    return { clientId, email };
  } catch (err) {
    console.error(
      `[billing] עדכון כרטיס הלקוח ב-iCount נכשל (${customer.name}): ${err.message}\n` +
        `          המסמך יופק לפי הכרטיס הקיים ולא יישלח במייל — הכתובת שם עלולה להיות ישנה.`
    );
    return { clientId: cached.clientId, email: "" };
  }
};

/** גרסה מקוצרת למי שצריך רק את המזהה. */
const ensureClientId = async (customerId) =>
  (await ensureClientForDocument(customerId)).clientId;

module.exports = {
  syncCustomer,
  ensureClientId,
  ensureClientForDocument,
  findClientId,
  toIcountClient,
  billingEmailOf,
  isDeliverableEmail,
};

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
const Customer = require("../../models/Customer");

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

    email: customer.email || erp.rawEmail || "",
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

  const payload = toIcountClient(customer);
  const existingId = customer.billing?.icountClientId || (await findClientId(customerNumber));

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

  // כתיבה ממוקדת ולא customer.save(): המסמך נשלף עם select('+erp') ושמירה
  // מלאה שלו הייתה מסכנת שדות אחרים בכתיבה מקבילה מזרימת ההזמנות.
  await Customer.updateOne(
    { _id: customer._id },
    {
      $set: {
        "billing.icountClientId": String(clientId),
        "billing.icountSyncedAt": new Date(),
      },
    }
  );

  return { clientId: String(clientId), action };
};

/**
 * מחזיר את ה-client_id של לקוח, ומסנכרן אותו אם צריך.
 * זו הפונקציה שהפקת המסמכים קוראת — היא לא צריכה לדעת אם הלקוח כבר קיים.
 */
const ensureClientId = async (customerId) => {
  const customer = await Customer.findById(customerId).select("+erp").lean();
  if (!customer) throw new IcountError(`לקוח ${customerId} לא נמצא במערכת`);

  if (customer.billing?.icountClientId) return customer.billing.icountClientId;

  const { clientId } = await syncCustomer(customer);
  return clientId;
};

module.exports = { syncCustomer, ensureClientId, findClientId, toIcountClient };

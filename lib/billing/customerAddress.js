// lib/billing/customerAddress.js
//
// כתובת הלקוח, כפי שהיא מודפסת על תעודת משלוח ותעודת זיכוי.
//
// לכתובת יש שני מקורות בכרטיס: erp.rawAddress / erp.rawCity מגיעים רק מיבוא
// אקסל ההנהח"ש, ו-address.street / address.city הוא מה שנשמר בכפתור "הוספת
// לקוח" ובעריכת הכרטיס. עד 06/10/2026 התעודה קראה רק את הראשון, ולכן לקוח
// שנפתח ידנית בפאנל (ולא עבר עדיין יבוא) יצא עם שם בלבד, בלי כתובת.
//
// סדר העדיפות: הערך מהיבוא, אחריו הכתובת שעל ההזמנה (לשם המשלוח יוצא
// בפועל), ורק בסוף הכרטיס. שני הראשונים הם ההתנהגות שהייתה — הכרטיס נוסף
// רק כמוצא אחרון, כדי שתעודה שכבר יצאה נכון לא תשתנה.

const Customer = require("../../models/Customer");

const clean = (v) => (v == null ? "" : String(v).trim());

/**
 * @param {object} customer - חייב לכלול erp (‏select("+erp"))
 * @param {object} [order] - ההזמנה שממנה הופקה התעודה, אם יש
 */
const addressOf = (customer, order) => {
  const erp = customer?.erp || {};
  const card = customer?.address || {};
  const shipped = order?.user_info?.address || {};

  return {
    address:
      clean(erp.rawAddress) || clean(shipped.street) || clean(card.street) || undefined,
    city:
      clean(erp.rawCity) ||
      clean(shipped.city?.city_name_he) ||
      clean(card.city?.city_name_he) ||
      undefined,
  };
};

/**
 * משלים כתובת למסמך שהופק בלעדיה. מסמך שכבר יש בו כתובת או עיר — חוזר כמו
 * שהוא, בלי פנייה למסד. נכשל בשקט: מסמך בלי כתובת עדיף על מסמך שלא נפתח.
 */
const withCustomerAddress = async (doc) => {
  const snap = doc?.customerSnapshot || {};
  if (!doc || snap.address || snap.city || !doc.customer) return doc;
  try {
    const customer = await Customer.findById(doc.customer).select("+erp address").lean();
    const { address, city } = addressOf(customer);
    if (!address && !city) return doc;
    return { ...doc, customerSnapshot: { ...snap, address, city } };
  } catch (err) {
    console.error(`[billing] השלמת כתובת הלקוח נכשלה: ${err.message}`);
    return doc;
  }
};

module.exports = { addressOf, withCustomerAddress };

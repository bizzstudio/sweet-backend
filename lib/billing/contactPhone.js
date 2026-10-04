// lib/billing/contactPhone.js
//
// הטלפון של איש הקשר, כפי שהוא מודפס על תעודת משלוח והצעת מחיר.
//
// בקשת הלקוחה (04/10/2026): ליד "איש קשר" צריך להופיע גם מספר הטלפון שלו,
// כדי שהנהג או המשרד יוכלו להתקשר בלי לחפש את הכרטיס.
//
// סדר העדיפות: הנייד מיבוא ההנהח"ש, אחריו הקווי, ורק בסוף customer.phone —
// השדה ההוא הוא טלפון ההרשמה לחנות, והוא לא תמיד של איש הקשר.
//
// המספר נשמר על המסמך (customerSnapshot.contactPhone) ברגע ההפקה, כמו שאר
// פרטי הלקוח: מסמך שהודפס חייב להיראות אותו דבר גם אחרי שהכרטיס השתנה.
// מסמכים שהופקו לפני שהשדה נוסף מושלמים בזמן הקריאה (withContactPhone),
// בלי לכתוב למסד — הם כבר יצאו ללקוח, ואין סיבה לגעת בהם.

const Customer = require("../../models/Customer");

// הייבוא מהאקסל רק מקצץ רווחים (toImportText), ולכן תא כמו "0" או "-" מגיע
// כמו שהוא. ערך עם פחות מ-7 ספרות אינו מספר טלפון — מדלגים עליו למקור הבא,
// במקום להדפיס "טלפון: 0" על מסמך שיוצא ללקוח.
const MIN_PHONE_DIGITS = 7;

const clean = (v) => {
  const text = v == null ? "" : String(v).trim();
  return text.replace(/\D/g, "").length >= MIN_PHONE_DIGITS ? text : "";
};

/** @param {object} customer - חייב לכלול erp (‏select("+erp")) */
const contactPhoneOf = (customer) => {
  const erp = customer?.erp || {};
  return clean(erp.mobile) || clean(erp.landline) || clean(customer?.phone) || undefined;
};

/**
 * משלים contactPhone למסמך ישן שאין בו. מסמך שכבר יש בו — חוזר כמו שהוא,
 * בלי פנייה למסד. נכשל בשקט: מסמך בלי טלפון עדיף על מסמך שלא נפתח.
 */
const withContactPhone = async (doc) => {
  if (!doc || doc.customerSnapshot?.contactPhone || !doc.customer) return doc;
  try {
    const customer = await Customer.findById(doc.customer).select("+erp phone").lean();
    const contactPhone = contactPhoneOf(customer);
    if (!contactPhone) return doc;
    return { ...doc, customerSnapshot: { ...(doc.customerSnapshot || {}), contactPhone } };
  } catch (err) {
    console.error(`[billing] השלמת טלפון איש קשר נכשלה: ${err.message}`);
    return doc;
  }
};

module.exports = { contactPhoneOf, withContactPhone };

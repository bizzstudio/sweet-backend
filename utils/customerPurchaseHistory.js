// utils/customerPurchaseHistory.js
//
// שליפת פרופיל הרכישות של לקוח לצינור הקליטה.
//
// מופרד מ-utils/purchaseHistoryRanking במכוון: שם יושבים **כללי ההכרעה**, והם
// חייבים להישאר פונקציה טהורה שאפשר לבדוק בלי מסד ובלי שעון (ראה
// script/test-purchase-history.js). כאן יושבת הגישה למסד, וזה כל מה שיש כאן.

const CustomerPurchaseHistory = require("../models/CustomerPurchaseHistory");
const { buildPurchaseProfile } = require("./purchaseHistoryRanking");

/**
 * פרופיל הרכישות של הלקוח, או null כשאין לו היסטוריה.
 *
 * ‏null ולא פרופיל ריק: `null` הוא "אין אות", וזה בדיוק מה ש-pickFromHistory
 * מצפה לקבל. פרופיל ריק היה מחייב כל קורא לבדוק `size` בעצמו.
 *
 * @param {string|ObjectId|null} customerId
 * @returns {Promise<null|{byProduct: Map, bySku: Map, size: number}>}
 */
const getCustomerPurchaseProfile = async (customerId) => {
  if (!customerId) return null;

  const doc = await CustomerPurchaseHistory.findOne({ customer: customerId })
    .select("+items")
    .lean();

  if (!doc?.items?.length) return null;

  const profile = buildPurchaseProfile(doc.items);
  return profile.size > 0 ? profile : null;
};

module.exports = { getCustomerPurchaseProfile };

// lib/orders/lineAmount.js
//
// סכום שורת עגלה — אותה סכימה בדיוק שבה נסכמת עגלה בקליטה
// (lib/order-ingestion/createOrder). קובץ נפרד כדי שגם עריכת פריטים וגם פיצול
// האחזקה (lib/order-ingestion/disposablesSplit) ישתמשו בה בלי require מעגלי:
// editItems דורש את createOrder, ו-createOrder דורש את disposablesSplit.
const lineAmount = (item) => {
  const quantity = Number(item.quantity) || 0;
  // מתנת הצטרפות ומוצר חינם מקופון אינם מחויבים — בדיוק כמו בצ'קאאוט
  // (controller/customerOrderController). בלי השורה הזו עריכה של הזמנה
  // שיש בה מוצר חינם הייתה מחייבת עליו
  if (item.isWelcomeGift || item.isCouponFreeProduct) return 0;
  if (item.isRewardProduct) return (Number(item.rewardPrice) || 0) * quantity;
  if (item.discountedPrice) return Number(item.discountedPrice) || 0;
  return (Number(item.prices?.price ?? item.price) || 0) * quantity;
};

module.exports = { lineAmount };

// lib/billing/pricing.js
//
// קביעת המחיר של מוצר ללקוח מסוים.
//
// סדר העדיפויות:
//
//   1. מחירון הלקוח (CustomerPriceList) — מחיר שסוכם איתו ספציפית
//   2. מחיר הקטלוג (products.prices.price) — מחיר המחירון הרגיל
//
// כל המחירים ללא מע"מ. המע"מ מתווסף רק בהפקת המסמך ב-iCount.
//
// ⚠️ מצב הנתונים נכון ל-13/08/26: מחירוני הלקוחות מכסים חציון של 55 מוצרים
//    לכל לקוח מתוך קטלוג של 4,320, ולכן רוב השורות נופלות לשלב 2 — ושם
//    יושבים כרגע מחירים שנוצרו אוטומטית משמות המוצרים, לא מחירי אמת.
//
//    לכן כל תוצאה נושאת שדה `source`, ו-`priceQuality()` מסכם כמה מהשורות
//    מתומחרות ממקור אמין. המסכים משתמשים בזה כדי להזהיר לפני הפקת מסמך.
//    ברגע שיועלה מחירון בסיס אמיתי, האזהרה נעלמת מעצמה.

const CustomerPriceList = require("../../models/CustomerPriceList");
const Product = require("../../models/Product");

const SOURCES = {
  CUSTOMER_LIST: "customerPriceList",
  CATALOG: "catalog",
  MISSING: "missing",
};

/**
 * טוען את מחירון הלקוח פעם אחת ומחזיר מפה מק"ט→מחיר.
 * מחזיר מפה ריקה אם אין ללקוח מחירון.
 */
const loadCustomerPrices = async (customerId) => {
  const list = await CustomerPriceList.findOne({ customer: customerId })
    .select("items")
    .lean();

  const map = new Map();
  for (const item of list?.items || []) {
    // מחיר 0 במחירון אינו "בחינם" אלא שורה ריקה מהיבוא. שורה כזו צריכה
    // ליפול למחיר הקטלוג ולא לחייב את הלקוח ב-0.
    if (item.sku && item.price > 0) map.set(String(item.sku), item.price);
  }
  return map;
};

/**
 * מתמחר רשימת פריטים ללקוח.
 *
 * @param {string} customerId
 * @param {Array<{sku: string, quantity: number}>} items
 * @returns {Promise<Array>} שורות עם unitPrice, lineTotal, source
 */
const priceItemsForCustomer = async (customerId, items) => {
  const customerPrices = await loadCustomerPrices(customerId);

  const skus = items.map((i) => String(i.sku)).filter(Boolean);
  const products = await Product.find({ sku: { $in: skus } })
    .select("sku title prices isVatFree category")
    .lean();

  const bySku = new Map(products.map((p) => [String(p.sku), p]));

  return items.map((item) => {
    const sku = String(item.sku);
    const product = bySku.get(sku);
    const quantity = Number(item.quantity) || 0;

    let unitPrice = null;
    let source = SOURCES.MISSING;

    if (customerPrices.has(sku)) {
      unitPrice = customerPrices.get(sku);
      source = SOURCES.CUSTOMER_LIST;
    } else if (product?.prices?.price > 0) {
      unitPrice = product.prices.price;
      source = SOURCES.CATALOG;
    }

    return {
      sku,
      productId: product?._id,
      name: item.name || product?.title?.he || product?.title?.en || sku,
      quantity,
      unitPrice: unitPrice ?? 0,
      lineTotal: Number(((unitPrice ?? 0) * quantity).toFixed(2)),
      isVatFree: Boolean(product?.isVatFree),
      category: product?.category,
      source,
      // מוצר שלא נמצא בקטלוג כלל — נשמר במפורש כדי שהמסך יוכל להתריע
      // במקום להציג שורה במחיר 0 בשקט
      unknownProduct: !product,
    };
  });
};

/**
 * סיכום איכות התמחור של רשימת שורות.
 * המסכים משתמשים בזה כדי להחליט אם להציג אזהרה לפני הפקת מסמך.
 */
const priceQuality = (pricedItems) => {
  const total = pricedItems.length;
  const counts = { customerPriceList: 0, catalog: 0, missing: 0 };
  for (const item of pricedItems) counts[item.source]++;

  return {
    total,
    ...counts,
    // כמה מהשורות מתומחרות ממקור שסוכם עם הלקוח
    reliableRatio: total ? counts.customerPriceList / total : 0,
    hasMissing: counts.missing > 0,
  };
};

module.exports = { priceItemsForCustomer, priceQuality, loadCustomerPrices, SOURCES };

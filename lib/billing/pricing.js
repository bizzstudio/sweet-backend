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

const mongoose = require("mongoose");
const CustomerPriceList = require("../../models/CustomerPriceList");
const Product = require("../../models/Product");
const Customer = require("../../models/Customer");
const { barcodeOf } = require("../../utils/barcode");

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
    // erp.barcode ולא barcode: השדה ברמה העליונה משמש לסדר התצוגה בחנות
    // והוא ריק בכל 4,320 המוצרים. הברקוד שמודפס על המסמכים הוא זה שהגיע
    // מהאקסל של מנוע (ראה utils/barcode.js).
    .select("sku title prices isVatFree category erp.barcode")
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
      // דרך barcodeOf ולא ישירות מהשדה: הוא זה שקובע מה נחשב ברקוד
      // (ומסנן את ערכי הזבל מהייבוא), ושני כללים היו מייצרים ברקוד
      // שמודפס על המסמך ואי אפשר לחפש לפיו
      barcode: barcodeOf(product),
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
 * אחוז ההנחה הקבוע של הלקוח.
 *
 * סדר העדיפויות:
 *
 *   1. billing.discountPercent — מה שהוגדר בכרטיס הלקוח אצלנו
 *   2. erp.discountPercent     — מה שהגיע באקסל של מנוע
 *
 * 0 מפורש בשלב 1 עוצר: הוא אומר "בלי הנחה", ונפילה ממנו לייבוא הייתה
 * מחזירה בשקט הנחה שמישהו ביטל במפורש.
 *
 * מקבל מסמך לקוח שכבר נטען (חוסך שאילתה) או מזהה.
 *
 * ⚠️ הזיהוי אינו לפי typeof: ObjectId הוא "object" בדיוק כמו מסמך, ובדיקה
 *    כזו הייתה מחזירה 0 בשקט לכל קורא שמעביר מזהה — כלומר הנחה שנעלמת
 *    במסלול אחד ועובדת באחר. הזיהוי הוא לפי השדות שאנחנו באמת קוראים.
 *
 * @param {string|ObjectId|object} customerOrId
 * @returns {Promise<number>} אחוז בין 0 ל-100
 */
/**
 * האם הערך הוא מסמך לקוח שאפשר לענות ממנו — ולא רק מזהה.
 *
 * שתי מלכודות שנבדקות כאן במפורש:
 *
 *   1. ObjectId הוא typeof "object" בדיוק כמו מסמך. בדיקה לפי typeof
 *      בלבד הייתה מחזירה 0 בשקט לכל קורא שמעביר מזהה.
 *   2. מסמך שנשלף בלי ‎+erp (השדה הוא select:false) נראה כמו מסמך תקין
 *      אבל חסר בו בדיוק המקור השני של ההנחה. תשובה ממנו הייתה 0 ללקוח
 *      שיש לו 5% בייבוא — כלומר הנחה שנעלמת לפי איך שנשלף הלקוח.
 *
 * לכן מסמך נחשב מספיק רק כשאפשר להכריע ממנו: או ש-erp קיים בו, או
 * ש-billing.discountPercent הוא מספר (ואז ה-erp כלל לא נדרש). בכל מקרה
 * אחר חוזרים למסד — שאילתה אחת, ובלבד שהתשובה נכונה.
 */
const isCustomerDoc = (value) => {
  if (!value || typeof value !== "object") return false;
  // ObjectId ו-Buffer נראים כמו אובייקט אבל אינם מסמך
  if (value._bsontype !== undefined) return false;

  if ("erp" in value) return true;
  return Number.isFinite(Number(value.billing?.discountPercent));
};

const discountPercentFor = async (customerOrId) => {
  if (!customerOrId) return 0;

  let customer = null;
  if (isCustomerDoc(customerOrId)) {
    customer = customerOrId;
  } else {
    const id = String(customerOrId?._id || customerOrId);
    // מזהה פגום לא מפיל את ההפקה. הפונקציה הזו נקראת מתוך יצירת תעודה
    // וסנכרון הזמנה, ו-CastError שנזרק מכאן היה עוצר משלוח בגלל שדה
    // שהתשובה הנכונה עליו היא פשוט "בלי הנחה".
    if (!mongoose.Types.ObjectId.isValid(id)) return 0;
    customer = await Customer.findById(id)
      .select("+erp billing.discountPercent")
      .lean();
  }

  if (!customer) return 0;

  const own = customer.billing?.discountPercent;
  const raw = own === undefined || own === null ? customer.erp?.discountPercent : own;

  const pct = Number(raw);
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  // אחוז מעל 100 באקסל הוא שגיאת הקלדה, ולא "הסחורה בחינם ועוד נשלם ללקוח"
  return Math.min(pct, 100);
};

/**
 * סכום ההנחה בשקלים על בסיס נתון.
 *
 * מעוגל לאגורות ומוגבל לבסיס עצמו: הנחה שגדולה מהמסמך הופכת אותו לזיכוי
 * מוסווה, וזיכוי מוציאים במסלול שלו (creditInvoice) עם מסמך מס משלו.
 */
const discountAmount = (base, percent) => {
  const pct = Number(percent) || 0;
  const amount = (Number(base) || 0) * (pct / 100);
  if (!(amount > 0)) return 0;
  return Number(Math.min(amount, Number(base) || 0).toFixed(2));
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

module.exports = {
  priceItemsForCustomer,
  priceQuality,
  loadCustomerPrices,
  discountPercentFor,
  discountAmount,
  SOURCES,
};

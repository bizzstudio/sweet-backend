// lib/orders/duplicateOrder.js
//
// "הזמנה חוזרת" — יצירת הזמנה חדשה מהעתק של הזמנה קיימת, מהפאנל.
//
// הצורך: לקוח מזמין שוב את אותה רשימה. עד היום הדרך היחידה הייתה להקליד
// אותה מחדש, שורה־שורה, במסך עריכת הפריטים.
//
// ── מה מועתק ומה לא, ולמה ──
//
//   מחירי השורות מועתקים כמות שהם ולא מחושבים מחדש מהקטלוג.
//   זו אותה החלטה שכבר נלקחה ב-lib/orders/editItems: שורה קיימת שומרת את
//   המחיר שנקבע לה, ורק שורה חדשה מתומחרת מהקטלוג/מהמחירון. מחירי הקטלוג
//   כאן אינם מקור אמת מלא (חלקם מחירי ברירת מחדל), ותמחור מחדש היה משנה
//   בשקט את הסכום של הזמנה שכבר הייתה נכונה. במקום זה — כל פער בין המחיר
//   שהועתק למחיר הנוכחי מדווח חזרה (‏priceChanges) ונרשם בהערת המערכת.
//
//   שורות המנוע (מוצר פרס, מתנת ברוכים הבאים, מוצר חינם מקופון) *אינן*
//   מועתקות: הן נגזרות ולא מוזמנות. מוצרי פרס נוצרים מחדש כאן ע"י אותו מנוע
//   מבצעים, ומתנה חד־פעמית פשוט אינה חוזרת.
//
//   הקופון אינו מועתק (‏discount=0, coupon=null): קוד קופון אינו ניתן למימוש
//   חוזר, והעתקתו הייתה מייצרת הנחה שאיש לא אישר.
//
//   דמי המשלוח מועתקים כמות שהם. הם נגזרו מהיעד של אותו לקוח, וחישוב מחדש
//   דורש את מסמך היעד ואת סף המשלוח החינם — שניהם עשויים להיות שונים היום.
//   הסכום ניתן לתיקון במסך עריכת הפריטים.
//
// ההזמנה החדשה נכנסת בסטטוס "טופלה" (‏Processing) — בדיוק כמו הזמנה שנקלטת
// ממייל או מווצאפ. משם היא מקבלת תעודת משלוח אוטומטית (דרך logStatusChange)
// והמלאי יורד. במכוון *לא* נשלח מייל אישור ללקוח: את ההזמנה יצר עובד בפאנל
// ולא הלקוח, ואישור שהלקוח לא ביקש הוא הודעה מטעה.

const mongoose = require("mongoose");
const Order = require("../../models/Order");
const Status = require("../../models/Status");
const Product = require("../../models/Product");
const Customer = require("../../models/Customer");
const logStatusChange = require("../../utils/logStatusChange");
const { handleProductQuantity } = require("../stock-controller/others");
const {
  buildCartItem,
  fetchEligibleOffers,
  saveOrder,
} = require("../order-ingestion/createOrder");
const { getCustomerPriceMap, priceForProduct } = require("../../utils/customerPriceList");
const { findOptimalOfferCombination } = require("../../utils/offerCalculations");

/** שגיאה עם סטטוס HTTP משלה, במקום 500 גורף. */
class OrderDuplicateError extends Error {
  constructor(message, { status = 400, code } = {}) {
    super(message);
    this.name = "OrderDuplicateError";
    this.status = status;
    this.code = code;
  }
}

const round2 = (n) => Number((Number(n) || 0).toFixed(2));
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());

/** שורה שהמנוע יצר ולא הוזמנה — אינה מועתקת (ראה הערת הפתיחה). */
const isEngineLine = (line) =>
  Boolean(line?.isRewardProduct || line?.isWelcomeGift || line?.isCouponFreeProduct);

/** אותה סכימה בדיוק שבה נסכמת עגלה בקליטה ובעריכה. */
const lineAmount = (item) => {
  const quantity = Number(item.quantity) || 0;
  if (item.isWelcomeGift || item.isCouponFreeProduct) return 0;
  if (item.isRewardProduct) return (Number(item.rewardPrice) || 0) * quantity;
  if (item.discountedPrice) return Number(item.discountedPrice) || 0;
  return (Number(item.prices?.price ?? item.price) || 0) * quantity;
};

// שם להצגה. ‏title הוא אובייקט רב-לשוני ברוב השורות ומחרוזת בישנות; החזרת
// האובייקט עצמו הייתה מדפיסה "[object Object]" בהערת המערכת ובמסך.
const productName = (line) => {
  const title = line?.title;
  const candidates = [
    title?.he,
    title?.en,
    typeof title === "string" ? title : null,
    typeof line?.name === "string" ? line.name : null,
    str(line?.sku),
  ];
  return candidates.find((c) => str(c)) || "פריט";
};

// ── תקרה לרשימות שנכנסות להערת המערכת ──
//
// ‏systemNote מודפס על תעודת הליקוט (ראה lib/order-ingestion/createOrder).
// הזמנה חוזרת של עגלה גדולה יכולה לייצר עשרות שורות דיווח, והן היו הופכות
// את התעודה שהמלקט מחזיק ביד לבלתי קריאה. הפירוט המלא מוצג ממילא במסך
// ברגע היצירה; כאן נשמרת התמצית.
const NOTE_LIST_LIMIT = 8;

const summarizeForNote = (items, format) => {
  const shown = items.slice(0, NOTE_LIST_LIMIT).map(format).join(", ");
  const rest = items.length - NOTE_LIST_LIMIT;
  return rest > 0 ? `${shown} ועוד ${rest}` : shown;
};

/**
 * איתור המוצר של שורה בקטלוג.
 *
 * ‏line._id הוא ה-_id של המוצר (ראה buildCartItem), והוא המפתח הנכון —
 * ‏productId על מסמך המוצר אינו מצביע על כלום (שדה מיובא) ואסור לחפש לפיו.
 * המק"ט הוא נפילה בלבד, להזמנות ישנות שנשמרו בלי מזהה.
 */
const findProducts = async (lines) => {
  const ids = [];
  const skus = [];

  // שני המפתחות נאספים לכל שורה, ולא זה-או-זה. מוצר שנמחק ונוצר מחדש
  // (ייבוא קטלוג, איחוד כפילויות) שומר את המק"ט ומקבל _id חדש — ואיסוף
  // המזהה בלבד היה הופך את הנפילה למק"ט לקוד מת, כי המק"ט לא היה נשאל.
  for (const line of lines) {
    const id = str(line._id) || str(line.id);
    if (id && mongoose.Types.ObjectId.isValid(id)) ids.push(id);
    if (str(line.sku)) skus.push(str(line.sku));
  }

  const or = [];
  if (ids.length) or.push({ _id: { $in: ids } });
  if (skus.length) or.push({ sku: { $in: skus } });
  if (!or.length) return { byId: new Map(), bySku: new Map() };

  const products = await Product.find({ $or: or })
    .select("sku title slug barcode image category prices isVatFree purchaseLimit weight stock status productId isCombination")
    .lean();

  return {
    byId: new Map(products.map((p) => [String(p._id), p])),
    bySku: new Map(products.map((p) => [String(p.sku), p])),
  };
};

/**
 * בניית העגלה החדשה מהעגלה הישנה.
 *
 * @returns {{cart: Array, dropped: Array, priceChanges: Array, stockWarnings: Array}}
 */
const buildCart = async (sourceOrder, priceMap) => {
  const sourceLines = (sourceOrder.cart || []).filter((line) => !isEngineLine(line));
  if (!sourceLines.length) {
    throw new OrderDuplicateError(
      "אין בהזמנה המקורית שורות שניתן להזמין מחדש",
      { code: "no_items" }
    );
  }

  const { byId, bySku } = await findProducts(sourceLines);

  const cart = [];
  const dropped = [];
  const priceChanges = [];
  const stockWarnings = [];
  const seen = new Set();

  for (const line of sourceLines) {
    const id = str(line._id) || str(line.id);
    const product =
      (id && byId.get(id)) || (str(line.sku) && bySku.get(str(line.sku))) || null;

    if (!product) {
      dropped.push({ name: productName(line), reason: "המוצר אינו קיים עוד בקטלוג" });
      continue;
    }

    if (product.status !== "show") {
      dropped.push({ name: productName(line), reason: "המוצר אינו זמין למכירה" });
      continue;
    }

    // ── מוצר עם וריאציות ──
    //
    // כל שכבת בניית ההזמנה בשרת (קליטה אוטומטית, עריכת פריטים) מתייחסת
    // למוצר כיחידה אחת ואינה יודעת לבחור וריאציה. שורה של מוצר כזה הייתה
    // נבנית כאן כמוצר האב: זהות הווריאציה נעלמת, והמלאי היה יורד מהאב
    // במקום מהווריאציה — כלומר סחורה שגויה בליקוט וספירת מלאי שגויה.
    // עדיף לוותר על השורה ולומר זאת, מאשר לשלוח את המוצר הלא נכון.
    if (product.isCombination) {
      dropped.push({
        name: productName(line),
        reason: "מוצר עם וריאציות — יש להוסיף אותו ידנית להזמנה",
      });
      continue;
    }

    // אותו מוצר בשתי שורות בהזמנה המקורית — הכמויות מאוחדות, כדי שהתעודה
    // והחשבונית לא ייצאו עם שתי שורות לאותו מק"ט
    const key = String(product._id);
    const quantity = Number(line.quantity) || 0;
    if (quantity <= 0) {
      dropped.push({ name: productName(line), reason: "כמות לא תקינה בהזמנה המקורית" });
      continue;
    }

    const existing = seen.has(key) ? cart.find((l) => String(l._id) === key) : null;
    if (existing) {
      existing.quantity = Number(existing.quantity) + quantity;
      existing.itemTotal = round2(
        (Number(existing.prices?.price ?? existing.price) || 0) * existing.quantity
      );
      continue;
    }

    const unitPrice = Number(line.prices?.price ?? line.price) || 0;
    if (!(unitPrice > 0)) {
      dropped.push({ name: productName(line), reason: "לשורה המקורית אין מחיר" });
      continue;
    }

    // השורה נבנית מהקטלוג ולא מועתקת כבלוק — כך השם, התמונה, הקטגוריה,
    // הפטור ממע"מ והמשקל הם של המוצר כפי שהוא היום. מההזמנה המקורית נלקחים
    // שני דברים בלבד: הכמות ומחיר היחידה. גם שדות המבצע נופלים כאן מעצמם,
    // כי המנוע מחשב אותם מחדש מיד אחר כך.
    const copy = buildCartItem(product, quantity, undefined, unitPrice);
    // ‏buildCartItem מסמן מחיר שנמסר לו כמחיר מחירון. כאן הוא הועתק מהזמנה
    // קודמת, ולכן הסימון מתוקן — אחרת השורה הייתה טוענת שהיא תומחרה
    // ממחירון הלקוח בעוד שהמחיר עשוי להיות ישן משנה
    copy.priceSource = "reorder";
    copy.catalogPrice = Number(product.prices?.price) || 0;
    copy.itemTotal = round2(unitPrice * quantity);

    // המחיר לא מחושב מחדש (ראה הערת הפתיחה), אבל פער מול המחיר הנוכחי
    // חייב להיות גלוי — אחרת ההזמנה החוזרת יוצאת במחיר של אשתקד בשקט
    const listPrice = priceForProduct(priceMap, product);
    const currentPrice =
      listPrice === null ? Number(product.prices?.price) || 0 : listPrice;
    if (currentPrice > 0 && round2(currentPrice) !== round2(unitPrice)) {
      priceChanges.push({
        name: productName(copy),
        sku: product.sku,
        copiedPrice: round2(unitPrice),
        currentPrice: round2(currentPrice),
      });
    }

    // ── מלאי: מדווח, לא חוסם ──
    //
    // הקליטה האוטומטית חוסמת על מלאי חסר, כי שם הבקשה באה מהלקוח ואי אפשר
    // לאשר לו הזמנה שלא תסופק. כאן ההזמנה נוצרת ביוזמת עובד שיודע מה מגיע
    // למחסן, ומספרי המלאי במערכת אינם מדויקים ממילא (ראה ההערה ב-editItems:
    // מחיקת הזמנה אינה מחזירה מלאי). לכן החוסר מדווח למסך ולהערת המערכת —
    // אבל ההחלטה נשארת אצל מי שלוחץ. ‏stock מסוג null = מלאי בלתי מוגבל.
    if (typeof product.stock === "number" && product.stock < quantity) {
      stockWarnings.push({
        name: productName(copy),
        sku: product.sku,
        requested: quantity,
        inStock: product.stock,
      });
    }

    seen.add(key);
    cart.push(copy);
  }

  if (!cart.length) {
    throw new OrderDuplicateError(
      `אף מוצר מההזמנה המקורית אינו זמין להזמנה חוזרת (${summarizeForNote(
        dropped,
        (d) => `${d.name} — ${d.reason}`
      )})`,
      { code: "all_items_dropped" }
    );
  }

  return { cart, dropped, priceChanges, stockWarnings };
};

/**
 * מזהי המבצעים שנוצלו בעגלה, לצורך מעקב אחר מבצע חד-פעמי (oncePerCustomer).
 *
 * ⚠️ המפתח הוא `offerId` ולא `_id`: זה מה ש-findOptimalOfferCombination
 *    מחזיר על כל רשומה ב-appliedOffers (ראה utils/offerCalculations),
 *    וזו גם הקריאה שמסלול הצ'קאאוט עושה (controller/customerOrderController,
 *    שלב 9). קריאה ל-`_id` הייתה מחזירה מערך ריק תמיד, בשקט.
 */
const collectUsedOfferIds = (cart, appliedOffers = []) => {
  const ids = new Set();

  for (const item of cart) {
    // מוצר פרס נושא את המבצע שיצר אותו
    if (item?.isRewardProduct && item.rewardOfferId) {
      ids.add(String(item.rewardOfferId));
    }
    for (const offer of item?.appliedOffers || []) {
      if (offer?.offerId) ids.add(String(offer.offerId));
    }
  }

  // הנחת סף אינה יושבת על שורה — היא ברמת העגלה
  for (const offer of appliedOffers) {
    if (offer?.type === "THRESHOLD_DISCOUNT" && offer.offerId) {
      ids.add(String(offer.offerId));
    }
  }

  return [...ids];
};

/** חישוב המבצעים הפעילים על העגלה החדשה — אותו מנוע שרץ בקליטה ובעריכה. */
const applyOffers = async (customer, cart) => {
  const offers = await fetchEligibleOffers(customer);
  if (!offers.length) return { cart, thresholdDiscount: 0, appliedOffers: [] };

  const {
    updatedCartItems = cart,
    thresholdDiscount = 0,
    appliedOffers = [],
  } = findOptimalOfferCombination(cart, offers, {}) || {};

  return {
    cart: updatedCartItems,
    thresholdDiscount: Number(thresholdDiscount) || 0,
    appliedOffers,
  };
};

const buildSystemNote = ({ sourceOrder, dropped, priceChanges, stockWarnings, createdBy }) => {
  const stamp = new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });
  const parts = [
    `[הזמנה חוזרת של הזמנה ${sourceOrder.invoice ?? sourceOrder._id} · ${stamp}${createdBy ? ` · ${createdBy}` : ""}]`,
  ];

  if (dropped.length) {
    parts.push(
      `לא הועתקו — ${summarizeForNote(dropped, (d) => `${d.name} (${d.reason})`)}`
    );
  }

  if (priceChanges.length) {
    parts.push(
      `מחיר השתנה מאז (הועתק המחיר המקורי) — ${summarizeForNote(
        priceChanges,
        (p) => `${p.name}: ${p.copiedPrice}₪ → ${p.currentPrice}₪`
      )}`
    );
  }

  if (stockWarnings.length) {
    parts.push(
      `מלאי חסר בעת היצירה — ${summarizeForNote(
        stockWarnings,
        (w) => `${w.name}: הוזמנו ${w.requested}, במלאי ${w.inStock}`
      )}`
    );
  }

  if (Number(sourceOrder.discount) > 0) {
    parts.push(`הנחת הקופון בהזמנה המקורית (${round2(sourceOrder.discount)}₪) לא הועתקה`);
  }

  return parts.join(" | ");
};

/**
 * יצירת הזמנה חוזרת מהזמנה קיימת.
 *
 * @param {string} sourceId - מזהה ההזמנה להעתקה
 * @param {object} [options]
 * @param {string} [options.createdBy] - מי ביצע (מייל המנהל), לתיעוד בהערת המערכת
 * @returns {Promise<{order: object, dropped: Array, priceChanges: Array, stockWarnings: Array}>}
 */
const duplicateOrder = async (sourceId, { createdBy } = {}) => {
  if (!mongoose.Types.ObjectId.isValid(str(sourceId))) {
    throw new OrderDuplicateError("מזהה הזמנה לא תקין", { status: 400 });
  }

  const sourceOrder = await Order.findById(sourceId).lean();
  if (!sourceOrder) {
    throw new OrderDuplicateError("ההזמנה לא נמצאה", { status: 404 });
  }

  const customer = await Customer.findById(sourceOrder.user).lean();
  if (!customer) {
    throw new OrderDuplicateError(
      "הלקוח של ההזמנה המקורית אינו קיים עוד — לא ניתן ליצור עבורו הזמנה",
      { status: 409, code: "no_customer" }
    );
  }

  const processingStatus = await Status.findOne({ name: "Processing" });
  if (!processingStatus) {
    throw new OrderDuplicateError('סטטוס "טופלה" לא נמצא במערכת', {
      status: 500,
      code: "no_status",
    });
  }

  const priceMap = await getCustomerPriceMap(sourceOrder.user);
  const built = await buildCart(sourceOrder, priceMap);
  const { cart, thresholdDiscount, appliedOffers } = await applyOffers(customer, built.cart);

  const subTotal = round2(cart.reduce((sum, item) => sum + lineAmount(item), 0));
  const shippingCost = round2(sourceOrder.shippingCost);
  const offerDiscount = round2(thresholdDiscount);
  const total = round2(subTotal - offerDiscount + shippingCost);

  // הנחת סף שגדולה מסכום השורות משאירה הזמנה בסכום שלילי. זה לא אמור לקרות
  // (המנוע גוזר את ההנחה מהעגלה עצמה), אבל הזמנה בסכום שלילי נכנסת משם
  // לתעודת המשלוח ולחשבונית — ולכן היא נעצרת כאן ולא מתגלה בחיוב.
  if (total < 0) {
    throw new OrderDuplicateError(
      `סכום ההזמנה החוזרת יצא שלילי (${total}₪) — יש לבדוק את המבצעים הפעילים`,
      { status: 409, code: "negative_total" }
    );
  }

  const order = await saveOrder({
    user: sourceOrder.user,
    cart,
    user_info: sourceOrder.user_info,
    subTotal,
    shippingCost,
    discount: 0, // הקופון של ההזמנה המקורית אינו ניתן למימוש חוזר
    offerDiscount,
    total,
    coupon: null,
    shippingOption: sourceOrder.shippingOption,
    paymentMethod: sourceOrder.paymentMethod,
    status: processingStatus._id,
    customer_note: sourceOrder.customer_note,
    systemNote: buildSystemNote({
      sourceOrder,
      dropped: built.dropped,
      priceChanges: built.priceChanges,
      stockWarnings: built.stockWarnings,
      createdBy,
    }),
    callOnArrival: sourceOrder.callOnArrival,
    usedOfferIds: collectUsedOfferIds(cart, appliedOffers),
    shippingRewardEligible: false,
    rewardCouponCode: null,
    source: "duplicate",
  });

  // תופעות הלוואי של הכניסה ל"טופלה" — אותן בדיוק כמו בקליטה אוטומטית:
  // רישום בהיסטוריית הסטטוס, ומשם גם תעודת המשלוח האוטומטית.
  await logStatusChange({
    from: "No Status",
    to: "Processing",
    functionName: `orderDuplicate${createdBy ? `:${createdBy}` : ""}`,
    order,
  });

  // כשל בהורדת מלאי אינו מבטל הזמנה שכבר נשמרה — רושמים וממשיכים,
  // בדיוק כמו בקליטה.
  try {
    await handleProductQuantity(order.cart);
  } catch (stockError) {
    console.error(
      `[duplicate-order] כשל בהורדת מלאי להזמנה ${order.invoice}: ${stockError.message}`
    );
  }

  return {
    order,
    dropped: built.dropped,
    priceChanges: built.priceChanges,
    stockWarnings: built.stockWarnings,
  };
};

module.exports = { duplicateOrder, OrderDuplicateError };

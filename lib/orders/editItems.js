// lib/orders/editItems.js
//
// עריכת שורות ההזמנה מהפאנל.
//
// עד כאן ההזמנה הייתה בלתי ניתנת לשינוי אחרי הקליטה: הפאנל ידע לשנות סטטוס
// בלבד. אבל תעודת המשלוח האוטומטית נגזרת מהעגלה (lib/billing/deliveryNotes),
// והחשבונית החודשית נבנית מהתעודה — ולכן כמות שגויה שנקלטה מהמייל או
// מווצאפ הייתה מגיעה עד לחיוב בלי שום נקודה לתקן אותה בה.
//
// זו הנקודה הזו. היא כותבת לעגלה, והסנכרון לתעודה קורה מעצמו — ה-hook על
// סכימת Order מזהה שינוי ב-cart ומרענן את התעודה כל עוד היא פתוחה.
//
// מה *לא* נעשה כאן, במכוון:
//
//   • מלאי. ההזמנה גורעת מלאי בקליטה, אבל מחיקת הזמנה (deleteOrder) אינה
//     מחזירה אותו, וגם אין מסלול אחר שמיישר אותו. תיקון חד-צדדי כאן היה
//     יוצר עוד מקור אמת למספר שכבר אינו מדויק, ולכן המלאי נשאר באחריות
//     מסך המוצרים.
//   • תאריך/חודש חיוב. התעודה נשארת בחודש שבו הופקה; ראו DELIVERY-NOTES.md.

const mongoose = require("mongoose");
const Order = require("../../models/Order");
const Product = require("../../models/Product");
const Customer = require("../../models/Customer");
const DeliveryNote = require("../../models/DeliveryNote");
const { buildCartItem, fetchEligibleOffers } = require("../order-ingestion/createOrder");
const { getCustomerPriceMap, priceForProduct } = require("../../utils/customerPriceList");
const { findOptimalOfferCombination } = require("../../utils/offerCalculations");

/** שגיאה שהמסלול יודע להחזיר עם סטטוס HTTP משלה, במקום 500 גורף. */
class OrderEditError extends Error {
  constructor(message, { status = 400, ...extra } = {}) {
    super(message);
    this.name = "OrderEditError";
    this.status = status;
    Object.assign(this, extra);
  }
}

// גבולות קלט. הבקשה מגיעה מהפאנל, אבל היא HTTP — ורשימה בגודל לא חסום
// הייתה מייצרת שאילתה ענקית ועגלה שאי אפשר להציג
const MAX_ITEMS = 300;
const MAX_QUANTITY = 100000;

const round2 = (n) => Number((Number(n) || 0).toFixed(2));
// שלוש ספרות: סחורה נשקלת מוזמנת גם ב-0.75 ק"ג, ועיגול לשתיים היה מספיק —
// אבל 1/3 ק"ג נכתב 0.333 ולא צריך להיחתך ל-0.33 כבר בהקלדה
const round3 = (n) => Number((Number(n) || 0).toFixed(3));

const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
/** המזהה של שורת עגלה. line._id הוא ה-_id של המוצר (ראו buildCartItem). */
const lineKey = (line) => str(line?._id) || str(line?.id);

/** שורה שנוצרה על ידי מנוע המבצעים/הקופונים ולא הוזמנה — לא ניתנת לעריכה. */
const isEngineLine = (line) =>
  Boolean(line?.isRewardProduct || line?.isWelcomeGift || line?.isCouponFreeProduct);

/** אותה סכימה בדיוק שבה נסכמת עגלה בקליטה (lib/order-ingestion/createOrder). */
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

const productName = (line) =>
  line?.title?.he || line?.title?.en || line?.title || line?.name || str(line?.sku) || "פריט";

/**
 * מצב התעודה האוטומטית של ההזמנה, כפי שהוא רלוונטי לעריכה.
 *
 * תעודה "נעולה" היא תעודה שהסנכרון לא ייגע בה (ראו syncFromOrder): חויבה,
 * נתפסה לחיוב, בוטלה בידי אדם, או תעודה ישנה בלי שדה סטטוס כלל. עריכה
 * במצב כזה משנה את ההזמנה ומשאירה את התעודה מאחור — ולכן היא נחסמת עד
 * לאישור מפורש.
 */
const inspectNote = async (orderId) => {
  const note = await DeliveryNote.findOne({ order: orderId, kind: { $ne: "manual" } })
    .select("number billing.status billing.cancelledBySync")
    .lean();

  if (!note) return { note: null, locked: false, reason: null };

  const status = note.billing?.status;
  if (status === "open") return { note, locked: false, reason: null };

  // ביטול שנעשה על ידי הסנכרון עצמו (ההזמנה רוקנה) חוזר לפעילה כשהיא
  // מתמלאת שוב, ולכן אינו נעילה
  if (status === "cancelled" && note.billing?.cancelledBySync) {
    return { note, locked: false, reason: null };
  }

  const reason =
    status === "billed"
      ? `תעודה ${note.number} כבר חויבה — עריכת ההזמנה לא תעדכן אותה. תיקון חיוב נעשה בחשבונית זיכוי.`
      : status === "billing"
      ? `תעודה ${note.number} נתפסה כרגע על ידי סגירת חודש. יש להמתין לסיום ההפקה.`
      : status === "cancelled"
      ? `תעודה ${note.number} בוטלה. עריכת ההזמנה לא תחזיר אותה לפעילה.`
      : `תעודה ${note.number} אינה במצב "ממתינה לחיוב" ולא תתעדכן מהעריכה.`;

  return { note, locked: true, reason, status };
};

/**
 * בונה את העגלה החדשה מתוך הבקשה.
 *
 * כל שורה בבקשה מזוהה מול העגלה הקיימת לפי מזהה המוצר, ואם אינה קיימת בה —
 * לפי מק"ט מול הקטלוג. שורה שאינה בבקשה כלל נמחקת מההזמנה; זה הממשק
 * ל"הסרת פריט", ולכן הבקשה חייבת לשאת את *כל* השורות שנשארות.
 */
const buildCart = async (order, requested) => {
  // שורות שמנוע המבצעים/הקופונים יצר נשמרות בנפרד ואינן במפות החיפוש.
  // אילו היו בהן, מוצר שיש לו גם שורת מתנה וגם הזמנה בתשלום היה נבלע
  // לתוך שורת המתנה ונעלם מההזמנה בלי שאיש ישים לב
  const engineIds = new Set();
  const byId = new Map();
  const bySku = new Map();

  for (const line of order.cart || []) {
    const key = lineKey(line);
    if (isEngineLine(line)) {
      if (key) engineIds.add(key);
      continue;
    }
    if (key && !byId.has(key)) byId.set(key, line);
    const sku = str(line.sku);
    if (sku && !bySku.has(sku)) bySku.set(sku, line);
  }

  // שלב א' — זיהוי כל השורות ואימות הכמויות, לפני שנוגעים במסד.
  // הפרדה לשלבים כדי שכל המוצרים החדשים יישלפו בשאילתה אחת ולא אחת לשורה
  const resolved = [];
  const newSkus = new Set();
  const seen = new Set();

  for (const row of requested) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new OrderEditError("שורה לא תקינה בבקשה");
    }

    const rowId = str(row._id);
    const rowSku = str(row.sku);

    const existing = (rowId && byId.get(rowId)) || (rowSku ? bySku.get(rowSku) : null) || null;

    // שורת מנוע שהמסך החזיר כמות שהיא — מחושבת מחדש ולכן מתעלמים ממנה.
    // הבדיקה *אחרי* החיפוש בשורות הרגילות, ולא לפניו: מוצר שיש לו גם שורת
    // מתנה וגם שורה בתשלום נושא את אותו מזהה בשתיהן, ודילוג מוקדם היה
    // מוציא את השורה בתשלום מההזמנה בלי שאיש ביקש
    if (!existing && rowId && engineIds.has(rowId)) continue;

    const quantity = round3(Number(row.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new OrderEditError(
        `כמות לא תקינה עבור ${rowSku || rowId || "שורה"} — חייבת להיות מספר גדול מאפס`
      );
    }
    if (quantity > MAX_QUANTITY) {
      throw new OrderEditError(
        `כמות חריגה עבור ${rowSku || rowId || "שורה"} (${quantity}). המקסימום הוא ${MAX_QUANTITY}`
      );
    }

    const key = existing ? lineKey(existing) || str(existing.sku) : rowSku;
    if (!key) {
      throw new OrderEditError('שורה חדשה חייבת לשאת מק"ט');
    }
    if (seen.has(key)) {
      throw new OrderEditError(
        `${existing ? productName(existing) : `המק"ט ${rowSku}`} מופיע פעמיים ברשימה`
      );
    }
    seen.add(key);

    if (!existing) newSkus.add(rowSku);
    resolved.push({ quantity, existing, sku: rowSku });
  }

  if (!resolved.length) {
    throw new OrderEditError(
      "לא ניתן להשאיר הזמנה בלי פריטים. למחיקת ההזמנה יש להשתמש בכפתור המחיקה."
    );
  }

  // שלב ב' — המוצרים החדשים והמחירון, בשתי שאילתות בסך הכל
  const [products, priceMap] = await Promise.all([
    newSkus.size
      ? Product.find({ sku: { $in: [...newSkus] } })
          .select("sku title slug barcode image category prices isVatFree purchaseLimit weight stock productId")
          .lean()
      : Promise.resolve([]),
    getCustomerPriceMap(order.user),
  ]);
  const productBySku = new Map(products.map((p) => [String(p.sku), p]));

  const cart = [];
  const added = [];
  const changed = [];

  for (const { quantity, existing, sku } of resolved) {
    if (existing) {
      const before = Number(existing.quantity) || 0;
      const unitPrice = Number(existing.prices?.price ?? existing.price) || 0;

      // העתקה ולא שינוי במקום: אם אימות מאוחר יותר ייכשל, ההזמנה שבזיכרון
      // לא תישאר עם חצי עריכה
      const line = { ...existing, quantity, itemTotal: round2(unitPrice * quantity) };

      // שדות המבצע יורדים כאן ומחושבים מחדש מיד אחר כך. השארתם הייתה
      // מותירה על השורה הנחה שחושבה לכמות אחרת
      delete line.discountedPrice;
      delete line.offerTitle;
      delete line.appliedOffers;

      if (quantity !== before) changed.push(`${productName(existing)} ${before}→${quantity}`);
      cart.push(line);
      continue;
    }

    // שורה חדשה — נבנית מהקטלוג, במחיר של הלקוח הזה
    const product = productBySku.get(sku);
    if (!product) {
      throw new OrderEditError(`מק"ט ${sku} אינו קיים בקטלוג`);
    }

    const customerPrice = priceForProduct(priceMap, product);
    const effective = customerPrice === null ? Number(product.prices?.price) || 0 : customerPrice;
    if (!(effective > 0)) {
      throw new OrderEditError(
        `ל${product.title?.he || sku} אין מחיר במחירון הלקוח ולא בקטלוג — לא ניתן להוסיף אותו להזמנה`
      );
    }

    const line = buildCartItem(product, quantity, undefined, customerPrice);
    added.push(`${productName(line)} ×${quantity}`);
    cart.push(line);
  }

  // אותו מוצר בשתי שורות — קורה כששורה קיימת חסרת מק"ט והמסך הוסיף אותה
  // מחדש כשורה חדשה. שתי שורות לאותו מוצר היו מייצרות שתי שורות בתעודה
  // ובחשבונית, ולכן זו שגיאה ולא איחוד שקט
  const idSeen = new Set();
  for (const line of cart) {
    const key = lineKey(line);
    if (!key) continue;
    if (idSeen.has(key)) {
      throw new OrderEditError(
        `${productName(line)} יצא בשתי שורות נפרדות. יש לרענן את המסך ולתקן את הכמות בשורה הקיימת.`
      );
    }
    idSeen.add(key);
  }

  // מה שירד מההזמנה: שורות שהיו בה, אינן שורות מנוע, ולא חזרו בבקשה
  const kept = new Set(cart.map((l) => lineKey(l) || str(l.sku)));
  const removed = (order.cart || [])
    .filter((l) => !isEngineLine(l) && !kept.has(lineKey(l) || str(l.sku)))
    .map((l) => productName(l));

  // שורות שהמנוע יצר ואינן מוצרי פרס (מתנת הצטרפות, מוצר חינם מקופון)
  // נשמרות כמות שהן: הן אינן נגזרות מהמבצעים ולכן החישוב מחדש מפיל אותן
  const preserved = (order.cart || []).filter(
    (l) => l?.isWelcomeGift || l?.isCouponFreeProduct
  );

  return { cart, preserved, added, changed, removed };
};

/**
 * חישוב המבצעים מחדש — אותו מנוע שרץ בקליטת ההזמנה.
 *
 * מוצרי הפרס הישנים אינם נכנסים לקלט (המנוע יוצר אותם מחדש), ובלעדי זה
 * מתנה הייתה מוכפלת בכל עריכה.
 */
const applyOffers = async (order, cart) => {
  const customer = await Customer.findById(order.user).lean();
  const offers = await fetchEligibleOffers(customer);

  // אין מבצעים פעילים (המצב במסד נכון להיום: אפס מבצעים) — אין מה לחשב.
  // המנוע היה מחזיר את אותן שורות בדיוק, אבל עם discountedPrice: null
  // ו-appliedOffers: [] על כל שורה. שדות המבצע כבר הוסרו ב-buildCart,
  // ולכן היציאה כאן זהה בתוצאה ואינה מלכלכת את העגלה
  if (!offers.length) return { cart, thresholdDiscount: 0 };

  const {
    updatedCartItems = cart,
    thresholdDiscount = 0,
  } = findOptimalOfferCombination(cart, offers, {}) || {};

  return { cart: updatedCartItems, thresholdDiscount: Number(thresholdDiscount) || 0 };
};

/**
 * עריכת שורות ההזמנה.
 *
 * @param {string} orderId
 * @param {object} input
 * @param {Array<{_id?: string, sku?: string, quantity: number}>} input.items - כל השורות שנשארות
 * @param {number} [input.shippingCost] - דמי משלוח חדשים; אם לא נשלח, נשארים כשהיו
 * @param {number} [input.discount]     - הנחה חדשה; אם לא נשלחה, נשארת כשהייתה
 * @param {boolean} [input.allowLockedNote] - אישור מפורש לערוך הזמנה שתעודתה נעולה
 * @param {string|Date} [input.expectedUpdatedAt] - updatedAt שהמסך ראה, לנעילה אופטימית
 * @param {string} [input.changedBy]
 */
const editOrderItems = async (orderId, input = {}) => {
  const {
    items,
    shippingCost,
    discount,
    allowLockedNote = false,
    expectedUpdatedAt,
    changedBy,
  } = input;

  if (!Array.isArray(items)) {
    throw new OrderEditError("רשימת הפריטים חסרה");
  }
  if (!items.length) {
    // הזמנה בלי שורות אינה הזמנה, והתעודה שלה תבוטל אוטומטית. מחיקה היא
    // פעולה אחרת, עם הגנות משלה (deleteOrder)
    throw new OrderEditError("לא ניתן להשאיר הזמנה בלי פריטים. למחיקת ההזמנה יש להשתמש בכפתור המחיקה.");
  }
  if (items.length > MAX_ITEMS) {
    throw new OrderEditError(`יותר מדי שורות בבקשה (${items.length}). המקסימום הוא ${MAX_ITEMS}`);
  }

  // מזהה שאינו ObjectId היה זורק CastError ומגיע למשתמש כשגיאת שרת
  if (!mongoose.isValidObjectId(orderId)) {
    throw new OrderEditError("מזהה הזמנה לא תקין", { status: 400 });
  }

  const order = await Order.findById(orderId);
  if (!order) {
    throw new OrderEditError("ההזמנה לא נמצאה", { status: 404 });
  }

  // נעילה אופטימית. שני מנהלים שפתחו את אותה הזמנה היו דורסים זה את זה
  // בשקט — העגלה נכתבת כמערך שלם, ולכן השני היה מוחק את התיקון של הראשון.
  // ‏expectedUpdatedAt מגיע מהמסך; בקשה בלעדיו (סקריפט) אינה נבדקת
  if (expectedUpdatedAt) {
    const expected = new Date(expectedUpdatedAt).getTime();
    const actual = new Date(order.updatedAt).getTime();
    if (!Number.isNaN(expected) && !Number.isNaN(actual) && expected !== actual) {
      throw new OrderEditError(
        "ההזמנה השתנתה מאז שהמסך נטען. יש לרענן את הדף ולבצע את התיקון מחדש.",
        { status: 409, code: "STALE_ORDER" }
      );
    }
  }

  const noteState = await inspectNote(order._id);
  if (noteState.locked && !allowLockedNote) {
    throw new OrderEditError(noteState.reason, {
      status: 409,
      code: "NOTE_LOCKED",
      noteNumber: noteState.note.number,
      noteStatus: noteState.status,
    });
  }

  const built = await buildCart(order, items);
  const { cart: pricedCart, thresholdDiscount } = await applyOffers(order, built.cart);

  const cart = [...pricedCart, ...built.preserved];

  // מוצר פרס שהמנוע כבר אינו מזכה בו (המבצע הסתיים) נעלם מהעגלה. הוא אינו
  // משפיע על החיוב — פרס מחויב ב-rewardPrice — אבל היעלמות שקטה של שורה
  // מהזמנה היא בדיוק מה שאיש לא מבחין בו, ולכן היא נרשמת
  const finalKeys = new Set(cart.map((l) => lineKey(l) || str(l.sku)));
  const lostEngineLines = (order.cart || [])
    .filter((l) => isEngineLine(l) && !finalKeys.has(lineKey(l) || str(l.sku)))
    .map((l) => `${productName(l)} (שורת מבצע)`);
  const removed = [...built.removed, ...lostEngineLines];

  const subTotal = round2(cart.reduce((sum, item) => sum + lineAmount(item), 0));

  const nextShipping =
    shippingCost === undefined || shippingCost === null || shippingCost === ""
      ? Number(order.shippingCost) || 0
      : Number(shippingCost);
  if (!Number.isFinite(nextShipping) || nextShipping < 0) {
    throw new OrderEditError("דמי משלוח חייבים להיות מספר שאינו שלילי");
  }

  const nextDiscount =
    discount === undefined || discount === null || discount === ""
      ? Number(order.discount) || 0
      : Number(discount);
  if (!Number.isFinite(nextDiscount) || nextDiscount < 0) {
    throw new OrderEditError("הנחה חייבת להיות מספר שאינו שלילי");
  }
  if (nextDiscount > subTotal) {
    throw new OrderEditError(
      `ההנחה (${round2(nextDiscount)}₪) גדולה מסכום השורות (${subTotal}₪). זיכוי מוציאים בחשבונית זיכוי.`
    );
  }

  const total = round2(subTotal - nextDiscount - thresholdDiscount + nextShipping);
  if (total < 0) {
    throw new OrderEditError("סכום ההזמנה יצא שלילי — יש לבדוק את ההנחה ואת דמי המשלוח");
  }

  order.cart = cart;
  // cart מוגדר בסכימה כמערך של Mixed, ומונגוס אינו מזהה בו שינוי לבד.
  // בלי זה השמירה הייתה עוברת בשקט בלי לכתוב כלום — וגם ה-hook שמסנכרן
  // את התעודה לא היה נורה
  order.markModified("cart");
  order.subTotal = subTotal;
  order.shippingCost = round2(nextShipping);
  order.discount = round2(nextDiscount);
  order.offerDiscount = round2(thresholdDiscount);
  order.total = total;

  const summary = [
    built.added.length ? `נוספו: ${built.added.join(", ")}` : null,
    built.changed.length ? `כמויות: ${built.changed.join(", ")}` : null,
    removed.length ? `הוסרו: ${removed.join(", ")}` : null,
  ].filter(Boolean);

  if (summary.length) {
    const stamp = new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });
    const entry = `[עריכת פריטים ${stamp}${changedBy ? ` · ${changedBy}` : ""}] ${summary.join(" | ")}`;
    // systemNote ולא customer_note: זו רשומה פנימית, ו-customer_note מצוטט
    // ללקוח במייל האישור ובהערות החשבונית
    order.systemNote = order.systemNote ? `${order.systemNote}\n${entry}` : entry;
  }

  try {
    await order.save();
  } catch (err) {
    // ‏save מריץ ולידציה על המסמך כולו, ולא רק על מה שנגענו בו. הזמנה
    // היסטורית שחסר בה שדה שהפך לחובה הייתה מחזירה 500 סתום; כאן היא
    // מחזירה את השדה החסר, כדי שאפשר יהיה להשלים אותו
    if (err.name === "ValidationError") {
      const fields = Object.keys(err.errors || {}).join(", ");
      throw new OrderEditError(
        `שמירת ההזמנה נכשלה באימות${fields ? ` (${fields})` : ""}: ${err.message}`,
        { status: 422, code: "ORDER_INVALID" }
      );
    }
    throw err;
  }

  // ה-hook שעל הסכימה מפעיל את אותו סנכרון בעצמו, אבל בלי await — ולכן
  // התשובה לפאנל הייתה יוצאת לפני שהתעודה התעדכנה, והמסך היה מציג אותה
  // ישנה. הקריאה כאן ממתינה; הריצה השנייה מוצאת תוכן זהה ואינה כותבת.
  let noteResult = null;
  try {
    noteResult = await require("../billing/deliveryNotes").syncFromOrder(order._id, {
      changedBy: changedBy || "עריכת פריטים בפאנל",
    });
  } catch (err) {
    console.error(`[order-edit] סנכרון התעודה להזמנה ${order.invoice} נכשל: ${err.message}`);
  }

  return {
    order,
    changes: { added: built.added, changed: built.changed, removed },
    totals: { subTotal, discount: order.discount, offerDiscount: order.offerDiscount, shippingCost: order.shippingCost, total },
    note: noteResult?.note
      ? {
          number: noteResult.note.number,
          status: noteResult.note.billing?.status,
          updated: Boolean(noteResult.changed),
          reason: noteResult.reason,
        }
      : null,
  };
};

module.exports = { editOrderItems, OrderEditError };

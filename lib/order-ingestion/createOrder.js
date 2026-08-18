// lib/order-ingestion/createOrder.js
//
// יצירת הזמנה מהודעה שנקלטה. שני מסלולים, ליבה אחת:
//
//   createOrderFromParsed() — ההודעה נקראה במלואה. ההזמנה נכנסת ל"טופלה",
//                             המלאי יורד, והצוות והלקוח מקבלים התראת מייל.
//
//   createErrorOrder()      — ההודעה לא נקראה במלואה. ההזמנה נכנסת בכל זאת,
//                             עם מה שכן נקרא, בסטטוס "שגיאה בקריאה". המלאי
//                             *לא* יורד, ללקוח *לא* נשלח מייל, וההזמנה אינה
//                             נכנסת לדוחות ולאפליקציית המלקטים.
//
// הדרך לסגור הזמנת שגיאה היא לתקן את הסיבה (למשל להוסיף מוצר לקטלוג) וללחוץ
// "נסה שוב" — הריצה החוזרת מוחקת את הזמנת השגיאה ויוצרת הזמנה נקייה במקומה.
//
// מחירים, מבצעים ודמי משלוח מחושבים בשרת מול ה-DB בשני המסלולים — בדיוק כמו
// ב-addOrder. שום מחיר לא מגיע מההודעה של הלקוח ולא מה-LLM.
//
// המחיר עצמו נלקח מהמחירון הפרטי של הלקוח כשיש לו כזה, ואחרת ממחיר הקטלוג
// (ראה utils/customerPriceList.js).

const Order = require("../../models/Order");
const Status = require("../../models/Status");
const Offer = require("../../models/Offer");
const Setting = require("../../models/Setting");
const Product = require("../../models/Product");
const logStatusChange = require("../../utils/logStatusChange");
const { nextFreeInvoice } = require("../../utils/invoiceNumber");
const { handleProductQuantity } = require("../stock-controller/others");
const { sendOrderNotificationEmail } = require("../email-sender/sender");
const { findOptimalOfferCombination } = require("../../utils/offerCalculations");
const {
  ensureIngestionErrorStatus,
  INGESTION_ERROR_STATUS_HE,
} = require("../../utils/ingestionStatus");
const {
  getCustomerPriceMap,
  priceForProduct,
} = require("../../utils/customerPriceList");
const { isSyntheticEmail } = require("./resolvers");

// ‏prices מגיע פעם כמסמך מונגו ופעם כאובייקט רגיל (‏lean). פרישה של מסמך מונגו
// הייתה מעתיקה את השדות הפנימיים שלו במקום את הערכים, ולכן ההמרה מפורשת.
const plainPrices = (prices) => {
  if (!prices) return {};
  return typeof prices.toObject === "function" ? prices.toObject() : { ...prices };
};

/**
 * בניית פריט עגלה בדיוק במבנה שהחנות שולחת.
 *
 * המבנה נקבע ע"י react-use-cart בצד החנות (id/quantity/price/itemTotal) ונקרא
 * ע"י החשבוניות בדשבורד (components/invoice/*) ובאפליקציית המלקטים. חריגה
 * מהמבנה הזה שוברת תצוגה, ולכן הוא משוחזר כאן במלואו.
 *
 * @param {number|null} customerPrice - המחיר מהמחירון הפרטי של הלקוח, או null
 *        כשהמוצר אינו במחירון שלו (ואז נלקח מחיר הקטלוג).
 */
const buildCartItem = (product, quantity, note, customerPrice = null) => {
  const catalogPrice = product.prices?.price || 0;
  const price = customerPrice === null ? catalogPrice : customerPrice;

  // ── המחיר נדרס גם בתוך prices, ולא רק בשדה price ──
  //
  // חישוב המבצעים (utils/offerCalculations) והחשבונית קוראים את
  // `item.prices.price`, ולא את `item.price`. דריסה של אחד מהם בלבד הייתה
  // מייצרת הזמנה שסכום השורות בה אינו מה שחושב למבצעים.
  //
  // ‏originalPrice נדרס גם הוא: הוא המחיר ה"לפני" בתצוגות, ומחיר מחירון אינו
  // הנחה מהקטלוג — השארתו הייתה מציירת ללקוח הנחה שלא קיימת.
  const prices = plainPrices(product.prices);
  if (customerPrice !== null) {
    prices.price = customerPrice;
    prices.originalPrice = customerPrice;
  }

  return {
    _id: product._id,
    id: product._id, // react-use-cart שומר את המזהה גם ב-id
    productId: product.productId,
    title: product.title,
    slug: product.slug,
    sku: product.sku,
    barcode: product.barcode,
    image: product.image,
    category: product.category,
    prices,
    variant: prices,
    price,
    originalPrice: prices.originalPrice,
    quantity,
    itemTotal: price * quantity,
    stock: product.stock,
    isVatFree: product.isVatFree,
    purchaseLimit: product.purchaseLimit,
    weight: product.weight,
    // מאיפה בא המחיר. נשמר על השורה כדי שאפשר יהיה לראות בהזמנה עצמה שהיא
    // תומחרה לפי מחירון הלקוח, ומה היה מחיר הקטלוג באותו רגע
    priceSource: customerPrice === null ? undefined : "customer-price-list",
    catalogPrice: customerPrice === null ? undefined : catalogPrice,
    // היחידה שהלקוח ביקש ("2 קילו") נשמרת כהערה למלקט — הקטלוג נמכר ביחידות
    // ולכן אין המרה אוטומטית ממשקל לאריזות.
    ingestionNote: note || undefined,
  };
};

/**
 * שליפת המבצעים הפעילים שהלקוח זכאי להם.
 * מיישם את אותם כללים כמו addOrder (שלב 5) כדי שהזמנה מווצאפ תקבל בדיוק
 * את אותם מבצעים כמו אותה הזמנה באתר.
 */
const fetchEligibleOffers = async (customer) => {
  const getNotActiveOffers = process.env.GET_NOT_ACTIVE_OFFERS === "true";

  let offerFilter = {};

  if (!getNotActiveOffers) {
    const now = new Date();
    const offerFilterConditions = [
      { isActive: true },
      {
        $or: [
          { startsAt: { $exists: false } },
          { startsAt: null },
          { startsAt: { $lte: now } },
        ],
      },
      {
        $or: [
          { endsAt: { $exists: false } },
          { endsAt: null },
          { endsAt: { $gte: now } },
        ],
      },
      // מתנת ברוכים הבאים דורשת בחירה מפורשת של הלקוח — לא מוענקת אוטומטית
      { type: { $ne: "WELCOME_GIFT" } },
    ];

    // מבצעים חד-פעמיים שהלקוח כבר ניצל
    if (customer?.redeemedOffers?.length > 0) {
      offerFilterConditions.push({
        $or: [
          { oncePerCustomer: { $ne: true } },
          { oncePerCustomer: false },
          { oncePerCustomer: { $exists: false } },
          { _id: { $nin: customer.redeemedOffers } },
        ],
      });
    }

    offerFilter = { $and: offerFilterConditions };
  }

  let offers = await Offer.find(offerFilter)
    .populate({ path: "products" })
    .populate({ path: "rewardProduct" })
    .populate({ path: "rewardProducts" })
    .populate({ path: "triggerProduct" });

  // מבצעים ללקוחות חדשים בלבד — רק אם החשבון נפתח אחרי תחילת המבצע
  if (customer) {
    offers = offers.filter((offer) => {
      if (offer.forNewCustomersOnly) {
        const offerStartDate = offer.startsAt || offer.createdAt;
        return customer.createdAt >= offerStartDate;
      }
      return true;
    });
  } else {
    offers = offers.filter((offer) => !offer.forNewCustomersOnly);
  }

  return offers;
};

/**
 * חישוב דמי משלוח, כולל משלוח חינם מעל סף (אם מופעל בהגדרות החנות).
 * מחזיר גם את סף המינימום ליעד, כדי שנוכל לחסום הזמנה שמתחתיו.
 */
const calculateShipping = async ({ shippingOption, deliveryDoc, itemsTotal }) => {
  if (shippingOption !== "2" || !deliveryDoc) {
    return { shippingCost: 0, minimumOrder: 0, shippingRewardEligible: false };
  }

  let shippingCost = deliveryDoc.price || 0;

  const storeSetting = await Setting.findOne({ name: "storeSetting" });
  const freeShippingStatus = storeSetting?.setting?.free_shipping_status;
  const freeShippingThreshold = Number(storeSetting?.setting?.free_shipping_threshold);

  if (freeShippingStatus && freeShippingThreshold > 0 && itemsTotal >= freeShippingThreshold) {
    shippingCost = 0;
  }

  const shippingRewardEligible =
    Boolean(freeShippingStatus) && freeShippingThreshold > 0 && shippingCost > 0;

  return {
    shippingCost,
    minimumOrder: Number(deliveryDoc.minimumOrder) || 0,
    shippingRewardEligible,
  };
};

/**
 * בדיקת מלאי מחודשת. ההתאמה קרתה קודם ובינתיים המלאי יכול היה להיגמר.
 * מוצר עם stock מסוג null הוא בלתי מוגבל (אותה סמנטיקה כמו ב-addOrder).
 *
 * מחזירה את המוצרים המעודכנים ואת רשימת הבעיות — ולא זורקת, כדי שהמסלול של
 * הזמנת השגיאה יוכל להשתמש באותה בדיקה בלי להיתפס בחריגה.
 */
const checkStock = async (items) => {
  // אותו דגל שנאכף ב-resolveItems. בלי זה הפריטים היו עוברים את ההתאמה ואז
  // יצירת ההזמנה הייתה נכשלת כאן על אותו מוצר בדיוק — שתי בדיקות שחולקות
  // כלל אחד חייבות לקרוא אותו מאותו מקום.
  const allowHidden = process.env.INGESTION_ALLOW_HIDDEN_PRODUCTS === "true";

  const productIds = items.map((i) => i.product._id);
  const freshProducts = await Product.find({ _id: { $in: productIds } }).lean();
  const freshById = new Map(freshProducts.map((p) => [String(p._id), p]));

  const problems = [];
  for (const item of items) {
    const fresh = freshById.get(String(item.product._id));
    if (!fresh) {
      problems.push(`${item.product.title?.he || item.rawName} (המוצר נמחק)`);
      continue;
    }
    if (fresh.status !== "show" && !allowHidden) {
      problems.push(`${fresh.title?.he || item.rawName} (אינו זמין)`);
      continue;
    }
    if (typeof fresh.stock === "number" && fresh.stock < item.quantity) {
      problems.push(
        `${fresh.title?.he || item.rawName} (מבוקש ${item.quantity}, במלאי ${fresh.stock})`
      );
    }
  }

  return { freshById, problems };
};

/**
 * חישוב העגלה והסכומים. משותף לשני המסלולים.
 */
const buildCartAndTotals = async ({
  items,
  customer,
  deliveryInfo,
  freshById,
  priceMap,
}) => {
  // ‏undefined = לא נשלח מפה, ולכן נשלפת כאן. ‏null הוא ערך תקף שמשמעותו "אין
  // ללקוח מחירון" ואינו מפעיל שליפה חוזרת.
  const customerPrices =
    priceMap === undefined ? await getCustomerPriceMap(customer?._id) : priceMap;

  const cartItems = items.map((item) => {
    // אם המוצר לא נמצא בבדיקה המחודשת (נמחק), נופלים למסמך מההתאמה
    const product = freshById.get(String(item.product._id)) || item.product;
    return buildCartItem(
      product,
      item.quantity,
      item.note,
      priceForProduct(customerPrices, product)
    );
  });

  const offers = await fetchEligibleOffers(customer);
  const {
    updatedCartItems: itemsWithOffers,
    thresholdDiscount = 0,
    appliedOffers = [],
  } = findOptimalOfferCombination(cartItems, offers, {});

  // סכימה באותה לוגיקה כמו addOrder
  let itemsTotal = 0;
  itemsWithOffers.forEach((item) => {
    if (item.isRewardProduct) {
      itemsTotal += (item.rewardPrice || 0) * item.quantity;
    } else if (item.discountedPrice) {
      itemsTotal += item.discountedPrice;
    } else {
      itemsTotal += (item.prices?.price || 0) * item.quantity;
    }
  });

  const subTotal = itemsTotal;
  let total = itemsTotal - (thresholdDiscount || 0);

  const { shippingCost, minimumOrder, shippingRewardEligible } = await calculateShipping({
    shippingOption: deliveryInfo.shippingOption,
    deliveryDoc: deliveryInfo.delivery,
    itemsTotal: total,
  });

  total += shippingCost;

  return {
    cart: itemsWithOffers,
    subTotal,
    total,
    shippingCost,
    minimumOrder,
    shippingRewardEligible,
    thresholdDiscount,
    appliedOffers,
  };
};

// מספר ההזמנה מוקצה במונה אטומי משותף (utils/invoiceNumber) — אותו מנגנון
// בדיוק כמו ב-addOrder. הוא עמיד גם למחיקת הזמנות (מספר שהוקצה לא חוזר) וגם
// ליצירות מקבילות מכמה תהליכים: סריקת ה-cron, ה-webhook של ווצאפ וצ'קאאוט
// מהאתר יכולים לרוץ יחד בלי לקבל את אותו מספר.
const SAVE_ATTEMPTS = 3;

const saveOrder = async (payload) => {
  // הניסיון החוזר מכסה את האינדקס הייחודי על invoice: אם מספר נתפס בכל זאת
  // (למשל ייבוא ישיר למונגו שהמונה לא ידע עליו), מקצים את הבא בתור.
  for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt++) {
    try {
      return await new Order({ ...payload, invoice: await nextFreeInvoice() }).save();
    } catch (err) {
      const isDuplicateInvoice =
        err.code === 11000 && String(err.message).includes("invoice");
      if (!isDuplicateInvoice || attempt === SAVE_ATTEMPTS) throw err;
      console.warn(
        `[ingestion] מספר ההזמנה נתפס בזמן השמירה — ניסיון ${attempt + 1}/${SAVE_ATTEMPTS}`
      );
    }
  }
};

const buildUserInfo = (customer, deliveryInfo) => ({
  name: customer.name,
  lastName: customer.lastName || "",
  email: isSyntheticEmail(customer.email) ? "" : customer.email,
  contact: customer.phone || "",
  address: deliveryInfo.address || {},
  country: "Israel",
  zipCode: deliveryInfo.address?.postalCode || "",
});

const CHANNEL_LABELS = {
  whatsapp: "ווצאפ",
  email: "מייל",
  manual: "הרצה ידנית",
};

// ── שתי הערות, לא אחת ──
//
// `customer_note` הוא מה שהלקוח כתב, ותו לא. הוא מצוטט חזרה *ללקוח* במייל
// אישור ההזמנה תחת הכותרת "הערות הלקוח", ונשלח כ-Comments לחשבונית — ולכן
// כל מילה שהמערכת תוסיף לו תיקרא כאילו הלקוח כתב אותה.
//
// `systemNote` הוא מה שהמערכת יודעת: מאיפה נקלטה ההזמנה, מה חסר בה, ואילו
// הנחות המנוע לקח. הוא מוצג במסך ההזמנה ומודפס על תעודת הליקוט (המלקט חייב
// לדעת שחסר מספר בית — לא לגלות את זה מול הדלת), ואינו נשלח ללקוח בשום ערוץ.

// הערת הלקוח: הטקסט החופשי שלו + מועד שביקש. שניהם דברים שהוא עצמו אמר.
const buildCustomerNote = ({ parsed }) => {
  const noteParts = [];

  if (parsed?.note) noteParts.push(parsed.note);
  if (parsed?.delivery?.requestedDate) {
    noteParts.push(`מועד מבוקש: ${parsed.delivery.requestedDate}`);
  }

  // לקוח שלא כתב דבר — אין הערה. מחרוזת ריקה הייתה מייצרת שורת "הערות הלקוח"
  // ריקה בתעודה ובמייל, ולכן מוותרים על השדה לגמרי.
  return noteParts.length ? noteParts.join(" | ") : undefined;
};

// הערת המערכת: סימון מקור, אזהרות, והנחות שהמנוע לקח על עצמו.
const buildSystemNote = ({ channel, items = [], deliveryInfo }) => {
  const sourceLabel = CHANNEL_LABELS[channel] || "מקור לא ידוע";
  const noteParts = [`[הזמנה נקלטה אוטומטית מ${sourceLabel}]`];

  // כתובת חסרה כשלא מנוהלים יעדי משלוח: ההזמנה לא נחסמת, אבל מי שמלקט
  // חייב לדעת שחסר מידע
  if (deliveryInfo?.addressWarning) noteParts.push(`⚠ ${deliveryInfo.addressWarning}`);

  // יחידות מדידה שהלקוח ציין ואינן יחידות הקטלוג — חייב להגיע לעיני המלקט
  const unitNotes = items
    .filter((i) => i.unit)
    .map((i) => `${i.rawName}: ${i.quantity} ${i.unit}`);
  if (unitNotes.length) {
    noteParts.push(`יחידות שהלקוח ציין — ${unitNotes.join(", ")}`);
  }

  // פריט שהלקוח כתב בלי כמות נלקח כיחידה אחת. זו הנחה של המערכת ולא בקשה
  // שלו, ולכן היא חייבת להיות גלויה — ולכן היא כאן ולא בהערת הלקוח.
  const assumedNames = items.filter((i) => i.quantityAssumed).map((i) => i.rawName);
  if (assumedNames.length) {
    noteParts.push(`נכתב בלי כמות ונלקחה יחידה אחת — ${assumedNames.join(", ")}`);
  }

  return noteParts.join(" | ");
};

/**
 * יצירת הזמנה תקינה — סטטוס "טופלה", הורדת מלאי, התראת מייל.
 *
 * @param {Object} input
 * @param {Array}  input.items - פלט resolveItems (product + quantity + note)
 * @param {Object} input.customer - מסמך Customer
 * @param {Object} input.deliveryInfo - פלט resolveDelivery
 * @param {Object} input.parsed - הפלט המלא של ה-LLM
 * @param {string} input.channel - "email" | "whatsapp"
 * @param {Object} input.incomingOrder - מסמך IncomingOrder
 * @param {Map<string,number>|null} [input.priceMap] - מחירון הלקוח. אם לא נשלח
 *        הוא נשלף כאן, כדי שהמסלול יישאר נכון גם בקריאה מכל מקום אחר.
 * @returns {Promise<Object>} מסמך ההזמנה שנוצר
 */
const createOrderFromParsed = async ({
  items,
  customer,
  deliveryInfo,
  parsed,
  channel,
  incomingOrder,
  priceMap,
}) => {
  if (!items.length) {
    const err = new Error("אין פריטים ליצירת הזמנה");
    err.code = "no_items";
    throw err;
  }

  const processingStatus = await Status.findOne({ name: "Processing" });
  if (!processingStatus) {
    const err = new Error('סטטוס "Processing" לא נמצא במערכת');
    err.code = "order_create_failed";
    throw err;
  }

  const { freshById, problems } = await checkStock(items);
  if (problems.length) {
    const err = new Error(`אין מלאי מספיק: ${problems.join("; ")}`);
    err.code = "out_of_stock";
    throw err;
  }

  const totals = await buildCartAndTotals({
    items,
    customer,
    deliveryInfo,
    freshById,
    priceMap,
  });

  // מינימום הזמנה ליעד — אותה מגבלה שהחנות אוכפת בצ'קאאוט
  if (
    deliveryInfo.shippingOption === "2" &&
    totals.minimumOrder > 0 &&
    totals.total - totals.shippingCost < totals.minimumOrder
  ) {
    const err = new Error(
      `סכום ההזמנה (${(totals.total - totals.shippingCost).toFixed(2)} ₪) מתחת למינימום ליעד ${deliveryInfo.city} (${totals.minimumOrder} ₪)`
    );
    err.code = "below_minimum";
    throw err;
  }

  const userInfo = buildUserInfo(customer, deliveryInfo);

  const order = await saveOrder({
    user: customer._id,
    cart: totals.cart,
    user_info: userInfo,
    subTotal: Number(totals.subTotal.toFixed(2)),
    shippingCost: totals.shippingCost,
    discount: 0, // קופונים אינם נקלטים אוטומטית מהודעות
    offerDiscount: totals.thresholdDiscount || 0,
    total: Number(totals.total.toFixed(2)),
    coupon: null,
    shippingOption: deliveryInfo.shippingOption,
    paymentMethod: process.env.INGESTION_PAYMENT_METHOD || "manual",
    status: processingStatus._id,
    customer_note: buildCustomerNote({ parsed }),
    systemNote: buildSystemNote({ channel, items, deliveryInfo }),
    callOnArrival:
      typeof parsed?.delivery?.callOnArrival === "boolean"
        ? parsed.delivery.callOnArrival
        : undefined,
    usedOfferIds: totals.appliedOffers.map((o) => o._id).filter(Boolean),
    shippingRewardEligible: totals.shippingRewardEligible,
    rewardCouponCode: null,
    source: channel,
    incomingOrder: incomingOrder?._id,
  });

  // ── תופעות הלוואי של המעבר ל-Processing ──
  // (ה-WebHook של Cardcom עושה אותן בהזמנה רגילה; כאן אין מסלול תשלום)

  await logStatusChange({
    from: "No Status",
    to: "Processing",
    functionName: `orderIngestion:${channel}`,
    order,
  });

  // כשל בהורדת מלאי לא מבטל הזמנה שכבר נשמרה — רושמים וממשיכים,
  // בדיוק כמו בהתנהגות ה-WebHook.
  try {
    await handleProductQuantity(order.cart);
  } catch (stockError) {
    console.error(
      `[ingestion] כשל בהורדת מלאי להזמנה ${order.invoice}: ${stockError.message}`
    );
  }

  // התראת מייל לצוות (וללקוח עצמו אם יש לו מייל אמיתי).
  // התבנית קוראת את הטלפון מ-`phone`, ואילו user_info שומר אותו ב-`contact` —
  // מוסיפים אותו לאובייקט שנשלח לתבנית בלבד (לא נשמר ב-DB).
  try {
    await sendOrderNotificationEmail(order, { ...userInfo, phone: customer.phone });
  } catch (emailError) {
    console.error(
      `[ingestion] כשל בשליחת התראת מייל להזמנה ${order.invoice}: ${emailError.message}`
    );
  }

  return order;
};

/**
 * יצירת הזמנת שגיאה — ההודעה זוהתה כהזמנה אבל לא נקראה במלואה.
 *
 * נכנסת עם מה שכן נקרא, בסטטוס "שגיאה בקריאה". במכוון:
 *   • המלאי אינו יורד — ההזמנה עוד לא אושרה ואסור שתשבש מלאי.
 *   • ללקוח אינו נשלח מייל אישור — הוא היה מקבל אישור על הזמנה שבורה.
 *   • הסטטוס מוחרג מדוחות ההכנסות ומאפליקציית המלקטים.
 *
 * ההתראה לצוות נשלחת ע"י alertFailure ב-index.js, עם מספר ההזמנה שנוצרה.
 *
 * @returns {Promise<Object>} מסמך ההזמנה שנוצר
 */
const createErrorOrder = async ({
  items = [],
  unmatched = [],
  customer,
  deliveryInfo,
  parsed,
  channel,
  incomingOrder,
  errorCode,
  errorMessage,
  confidence,
  priceMap,
}) => {
  const errorStatus = await ensureIngestionErrorStatus();
  if (!errorStatus) {
    const err = new Error(`לא ניתן ליצור את הסטטוס "${INGESTION_ERROR_STATUS_HE}"`);
    err.code = "order_create_failed";
    throw err;
  }

  // כתובת עשויה להיות לא פתורה — אז אין משלוח ואין עלות
  const safeDelivery = deliveryInfo || {
    shippingOption: "2",
    address: {},
    delivery: null,
    city: null,
  };

  let totals = {
    cart: [],
    subTotal: 0,
    total: 0,
    shippingCost: 0,
    thresholdDiscount: 0,
    appliedOffers: [],
    shippingRewardEligible: false,
  };

  if (items.length) {
    const { freshById } = await checkStock(items);
    totals = await buildCartAndTotals({
      items,
      customer,
      deliveryInfo: safeDelivery,
      freshById,
      priceMap,
    });
  }

  // פירוט השגיאה *אינו* נכנס להערת ההזמנה. הוא נשמר ב-ingestionError למטה,
  // ומשם מוצג בבאנר בראש מסך ההזמנה ובמסך קליטת ההזמנות. שכפול שלו להערה
  // הטביע את מה שהלקוח באמת כתב, ונשאר מודפס על תעודת הליקוט גם אחרי אישור.
  const order = await saveOrder({
    user: customer._id,
    cart: totals.cart,
    user_info: buildUserInfo(customer, safeDelivery),
    subTotal: Number(totals.subTotal.toFixed(2)),
    shippingCost: totals.shippingCost,
    discount: 0,
    offerDiscount: totals.thresholdDiscount || 0,
    total: Number(totals.total.toFixed(2)),
    coupon: null,
    shippingOption: safeDelivery.shippingOption,
    paymentMethod: process.env.INGESTION_PAYMENT_METHOD || "manual",
    status: errorStatus._id,
    customer_note: buildCustomerNote({ parsed }),
    systemNote: buildSystemNote({ channel, items, deliveryInfo: safeDelivery }),
    callOnArrival:
      typeof parsed?.delivery?.callOnArrival === "boolean"
        ? parsed.delivery.callOnArrival
        : undefined,
    usedOfferIds: totals.appliedOffers.map((o) => o._id).filter(Boolean),
    shippingRewardEligible: false, // לא מזכה בקופון עד שההזמנה תושלם
    rewardCouponCode: null,
    source: channel,
    incomingOrder: incomingOrder?._id,
    ingestionError: {
      code: errorCode,
      message: errorMessage,
      unmatchedItems: unmatched.length
        ? unmatched.map((i) => ({
            rawName: i.rawName,
            quantity: i.quantity,
            unit: i.unit || undefined,
            note: i.note || undefined,
            failReason: i.failReason,
          }))
        : undefined,
      confidence,
      rawText: incomingOrder?.rawText,
    },
  });

  await logStatusChange({
    from: "No Status",
    to: INGESTION_ERROR_STATUS_HE,
    functionName: `orderIngestion:${channel}:error`,
    order,
  });

  console.log(
    `[ingestion] נוצרה הזמנת שגיאה ${order.invoice} (${errorCode}) — המלאי לא ירד`
  );

  return order;
};

module.exports = {
  createOrderFromParsed,
  createErrorOrder,
  buildCartItem,
  fetchEligibleOffers,
  calculateShipping,
  checkStock,
};

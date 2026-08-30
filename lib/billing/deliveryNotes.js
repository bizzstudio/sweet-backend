// lib/billing/deliveryNotes.js
//
// יצירת תעודת משלוח — מהזמנה (אוטומטית) או בהקלדה ידנית.
//
// התעודה האוטומטית נוצרת כשההזמנה יוצאת ללקוח — לא כשהיא נקלטת. הזמנה
// שנקלטה עדיין יכולה להשתנות (פריט חסר במלאי, תיקון כמות), ותעודה שהופקה
// מוקדם מדי הייתה מתארת משלוח שלא קרה.
//
// היא מכילה רק את השורות שנמכרות ביחידות. סחורה שנשקלת — פירות וירקות,
// ובאופן כללי כל קטגוריה שסומנה requiresManualNote — יורדת ממנה, כי
// ההזמנה נושאת את המשקל שהלקוח *ביקש* ולא את מה שנשקל בפועל. עליה מוציאים
// תעודה ידנית (createManual) עם המשקל האמיתי, וממנה החשבונית החודשית
// לוקחת את הכמות לחיוב.

const mongoose = require("mongoose");
const DeliveryNote = require("../../models/DeliveryNote");
const Order = require("../../models/Order");
const Customer = require("../../models/Customer");
const Category = require("../../models/Category");
const { nextFreeNumber } = require("../../utils/deliveryNoteNumber");
const { splitByNoteKind } = require("./manualItems");
const {
  priceItemsForCustomer,
  priceQuality,
  discountPercentFor,
  discountAmount,
} = require("./pricing");
const { barcodesBySku } = require("../../utils/barcode");
const ledger = require("./ledger");
const {
  queueDeliveryNoteSafe,
  cancelDeliveryNotePrint,
} = require("../printing/printJobs");

/**
 * YYYY-MM-DD לפי שעון ישראל.
 *
 * en-CA הוא הלוקאל שמחזיר בדיוק את הפורמט הזה, ו-timeZone מטפל בהזמנה
 * שיצאה ב-23:30 ב-31 בחודש: בלי זה היא הייתה נופלת לחודש הבא לפי UTC.
 */
const israelDay = (date) => date.toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });

/** YYYY-MM לפי שעון ישראל. */
const billingMonthOf = (date) => israelDay(date).slice(0, 7);

/** שם קטגוריה בעברית, עם מטמון לכל קריאה כדי לא לשאול פעמיים על אותה קטגוריה. */
const categoryNameLoader = () => {
  const cache = new Map();
  return async (categoryId) => {
    if (!categoryId) return null;
    const key = String(categoryId);
    if (cache.has(key)) return cache.get(key);

    const cat = await Category.findById(categoryId).select("name").lean();
    const name = cat?.name?.he || cat?.name?.en || null;
    cache.set(key, name);
    return name;
  };
};

/**
 * מפתח ייחודיות בטוח לשאילתה.
 *
 * הערך מגיע מגוף הבקשה, ו-mongoose מעביר אובייקט בשדה שאילתה כאופרטור.
 * ‏{ idempotencyKey: { $ne: null } } היה שאילתה תקינה שמחזירה תעודה
 * שרירותית — ואז הזרימה מדווחת "התעודה כבר נוצרה", מחזירה מסמך של לקוח
 * אחר, ו*לא יוצרת* את התעודה שהתבקשה. כלומר סחורה שיצאה בלי תעודה.
 *
 * מחרוזת בלבד, ובאורך סביר: מפתח ענק אינו מזיק אבל אין סיבה לאחסן אותו.
 *
 * @returns {string|undefined} undefined = לא נשלח מפתח (מותר)
 */
const MAX_IDEMPOTENCY_KEY = 200;

const safeIdempotencyKey = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error("מפתח ייחודיות חייב להיות מחרוזת");
  }
  const key = value.trim();
  if (!key) return undefined;
  if (key.length > MAX_IDEMPOTENCY_KEY) {
    throw new Error(`מפתח ייחודיות ארוך מ-${MAX_IDEMPOTENCY_KEY} תווים`);
  }
  return key;
};

/**
 * ממלא את הברקוד בשורות שכבר נבנו.
 *
 * שאילתה אחת לכל התעודה ולא אחת לשורה: תעודה של 40 שורות הייתה פונה
 * למסד 40 פעם רק כדי להדפיס עמודה.
 *
 * שורה שלא נמצא לה ברקוד נשארת בלי אחד ואינה נחסמת — הברקוד הוא לתצוגה
 * ולהצלבה, והחיוב עצמו נשען על המק\"ט.
 */
const attachBarcodes = async (items) => {
  const missing = items.filter((i) => !i.barcode && i.sku).map((i) => i.sku);
  if (!missing.length) return items;

  const map = await barcodesBySku(missing);
  for (const item of items) {
    if (!item.barcode && item.sku) {
      const code = map.get(String(item.sku));
      if (code) item.barcode = code;
    }
  }
  return items;
};

/**
 * המרת שורות העגלה לשורות התעודה.
 *
 * המחירים בעגלה הם ללא מע"מ (כל המערכת עובדת ככה), ולכן מועתקים כמו שהם.
 * המע"מ מתווסף רק בהפקת החשבונית ב-iCount.
 */
const toNoteItems = async (cart, resolveCategoryName) => {
  const items = [];

  for (const line of cart || []) {
    const quantity = Number(line.quantity) || 0;
    const unitPrice = Number(line.price) || 0;

    // שורה בכמות 0 היא שריד מעריכת עגלה ולא משהו שנמסר ללקוח.
    if (quantity <= 0) continue;

    items.push({
      // line._id ולא line.productId. השדה Product.productId הוא מחרוזת
      // מהתבנית שממנה הפרויקט שוכפל ואינו ה-_id של המוצר — הוא מצביע על
      // מסמך שאינו קיים (נבדק על כל 4,320 המוצרים). השדה כאן מוגדר
      // ref: "Product", ולכן מזהה שאינו _id הופך אותו לקישור שבור.
      productId: line._id || line.id || undefined,
      sku: line.sku ? String(line.sku) : undefined,
      barcode: line.barcode || undefined,
      name: line.title?.he || line.title?.en || line.title || line.name || "פריט",
      quantity,
      unitPrice,
      // לא לוקחים את line.itemTotal: הוא מחושב בצד הלקוח ולא תמיד מעודכן
      // אחרי עריכה ידנית של ההזמנה באדמין.
      lineTotal: Number((quantity * unitPrice).toFixed(2)),
      isVatFree: Boolean(line.isVatFree),
      category: line.category || undefined,
      categoryName: (await resolveCategoryName(line.category)) || undefined,
    });
  }

  return items;
};

/**
 * תוכן התעודה האוטומטית שנגזר מההזמנה — השורות, הסכומים, וחלוקת ההנחה.
 *
 * מוצא מ-createFromOrder כדי ש-syncFromOrder יחשב בדיוק את אותו הדבר.
 * שני חישובים נפרדים היו נפרדים גם בבאג הראשון שייכנס לאחד מהם, וההפרש
 * בין תעודה שנוצרה לתעודה שסונכרנה הוא הפרש בחיוב.
 *
 * @returns {Promise<{items, pendingManual, empty, subTotal, shippingCost, discount, total}>}
 *          empty=true כשאין לתעודה אף שורה אוטומטית.
 */
const buildAutoContent = async (order, { discountPercent = 0 } = {}) => {
  const resolveCategoryName = categoryNameLoader();
  const { automatic, manual } = await splitByNoteKind(order.cart || []);

  const items = await toNoteItems(automatic, resolveCategoryName);
  const pendingManual = await toNoteItems(manual, resolveCategoryName);

  // שאילתת ברקודים אחת לשני החלקים. buildAutoContent נקרא בכל שמירת
  // הזמנה (syncFromOrder), ושתי שאילתות במקום אחת הן פנייה מיותרת למסד
  // על כל לחיצת שמירה במסך ההזמנה.
  await attachBarcodes([...items, ...pendingManual]);

  if (!items.length) {
    return { items, pendingManual, empty: true };
  }

  // מחשבים מחדש ולא לוקחים את order.subTotal: אם ההזמנה נערכה באדמין
  // הסכומים שלה לא תמיד חושבו מחדש, והתעודה חייבת להסכים עם השורות שבה.
  const subTotal = Number(items.reduce((s, i) => s + i.lineTotal, 0).toFixed(2));
  const shippingCost = Number(order.shippingCost) || 0;

  // ההנחה בהזמנה ניתנה על כל הסחורה, כולל השורות הנשקלות שירדו מהתעודה.
  // הורדה שלה במלואה מהחלק האוטומטי הייתה מזכה את הלקוח פעמיים על אותו
  // סכום — פעם כאן ופעם בתעודה הידנית — ולכן היא מתחלקת יחסית.
  const orderDiscount = Number(order.discount || 0) + Number(order.offerDiscount || 0);
  const manualSubTotal = Number(
    pendingManual.reduce((s, i) => s + i.lineTotal, 0).toFixed(2)
  );
  const discountShare = subTotal + manualSubTotal > 0 ? subTotal / (subTotal + manualSubTotal) : 1;
  const orderShare = Number((orderDiscount * discountShare).toFixed(2));

  // ההנחה הקבועה של הלקוח, על סכום השורות שאחרי ההנחה שכבר ניתנה בהזמנה.
  // חישוב על subTotal המלא היה מעניק אותה גם על מה שכבר הוזל, כלומר הנחה
  // כפולה על אותו סכום.
  const customerDiscount = discountAmount(Math.max(0, subTotal - orderShare), discountPercent);
  const discount = Number((orderShare + customerDiscount).toFixed(2));

  const total = Number((subTotal + shippingCost - discount).toFixed(2));

  return {
    items,
    pendingManual,
    empty: false,
    subTotal,
    shippingCost,
    discount,
    discountPercent: customerDiscount > 0 ? Number(discountPercent) : 0,
    customerDiscount,
    total,
  };
};

/**
 * חתימה להשוואה בין תוכן התעודה לתוכן שנגזר מההזמנה עכשיו.
 *
 * רק השדות שמשפיעים על החיוב. השוואה על המסמך כולו הייתה מוצאת הבדל בכל
 * קריאה (_id של תת-מסמכים, חותמות זמן) ומייצרת כתיבה מיותרת בכל שמירה
 * של ההזמנה.
 */
const contentSignature = (content) =>
  JSON.stringify({
    items: (content.items || []).map((i) => [
      String(i.sku || ""),
      i.name,
      Number(i.quantity),
      Number(i.unitPrice),
      Number(i.lineTotal),
      Boolean(i.isVatFree),
      // החשבונית החודשית מפוצלת לפי categoryName. בלעדיו מוצר שהועבר
      // קטגוריה היה משאיר על התעודה שם קטגוריה שכבר לא נכון, והפיצול
      // בחשבונית היה לפי הישן
      String(i.categoryName || ""),
    ]),
    subTotal: Number(content.subTotal || 0),
    shippingCost: Number(content.shippingCost || 0),
    discount: Number(content.discount || 0),
    // בלי אלה, שינוי אחוז ההנחה של הלקוח לא היה נחשב "שינוי" והתעודה
    // הייתה נשארת עם ההנחה הישנה עד שמשהו אחר בהזמנה יזוז
    discountPercent: Number(content.discountPercent || 0),
    customerDiscount: Number(content.customerDiscount || 0),
    total: Number(content.total || 0),
  });

/**
 * יוצר תעודת משלוח אוטומטית להזמנה, על השורות שנמכרות ביחידות בלבד.
 *
 * אם כבר קיימת תעודה אוטומטית להזמנה — מחזיר אותה ולא יוצר חדשה.
 *
 * שורות של סחורה שנשקלת אינן נכנסות לתעודה. הן מוחזרות ב-pendingManual
 * כדי שהמסך יוכל להציע להקליד עליהן תעודה ידנית עם המשקל שנשקל, ולא
 * ייעלמו בשקט — שורה שנעלמה משתי התעודות היא סחורה שנמסרה ולא חויבה.
 *
 * @param {string|ObjectId} orderId
 * @param {object} [opts]
 * @param {string} [opts.issuedBy] - מי הפיק (מייל המשתמש באדמין)
 * @returns {Promise<{note: object|null, created: boolean, pendingManual: Array, reason?: string}>}
 *          note=null עם reason="manualOnly" כשכל ההזמנה היא סחורה נשקלת —
 *          מצב תקין שבו יש להקליד תעודה ידנית ואין מה להפיק אוטומטית.
 */
const createFromOrder = async (orderId, { issuedBy } = {}) => {
  // $ne: "manual" ולא kind: "auto" — תעודה שנוצרה לפני שהשדה קיים אינה
  // נושאת אותו, ושאילתה על "auto" הייתה מפספסת אותה ויוצרת תעודה שנייה
  // לאותה הזמנה. גם האינדקס הייחודי לא היה עוצר זאת, מאותה סיבה בדיוק.
  const existing = await DeliveryNote.findOne({ order: orderId, kind: { $ne: "manual" } });
  if (existing) return { note: existing, created: false, pendingManual: [] };

  const order = await Order.findById(orderId).lean();
  if (!order) throw new Error(`הזמנה ${orderId} לא נמצאה`);

  const customer = await Customer.findById(order.user).select("+erp").lean();
  if (!customer) throw new Error(`הלקוח של הזמנה ${order.invoice} לא נמצא`);

  const discountPercent = await discountPercentFor(customer);
  const {
    items,
    pendingManual,
    empty,
    subTotal,
    shippingCost,
    discount,
    customerDiscount,
    total,
  } = await buildAutoContent(order, { discountPercent });

  if (empty) {
    // הזמנה שכולה פירות וירקות אינה שגיאה — פשוט אין לה חלק אוטומטי.
    if (pendingManual.length) {
      return { note: null, created: false, pendingManual, reason: "manualOnly" };
    }
    throw new Error(`הזמנה ${order.invoice} ריקה — אין ממה להפיק תעודת משלוח`);
  }

  const issuedAt = new Date();
  const erp = customer.erp || {};

  // לולאת ניסיונות סביב המספר הרץ: אם שני תהליכים הגיעו לאותו מספר,
  // האינדקס הייחודי יזרוק ואנחנו מקצים את הבא. הניסיון מוגבל כדי שכשלון
  // אמיתי (למשל תעודה שכבר קיימת להזמנה) לא ייכנס ללולאה אינסופית.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const note = await DeliveryNote.create({
        number: await nextFreeNumber(),
        kind: "auto",
        order: order._id,
        orderNumber: order.invoice,
        customer: customer._id,
        customerSnapshot: {
          name: [customer.name, customer.lastName].filter(Boolean).join(" ").trim(),
          customerNumber: erp.customerNumber,
          vatId: erp.idNumber,
          address: erp.rawAddress || order.user_info?.address?.street,
          city: erp.rawCity || order.user_info?.address?.city?.city_name_he,
          contactPerson: erp.contactPerson,
        },
        items,
        subTotal,
        shippingCost,
        discount,
        discountPercent: customerDiscount > 0 ? discountPercent : 0,
        customerDiscount,
        total,
        issuedAt,
        issuedBy,
        billing: {
          status: "open",
          billingMonth: billingMonthOf(issuedAt),
        },
      });

      // הדפסה מיד עם היצירה. בלי await ובלי catch בצד הקורא — הפונקציה
      // מובטחת לא לזרוק, וההדפסה לא מעכבת את התשובה למי שיצר את התעודה.
      queueDeliveryNoteSafe(note);

      return { note, created: true, pendingManual };
    } catch (err) {
      if (err.code !== 11000) throw err;

      // התנגשות על order = תעודה נוצרה במקביל. מחזירים אותה במקום לנסות שוב.
      if (String(err.message).includes("order")) {
        const raced = await DeliveryNote.findOne({ order: orderId, kind: { $ne: "manual" } });
        if (raced) return { note: raced, created: false, pendingManual };
      }

      console.warn(`[delivery-note] התנגשות מספר בניסיון ${attempt} — מנסה שוב`);
    }
  }

  throw new Error(`יצירת תעודת משלוח להזמנה ${order.invoice} נכשלה אחרי 5 ניסיונות`);
};

/**
 * התאמת התעודה האוטומטית להזמנה, אחרי שההזמנה השתנתה.
 *
 * התעודה נוצרת עם קליטת ההזמנה, וההזמנה ממשיכה להשתנות אחריה — פריט
 * שהתברר כחסר במלאי, כמות שתוקנה, הנחה שנוספה. בלי הסנכרון הזה הלקוח היה
 * מחויב על מה שביקש ולא על מה שקיבל, כי החשבונית החודשית נבנית מהתעודות.
 *
 * תעודה שיצאה ממצב "open" אינה משתנה: מול תעודה שחויבה עומד מסמך מס
 * ב-iCount ותיקון שלה היה מנתק את השניים, ותעודה שנתפסה לחיוב (billing)
 * נמצאת באמצע ריצת סגירת חודש. הפער נרשם ללוג במקום להישאר בשקט — זה
 * בדיוק המצב שבו מישהו צריך להוציא זיכוי.
 *
 * החריג היחיד הוא תעודה שהסנכרון עצמו ביטל כשההזמנה רוקנה: אם ההזמנה
 * התמלאה שוב היא חוזרת ל-open, באותו מספר. ביטול בידי אדם אינו חוזר.
 *
 * @param {string|ObjectId} orderId
 * @param {object} [opts]
 * @param {string} [opts.changedBy] - לרישום בלוג
 * @returns {Promise<{note: object|null, changed: boolean, reason: string}>}
 *          reason: noNote | unchanged | cancelled | billed | billing |
 *                  raced | updated | cancelledEmpty
 */
const syncFromOrder = async (orderId, { changedBy } = {}) => {
  // $ne: "manual" ולא kind: "auto", מאותה סיבה כמו ב-createFromOrder:
  // תעודה שנוצרה לפני שהשדה קיים אינה נושאת אותו.
  const note = await DeliveryNote.findOne({ order: orderId, kind: { $ne: "manual" } });
  if (!note) return { note: null, changed: false, reason: "noNote" };

  const order = await Order.findById(orderId).lean();
  if (!order) throw new Error(`הזמנה ${orderId} לא נמצאה`);

  // אחוז ההנחה נקרא מהלקוח ולא מהתעודה: הסנכרון קיים בדיוק כדי שהתעודה
  // תשקף את המצב הנוכחי, והנחה שהשתנתה היא שינוי כמו כל שינוי אחר.
  const content = await buildAutoContent(order, {
    discountPercent: await discountPercentFor(order.user),
  });

  const current = contentSignature(note);
  const wanted = contentSignature(content.empty ? { items: [] } : content);
  if (current === wanted) return { note, changed: false, reason: "unchanged" };

  // תעודה שנערכה ביד אינה נדרסת. הסנכרון קיים כדי שהתעודה תעקוב אחרי
  // ההזמנה, אבל אדם שתיקן בה כמות תיקן אותה מסיבה — למשל כי זה מה שנמסר
  // בפועל — ודריסה שקטה הייתה מחזירה את הנתון השגוי בלי שאיש ידע.
  //
  // הפער נרשם ללוג ולא נבלע: זה בדיוק המצב שבו צריך להסתכל.
  if (note.manuallyEdited) {
    console.warn(
      `[delivery-note] הזמנה ${order.invoice} השתנתה אחרי שתעודה ${note.number} ` +
        `נערכה ידנית — התעודה לא עודכנה. יש לבדוק אם צריך לתקן אותה במסך.`
    );
    return { note, changed: false, reason: "manuallyEdited" };
  }

  const status = note.billing?.status;

  // תעודה שהסנכרון עצמו ביטל כשההזמנה רוקנה. אם ההזמנה התמלאה שוב היא
  // חוזרת לחיים — עם אותו מספר, שכבר יצא ללקוח. ביטול שנעשה בידי אדם
  // אינו מתבטל כאן: הוא החלטה, ותעודה שקמה לתחייה בעקבות עריכת הזמנה
  // הייתה מחייבת סחורה שמישהו החליט לא לחייב.
  const revivable =
    status === "cancelled" && note.billing?.cancelledBySync && !content.empty;

  if (status === "cancelled" && !revivable) {
    // בלי היציאה השקטה הזו כל שמירה של ההזמנה הייתה מדפיסה אזהרה על
    // תעודה שכבר אין בה עניין
    return { note, changed: false, reason: "cancelled" };
  }

  if (status !== "open" && !revivable) {
    // status חסר לגמרי (תעודה מלפני שהשדה קיים) נופל לכאן במכוון: בלי
    // לדעת אם היא חויבה, אסור לדרוס אותה
    const state =
      status === "billed" ? "חויבה" : status === "billing" ? "נתפסה לחיוב" : `במצב ${status}`;
    console.warn(
      `[delivery-note] הזמנה ${order.invoice} השתנתה אחרי שתעודה ${note.number} ` +
        `כבר ${state} — התעודה לא עודכנה. תיקון נעשה בחשבונית זיכוי.`
    );
    return { note, changed: false, reason: status || "unknown" };
  }

  // הכתיבה מותנית בסטטוס שנקרא למעלה, ולא note.save().
  //
  // בין הקריאה לכתיבה יכולה סגירת החודש לתפוס את התעודה (open → billing)
  // ולהפיק ממנה חשבונית ב-iCount. note.save() היה כותב את השורות החדשות
  // *אחרי* שהחשבונית כבר יצאה, ומשאיר מסמך מס שאינו תואם לתעודה שהוא
  // מבוסס עליה. סגירת החודש עצמה מגנה על עצמה בדיוק כך (claimNotes),
  // וזו אותה הגנה מהצד השני.
  const guard = { _id: note._id, "billing.status": status };

  if (content.empty) {
    // כל השורות ירדו מההזמנה (או שכולן הפכו לסחורה נשקלת). תעודה בלי
    // שורות אינה מסמך — אבל גם אי אפשר למחוק אותה, כי המספר שלה כבר יצא
    // ללקוח ומחיקה הייתה יוצרת חור בסדרה. ביטול הוא המצב הנכון.
    const res = await DeliveryNote.updateOne(guard, {
      $set: {
        "billing.status": "cancelled",
        "billing.cancelReason": `ההזמנה ${order.invoice} רוקנה מפריטים`,
        "billing.cancelledBySync": true,
      },
    });

    if (!res.modifiedCount) return { note, changed: false, reason: "raced" };

    // מוציאים מהתור לפני שהנייר יוצא. תעודה נוצרת בקליטת ההזמנה ומבוטלת
    // כאן שניות אחר כך אם ההזמנה רוקנה — בלי זה מסמך מבוטל היה מגיע ללקוח.
    // ממתינים בכוונה: הביטול מירוץ מול הסוכן, וקריאה שלא ממתינים לה
    // הייתה יכולה להגיע אחרי שהמשימה כבר נתפסה.
    await cancelDeliveryNotePrint(note._id, `ההזמנה ${order.invoice} רוקנה מפריטים`);

    console.log(
      `[delivery-note] תעודה ${note.number} בוטלה — לא נותרו בהזמנה ${order.invoice} שורות אוטומטיות`
    );
    return { note: await DeliveryNote.findById(note._id), changed: true, reason: "cancelledEmpty" };
  }

  // issuedAt ו-billingMonth אינם נכתבים בכוונה: התעודה הופקה במועד
  // הקליטה, ועדכון מאוחר שלה אינו מזיז אותה לחודש חיוב אחר.
  const update = {
    $set: {
      items: content.items,
      subTotal: content.subTotal,
      shippingCost: content.shippingCost,
      discount: content.discount,
      discountPercent: content.discountPercent || 0,
      customerDiscount: content.customerDiscount || 0,
      total: content.total,
    },
  };

  if (revivable) {
    update.$set["billing.status"] = "open";
    update.$unset = { "billing.cancelReason": "", "billing.cancelledBySync": "" };
  }

  const res = await DeliveryNote.updateOne(guard, update, { runValidators: true });
  if (!res.modifiedCount) return { note, changed: false, reason: "raced" };

  if (revivable) {
    // התעודה בוטלה קודם, ואיתה בוטלה משימת ההדפסה שלה — כלומר הנייר
    // מעולם לא יצא. עכשיו היא חיה שוב, עם תוכן חדש, וצריכה להודפס.
    // בלי זה סחורה הייתה יוצאת בלי תעודה, בשקט.
    //
    // reprint ולא הוספה רגילה: הרשומה בתור כבר קיימת (במצב cancelled),
    // והוספה רגילה הייתה נעצרת ב-"כבר בתור" ולא מדפיסה כלום.
    queueDeliveryNoteSafe(note, { requestedBy: "התעודה חזרה לפעילה", reprint: true });

    console.log(
      `[delivery-note] תעודה ${note.number} חזרה לפעילה — הזמנה ${order.invoice} התמלאה שוב`
    );
  }
  console.log(
    `[delivery-note] תעודה ${note.number} עודכנה לפי הזמנה ${order.invoice} ` +
      `(${content.items.length} שורות, ${content.total}₪)${changedBy ? ` — ${changedBy}` : ""}`
  );

  return { note: await DeliveryNote.findById(note._id), changed: true, reason: "updated" };
};

/**
 * מה עוד ממתין לתעודה ידנית בהזמנה נתונה.
 *
 * זה מה שממלא מראש את טופס התעודה הידנית: השורות הנשקלות של ההזמנה,
 * עם המשקל שהוזמן ככמות התחלתית שהמשתמשת מתקנת למה שנשקל בפועל.
 *
 * שורות שכבר הוקלדו בתעודה ידנית קודמת יורדות מהרשימה — אחרת משלוח פירות
 * שיצא בשתי פעימות היה מוצע שוב במלואו והלקוח היה מחויב פעמיים.
 *
 * @param {string|ObjectId} orderId
 * @returns {Promise<{items: Array, coveredSkus: Array, shippingCost: number, order: object}>}
 */
const pendingManualItems = async (orderId) => {
  const order = await Order.findById(orderId).lean();
  if (!order) throw new Error(`הזמנה ${orderId} לא נמצאה`);

  const { manual } = await splitByNoteKind(order.cart || []);
  const items = await attachBarcodes(await toNoteItems(manual, categoryNameLoader()));

  const existing = await DeliveryNote.find({
    order: orderId,
    kind: "manual",
    "billing.status": { $ne: "cancelled" },
  })
    .select("items")
    .lean();

  // ההשוואה על מק"ט ולא על שם: השם על התעודה הוא צילום מצב ויכול להשתנות
  // בקטלוג, המק"ט לא.
  //
  // מק"ט ריק אינו מסתנן: בלי הסינון, תעודה אחת עם שורה חסרת מק"ט הייתה
  // מכניסה "" לקבוצה ומעלימה *כל* שורה ממתינה חסרת מק"ט מהרשימה.
  const covered = new Set(
    existing
      .flatMap((note) => (note.items || []).map((i) => String(i.sku || "")))
      .filter(Boolean)
  );

  const pending = items.filter((i) => !i.sku || !covered.has(String(i.sku)));

  // חלק ההנחה שלא ירד מהתעודה האוטומטית. createFromOrder מחלק את ההנחה
  // יחסית בין שני החלקים, ובלי להחזיר את השארית לכאן היא הייתה נעלמת —
  // הלקוח היה מקבל הנחה על היבש בלבד ומשלם מלא על הפירות.
  const autoNote = await DeliveryNote.findOne({
    order: orderId,
    kind: { $ne: "manual" },
    "billing.status": { $ne: "cancelled" },
  })
    .select("discount")
    .lean();

  const orderDiscount = Number(order.discount || 0) + Number(order.offerDiscount || 0);
  const alreadyGiven =
    Number(autoNote?.discount || 0) +
    existing.reduce((s, n) => s + Number(n.discount || 0), 0);

  return {
    items: pending,
    coveredSkus: [...covered],
    // המשלוח יושב על התעודה האוטומטית כשהיא קיימת. כשההזמנה כולה נשקלת
    // אין תעודה כזו, ובלי המספר הזה דמי המשלוח היו נופלים בין הכיסאות.
    shippingCost: autoNote ? 0 : Number(order.shippingCost) || 0,
    remainingDiscount: Number(Math.max(0, orderDiscount - alreadyGiven).toFixed(2)),
    order: { _id: order._id, invoice: order.invoice, user: order.user },
  };
};

/**
 * הפקת תעודת משלוח ידנית — הסחורה שנשקלת.
 *
 * הכמות שמוזנת כאן היא המשקל שנשקל בפועל, ולכן היא זו שמגיעה לחשבונית
 * החודשית. זו הנקודה שבה המשקל האמיתי נכנס למערכת.
 *
 * המחירים נקבעים כמו בהצעת מחיר (מחירון הלקוח → קטלוג), אלא אם נשלח מחיר
 * מפורש לשורה — סחורה נשקלת מתומחרת לפעמים לפי מחיר יום.
 *
 * @param {object} p
 * @param {string} [p.customerId] - חובה, אלא אם נשלחה הזמנה שממנה הוא נגזר
 * @param {string} [p.orderId]    - קישור להזמנה, אם התעודה נובעת מאחת
 * @param {Array<{sku, quantity, unitPrice?}>} p.items
 * @param {string} [p.manualReference] - מספר התעודה מהפנקס הידני
 * @param {string|Date} [p.issuedAt]   - תאריך המסירה בפועל. קובע את חודש
 *        החיוב, ולכן ניתן לתארוך אחורה תעודה שהוקלדה באיחור
 * @param {string} [p.idempotencyKey]  - מפתח מהטופס, נגד שליחה כפולה
 * @returns {Promise<{note: object, created: boolean, quality: object}>}
 */
const createManual = async ({
  customerId,
  orderId,
  items,
  manualReference,
  issuedAt,
  notes,
  shippingCost = 0,
  discount = 0,
  issuedBy,
  idempotencyKey,
}) => {
  if (!Array.isArray(items) || !items.length) {
    throw new Error("תעודת משלוח חייבת לכלול לפחות שורה אחת");
  }

  // בדיקה לפני היצירה ולא רק הסתמכות על האינדקס: שליחה חוזרת מחזירה את
  // התעודה הקיימת במקום שגיאה, וזה מה שהמסך צריך לראות
  const safeKey = safeIdempotencyKey(idempotencyKey);
  if (safeKey) {
    const already = await DeliveryNote.findOne({ idempotencyKey: safeKey }).lean();
    if (already) return { note: already, created: false, quality: null };
  }

  let order = null;
  if (orderId) {
    order = await Order.findById(orderId).lean();
    if (!order) throw new Error(`הזמנה ${orderId} לא נמצאה`);
  }

  const resolvedCustomerId = customerId || order?.user;
  if (!resolvedCustomerId) throw new Error("יש לבחור לקוח");

  const customer = await Customer.findById(resolvedCustomerId).select("+erp").lean();
  if (!customer) throw new Error("הלקוח לא נמצא");

  // תעודה שקושרה להזמנה של לקוח אחר הייתה מחייבת את הלקוח הלא נכון, ובסוף
  // החודש זה כבר מסמך מס ב-iCount
  if (order && String(order.user) !== String(customer._id)) {
    throw new Error(
      `הזמנה ${order.invoice} שייכת ללקוח אחר — לא ניתן לקשר אליה תעודה של ${customer.name}`
    );
  }

  const clean = items
    .map((i) => ({
      sku: String(i.sku || "").trim(),
      quantity: Number(i.quantity),
      unitPrice: i.unitPrice,
      name: i.name,
    }))
    .filter((i) => i.sku);

  if (!clean.length) throw new Error('כל השורות חסרות מק"ט');

  const bad = clean.filter((i) => !Number.isFinite(i.quantity) || i.quantity <= 0);
  if (bad.length) {
    throw new Error(
      `כמות חייבת להיות גדולה מאפס: ${bad.map((i) => i.sku).join(", ")}`
    );
  }

  // מק"ט שכבר הוקלד בתעודה ידנית אחרת של אותה הזמנה.
  //
  // idempotencyKey מגן מפני שליחה כפולה של *אותו* טופס, אבל לא מפני שני
  // אנשים שפותחים את ההזמנה ומקלידים את אותן שקילות בנפרד — ושם התוצאה
  // היא חיוב כפול בסוף החודש, על מסמך מס שאי אפשר למחוק.
  //
  // חסימה ולא אזהרה, כי הצד השני של הטעות יקר בהרבה: משלוח פירות מפוצל
  // *של אותו מוצר* עדיין אפשרי דרך תעודה עצמאית בלי קישור להזמנה.
  if (order) {
    const already = await DeliveryNote.find({
      order: order._id,
      kind: "manual",
      "billing.status": { $ne: "cancelled" },
    })
      .select("number items.sku")
      .lean();

    const coveredBy = new Map();
    for (const note of already) {
      for (const item of note.items || []) {
        if (item.sku) coveredBy.set(String(item.sku), note.number);
      }
    }

    const clashes = clean.filter((i) => coveredBy.has(i.sku));
    if (clashes.length) {
      throw new Error(
        `מק"טים שכבר הוקלדו בתעודה ידנית להזמנה זו: ` +
          `${clashes.map((i) => `${i.sku} (תעודה ${coveredBy.get(i.sku)})`).join(", ")}. ` +
          `לתיקון — יש לבטל את התעודה הקיימת; למשלוח נוסף — יש להפיק תעודה ידנית ללא קישור להזמנה.`
      );
    }
  }

  // אותה בנייה בדיוק כמו בעריכה ובהמרה מהצעת מחיר — מקור אחד לשורות,
  // כולל הברקוד ושם הקטגוריה שהחשבונית מפוצלת לפיו
  const { items: finalItems, priced } = await buildPricedItems(resolvedCustomerId, clean);

  const subTotal = Number(finalItems.reduce((s, i) => s + i.lineTotal, 0).toFixed(2));

  // סכומים שליליים הופכים תעודה לזיכוי מוסווה. זיכוי יש להוציא במסלול
  // שלו (creditInvoice), עם מסמך מס משלו
  const shipping = Number(shippingCost) || 0;
  const manualDiscount = Number(discount) || 0;
  if (shipping < 0) throw new Error("דמי משלוח לא יכולים להיות שליליים");
  if (manualDiscount < 0) throw new Error("הנחה לא יכולה להיות שלילית");

  // ההנחה הקבועה של הלקוח, על מה שנשאר אחרי ההנחה שהוקלדה בטופס. שתיהן
  // על אותו בסיס היו נותנות יותר ממה שסוכם.
  const discountPercent = await discountPercentFor(customer);
  const customerDiscount = discountAmount(
    Math.max(0, subTotal - manualDiscount),
    discountPercent
  );
  const noteDiscount = Number((manualDiscount + customerDiscount).toFixed(2));

  if (noteDiscount > subTotal + shipping) {
    throw new Error(
      `ההנחה (${noteDiscount}) גדולה מסכום התעודה (${(subTotal + shipping).toFixed(2)})`
    );
  }

  const total = Number((subTotal + shipping - noteDiscount).toFixed(2));

  // תאריך לא תקין (טופס ריק, מחרוזת פגומה) היה מייצר billingMonth של
  // "Invalid Date" — והתעודה נופלת מכל שאילתת סגירת חודש ולא מחויבת לעולם
  const parsed = issuedAt ? new Date(issuedAt) : new Date();
  const issued = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

  // תאריך עתידי משייך את התעודה לחודש חיוב שטרם הגיע, וסגירת החודש —
  // שאוספת billingMonth <= החודש הנסגר — לא תיגע בה עד שיגיע. סחורה
  // שנמסרה הייתה יושבת לא מחויבת בלי שאיש ישים לב.
  //
  // ההשוואה על היום בשעון ישראל ולא על חותמת זמן: תעודה שמוקלדת היום
  // אסור שתיפסל בגלל הפרש שעות בין הדפדפן לשרת. מחרוזות YYYY-MM-DD
  // מסודרות לקסיקוגרפית, ולכן אין כאן חשבון קיזוזים שנשבר במעבר לשעון קיץ.
  if (israelDay(issued) > israelDay(new Date())) {
    throw new Error("לא ניתן להפיק תעודה בתאריך עתידי — יש לתארך ליום המסירה בפועל");
  }

  const erp = customer.erp || {};

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const note = await DeliveryNote.create({
        number: await nextFreeNumber(),
        kind: "manual",
        order: order?._id,
        orderNumber: order?.invoice,
        customer: customer._id,
        customerSnapshot: {
          name: [customer.name, customer.lastName].filter(Boolean).join(" ").trim(),
          customerNumber: erp.customerNumber,
          vatId: erp.idNumber,
          address: erp.rawAddress || order?.user_info?.address?.street,
          city: erp.rawCity || order?.user_info?.address?.city?.city_name_he,
          contactPerson: erp.contactPerson,
        },
        items: finalItems,
        subTotal,
        shippingCost: shipping,
        discount: noteDiscount,
        discountPercent: customerDiscount > 0 ? discountPercent : 0,
        customerDiscount,
        total,
        issuedAt: issued,
        issuedBy,
        manualReference: manualReference || undefined,
        idempotencyKey: safeKey,
        notes,
        billing: {
          status: "open",
          billingMonth: billingMonthOf(issued),
        },
      });

      // תעודה ידנית מודפסת בדיוק כמו האוטומטית — היא אותו מסמך שיוצא
      // ללקוח, וההבדל היחיד הוא איך הגיעו אליה השורות.
      queueDeliveryNoteSafe(note, { requestedBy: issuedBy || "אוטומטי" });

      return { note, created: true, quality: priceQuality(priced) };
    } catch (err) {
      if (err.code !== 11000) throw err;

      // שליחה כפולה שהגיעה עד לכתיבה — האינדקס עצר אותה, ומחזירים את
      // התעודה שנוצרה ראשונה
      if (safeKey && String(err.message).includes("idempotencyKey")) {
        const raced = await DeliveryNote.findOne({ idempotencyKey: safeKey }).lean();
        if (raced) return { note: raced, created: false, quality: null };
      }

      console.warn(`[delivery-note] התנגשות מספר בניסיון ${attempt} — מנסה שוב`);
    }
  }

  throw new Error("הפקת תעודת משלוח ידנית נכשלה אחרי 5 ניסיונות");
};

/**
 * תמחור ובניית שורות תעודה מרשימת {sku, quantity, unitPrice?}.
 *
 * מוצא מ-createManual כדי שעריכת תעודה, שכפול והמרה מהצעת מחיר יבנו
 * שורות בדיוק באותו אופן. שלושה מימושים נפרדים היו נפרדים גם ביום שבו
 * אחד מהם ישכח את הברקוד או את שם הקטגוריה.
 *
 * @param {string} customerId
 * @param {Array<{sku, quantity, unitPrice?}>} rawItems
 * @param {object} [opts]
 * @param {boolean} [opts.requirePrice=true] - לחסום שורה שלא נמצא לה מחיר
 * @returns {Promise<{items: Array, priced: Array}>}
 */
const buildPricedItems = async (customerId, rawItems, { requirePrice = true } = {}) => {
  const clean = (rawItems || [])
    .map((i) => ({
      sku: String(i.sku || "").trim(),
      quantity: Number(i.quantity),
      unitPrice: i.unitPrice,
      name: i.name,
    }))
    .filter((i) => i.sku);

  if (!clean.length) throw new Error('כל השורות חסרות מק"ט');

  const bad = clean.filter((i) => !Number.isFinite(i.quantity) || i.quantity <= 0);
  if (bad.length) {
    throw new Error(`כמות חייבת להיות גדולה מאפס: ${bad.map((i) => i.sku).join(", ")}`);
  }

  const priced = await priceItemsForCustomer(customerId, clean);

  const unknown = priced.filter((i) => i.unknownProduct);
  if (unknown.length) {
    throw new Error(`מק"טים שאינם קיימים בקטלוג: ${unknown.map((i) => i.sku).join(", ")}`);
  }

  const resolveCategoryName = categoryNameLoader();
  const items = [];

  for (let i = 0; i < priced.length; i++) {
    const row = priced[i];
    const override = clean[i].unitPrice;
    // 0 מפורש הוא החלטה לגיטימית (סחורה שניתנה בלי חיוב), ולכן הבדיקה על
    // undefined ולא על falsy
    const hasOverride = override !== undefined && override !== null && override !== "";
    const unitPrice = hasOverride ? Number(override) : row.unitPrice;

    if (hasOverride && (!Number.isFinite(unitPrice) || unitPrice < 0)) {
      throw new Error(`מחיר לא תקין בשורה ${row.sku}`);
    }

    items.push({
      productId: row.productId,
      sku: row.sku,
      barcode: row.barcode,
      name: row.name,
      quantity: row.quantity,
      unitPrice,
      lineTotal: Number((unitPrice * row.quantity).toFixed(2)),
      isVatFree: row.isVatFree,
      category: row.category,
      categoryName: (await resolveCategoryName(row.category)) || undefined,
    });
  }

  if (requirePrice) {
    // שורה בלי מחיר משום מקור הופכת ל-0, כלומר סחורה שנמסרה ולא חויבה.
    // אם זו הכוונה — יש לשלוח unitPrice: 0 במפורש.
    const unpriced = items.filter((item, i) => {
      const override = clean[i].unitPrice;
      const explicit = override !== undefined && override !== null && override !== "";
      return !explicit && !(item.unitPrice > 0);
    });
    if (unpriced.length) {
      throw new Error(
        `אין מחיר למק"טים: ${unpriced.map((i) => i.sku).join(", ")} — יש להזין מחיר יחידה ידני`
      );
    }
  }

  return { items, priced };
};

/**
 * עריכת תעודה שעדיין לא חויבה.
 *
 * מותר רק במצב open, ומסיבה אחת: מול תעודה שחויבה עומד מסמך מס ב-iCount,
 * ושינוי שלה היה מנתק את השניים בלי שאיש ידע. התיקון שם נעשה בזיכוי
 * (creditInvoice) — הוא מחזיר את התעודות ל-open, ואז אפשר לערוך כאן.
 *
 * תעודה שנערכה מסומנת manuallyEdited, וזה מה שעוצר את הסנכרון מההזמנה:
 * בלי הסימון, העריכה הבאה של ההזמנה הייתה מוחקת בשקט את מה שתוקן ביד.
 *
 * @param {string|ObjectId} noteId
 * @param {object} patch - items / manualReference / issuedAt / notes /
 *                         shippingCost / discount. שדה שלא נשלח לא משתנה.
 * @returns {Promise<{note: object, changed: boolean}>}
 */
const update = async (noteId, patch = {}) => {
  const note = await DeliveryNote.findById(noteId);
  if (!note) throw new Error(`תעודה ${noteId} לא נמצאה`);

  const status = note.billing?.status;
  if (status === "billed") {
    throw new Error(
      `תעודה ${note.number} כבר חויבה בחשבונית ${note.billing.icountDocNum} — ` +
        `לתיקון יש להוציא חשבונית זיכוי, שתחזיר את התעודה למצב פתוח.`
    );
  }
  if (status === "billing") {
    throw new Error(`תעודה ${note.number} נתפסה כרגע לחיוב — יש לנסות שוב בעוד רגע`);
  }
  if (status === "cancelled") {
    throw new Error(`תעודה ${note.number} בוטלה ואינה ניתנת לעריכה`);
  }
  // סטטוס חסר לגמרי (תעודה מלפני שהשדה קיים) נחסם במפורש, כמו
  // ב-syncFromOrder: בלי לדעת אם היא חויבה, אסור לגעת בה. בלי החסימה הזו
  // הכתיבה המותנית שבהמשך הייתה נכשלת עם הודעה מטעה על "נתפסה לחיוב".
  if (status !== "open") {
    throw new Error(
      `לתעודה ${note.number} אין מצב חיוב מוכר (${status || "ריק"}) — לא ניתן לערוך אותה`
    );
  }

  // מצב דמו: התעודה יכולה להיות "חויבה" בכיס הדמו בזמן שהיא פתוחה באמת.
  // עריכה כזו הייתה משנה שורות מאחורי חשבונית דמו קיימת, ומציגה במסך
  // מסמך שאינו תואם את מה שהופק. אותה בדיקה כמו ב-billNoteImmediately.
  const pocket = ledger.of(note).status;
  if (pocket && pocket !== "open") {
    throw new Error(
      `תעודה ${note.number} כבר חויבה בהדגמה (${pocket}) — יש לאפס את מצב הדמו לפני עריכה`
    );
  }

  const customer = await Customer.findById(note.customer).select("+erp").lean();
  if (!customer) throw new Error("הלקוח של התעודה לא נמצא");

  // השורות. לא נשלחו = נשארות כמו שהן, ורק הסכומים מחושבים מחדש.
  const items = patch.items
    ? (await buildPricedItems(note.customer, patch.items)).items
    : await attachBarcodes(note.items.map((i) => ({ ...(i.toObject?.() || i) })));

  const subTotal = Number(items.reduce((s, i) => s + i.lineTotal, 0).toFixed(2));

  const shipping =
    patch.shippingCost === undefined ? Number(note.shippingCost) || 0 : Number(patch.shippingCost) || 0;
  if (shipping < 0) throw new Error("דמי משלוח לא יכולים להיות שליליים");

  // ההנחה הידנית היא מה שהוקלד, בלי החלק שההנחה הקבועה של הלקוח יצרה —
  // אחרת כל שמירה הייתה מוסיפה את אחוז ההנחה שוב על עצמו.
  const previousManual = Math.max(
    0,
    Number((Number(note.discount || 0) - Number(note.customerDiscount || 0)).toFixed(2))
  );
  const manualDiscount =
    patch.discount === undefined ? previousManual : Number(patch.discount) || 0;
  if (manualDiscount < 0) throw new Error("הנחה לא יכולה להיות שלילית");

  const discountPercent = await discountPercentFor(customer);
  const customerDiscount = discountAmount(
    Math.max(0, subTotal - manualDiscount),
    discountPercent
  );
  const discount = Number((manualDiscount + customerDiscount).toFixed(2));

  if (discount > subTotal + shipping) {
    throw new Error(
      `ההנחה (${discount}) גדולה מסכום התעודה (${(subTotal + shipping).toFixed(2)})`
    );
  }

  const total = Number((subTotal + shipping - discount).toFixed(2));

  const $set = {
    items,
    subTotal,
    shippingCost: shipping,
    discount,
    discountPercent: customerDiscount > 0 ? discountPercent : 0,
    customerDiscount,
    total,
    manuallyEdited: true,
    editedAt: new Date(),
    editedBy: patch.changedBy,
  };

  // ניקוי שדה טקסט חייב $unset ולא $set: undefined ב-$set נזרק על ידי
  // mongoose לפני שהוא מגיע למסד, כלומר "מחקתי את מספר הפנקס" היה נשמר
  // בהצלחה ולא משנה כלום.
  const $unset = {};

  if (patch.manualReference !== undefined) {
    const value = String(patch.manualReference || "").trim();
    if (value) $set.manualReference = value;
    else $unset.manualReference = "";
  }
  if (patch.notes !== undefined) {
    const value = String(patch.notes || "").trim();
    if (value) $set.notes = value;
    else $unset.notes = "";
  }
  if (!patch.changedBy) delete $set.editedBy;

  // תאריך המסירה קובע את חודש החיוב, ולכן שינוי שלו מזיז את התעודה בין
  // חודשים. אותן בדיקות כמו בהקלדה: תאריך פגום היה יוצר billingMonth
  // שנופל מכל שאילתת סגירת חודש, ותעודה עתידית לא תחויב עד שיגיע התאריך.
  if (patch.issuedAt !== undefined) {
    const parsed = new Date(patch.issuedAt);
    if (Number.isNaN(parsed.getTime())) throw new Error("תאריך מסירה לא תקין");
    if (israelDay(parsed) > israelDay(new Date())) {
      throw new Error("לא ניתן לתארך תעודה לעתיד — יש לתארך ליום המסירה בפועל");
    }
    $set.issuedAt = parsed;
    $set["billing.billingMonth"] = billingMonthOf(parsed);
  }

  // הכתיבה מותנית ב-status שנקרא למעלה, מאותה סיבה כמו ב-syncFromOrder:
  // בין הקריאה לכתיבה יכולה סגירת החודש לתפוס את התעודה ולהפיק ממנה
  // חשבונית, ואז השורות החדשות היו נכתבות אחרי שהמסמך כבר יצא.
  const res = await DeliveryNote.updateOne(
    { _id: note._id, "billing.status": "open" },
    Object.keys($unset).length ? { $set, $unset } : { $set },
    { runValidators: true }
  );

  if (!res.matchedCount) {
    throw new Error(`תעודה ${note.number} נתפסה לחיוב באמצע העריכה — השינוי לא נשמר`);
  }

  const updated = await DeliveryNote.findById(note._id);

  // התעודה השתנתה, והנייר שיצא כבר אינו נכון. reprint ולא הוספה רגילה:
  // הרשומה בתור כבר קיימת, והוספה רגילה הייתה נעצרת ב"כבר בתור".
  queueDeliveryNoteSafe(updated, {
    requestedBy: patch.changedBy || "עריכה",
    reprint: true,
  });

  console.log(
    `[delivery-note] תעודה ${updated.number} נערכה ידנית ` +
      `(${items.length} שורות, ${total}₪)${patch.changedBy ? ` — ${patch.changedBy}` : ""}`
  );

  return { note: updated, changed: true };
};

/**
 * שכפול מסמך — "עוד אחת בדיוק כמו זו".
 *
 * המקרה שממנו זה נולד: אותה סחורה יוצאת שוב לאותו לקוח, ואין סיבה
 * להקליד את כל השורות מחדש.
 *
 * ההעתק לוקח את השורות *כמו שהן*, כולל המחירים — ולא מתמחר מחדש. הכוונה
 * היא "עוד אחת כמו זו", ומחירון שהתעדכן בינתיים היה הופך את ההעתק למסמך
 * אחר בלי שאיש ביקש.
 *
 * ההעתק תמיד ידני ואינו קשור להזמנה, גם כשהמקור היה אוטומטי: להזמנה
 * יכולה להיות תעודה אוטומטית אחת בלבד (אינדקס ייחודי), ותעודה שנייה
 * שקושרה אליה הייתה נספרת פעמיים בבדיקות "מה כבר הוקלד".
 *
 * @returns {Promise<{note: object, created: boolean}>}
 */
const duplicate = async (noteId, { issuedBy, idempotencyKey, issuedAt } = {}) => {
  const safeKey = safeIdempotencyKey(idempotencyKey);
  if (safeKey) {
    const already = await DeliveryNote.findOne({ idempotencyKey: safeKey }).lean();
    if (already) return { note: already, created: false };
  }

  const source = await DeliveryNote.findById(noteId).lean();
  if (!source) throw new Error(`תעודה ${noteId} לא נמצאה`);
  if (!source.items?.length) throw new Error("אי אפשר להעתיק תעודה בלי שורות");

  const parsed = issuedAt ? new Date(issuedAt) : new Date();
  const issued = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  if (israelDay(issued) > israelDay(new Date())) {
    throw new Error("לא ניתן להפיק תעודה בתאריך עתידי");
  }

  // הברקודים ממולאים גם בהעתק של תעודה ישנה שנוצרה לפני שהשדה היה קיים
  const items = await attachBarcodes(source.items.map((i) => ({ ...i })));

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const note = await DeliveryNote.create({
        number: await nextFreeNumber(),
        kind: "manual",
        customer: source.customer,
        customerSnapshot: source.customerSnapshot,
        items,
        subTotal: source.subTotal,
        shippingCost: source.shippingCost,
        discount: source.discount,
        discountPercent: source.discountPercent || 0,
        customerDiscount: source.customerDiscount || 0,
        total: source.total,
        issuedAt: issued,
        issuedBy,
        notes: source.notes,
        copiedFrom: source._id,
        copiedFromNumber: source.number,
        idempotencyKey: safeKey,
        billing: {
          status: "open",
          billingMonth: billingMonthOf(issued),
        },
      });

      queueDeliveryNoteSafe(note, { requestedBy: issuedBy || "העתקה" });

      console.log(
        `[delivery-note] תעודה ${note.number} נוצרה כהעתק של ${source.number}`
      );
      return { note, created: true };
    } catch (err) {
      if (err.code !== 11000) throw err;

      if (safeKey && String(err.message).includes("idempotencyKey")) {
        const raced = await DeliveryNote.findOne({ idempotencyKey: safeKey }).lean();
        if (raced) return { note: raced, created: false };
      }

      console.warn(`[delivery-note] התנגשות מספר בניסיון ${attempt} — מנסה שוב`);
    }
  }

  throw new Error(`העתקת תעודה ${source.number} נכשלה אחרי 5 ניסיונות`);
};

/**
 * ביטול תעודה. תעודה שכבר חויבה אינה ניתנת לביטול — מולה מוציאים חשבונית
 * זיכוי, אחרת החשבונית שהופקה ב-iCount הייתה מצביעה על תעודה שלא קיימת.
 */
const cancel = async (noteId, reason) => {
  const note = await DeliveryNote.findById(noteId);
  if (!note) throw new Error(`תעודה ${noteId} לא נמצאה`);

  if (note.billing.status === "billed") {
    throw new Error(
      `תעודה ${note.number} כבר חויבה בחשבונית ${note.billing.icountDocNum} — ` +
        `לביטול יש להוציא חשבונית זיכוי`
    );
  }

  note.billing.status = "cancelled";
  note.billing.cancelReason = reason;
  // ביטול בידי אדם, ולכן לא נסוג מעצמו. בלי האיפוס הזה תעודה שהסנכרון
  // ביטל קודם (ההזמנה רוקנה) והאדם ביטל אחריה שוב הייתה חוזרת לחיים
  // ברגע שההזמנה תתמלא — כלומר מחייבת סחורה שמישהו החליט לא לחייב.
  note.billing.cancelledBySync = false;
  await note.save();

  // אותו שיקול כמו בביטול מהסנכרון: תעודה שבוטלה לפני שהנייר יצא אינה
  // צריכה לצאת. משימה שכבר הודפסה נשארת כמו שהיא — הנייר קיים במציאות.
  await cancelDeliveryNotePrint(note._id, reason || "התעודה בוטלה");

  return note;
};

module.exports = {
  createFromOrder,
  syncFromOrder,
  createManual,
  pendingManualItems,
  update,
  duplicate,
  buildPricedItems,
  attachBarcodes,
  cancel,
  billingMonthOf,
  // מיוצא כדי שסינון לפי יום (lib/billing/receipts) ישתמש באותה הגדרת
  // "יום" כמו שיוך התעודות לחודש. שתי הגדרות יום שונות באותו מודול חיוב
  // הן הדרך לקבל דוח שמראה תעודה בחודש אחד וקבלה ביום אחר
  israelDay,
};

// lib/order-ingestion/disposablesSplit.js
//
// פיצול הזמנה מעורבת לכמה הזמנות: כיבוד, אחזקה (ח.ניקוי+ח"פ ומשרד) וחלב.
//
// בקשה 05/11/2026: לקוחות עם תקציב נפרד לכיבוד ולאחזקה שולחים מייל אחד עם
// הכל, ודורשים שתי תעודות משלוח. תעודה נוצרת להזמנה (deliveryNotes.
// createFromOrder — תעודה אחת לכל הזמנה), ולכן הפיצול הוא של ההזמנה, לפני
// המעבר ל"טופלה": כל אחת מקבלת תעודה משלה, ליקוט משלה, והחשבונית החודשית
// (separateDisposablesInvoice / separateMilk) מקבלת תעודות "נקיות" במקום
// תעודה מעורבת שנופלת כולה לחשבונית המזון.
//
// כל חלק מופעל לפי דגל משלו בכרטיס הלקוח:
//   billing.separateDisposablesNote — אחזקה: ח.ניקוי+ח"פ, ומ-08/11/2026 גם
//     משרד ("אחזקה חד פעמי ומשרד הם ביחד").
//   billing.separateMilk — חלב (בקשה 08/11/2026, עתידים ונטלי): רק הקטגוריה
//     "חלב"; גבינות נשארות עם הכיבוד.
// השיוך לפי קטגוריית המוצר בקטלוג — מוצר אחזקה שרשום תחת "מזון" נשאר בתעודת
// הכיבוד. פירות נשארים עם הכיבוד.
//
// ההזמנה המקורית נשארת עם הכיבוד, ואם אין כיבוד — עם החלק הראשון שיש בו
// מוצרים. דמי המשלוח וההנחה על הסכום נשארים בה: זה משלוח אחד, והמינימום כבר
// נבדק על ההזמנה המלאה לפני הפיצול.

const Category = require("../../models/Category");
const Order = require("../../models/Order");
const { lineAmount } = require("../orders/lineAmount");

const DISPOSABLES_CATEGORY = 'ח.ניקוי+ח"פ';
const OFFICE_CATEGORY = "משרד";
const MILK_CATEGORY = "חלב";

// החלקים שיכולים לצאת מההזמנה, בסדר הזה. הכיבוד הוא "כל השאר"
const PARTS = [
  {
    key: "disposables",
    label: "אחזקה",
    flag: "separateDisposablesNote",
    categories: [DISPOSABLES_CATEGORY, OFFICE_CATEGORY],
  },
  { key: "milk", label: "חלב", flag: "separateMilk", categories: [MILK_CATEGORY] },
];
const REST_LABEL = "כיבוד";

const sumOf = (cart) => Number(cart.reduce((s, i) => s + lineAmount(i), 0).toFixed(2));

/** מזהה קטגוריה → שם, רק לקטגוריות שבסל */
const categoryNamesOf = async (cart) => {
  const ids = [...new Set(cart.map((i) => String(i.category || "")).filter(Boolean))];
  if (!ids.length) return new Map();
  const cats = await Category.find({ _id: { $in: ids } }).select("name").lean();
  return new Map(cats.map((c) => [String(c._id), c.name?.he || c.name?.en || ""]));
};

/** "אחזקה" / "חלב" — לשורות יומן של הקורא ("הזמנה נפרדת לחלב: ...") */
const splitLabelOf = (order) => order?.$locals?.splitLabel || "חלק";

const appendNote = (existing, line) => (existing ? `${existing}\n${line}` : line);

/**
 * חלוקת הסל לפי החלקים הפעילים אצל הלקוח. פונקציה טהורה, לבדיקה.
 * @returns {Array<{label, cart}>} רק חלקים שיש בהם מוצרים; הכיבוד ראשון
 */
const partitionCart = (cart, activeParts, categoryOf) => {
  const buckets = new Map([[REST_LABEL, []], ...activeParts.map((p) => [p.label, []])]);
  for (const item of cart) {
    const name = categoryOf(item);
    const part = activeParts.find((p) => p.categories.includes(name));
    buckets.get(part ? part.label : REST_LABEL).push(item);
  }
  return [...buckets.entries()]
    .filter(([, items]) => items.length)
    .map(([label, items]) => ({ label, cart: items }));
};

/**
 * מפצל את ההזמנה אם צריך. ההזמנה המקורית נשארת עם הכיבוד (ועם המשלוח),
 * ולכל חלק אחר נוצרת הזמנה חדשה באותו סטטוס. לא קורא ל-logStatusChange ולא
 * מוריד מלאי — הקורא עושה את זה לכל אחת מההזמנות שחוזרות.
 *
 * לעולם לא זורק: ההזמנה המקורית כבר נשמרה, וכשל כאן שהיה עולה לקליטה היה
 * פותח לצידה הזמנת שגיאה — אותה סחורה פעמיים. בכשל ההזמנה נשארת מעורבת.
 *
 * @param {Object} order - מסמך Order שכבר נשמר
 * @param {Object} customer - כרטיס הלקוח (צריך את billing)
 * @param {Function} saveOrder - createOrder.saveOrder (הקצאת מספר הזמנה)
 * @returns {Promise<Object[]>} [order] בלי פיצול, אחרת [order, ...החלקים]
 */
const splitDisposablesOrder = async (order, customer, saveOrder) => {
  const activeParts = PARTS.filter((p) => customer?.billing?.[p.flag]);
  if (!activeParts.length) return [order];

  const created = [];
  const before = {
    cart: order.cart,
    subTotal: order.subTotal,
    total: order.total,
    systemNote: order.systemNote,
  };

  let kept;
  try {
    const cart = order.cart || [];
    const names = await categoryNamesOf(cart);
    const parts = partitionCart(cart, activeParts, (i) => names.get(String(i.category || "")));
    if (parts.length < 2) return [order];

    [kept] = parts;
    const keptSubTotal = sumOf(kept.cart);
    const deductions = (Number(order.offerDiscount) || 0) + (Number(order.discount) || 0);
    // הנחה גדולה מהחלק שנשאר עם המשלוח הייתה משאירה הזמנה בסכום שלילי.
    // עדיף הזמנה מעורבת
    if (deductions > keptSubTotal) {
      console.warn(
        `[ingestion] הזמנה ${order.invoice}: ההנחה גדולה מסכום ה${kept.label} — לא פוצלה`
      );
      return [order];
    }

    for (const part of parts.slice(1)) {
      const subTotal = sumOf(part.cart);
      const extra = await saveOrder({
          user: order.user,
          cart: part.cart,
          user_info: order.user_info,
          subTotal,
          shippingCost: 0,
          discount: 0,
          offerDiscount: 0,
          total: subTotal,
          coupon: null,
          shippingOption: order.shippingOption,
          paymentMethod: order.paymentMethod,
          status: order.status,
          customer_note: order.customer_note,
          systemNote: appendNote(order.systemNote, `${part.label} — פוצלה מהזמנה ${order.invoice}`),
          callOnArrival: order.callOnArrival,
          usedOfferIds: [],
          shippingRewardEligible: false,
          rewardCouponCode: null,
          source: order.source,
          incomingOrder: order.incomingOrder,
      });
      // שם החלק להודעות של הקורא (splitLabelOf)
      if (extra.$locals) extra.$locals.splitLabel = part.label;
      created.push(extra);
    }

    order.cart = kept.cart;
    order.subTotal = keptSubTotal;
    order.total = Number(
      (keptSubTotal - deductions + (Number(order.shippingCost) || 0)).toFixed(2)
    );
    order.systemNote = appendNote(
      order.systemNote,
      `${kept.label} — פוצלו: ` +
        parts
          .slice(1)
          .map((part, i) => `${part.label} בהזמנה ${created[i].invoice}`)
          .join(", ")
    );
    await order.save();
  } catch (err) {
    // ההזמנות שנוצרו נמחקות, אחרת שורותיהן היו גם בהן וגם בהזמנה המקורית
    for (const extra of created) {
      await Order.deleteOne({ _id: extra._id }).catch((delErr) =>
        console.error(
          `[ingestion] מחיקת ההזמנה ${extra.invoice} נכשלה — ` +
            `יש למחוק ידנית, שורותיה כפולות בהזמנה ${order.invoice}: ${delErr.message}`
        )
      );
    }
    Object.assign(order, before);
    console.error(
      `[ingestion] פיצול ההזמנה ${order.invoice} נכשל, ההזמנה נשארה מעורבת: ${err.message}`
    );
    return [order];
  }

  console.log(
    `[ingestion] הזמנה ${order.invoice} פוצלה: ${kept.label} ${order.total} ₪, ` +
      created.map((o) => `הזמנה ${o.invoice} ${o.total} ₪`).join(", ")
  );

  return [order, ...created];
};

module.exports = {
  splitDisposablesOrder,
  partitionCart,
  splitLabelOf,
  PARTS,
  DISPOSABLES_CATEGORY,
  OFFICE_CATEGORY,
  MILK_CATEGORY,
};

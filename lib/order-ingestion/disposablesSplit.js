// lib/order-ingestion/disposablesSplit.js
//
// פיצול הזמנה מעורבת לשתי הזמנות: כיבוד, ואחזקה (ח.ניקוי+ח"פ).
//
// בקשה 05/11/2026: לקוחות עם תקציב נפרד לכיבוד ולאחזקה שולחים מייל אחד עם
// הכל, ודורשים שתי תעודות משלוח. תעודה נוצרת להזמנה (deliveryNotes.
// createFromOrder — תעודה אחת לכל הזמנה), ולכן הפיצול הוא של ההזמנה, לפני
// המעבר ל"טופלה": כל אחת מקבלת תעודה משלה, ליקוט משלה, והחשבונית החודשית
// (separateDisposablesInvoice) מקבלת תעודות "נקיות" במקום תעודה מעורבת
// שנופלת כולה לחשבונית המזון.
//
// מופעל רק אצל לקוח עם billing.separateDisposablesNote, ורק כשבהזמנה יש גם
// אחזקה וגם משהו אחר. השיוך לפי קטגוריית המוצר בקטלוג — מוצר אחזקה שרשום
// תחת "מזון" נשאר בתעודת הכיבוד. פירות נשארים עם הכיבוד.
//
// דמי המשלוח וההנחה על הסכום נשארים בהזמנת הכיבוד: זה משלוח אחד, והמינימום
// כבר נבדק על ההזמנה המלאה לפני הפיצול.

const Category = require("../../models/Category");
const Order = require("../../models/Order");
const { lineAmount } = require("../orders/lineAmount");

const DISPOSABLES_CATEGORY = 'ח.ניקוי+ח"פ';

const sumOf = (cart) => Number(cart.reduce((s, i) => s + lineAmount(i), 0).toFixed(2));

const disposablesCategoryIds = async (cart) => {
  const ids = [...new Set(cart.map((i) => String(i.category || "")).filter(Boolean))];
  if (!ids.length) return new Set();
  const cats = await Category.find({ _id: { $in: ids } }).select("name").lean();
  return new Set(
    cats
      .filter((c) => (c.name?.he || c.name?.en) === DISPOSABLES_CATEGORY)
      .map((c) => String(c._id))
  );
};

const appendNote = (existing, line) => (existing ? `${existing}\n${line}` : line);

/**
 * מפצל את ההזמנה אם צריך. ההזמנה המקורית נשארת עם הכיבוד (ועם המשלוח),
 * ונוצרת הזמנה חדשה לאחזקה באותו סטטוס. לא קורא ל-logStatusChange ולא
 * מוריד מלאי — הקורא עושה את זה לכל אחת מההזמנות שחוזרות.
 *
 * לעולם לא זורק: ההזמנה המקורית כבר נשמרה, וכשל כאן שהיה עולה לקליטה היה
 * פותח לצידה הזמנת שגיאה — אותה סחורה פעמיים. בכשל ההזמנה נשארת מעורבת.
 *
 * @param {Object} order - מסמך Order שכבר נשמר
 * @param {Object} customer - כרטיס הלקוח (צריך את billing)
 * @param {Function} saveOrder - createOrder.saveOrder (הקצאת מספר הזמנה)
 * @returns {Promise<Object[]>} [order] בלי פיצול, [order, disposablesOrder] עם
 */
const splitDisposablesOrder = async (order, customer, saveOrder) => {
  if (!customer?.billing?.separateDisposablesNote) return [order];

  let disposablesOrder = null;
  const before = {
    cart: order.cart,
    subTotal: order.subTotal,
    total: order.total,
    systemNote: order.systemNote,
  };

  try {
    const cart = order.cart || [];
    const disposableIds = await disposablesCategoryIds(cart);
    const isDisposable = (i) => disposableIds.has(String(i.category || ""));
    const disposables = cart.filter(isDisposable);
    const rest = cart.filter((i) => !isDisposable(i));
    if (!disposables.length || !rest.length) return [order];

    const restSubTotal = sumOf(rest);
    const deductions = (Number(order.offerDiscount) || 0) + (Number(order.discount) || 0);
    // הנחה גדולה מהכיבוד הייתה משאירה הזמנה בסכום שלילי. עדיף הזמנה מעורבת
    if (deductions > restSubTotal) {
      console.warn(
        `[ingestion] הזמנה ${order.invoice}: ההנחה גדולה מסכום הכיבוד — לא פוצלה`
      );
      return [order];
    }

    const disposablesSubTotal = sumOf(disposables);
    disposablesOrder = await saveOrder({
      user: order.user,
      cart: disposables,
      user_info: order.user_info,
      subTotal: disposablesSubTotal,
      shippingCost: 0,
      discount: 0,
      offerDiscount: 0,
      total: disposablesSubTotal,
      coupon: null,
      shippingOption: order.shippingOption,
      paymentMethod: order.paymentMethod,
      status: order.status,
      customer_note: order.customer_note,
      systemNote: appendNote(order.systemNote, `אחזקה — פוצלה מהזמנה ${order.invoice}`),
      callOnArrival: order.callOnArrival,
      usedOfferIds: [],
      shippingRewardEligible: false,
      rewardCouponCode: null,
      source: order.source,
      incomingOrder: order.incomingOrder,
    });

    order.cart = rest;
    order.subTotal = restSubTotal;
    order.total = Number(
      (restSubTotal - deductions + (Number(order.shippingCost) || 0)).toFixed(2)
    );
    order.systemNote = appendNote(
      order.systemNote,
      `כיבוד — האחזקה פוצלה להזמנה ${disposablesOrder.invoice}`
    );
    await order.save();
  } catch (err) {
    // הזמנת האחזקה נמחקת, אחרת שורותיה היו גם בה וגם בהזמנה המקורית
    if (disposablesOrder) {
      await Order.deleteOne({ _id: disposablesOrder._id }).catch((delErr) =>
        console.error(
          `[ingestion] מחיקת הזמנת האחזקה ${disposablesOrder.invoice} נכשלה — ` +
            `יש למחוק ידנית, שורותיה כפולות בהזמנה ${order.invoice}: ${delErr.message}`
        )
      );
    }
    Object.assign(order, before);
    console.error(
      `[ingestion] פיצול האחזקה בהזמנה ${order.invoice} נכשל, ההזמנה נשארה מעורבת: ${err.message}`
    );
    return [order];
  }

  console.log(
    `[ingestion] הזמנה ${order.invoice} פוצלה: כיבוד ${order.total} ₪, ` +
      `אחזקה בהזמנה ${disposablesOrder.invoice} ${disposablesOrder.total} ₪`
  );

  return [order, disposablesOrder];
};

module.exports = { splitDisposablesOrder, DISPOSABLES_CATEGORY };

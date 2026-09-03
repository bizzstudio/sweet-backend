// lib/orders/finalizeOrder.js
//
// "סגירת" הזמנה: כל מה שקורה להזמנה ברגע שהיא הופכת מטיוטה (Pending) להזמנה
// אמיתית שהצוות אמור לטפל בה — מעבר ל-Processing, הורדת מלאי, סימון קופון
// ומבצעים כמנוצלים, מתנת ברוכים הבאים, קופון "לקנייה הבאה" ומייל ההודעה.
//
// עד כה הקוד הזה ישב בתוך updateOrderWebHook והופעל רק כשקארדקום דיווח על
// תשלום מוצלח. הוצאתי אותו לכאן כי יש עכשיו מסלול שני שמגיע לאותה נקודה בדיוק:
// חנות ללא תשלום (PAYMENT_DISABLED) שבה ההזמנה נסגרת מיד עם השמירה.
// שני המסלולים חייבים לעשות את *אותו* דבר — אחרת הזמנה שנשמרה בלי תשלום
// לא הייתה מורידה מלאי, לא שורפת קופון ולא מודיעה לאף אחד.
require("dotenv").config();
const crypto = require("crypto");
const Coupon = require("../../models/Coupon");
const Customer = require("../../models/Customer");
const Offer = require("../../models/Offer");
const Order = require("../../models/Order");
const Status = require("../../models/Status");
const logStatusChange = require("../../utils/logStatusChange");
const { handleProductQuantity } = require("../stock-controller/others");
const { sendOrderNotificationEmail } = require("../email-sender/sender");

// יצירת קוד קופון ייחודי לקנייה הבאה (מנסה עד 10 פעמים למקרה של התנגשות).
// ללא מקף בכוונה: בתצוגה עם ריווח אותיות מקף נקרא כרווח, ולקוחות הקלידו את הקוד בלעדיו.
// 10 תווים אקראיים (32^10 ≈ 10^15 צירופים) עם crypto — הקוד הוא "טוקן למוכ"ז" בעל ערך כספי,
// והקידומת ידועה בפומבי, ולכן נדרשת אנטרופיה שמונעת ניחוש בכוח גס.
const REWARD_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ללא תווים מבלבלים (O/0, I/1)
const REWARD_CODE_LENGTH = 10;

const generateUniqueCouponCode = async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = "TOMER25";
    for (let i = 0; i < REWARD_CODE_LENGTH; i++) {
      code += REWARD_CODE_CHARS[crypto.randomInt(REWARD_CODE_CHARS.length)];
    }
    const exists = await Coupon.findOne({ couponCode: code });
    if (!exists) return code;
  }
  return null;
};

/**
 * סוגר הזמנה קיימת ומעביר אותה ל-Processing.
 *
 * @param {object} order  מסמך ההזמנה (mongoose document). כדאי שיגיע עם
 *                        populate על status ועל coupon, אך לא חובה.
 * @param {object} [opts]
 * @param {object} [opts.cardInfo]      גוף ה-webhook של קארדקום, לשמירה על
 *                                      ההזמנה לצורך זיכוי עתידי. null כשאין תשלום.
 * @param {string} [opts.functionName]  שם הפונקציה הקוראת, ליומן שינוי הסטטוס.
 * @returns {Promise<object>} מסמך ההזמנה לאחר השמירה.
 */
const finalizeOrder = async (order, { cardInfo = null, functionName = "finalizeOrder" } = {}) => {
  // הקוראים שולפים את ההזמנה בעצמם; שליפה שהחזירה null (הזמנה שנמחקה בין
  // השמירה לשליפה) חייבת להיעצר כאן ולא להתגלגל ל-TypeError עמוק בפנים.
  if (!order) {
    throw new Error("finalizeOrder: לא התקבלה הזמנה לסגירה");
  }

  const processingStatus = await Status.findOne({ name: "Processing" });
  // עצירה מפורשת במקום TypeError על processingStatus._id. הקריאה מגיעה גם
  // מהמסלול של שמירת הזמנה ללא תשלום, שם הקורא תופס את החריגה ומתריע —
  // הודעה קריאה שווה שם הרבה יותר מ-"Cannot read properties of null".
  if (!processingStatus) {
    throw new Error('סטטוס "Processing" לא נמצא במסד — אי אפשר לסגור את ההזמנה');
  }

  const previousStatus = order.status?.name || "Unknown"; // שמירת הסטטוס הקודם

  // עדכון סטטוס ההזמנה ל-"Processing"
  order.status = processingStatus._id;

  // הורדת מלאי מהמוצרים שבהזמנה
  try {
    console.log('Starting to decrease product quantities for order:', order.invoice);
    await handleProductQuantity(order.cart);
    console.log('Successfully decreased product quantities for order:', order.invoice);
  } catch (stockError) {
    console.error('Error decreasing product quantities for order', order.invoice, ':', stockError.message);
    // ממשיכים הלאה גם אם יש שגיאה במלאי
  }

  // אם יש קופון שמקושר להזמנה
  if (order.coupon) {
    const coupon = await Coupon.findById(order.coupon._id || order.coupon);

    if (coupon) {
      if (coupon.discountType.type === "percentage") {
        coupon.timesIsUsed += 1;
      } else if (coupon.discountType.type === "fixed") {
        coupon.timesIsUsed += 1;
        coupon.isUsed = true; // סימון קופון כמשומש אם הוא מסוג "fixed"
      }

      // אכיפת "פעם אחת לכל לקוח" — רישום הלקוח שמימש את הקופון
      if (coupon.oncePerCustomer && order.user) {
        const alreadyRecorded = Array.isArray(coupon.usedBy) &&
          coupon.usedBy.some((id) => id.toString() === order.user.toString());
        if (!alreadyRecorded) {
          coupon.usedBy.push(order.user);
        }
      }

      await coupon.save();
    }
  }

  // סימון מבצעים שנוצלו (רק מבצעים עם oncePerCustomer: true)
  try {
    const customer = await Customer.findById(order.user);
    if (
      customer
      && order.usedOfferIds
      && Array.isArray(order.usedOfferIds)
      && order.usedOfferIds.length > 0
    ) {
      // שליפת המבצעים שנוצלו כדי לבדוק אם הם oncePerCustomer
      const usedOffers = await Offer.find({
        _id: { $in: order.usedOfferIds },
        oncePerCustomer: true
      });

      if (usedOffers.length > 0) {
        // הוספת המבצעים לרשימת המבצעים שנוצלו של הלקוח
        const offerIdsToAdd = usedOffers
          .map(offer => offer._id.toString())
          .filter(offerId => !customer.redeemedOffers.some(id => id.toString() === offerId));

        if (offerIdsToAdd.length > 0) {
          customer.redeemedOffers.push(...offerIdsToAdd);
          await customer.save();
          console.log(`Marked ${offerIdsToAdd.length} offers as redeemed for customer ${customer.email}`);
        }
      }
    }
  } catch (offerRedemptionError) {
    console.error('Error marking offers as redeemed:', offerRedemptionError);
    // ממשיכים הלאה גם אם יש שגיאה בעדכון המבצעים
  }

  // סימון מתנת ברוכים הבאים כמנוצלת
  try {
    const hasWelcomeGiftInOrder = Array.isArray(order.cart)
      && order.cart.some((item) => item.isWelcomeGift);
    if (hasWelcomeGiftInOrder) {
      const customer = await Customer.findById(order.user);
      if (customer?.welcomeGift && customer.welcomeGift.isUsed === false) {
        customer.welcomeGift.isUsed = true;
        await customer.save();
        console.log(`Marked welcome gift as used for customer ${customer.email}`);
      }
    }
  } catch (welcomeGiftError) {
    console.error('Error marking welcome gift as used:', welcomeGiftError);
  }

  // שמירת נתוני עסקת Cardcom (כולל InternalDealNumber) לצורך החזר עתידי
  if (cardInfo && typeof cardInfo === "object") {
    order.cardInfo = cardInfo;
    console.log(
      `[Cardcom Webhook] שמירת cardInfo להזמנה ${order.invoice} | InternalDealNumber: ${cardInfo.InternalDealNumber ?? "לא נמצא"}`
    );
  }

  // הנפקת קופון "לקנייה הבאה" — ללקוח ששילם דמי משלוח ולא הגיע לסף המשלוח החינם.
  // נוצר רק בסגירת ההזמנה (כאן), פעם אחת להזמנה. קופון fixed מסומן isUsed=true אוטומטית
  // אחרי מימוש → שימוש חד-פעמי. status:"show" נדרש כדי שיהיה בר-מימוש (useCoupon דוחה "hide"),
  // ו-productType:"shippingReward" מסתיר אותו מרשימת הקופונים הציבורית.
  //
  // ההטבה היא חד-פעמית לכל לקוח (לכל החיים), ולכן "תופסים" את הלקוח אטומית עם
  // findOneAndUpdate מותנה ב-shippingRewardIssued שאינו true. רק קריאה אחת תצליח לתפוס —
  // מה שמונע גם קופון שני ללקוח חוזר וגם כפילות במירוץ webhook מקביל של אותה הזמנה.
  if (order.shippingRewardEligible && !order.rewardCouponCode && order.user) {
    let claimedCustomer = null;
    try {
      // מחזיר את המסמך שלפני העדכון (ברירת מחדל) — משמש רק כבדיקה בוליאנית
      // "האם אני זה שתפס". אין צורך ב-{ new: true }.
      claimedCustomer = await Customer.findOneAndUpdate(
        { _id: order.user, shippingRewardIssued: { $ne: true } },
        { $set: { shippingRewardIssued: true } }
      ).select("_id").lean();

      if (!claimedCustomer) {
        // הלקוח כבר קיבל קופון בעבר. ייתכן גם שקריאה מקבילה הנפיקה לאותה הזמנה —
        // נסנכרן את הקוד הקיים לזיכרון כדי ש-order.save() הסופי לא ידרוס אותו ל-null.
        const fresh = await Order.findById(order._id).select("rewardCouponCode");
        if (fresh && fresh.rewardCouponCode) {
          order.rewardCouponCode = fresh.rewardCouponCode;
        }
        console.log(`[Reward Coupon] דילוג — הלקוח כבר קיבל קופון הטבה (הזמנה ${order.invoice})`);
      } else {
        const code = await generateUniqueCouponCode();
        if (!code) throw new Error("failed to generate a unique coupon code");

        await new Coupon({
          couponCode: code,
          title: { he: "קופון לקנייה הבאה", en: "Next purchase coupon" },
          discountType: { type: "fixed", value: 25 },
          minimumAmount: 150,
          productType: "shippingReward",
          status: "show",
          endTime: new Date("2500-01-01T00:00:00Z"), // ללא תפוגה בפועל
        }).save();

        // שמירה אטומית ומיידית על ההזמנה — לא מסתמכים על order.save() שבהמשך.
        // אחרת, אם השמירה הכללית תיכשל, הדגל אצל הלקוח כבר "נשרף" והקוד היה אובד לתמיד.
        await Order.updateOne({ _id: order._id }, { $set: { rewardCouponCode: code } });

        order.rewardCouponCode = code;
        console.log(`[Reward Coupon] הונפק קופון ${code} להזמנה ${order.invoice}`);
      }
    } catch (rewardError) {
      console.error("Error creating next-purchase reward coupon:", rewardError);
      // אם תפסנו את הלקוח אך ההנפקה נכשלה — משחררים את הדגל כדי שלא יאבד את ההטבה
      if (claimedCustomer) {
        try {
          await Customer.updateOne(
            { _id: order.user },
            { $set: { shippingRewardIssued: false } }
          );
        } catch (rollbackError) {
          console.error("Failed to roll back shippingRewardIssued:", rollbackError);
        }
      }
      // לא מכשילים את סיום ההזמנה אם הנפקת הקופון נכשלה
    }
  }

  await order.save();

  // הדפסת שינוי סטטוס ההזמנה
  logStatusChange({
    from: previousStatus,
    to: "Processing",
    functionName,
    order: order,
  });

  // שליחת הודעת אימייל על הזמנה חדשה (ללקוח ולמנהלים)
  sendOrderNotificationEmail(order, order.user_info);

  return order;
};

module.exports = { finalizeOrder };

// script/createTestRewardCoupon.js
//
// יוצר קופון בדיקה זהה לקופון ההטבה האמיתי ("לקנייה הבאה") כדי לבדוק מימוש בחנות.
// הרצה:  node script/createTestRewardCoupon.js   (או: npm run coupon:test)
//
// הסקריפט מוחק קופון בדיקה קודם עם אותו קוד (אם קיים) ויוצר אותו מחדש עם isUsed:false,
// כך שאפשר להריץ שוב כדי "לאפס" את הקופון אחרי שמומש ולבדוק שוב.

// אפשר גם לאפס לקוח כדי שיוכל לקבל שוב קופון הטבה (ההטבה חד-פעמית לכל לקוח):
//   node script/createTestRewardCoupon.js someone@example.com

require("dotenv").config();
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const Coupon = require("../models/Coupon");
const Customer = require("../models/Customer");

// קוד קבוע וקל להקלדה לבדיקה (הקופונים האמיתיים מקבלים קוד רנדומלי TOMER25XXXXXX, ללא מקף)
const TEST_CODE = "TOMER25TEST01";

connectDB();

const run = async () => {
  try {
    // מחיקת קופון בדיקה קודם (אם קיים) — מאפשר להריץ שוב כדי לאפס לבדיקה חוזרת
    await Coupon.deleteOne({ couponCode: TEST_CODE });

    await new Coupon({
      couponCode: TEST_CODE,
      title: { he: "קופון בדיקה - לקנייה הבאה", en: "Test next-purchase coupon" },
      discountType: { type: "fixed", value: 25 }, // 25 ₪ הנחה קבועה
      minimumAmount: 150, // מינימום קנייה למימוש
      productType: "shippingReward", // מסמן קופון הטבה — מוסתר מרשימות הקופונים (ציבורי + ניהול)
      status: "show", // חייב "show" כדי שיהיה בר-מימוש
      endTime: new Date("2500-01-01T00:00:00Z"), // ללא תפוגה בפועל
      isUsed: false,
      timesIsUsed: 0,
    }).save();

    console.log("\n==============================================");
    console.log("  קופון הבדיקה נוצר בהצלחה!");
    console.log("  קוד לבדיקה בחנות:  " + TEST_CODE);
    console.log("  שווי: 25 ₪  |  מינימום קנייה: 150 ₪  |  חד-פעמי");
    console.log("==============================================\n");
    console.log("להרצה חוזרת (איפוס הקופון לבדיקה נוספת): node script/createTestRewardCoupon.js");

    // איפוס זכאות לקוח (אופציונלי) — כדי שיוכל לקבל שוב קופון הטבה בהזמנת בדיקה
    const email = (process.argv[2] || "").trim().toLowerCase();
    if (email) {
      const res = await Customer.updateOne(
        { email },
        { $set: { shippingRewardIssued: false } }
      );
      if (res.matchedCount) {
        console.log(`\n✓ הלקוח ${email} אופס — יקבל שוב קופון הטבה בהזמנה הבאה שמשלמת משלוח.`);
      } else {
        console.log(`\n✗ לא נמצא לקוח עם האימייל ${email}`);
      }
    }

    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error("שגיאה ביצירת קופון הבדיקה:", error);
    process.exit(1);
  }
};

run();

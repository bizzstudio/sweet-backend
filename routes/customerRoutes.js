// routes/customerRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const {
  loginCustomer,
  sendOtp,
  verifyOtp,
  registerCustomer,
  signUpWithProvider,
  verifyEmailAddress,
  forgetPassword,
  changePassword,
  resetPassword,
  getAllCustomers,
  getCustomerById,
  getCustomerDetails,
  getShippingRewardEligibility,
  updateCustomer,
  deleteCustomer,
  importCustomers,
  checkImportCustomers,
  addToBlackListByPhone,
  toggleCustomerCashier,
  validateToken,
  contactUs,
} = require("../controller/customerController");
const {
  passwordVerificationLimit,
  emailVerificationLimit,
  clientIpKeyGenerator,
} = require("../lib/email-sender/sender");
const { isAdmin, isAuth, isWhatsappServer } = require("../config/auth");

// verify email
router.post("/verify-email",
  emailVerificationLimit,
  verifyEmailAddress);

// register a user
router.post("/register/:token", registerCustomer);

// login a user
router.post("/login", loginCustomer);

// הגבלת קצב לשליחת קודי SMS - מונע ניצול לרעה (עד 5 בקשות ל-10 דקות מכל IP).
// חובה להשתמש ב-clientIpKeyGenerator כמו שאר הלימיטרים: מאחורי Cloudflare req.ip הוא
// ה-IP של Cloudflare, וללא זה כל המשתמשים היו חולקים מונה אחד ומחסימים זה את זה.
const otpRequestLimit = rateLimit({
  keyGenerator: clientIpKeyGenerator,
  windowMs: 10 * 60 * 1000,
  max: process.env.ENV === "dev" ? 100 : 5,
  handler: (req, res) => {
    res.status(429).send({
      message: "יותר מדי בקשות לקוד. נסו שוב בעוד מספר דקות.",
    });
  },
});

// כניסה בטלפון: שליחת קוד אימות ב-SMS
router.post("/send-otp", otpRequestLimit, sendOtp);

// הגבלת קצב לאימות הקוד. בלי זה אפשר היה לנחש קודים ללא הגבלה, ובעיקר לשרוף
// בכוונה את חמשת הניסיונות של מספר זר ולמחוק לו את הקוד לפני שהספיק להקליד אותו.
// התקרה גבוהה מזו של השליחה כדי לא לפגוע בלקוח שטועה בהקלדה כמה פעמים
const otpVerifyLimit = rateLimit({
  keyGenerator: clientIpKeyGenerator,
  windowMs: 10 * 60 * 1000,
  max: process.env.ENV === "dev" ? 200 : 20,
  handler: (req, res) => {
    res.status(429).send({
      message: "יותר מדי ניסיונות אימות. נסו שוב בעוד מספר דקות.",
    });
  },
});

// כניסה בטלפון: אימות הקוד והתחברות
router.post("/verify-otp", otpVerifyLimit, verifyOtp);

// validate token
router.get("/validate-token", validateToken);

// contact-us
router.post("/contact-us", contactUs);

// register or login with google
router.post("/signup-with-google", signUpWithProvider);

// add user to black list
router.put("/add-to-black-list", isWhatsappServer, addToBlackListByPhone);

// forget-password
router.put("/forget-password", passwordVerificationLimit, forgetPassword);

// reset-password
router.put("/reset-password", resetPassword);

// change password
router.post("/change-password", isAuth, changePassword);

// בדיקה מקדימה לפני יבוא אקסל של לקוחות
router.post("/import/check", isAdmin, checkImportCustomers);

// יבוא/עדכון לקוחות מאקסל לפי מספר לקוח
router.post("/import", isAdmin, importCustomers);

// get all user
router.get("/", isAdmin, getAllCustomers);

// get a user
// זכאות הלקוח המחובר לקופון "לקנייה הבאה".
// חייב להירשם *לפני* "/:id" — אחרת הנתיב הזה נבלע על ידו ונחסם ב-isAdmin.
router.get("/shipping-reward-eligible", isAuth, getShippingRewardEligibility);

// כרטיס לקוח מלא (כולל נתוני ההנהח"ש מיבוא האקסל) למסך "צפייה בלקוח"
router.get("/:id/details", isAdmin, getCustomerDetails);

router.get("/:id", isAdmin, getCustomerById);

// update a user
router.put("/:id", isAuth, updateCustomer);

// delete a user
router.delete("/:id", isAuth, deleteCustomer);

// toggle customer cashier
router.put("/toggle-cashier/:id", isAdmin, toggleCustomerCashier);

module.exports = router;

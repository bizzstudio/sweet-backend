// routes/orderPlatformRoutes.js
//
// מסך הפלטפורמות — אדמין בלבד. כל מה שיש כאן הוא פעולה שנעשית **פעם אחת
// לפלטפורמה** (אישור, התחברות) או **פעם אחת ללקוח** (מיפוי), ולא פעם אחת
// להזמנה.

const express = require("express");
const router = express.Router();

const {
  getAllPlatforms,
  getPlatformById,
  approvePlatformAndReprocess,
  updatePlatform,
  loginPlatform,
  savePastedSession,
  testPlatformLink,
  mapPlatformCustomer,
  unmapPlatformCustomer,
  getMappingSuggestion,
  getMessageScreenshot,
} = require("../controller/orderPlatformController");
const { isAdmin } = require("../config/auth");

// ── נתיבים לפי הודעה — לפני /:id, אחרת "message" ייתפס כמזהה פלטפורמה ──

// מה למפות בהודעה הזו + לקוחות מוצעים
router.get("/message/:incomingOrderId/mapping-suggestion", isAdmin, getMappingSuggestion);

// צילום המסך של הדף שנפתח (נתיב נפרד — הוא כבד)
router.get("/message/:incomingOrderId/screenshot", isAdmin, getMessageScreenshot);

// ── פלטפורמות ──

router.get("/", isAdmin, getAllPlatforms);

// "כן, זו פלטפורמת הזמנות" — ומעבד את מה שהמתין
router.post("/:id/approve", isAdmin, approvePlatformAndReprocess);

// התחברות אחת לפלטפורמה, ושמירת הסשן
router.post("/:id/login", isAdmin, loginPlatform);

// הדבקת סשן מהדפדפן — לפלטפורמה עם אימות דו-שלבי או CAPTCHA
router.post("/:id/session", isAdmin, savePastedSession);

// בדיקה שההתחברות עבדה, בלי ליצור הזמנה
router.post("/:id/test", isAdmin, testPlatformLink);

// מיפוי לקוח: המזהה שלו אצלם ← הכרטיס אצלנו
router.post("/:id/map-customer", isAdmin, mapPlatformCustomer);
router.delete("/:id/map-customer/:customerId", isAdmin, unmapPlatformCustomer);

// שם לתצוגה, חסימה, הערות, פרטי התחברות
router.put("/:id", isAdmin, updatePlatform);

// פלטפורמה בודדת — אחרי הנתיבים הספציפיים
router.get("/:id", isAdmin, getPlatformById);

module.exports = router;

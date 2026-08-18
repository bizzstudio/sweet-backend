// config/auth.js
require("dotenv").config();
const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const Status = require("../models/Status"); // הנח שאני מביא את המודל המתאים

const signInToken = (user) => {
  return jwt.sign(
    {
      _id: user._id,
      name: user.name,
      lastName: user.lastName,
      email: user.email,
      address: user.address,
      phone: user.phone,
      image: user.image,
      role: user.role,
      isCashier: user.isCashier,
      welcomeGift: user.welcomeGift,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "21d", // 21 days
    }
  );
};

const tokenForVerify = (user) => {
  return jwt.sign(
    {
      _id: user._id,
      name: user.name,
      lastName: user.lastName,
      email: user.email,
      password: user.password,
      phone: user.phone,
    },
    process.env.JWT_SECRET_FOR_VERIFY,
    { expiresIn: "15m" }
  );
};

// יצירת טוקן להזמנה - מאפשר גישה להזמנה ללא authentication
const tokenForOrder = (orderId) => {
  return jwt.sign(
    {
      orderId: orderId,
      type: "order_access",
    },
    process.env.JWT_SECRET,
    { expiresIn: "15m" } // 15 דקות
  );
};

const isAuth = async (req, res, next) => {
  const { authorization } = req.headers;
  // console.log('authorization',authorization)
  try {
    const token = authorization.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).send({
      // message: err.message,
      message: "ההזדהות נכשלה, יש להתנתק ולהתחבר לחשבונך מחדש.",
    });
  }
};

const isAdmin = async (req, res, next) => {
  const { authorization } = req.headers;
  try {
    if (!authorization || typeof authorization !== "string") {
      throw new Error("No token");
    }
    const parts = authorization.split(" ");
    const token = parts.length >= 2 ? parts[1] : null;
    if (!token) throw new Error("No token");

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const admin = await Admin.findOne({ email: decoded.email });
    if (!admin) throw new Error("User is not Admin");
    if (admin.status === "Inactive") throw new Error("User is inactive");

    req.user = {
      _id: admin._id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      iat: decoded.iat,
      exp: decoded.exp,
    };
    next();
  } catch (err) {
    console.log(err);
    res.status(401).send({
      // message: err.message,
      message: "ההזדהות נכשלה, יש לצאת ולהכנס לחשבונך מחדש.",
    });
  }
};

const isApp = async (req, res, next) => {
  const { authorization } = req.headers;

  if (!authorization) {
    return res.status(401).send('Unauthorized');
  }

  try {
    const token = authorization.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).send('Invalid or expired token');
  }
};

const loginApp = async (req, res) => {
  const { username, phone, password } = req.body;
  try {
    // מלקטים חדשים מתחברים בשם משתמש, ותיקים עדיין לפי טלפון — לכן שני
    // השדות מתקבלים והאפליקציה שולחת את מה שהוקלד בשדה היחיד שלה.
    //
    // הבדיקה typeof היא מחסום הזרקה, לא ניקוי סגנוני: express.json מפרש
    // גוף בקשה ל-JSON, ולכן { "password": { "$ne": null } } היה מגיע
    // כאובייקט לתוך השאילתה ומתאים לכל מלקט שיש לו סיסמה — עקיפת אימות
    // מלאה עבור כל מי שיודע מספר טלפון של מלקט.
    const asText = (value) => (typeof value === "string" ? value.trim() : "");

    const identifier = asText(username) || asText(phone);
    const secret = typeof password === "string" ? password : "";

    // בלי החסימה הזו מזהה ריק היה מותאם לסטטוסי ההזמנה, שנזרעים עם
    // phone: "" ויושבים באותו collection.
    if (!identifier || !secret) {
      return res.status(401).send("שם משתמש או סיסמה שגויים");
    }

    const melaket = await Status.findOne({
      password: secret,
      $or: [{ username: identifier }, { phone: identifier }],
    });
    if (!melaket) {
      return res.status(401).send("שם משתמש או סיסמה שגויים");
    }

    if (!melaket.isActive) {
      return res.status(403).send("מלקט לא פעיל!");
    }
    console.log(melaket.name + ` just log in to the App!`)

    const token = jwt.sign(
      {
        _id: melaket._id,
        isActive: melaket.isActive,
        name: melaket.name,
        heName: melaket.heName,
        username: melaket.username,
        phone: melaket.phone,
        color: melaket.color,
      },
      process.env.JWT_SECRET,
    );

    res.send({ token, melaketId: melaket._id });
  } catch (error) {
    res.status(500).send("Error logging in, please try again later");
  }
};

// Middleware: אימות שרת WhatsApp
const isWhatsappServer = async (req, res, next) => {
  try {
    // בדיקה אם המשתמש הוא אדמין
    const { authorization } = req.headers;
    if (authorization) {
      const token = authorization.split(" ")[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      // "Super Admin" חייב להיכלל — זה תפקיד ברירת המחדל של המשתמש שנוצר
      // ב-script/create-admin.js וב-script/init-db.js. אותה רשימה כמו
      // CUSTOMER_MANAGER_ROLES ב-customerController.
      if (["Admin", "Super Admin", "CEO"].includes(decoded.role)) {
        // המשתמש הוא אדמין, מאפשר להמשיך
        req.user = decoded;
        return next();
      }
    }

    // אם לא אדמין, בדיקה של ה-API key של שרת הווצאפ שלנו (sweet-whatsapp).
    //
    // זהו הכיוון ה**נכנס** בלבד. הכיוון היוצא — הקריאות מהבקאנד לשרת של קירשנר
    // ב-orderController ו-messageController — משתמש ב-KIRSHNER_WHATSAPP_API_KEY,
    // שהוא סוד של שרת אחר. שני הכיוונים חלקו בעבר מפתח אחד, מה שאילץ את שני
    // השרתים להחזיק את אותו סוד.
    //
    // המידלוור הזה שומר על 8 נקודות קצה, לא רק על ה-webhook של הקליטה: תבניות
    // ההודעות, הסקר, ורשימת החסומים. אם שרת חיצוני כלשהו עדיין קורא להן עם
    // המפתח הישן, KIRSHNER_WHATSAPP_API_KEY ממשיך להתקבל — **רק אם הוא מוגדר
    // במפורש**. מחיקתו מ-.env מבטלת את המסלול הישן לגמרי.
    const apiKey = req.headers["x-api-key"];
    const legacyKey = process.env.KIRSHNER_WHATSAPP_API_KEY;

    const accepted =
      (apiKey && apiKey === process.env.SWEET_WHATSAPP_API_KEY) ||
      (apiKey && legacyKey && apiKey === legacyKey);

    if (apiKey && legacyKey && apiKey === legacyKey) {
      console.warn(
        "[isWhatsappServer] התקבל המפתח הישן KIRSHNER_WHATSAPP_API_KEY. " +
          "יש להעביר את הקורא ל-SWEET_WHATSAPP_API_KEY ולמחוק את הישן."
      );
    }

    if (!accepted) {
      return res.status(403).send({
        success: false,
        message: "Unauthorized: Invalid WhatsApp API key",
      });
    }

    // אם ה-API key תקין, מאפשר להמשיך
    next();
  } catch (err) {
    console.error("Error in isWhatsappServer middleware:", err);
    res.status(401).send({
      success: false,
      message: "Unauthorized access",
    });
  }
};

const isCashier = async (req, res, next) => {
  const { authorization } = req.headers;
  try {
    const token = authorization.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded.isCashier) {
      throw new Error("User is not a cashier");
    }

    req.user = decoded;
    next();
  } catch (err) {
    console.log(err);
    res.status(401).send({
      message: {
        he: "גישה נדחתה - רק קופאים מורשים יכולים לבצע פעולה זו.",
        en: "Access denied - only authorized cashiers can perform this action.",
      },
    });
  }
};

// חילוץ פרטי היוזר מהבקשה
const extractUserDetails = (req, res, next) => {
  const { authorization } = req.headers;
  try {
    const token = authorization.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    req.user = {};
    next();
  }
}

// Middleware: אימות טוקן הזמנה - מאפשר גישה להזמנה עם טוקן מה-URL
// בודק טוקן רק אם אין משתמש מחובר
const isOrderTokenValid = async (req, res, next) => {
  try {
    // אם יש משתמש מחובר - לא צריך טוקן, ממשיכים הלאה
    if (req.user && req.user._id) {
      return next();
    }

    // אם אין משתמש מחובר - צריך טוקן
    const { token } = req.query;
    
    if (!token) {
      return res.status(401).send({
        message: "הקישור לא תקין או שפג תוקפו.",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // בדיקה שהטוקן הוא מסוג order_access
    if (decoded.type !== "order_access" || !decoded.orderId) {
      return res.status(401).send({
        message: "הקישור לא תקין או שפג תוקפו.",
      });
    }

    // שמירת orderId ב-req כדי להשתמש בו ב-controller
    req.orderToken = {
      orderId: decoded.orderId,
      isValid: true,
    };
    
    next();
  } catch (err) {
    res.status(401).send({
      message: "הקישור לא תקין או שפג תוקפו.",
    });
  }
};

module.exports = {
  signInToken,
  tokenForVerify,
  tokenForOrder,
  isAuth,
  isAdmin,
  isApp,
  loginApp,
  isWhatsappServer,
  isCashier,
  extractUserDetails,
  isOrderTokenValid,
};

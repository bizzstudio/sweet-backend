// controller/customerController.js
require("dotenv").config();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const Customer = require("../models/Customer");
const CustomerPriceList = require("../models/CustomerPriceList");
const Admin = require("../models/Admin");
const Application = require("../models/Application");
const Setting = require("../models/Setting");
const OtpCode = require("../models/OtpCode");
const { signInToken, tokenForVerify } = require("../config/auth");
const { sendEmail } = require("../lib/email-sender/sender");
const { sendSms } = require("../utils/smsSender");
const {
  canonicalPhone,
  isValidIsraeliMobile,
  phoneVariations,
} = require("../utils/phone");
const {
  customerRegisterBody,
} = require("../lib/email-sender/templates/register");
const {
  forgetPasswordEmailBody,
} = require("../lib/email-sender/templates/forget-password");
const { newApplicationBody } = require("../lib/email-sender/templates/new-application");
const { assignWelcomeGiftToCustomer } = require("../utils/welcomeGift");
// אותה בדיקה בדיוק שמחליטה בזמן ההפקה אם אפשר לשלוח את החשבונית. שתי
// גרסאות היו מאפשרות לשמור כתובת שהמסך מאשר וההפקה פוסלת בשקט.
const { isDeliverableEmail } = require("../lib/icount/clients");

const PHONE_TAKEN_MESSAGE =
  "מספר הטלפון הזה כבר רשום במערכת. ניתן להתחבר באמצעות המספר וקוד ב-SMS.";

// תפקידי צוות שרשאים לערוך ולמחוק לקוחות. חייב לכלול את "Super Admin" - זהו
// תפקיד ברירת המחדל של המשתמש שנוצר ב-script/create-admin.js וב-script/init-db.js,
// כלומר בלעדיו דווקא בעל ההרשאות הגבוה ביותר נחסם.
// שאר התפקידים במודל (Manager, Cashier, Driver, Accountant, Security Guard)
// לא נכללים בכוונה - הוספה כאן היא הרחבת הרשאות ודורשת החלטה עסקית
const CUSTOMER_MANAGER_ROLES = ["Admin", "Super Admin", "CEO"];

// עדכון/מחיקת לקוח מותרים ללקוח עצמו, או לאיש צוות פעיל בעל תפקיד ניהולי.
// המסלולים האלה מוגנים ב-isAuth (כי גם לקוח מעדכן דרכם את הפרופיל שלו), ולכן
// התפקיד נבדק כאן מול טבלת האדמינים ולא נלקח מהטוקן: הטוקן תקף 21 יום, ובלי
// הבדיקה הזו איש צוות שהושבת, נמחק או הורד בדרגה היה ממשיך לנהל לקוחות עד לפקיעתו.
// שאילתה נוספת מתבצעת רק במסלול הצוות - לקוח שמעדכן את עצמו יוצא מיד
const isCustomerManager = async (user) => {
  const email = user?.email;
  if (!email) return false;

  const staff = await Admin.findOne({ email }).select("role status").lean();
  return (
    !!staff &&
    staff.status !== "Inactive" &&
    CUSTOMER_MANAGER_ROLES.includes(staff.role)
  );
};

// אורך הסיסמה המינימלי שהפאנל רשאי לקבוע ללקוח
const MIN_PASSWORD_LENGTH = 6;

// קביעת סיסמה ללקוח. נשמרת מוצפנת (password) לצורך הכניסה, ובמקביל כטקסט
// גלוי (plainPassword) כדי שכרטיס הלקוח בפאנל יציג אותה. כל מקום שמשנה
// סיסמה חייב לעבור כאן - אחרת הערך הגלוי נשאר על סיסמה ישנה, והפאנל מציג
// סיסמה שכבר אינה עובדת
const setCustomerPassword = (customer, plainPassword) => {
  customer.password = bcrypt.hashSync(plainPassword);
  customer.plainPassword = plainPassword;
};

const canManageCustomer = async (user, customer) => {
  const email = user?.email;
  // בלי שתי הבדיקות האלה שני ערכים ריקים היו נחשבים לזהים ומאשרים גישה
  if (!email || !customer?.email) return false;
  if (email === customer.email) return true;

  return isCustomerManager(user);
};

// שדות ההנהח"ש שניתן לערוך ידנית ממסך הלקוח בפאנל. הרשימה סגורה בכוונה:
// הערכים הגולמיים מהקובץ (rawEmail, rawAddress, rawCity) ו-syncedAt נשמרים
// כדי לדעת מה בדיוק הגיע מהיבוא, ואסור שטופס עריכה ידרוך עליהם
const ERP_EDITABLE_FIELDS = [
  "customerNumber",
  "idNumber",
  "customerType",
  "contactPerson",
  "landline",
  "mobile",
  "agent",
  "active",
  "points",
  "discountPercent",
  "cumulativePurchase",
  "credit",
  "openingBalance",
  "priceLevel",
  "paymentTerms",
  "birthDate",
  "openDate",
  "lastPurchaseAt",
  "notes",
];

// דגלי החשבון של הלקוח בחנות. רק איש צוות רשאי לשנות אותם - המסלול מוגן
// ב-isAuth בלבד (גם לקוח מעדכן דרכו את הפרופיל שלו), ובלי ההפרדה הזו לקוח
// היה יכול להפוך את עצמו לקופאי
const STAFF_ONLY_FLAGS = [
  "isCashier",
  "inBlackList",
  "isRegistered",
  "shippingRewardIssued",
];

// בודק אם המספר כבר משויך ללקוח רשום קיים (חוץ מהרשומה שמשדרגים, אם יש).
// כניסה בטלפון מזהה לקוח לפי המספר בלבד, ולכן שני חשבונות רשומים עם אותו מספר
// שוברים אותה - לכן חוסמים הרשמה חדשה עם מספר שכבר משויך לחשבון רשום.
// בודקים רק מול חשבונות רשומים: רשומות אורח נוצרות בצ'קאאוט מפרטים לא מאומתים,
// וחסימה מולן הייתה מונעת מאדם להירשם רק כי מישהו הקליד את מספרו כאורח
const phoneTakenByRegisteredCustomer = async (phone, excludeId = null) => {
  const variations = phoneVariations(phone);
  if (!variations.length) return false; // בלי מספר תקין אין מה לחסום

  const query = { phone: { $in: variations }, isRegistered: true };
  if (excludeId) query._id = { $ne: excludeId };

  const existing = await Customer.findOne(query).select("_id");
  return !!existing;
};

// פונקציה לבדיקת תקפות הטוקן
const validateToken = async (req, res) => {
  try {
    const { authorization } = req.headers;
    const token = authorization.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    res.send(true);
  } catch (err) {
    console.error("validateToken error:", err.message);
    res.status(200).send(false);
  }
};

const verifyEmailAddress = async (req, res) => {
  try {
    console.log('verifyEmailAddress req.body: ', req.body)

    // ‎+plainPassword: השדה מוגדר select:false, והרשומה הזו עשויה לקבל כאן
    // סיסמה חדשה (setCustomerPassword) - טעינה מפורשת שומרת על ההשמה חד-משמעית
    const existingCustomer = await Customer.findOne({
      email: req.body.email.toLowerCase(),
    }).select("+plainPassword");

    // אם האימייל כבר רשום - מחזירים שגיאה (עדיפות על בדיקת הטלפון, כי זו רשומה
    // של אותו לקוח שכבר יש לו חשבון)
    if (existingCustomer && existingCustomer.isRegistered) {
      return res.status(403).send({
        message: "האימייל כבר רשום במערכת!",
      });
    }

    // חסימת הרשמה עם מספר שכבר משויך לחשבון רשום אחר - גם בהרשמה חדשה וגם בשדרוג
    // רשומת אורח לרשום. excludeId מבטיח שרשומת האורח שמשדרגים לא תיחשב כהתנגשות
    if (await phoneTakenByRegisteredCustomer(req.body.phone, existingCustomer?._id)) {
      return res.status(409).send({
        keyWord: "phoneNotUnique",
        message: PHONE_TAKEN_MESSAGE,
      });
    }

    if (existingCustomer) {
      // הלקוח קיים אבל לא רשום (אורח) - מעדכנים אותו לרשום ישר (בלי אימייל אימות)
      existingCustomer.isRegistered = true;
      existingCustomer.name = req.body.name;
      if (req.body.lastName) existingCustomer.lastName = req.body.lastName;
      if (req.body.phone) existingCustomer.phone = req.body.phone;
      if (req.body.password) {
        setCustomerPassword(existingCustomer, req.body.password);
      }
      await assignWelcomeGiftToCustomer(existingCustomer);

      await existingCustomer.save();
      console.log('Updated existing guest customer to registered in verifyEmailAddress: ', existingCustomer.email);

      // שולחים token ומחזירים תשובה שההרשמה בוצעה בהצלחה
      const token = signInToken(existingCustomer);
      return res.send({
        token,
        _id: existingCustomer._id,
        name: existingCustomer.name,
        lastName: existingCustomer.lastName,
        email: existingCustomer.email,
        phone: existingCustomer.phone,
        welcomeGift: existingCustomer.welcomeGift,
        message: "ההרשמה בוצעה בהצלחה, ברוכים הבאים!",
        keyWord: "customerRegistered",
      });
    }

    // אם הלקוח לא קיים - ממשיכים עם התהליך הרגיל של שליחת אימייל אימות
    const token = tokenForVerify(req.body);
    const option = {
      name: req.body.name,
      lastName: req.body.lastName,
      email: req.body.email,
      phone: req.body.phone,
      token: token,
    };
    const body = {
      from: `"${process.env.COMPANY_NAME}" <${process.env.EMAIL_USER}>`,
      to: `${req.body.email}`,
      subject: "אימות האימייל שלך",
      html: customerRegisterBody(option),
    };

    const message = "הרשמתך בוצעה בהצלחה. נא לגשת לתיבת האימייל שלך לבצע אימות הרשמה. במידה ולא קיבלת אימייל נא לבדוק בתיבת הספאם";
    sendEmail(body, res, message);
  } catch (error) {
    console.error('Error verifying email: ', error);
    if (!res.headersSent) {
      res.status(500).send({
        message: "התרחשה שגיאה, אנא נסו מאוחר יותר",
      });
    }
  }
};

const registerCustomer = async (req, res) => {
  const token = req.params.token;
  const { name, lastName, email, password, phone } = jwt.decode(token);
  console.log('name: ', name)
  console.log('lastName: ', lastName)
  console.log('email: ', email)
  // הסיסמה עצמה אינה נכתבת ללוג: היא מגיעה כטקסט גלוי מטוקן ההרשמה, ולוגים
  // של השרת נשמרים ונקראים במקומות שאין להם שום סיבה להחזיק סיסמאות לקוחות
  console.log('phone: ', phone)
  const isAdded = await Customer.findOne({ email: email });

  if (isAdded) {
    const token = signInToken(isAdded);
    return res.send({
      token,
      _id: isAdded._id,
      name: isAdded.name,
      lastName: isAdded.lastName,
      email: isAdded.email,
      phone: isAdded.phone,
      welcomeGift: isAdded.welcomeGift,
      message: "האימייל כבר אומת",
    });
  }

  if (token) {
    jwt.verify(token, process.env.JWT_SECRET_FOR_VERIFY, async (err, decoded) => {
      if (err) {
        return res.status(401).send({
          message: "פג תוקף הבקשה, אנא נסה שוב",
        });
      } else {
        const existingUser = await Customer.findOne({ email });
        if (existingUser) {
          return res.status(400).send({
            message: "האימייל כבר קיים במערכת",
          });
        }

        // בדיקה חוזרת גם כאן: בין שליחת אימייל האימות ללחיצה על הקישור ייתכן שנרשם
        // בינתיים לקוח אחר עם אותו מספר, ואסור ליצור כפילות אחרי שכבר עבר האימות
        if (await phoneTakenByRegisteredCustomer(phone)) {
          return res.status(409).send({
            keyWord: "phoneNotUnique",
            message: PHONE_TAKEN_MESSAGE,
          });
        }

        const newUser = new Customer({
          name,
          lastName,
          email,
          phone,
          password: bcrypt.hashSync(password),
          // נשמרת גם כטקסט גלוי לכרטיס הלקוח בפאנל (ראו setCustomerPassword)
          plainPassword: password,
          isRegistered: true,
        });
        await assignWelcomeGiftToCustomer(newUser);

        try {
          await newUser.save();
          console.log('newUser: ', newUser)
          const token = signInToken(newUser);
          res.send({
            token,
            _id: newUser._id,
            name: newUser.name,
            lastName: newUser.lastName,
            email: newUser.email,
            phone: newUser.phone,
            welcomeGift: newUser.welcomeGift,
            message: "האימייל אומת, אפשר להתחבר עכשיו!",
          });
        } catch (error) {
          console.error('Error registering customer: ', error);
          return res.status(500).send({
            message: "התרחשה שגיאה בעת שמירת המשתמש החדש",
          });
        }
      }
    });
  }
};

/* ------------------------------------------------------------------ *
 * יבוא לקוחות מקובץ אקסל של ההנהח"ש ("רשימת לקוחות")
 * העמודות מפוענחות בצד האדמין ונשלחות לכאן כשורות מנורמלות.
 * ההתאמה לפי מספר לקוח -> אימייל -> נייד. אין מחיקות ואין שינוי סיסמאות.
 * ------------------------------------------------------------------ */

const IMPORT_MAX_ROWS = 2000;
// דומיין פנימי ללקוחות מההנהח"ש שאין להם כתובת מייל.
// אימייל הוא שדה חובה וייחודי, ובלי סיסמה הם לא יכולים להתחבר.
const IMPORT_EMAIL_DOMAIN = "import.local";

const toImportText = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const toImportNum = (value) => {
  if (value === null || value === undefined || value === "") return null;
  // ערך שכבר הגיע כמספר עובר כמו שהוא. ניקוי התווים למטה נועד למחרוזות
  // עם סימני מטבע ופסיקים, אבל הוא הורס סימון מדעי שאקסל מייצר לערכים
  // קטנים או גדולים מאוד: 7.1e-15 הפך ל-null ו-1e21 הפך ל-121 בשקט
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value).trim();
  // מחרוזת שכולה מספר תקין (כולל סימון מדעי) נקראת ישירות
  const direct = Number(raw);
  if (raw !== "" && Number.isFinite(direct)) return direct;
  // ניקוי סימני מטבע/אחוז/פסיקים. בלי בדיקת הספרה, ערך שאין בו מספר כלל
  // ("abc", "-", רווחים) היה מנוקה למחרוזת ריקה, ו-Number("") מחזיר 0 - כלומר
  // זבל נשמר כאפס במקום להיחשב ריק, ובניגוד לפענוח בצד האדמין שמחזיר null
  const cleaned = raw.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  if (!/\d/.test(cleaned)) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
};

const toImportDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const placeholderEmailFor = (customerNumber) =>
  `erp-${toImportText(customerNumber).toLowerCase()}@${IMPORT_EMAIL_DOMAIN}`;

// "עיר" בקובץ מכילה לפעמים הערת אספקה ("לחנות במידטאון ולקחת מדבקה")
// ולא שם עיר. ערך כזה לא נכנס לשדה העיר אלא נשמר כטקסט חופשי.
const looksLikeCityName = (value) => {
  const text = toImportText(value);
  if (!text || text.length > 20) return false;
  if (/\d/.test(text)) return false;
  return text.split(/\s+/).length <= 3;
};

const buildCustomerErp = (row) => ({
  customerNumber: toImportText(row.customerNumber),
  contactPerson: toImportText(row.contactPerson),
  notes: toImportText(row.notes),
  idNumber: toImportText(row.idNumber),
  active: row.active === false ? false : true,
  points: toImportNum(row.points),
  discountPercent: toImportNum(row.discountPercent),
  cumulativePurchase: toImportNum(row.cumulativePurchase),
  credit: toImportNum(row.credit),
  openingBalance: toImportNum(row.openingBalance),
  agent: toImportText(row.agent),
  customerType: toImportText(row.customerType),
  priceLevel: toImportNum(row.priceLevel),
  paymentTerms: toImportNum(row.paymentTerms),
  rawEmail: toImportText(row.email),
  rawAddress: toImportText(row.address),
  rawCity: toImportText(row.city),
  mobile: toImportText(row.mobile),
  landline: toImportText(row.landline),
  birthDate: toImportDate(row.birthDate),
  openDate: toImportDate(row.openDate),
  lastPurchaseAt: toImportDate(row.lastPurchaseDate),
  syncedAt: new Date(),
});

const buildCustomerAddress = (row, existingAddress = {}) => {
  const city = looksLikeCityName(row.city)
    ? { city_name_he: toImportText(row.city) }
    : existingAddress?.city;

  // כשה"עיר" היא בעצם הערה, היא נשמרת בסוף שורת הכתובת כדי לא לאבד אותה
  const streetParts = [toImportText(row.address)];
  if (toImportText(row.city) && !looksLikeCityName(row.city)) {
    streetParts.push(toImportText(row.city));
  }

  return {
    ...(existingAddress || {}),
    ...(city ? { city } : {}),
    street: streetParts.filter(Boolean).join(", "),
    postalCode: toImportText(row.postalCode) || existingAddress?.postalCode || "",
  };
};

// בדיקה מקדימה לפני היבוא: מה קיים במערכת
// מגבלה על גודל הבדיקה המקדימה כדי שלא תיבנה שאילתת $in ענקית
const CHECK_MAX_VALUES = 20000;

const checkImportCustomers = async (req, res) => {
  try {
    const numbers = (Array.isArray(req.body?.customerNumbers) ? req.body.customerNumbers : [])
      .map((value) => toImportText(value))
      .filter(Boolean);
    const emails = (Array.isArray(req.body?.emails) ? req.body.emails : [])
      .map((value) => toImportText(value).toLowerCase())
      .filter(Boolean);
    const phones = (Array.isArray(req.body?.phones) ? req.body.phones : [])
      .map((value) => toImportText(value))
      .filter(Boolean);

    if (
      numbers.length > CHECK_MAX_VALUES ||
      emails.length > CHECK_MAX_VALUES ||
      phones.length > CHECK_MAX_VALUES
    ) {
      return res
        .status(400)
        .send({ message: `ניתן לבדוק עד ${CHECK_MAX_VALUES} רשומות בכל בקשה` });
    }

    const matchedNumbers = new Set();
    const matchedEmails = new Set();
    const matchedPhones = new Set();
    const chunkSize = 1000;

    for (let i = 0; i < numbers.length; i += chunkSize) {
      const found = await Customer.find({
        "erp.customerNumber": { $in: numbers.slice(i, i + chunkSize) },
      })
        .select("erp.customerNumber")
        .lean();
      found.forEach((c) => matchedNumbers.add(toImportText(c?.erp?.customerNumber)));
    }

    for (let i = 0; i < emails.length; i += chunkSize) {
      const found = await Customer.find({ email: { $in: emails.slice(i, i + chunkSize) } })
        .select("email")
        .lean();
      found.forEach((c) => matchedEmails.add(toImportText(c.email).toLowerCase()));
    }

    const phoneQuery = [...new Set(phones.flatMap((phone) => phoneVariations(phone)))];
    for (let i = 0; i < phoneQuery.length; i += chunkSize) {
      const found = await Customer.find({ phone: { $in: phoneQuery.slice(i, i + chunkSize) } })
        .select("phone")
        .lean();
      found.forEach((c) => matchedPhones.add(canonicalPhone(c.phone) || toImportText(c.phone)));
    }

    const totalCustomers = await Customer.countDocuments();

    res.send({
      matchedByNumber: matchedNumbers.size,
      matchedByEmail: matchedEmails.size,
      matchedByPhone: matchedPhones.size,
      existingNumbers: [...matchedNumbers],
      existingEmails: [...matchedEmails],
      totalCustomers,
    });
  } catch (err) {
    console.log("checkImportCustomers error: ", err);
    res.status(500).send({ message: err.message });
  }
};

const importCustomers = async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const rawOptions = req.body?.options || {};

    if (rows.length === 0) {
      return res.status(400).send({ message: "לא נשלחו שורות לייבוא" });
    }
    if (rows.length > IMPORT_MAX_ROWS) {
      return res
        .status(400)
        .send({ message: `ניתן לשלוח עד ${IMPORT_MAX_ROWS} שורות בכל בקשה` });
    }

    const options = {
      createNew: rawOptions.createNew !== false,
      updateExisting: rawOptions.updateExisting !== false,
      updateName: !!rawOptions.updateName,
      updatePhone: !!rawOptions.updatePhone,
      updateAddress: !!rawOptions.updateAddress,
      placeholderEmail: rawOptions.placeholderEmail !== false,
      matchByPhone: rawOptions.matchByPhone !== false,
    };

    const report = {
      received: rows.length,
      created: 0,
      updated: 0,
      skipped: 0,
      duplicates: 0,
      placeholderEmails: 0,
      emailsUpgraded: 0,
      emailConflicts: 0,
      matchedByNumber: 0,
      matchedByEmail: 0,
      matchedByPhone: 0,
      errors: [],
    };

    const addError = (row, message) => {
      report.skipped += 1;
      if (report.errors.length < 50) {
        report.errors.push({
          rowNumber: row?.rowNumber || null,
          customerNumber: toImportText(row?.customerNumber),
          name: toImportText(row?.name),
          message,
        });
      }
    };

    // 1. סינון שורות לא תקינות + הסרת מספרי לקוח כפולים באצווה
    const byNumber = new Map();
    for (const row of rows) {
      const customerNumber = toImportText(row?.customerNumber);
      const name = toImportText(row?.name);
      const email = toImportText(row?.email).toLowerCase();
      const phone = toImportText(row?.phone);

      if (!name) {
        addError(row, "חסר שם לקוח");
        continue;
      }
      if (!customerNumber) {
        addError(row, "חסר מספר לקוח");
        continue;
      }
      // החלטה מכוונת: לקוח מיובא גם בלי אימייל וגם בלי טלפון. המזהה שלו
      // נבנה ממספר הלקוח בהנהח"ש (erp-<מספר>@import.local), ובלי סיסמה הוא
      // לא יכול להתחבר. אין להוסיף כאן דילוג על פרטי קשר חסרים.
      // הדילוג היחיד הוא כשהיבוא הופעל בלי מזהה מחליף, ואז אין מה לשים
      // בשדה האימייל שהוא חובה וייחודי
      if (!email && !options.placeholderEmail) {
        addError(row, "אין כתובת אימייל");
        continue;
      }

      if (byNumber.has(customerNumber)) report.duplicates += 1;
      byNumber.set(customerNumber, { ...row, customerNumber, name, email, phone });
    }

    const validRows = [...byNumber.values()];
    if (validRows.length === 0) {
      return res.send({ ...report, message: "לא נמצאו שורות תקינות לייבוא" });
    }

    // 2. שליפת הלקוחות הקיימים לפי שלושת המזהים
    const numbers = validRows.map((row) => row.customerNumber);
    const emails = [...new Set(validRows.map((row) => row.email).filter(Boolean))];
    const placeholders = validRows.map((row) => placeholderEmailFor(row.customerNumber));
    const phones = options.matchByPhone
      ? [
          ...new Set(
            validRows
              .map((row) => row.phone)
              .filter((phone) => isValidIsraeliMobile(phone))
              .flatMap((phone) => phoneVariations(phone))
          ),
        ]
      : [];

    const found = [];
    const fetchInChunks = async (query, values) => {
      for (let i = 0; i < values.length; i += 1000) {
        const docs = await Customer.find(query(values.slice(i, i + 1000)))
          .select("_id name email phone address erp")
          .lean();
        found.push(...docs);
      }
    };

    await fetchInChunks((chunk) => ({ "erp.customerNumber": { $in: chunk } }), numbers);
    await fetchInChunks((chunk) => ({ email: { $in: chunk } }), [
      ...emails,
      ...placeholders,
    ]);
    if (phones.length) {
      await fetchInChunks((chunk) => ({ phone: { $in: chunk } }), phones);
    }

    const byId = new Map(found.map((doc) => [String(doc._id), doc]));
    const existingByNumber = new Map();
    // אימייל וטלפון מוחזקים כרשימת מועמדים ולא כמסמך בודד: כמה לקוחות
    // יכולים לחלוק טלפון של איש קשר, ושמירת הראשון בלבד הייתה מפילה מועמד
    // שכן ניתן לקשר ויוצרת לקוח כפול
    const existingByEmail = new Map();
    const existingByPhone = new Map();
    const pushCandidate = (map, key, doc) => {
      if (!key) return;
      const list = map.get(key);
      if (list) list.push(doc);
      else map.set(key, [doc]);
    };
    byId.forEach((doc) => {
      const number = toImportText(doc?.erp?.customerNumber);
      if (number && !existingByNumber.has(number)) existingByNumber.set(number, doc);
      pushCandidate(existingByEmail, toImportText(doc.email).toLowerCase(), doc);
      pushCandidate(existingByPhone, canonicalPhone(doc.phone), doc);
    });

    // 3. בניית פעולות הכתיבה
    const operations = [];
    const usedEmails = new Set([...existingByEmail.keys()]);
    // מבין המועמדים לאותו אימייל/טלפון בוחרים את זה שאפשר לקשר לשורה
    const pickLinkable = (map, key, row) =>
      (map.get(key) || []).find((candidate) => isLinkableTo(candidate, row));
    const handledIds = new Set();

    // התאמה לפי אימייל/נייד מותרת רק ללקוח שאינו כבר מקושר למספר לקוח אחר
    // בהנהח"ש. בלי התנאי הזה שתי חברות שחולקות טלפון של איש קשר היו נדרסות
    // ללקוח אחד, ורשומה אחת מההנהח"ש הייתה נעלמת.
    const isLinkableTo = (candidate, row) => {
      if (!candidate) return false;
      const linked = toImportText(candidate?.erp?.customerNumber);
      return !linked || linked === row.customerNumber;
    };

    for (const row of validRows) {
      let existing = existingByNumber.get(row.customerNumber);
      let matchedBy = existing ? "number" : "";

      if (!existing && row.email) {
        const candidate = pickLinkable(existingByEmail, row.email, row);
        if (candidate) {
          existing = candidate;
          matchedBy = "email";
        }
      }
      if (!existing && options.matchByPhone && isValidIsraeliMobile(row.phone)) {
        const candidate = pickLinkable(
          existingByPhone,
          canonicalPhone(row.phone),
          row
        );
        if (candidate) {
          existing = candidate;
          matchedBy = "phone";
        }
      }

      // לקוח קיים שכבר טופל בשורה אחרת באותה אצווה - לא נוגעים בו פעמיים
      if (existing && handledIds.has(String(existing._id))) {
        report.duplicates += 1;
        continue;
      }

      const erp = buildCustomerErp(row);

      if (existing) {
        if (!options.updateExisting) continue;
        handledIds.add(String(existing._id));
        if (matchedBy === "number") report.matchedByNumber += 1;
        if (matchedBy === "email") report.matchedByEmail += 1;
        if (matchedBy === "phone") report.matchedByPhone += 1;

        const set = { erp };
        if (options.updateName) set.name = row.name;
        if (options.updatePhone && row.phone) set.phone = row.phone;
        if (options.updateAddress && (row.address || row.city || row.postalCode)) {
          set.address = buildCustomerAddress(row, existing.address);
        }

        // לקוח שיובא בעבר עם מזהה פנימי (בגלל שלא הייתה לו כתובת) מקבל את
        // כתובת האימייל האמיתית ברגע שהיא מופיעה בקובץ. כתובת אמיתית קיימת
        // לא נדרסת אף פעם - היא המזהה שאיתו הלקוח מתחבר.
        const existingEmail = toImportText(existing.email).toLowerCase();
        const isPlaceholder = existingEmail.endsWith(`@${IMPORT_EMAIL_DOMAIN}`);
        if (isPlaceholder && row.email && !usedEmails.has(row.email)) {
          set.email = row.email;
          usedEmails.add(row.email);
          report.emailsUpgraded += 1;
        }

        operations.push({
          updateOne: { filter: { _id: existing._id }, update: { $set: set } },
        });
        report.updated += 1;
        continue;
      }

      if (!options.createNew) continue;

      // אימייל הוא מזהה ייחודי. אם המייל מהקובץ כבר תפוס בלקוח אחר,
      // הלקוח הזה נשמר עם מייל פנימי כדי לא לאבד אותו (המקורי נשמר ב-erp)
      let email = row.email;
      if (!email) {
        email = placeholderEmailFor(row.customerNumber);
        report.placeholderEmails += 1;
      } else if (usedEmails.has(email)) {
        email = placeholderEmailFor(row.customerNumber);
        report.emailConflicts += 1;
      }

      if (usedEmails.has(email)) {
        addError(row, `כתובת האימייל ${email} כבר בשימוש`);
        continue;
      }
      usedEmails.add(email);

      operations.push({
        insertOne: {
          document: {
            name: row.name,
            lastName: "",
            email,
            phone: row.phone || "",
            address: buildCustomerAddress(row),
            isRegistered: false,
            inBlackList: false,
            isCashier: false,
            erp,
          },
        },
      });
      report.created += 1;
    }

    // 4. כתיבה לבסיס הנתונים באצוות
    for (let i = 0; i < operations.length; i += 500) {
      const batch = operations.slice(i, i + 500);
      if (batch.length === 0) continue;
      try {
        // ordered: false -> שורה שנכשלת בולידציה של הסכימה מושמטת בשקט
        // והשאר נכתבות. קוראים את השגיאות מהתוצאה כדי שלא ייעלמו מהדוח
        const result = await Customer.bulkWrite(batch, { ordered: false });
        const validationErrors = result?.mongoose?.validationErrors || [];
        validationErrors.forEach((validationError) => {
          report.created = Math.max(0, report.created - 1);
          report.skipped += 1;
          if (report.errors.length < 50) {
            report.errors.push({
              rowNumber: null,
              customerNumber: "",
              name: "",
              message: validationError?.message || "השורה לא עברה ולידציה",
            });
          }
        });
      } catch (bulkErr) {
        const writeErrors = bulkErr?.writeErrors || [];
        writeErrors.forEach((writeError) => {
          const failed = writeError?.err?.op || {};
          if (failed.email) report.created = Math.max(0, report.created - 1);
          else report.updated = Math.max(0, report.updated - 1);
          report.skipped += 1;
          if (report.errors.length < 50) {
            report.errors.push({
              rowNumber: null,
              customerNumber: "",
              name: toImportText(failed.name),
              message: writeError?.errmsg || writeError?.err?.errmsg || "כתיבה נכשלה",
            });
          }
        });
        if (writeErrors.length === 0) throw bulkErr;
      }
    }

    res.send({
      ...report,
      message: `יובאו ${report.created} לקוחות חדשים, עודכנו ${report.updated} לקוחות`,
    });
  } catch (err) {
    console.log("importCustomers error: ", err);
    res.status(500).send({ message: err.message });
  }
};

const loginCustomer = async (req, res) => {
  try {
    // האימייל נשמר במודל באותיות קטנות (lowercase: true), ולכן חיפוש לפי מה
    // שהוקלד כמו שהוא לא מוצא לקוח שהוקלדה לו אות גדולה או נוסף רווח בהדבקה
    const email = String(req.body.registerEmail || "").trim().toLowerCase();
    // ‎+password: השדה select:false במודל, וההשוואה כאן היא כל תכלית השאילתה
    const customer = await Customer.findOne({ email }).select("+password");

    if (
      customer &&
      customer.password &&
      bcrypt.compareSync(req.body.password, customer.password)
    ) {
      const token = signInToken(customer);
      res.send({
        token,
        _id: customer._id,
        name: customer.name,
        lastName: customer.lastName,
        email: customer.email,
        address: customer.address,
        phone: customer.phone,
        image: customer.image,
        city: customer.city,
        welcomeGift: customer.welcomeGift,
        ...(customer.isCashier ? { isCashier: customer.isCashier } : {})
      });
    } else {
      res.status(401).send({
        message: "אימייל או סיסמה שגויים",
      });
    }
  } catch (err) {
    console.log('loginCustomer error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

// ===== כניסה בטלפון + קוד אימות ב-SMS =====

const OTP_TTL_MINUTES = 5;      // כמה דקות הקוד תקף
const OTP_MAX_ATTEMPTS = 5;     // כמה ניסיונות אימות שגויים מותרים
const OTP_RESEND_COOLDOWN = 60; // שניות מינימום בין שליחת קוד לקוד (מונע ניצול וחיוב מיותר)

const RESEND_TOO_SOON_MESSAGE = "כבר נשלח קוד. יש להמתין דקה לפני בקשת קוד חדש.";
const NO_ACCOUNT_MESSAGE = "לא נמצא חשבון עם מספר הטלפון הזה. יש להירשם תחילה.";

// כניסה בטלפון היא קיצור דרך ללקוח רשום קיים בלבד - היא לעולם לא יוצרת חשבון.
// רשומת אורח (isRegistered: false) נוצרת בצ'קאאוט מפרטים שהוקלדו בלי שום אימות,
// ולכן אינה מזכה בכניסה - אחרת די היה בהזמנת אורח עם מספר של אדם אחר.
//
// אין אילוץ ייחודיות על phone בסכמה, ולכן כמה חשבונות רשומים יכולים לשאת אותו מספר.
// במקום לחסום מצב כזה בוחרים את החשבון הרשום האחרון (החדש ביותר) - מיון לפי _id
// יורד נותן את סדר היצירה ההפוך, כך שהבחירה עקבית ותמיד אותו לקוח מקבל את הכניסה
const resolveRegisteredCustomerByPhone = async (canonical) => {
  const customer = await Customer.findOne({
    phone: { $in: phoneVariations(canonical) },
    isRegistered: true,
  }).sort({ _id: -1 });

  return { customer: customer || null };
};

// תשובה אחידה לשני השלבים כשאין אף חשבון רשום למספר
const rejectUnusablePhone = (res) =>
  res.status(404).send({
    keyWord: "customerNotFound",
    message: NO_ACCOUNT_MESSAGE,
  });

// שלב 1: שליחת קוד אימות למספר הטלפון
const sendOtp = async (req, res) => {
  try {
    const { phone } = req.body;

    if (!isValidIsraeliMobile(phone)) {
      return res.status(400).send({ message: "מספר הטלפון אינו תקין" });
    }

    const canonical = canonicalPhone(phone);

    // הבדיקה לפני שליחת ה-SMS ולא אחריה: אין טעם לחייב על הודעה למספר שלא יוכל
    // להיכנס בה, והלקוח מקבל הפניה להרשמה מיד במקום אחרי הקלדת קוד
    const { customer } = await resolveRegisteredCustomerByPhone(canonical);
    if (!customer) {
      return rejectUnusablePhone(res);
    }

    // מניעת שליחה חוזרת מהירה מדי לאותו מספר (מגן על עלות ה-SMS ועל ניצול לרעה).
    // otpAlreadySent מאפשר לקומפוננטה לקדם למסך הקוד במקום להשאיר את הלקוח תקוע -
    // הקוד הקודם עדיין תקף, ואין לו דרך אחרת לחזור אליו
    const existing = await OtpCode.findOne({ phone: canonical });
    if (
      existing &&
      Date.now() - new Date(existing.sentAt || existing.updatedAt).getTime() <
        OTP_RESEND_COOLDOWN * 1000
    ) {
      return res.status(429).send({
        keyWord: "otpAlreadySent",
        message: RESEND_TOO_SOON_MESSAGE,
      });
    }

    const code = String(crypto.randomInt(100000, 1000000)); // קוד בן 6 ספרות
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    // שמירה/דריסה של הקוד עבור מספר זה
    try {
      await OtpCode.findOneAndUpdate(
        { phone: canonical },
        { code, attempts: 0, expiresAt, sentAt: new Date() },
        { upsert: true, new: true }
      );
    } catch (upsertErr) {
      // שתי בקשות במקביל לאותו מספר - האינדקס הייחודי מוודא שרק אחת יוצרת קוד,
      // והשנייה מקבלת בדיוק את אותה תשובה כמו בקשה מוקדמת מדי
      if (upsertErr.code === 11000) {
        return res.status(429).send({
          keyWord: "otpAlreadySent",
          message: RESEND_TOO_SOON_MESSAGE,
        });
      }
      throw upsertErr;
    }

    try {
      await sendSms(
        canonical,
        `קוד ההתחברות שלך ל${process.env.COMPANY_NAME || "המתוקים של בני"}: ${code}`
      );
    } catch (smsErr) {
      // אם השליחה נכשלה - מוחקים את הקוד כדי לאפשר ניסיון חוזר מיידי
      await OtpCode.deleteOne({ phone: canonical });
      throw smsErr;
    }

    return res.send({ message: "קוד אימות נשלח בהודעת SMS" });
  } catch (err) {
    // סיבת הכשל של הספק (מפתח שגוי, יתרה נגמרה וכו') היא מידע תפעולי - נרשם בלוג בלבד
    // ולא נחשף ללקוח
    console.log("sendOtp error: ", err.smsReason || err.message);
    return res.status(500).send({
      message: "שליחת הקוד נכשלה, אנא נסו שוב",
    });
  }
};

// שלב 2: אימות הקוד והתחברות ללקוח רשום קיים
const verifyOtp = async (req, res) => {
  try {
    const { phone, code } = req.body;

    if (!isValidIsraeliMobile(phone) || !code) {
      return res.status(400).send({ message: "חסרים פרטים לאימות" });
    }

    const canonical = canonicalPhone(phone);
    const otp = await OtpCode.findOne({ phone: canonical });

    if (!otp || otp.expiresAt < new Date()) {
      if (otp) await OtpCode.deleteOne({ _id: otp._id });
      return res.status(400).send({ message: "הקוד פג תוקף, יש לבקש קוד חדש" });
    }

    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      await OtpCode.deleteOne({ _id: otp._id });
      return res.status(400).send({ message: "יותר מדי ניסיונות, יש לבקש קוד חדש" });
    }

    if (String(code) !== otp.code) {
      otp.attempts += 1;
      await otp.save();
      return res.status(400).send({ message: "הקוד שגוי" });
    }

    // איתור החשבון לפני צריכת הקוד: הבדיקה שב-sendOtp אינה מספיקה כי החשבון עשוי
    // היה להימחק בין שני השלבים, ואם השליפה נכשלת אין סיבה לשרוף קוד תקף
    const { customer } = await resolveRegisteredCustomerByPhone(canonical);
    if (!customer) {
      return rejectUnusablePhone(res);
    }

    // הקוד תקין ויש חשבון - מוחקים אותו (חד-פעמי)
    await OtpCode.deleteOne({ _id: otp._id });

    const token = signInToken(customer);
    return res.send({
      token,
      _id: customer._id,
      name: customer.name,
      lastName: customer.lastName,
      email: customer.email,
      address: customer.address,
      phone: customer.phone,
      image: customer.image,
      city: customer.city,
      welcomeGift: customer.welcomeGift,
      ...(customer.isCashier ? { isCashier: customer.isCashier } : {}),
    });
  } catch (err) {
    console.log("verifyOtp error: ", err.message);
    return res.status(500).send({ message: "אירעה שגיאה, אנא נסו שוב" });
  }
};

const forgetPassword = async (req, res) => {
  const isAdded = await Customer.findOne({ email: req.body.verifyEmail });
  if (!isAdded) {
    return res.status(404).send({
      message: "לא נמצא משתמש עם אמייל כזה",
    });
  } else {
    const token = tokenForVerify(isAdded);
    const option = {
      name: isAdded.name,
      lastName: isAdded.lastName || '',
      email: isAdded.email,
      token: token,
    };

    const body = {
      from: `"${process.env.COMPANY_NAME}" <${process.env.EMAIL_USER}>`,
      to: `${req.body.verifyEmail}`,
      subject: "הסיסמה אופסה",
      html: forgetPasswordEmailBody(option),
    };

    const message = "זה הצליח! יש לבדוק את חשבון האימייל כדי לאפס את הסיסמה";
    sendEmail(body, res, message);
  }
};

const resetPassword = async (req, res) => {
  const token = req.body.token;
  const { email } = jwt.decode(token);
  // ‎+plainPassword: השדה select:false ונכתב כאן מחדש (setCustomerPassword)
  const customer = await Customer.findOne({ email: email }).select(
    "+plainPassword"
  );

  if (token) {
    jwt.verify(token, process.env.JWT_SECRET_FOR_VERIFY, (err, decoded) => {
      if (err) {
        console.log('resetPassword error: ', err);
        return res.status(500).send({
          message: "פג תוקף הבקשה, אנא נסה שוב",
        });
      } else {
        setCustomerPassword(customer, req.body.newPassword);
        customer.save();
        res.send({
          message: "הסיסמה הוחלפה בהצלחה, אפשר להתחבר עכשיו!",
        });
      }
    });
  }
};

const changePassword = async (req, res) => {
  try {
    // ‎+password: נדרש להשוואה מול הסיסמה הנוכחית (select:false במודל)
    // ‎+plainPassword: השדה select:false ונכתב כאן מחדש (setCustomerPassword)
    const customer = await Customer.findOne({ email: req.body.email }).select(
      "+password +plainPassword"
    );
    // אימייל שאינו קיים הפיל כאן את הבקשה ב-TypeError והוחזר 500 במקום 404
    if (!customer) {
      return res.status(404).send({ message: "לקוח לא נמצא" });
    }
    if (req?.user?.email !== customer.email) {
      return res.status(403).send({
        message: "You are not authorized to change this password!",
      });
    }
    if (!customer.password) {
      return res.send({
        message:
          "כדי לשנות סיסמה - יש להתחבר עם אימייל וסיסמה",
      });
    } else if (
      customer &&
      bcrypt.compareSync(req.body.currentPassword, customer.password)
    ) {
      setCustomerPassword(customer, req.body.newPassword);
      await customer.save();
      res.send({
        message: "הסיסמה שונתה בהצלחה!",
      });
    } else {
      res.status(401).send({
        message: "אימייל או סיסמה שגויים!",
      });
    }
  } catch (err) {
    console.log('changePassword error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const signUpWithProvider = async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).send({
        message: {
          en: "An error occurred while logging in with Google, please try again later",
          he: "התרחשה שגיאה בכניסה עם גוגל, נסו שוב מאוחר יותר"
        }
      });
    }

    // קבלת google_client_id מה-Setting
    const storeSetting = await Setting.findOne({ name: "storeSetting" });
    if (!storeSetting || !storeSetting.setting?.google_client_id) {
      console.error("An error occurred while logging in with Google");
      console.error("googleClientId :>> ", storeSetting.setting?.google_client_id);
      return res.status(500).send({
        message: {
          en: "An error occurred while logging in with Google, please try again later",
          he: "התרחשה שגיאה בכניסה עם גוגל, נסו שוב מאוחר יותר"
        }
      });
    }

    const googleClientId = storeSetting.setting.google_client_id;

    // אימות הטוקן מגוגל
    const client = new OAuth2Client(googleClientId);
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: googleClientId,
    });

    const payload = ticket.getPayload();
    const email = payload.email.toLowerCase();
    const name = payload.given_name || payload.name || '';
    const lastName = payload.family_name || '';
    const picture = payload.picture || '';

    // חיפוש לקוח קיים
    const existingCustomer = await Customer.findOne({ email });

    if (existingCustomer) {
      // אם הלקוח קיים אבל לא רשום - מעדכנים אותו לרשום
      if (!existingCustomer.isRegistered) {
        existingCustomer.isRegistered = true;
        // מעדכנים פרטים נוספים אם קיימים
        if (name) existingCustomer.name = name;
        if (lastName) existingCustomer.lastName = lastName;
        if (picture) existingCustomer.image = picture;
        await assignWelcomeGiftToCustomer(existingCustomer);

        await existingCustomer.save();
        console.log('Updated existing guest customer to registered via provider: ', existingCustomer._id);
      }

      const token = signInToken(existingCustomer);
      return res.send({
        token,
        _id: existingCustomer._id,
        name: existingCustomer.name,
        lastName: existingCustomer.lastName,
        email: existingCustomer.email,
        address: existingCustomer.address,
        phone: existingCustomer.phone,
        image: existingCustomer.image,
        welcomeGift: existingCustomer.welcomeGift,
        ...(existingCustomer.isCashier ? { isCashier: existingCustomer.isCashier } : {})
      });
    }

    // אם הלקוח לא קיים - יוצרים לקוח חדש רשום
    const newUser = new Customer({
      name: name,
      lastName: lastName || '',
      email: email,
      image: picture,
      isRegistered: true,
    });
    await assignWelcomeGiftToCustomer(newUser);

    const signUpCustomer = await newUser.save();
    console.log('Created new registered customer via provider: ', signUpCustomer.email);
    const token = signInToken(signUpCustomer);
    res.send({
      token,
      _id: signUpCustomer._id,
      name: signUpCustomer.name,
      lastName: signUpCustomer.lastName,
      email: signUpCustomer.email,
      image: signUpCustomer.image,
      welcomeGift: signUpCustomer.welcomeGift,
    });
  } catch (err) {
    console.log('signUpWithProvider error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

/*
 * \u05E8\u05E9\u05D9\u05DE\u05EA \u05D4\u05DC\u05E7\u05D5\u05D7\u05D5\u05EA \u05DC\u05DE\u05E1\u05DA "\u05DC\u05E7\u05D5\u05D7\u05D5\u05EA" \u05D5\u05DC\u05D1\u05D5\u05E8\u05E8\u05D9 \u05D4\u05DC\u05E7\u05D5\u05D7\u05D5\u05EA (\u05D4\u05E6\u05E2\u05D5\u05EA \u05DE\u05D7\u05D9\u05E8, \u05EA\u05E2\u05D5\u05D3\u05D4 \u05D9\u05D3\u05E0\u05D9\u05EA,
 * \u05E4\u05DC\u05D8\u05E4\u05D5\u05E8\u05DE\u05D5\u05EA). \u05D4\u05E8\u05E9\u05D9\u05DE\u05D4 \u05E0\u05D8\u05E2\u05E0\u05EA \u05D1\u05DE\u05DC\u05D5\u05D0\u05D4 \u05D1\u05DB\u05D5\u05D5\u05E0\u05D4 \u2014 \u05D4\u05D7\u05D9\u05E4\u05D5\u05E9 \u05D5\u05D4\u05D3\u05E4\u05D3\u05D5\u05E3 \u05E8\u05E6\u05D9\u05DD \u05D1\u05E6\u05D3 \u05D4\u05DC\u05E7\u05D5\u05D7,
 * \u05D5\u05DB\u05DA \u05EA\u05D9\u05D1\u05EA \u05D4\u05D7\u05D9\u05E4\u05D5\u05E9 \u05DE\u05D5\u05E6\u05D0\u05EA \u05DB\u05DC \u05DC\u05E7\u05D5\u05D7 \u05D5\u05DC\u05D0 \u05E8\u05E7 \u05D0\u05EA \u05DE\u05D9 \u05E9\u05E0\u05DE\u05E6\u05D0 \u05D1\u05E2\u05DE\u05D5\u05D3 \u05D4\u05E0\u05D5\u05DB\u05D7\u05D9.
 *
 * \u05DE\u05D4 \u05E9\u05DB\u05DF \u05E6\u05D5\u05DE\u05E6\u05DD: \u05D4\u05E9\u05D3\u05D5\u05EA. \u05E2\u05D3 \u05DB\u05D0\u05DF \u05D7\u05D6\u05E8\u05D5 \u05DE\u05E1\u05DE\u05DB\u05D9 \u05D4\u05DC\u05E7\u05D5\u05D7 \u05D1\u05DE\u05DC\u05D5\u05D0\u05DD, \u05DB\u05D5\u05DC\u05DC \u05D4-hash \u05E9\u05DC \u05D4\u05E1\u05D9\u05E1\u05DE\u05D4
 * (\u05D4\u05E9\u05D3\u05D4 \u05DC\u05D0 \u05D4\u05D9\u05D4 select:false), \u05E2\u05DC \u05E4\u05E0\u05D9 \u05DE\u05D0\u05D5\u05EA \u05DC\u05E7\u05D5\u05D7\u05D5\u05EA. \u05D4\u05E8\u05E9\u05D9\u05DE\u05D4 \u05DB\u05D0\u05DF \u05D4\u05D9\u05D0 \u05D1\u05D3\u05D9\u05D5\u05E7 \u05DE\u05D4
 * \u05E9\u05D4\u05DE\u05E1\u05DB\u05D9\u05DD \u05E7\u05D5\u05E8\u05D0\u05D9\u05DD \u2014 \u05DB\u05DC \u05E9\u05D3\u05D4 \u05E0\u05D5\u05E1\u05E3 \u05E9\u05D9\u05D9\u05D3\u05E8\u05E9 \u05D1\u05E2\u05EA\u05D9\u05D3 \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05EA\u05D5\u05D5\u05E1\u05E3 \u05D1\u05DE\u05E4\u05D5\u05E8\u05E9.
 */
// erp.customerNumber נכלל כדי שתיבת החיפוש תמצא לקוח לפי מספר הלקוח
// בהנהח"ש ולא רק לפי שם, והמספר גם מוצג בעמודת המזהה בטבלה
const CUSTOMER_LIST_FIELDS =
  "name lastName email phone isCashier createdAt erp.customerNumber";

const getAllCustomers = async (req, res) => {
  try {
    const users = await Customer.find({}).select(CUSTOMER_LIST_FIELDS).lean();

    // Collator \u05D0\u05D7\u05D3 \u05DC\u05DB\u05DC \u05D4\u05DE\u05D9\u05D5\u05DF; localeCompare \u05DC\u05DB\u05DC \u05D4\u05E9\u05D5\u05D5\u05D0\u05D4 \u05D1\u05D5\u05E0\u05D4 \u05D0\u05D5\u05EA\u05D5 \u05DE\u05D7\u05D3\u05E9
    const collator = new Intl.Collator("he");
    // \u05DC\u05E7\u05D5\u05D7 \u05E9\u05D9\u05D5\u05D1\u05D0 \u05D1\u05DC\u05D9 \u05E9\u05DD \u05D4\u05D9\u05D4 \u05DE\u05E4\u05D9\u05DC \u05DB\u05D0\u05DF \u05D0\u05EA \u05DB\u05DC \u05D4\u05D1\u05E7\u05E9\u05D4 \u05D1-TypeError, \u05D5\u05D4\u05DE\u05E1\u05DA \u05D4\u05D9\u05D4
    // \u05DE\u05E6\u05D9\u05D2 \u05E9\u05D2\u05D9\u05D0\u05D4 \u05D1\u05DE\u05E7\u05D5\u05DD \u05E8\u05E9\u05D9\u05DE\u05D4
    const nameOf = (customer) =>
      typeof customer?.name === "string" ? customer.name : "";

    users.sort((a, b) => {
      const nameA = nameOf(a);
      const nameB = nameOf(b);
      const isANameHebrew = /^[\u0590-\u05FF]+$/.test(nameA);
      const isBNameHebrew = /^[\u0590-\u05FF]+$/.test(nameB);

      if (isANameHebrew && !isBNameHebrew) return -1;
      if (!isANameHebrew && isBNameHebrew) return 1;
      return collator.compare(nameA, nameB);
    });
    res.send(users);
  } catch (err) {
    console.log('getAllCustomers error: ', err);
    res.status(500).send({ message: err.message });
  }
};

// האם הלקוח המחובר עדיין זכאי לקופון "לקנייה הבאה" (הטבה חד-פעמית לכל לקוח).
// משמש את דף התשלום כדי לא להבטיח קופון למי שכבר קיבל.
const getShippingRewardEligibility = async (req, res) => {
  try {
    const customer = await Customer.findById(req.user._id).select("shippingRewardIssued");
    if (!customer) {
      return res.status(404).send({ message: "לקוח לא נמצא" });
    }
    res.send({ eligible: customer.shippingRewardIssued !== true });
  } catch (err) {
    console.log('getShippingRewardEligibility error: ', err);
    res.status(500).send({ message: err.message });
  }
};

const getCustomerById = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    res.send(customer);
  } catch (err) {
    console.log('getCustomerById error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

// כרטיס לקוח מלא למסך "צפייה בלקוח" באדמין: כל שדות החנות יחד עם נתוני
// ההנהח"ש מיבוא האקסל. erp מוגדר select:false במודל ולכן צריך לבקש אותו
// במפורש - בלי זה המסך היה מציג רק שם, מייל וטלפון.
// הצורה המוצפנת של הסיסמה מוסרת - אין בה שום שימוש במסך; מה שכן יוצא הוא
// הסיסמה כטקסט גלוי (plainPassword), כדי שאפשר יהיה לראות אותה בכרטיס
// ולהיכנס איתה לחנות, ולצידה סימון האם ללקוח יש סיסמה בכלל
const getCustomerDetails = async (req, res) => {
  try {
    // ‎+password: נטען רק כדי לחשב את hasPassword למטה, ונמחק מיד אחר כך
    const customer = await Customer.findById(req.params.id)
      .select("+erp +password +plainPassword")
      .lean();

    if (!customer) {
      return res.status(404).send({ message: "לקוח לא נמצא" });
    }

    // ללקוח שקבע לעצמו סיסמה לפני שהשדה הגלוי נוסף אין plainPassword, ולכן
    // הסימון הזה הוא מה שמבדיל בין "אין סיסמה" ל"יש סיסמה שאינה ניתנת לצפייה"
    customer.hasPassword = !!customer.password;
    delete customer.password;

    // הסיסמה הגלויה נחשפת רק לתפקידים שרשאים גם לקבוע אותה. isAdmin מכניס
    // לכאן כל איש צוות פעיל - גם נהג, מלקט או קופאי - ובלעדי הסינון הזה כל
    // אחד מהם היה יכול לקרוא את הסיסמה של כל לקוח ולהיכנס לחנות בשמו.
    // התפקיד נלקח מ-req.user שאותו isAdmin טוען מהמסד, ולכן אין כאן שאילתה נוספת
    if (!CUSTOMER_MANAGER_ROLES.includes(req?.user?.role)) {
      delete customer.plainPassword;
    }

    res.send(customer);
  } catch (err) {
    console.log("getCustomerDetails error: ", err);
    // מזהה שאינו ObjectId תקין מפיל את findById ב-CastError. בלי ההפרדה הזו
    // הפאנל היה מציג שגיאת שרת פנימית עם נוסח של mongoose במקום "לקוח לא נמצא"
    if (err?.name === "CastError") {
      return res.status(404).send({ message: "לקוח לא נמצא" });
    }
    res.status(500).send({
      message: err.message,
    });
  }
};

const updateCustomer = async (req, res) => {
  try {
    // ‎+erp כדי שעריכת נתוני ההנהח"ש תמזג לתוך מה שקיים ולא תיצור אובייקט חדש
    // שמאבד את הערכים הגולמיים מהקובץ (erp מוגדר select:false במודל).
    // ‎+plainPassword כדי לזהות שהסיסמה שנשלחה זהה לזו השמורה ולא להצפין
    // אותה מחדש בכל שמירה של הכרטיס
    const customer = await Customer.findById(req.params.id).select(
      "+erp +plainPassword"
    );
    if (customer) {
      if (!(await canManageCustomer(req?.user, customer))) {
        return res.status(403).send({
          message: "You are not authorized to update this customer!",
        });
      }
      // נקבע לפי האימייל שלפני העדכון, אחרת לקוח שמשנה את האימייל של עצמו
      // היה נחשב בטעות לאיש צוות שעורך לקוח אחר ולא היה מקבל טוקן מעודכן
      const isSelfUpdate = req?.user?.email === customer.email;

      // מעדכנים רק שדות שנשלחו בפועל. טופס עריכת הלקוח בפאנל שולח שם/אימייל/טלפון
      // בלבד, ולכן השמה עיוורת של כל השדות הייתה מוחקת ללקוח את הכתובת והתמונה
      if (req.body.name !== undefined) customer.name = req.body.name;
      if (req.body.lastName !== undefined) customer.lastName = req.body.lastName;
      if (req.body.email !== undefined) customer.email = req.body.email;
      if (req.body.address !== undefined) customer.address = req.body.address;
      // נרמול נייד ישראלי לפורמט 05XXXXXXXX. בלי זה מספר שנשמר עם מקפים או רווחים
      // אינו נמצא בכניסה בטלפון, והלקוח נתקע: הכניסה אומרת שאין חשבון וההרשמה
      // אומרת שהאימייל כבר רשום. כל פורמט אחר נשמר כפי שהוא
      if (req.body.phone !== undefined) {
        customer.phone = isValidIsraeliMobile(req.body.phone)
          ? canonicalPhone(req.body.phone)
          : req.body.phone;
      }
      if (req.body.image !== undefined) customer.image = req.body.image;

      // מסך הלקוח בפאנל עורך גם את דגלי החשבון ואת נתוני ההנהח"ש. שניהם
      // פתוחים לאיש צוות בלבד: לקוח שמעדכן את הפרופיל של עצמו עובר באותו
      // מסלול, ובלי ההפרדה הוא היה יכול להעניק לעצמו הרשאות או לשנות יתרות.
      // בדיקת התפקיד עולה שאילתה, ולכן היא נעשית רק כשהבקשה בכלל מנסה לגעת
      // בשדות האלה - עדכון פרופיל רגיל מהחנות לא משלם עליה
      const touchesStaffFields =
        req.body.erp !== undefined ||
        req.body.billing !== undefined ||
        req.body.welcomeGift !== undefined ||
        req.body.password !== undefined ||
        STAFF_ONLY_FLAGS.some((flag) => req.body[flag] !== undefined);

      // הגדרות החיוב נדחות במפורש למי שאינו מורשה, ולא נבלעות בשקט.
      // הבליעה השקטה (ההתנהגות של שאר השדות כאן) גורמת למסך להציג
      // "נשמר" כשלא נשמר כלום — ובהגדרה שקובעת איך הלקוח מחויב, פער
      // בין מה שרואים למה שקיים הוא בדיוק סוג הטעות שמגיעה לחשבונית.
      if (req.body.billing !== undefined && !(await isCustomerManager(req?.user))) {
        return res.status(403).send({
          message: "אין לך הרשאה לשנות את הגדרות החיוב של הלקוח.",
        });
      }

      if (touchesStaffFields && (await isCustomerManager(req?.user))) {
        STAFF_ONLY_FLAGS.forEach((flag) => {
          if (req.body[flag] !== undefined) customer[flag] = !!req.body[flag];
        });

        // קביעת סיסמה ללקוח מהפאנל, כדי שאפשר יהיה להיכנס איתה לחנות בשמו.
        // הטופס שולח את השדה רק כשהוא שונה מהסיסמה השמורה, ולכן שמירה רגילה
        // של הכרטיס אינה נוגעת בסיסמה בכלל
        if (req.body.password !== undefined) {
          // בדיקת typeof ולא רק המרה למחרוזת: גוף בקשה ב-JSON יכול להביא
          // אובייקט או מערך, ו-String() היה הופך אותו ל"סיסמה" תקינה לכאורה
          // ("[object Object]") שנשמרת בפועל ללקוח
          if (req.body.password !== null && typeof req.body.password !== "string") {
            return res.status(400).send({ message: "סיסמה לא תקינה." });
          }

          const newPassword = String(req.body.password || "").trim();

          if (!newPassword) {
            // ניקוי מכוון של השדה מבטל את הכניסה עם סיסמה. הלקוח עדיין יכול
            // להיכנס עם מספר טלפון וקוד ב-SMS
            customer.password = undefined;
            customer.plainPassword = undefined;
          } else if (newPassword.length < MIN_PASSWORD_LENGTH) {
            return res.status(400).send({
              message: `הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים.`,
            });
          } else if (newPassword !== customer.plainPassword) {
            setCustomerPassword(customer, newPassword);
            // לקוח שיש לו סיסמה יכול להיכנס לחנות, ולכן אין מצב שהוא מסומן
            // כלא רשום. נקבע אחרי הלולאה של STAFF_ONLY_FLAGS כדי לגבור על
            // המתג בטופס, שאינו יודע שנקבעה עכשיו סיסמה
            customer.isRegistered = true;
          }
        }

        if (req.body.welcomeGift?.isUsed !== undefined) {
          customer.set("welcomeGift.isUsed", !!req.body.welcomeGift.isUsed);
        }

        // מיזוג ולא השמה: הטופס שולח רק את השדות שהוא מציג. ללקוח שנרשם
        // בחנות אין erp כלל, והוא לא נוצר כאן - "לקוח חנות" נקבע לפי קיומו
        if (req.body.erp && customer.erp) {
          ERP_EDITABLE_FIELDS.forEach((field) => {
            if (req.body.erp[field] === undefined) return;
            const value = req.body.erp[field];
            // מחרוזת ריקה בשדה מספר/תאריך נכשלת בהמרה של mongoose, ולכן
            // "ניקוי" שדה נשמר כ-null ולא כ-""
            customer.erp[field] = value === "" ? null : value;
          });
        }

        // הגדרות החיוב שניתנות לעריכה מהפאנל. icountClientId אינו ביניהן —
        // הוא נכתב על ידי הסנכרון בלבד, ומסך שהיה דורס אותו בערך ישן היה
        // גורם ליצירת כרטיס לקוח כפול ב-iCount.
        if (req.body.billing?.splitInvoiceByCategory !== undefined) {
          customer.set(
            "billing.splitInvoiceByCategory",
            !!req.body.billing.splitInvoiceByCategory
          );
        }

        // אחוז ההנחה הקבוע של הלקוח. יורד מכל מסמך שמופק לו מכאן והלאה
        // (תעודה, הצעה, חשבונית) — ראה lib/billing/pricing.
        //
        // null = ניקוי מכוון, וחזרה לאחוז שהגיע בייבוא מנוע
        // (erp.discountPercent). 0 = בלי הנחה, וגובר על הייבוא. ההבחנה
        // חשובה: לקוח שההנחה שלו בוטלה במפורש אסור שיקבל אותה בחזרה
        // בייבוא האקסל הבא.
        if (req.body.billing?.discountPercent !== undefined) {
          const raw = req.body.billing.discountPercent;

          if (raw === null || raw === "") {
            customer.set("billing.discountPercent", undefined);
          } else {
            const pct = Number(raw);
            if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
              return res.status(400).send({
                message: `אחוז הנחה לא תקין: "${raw}". יש להזין מספר בין 0 ל-100.`,
              });
            }
            customer.set("billing.discountPercent", pct);
          }
        }

        // האם החשבונית החודשית מרכזת את השורות לפי קטגוריה, או מפרטת כל
        // מוצר. ראה lib/billing/monthlyBilling.
        if (req.body.billing?.summarizeInvoiceLines !== undefined) {
          customer.set(
            "billing.summarizeInvoiceLines",
            !!req.body.billing.summarizeInvoiceLines
          );
        }

        // מסלול החיוב. ערך לא מוכר נדחה במפורש ולא נשמר כברירת מחדל —
        // לקוח שאמור לקבל חשבונית מיד ונשמר בטעות כחודשי יגלה את זה רק
        // בסוף החודש.
        if (req.body.billing?.mode !== undefined) {
          const mode = String(req.body.billing.mode);
          if (!["monthly", "perDelivery"].includes(mode)) {
            return res.status(400).send({
              message: `מסלול חיוב לא מוכר: "${mode}". אפשרויות: monthly, perDelivery`,
            });
          }
          customer.set("billing.mode", mode);
        }

        // כתובת המייל לחשבוניות. שדה חופשי ולא ייחודי — הנהלת חשבונות אחת
        // יכולה לשרת כמה לקוחות. כתובת פגומה נדחית ולא נשמרת: היא תתגלה רק
        // בסוף החודש, כשהחשבונית תופק ולא תישלח לאיש.
        if (req.body.billing?.invoiceEmail !== undefined) {
          const raw = req.body.billing.invoiceEmail;
          if (raw !== null && typeof raw !== "string") {
            return res.status(400).send({ message: "כתובת מייל לחשבוניות אינה תקינה." });
          }

          const invoiceEmail = String(raw || "").trim().toLowerCase();

          // ריק = ניקוי מכוון, וחזרה לכתובת הרגילה של הלקוח
          if (invoiceEmail && !isDeliverableEmail(invoiceEmail)) {
            return res.status(400).send({
              message: `"${invoiceEmail}" אינה כתובת מייל שאפשר לשלוח אליה חשבונית.`,
            });
          }

          customer.set("billing.invoiceEmail", invoiceEmail || undefined);
        }
      }

      const updatedUser = await customer.save();
      // הטוקן נועד לרענן את החיבור של הלקוח בחנות אחרי עדכון הפרופיל. איש צוות
      // שעורך לקוח אחר אינו זקוק לו, ואין סיבה להנפיק לו טוקן התחברות של הלקוח
      const token = isSelfUpdate ? signInToken(updatedUser) : undefined;
      res.send({
        token,
        _id: updatedUser._id,
        name: updatedUser.name,
        lastName: updatedUser.lastName,
        email: updatedUser.email,
        address: updatedUser.address,
        phone: updatedUser.phone,
        image: updatedUser.image,
        city: updatedUser.city,
        isCashier: updatedUser.isCashier,
        welcomeGift: updatedUser.welcomeGift,
        billing: updatedUser.billing,
        message: "Customer Updated Successfully!",
      });
    } else {
      // בלי זה בקשה למזהה שלא קיים לא מקבלת תשובה כלל, והפאנל נתקע בטעינה
      res.status(404).send({ message: "לקוח לא נמצא" });
    }
  } catch (err) {
    console.log('updateCustomer error: ', err);
    // האימייל ייחודי במודל, ולכן שיוך אימייל שכבר תפוס נכשל כאן. בלי ההפרדה
    // הזו הפאנל הציג "Your email is not valid!" ולא ניתן היה להבין מה נכשל
    if (err?.code === 11000) {
      return res.status(409).send({
        message: "כתובת האימייל הזו כבר משויכת ללקוח אחר במערכת.",
      });
    }
    res.status(400).send({
      message: "עדכון פרטי הלקוח נכשל. יש לוודא שהפרטים תקינים ולנסות שוב.",
    });
  }
};

const deleteCustomer = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    // בלי הבדיקה הזו מזהה שאינו קיים דילג על בדיקת ההרשאות והחזיר "נמחק בהצלחה"
    if (!customer) {
      return res.status(404).send({ message: "לקוח לא נמצא" });
    }
    if (!(await canManageCustomer(req?.user, customer))) {
      return res.status(403).send({
        message: "You are not authorized to delete this customer!",
      });
    }

    await Customer.deleteOne({ _id: req.params.id });

    // המחירון הפרטי נמחק יחד עם הלקוח, אחרת הוא נשאר במסד כרשומה יתומה שאף
    // מסך אינו מציג ואף אחד אינו יכול להסיר.
    // כשל כאן אינו מבטל מחיקה שכבר בוצעה - הלקוח נמחק, והשארית מדווחת ללוג
    await CustomerPriceList.deleteOne({ customer: req.params.id }).catch((err) =>
      console.log(`deleteCustomer: כשל במחיקת מחירון הלקוח — ${err.message}`)
    );

    res.status(200).send({
      message: "המשתמש נמחק בהצלחה!",
    });
  } catch (err) {
    console.log('deleteCustomer error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

// הוספת לקוח לרשימה השחורה - לא מקבל הודעות סקר בוואטסאפ
const addToBlackListByPhone = async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).send({
        message: "Please send a phone number to update the blacklist",
      });
    }

    // ניקוי הספרות מהמספר (הורדת מקפים, רווחים, וכו')
    const cleanedPhone = phone.replace(/[^0-9]/g, "");

    // גרסאות שונות של המספר לבדיקה
    const variations = [
      cleanedPhone,
      "972" + cleanedPhone.slice(-9),
      "+972" + cleanedPhone.slice(-9),
    ];

    // חיפוש לפי אחת האפשרויות
    const updatedCustomer = await Customer.findOneAndUpdate(
      { phone: { $in: variations } },     // תנאי החיפוש
      { $set: { inBlackList: true } },    // העדכון
      { new: true }                       // החזרה של המסמך המעודכן
    );

    if (!updatedCustomer) {
      return res.status(404).send({
        message: "No customer found with the requested phone number",
      });
    }

    return res.send({
      message: "Customer successfully added to the blacklist",
      customer: updatedCustomer,
    });
  } catch (error) {
    console.error("Error adding to blacklist:", error);
    if (!res.headersSent) {
      res.status(500).send({
        message: "An error occurred, please try again later",
      });
    }
  }
};

// החלפת לקוח לקופאי/לקוח רגיל
const toggleCustomerCashier = async (req, res) => {
  try {
    const { id } = req.params;
    const isCashier = req.body.isCashier;

    const customer = await Customer.findById(id);
    if (!customer) {
      return res.status(404).send({
        message: "Customer not found",
      });
    }

    customer.isCashier = isCashier;
    await customer.save();

    const message = isCashier ? {
      en: "Customer is now a cashier",
      he: "הלקוח שונה לקופאי"
    } : {
      en: "Customer is now a regular customer",
      he: "הקופאי שונה ללקוח רגיל"
    };

    console.log(customer.name + " " + message.en)

    res.send({
      message,
      customer,
    });
  } catch (error) {
    console.error("Error toggling customer cashier:", error);
  }
};

// contact-us
const contactUs = async (req, res) => {
  try {
    // Get application data from request body
    const {
      message,
      name,
      email,
      subject
    } = req.body;

    // Validate required fields
    if (!message || !name || !email || !subject) {
      return res.status(400).send({
        message: {
          en: "Please fill all required fields",
          he: "אנא מלא את כל השדות הנדרשים"
        }
      });
    }

    // Create new application
    const newApplication = new Application({
      message,
      name,
      email,
      subject,
    });

    // Save application to database
    const savedApplication = await newApplication.save();

    // Prepare email to admin
    const option = {
      message,
      name,
      email,
      subject,
    };

    const to = [process.env.EMAIL_USER, process.env.OUR_EMAIL];

    if (process.env.NODE_ENV === "development") {
      to.push("israelbenari1000@gmail.com");
    }

    const body = {
      from: `"${process.env.COMPANY_NAME}" <${process.env.EMAIL_USER}>`,
      to: to,
      subject: `פנייה חדשה מאת ${name} - ${subject}`,
      html: newApplicationBody(option)
    };

    // Send email to admin
    const response = {
      en: "Your message has been sent successfully. We will contact you soon.",
      he: "הודעתך נשלחה בהצלחה. ניצור איתך קשר בהקדם."
    };

    sendEmail(body, res, response);

  } catch (err) {
    console.error("contactUs error:", err);
    if (!res.headersSent) {
      res.status(500).send({
        message: {
          en: "An error occurred while processing your request",
          he: "אירעה שגיאה בעת עיבוד הבקשה שלך"
        }
      });
    }
  }
};

// Middleware: יצירת/עדכון לקוח אורח לפני יצירת הזמנה
const createGuestCustomer = async (req, res, next) => {
  try {
    const {
      name,
      lastName,
      email,
      phone,
      city,
      street,
      houseNumber,
      apartmentNumber,
      floor,
      entryCode,
      postalCode
    } = req.body;

    // בדיקת שדות חובה
    if (!name || !lastName || !email || !phone || !city || !street || !houseNumber || !apartmentNumber) {
      return res.status(400).send({
        message: "נא להזין את כל השדות החובה",
      });
    }

    // בדיקה אם הלקוח כבר קיים
    const existingCustomer = await Customer.findOne({ email: email.toLowerCase() });

    if (existingCustomer) {
      // אם הלקוח רשום - מחזירים שגיאה מיוחדת
      if (existingCustomer.isRegistered) {
        return res.status(409).send({
          keyWord: "customerAlreadyRegistered",
          message: "האימייל כבר רשום במערכת. יש להתחבר לפני הרכישה באמצעות סיסמה או עם גוגל.",
        });
      }

      // אם הלקוח לא רשום - מעדכנים את הפרטים
      existingCustomer.name = name;
      if (lastName) existingCustomer.lastName = lastName;
      if (phone) existingCustomer.phone = phone;

      // עדכון כתובת
      if (city) existingCustomer.address.city = city;
      if (street) existingCustomer.address.street = street;
      if (houseNumber) existingCustomer.address.houseNumber = houseNumber;
      if (apartmentNumber) existingCustomer.address.apartmentNumber = apartmentNumber;
      if (floor) existingCustomer.address.floor = floor;
      if (entryCode) existingCustomer.address.entryCode = entryCode;
      if (postalCode) existingCustomer.address.postalCode = postalCode;

      await existingCustomer.save();

      // הוספת פרטי הלקוח ל-req.user בדומה ל-isAuth
      req.user = {
        _id: existingCustomer._id,
        name: existingCustomer.name,
        lastName: existingCustomer.lastName,
        email: existingCustomer.email,
        address: existingCustomer.address,
        phone: existingCustomer.phone,
        image: existingCustomer.image,
        isCashier: existingCustomer.isCashier,
      };

      console.log('createGuestCustomer user updated :>> ', req.user);

      return next();
    }

    // יצירת לקוח חדש (לא רשום)
    const newCustomer = new Customer({
      name,
      lastName: lastName || "",
      email: email.toLowerCase(),
      phone: phone || "",
      address: {
        city: city || {},
        street: street || "",
        houseNumber: houseNumber || "",
        apartmentNumber: apartmentNumber || "",
        floor: floor || "",
        entryCode: entryCode || "",
        postalCode: postalCode || "",
      },
      isRegistered: false,
    });

    await newCustomer.save();

    // הוספת פרטי הלקוח ל-req.user בדומה ל-isAuth
    req.user = {
      _id: newCustomer._id,
      name: newCustomer.name,
      lastName: newCustomer.lastName,
      email: newCustomer.email,
      address: newCustomer.address,
      phone: newCustomer.phone,
      image: newCustomer.image,
      isCashier: newCustomer.isCashier,
    };

    console.log('createGuestCustomer user created :>> ', req.user);

    next();
  } catch (err) {
    console.error("Error in createGuestCustomer middleware:", err);
    res.status(500).send({
      message: "שגיאה ביצירת ההזמנה, אנא נסו שוב מאוחר יותר או פנו לשירות הלקוחות שלנו.",
    });
  }
};

module.exports = {
  loginCustomer,
  sendOtp,
  verifyOtp,
  registerCustomer,
  importCustomers,
  checkImportCustomers,
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
  addToBlackListByPhone,
  toggleCustomerCashier,
  validateToken,
  contactUs,
  createGuestCustomer,
  // מיוצא כדי שמחירוני הלקוחות ייאכפו באותו שער בדיוק שמגן על עריכת לקוח,
  // בלי לשכפל את רשימת התפקידים במקום שני שיישכח בעדכון הבא
  isCustomerManager,
  CUSTOMER_MANAGER_ROLES,
};
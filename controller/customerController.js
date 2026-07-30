// controller/customerController.js
require("dotenv").config();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const Customer = require("../models/Customer");
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

const PHONE_TAKEN_MESSAGE =
  "מספר הטלפון הזה כבר רשום במערכת. ניתן להתחבר באמצעות המספר וקוד ב-SMS.";

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

    const existingCustomer = await Customer.findOne({ email: req.body.email.toLowerCase() });

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
        existingCustomer.password = bcrypt.hashSync(req.body.password);
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
  console.log('password: ', password)
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

const addAllCustomers = async (req, res) => {
  try {
    await Customer.deleteMany();
    await Customer.insertMany(req.body);
    res.send({
      message: "Added all users successfully!",
    });
  } catch (err) {
    console.log('addAllCustomers error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const loginCustomer = async (req, res) => {
  try {
    const customer = await Customer.findOne({ email: req.body.registerEmail });

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
        `קוד ההתחברות שלך ל${process.env.COMPANY_NAME || "תמרים בתומר"}: ${code}`
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
  const customer = await Customer.findOne({ email: email });

  if (token) {
    jwt.verify(token, process.env.JWT_SECRET_FOR_VERIFY, (err, decoded) => {
      if (err) {
        console.log('resetPassword error: ', err);
        return res.status(500).send({
          message: "פג תוקף הבקשה, אנא נסה שוב",
        });
      } else {
        customer.password = bcrypt.hashSync(req.body.newPassword);
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
    const customer = await Customer.findOne({ email: req.body.email });
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
      customer.password = bcrypt.hashSync(req.body.newPassword);
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

const getAllCustomers = async (req, res) => {
  try {
    const users = await Customer.find({});
    users.sort((a, b) => {
      const isANameHebrew = /^[\u0590-\u05FF]+$/.test(a.name);
      const isBNameHebrew = /^[\u0590-\u05FF]+$/.test(b.name);

      if (isANameHebrew && !isBNameHebrew) return -1;
      if (!isANameHebrew && isBNameHebrew) return 1;
      return a.name.localeCompare(b.name);
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

const updateCustomer = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (customer) {
      if (req?.user?.email !== customer.email && req?.user?.role !== "Admin" && req?.user?.role !== "CEO") {
        return res.status(403).send({
          message: "You are not authorized to update this customer!",
        });
      }
      customer.name = req.body.name;
      customer.lastName = req.body.lastName;
      customer.email = req.body.email;
      customer.address = req.body.address;
      // נרמול נייד ישראלי לפורמט 05XXXXXXXX. בלי זה מספר שנשמר עם מקפים או רווחים
      // אינו נמצא בכניסה בטלפון, והלקוח נתקע: הכניסה אומרת שאין חשבון וההרשמה
      // אומרת שהאימייל כבר רשום. כל פורמט אחר נשמר כפי שהוא
      customer.phone = isValidIsraeliMobile(req.body.phone)
        ? canonicalPhone(req.body.phone)
        : req.body.phone;
      customer.image = req.body.image;
      // customer.password = bcrypt.hashSync("12345678");
      const updatedUser = await customer.save();
      const token = signInToken(updatedUser);
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
        message: "Customer Updated Successfully!",
      });
    }
  } catch (err) {
    console.log('updateCustomer error: ', err);
    res.status(404).send({
      message: "Your email is not valid!",
    });
  }
};

const deleteCustomer = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (customer) {
      if (req?.user?.email !== customer.email && req?.user?.role !== "Admin" && req?.user?.role !== "CEO") {
        return res.status(403).send({
          message: "You are not authorized to delete this customer!",
        });
      }
    }

    await Customer.deleteOne({ _id: req.params.id });
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
  addAllCustomers,
  signUpWithProvider,
  verifyEmailAddress,
  forgetPassword,
  changePassword,
  resetPassword,
  getAllCustomers,
  getCustomerById,
  getShippingRewardEligibility,
  updateCustomer,
  deleteCustomer,
  addToBlackListByPhone,
  toggleCustomerCashier,
  validateToken,
  contactUs,
  createGuestCustomer,
};
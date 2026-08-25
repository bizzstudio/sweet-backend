// controller/orderPlatformController.js
//
// מסך הפלטפורמות: מי שולח לנו הזמנות דרך קישור, מה מאושר, ומה חסר כדי
// שההזמנות ממנו ייקראו לבד.
//
// ── למה זה מסך ולא הגדרה בקוד ──
//
// אי אפשר לדעת מראש דרך איזו פלטפורמה לקוח יזמין. המערכת רושמת בעצמה כל
// שולח חדש שנראה כמו פלטפורמת הזמנות (ראה lib/order-ingestion/platforms),
// והמסך הזה הוא מה שהופך את הרישום הזה לפעולה: אישור אחד לפלטפורמה,
// והתחברות אחת אם היא דורשת. לא אישור לכל לקוח ולא לכל הזמנה.

const mongoose = require("mongoose");

const OrderPlatform = require("../models/OrderPlatform");
const IncomingOrder = require("../models/IncomingOrder");
const Customer = require("../models/Customer");
const {
  approvePlatform,
  mapCustomer,
  extractPlatformRefs,
  sessionAppliesToHost,
} = require("../lib/order-ingestion/platforms");
const { reprocess } = require("../lib/order-ingestion");
const { loginToPlatform } = require("../lib/link-follower/login");
const { followOrderLink } = require("../lib/link-follower");

const adminDisplayName = (user) =>
  [user?.name, user?.email].filter(Boolean).join(" ") || "אדמין";

const asObjectId = (value, res) => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    res.status(400).send({ message: "מזהה לא תקין" });
    return null;
  }
  return value;
};

/**
 * ניקוי הסשן מהתשובה.
 *
 * הסשן הוא מפתח לחשבון אצל הפלטפורמה. הוא נדרש לשרת, ואין שום סיבה שהוא
 * יעבור בחוט לדפדפן של האדמין — מה שהמסך צריך לדעת זה **אם** יש סשן ומתי
 * נשמר, לא מה הוא. אותו דבר לגבי הסיסמה.
 */
const publicPlatform = (doc) => {
  const platform = doc.toObject ? doc.toObject() : { ...doc };

  platform.hasSession = Boolean(
    platform.session?.cookies?.length || platform.session?.localStorage
  );
  platform.sessionSavedAt = platform.session?.savedAt || null;
  platform.sessionExpiredAt = platform.session?.expiredAt || null;
  // המקור הוא גם ההיקף: הסשן מוצמד רק לקישורים בדומיין הזה (ראה
  // sessionAppliesToHost). המסך צריך להציג אותו, אחרת "יש סשן" ו"הקישור
  // נפתח בלי סשן" נראים כסתירה.
  platform.sessionOrigin = platform.session?.origin || null;
  delete platform.session;

  platform.hasCredentials = Boolean(platform.login?.username && platform.login?.password);
  if (platform.login) {
    platform.login = {
      url: platform.login.url,
      username: platform.login.username,
      lastLoginAt: platform.login.lastLoginAt,
      lastLoginError: platform.login.lastLoginError,
    };
  }

  return platform;
};

/**
 * GET /api/order-platforms
 *
 * הרשימה, עם ספירת ההודעות שממתינות מכל פלטפורמה — זה המספר שהופך
 * "פלטפורמה ממתינה" ל"שבע הזמנות שלא נקראו".
 */
const getAllPlatforms = async (req, res) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const query = status && status !== "all" ? { status } : {};

    const platforms = await OrderPlatform.find(query)
      // שמות הלקוחות הממופים נדרשים כבר ברשימה: בלעדיהם המסך היה מציג
      // ‏ObjectId גולמי ליד המזהה של הלקוח בפלטפורמה, כלומר שורת מיפוי
      // שאי אפשר לקרוא ולכן גם אי אפשר לבדוק.
      .populate({ path: "customerMap.customer", select: "name lastName" })
      .sort({ "stats.lastSeenAt": -1 })
      .lean();

    // הודעות שממתינות, לפי פלטפורמה. ‏aggregate אחד ולא שאילתה לכל פלטפורמה.
    const pendingCounts = await IncomingOrder.aggregate([
      { $match: { status: "platform_pending" } },
      { $group: { _id: "$platform.ref", count: { $sum: 1 } } },
    ]);
    const pendingByPlatform = pendingCounts.reduce((acc, row) => {
      if (row._id) acc[String(row._id)] = row.count;
      return acc;
    }, {});

    // הודעות שנקראו אבל הלקוח שלהן לא ממופה — הפעולה הפתוחה השנייה בגודלה
    const unmappedCounts = await IncomingOrder.aggregate([
      // ‏status נכלל כדי שהשאילתה תשתמש באינדקס { status: 1, createdAt: -1 }
      // הקיים. על errorCode לבדו אין אינדקס, וזו הייתה סריקת אוסף מלאה בכל
      // טעינה של המסך — על אוסף שגדל בכל מייל שנכנס.
      { $match: { status: "failed", errorCode: "platform_customer_unmapped" } },
      { $group: { _id: "$platform.ref", count: { $sum: 1 } } },
    ]);
    const unmappedByPlatform = unmappedCounts.reduce((acc, row) => {
      if (row._id) acc[String(row._id)] = row.count;
      return acc;
    }, {});

    const withCounts = platforms.map((platform) => ({
      ...publicPlatform(platform),
      pendingMessages: pendingByPlatform[String(platform._id)] || 0,
      unmappedMessages: unmappedByPlatform[String(platform._id)] || 0,
    }));

    res.send({
      platforms: withCounts,
      counts: {
        all: withCounts.length,
        pending: withCounts.filter((p) => p.status === "pending").length,
        approved: withCounts.filter((p) => p.status === "approved").length,
        blocked: withCounts.filter((p) => p.status === "blocked").length,
        needsLogin: withCounts.filter((p) => p.status === "approved" && p.requiresLogin).length,
      },
    });
  } catch (err) {
    console.log("getAllPlatforms error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/**
 * GET /api/order-platforms/:id
 * פלטפורמה אחת + ההודעות האחרונות ממנה (בלי צילומי המסך — הם כבדים).
 */
const getPlatformById = async (req, res) => {
  try {
    const id = asObjectId(req.params.id, res);
    if (!id) return;

    const platform = await OrderPlatform.findById(id).populate({
      path: "customerMap.customer",
      select: "name lastName email phone",
    });
    if (!platform) return res.status(404).send({ message: "הפלטפורמה לא נמצאה" });

    const messages = await IncomingOrder.find({ "platform.ref": id })
      .select("-linkFollow.screenshot")
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    res.send({ platform: publicPlatform(platform), messages });
  } catch (err) {
    console.log("getPlatformById error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/**
 * POST /api/order-platforms/:id/approve
 *
 * הפעולה המרכזית: "כן, זו פלטפורמת הזמנות אמיתית". מכאן והלאה הודעות ממנה
 * נקראות, וכל ההודעות שהמתינו מעובדות מיד — כלומר האישור אינו רק הגדרה
 * לעתיד, הוא גם משלים את מה שכבר הגיע.
 */
const approvePlatformAndReprocess = async (req, res) => {
  try {
    const id = asObjectId(req.params.id, res);
    if (!id) return;

    const platform = await approvePlatform({
      platformId: id,
      name: req.body?.name,
      by: adminDisplayName(req.user),
    });
    if (!platform) return res.status(404).send({ message: "הפלטפורמה לא נמצאה" });

    // ── ההודעות שהמתינו ──
    //
    // תקרה מכוונת: פלטפורמה שהגיעו ממנה 300 מיילים לפני האישור הייתה פותחת
    // 300 עמודי דפדפן בבקשת HTTP אחת. הנותרות ייקראו בהרצה חוזרת מהמסך.
    //
    // המספר נגזר מזמן אמיתי ולא מתחושה: פתיחת דף אורכת עד 25 שניות
    // (‏LINK_FOLLOW_TIMEOUT_MS), והעיבוד סדרתי. חמש הודעות = עד ~2 דקות, מתחת
    // ל-ProxyTimeout של אפאצ'י (300 שניות) שדרכו השרת מוגש ב-srv2. תקרה של 20
    // הייתה יכולה להגיע ל-8 דקות, כלומר הבקשה נופלת ב-504 בזמן שהעיבוד ממשיך
    // ברקע — והמסך מדווח כשל על פעולה שהצליחה.
    const limit = Math.min(10, Math.max(1, Number(req.body?.limit) || 5));
    const waiting = await IncomingOrder.find({
      "platform.ref": id,
      status: "platform_pending",
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .select("_id");

    const results = [];
    for (const doc of waiting) {
      try {
        // ── תפיסה אטומית ──
        //
        // הרשומה יוצאת מ-platform_pending לפני ההרצה, כי reprocess מריץ את
        // העיבוד והסטטוס הוא מה שהמסך מציג בינתיים. התנאי על הסטטוס בתוך
        // השאילתה הוא מה שהופך את זה לתפיסה: שני אדמינים שלוחצים "אשר"
        // באותו רגע (או לחיצה כפולה) היו שניהם עוברים בדיקה נפרדת ומריצים
        // את אותה הודעה — כלומר **שתי הזמנות לאותו מייל**. רק מי שהחליף את
        // הסטטוס בפועל ממשיך.
        const claimed = await IncomingOrder.updateOne(
          { _id: doc._id, status: "platform_pending" },
          {
            $set: { status: "received", "platform.status": "approved" },
            $push: {
              logs: {
                at: new Date(),
                step: "platform",
                message: `הפלטפורמה אושרה ע"י ${adminDisplayName(req.user)} — קורא מחדש`,
              },
            },
          }
        );

        if (!claimed.modifiedCount) {
          results.push({ incomingOrderId: doc._id, status: "skipped", error: "כבר בטיפול" });
          continue;
        }

        const processed = await reprocess(doc._id);
        results.push({
          incomingOrderId: doc._id,
          status: processed.status,
          invoice: processed.invoice,
          errorCode: processed.errorCode,
          error: processed.error,
        });
      } catch (err) {
        results.push({ incomingOrderId: doc._id, status: "failed", error: err.message });
      }
    }

    const remaining = await IncomingOrder.countDocuments({
      "platform.ref": id,
      status: "platform_pending",
    });

    const created = results.filter((r) => r.status === "order_created").length;

    res.send({
      message:
        `הפלטפורמה ${platform.name || platform.key} אושרה. ` +
        (results.length
          ? `עובדו ${results.length} הודעות שהמתינו, ${created} הפכו להזמנה.`
          : "לא היו הודעות שממתינות.") +
        (remaining ? ` נותרו ${remaining} להרצה חוזרת.` : ""),
      platform: publicPlatform(platform),
      processed: results,
      remaining,
    });
  } catch (err) {
    console.log("approvePlatformAndReprocess error: ", err);
    res.status(400).send({ message: err.message });
  }
};

/**
 * PUT /api/order-platforms/:id
 * עריכה: שם לתצוגה, חסימה, הערות, ופרטי התחברות.
 */
const updatePlatform = async (req, res) => {
  try {
    const id = asObjectId(req.params.id, res);
    if (!id) return;

    const set = {};
    if (typeof req.body?.name === "string") set.name = req.body.name.trim().slice(0, 120);
    if (typeof req.body?.notes === "string") set.notes = req.body.notes.slice(0, 2000);
    if (["pending", "approved", "blocked"].includes(req.body?.status)) {
      set.status = req.body.status;
      if (req.body.status === "approved") {
        set.approvedAt = new Date();
        set.approvedBy = adminDisplayName(req.user);
      }
    }

    // פרטי התחברות. הסיסמה מתעדכנת רק אם נשלחה — כך שעריכת השם לא מוחקת
    // אותה, וכך שהמסך יכול להציג שדה ריק בלי להרוס את מה ששמור.
    const login = req.body?.login || {};
    if (typeof login.url === "string") set["login.url"] = login.url.trim();
    if (typeof login.username === "string") set["login.username"] = login.username.trim();
    if (typeof login.password === "string" && login.password) {
      set["login.password"] = login.password;
    }
    ["usernameSelector", "passwordSelector", "submitSelector"].forEach((field) => {
      if (typeof login[field] === "string") set[`login.${field}`] = login[field].trim();
    });

    if (!Object.keys(set).length) {
      return res.status(400).send({ message: "אין מה לעדכן" });
    }

    const platform = await OrderPlatform.findByIdAndUpdate(id, { $set: set }, { new: true });
    if (!platform) return res.status(404).send({ message: "הפלטפורמה לא נמצאה" });

    res.send({ message: "עודכן", platform: publicPlatform(platform) });
  } catch (err) {
    console.log("updatePlatform error: ", err);
    res.status(400).send({ message: err.message });
  }
};

/**
 * POST /api/order-platforms/:id/login
 *
 * התחברות אחת לפלטפורמה. מכאן והלאה הדפדפן שלנו פותח את דפי ההזמנות שלה
 * כשהוא מחובר — לכל הלקוחות, לא לאחד.
 */
const loginPlatform = async (req, res) => {
  try {
    const id = asObjectId(req.params.id, res);
    if (!id) return;

    const platform = await OrderPlatform.findById(id);
    if (!platform) return res.status(404).send({ message: "הפלטפורמה לא נמצאה" });

    // פרטים מהבקשה מנצחים את השמורים — כך אפשר לתקן סיסמה בלי לשמור קודם
    const loginUrl = String(req.body?.url || platform.login?.url || "").trim();
    const username = String(req.body?.username || platform.login?.username || "").trim();
    const password = String(req.body?.password || platform.login?.password || "");

    if (!loginUrl || !username || !password) {
      return res.status(400).send({
        message: "נדרשים כתובת דף ההתחברות, שם משתמש וסיסמה",
      });
    }

    const result = await loginToPlatform({
      loginUrl,
      username,
      password,
      selectors: {
        username: platform.login?.usernameSelector,
        password: platform.login?.passwordSelector,
        submit: platform.login?.submitSelector,
      },
    });

    if (!result.ok) {
      await OrderPlatform.updateOne(
        { _id: id },
        {
          $set: {
            "login.url": loginUrl,
            "login.username": username,
            ...(req.body?.password ? { "login.password": password } : {}),
            "login.lastLoginError": result.error,
          },
        }
      );
      return res.status(400).send({ message: result.error, code: result.code });
    }

    await OrderPlatform.updateOne(
      { _id: id },
      {
        $set: {
          session: { ...result.session, savedBy: adminDisplayName(req.user) },
          requiresLogin: false,
          "login.url": loginUrl,
          "login.username": username,
          ...(req.body?.password ? { "login.password": password } : {}),
          "login.lastLoginAt": new Date(),
          "login.lastLoginError": null,
        },
        $unset: { "session.expiredAt": "" },
      }
    );

    res.send({
      message:
        "ההתחברות הצליחה והסשן נשמר. מכאן והלאה ההזמנות מהפלטפורמה הזו ייקראו אוטומטית.",
      cookies: result.session.cookies.length,
      localStorageKeys: Object.keys(result.session.localStorage || {}).length,
    });
  } catch (err) {
    console.log("loginPlatform error: ", err);
    res.status(400).send({ message: err.message });
  }
};

/**
 * POST /api/order-platforms/:id/session
 *
 * הדבקת סשן מהדפדפן של המשתמש — המסלול לפלטפורמה שההתחברות אליה אינה
 * אוטומטית (אימות דו-שלבי, CAPTCHA, כניסה דרך גוגל).
 */
const savePastedSession = async (req, res) => {
  try {
    const id = asObjectId(req.params.id, res);
    if (!id) return;

    const cookies = Array.isArray(req.body?.cookies) ? req.body.cookies : [];
    const localStorageEntries =
      req.body?.localStorage && typeof req.body.localStorage === "object"
        ? req.body.localStorage
        : {};

    if (!cookies.length && !Object.keys(localStorageEntries).length) {
      return res.status(400).send({
        message: "לא נשלח סשן. נדרש cookies (מערך) או localStorage (אובייקט).",
      });
    }

    // ── מקור הוא שדה חובה, ולא נוחות ──
    //
    // הסשן מוצמד לקישור **רק** כשהוא מגיע מהדומיין שבו הוא נוצר
    // (‏sessionAppliesToHost). סשן בלי מקור לא היה מוצמד לעולם, כלומר "נשמר
    // בהצלחה" ואז שום דבר לא משתנה — הכשל השקט הגרוע ביותר. אם לא נשלח,
    // נגזר מהדומיין הראשון שראינו קישורים אליו.
    const platformForOrigin = await OrderPlatform.findById(id).select("linkHosts");
    if (!platformForOrigin) return res.status(404).send({ message: "הפלטפורמה לא נמצאה" });

    let origin = String(req.body?.origin || "").trim();
    if (!origin && platformForOrigin.linkHosts?.length) {
      origin = `https://${platformForOrigin.linkHosts[0]}`;
    }
    try {
      const parsedOrigin = new URL(origin);
      origin = `${parsedOrigin.protocol}//${parsedOrigin.host}`;
    } catch (_) {
      return res.status(400).send({
        message:
          "נדרש origin — הדומיין שממנו הועתק הסשן (למשל https://app.example.com). " +
          "בלעדיו הסשן לא יוצמד לאף קישור.",
      });
    }

    // קוקי בלי name/value אינו קוקי, ו-puppeteer זורק עליו. סינון כאן ולא
    // בפתיחת הקישור: שם הכשל היה מתגלה רק כשההזמנה הבאה נכשלת.
    const clean = cookies
      .filter((cookie) => cookie?.name && cookie?.value !== undefined)
      .map((cookie) => ({
        name: String(cookie.name),
        value: String(cookie.value),
        domain: cookie.domain ? String(cookie.domain) : undefined,
        path: cookie.path ? String(cookie.path) : "/",
        expires: typeof cookie.expires === "number" ? cookie.expires : undefined,
        httpOnly: Boolean(cookie.httpOnly),
        secure: Boolean(cookie.secure),
        sameSite: ["Strict", "Lax", "None"].includes(cookie.sameSite) ? cookie.sameSite : undefined,
      }));

    const platform = await OrderPlatform.findByIdAndUpdate(
      id,
      {
        $set: {
          session: {
            cookies: clean,
            localStorage: localStorageEntries,
            origin,
            savedAt: new Date(),
            savedBy: adminDisplayName(req.user),
          },
          requiresLogin: false,
        },
      },
      { new: true }
    );
    if (!platform) return res.status(404).send({ message: "הפלטפורמה לא נמצאה" });

    res.send({
      message: `הסשן נשמר (${clean.length} קוקיז, ${Object.keys(localStorageEntries).length} מפתחות).`,
      platform: publicPlatform(platform),
    });
  } catch (err) {
    console.log("savePastedSession error: ", err);
    res.status(400).send({ message: err.message });
  }
};

/**
 * POST /api/order-platforms/:id/test
 *
 * בדיקה: פותח קישור מהפלטפורמה עם הסשן השמור ומדווח מה נקרא — בלי ליצור
 * הזמנה ובלי לגעת ברשומות. זה מה שעונה על "האם ההתחברות באמת עבדה" מיד,
 * ולא בהזמנה הבאה שתיכשל.
 */
const testPlatformLink = async (req, res) => {
  try {
    const id = asObjectId(req.params.id, res);
    if (!id) return;

    const platform = await OrderPlatform.findById(id);
    if (!platform) return res.status(404).send({ message: "הפלטפורמה לא נמצאה" });

    const url = String(req.body?.url || platform.lastLinkSample || "").trim();
    if (!url) {
      return res.status(400).send({
        message: "אין קישור לבדיקה. יש לשלוח url, או להמתין להודעה הבאה מהפלטפורמה.",
      });
    }

    const saved =
      platform.session?.cookies?.length || platform.session?.localStorage
        ? platform.session
        : null;

    // ── גם כאן הסשן מוצמד רק לדומיין שבו התחברנו ──
    //
    // ברירת המחדל לבדיקה היא lastLinkSample, שמקורו בקישור שהגיע במייל —
    // כלומר קלט שאיננו שולטים בו. "אדמין לחץ על כפתור" אינו אישור למסור את
    // הטוקן לכתובת שמישהו אחר בחר.
    let host = null;
    try {
      host = new URL(url).hostname;
    } catch (_) {
      return res.status(400).send({ message: "הכתובת אינה תקינה" });
    }

    const session = sessionAppliesToHost(saved, host) ? saved : null;
    const sessionSkipped = Boolean(saved) && !session;

    // "always": במסך הבדיקה הצילום הוא כל הפואנטה — לראות מה הדפדפן ראה,
    // גם (ובעיקר) כשהקריאה הצליחה.
    const result = await followOrderLink({ url, session, screenshot: "always" });

    res.send({
      ok: result.ok,
      code: result.code,
      error: result.error,
      // המסך חייב לדעת שהבדיקה רצה בלי הסשן — אחרת "דורש התחברות" ייראה
      // ככשל של ההתחברות במקום כמה שהוא: כתובת שאינה של הפלטפורמה.
      sessionSkipped,
      sessionOrigin: saved?.origin || null,
      loginRequired: result.loginRequired,
      blocked: result.blocked,
      chars: result.chars,
      title: result.title,
      finalUrl: result.finalUrl,
      // 2000 תווים ראשונים — מספיק כדי לראות שזו ההזמנה הנכונה
      textPreview: result.text ? result.text.slice(0, 2000) : "",
      screenshot: result.screenshot,
    });
  } catch (err) {
    console.log("testPlatformLink error: ", err);
    res.status(400).send({ message: err.message });
  }
};

/**
 * POST /api/order-platforms/:id/map-customer
 *
 * "המסעדה הזאת אצלם היא הכרטיס הזה אצלנו" — פעם אחת לכל לקוח, ואז אוטומטי.
 * אם נשלח incomingOrderId, ההודעה שנתקעה על זה נקראת מחדש מיד.
 */
const mapPlatformCustomer = async (req, res) => {
  try {
    const id = asObjectId(req.params.id, res);
    if (!id) return;

    const customerId = req.body?.customerId;
    if (!mongoose.Types.ObjectId.isValid(customerId)) {
      return res.status(400).send({ message: "נדרש מזהה לקוח תקין" });
    }

    const customer = await Customer.findById(customerId).select("name lastName email phone");
    if (!customer) return res.status(404).send({ message: "הלקוח לא נמצא" });

    const keys = Array.isArray(req.body?.keys) ? req.body.keys : [req.body?.key].filter(Boolean);
    if (!keys.length) {
      return res.status(400).send({
        message: "נדרש לפחות מזהה אחד של הלקוח בפלטפורמה (מספר לקוח או שם העסק)",
      });
    }

    const platform = await mapCustomer({
      platformId: id,
      keys,
      externalName: req.body?.externalName,
      customerId,
      by: adminDisplayName(req.user),
    });
    if (!platform) return res.status(404).send({ message: "הפלטפורמה לא נמצאה" });

    // ── הרצה חוזרת של ההודעה שחיכתה למיפוי הזה ──
    let processed = null;
    if (req.body?.incomingOrderId && mongoose.Types.ObjectId.isValid(req.body.incomingOrderId)) {
      // קריאה-שינוי-שמירה בשלושה שלבים אפשרה לשתי לחיצות לתפוס את אותה
      // הודעה ולייצר שתי הזמנות. פעולה אחת עם התנאי בתוכה מכריעה מי מנצח.
      const claimed = await IncomingOrder.findOneAndUpdate(
        { _id: req.body.incomingOrderId, status: { $ne: "order_created" } },
        {
          $set: { status: "received" },
          $push: {
            logs: {
              at: new Date(),
              step: "platform",
              message: `הלקוח מופה ל-${customer.name} ע"י ${adminDisplayName(req.user)} — קורא מחדש`,
            },
          },
        },
        { new: true }
      );

      if (claimed) processed = await reprocess(claimed._id);
    }

    res.send({
      message:
        `הלקוח ${customer.name} מופה ל-${keys.join(" / ")}. ` +
        (processed
          ? processed.status === "order_created"
            ? `ההודעה נקראה ונוצרה הזמנה ${processed.invoice}.`
            : `ההודעה עובדה מחדש והסתיימה בסטטוס "${processed.status}".`
          : "כל הזמנה הבאה מהלקוח הזה תזוהה אוטומטית."),
      platform: publicPlatform(platform),
      incomingOrder: processed,
    });
  } catch (err) {
    console.log("mapPlatformCustomer error: ", err);
    res.status(400).send({ message: err.message });
  }
};

/**
 * DELETE /api/order-platforms/:id/map-customer/:customerId
 * ביטול מיפוי שנעשה בטעות.
 */
const unmapPlatformCustomer = async (req, res) => {
  try {
    const id = asObjectId(req.params.id, res);
    if (!id) return;

    const platform = await OrderPlatform.findByIdAndUpdate(
      id,
      { $pull: { customerMap: { customer: req.params.customerId } } },
      { new: true }
    );
    if (!platform) return res.status(404).send({ message: "הפלטפורמה לא נמצאה" });

    res.send({ message: "המיפוי בוטל", platform: publicPlatform(platform) });
  } catch (err) {
    console.log("unmapPlatformCustomer error: ", err);
    res.status(400).send({ message: err.message });
  }
};

/**
 * GET /api/order-platforms/message/:incomingOrderId/mapping-suggestion
 *
 * מה למפות בהודעה הזו: המזהים שנמצאו בה, ולקוחות שנראים דומים.
 * המסך צריך להציע, לא לבקש מאדם לחפש בגוף המייל בעצמו.
 */
const getMappingSuggestion = async (req, res) => {
  try {
    const doc = await IncomingOrder.findById(req.params.incomingOrderId)
      .select("-linkFollow.screenshot")
      .lean();
    if (!doc) return res.status(404).send({ message: "ההודעה לא נמצאה" });

    const { refs, names } = extractPlatformRefs({ subject: doc.subject, text: doc.rawText });

    // חיפוש לקוחות לפי השמות שנמצאו. בריחה מתווים מיוחדים כדי שקלט מהמייל
    // לא ישבור את ה-regex, ותקרה על מספר ההצעות.
    const suggestions = [];
    for (const name of names.slice(0, 3)) {
      const words = name
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .split(/\s+/)
        .filter((word) => word.length >= 2)
        .slice(0, 3);
      if (!words.length) continue;

      const found = await Customer.find({
        $or: words.map((word) => ({ name: new RegExp(word, "i") })),
      })
        .select("name lastName email phone")
        .limit(8)
        .lean();

      found.forEach((customer) => {
        if (!suggestions.some((s) => String(s._id) === String(customer._id))) {
          suggestions.push(customer);
        }
      });
    }

    res.send({
      refs,
      names,
      suggestions,
      platform: doc.platform || null,
      subject: doc.subject,
      linkFollow: doc.linkFollow || null,
    });
  } catch (err) {
    console.log("getMappingSuggestion error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/**
 * GET /api/order-platforms/message/:incomingOrderId/screenshot
 *
 * צילום המסך של הדף שנפתח, בנתיב נפרד ובכוונה: הוא כבד, והרשימות והמסכים
 * טוענים אותו רק כשמישהו באמת מסתכל.
 */
const getMessageScreenshot = async (req, res) => {
  try {
    const doc = await IncomingOrder.findById(req.params.incomingOrderId)
      .select("linkFollow.screenshot linkFollow.url linkFollow.followedAt")
      .lean();
    if (!doc) return res.status(404).send({ message: "ההודעה לא נמצאה" });
    if (!doc.linkFollow?.screenshot) {
      return res.status(404).send({ message: "אין צילום מסך להודעה הזו" });
    }

    res.send({
      screenshot: doc.linkFollow.screenshot,
      url: doc.linkFollow.url,
      followedAt: doc.linkFollow.followedAt,
    });
  } catch (err) {
    console.log("getMessageScreenshot error: ", err);
    res.status(500).send({ message: err.message });
  }
};

module.exports = {
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
};

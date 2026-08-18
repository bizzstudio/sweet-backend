// lib/icount/client.js
//
// שכבת התקשורת מול iCount API v3. כל מודול אחר בתיקייה קורא דרך כאן ולא
// מדבר עם ה-HTTP ישירות.
//
// למה sid ולא cid/user/pass בכל קריאה:
//
//   ה-API מקבל את שני האופנים, אבל שליחת הסיסמה בגוף כל בקשה משמעותה שהיא
//   מופיעה בכל לוג, בכל trace ובכל דוח שגיאה. במקום זה מתחברים פעם אחת,
//   מקבלים sid, ומשתמשים בו. הסיסמה יוצאת מהתהליך רק בהתחברות עצמה.
//
// ה-sid נשמר בזיכרון התהליך בלבד. הוא מת עם ריסטארט, וזה בסדר — ההתחברות
// מחדש עולה בקשה אחת. מכוון: אחסון sid במסד היה מחייב אותנו לנהל אותו
// בין אינסטנסים, בלי שום רווח.

const { isDemoMode, modeLabel } = require("./mode");

const BASE_URL = "https://api.icount.co.il/api/v3.php";

// ה-sid של iCount תקף לזמן ארוך, אבל אין הבטחה מתועדת לכמה. מרעננים
// יזומה כל שעה במקום לחכות לכשלון — כשלון באמצע הפקת מסמך חודשי יקר יותר
// מבקשת התחברות מיותרת.
const SESSION_TTL_MS = 60 * 60 * 1000;

// כמה זמן לחכות לתשובה. iCount איטי יחסית בהפקת מסמכים, ולכן לא 10 שניות.
const REQUEST_TIMEOUT_MS = 30 * 1000;

let session = null; // { sid, expiresAt }
let loggingIn = null; // Promise — מונע התחברויות מקבילות

/**
 * שגיאה מ-iCount, עם הסיבה המקורית שלהם ולא רק "request failed".
 * הקוד (reason) הוא מה שמבדיל בין "הסיסמה שגויה" ל"הלקוח לא קיים",
 * ובלעדיו כל כשלון נראה אותו דבר בלוג.
 */
class IcountError extends Error {
  constructor(message, { reason, endpoint, details } = {}) {
    super(message);
    this.name = "IcountError";
    this.reason = reason;
    this.endpoint = endpoint;
    this.details = details;
  }
}

const credentials = () => {
  if (isDemoMode()) return demoCredentials();

  const cid = process.env.ICOUNT_CID;
  const user = process.env.ICOUNT_USER;
  const pass = process.env.ICOUNT_PASS;

  if (!cid || !user || !pass) {
    throw new IcountError(
      "חסרים פרטי התחברות ל-iCount. נדרשים ICOUNT_CID, ICOUNT_USER, ICOUNT_PASS ב-.env"
    );
  }
  return { cid, user, pass };
};

/**
 * פרטי חשבון הדמו.
 *
 * אין כאן שום נפילה חזרה ל-ICOUNT_CID/USER/PASS, וזה העיקר: הודעת שגיאה
 * ברורה עדיפה על התחברות שקטה לחשבון האמיתי בזמן שכל שאר המערכת בטוחה
 * שהיא בדמו — שם כפתור "הפק חשבונית דמו" מפיק מסמך מס אמיתי.
 */
const demoCredentials = () => {
  const cid = process.env.ICOUNT_DEMO_CID;
  const user = process.env.ICOUNT_DEMO_USER;
  const pass = process.env.ICOUNT_DEMO_PASS;

  if (!cid || !user || !pass) {
    throw new IcountError(
      "ICOUNT_MODE=demo אך חסרים פרטי חשבון הדמו. נדרשים " +
        "ICOUNT_DEMO_CID, ICOUNT_DEMO_USER, ICOUNT_DEMO_PASS ב-.env"
    );
  }

  // אותו cid בשני המצבים פירושו שמצב הדמו מצביע על החברה האמיתית, וכל
  // ההגנות של mode.js הופכות לתיאטרון. עדיף להיכשל בעלייה.
  const live = process.env.ICOUNT_CID;
  if (live && live.trim().toLowerCase() === cid.trim().toLowerCase()) {
    throw new IcountError(
      `ICOUNT_DEMO_CID זהה ל-ICOUNT_CID (${cid}) — זה החשבון האמיתי ולא חשבון דמו. ` +
        "יש לפתוח חשבון נפרד ב-iCount ולהזין את ה-cid שלו."
    );
  }

  return { cid, user, pass };
};

/**
 * בקשה גולמית, בלי טיפול ב-session. פנימי.
 */
const rawCall = async (endpoint, body) => {
  let res;
  try {
    res = await fetch(`${BASE_URL}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // TimeoutError מ-AbortSignal, או תקלת רשת
    throw new IcountError(`הקריאה ל-iCount נכשלה: ${err.message}`, {
      endpoint,
      reason: err.name === "TimeoutError" ? "timeout" : "network",
    });
  }

  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // iCount מחזיר HTML כשהשרת שלהם נופל. הטקסט הגולמי מקוצץ — אין טעם
    // להעיף דף שגיאה שלם ללוג.
    throw new IcountError(
      `iCount החזיר תשובה שאינה JSON (HTTP ${res.status})`,
      { endpoint, reason: "bad_response", details: text.slice(0, 300) }
    );
  }

  // ה-API מחזיר HTTP 200 גם על שגיאות לוגיות. status:false הוא הסימן האמיתי.
  if (data.status === false) {
    throw new IcountError(
      data.error_description || data.reason || "שגיאה לא ידועה מ-iCount",
      { endpoint, reason: data.reason, details: data.error_details }
    );
  }

  return data;
};

/**
 * מחזיר sid תקף, ומתחבר אם צריך.
 *
 * loggingIn מונע את המקרה שבו כמה קריאות מקבילות מגלות יחד ש-ה-sid פג
 * וכל אחת פותחת session משלה. הן ממתינות לאותה התחברות.
 */
const getSid = async () => {
  if (session && session.expiresAt > Date.now()) return session.sid;
  if (loggingIn) return loggingIn;

  loggingIn = (async () => {
    const data = await rawCall("auth/login", credentials());
    if (!data.sid) {
      throw new IcountError("ההתחברות ל-iCount לא החזירה sid", {
        endpoint: "auth/login",
      });
    }
    session = { sid: data.sid, expiresAt: Date.now() + SESSION_TTL_MS };
    console.log(
      `[icount] מחובר כ-${data.user} (חברה: ${data.cid}, מצב: ${modeLabel()})` +
        (isDemoMode() ? " ⚠️ חשבון דמו — לא מופקים מסמכי מס אמיתיים" : "")
    );
    return data.sid;
  })();

  loggingIn.catch(() => {
    // כשלון לא "נועל" את התהליך — הניסיון הבא ינסה להתחבר מחדש
    session = null;
  });

  try {
    return await loggingIn;
  } finally {
    loggingIn = null;
  }
};

// הסיבות שמשמעותן "ה-sid כבר לא תקף". מולן שווה לנסות שוב פעם אחת עם
// session חדש; מול כל שגיאה אחרת ניסיון חוזר רק יחזור על אותו כשלון.
const AUTH_REASONS = new Set(["not_logged_in", "invalid_sid", "no_sid", "auth_failed"]);

/**
 * קריאה ל-iCount עם session אוטומטי.
 *
 * @param {string} endpoint - למשל "doc/create" או "client/create"
 * @param {object} params   - פרמטרים ספציפיים לקריאה (בלי sid)
 * @returns {Promise<object>} גוף התשובה
 */
const call = async (endpoint, params = {}) => {
  const sid = await getSid();

  try {
    return await rawCall(endpoint, { ...params, sid });
  } catch (err) {
    if (!(err instanceof IcountError) || !AUTH_REASONS.has(err.reason)) throw err;

    // ה-sid פג לפני שה-TTL שלנו חשב שהוא יפוג. מתחברים מחדש ומנסים שוב,
    // פעם אחת בלבד — אם גם זה נכשל, הבעיה אינה ב-session.
    console.warn(`[icount] ה-session פג (${err.reason}) — מתחבר מחדש`);
    session = null;
    const freshSid = await getSid();
    return rawCall(endpoint, { ...params, sid: freshSid });
  }
};

/**
 * בדיקת חיבור. מחזיר את פרטי החשבון, או זורק אם ההתחברות נכשלה.
 * שימושי כ-health check ובסקריפטים לפני פעולה כבדה.
 */
const ping = async () => {
  session = null; // בדיקה אמיתית, לא מה שיושב בזיכרון
  const data = await rawCall("auth/login", credentials());
  return {
    cid: data.cid,
    user: data.user,
    fullName: data.user_info?.full_name_he || data.user_info?.full_name,
    // הממשק מסתמך על זה כדי להציג באנר "מצב דמו". שדה שקרי כאן משמעותו
    // שמישהו יסתכל על חשבונית דמו ויחשוב שהיא בספרים.
    mode: modeLabel(),
    demo: isDemoMode(),
  };
};

module.exports = { call, ping, IcountError, BASE_URL };

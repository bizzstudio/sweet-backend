// lib/link-follower/login.js
//
// התחברות אחת לפלטפורמה, ושמירת מה שמאפשר לדפדפן שלנו להישאר מחובר.
//
// ── למה זה גנרי ולא "אינטגרציה עם Zestt" ──
//
// דף התחברות הוא אותו דף בכל מקום: שדה מייל, שדה סיסמה, כפתור. הקוד כאן
// מחפש אותם בדף בלי לדעת של מי הוא — ולכן פלטפורמה חדשה אינה דורשת שורת
// קוד, רק שם משתמש וסיסמה. אם דווקא אצלה הזיהוי לא מצא, אפשר לתת סלקטורים
// מדויקים ברשומת הפלטפורמה, וגם זה נתון ולא קוד.
//
// ── מה נשמר ──
//
// קוקיז **וגם** localStorage. זה לא כפל: אפליקציית SPA (וזה כמעט כל מה
// שנפגוש) מחזיקה את הטוקן ב-localStorage ולא בקוקי, ושמירת קוקיז בלבד
// הייתה מייצרת "התחברנו בהצלחה" שאחריו הדף הבא חוזר למסך ההתחברות.
//
// ── מה זה לא ──
//
// זה אינו פתרון ל-2FA, ל-CAPTCHA, ולהתחברות דרך גוגל. בשלושת המקרים האלה
// הפונקציה תיכשל בהודעה מפורשת, והמסלול הנכון הוא הדבקת סשן מהדפדפן של
// המשתמש (ראה sessionFromPaste בקונטרולר) — או בקשת גישה מהפלטפורמה.

const { getBrowser } = require("../headless-browser");
const { assertSafeUrl } = require("./guards");

const NAV_TIMEOUT_MS = Number(process.env.LINK_FOLLOW_TIMEOUT_MS) || 25000;

// שדות שמזהים "כאן מקלידים מייל/שם משתמש", בסדר עדיפות. הראשון שקיים בדף נבחר.
const USERNAME_SELECTORS = [
  'input[type="email"]',
  'input[name*="email" i]',
  'input[name*="user" i]',
  'input[id*="email" i]',
  'input[id*="user" i]',
  'input[autocomplete="username"]',
  'input[type="text"]',
];

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  "form button",
  "button",
];

const CAPTCHA_HINTS = [
  "iframe[src*='recaptcha']",
  "iframe[src*='hcaptcha']",
  ".g-recaptcha",
  "[data-sitekey]",
];

/** הסלקטור הראשון שקיים בדף, או null. */
const firstPresent = async (page, selectors) => {
  for (const selector of selectors) {
    const handle = await page.$(selector).catch(() => null);
    if (handle) return selector;
  }
  return null;
};

/**
 * התחברות לפלטפורמה ושמירת הסשן.
 *
 * @param {Object} input
 * @param {string} input.loginUrl
 * @param {string} input.username
 * @param {string} input.password
 * @param {Object} [input.selectors] - { username, password, submit } — עקיפה ידנית
 * @returns {Promise<{ok, session?, error?, code?, screenshot?, finalUrl?}>}
 */
const loginToPlatform = async ({ loginUrl, username, password, selectors = {} } = {}) => {
  if (!loginUrl || !username || !password) {
    return { ok: false, code: "missing_credentials", error: "חסרים כתובת התחברות, שם משתמש או סיסמה" };
  }

  let safe;
  try {
    safe = await assertSafeUrl(loginUrl);
  } catch (err) {
    return { ok: false, code: "link_blocked", error: err.message };
  }

  let context = null;
  let page = null;

  try {
    const browser = await getBrowser();
    context = await browser.createBrowserContext();
    page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    await page.goto(safe.url.href, { waitUntil: "domcontentloaded" });

    // ‏SPA מרנדר את הטופס אחרי ה-load. ההמתנה היא לשדה הסיסמה ולא לזמן קבוע.
    const passwordSelector =
      selectors.password ||
      (await page
        .waitForSelector('input[type="password"]', { timeout: 12000 })
        .then(() => 'input[type="password"]')
        .catch(() => null));

    if (!passwordSelector) {
      // לפני שמדווחים "לא נמצא טופס" — אולי יש CAPTCHA, וזו תשובה אחרת לגמרי
      const captcha = await firstPresent(page, CAPTCHA_HINTS);
      if (captcha) {
        return {
          ok: false,
          code: "captcha",
          error:
            "בדף ההתחברות יש CAPTCHA, ולכן אי אפשר להתחבר אוטומטית. " +
            "אפשר להדביק סשן מהדפדפן שלך במקום.",
        };
      }
      return {
        ok: false,
        code: "no_login_form",
        error:
          "לא נמצא שדה סיסמה בדף. אם ההתחברות היא דרך גוגל או בשני שלבים — " +
          "המסלול הנכון הוא הדבקת סשן מהדפדפן שלך.",
      };
    }

    const usernameSelector =
      selectors.username || (await firstPresent(page, USERNAME_SELECTORS));
    if (!usernameSelector) {
      return { ok: false, code: "no_login_form", error: "נמצא שדה סיסמה אבל לא שדה שם משתמש" };
    }

    await page.type(usernameSelector, username, { delay: 15 });
    await page.type(passwordSelector, password, { delay: 15 });

    const submitSelector = selectors.submit || (await firstPresent(page, SUBMIT_SELECTORS));

    // ניווט אחרי שליחה אינו מובטח: ‏SPA מתחבר ב-XHR ומחליף מסך בלי ניווט.
    // לכן ממתינים לשניהם — מה שיקרה קודם — ולא נכשלים אם לא היה ניווט.
    const navigation = page
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 })
      .catch(() => null);

    if (submitSelector) {
      await page.click(submitSelector).catch(() => {});
    } else {
      await page.keyboard.press("Enter");
    }

    await navigation;
    // חלון קצר לסיום ה-XHR ולכתיבת הטוקן ל-localStorage
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const stillOnLogin = await page.$('input[type="password"]').catch(() => null);
    const finalUrl = page.url();

    const cookies = await context.cookies().catch(() => []);
    const localStorageEntries = await page
      .evaluate(() => {
        const out = {};
        try {
          for (let i = 0; i < window.localStorage.length; i += 1) {
            const key = window.localStorage.key(i);
            out[key] = window.localStorage.getItem(key);
          }
        } catch (_) {}
        return out;
      })
      .catch(() => ({}));

    const hasSession = cookies.length > 0 || Object.keys(localStorageEntries).length > 0;

    // ── מה נחשב "התחברנו" ──
    //
    // לא נוכחות קוקי: דף התחברות מציב קוקי גם לפני שנכנסת. הבדיקה היא
    // ששדה הסיסמה **נעלם** — כלומר המסך התחלף — ושיש מה לשמור.
    if (stillOnLogin || !hasSession) {
      // הודעת שגיאה מהדף עצמה שווה יותר מכל ניחוש שלנו
      const pageMessage = await page
        .evaluate(() => {
          const candidates = document.querySelectorAll(
            "[class*='error' i], [class*='alert' i], [role='alert'], .invalid-feedback"
          );
          for (const el of candidates) {
            const text = (el.innerText || "").trim();
            if (text) return text.slice(0, 200);
          }
          return "";
        })
        .catch(() => "");

      return {
        ok: false,
        code: "login_failed",
        error:
          pageMessage ||
          "ההתחברות לא הצליחה — הדף נשאר במסך ההתחברות. יש לבדוק שם משתמש וסיסמה.",
        finalUrl,
      };
    }

    return {
      ok: true,
      finalUrl,
      session: {
        cookies,
        localStorage: localStorageEntries,
        origin: `${safe.url.protocol}//${safe.url.host}`,
        savedAt: new Date(),
      },
    };
  } catch (err) {
    return { ok: false, code: "login_failed", error: err.message };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (_) {}
    }
    if (context) {
      try {
        await context.close();
      } catch (_) {}
    }
  }
};

module.exports = { loginToPlatform };

// lib/link-follower/index.js
//
// פתיחת קישור הזמנה שהגיע במייל, וקריאת הטקסט שמעברו.
//
// ── הבעיה שזה פותר ──
//
// פלטפורמות הזמנות (Zestt וכל מי שיבוא אחריה) שולחות מייל שאין בו הזמנה:
// יש בו כותרת, פרטי לקוח, וכפתור "לצפייה בהזמנה". השורות עצמן — מה הוזמן
// ובאיזו כמות — נמצאות רק מעבר לכפתור. הצינור שלנו קורא טקסט, ולכן מייל
// כזה נפל תמיד ל"שגיאה בקריאה" בלי שורה אחת.
//
// המודול הזה פותח את הקישור בדפדפן שרץ בשרת, לוקח את הטקסט של הדף, ומחזיר
// אותו לצינור. משם ממשיך אותו מסלול בדיוק כמו כל מייל אחר — פרסר, קטלוג,
// מלאי, תעודה. הפרסר אינו יודע ואינו מתעניין מאיפה הטקסט בא.
//
// ── למה זה במקום API ──
//
// אינטגרציה מול פלטפורמה דורשת הסכמה שלה, והלקוחות שולחים מכמה פלטפורמות
// שאי אפשר לדעת מראש מי הן. הדפדפן עובד מול כל אחת מהן באותו קוד.
//
// ── הארגז ──
//
// הכתובת מגיעה ממייל, כלומר מקלט שאיש לא מאמת. לכן:
//
//   1. הכתובת נבדקת ב-guards.js לפני פתיחה — וגם בכל הפניה (redirect).
//   2. הקשר דפדפן **נפרד** לכל פתיחה, בלי קוקיז וללא זיכרון בין פתיחות.
//      קוקי סשן מוצמד רק לדומיין שנרשם במפורש כפלטפורמה מאושרת.
//   3. הורדות חסומות. דף עוין לא ימלא לנו את הדיסק.
//   4. timeout על הכול, כולל על עצם הרינדור.
//   5. הדף נסגר תמיד, גם בכשל — אחרת כל מייל היה משאיר לשונית חיה.

const { getBrowser } = require("../headless-browser");
const { assertSafeUrl, isObviouslyPrivateTarget } = require("./guards");

// כמה זמן מותר לדף אחד לקחת. דף הזמנה הוא דף פשוט; מעל זה זו כבר תקלה
// אצלם או אצלנו, ואין טעם להחזיק בגללה את סריקת המייל.
const NAV_TIMEOUT_MS = Number(process.env.LINK_FOLLOW_TIMEOUT_MS) || 25000;

// אחרי שהניווט הסתיים, SPA עדיין מרנדר. זו המתנה קצרה לתוכן שנכנס אחרי
// ה-load — בלעדיה היינו קוראים דף שלד ריק ומדווחים "אין טקסט".
const SETTLE_MS = Number(process.env.LINK_FOLLOW_SETTLE_MS) || 1200;

// טקסט קצר מזה אינו דף הזמנה אלא שלד, שגיאה או "הדף לא נמצא"
const MIN_USEFUL_CHARS = Number(process.env.LINK_FOLLOW_MIN_CHARS) || 120;

// תקרה על הטקסט שנכנס לצינור. דף עם קטלוג שלם היה מנפח את rawText ואת
// הקריאה ל-AI בלי להוסיף מידע על ההזמנה.
const MAX_TEXT_CHARS = Number(process.env.LINK_FOLLOW_MAX_CHARS) || 20000;

// שתי פתיחות במקביל לכל היותר. סריקת מייל יכולה להביא 20 הודעות בבת אחת,
// ו-20 לשוניות Chromium במקביל בשרת של 2GB זה שרת שנפל.
const MAX_CONCURRENT = Number(process.env.LINK_FOLLOW_CONCURRENCY) || 2;

let active = 0;
const waiting = [];

const acquireSlot = () => {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
};

const releaseSlot = () => {
  const next = waiting.shift();
  if (next) return next();      // התור מקבל את המקום ישירות, בלי לרדת ולעלות
  active = Math.max(0, active - 1);
};

/** מרוץ מול שעון — ל-page.screenshot ולהערכות שאין להן timeout משלהן. */
const withTimeout = (promise, ms, message) => {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
};

// ── זיהוי "הדף דורש התחברות" ──
//
// זה לא כשל, וחשוב שלא ידווח כאחד: זה המצב שבו אדם צריך להתחבר פעם אחת
// לפלטפורמה, ומאותו רגע כל ההזמנות ממנה נקראות לבד. הודעת שגיאה כללית
// הייתה שולחת אותו לחפש באג בקוד במקום ללחוץ על כפתור.
const LOGIN_TEXT = [
  /הת?חבר(ות)?\s*(למערכת|לחשבון)?/,
  /כניסה\s+(למערכת|לחשבון|לאזור)/,
  /סיסמ[הא]/,
  /שם\s+משתמש/,
  /sign\s*in/i,
  /log\s*in/i,
  /password/i,
  /forgot\s+your\s+password/i,
];

const LOGIN_URL = /\/(login|signin|sign-in|auth|authenticate|sso)(\/|\?|#|$)/i;

const looksLikeLogin = ({ url, text, hasPasswordField }) => {
  if (hasPasswordField) return true;
  if (LOGIN_URL.test(url)) return true;

  // טקסט בלבד אינו מספיק: דף הזמנה יכול להכיל "התנתק" או קישור "התחברות"
  // בפוטר. נדרשות שתי אינדיקציות, ורק בדף קצר — דף עם הזמנה מלאה הוא ארוך.
  if (text.length > 1500) return false;
  const hits = LOGIN_TEXT.filter((re) => re.test(text)).length;
  return hits >= 2;
};

/**
 * חילוץ הטקסט מהדף.
 *
 * ‏innerText ולא textContent, בכוונה: הוא מחזיר את מה ש**נראה** — בלי
 * סקריפטים, בלי אלמנטים מוסתרים, ועם מעבר שורה בין בלוקים. בטבלה כרום
 * מפריד תאים בטאב, וזה בדיוק מה שהפרסר שלנו מצפה לו (ראה htmlToText).
 */
const readPageText = (page) =>
  page.evaluate(() => {
    const body = document.body;
    if (!body) return { text: "", title: document.title || "", hasPasswordField: false };

    // תפריטים, פוטר ובאנר קוקיז אינם חלק מההזמנה והם מוסיפים רעש לפרסר
    const noise = body.querySelectorAll(
      "nav, header, footer, script, style, noscript, [role=navigation], [aria-hidden=true]"
    );
    const hidden = [];
    noise.forEach((el) => {
      hidden.push([el, el.style.display]);
      el.style.display = "none";
    });

    const text = body.innerText || "";

    hidden.forEach(([el, display]) => {
      el.style.display = display;
    });

    return {
      text,
      title: document.title || "",
      hasPasswordField: Boolean(document.querySelector('input[type="password"]')),
    };
  });

/** צילום מסך קטן לעיני אדם — לא לפרסר. */
const takeScreenshot = async (page) => {
  try {
    const raw = await withTimeout(
      page.screenshot({ type: "jpeg", quality: 55, fullPage: true }),
      8000,
      "צילום המסך לא הסתיים"
    );

    let buffer = Buffer.from(raw);

    // דף ארוך מייצר צילום כבד, והוא נשמר בתוך מסמך ההודעה במונגו. הכיווץ
    // הופך 800KB לכ-60KB — מספיק כדי שאדם יזהה מה הוא רואה.
    try {
      const sharp = require("sharp");
      buffer = await sharp(buffer)
        .resize({ width: 900, withoutEnlargement: true })
        .jpeg({ quality: 50 })
        .toBuffer();
    } catch (_) {
      // sharp אינו חובה כאן — בלעדיו נשמר הצילום המקורי
    }

    // תקרה קשה: מסמך מונגו מוגבל ל-16MB, ורשומת הודעה אינה המקום לתמונות.
    if (buffer.length > 400 * 1024) return null;

    return `data:image/jpeg;base64,${buffer.toString("base64")}`;
  } catch (_) {
    // צילום המסך הוא נוחות. כשלון בו אינו כשלון של קריאת ההזמנה.
    return null;
  }
};

/**
 * פתיחת קישור וקריאת הטקסט שמעברו.
 *
 * אינו זורק על כשל "רגיל" (חסום, לא נטען, דורש התחברות) — הכשל מוחזר
 * במבנה. הקורא הוא צינור קליטת הזמנות, ושם כל מסלול חייב להסתיים ברשומה
 * ולא בחריגה שתפיל את עיבוד שאר ההודעות בסריקה.
 *
 * @param {Object} input
 * @param {string} input.url
 * @param {Object} [input.session] - סשן פלטפורמה: { cookies: [], localStorage: {}, origin }
 * @param {boolean|"always"} [input.screenshot=true] - ‏true = רק כשמשהו השתבש
 *        (זה הרגע שבו אדם צריך לראות מה הדפדפן ראה), ‏"always" = תמיד (מסך
 *        הבדיקה), ‏false = אף פעם. צילום של דף שנקרא בהצלחה עולה כ-300ms
 *        וכ-60KB במסמך ההודעה, ואף אחד לא מסתכל בו — הטקסט הוא הראיה.
 * @returns {Promise<{ok, url, finalUrl, host, text, title, chars, loginRequired, blocked, error, code, screenshot}>}
 */
const followOrderLink = async ({ url, session = null, screenshot = true } = {}) => {
  const result = {
    ok: false,
    url,
    finalUrl: null,
    host: null,
    text: "",
    title: "",
    chars: 0,
    loginRequired: false,
    blocked: false,
    error: null,
    code: null,
    screenshot: null,
    followedAt: new Date(),
  };

  // ── 1. האם מותר בכלל ──
  let safe;
  try {
    safe = await assertSafeUrl(url);
    result.host = safe.url.hostname.toLowerCase();
  } catch (err) {
    result.blocked = true;
    result.code = "link_blocked";
    result.error = err.message;
    return result;
  }

  await acquireSlot();

  let context = null;
  let page = null;

  try {
    const browser = await getBrowser();

    // הקשר נפרד = מיכל קוקיז נפרד. שתי פתיחות אינן רואות זו את זו, ודף
    // שהגיע ממייל אינו נוגע בשום סשן ששמור לפלטפורמה אחרת.
    context = await browser.createBrowserContext();
    page = await context.newPage();

    await page.setViewport({ width: 1280, height: 1400 });
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    // הורדות: לא. דף יכול להתחיל הורדה בעצמו, וקובץ שנשמר בשרת מדיסק של
    // מישהו אחר הוא בדיוק מה שאין לנו צורך בו.
    try {
      const cdp = await page.createCDPSession();
      await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" });
    } catch (_) {
      // גרסת CDP שאינה תומכת — ממשיכים, שאר הגדרות הארגז בתוקף
    }

    // ── הפניות נבדקות גם הן ──
    //
    // הבדיקה הראשונה הייתה על הכתובת מהמייל. דף יכול להחזיר 302 לכל מקום,
    // כולל ל-127.0.0.1 — כלומר לעקוף את השומר לגמרי אם בודקים רק בהתחלה.
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      const target = request.url();

      // ── כל בקשה: חסימה זולה של יעד פנימי מפורש ──
      //
      // הדף שנפתח מריץ JavaScript, והוא רץ אצלנו — כלומר בתוך הרשת הפרטית.
      // בלי הבדיקה הזו דף עוין יכול היה לסרוק את הרשת הפנימית דרך תמונות
      // או fetch, בלי לנווט לשום מקום. הבדיקה סינכרונית (בלי DNS) כי היא
      // רצה על כל משאב בדף.
      if (isObviouslyPrivateTarget(target)) {
        console.log(`[link-follower] בקשה ליעד פנימי נחסמה: ${target}`);
        return request.abort("blockedbyclient").catch(() => {});
      }

      // ── ניווט של המסגרת הראשית: הבדיקה המלאה, כולל DNS ──
      //
      // זה המסלול שבו אנחנו באמת הולכים לקרוא ולשמור תוכן, ולכן הוא שווה
      // את עלות ה-DNS. הפניה (302) מדף תמים לכתובת פנימית נחסמת כאן.
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        try {
          await assertSafeUrl(target);
        } catch (err) {
          console.log(`[link-follower] הפניה נחסמה: ${target} — ${err.message}`);
          return request.abort("blockedbyclient").catch(() => {});
        }
      }

      return request.continue().catch(() => {});
    });

    // ── סשן פלטפורמה, אם יש ──
    //
    // מוצמד רק לדומיין שנרשם במפורש. פלטפורמה שמחזיקה טוקן ב-localStorage
    // (רוב ה-SPA) דורשת ביקור מקדים במקור לפני שאפשר לכתוב אליו — אין דרך
    // לכתוב ל-localStorage של דומיין בלי להיות בו.
    if (session?.cookies?.length) {
      try {
        await context.setCookie(...session.cookies);
      } catch (err) {
        console.log(`[link-follower] טעינת קוקיז נכשלה: ${err.message}`);
      }
    }
    if (session?.localStorage && Object.keys(session.localStorage).length) {
      // ── ההזרקה נעשית לפני שהדף מריץ שורת קוד, ולא בביקור מקדים ──
      //
      // הגרסה הראשונה ניווטה למקור, כתבה ל-localStorage, ואז ניווטה ליעד.
      // זה נשבר בדיוק על מה שנפוץ אצל הפלטפורמות: כתובת עם ניתוב hash
      // (‏app.example.com/#/orders/123). מעבר מהמקור לכתובת כזו נבדל רק
      // ב-hash, כלומר אינו טעינה של מסמך — ‏goto חוזר מיד, בלי להמתין
      // לרינדור, והיינו קוראים את מסך הפתיחה ומדווחים עליו כעל ההזמנה.
      //
      // ‏evaluateOnNewDocument רץ בכל מסמך חדש **לפני** הסקריפטים של הדף,
      // כלומר הטוקן קיים כבר בבדיקת ההתחברות הראשונה של האפליקציה.
      // ── והמקור נבדק שוב **בתוך הדף** ──
      //
      // הבדיקה מי מקבל סשן נעשית לפני הפתיחה (ראה sessionAppliesToHost), אבל
      // ‏evaluateOnNewDocument רץ בכל מסמך — כולל כזה שהגיע אחרי הפניה. דף
      // שמפנה לשרת זר היה גורם לטוקן להיכתב שם. הבדיקה כאן זולה וסוגרת את זה
      // גם כשהשכבה שמעליה טועה.
      const expectedOrigin = session.origin || `${safe.url.protocol}//${safe.url.host}`;
      try {
        await page.evaluateOnNewDocument(
          (entries, allowedOrigin) => {
            try {
              if (window.location.origin !== allowedOrigin) return;
              Object.entries(entries).forEach(([key, value]) => {
                window.localStorage.setItem(key, value);
              });
            } catch (_) {
              // דפדפן שחוסם אחסון לדומיין הזה — הקוקיז עדיין בתוקף
            }
          },
          session.localStorage,
          expectedOrigin
        );
      } catch (err) {
        console.log(`[link-follower] הזרקת הסשן נכשלה: ${err.message}`);
      }
    }

    // ── 2. הניווט ──
    //
    // ‏domcontentloaded ולא networkidle: דף עם פולינג או צ'אט חי לעולם אינו
    // מגיע ל-idle, וההמתנה הייתה נגמרת ב-timeout על דף שכבר מוצג. התוכן
    // של ה-SPA נאסף בהמתנה שאחרי.
    let response = null;
    try {
      response = await page.goto(safe.url.href, { waitUntil: "domcontentloaded" });
    } catch (err) {
      result.code = "link_unreachable";
      result.error = `הדף לא נטען: ${err.message}`;
      return result;
    }

    const status = response?.status?.() ?? 0;
    result.finalUrl = page.url();

    // ── 3. המתנה לתוכן ──
    //
    // ‏SPA מרנדר אחרי ה-load. במקום המתנה קבועה — המתנה עד שיש טקסט, עם
    // תקרה. דף מהיר לא משלם על האיטיים.
    try {
      await page.waitForFunction(
        (min) => (document.body?.innerText || "").trim().length >= min,
        { timeout: SETTLE_MS + 4000, polling: 300 },
        MIN_USEFUL_CHARS
      );
    } catch (_) {
      // אין טקסט גם אחרי ההמתנה — נמשיך ונדווח על מה שיש
    }

    const { text, title, hasPasswordField } = await readPageText(page);
    const clean = String(text || "")
      .replace(/ /g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    result.title = title;
    result.chars = clean.length;
    result.text = clean.slice(0, MAX_TEXT_CHARS);

    // ── 4. מה קיבלנו ──
    //
    // ההכרעה נעשית **לפני** הצילום, כדי שאפשר יהיה לצלם רק כשיש מה לראות.
    // הצילום חייב להיעשות כאן ולא אצל הקורא: הדף נסגר ב-finally.
    const loginRequired = looksLikeLogin({ url: result.finalUrl, text: clean, hasPasswordField });
    const httpError = status >= 400;
    const tooShort = clean.length < MIN_USEFUL_CHARS;
    result.ok = !loginRequired && !httpError && !tooShort;

    if (screenshot === "always" || (screenshot && !result.ok)) {
      result.screenshot = await takeScreenshot(page);
    }

    if (loginRequired) {
      result.ok = false;
      result.loginRequired = true;
      result.code = "platform_login_required";
      result.error =
        "הדף דורש התחברות לפלטפורמה. אחרי התחברות אחת, כל ההזמנות מהפלטפורמה הזו ייקראו אוטומטית.";
      return result;
    }

    if (httpError) {
      result.code = "link_unreachable";
      result.error = `הדף החזיר שגיאה ${status}`;
      return result;
    }

    if (tooShort) {
      result.code = "link_empty";
      result.error = `הדף נפתח אבל לא היה בו טקסט קריא (${clean.length} תווים)`;
      return result;
    }

    return result;
  } catch (err) {
    result.code = "link_failed";
    result.error = err.message;
    return result;
  } finally {
    // סדר הסגירה חשוב: דף לפני הקשר. הקשר שנסגר עם דף פתוח משאיר לפעמים
    // target תלוי, ואלה נצברים לאורך ימים של סריקות.
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
    releaseSlot();
  }
};

module.exports = { followOrderLink, NAV_TIMEOUT_MS, MAX_TEXT_CHARS };

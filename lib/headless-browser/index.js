// lib/headless-browser/index.js
//
// ‏Chromium אחד לכל השרת. שני צרכנים משתמשים בו היום:
//
//   lib/printing/deliveryNotePdf  — הפקת תעודות משלוח
//   lib/link-follower             — פתיחת קישור הזמנה שהגיע במייל
//
// הקוד הזה היה בתוך deliveryNotePdf, והוצא לכאן כשנוסף הצרכן השני. הסיבה
// מעשית: עלייה של דפדפן היא כשנייה וכ-100MB, ושני מודולים שכל אחד מחזיק
// דפדפן משלו היו מכפילים את זה בשרת שממילא צר בזיכרון. חשוב מזה — שניהם
// היו מריצים לוגיקת התאוששות משלהם, וההפרש בין שתי העתקות היה מתגלה
// כתהליך Chromium יתום בזיכרון.
//
// ‏Chromium נטען פעם אחת ומוחזק חי. אבל דפדפן שקרס חייב לקום מעצמו, ולכן
// הבדיקה על connected() בכל קריאה.

let browserPromise = null;

/**
 * טעינת puppeteer.
 *
 * העמסה עצלה ולא require בראש הקובץ, בכוונה: puppeteer הוא התלות הכבדה
 * היחידה שהמערכת הזו הוסיפה, וכשלון בטעינתו אסור שימנע מהשרת לעלות.
 * בלי זה שרת שנפרס בלי ההתקנה המלאה לא היה עולה בכלל — ותקלת הדפסה
 * הייתה מפילה גם את קליטת ההזמנות ואת החיוב.
 *
 * ההודעה מפורשת כי MODULE_NOT_FOUND גולמי בלוג לא אומר לאיש מה לעשות.
 */
const loadPuppeteer = () => {
  try {
    return require("puppeteer");
  } catch (err) {
    if (err.code === "MODULE_NOT_FOUND") {
      throw new Error(
        "puppeteer אינו מותקן בשרת — תעודות לא יודפסו אוטומטית וקישורי הזמנה " +
          "מהמייל לא ייקראו. יש להריץ npm ci בתיקיית sweet-backend. " +
          "אם ההורדה של Chromium חסומה: PUPPETEER_SKIP_DOWNLOAD=true בהתקנה, " +
          "ו-PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium ב-.env."
      );
    }
    throw err;
  }
};

const getBrowser = async () => {
  const puppeteer = loadPuppeteer();

  // ‏current נלכד למשתנה מקומי לפני ה-await, וההחלפה מותנית בכך שאיש לא
  // הספיק להחליף אותו בינתיים.
  //
  // בלי התנאי הזה שתי בקשות שמגיעות יחד אחרי שהדפדפן מת היו שתיהן
  // מאפסות ושתיהן מפעילות — השנייה דורסת את ההפניה של הראשונה, ותהליך
  // Chromium שלם נשאר יתום בזיכרון בלי שאיש מחזיק בו. זה בדיוק מסלול
  // ההתאוששות, כלומר הרגע שבו הכי חשוב שלא ידלוף.
  const current = browserPromise;
  if (current) {
    try {
      const existing = await current;
      if (existing.connected) return existing;
      // מת אבל עדיין מחזיק תהליך — סוגרים במפורש
      existing.close().catch(() => {});
    } catch (_) {
      // ההפעלה הקודמת נכשלה — נופלים להפעלה חדשה למטה
    }
    if (browserPromise === current) browserPromise = null;
  }

  // מכאן ועד ההשמה אין await, ולכן שני קוראים לא יכולים להיכנס לכאן
  // שניהם — ה-event loop אינו נכנס באמצע.
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      // no-sandbox נדרש כשהתהליך רץ כ-root, וזה המצב ב-pm2 על srv2.
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
      ],
    });
  }

  return browserPromise;
};

/** סגירה מסודרת — נקרא מכיבוי השרת, ובבדיקות כדי שהתהליך לא יישאר תלוי. */
const closeBrowser = async () => {
  if (!browserPromise) return;
  const p = browserPromise;
  browserPromise = null;
  try {
    (await p).close();
  } catch (_) {}
};

module.exports = { getBrowser, closeBrowser, loadPuppeteer };

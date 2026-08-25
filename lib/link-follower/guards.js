// lib/link-follower/guards.js
//
// האם מותר לשרת לפתוח את הכתובת הזו.
//
// ── למה בכלל צריך שומר ──
//
// הקישור מגיע מגוף מייל, כלומר מקלט שאנחנו לא שולטים בו. שרת שפותח כתובת
// שהגיעה במייל הוא בדיוק תרחיש SSRF: מי ששולח את המייל בוחר לאן השרת שלנו
// יפנה, והשרת שלנו נמצא **בתוך** הרשת הפרטית. כתובת כמו
// ‏http://169.254.169.254/latest/meta-data/ או http://127.0.0.1:27017 אינה
// נראית מסוכנת בעין, אבל היא קריאה מהמערכות הפנימיות שלנו בשם השרת.
//
// לכן הבדיקה אינה על המחרוזת אלא על **כתובות ה-IP שהדומיין נפתר אליהן**.
// שם דומיין ציבורי לגמרי יכול להצביע על 127.0.0.1, וזו התקפה מוכרת
// (DNS rebinding בגרסת העני). בדיקת מחרוזת בלבד הייתה מפספסת אותה לגמרי.
//
// ── מה השומר הזה *אינו* עושה ──
//
// הוא אינו מגן מפני דף זדוני שמריץ JavaScript בדפדפן שלנו. זו עבודתו של
// הארגז בצד השני (lib/link-follower/index.js): הקשר דפדפן נפרד בלי קוקיז,
// בלי הורדות, ועם timeout.

const dns = require("dns").promises;
const net = require("net");

// פורטים מותרים. דף הזמנה יושב על HTTP(S) רגיל; פורט חריג בכתובת שהגיעה
// במייל הוא כמעט תמיד סריקת שירות פנימי ולא הזמנה.
const ALLOWED_PORTS = new Set([80, 443]);

// דומיינים שאינם ציבוריים מעצם הסיומת שלהם. הם לא ייפתרו בכלל בשרת ציבורי,
// אבל בשרת עם DNS פנימי הם דווקא כן — וזה המצב המסוכן.
const PRIVATE_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp"];

const ipv4ToInt = (ip) =>
  ip.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);

const inRange = (ip, cidr) => {
  const [base, bits] = cidr.split("/");
  const mask = bits === "0" ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
};

// כל מה שאינו האינטרנט הציבורי
const BLOCKED_V4 = [
  "0.0.0.0/8",        // "this network"
  "10.0.0.0/8",       // פרטי
  "100.64.0.0/10",    // CGNAT
  "127.0.0.0/8",      // loopback
  "169.254.0.0/16",   // link-local — כאן יושב ה-metadata של ספקי הענן
  "172.16.0.0/12",    // פרטי
  "192.0.0.0/24",
  "192.168.0.0/16",   // פרטי
  "198.18.0.0/15",    // benchmarking
  "224.0.0.0/4",      // multicast
  "240.0.0.0/4",      // reserved
];

const isPrivateIpv4 = (ip) => BLOCKED_V4.some((cidr) => inRange(ip, cidr));

const isPrivateIpv6 = (ip) => {
  const value = ip.toLowerCase().split("%")[0]; // חיתוך zone id (fe80::1%eth0)

  if (value === "::1" || value === "::") return true;
  if (value.startsWith("fe80:")) return true;                 // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(value)) return true;          // fc00::/7 — unique local

  // IPv4 עטוף ב-IPv6 (::ffff:127.0.0.1) — נבדק בכלים של IPv4
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);

  return false;
};

const isPrivateIp = (ip) =>
  net.isIPv4(ip) ? isPrivateIpv4(ip) : net.isIPv6(ip) ? isPrivateIpv6(ip) : true;

/** שגיאה עם קוד, כדי שהצינור יוכל להבדיל בין "חסום" לבין "נכשל". */
const blocked = (message) => {
  const err = new Error(message);
  err.code = "link_blocked";
  return err;
};

/**
 * בדיקת כתובת לפני פתיחה.
 *
 * @param {string} rawUrl
 * @returns {Promise<{url: URL, addresses: string[]}>}
 * @throws שגיאה עם code="link_blocked" אם אסור לפתוח
 */
const assertSafeUrl = async (rawUrl) => {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch (_) {
    throw blocked(`כתובת לא תקינה: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw blocked(`פרוטוקול ${url.protocol} אינו נפתח (רק http/https)`);
  }

  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  if (!ALLOWED_PORTS.has(port)) {
    throw blocked(`פורט ${port} אינו נפתח — דף הזמנה יושב על 80/443`);
  }

  // ‏hostname של כתובת IPv6 מגיע עטוף בסוגריים ("[::1]"), ובלי הפשטתם
  // ‏net.isIP לא היה מזהה אותה כ-IP בכלל — כלומר loopback היה נבדק כשם דומיין.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (!host.includes(".") && !net.isIP(host)) {
    throw blocked(`"${host}" אינו דומיין ציבורי (שם בלי נקודה = מכונה ברשת הפנימית)`);
  }
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw blocked(`"${host}" הוא שם ברשת פנימית`);
  }

  // כתובת IP שנכתבה ישירות — אין מה לפתור, בודקים אותה כמו שהיא
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw blocked(`הכתובת ${host} היא ברשת פנימית`);
    return { url, addresses: [host] };
  }

  let addresses;
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    addresses = records.map((record) => record.address);
  } catch (err) {
    throw blocked(`הדומיין ${host} לא נפתר (${err.code || err.message})`);
  }

  if (!addresses.length) throw blocked(`הדומיין ${host} לא נפתר לשום כתובת`);

  // **כל** הכתובות חייבות להיות ציבוריות, לא רק הראשונה. דומיין שמצביע גם
  // על כתובת ציבורית וגם על 127.0.0.1 היה עובר בדיקה של "הראשונה בלבד",
  // והדפדפן יכול לבחור דווקא את השנייה.
  const privateHit = addresses.find(isPrivateIp);
  if (privateHit) {
    throw blocked(`הדומיין ${host} מצביע על כתובת ברשת פנימית (${privateHit})`);
  }

  return { url, addresses };
};

/**
 * בדיקה **סינכרונית** של כתובת יעד — בלי DNS.
 *
 * נועדה לכל בקשה שדף מייצר בעצמו: תמונות, XHR, iframes. הדף שנפתח יכול
 * להריץ JavaScript, ו-JavaScript שרץ אצלנו יושב בתוך הרשת הפרטית — כלומר
 * `fetch("http://192.168.1.1/")` מתוך דף שנפתח הוא סריקת רשת פנימית בשמנו.
 *
 * למה סינכרונית ולא assertSafeUrl המלאה: היא נקראת על **כל** משאב בדף
 * (עשרות בקשות), ובדיקת DNS לכל אחת הייתה מכפילה את זמן הטעינה. לכן כאן
 * נבדק מה שאפשר לבדוק במחרוזת — כתובת IP פרטית מפורשת, localhost, שם בלי
 * נקודה, וסיומת פנימית. ניווט של המסגרת הראשית, שהוא המסלול המסוכן באמת,
 * עובר את הבדיקה המלאה עם DNS.
 *
 * @returns {boolean} true = לחסום
 */
const isObviouslyPrivateTarget = (rawUrl) => {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch (_) {
    return false; // ‏data:, blob: וכתובות פנימיות של הדפדפן — לא יעד רשת
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (net.isIP(host)) return isPrivateIp(host);
  if (!host.includes(".")) return true;
  return PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
};

/** גרסה שקטה — לשימוש בסינון רשימת מועמדים, שבו כתובת פסולה סתם יורדת. */
const isSafeUrl = async (rawUrl) => {
  try {
    await assertSafeUrl(rawUrl);
    return true;
  } catch (_) {
    return false;
  }
};

module.exports = {
  assertSafeUrl,
  isSafeUrl,
  isObviouslyPrivateTarget,
  isPrivateIp,
  ALLOWED_PORTS,
};

// lib/order-ingestion/platforms.js
//
// המרשם של פלטפורמות ההזמנות — הצד ההתנהגותי של models/OrderPlatform.
//
// שלושה תפקידים:
//
//   1. **רישום עצמי.** מייל שנראה כמו הודעת פלטפורמה (יש בו קישור הזמנה,
//      והשולח אינו לקוח) רושם את עצמו כפלטפורמה ממתינה. אף אחד לא צריך
//      לדעת מראש מי ישלח — המערכת מספרת מי שלח.
//
//   2. **שער.** רק פלטפורמה שאושרה פעם אחת עוברת את הרשימה הלבנה, וכן —
//      רק אצלה מותר לפתוח את הקישור. פתיחת קישור ממייל שאיש לא אימת היא
//      פעולה של השרת שלנו בשם שולח לא מזוהה, ולכן היא דורשת אישור אחד.
//      הדגל INGESTION_PLATFORM_AUTO_APPROVE=true מבטל את האישור הזה למי
//      שמעדיף אפס נגיעות — זו החלטה של בעל העסק, לא ברירת מחדל.
//
//   3. **מיפוי לקוחות.** במייל של פלטפורמה השולח הוא no-reply@ ולא הלקוח,
//      ולכן זיהוי הלקוח לפי כתובת השולח — הדרך שכל שאר הצינור עובד בה —
//      לא רק נכשל אלא **מסוכן**: הוא היה יוצר כרטיס לקוח בשם הפלטפורמה
//      ומצמיד אליו את ההזמנות של כולם.

const OrderPlatform = require("../../models/OrderPlatform");
const { platformKeyOf } = require("../../models/OrderPlatform");

const AUTO_APPROVE = () => process.env.INGESTION_PLATFORM_AUTO_APPROVE === "true";

/**
 * נרמול מזהה להשוואה.
 *
 * "77521-942", "77521942" ו-"‏77521 942" הם אותו מספר לקוח שנכתב בשלוש
 * צורות בשלושה מיילים. השוואת מחרוזות גולמית הייתה מייצרת שלוש רשומות
 * מיפוי לאותו לקוח — ואז מייל בפורמט רביעי היה נכשל בלי סיבה מובנת.
 */
const normalizeRef = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[\s‏‎]+/g, "")
    .replace(/["'`׳״]/g, "")
    .replace(/[-–—_.]/g, "")
    .trim();

/** נרמול שם עסק — להשוואה בלבד, לא לתצוגה. */
const normalizeName = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[‏‎]/g, "")
    .replace(/\(.*?\)/g, " ")                    // "(פתאל וורקספייס שותפות מוגבלת בעמ)"
    // ‏\b אינו חל על עברית: ‏\w ב-JavaScript הוא [A-Za-z0-9_] בלבד, ולכן אין
    // גבול מילה בין רווח לאות עברית — הביטוי הקודם פשוט לא התאים ל"בעמ"
    // לעולם. גבול מפורש של רווח/קצה מחרוזת עובד בשתי השפות.
    .replace(/(^|\s)(בע["״׳']?מ|בעמ|ltd|inc|llc)(?=\s|$)/gi, " ")
    .replace(/["'`׳״]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * מזהים אפשריים של הלקוח מתוך הודעת פלטפורמה.
 *
 * מה שנחפש בהודעה כמו:
 *   "הזמנה חדשה מ ROOMS בסר פתח תקווה (פתאל וורקספייס ...) מס' 77521-942"
 *   "ROOMS בסר פתח תקווה (633) שלח הזמנה חדשה: 7667033"
 *
 * שלוש קבוצות: מספר לקוח/ספק, מספר בסוגריים, ושם העסק מהכותרת. אחת מהן
 * תספיק כדי לזהות את הלקוח בפעם הבאה.
 */
const extractPlatformRefs = ({ subject = "", text = "" } = {}) => {
  const haystack = `${subject}\n${text}`;
  const refs = new Set();
  const names = new Set();

  // "מס' 77521-942" / "מספר לקוח: 633" / "ח.פ 514..." — מזהה מפורש
  const labeled = /(?:מס['׳"]?|מספר|קוד|ח\.?פ|customer|account|supplier)[\s:]*([0-9][0-9\-\/]{2,20})/gi;
  let hit;
  while ((hit = labeled.exec(haystack)) !== null) refs.add(hit[1]);

  // מספר בסוגריים אחרי שם — "(633)". נפוץ כמספר סניף.
  const parenthesized = /\(\s*([0-9]{2,10})\s*\)/g;
  while ((hit = parenthesized.exec(haystack)) !== null) refs.add(hit[1]);

  // שם העסק מכותרת "הזמנה חדשה מ X בסר..." — עד לסוגריים או "מס'"
  const fromName = haystack.match(
    /הזמנה\s+חדשה\s+מ[\s־-]*(.{2,80}?)(?=\s*[\(]|\s+מס['׳"]|\n|$)/
  );
  if (fromName) names.add(fromName[1].trim());

  // "X שלח הזמנה חדשה" — אותו שם, מהניסוח השני
  const senderName = haystack.match(/^(.{2,80}?)\s+שלח[ה]?\s+הזמנה/m);
  if (senderName) names.add(senderName[1].trim());

  return {
    refs: [...refs].filter(Boolean),
    names: [...names].map((n) => n.replace(/\s+/g, " ").trim()).filter((n) => n.length >= 2),
  };
};

/**
 * רצפי הספרות שבטקסט.
 *
 * ── למה זה לא "חיפוש המזהה בתוך ההודעה" ──
 *
 * הגרסה הראשונה חיפשה את המזהה כתת-מחרוזת. זה עבד, וזה היה מסוכן: מזהה כמו
 * "633" נמצא בתוך מספר טלפון (052-633-1234), בתוך מחיר ובתוך מספר הזמנה.
 * התוצאה הייתה שיוך ההזמנה **ללקוח הלא נכון** — עם המחירון שלו ועם תעודת
 * משלוח לכתובת שלו. באג כזה גם כמעט בלתי אפשרי לגלות: ההזמנה נכנסת בהצלחה.
 *
 * לכן ההשוואה היא **שוויון מול רצף שלם** ולא הכלה. "633" שווה לרצף "633"
 * שבסוגריים, ואינו שווה לרצף "0526331234".
 *
 * שתי מידות של "רצף": אחת שמאחדת ספרות שמופרדות במקף בלבד, ואחת שמאחדת גם
 * רווח — כדי ש-"77521-942" ו-"77521 942" יזוהו שניהם. איחוד רחב מדי אינו
 * מסוכן כאן דווקא בגלל השוויון: הוא יכול לגרום להחמצה, לא להתאמה שגויה.
 */
const digitRuns = (text, allowSpace) => {
  const sep = allowSpace ? "[\\s\\u200e\\u200f\\-–—_.]" : "[\\u200e\\u200f\\-–—_.]";
  const collapsed = String(text || "").replace(
    new RegExp(`(?<=\\d)${sep}+(?=\\d)`, "g"),
    ""
  );
  return new Set(collapsed.match(/\d+/g) || []);
};

/**
 * האם מותר להצמיד את הסשן הזה לכתובת הזו.
 *
 * ── למה זו שאלה של אבטחה ולא של נוחות ──
 *
 * כותרת ה-From במייל אינה מאומתת. כל אחד יכול לשלוח מייל שנראה כאילו הגיע
 * מ-no-reply@zestt.io ולשתול בו קישור לשרת שלו. בלי הבדיקה הזו הצינור היה
 * מצמיד לקישור הזה את הסשן השמור של הפלטפורמה — והטוקן היה **נכתב
 * ל-localStorage של השרת הזר**, כלומר נמסר למי שביקש אותו במייל אחד.
 *
 * ── למה לפי מקור הסשן ולא לפי רשימת הדומיינים של הפלטפורמה ──
 *
 * ‏linkHosts נבנה מהדומיינים שראינו בקישורים שהגיעו במייל, כלומר מקלט שאותו
 * תוקף שולט בו. הוא היה יכול לשתול את הדומיין שלו במייל אחד ("נרשם כדומיין
 * מוכר"), ובמייל השני לקבל את הסשן. לכן מקור האמון הוא **המקום שבו באמת
 * התחברנו** — כתובת שאדם הקליד או אישר, ולא כתובת שהגיעה בדואר.
 *
 * ההשוואה היא על הדומיין הרשום, ולא על סיומת מחרוזת: "app.zester.co.il.evil.com"
 * מסתיים ב-"evil.com" ואינו שייך לאיש מלבד לתוקף.
 */
const sessionAppliesToHost = (session, host) => {
  if (!session?.origin || !host) return false;

  let originHost;
  try {
    originHost = new URL(session.origin).hostname.toLowerCase();
  } catch (_) {
    return false;
  }

  const clean = String(host).toLowerCase().trim();
  if (clean === originHost) return true;

  const originKey = platformKeyOf(originHost);
  return Boolean(originKey) && platformKeyOf(clean) === originKey;
};

/**
 * הפלטפורמה של שולח, אם קיימת במרשם.
 *
 * שאילתה ישירה ולא מטמון בזיכרון, בשונה מהרשימה הלבנה של הלקוחות: שם
 * הבדיקה רצה על **כל הודעת ווצאפ** ולכן שילמה סריקת אוסף, וכאן היא רצה רק
 * על מייל, רק לפי מפתח עם אינדקס ייחודי, וכמה מיילים בדקה זה כלום. מטמון
 * היה מוסיף שאלה של "מתי הוא מתיישן" בלי להרוויח דבר.
 */
const findPlatformForSender = async (email) => {
  const key = platformKeyOf(email);
  if (!key) return null;
  return OrderPlatform.findOne({ key });
};

/** האם מותר לקרוא הודעות מהשולח הזה כפלטפורמה. */
const isApprovedPlatformSender = async (email) => {
  const platform = await findPlatformForSender(email);
  if (!platform) return { approved: false, platform: null };
  return { approved: platform.status === "approved", platform };
};

/**
 * רישום הופעה של פלטפורמה.
 *
 * נקרא גם כשההודעה נדחית (שולח לא מוכר) — וזו כל הנקודה: מסך "פלטפורמות
 * חדשות" נבנה בדיוק מהדחיות האלה, ולכן דחייה חייבת להשאיר עקבות. בלי זה
 * "לא ידעתי שמישהו שולח לי ככה" נשאר בלי תשובה.
 *
 * @returns {Promise<Object|null>} מסמך הפלטפורמה, או null אם אין דומיין תקין
 */
const recordSighting = async ({
  senderEmail,
  senderName,
  subject,
  links = [],
  linkHost,
} = {}) => {
  const key = platformKeyOf(senderEmail);
  if (!key) return null;

  const now = new Date();
  const sample = links[0]?.url;
  const hosts = [...new Set([...links.map((l) => l.host).filter(Boolean), linkHost].filter(Boolean))];

  const update = {
    $inc: { "stats.seen": 1 },
    $set: {
      "stats.lastSeenAt": now,
      ...(sample ? { lastLinkSample: String(sample).slice(0, 500) } : {}),
      ...(subject ? { lastSubjectSample: String(subject).slice(0, 300) } : {}),
    },
    $setOnInsert: {
      key,
      // שם השולח הוא ניחוש טוב לשם הפלטפורמה ("Zestt"), וניתן לעריכה במסך
      name: String(senderName || key).slice(0, 120),
      "stats.firstSeenAt": now,
      // ── ברירת המחדל היא "ממתינה", גם במצב אישור אוטומטי ──
      // ההחלטה נעשית בשורה הבאה ולא כאן, כי $setOnInsert רץ רק ביצירה
      // ולא היה מעדכן פלטפורמה שנרשמה לפני שהדגל הודלק.
      status: AUTO_APPROVE() ? "approved" : "pending",
      ...(AUTO_APPROVE() ? { approvedAt: now, approvedBy: "אישור אוטומטי (דגל מערכת)" } : {}),
    },
    ...(hosts.length ? { $addToSet: { linkHosts: { $each: hosts } } } : {}),
  };

  // ── מרוץ upsert ──
  //
  // שתי הודעות מאותה פלטפורמה **חדשה** שנקלטות באותו רגע מגיעות שתיהן
  // ל-upsert לפני שהאינדקס הייחודי נוצר עבור אחת מהן, ומונגו דוחה את השנייה
  // ב-E11000. בלי הטיפול הזה ההודעה השנייה נשמרת בלי שיוך לפלטפורמה — כלומר
  // רשומה יתומה שכפתור "אשר פלטפורמה" לא יודע על מה לפעול. בניסיון השני
  // הרשומה כבר קיימת, ולכן הוא מתנהג כעדכון רגיל ומצליח.
  const upsert = () =>
    OrderPlatform.findOneAndUpdate({ key }, update, {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    });

  try {
    return await upsert();
  } catch (err) {
    if (err.code === 11000) return upsert();
    throw err;
  }
};

/** תוצאת פתיחת קישור — נצברת לתצוגה במסך הפלטפורמות. */
const recordFollowOutcome = async (platformId, { ok, code, error, host, requiresLogin } = {}) => {
  if (!platformId) return;

  const set = {};
  const inc = {};

  if (ok) inc["stats.followed"] = 1;
  else inc["stats.failed"] = 1;

  if (error) {
    set["stats.lastError"] = String(error).slice(0, 500);
    set["stats.lastErrorAt"] = new Date();
  }
  // ‏requiresLogin נקבע מהניסיון: הדף אמר לנו בעצמו. וכשההתחברות עבדה,
  // הדגל חייב לחזור לכבוי — אחרת המסך היה ממשיך לבקש חיבור לנצח.
  if (typeof requiresLogin === "boolean") set.requiresLogin = requiresLogin;
  if (requiresLogin) set["session.expiredAt"] = new Date();

  const update = {};
  if (Object.keys(inc).length) update.$inc = inc;
  if (Object.keys(set).length) update.$set = set;
  if (host) update.$addToSet = { linkHosts: host };
  if (!Object.keys(update).length) return;
  await OrderPlatform.updateOne({ _id: platformId }, update);
};

/** הזמנה נקראה במלואה דרך הפלטפורמה. */
const recordOrderRead = async (platformId, { mappingKey } = {}) => {
  if (!platformId) return;
  await OrderPlatform.updateOne({ _id: platformId }, { $inc: { "stats.ordersRead": 1 } });
  if (mappingKey) {
    await OrderPlatform.updateOne(
      { _id: platformId, "customerMap.keys": mappingKey },
      { $inc: { "customerMap.$.orderCount": 1 } }
    );
  }
};

/**
 * איזה לקוח שלנו מוזכר בהודעה הזו.
 *
 * חיפוש המזהים השמורים בתוך הטקסט, ולא להיפך: המזהה יכול להופיע בכל מקום
 * בהודעה ובכל פורמט, ולכן הטקסט מנורמל פעם אחת וכל מפתח נבדק מולו.
 *
 * @returns {{customer: ObjectId, entry: Object, matchedKey: string}|null}
 */
const findMappedCustomer = (platform, { subject = "", text = "" } = {}) => {
  if (!platform?.customerMap?.length) return null;

  const haystack = `${subject}\n${text}`;
  const normalizedNames = normalizeName(haystack);

  // מחושבים פעם אחת לכל ההודעה ולא לכל מפתח — פלטפורמה עם 80 לקוחות ממופים
  // הייתה סורקת את הטקסט 160 פעם.
  const runsTight = digitRuns(haystack, false);
  const runsLoose = digitRuns(haystack, true);

  for (const entry of platform.customerMap) {
    for (const raw of entry.keys || []) {
      const normalized = normalizeRef(raw);
      if (!normalized) continue;

      const digits = normalized.replace(/\D/g, "");

      // ── מזהה מספרי ──
      //
      // סף של שלוש ספרות: מזהה של ספרה או שתיים ("7") היה נמצא בכל הודעה
      // שיש בה מספר כלשהו, ואין שום דרך להבדיל אותו מכמות או ממחיר.
      if (digits.length >= 3 && digits.length === normalized.length) {
        if (runsTight.has(digits) || runsLoose.has(digits)) {
          return { customer: entry.customer, entry, matchedKey: raw };
        }
        continue;
      }

      // ── מזהה שהוא שם עסק (או שם עם ספרות בתוכו) ──
      //
      // כאן הרווחים נשמרים בנרמול, ולכן אין את בעיית מרק הספרות. סף של
      // שלושה תווים כדי ש-"בן" לא יתאים לכל הודעה שנייה.
      const nameKey = normalizeName(raw);
      if (nameKey.length >= 3 && normalizedNames.includes(nameKey)) {
        return { customer: entry.customer, entry, matchedKey: raw };
      }
    }
  }

  return null;
};

/** אישור פלטפורמה — הפעולה שהופכת "ממתינה" ל"נקראת אוטומטית". */
const approvePlatform = async ({ platformId, key, name, by }) => {
  const query = platformId ? { _id: platformId } : { key: platformKeyOf(key) };
  return OrderPlatform.findOneAndUpdate(
    query,
    {
      $set: {
        status: "approved",
        approvedAt: new Date(),
        approvedBy: by || "אדמין",
        ...(name ? { name: String(name).slice(0, 120) } : {}),
      },
    },
    { new: true }
  );
};

/** הוספת מיפוי לקוח — "המסעדה הזאת אצלם היא הכרטיס הזה אצלנו". */
const mapCustomer = async ({ platformId, keys, externalName, customerId, by }) => {
  const clean = [...new Set((keys || []).map((k) => String(k).trim()).filter(Boolean))];
  if (!clean.length) throw new Error("אין מזהה למיפוי");

  // מיפוי קיים לאותו לקוח מתעדכן במקום להיכפל — אחרת שני מיפויים סותרים
  // לאותה מסעדה היו מכריעים לפי סדר במערך, כלומר באג שתלוי בהיסטוריה.
  const existing = await OrderPlatform.findOne({
    _id: platformId,
    "customerMap.customer": customerId,
  });

  if (existing) {
    await OrderPlatform.updateOne(
      { _id: platformId, "customerMap.customer": customerId },
      {
        $addToSet: { "customerMap.$.keys": { $each: clean } },
        $set: {
          "customerMap.$.mappedAt": new Date(),
          "customerMap.$.mappedBy": by || "אדמין",
          ...(externalName ? { "customerMap.$.externalName": externalName } : {}),
        },
      }
    );
  } else {
    await OrderPlatform.updateOne(
      { _id: platformId },
      {
        $push: {
          customerMap: {
            keys: clean,
            externalName,
            customer: customerId,
            mappedAt: new Date(),
            mappedBy: by || "אדמין",
            orderCount: 0,
          },
        },
      }
    );
  }

  return OrderPlatform.findById(platformId);
};

module.exports = {
  platformKeyOf,
  sessionAppliesToHost,
  findPlatformForSender,
  isApprovedPlatformSender,
  recordSighting,
  recordFollowOutcome,
  recordOrderRead,
  findMappedCustomer,
  extractPlatformRefs,
  approvePlatform,
  mapCustomer,
  normalizeRef,
  normalizeName,
  AUTO_APPROVE,
};

// lib/order-ingestion/index.js
//
// נקודת הכניסה של קליטת ההזמנות מהמייל ומווצאפ.
//
//   ingestMessage()  — הודעה נכנסת → הזמנה במערכת
//   reprocess()      — הרצה חוזרת אחרי תיקון הסיבה (כפתור בדשבורד)
//
// זרימה:
//   1. מניעת כפילות לפי externalId — אותה הודעה לא תיצור שתי הזמנות.
//   2. חילוץ ע"י OpenAI. אם ההודעה אינה הזמנה — נגמר כאן, בלי הזמנה.
//   3. זיהוי הלקוח. נעשה מוקדם, כי הזמנה חייבת להיות משויכת ללקוח — גם הזמנת
//      שגיאה. זה המצב היחיד שבו לא נוצרת הזמנה בכלל.
//   3ב. הזמנה שיושבת מעבר לקישור: אם לא נקראו פריטים ובגוף ההודעה יש קישור
//      להזמנה (Zestt וכל פלטפורמה אחרת), הקישור נפתח בדפדפן שרץ בשרת והטקסט
//      שנקרא ממנו נוסף להודעה — ואז היא נקראת שוב. ראה lib/link-follower.
//   4. התאמת הפריטים לקטלוג + פתירת יעד המשלוח.
//   5. הכול נקרא → הזמנה ב"טופלה". משהו לא נקרא → הזמנה ב"שגיאה בקריאה",
//      עם מה שכן נקרא.
//
// כל הודעה מקבלת גם רשומת IncomingOrder — יומן ביקורת מול הטקסט המקורי.

const IncomingOrder = require("../../models/IncomingOrder");
const { INCOMING_ORDER_ERROR_CODES } = require("../../models/IncomingOrder");
const Order = require("../../models/Order");
const Customer = require("../../models/Customer");
const OrderPlatform = require("../../models/OrderPlatform");
const { extractOrder } = require("./llm");
const { parseOrderText } = require("./tableParser");
const { resolveItems, resolveCustomer, resolveDelivery } = require("./resolvers");
const { isAllowedSender } = require("./senderWhitelist");
const {
  recordSighting,
  recordFollowOutcome,
  recordOrderRead,
  findMappedCustomer,
  extractPlatformRefs,
  sessionAppliesToHost,
} = require("./platforms");
const { followOrderLink } = require("../link-follower");
const { createOrderFromParsed, createErrorOrder } = require("./createOrder");
const { sendEmailSilent } = require("../email-sender/sender");
const { canonicalPhone } = require("../../utils/phone");
const {
  getCustomerPriceMap,
  effectivePrice,
} = require("../../utils/customerPriceList");
const {
  getCustomerPurchaseProfile,
} = require("../../utils/customerPurchaseHistory");

// ביטחון כולל מתחת לסף הזה → הזמנת שגיאה במקום הזמנה תקינה
const MIN_ORDER_CONFIDENCE = Number(process.env.INGESTION_MIN_ORDER_CONFIDENCE) || 0.7;

// האם לקבל הזמנה חלקית כתקינה כשחלק מהפריטים לא זוהו.
// ברירת המחדל false: הזמנה חלקית שנכנסת ל"טופלה" תילקט ותישלח בלי מוצר
// שהלקוח ביקש, ואף אחד לא יידע. עם false היא נכנסת ל"שגיאה בקריאה" — כלומר
// עדיין נכנסת למערכת, אבל לא תילקט לפני שאדם אישר אותה.
const ALLOW_PARTIAL = process.env.INGESTION_ALLOW_PARTIAL === "true";

const FAILURE_ALERT_EMAIL =
  process.env.INGESTION_ALERT_EMAIL ||
  process.env.ADD_ORDER_ERROR_ALERT_EMAIL ||
  process.env.OUR_EMAIL;

// תאריך חוקי או null. נדרש לכל חישוב הפרש זמנים על קלט חיצוני: חותמת זמן
// שהגיעה כמחרוזת, כמספר, או כזבל — new Date() ממנה יכול להיות Invalid Date,
// ו-getTime() עליו מחזיר NaN שמזהם כל השוואה אחריו בשקט.
const toValidDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const log = (doc, step, message) => {
  doc.logs.push({ at: new Date(), step, message });
  console.log(`[ingestion:${doc.channel}:${doc._id}] ${step} — ${message}`);
};

// ── בחירת מנוע הניתוח ──
//
// המנוע הראשי הוא הפרסר הפנימי הדטרמיניסטי (tableParser). הוא קורא טבלאות
// ורשימות פריטים בלי שירות חיצוני, בלי עלות, ובלי שנתוני לקוחות יוצאים מהשרת.
//
// ה-AI החיצוני נשאר בקוד אבל **כבוי בברירת מחדל**. הוא רלוונטי רק לטקסט חופשי
// שהפרסר לא הצליח לקרוא, ומופעל בהדלקה מפורשת:
//     INGESTION_USE_EXTERNAL_AI=true
const USE_EXTERNAL_AI = process.env.INGESTION_USE_EXTERNAL_AI === "true";

/**
 * ניתוח ההודעה: פנימי תחילה, וה-AI רק כנפילה ורק אם הודלק.
 */
const analyzeMessage = async (doc) => {
  const internal = parseOrderText({
    text: doc.rawText,
    channel: doc.channel,
    sender: doc.sender,
    subject: doc.subject,
    // קובץ מצורף הוא ראיה להזמנה בפני עצמו — גם תמונה והקלטה, שמהן לא מחולץ
    // טקסט כלל. בלעדיו הזמנה שנשלחה כצילום של דף נסגרת כ"הודעת שיחה".
    attachments: doc.attachments || [],
    // ההודעות שנצברו, כל אחת בנפרד. ‏rawText הוא שרשור שלהן, ולכן ספירת שורות
    // עליו סופרת תורות בשיחה כשורות ברשימה — ראה looksLikeOrderAttempt.
    segments: (doc.messages || []).map((message) => message.text),
  });

  if (internal.isOrder) {
    log(
      doc,
      "extract",
      `נותח במנוע הפנימי (${internal.method}): ${internal.items.length} פריטים, ביטחון ${internal.confidence}`
    );
    return internal;
  }

  // הפרסר הפנימי לא זיהה פריטים.
  // אם ההודעה שיחתית בבירור (שאלה קצרה) — אין מה לחפש, וגם לא כדאי לבזבז
  // עליה קריאה בתשלום.
  if (internal.certainNotOrder || !USE_EXTERNAL_AI) {
    log(
      doc,
      "extract",
      internal.certainNotOrder
        ? `המנוע הפנימי: ${internal.notAnOrderReason}`
        : `המנוע הפנימי לא קרא את ההודעה (${internal.notAnOrderReason}). ה-AI החיצוני כבוי.`
    );
    return internal;
  }

  // נפילה ל-AI חיצוני — רק כשהודלק במפורש
  log(doc, "extract", "המנוע הפנימי לא קרא את ההודעה — נפילה ל-AI חיצוני");
  try {
    const external = await extractOrder({
      text: doc.rawText,
      channel: doc.channel,
      sender: doc.sender,
      subject: doc.subject,
    });
    external.parsedBy = "external-ai";
    log(
      doc,
      "extract",
      `נותח ב-AI חיצוני: ${external.isOrder ? `${external.items.length} פריטים` : "אינה הזמנה"}, ביטחון ${external.confidence}`
    );
    return external;
  } catch (err) {
    // כשל ב-AI לא מוחק את מה שהמנוע הפנימי כבר קבע
    log(doc, "extract", `ה-AI החיצוני נכשל: ${err.message}`);
    return internal;
  }
};

// ── פתיחת קישורי הזמנה ──
//
// כבוי מפורש (false) מחזיר את ההתנהגות הקודמת: מייל בלי שורות הזמנה בגוף
// נשאר "שגיאה בקריאה". שימושי אם Chromium אינו זמין בשרת.
const FOLLOW_LINKS = () => process.env.INGESTION_FOLLOW_LINKS !== "false";

// כמה קישורים לנסות בהודעה אחת. הראשון הוא בעל הניקוד הגבוה, כלומר כמעט
// תמיד הכפתור הנכון; השני הוא הגיבוי למקרה שהראשון היה דף ביניים.
const MAX_LINKS_PER_MESSAGE = Number(process.env.LINK_FOLLOW_MAX_PER_MESSAGE) || 2;

// הכותרת שמפרידה בין מה שהיה במייל למה שנקרא מהדף. גם סימן לאדם שקורא את
// הרשומה, וגם הסימון שמאפשר להסיר את התוספת לפני הרצה חוזרת.
const PAGE_TEXT_MARKER = "──── תוכן הדף שמעבר לקישור";

/** הדומיין מתוך כתובת, בלי לזרוק על כתובת פגומה. */
const hostOf = (url) => {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch (_) {
    return null;
  }
};

/**
 * הסרת תוכן דף שצורף בהרצה קודמת.
 *
 * בלי זה הרצה חוזרת על הודעה שכבר נקרא לה הדף הייתה משרשרת עותק שני של אותו
 * דף ל-rawText — ובהרצה שלישית עותק שלישי. הודעה עם טבלת הזמנה הייתה מגיעה
 * לפרסר עם כל שורה פעמיים, כלומר סיכון לכמויות כפולות בהזמנה. ‏rawText חייב
 * להישאר "מה שהגיע + קריאה אחת של הדף", בכל מספר הרצות.
 */
const withoutPreviousPageText = (rawText) => {
  const at = String(rawText || "").indexOf(`\n\n${PAGE_TEXT_MARKER}`);
  return at === -1 ? rawText : String(rawText).slice(0, at);
};

/**
 * ההזמנה נמצאת מעבר לקישור — פותחים אותו וקוראים משם.
 *
 * ‏Zestt ודומותיה שולחות מייל שאין בו הזמנה: כותרת, פרטי לקוח, וכפתור
 * "לצפייה בהזמנה". הפרסר קורא טקסט, ולכן מייל כזה נפל תמיד ל"שגיאה בקריאה"
 * בלי שורה אחת. כאן הדפדפן שבשרת פותח את הכפתור, והטקסט שמעברו נוסף
 * ל-rawText — משם ממשיך אותו מסלול בדיוק כמו כל מייל אחר.
 *
 * הקישור נפתח רק אחרי שהשולח עבר את הרשימה הלבנה (לקוח מוכר או פלטפורמה
 * שאושרה), או כשאדמין הריץ מחדש בעצמו. פתיחת קישור ממייל שאיש לא אימת היא
 * פעולה של השרת שלנו בשם שולח לא מזוהה, וזה בדיוק מה שהשער מונע.
 *
 * @returns {Promise<{enriched: boolean, errorCode?: string, error?: string}>}
 */
const followLinksForDoc = async (doc) => {
  const links = (doc.links || []).filter((link) => link?.url).slice(0, MAX_LINKS_PER_MESSAGE);
  if (!links.length) return { enriched: false };

  if (!FOLLOW_LINKS()) {
    log(doc, "link", "יש קישור להזמנה, אבל פתיחת קישורים כבויה (INGESTION_FOLLOW_LINKS=false)");
    return { enriched: false };
  }

  // סשן הפלטפורמה, אם נשמר. הוא מוצמד לפלטפורמה ולא להודעה — התחברות אחת
  // משרתת את כל הלקוחות שמזמינים דרכה.
  let platform = null;
  if (doc.platform?.ref) {
    platform = await OrderPlatform.findById(doc.platform.ref).catch(() => null);
  }
  const savedSession =
    platform?.session?.cookies?.length || platform?.session?.localStorage
      ? platform.session
      : null;

  let lastFailure = null;

  for (const link of links) {
    // ── הסשן מוצמד רק לדומיין שבו באמת התחברנו ──
    //
    // כותרת ה-From אינה מאומתת: אפשר לשלוח מייל שנראה כאילו הגיע מהפלטפורמה
    // ולשתול בו קישור לשרת זר. בלי התנאי הזה הטוקן השמור שלנו היה נכתב
    // ל-localStorage של אותו שרת. הקישור עדיין נפתח — פשוט בלי מפתחות.
    const linkHost = link.host || hostOf(link.url);
    const trusted = sessionAppliesToHost(savedSession, linkHost);
    const session = trusted ? savedSession : null;

    if (savedSession && !trusted) {
      log(
        doc,
        "link",
        `הקישור מוביל ל-${linkHost || "דומיין לא ידוע"}, שאינו הדומיין שבו התחברנו ` +
          `(${savedSession.origin}) — נפתח בלי הסשן`
      );
    }

    log(doc, "link", `פותח את הקישור בדפדפן: ${link.url}`);

    const result = await followOrderLink({ url: link.url, session });

    // נשמר גם בכשל — זה ההסבר שהמסך מציג, וגם צילום המסך שמראה מה נפתח
    doc.linkFollow = {
      attempted: true,
      url: link.url,
      host: result.host || link.host,
      finalUrl: result.finalUrl,
      title: result.title,
      chars: result.chars,
      ok: result.ok,
      code: result.code,
      error: result.error,
      loginRequired: result.loginRequired,
      blocked: result.blocked,
      followedAt: result.followedAt,
      // ‏null ולא undefined: השמה לנתיב מקונן ב-Mongoose ממזגת ואינה מחליפה,
      // ולכן undefined היה משאיר את הצילום מהניסיון הקודם ליד תוצאה חדשה.
      screenshot: result.screenshot || null,
    };

    await recordFollowOutcome(doc.platform?.ref, {
      ok: result.ok,
      code: result.code,
      error: result.error,
      host: result.host,
      // מדווח גם כשהתשובה היא "לא", כדי שסשן שהתחדש יכבה את הדגל
      requiresLogin: result.loginRequired,
    }).catch((err) => console.log(`[ingestion] עדכון מרשם הפלטפורמות נכשל: ${err.message}`));

    if (result.ok) {
      // ── אותה הזמנה, הודעה שנייה ──
      //
      // ‏externalId מונע עיבוד כפול של אותה הודעה, אבל פלטפורמה שולחת לפעמים
      // התראה ואחריה תזכורת על אותה הזמנה — שתי הודעות שונות עם אותו קישור.
      // בלי הבדיקה הזו נוצרות שתי הזמנות זהות, כלומר סחורה שנשלחת פעמיים.
      // הבדיקה נעשית **אחרי** הפתיחה ולא לפניה, כי רק הפתיחה מוכיחה שהקישור
      // באמת מוביל להזמנה, וכי כתובת אחת יכולה להופיע בכמה צורות.
      const alreadyOrdered = await IncomingOrder.findOne({
        _id: { $ne: doc._id },
        "linkFollow.url": link.url,
        status: "order_created",
      })
        .select("invoice order")
        .lean();

      if (alreadyOrdered) {
        log(
          doc,
          "link",
          `הקישור הזה כבר נקרא ונוצרה ממנו הזמנה ${alreadyOrdered.invoice} — לא נוצרת הזמנה נוספת`
        );
        return {
          enriched: false,
          duplicateOf: alreadyOrdered,
        };
      }

      // הפרדה ברורה בין מה שהיה במייל למה שנקרא מהדף. גם הפרסר וגם אדם
      // שמסתכל ברשומה צריכים לדעת מאיפה כל חלק בא — והכותרת היא גם מה
      // שמאפשר להרצה חוזרת להחליף את התוכן במקום לשרשר אליו.
      doc.rawText =
        `${withoutPreviousPageText(doc.rawText)}\n\n` +
        `${PAGE_TEXT_MARKER} (${result.host}) ────\n` +
        `${result.text}`;

      log(
        doc,
        "link",
        `הדף נקרא: ${result.chars} תווים${result.title ? ` ("${result.title}")` : ""}`
      );
      return { enriched: true };
    }

    log(doc, "link", `הקישור לא נקרא (${result.code}): ${result.error}`);
    lastFailure = result;

    // דף שדורש התחברות אינו כשל שממשיכים ממנו לקישור הבא — הקישור הבא
    // יבקש את אותה התחברות. עוצרים ומדווחים מה חסר.
    if (result.loginRequired) {
      return {
        enriched: false,
        errorCode: "platform_login_required",
        error: result.error,
      };
    }
  }

  return {
    enriched: false,
    errorCode: "link_unreadable",
    error: lastFailure?.error || "הקישור להזמנה לא נפתח",
  };
};

/**
 * איזה לקוח שלנו שלח את ההזמנה שהגיעה דרך פלטפורמה.
 *
 * שני מסלולים, בסדר אמון יורד:
 *
 *   1. **מיפוי שנשמר** — "מספר הלקוח 77521-942 אצל Zestt הוא הכרטיס הזה
 *      אצלנו". נעשה פעם אחת לכל לקוח בפלטפורמה, ומשם והלאה אוטומטי.
 *   2. **מזהה מתוך הדף** — טלפון או מייל שהופיעו בהזמנה עצמה. עובד בלי שום
 *      הגדרה מוקדמת, ולכן שווה לנסות; אבל **בלי יצירת לקוח**. לקוח חדש
 *      שנוצר ממייל של פלטפורמה הוא כרטיס שאיש לא הזמין, עם שם שנלקח מטקסט
 *      חופשי, והוא היה משתלב בשקט בדוחות ובחיוב.
 *
 * @returns {Promise<{customer: Object, via: string}|null>}
 */
const resolvePlatformCustomer = async (doc, parsed) => {
  const platform = await OrderPlatform.findById(doc.platform.ref).catch(() => null);

  if (platform) {
    const mapped = findMappedCustomer(platform, {
      subject: doc.subject,
      text: doc.rawText,
    });
    if (mapped) {
      const customer = await Customer.findById(mapped.customer);
      if (customer) {
        return {
          customer,
          via: `מיפוי הפלטפורמה (${mapped.matchedKey})`,
          mappingKey: mapped.matchedKey,
        };
      }
      // הכרטיס נמחק מאז המיפוי. לא נופלים חזרה בשקט למסלול אחר — הודעה
      // ביומן, ואז ניסיון לפי מזהה מהדף כמו בפלטפורמה חדשה.
      log(
        doc,
        "customer",
        `המיפוי מצביע על כרטיס לקוח שנמחק (${mapped.customer}) — מתעלם ממנו`
      );
    }
  }

  try {
    const resolved = await resolveCustomer({
      parsedCustomer: parsed.customer,
      // ── כתובת השולח **אינה** מועברת ──
      // היא no-reply@ של הפלטפורמה. במסלול הרגיל היא הייתה המזהה המאומת
      // בעל העדיפות הגבוהה ביותר, כלומר כל ההזמנות היו מתאחדות ללקוח אחד.
      sender: {},
      channel: doc.channel,
      allowCreate: false,
    });
    return { customer: resolved.customer, via: "מזהה מתוך גוף ההזמנה" };
  } catch (_) {
    return null;
  }
};

/**
 * הסבר ל"לא ידוע איזה לקוח זה" — עם המזהים שנמצאו בהודעה.
 *
 * ההודעה הזו מוצגת במסך, והיא צריכה לענות על השאלה הבאה של מי שקורא אותה:
 * *מה* למפות. "לא זוהה לקוח" בלי המספר שהופיע בהודעה שולח אדם לחפש בגוף
 * המייל בעצמו.
 */
const describeUnmappedCustomer = (doc) => {
  const { refs, names } = extractPlatformRefs({ subject: doc.subject, text: doc.rawText });
  const found = [...names.slice(0, 2), ...refs.slice(0, 4)];

  return (
    `ההזמנה נקראה, אבל לא ידוע לאיזה לקוח שלנו היא שייכת. ` +
    `במייל של פלטפורמה השולח הוא הפלטפורמה עצמה, ולכן הלקוח מזוהה לפי המזהה שלו אצלה` +
    (found.length ? `: ${found.join(" / ")}` : "") +
    `. מיפוי חד-פעמי של הלקוח הזה יגרום לכל ההזמנות הבאות שלו להיקרא אוטומטית.`
  );
};

const KNOWN_ERROR_CODES = new Set(INCOMING_ORDER_ERROR_CODES);

/**
 * נרמול קוד שגיאה לערך מוכר.
 *
 * `err.code` יכול להגיע מכל מקום: 11000 (מספר) משגיאת כפילות ב-Mongo,
 * "ETIMEDOUT" משגיאת רשת, undefined משגיאה רגילה. errorCode במודל הוא enum,
 * ולכן ערך לא מוכר היה מפיל את doc.save() — ואז רשומת הכשל לא נשמרת כלל,
 * וזו בדיוק הרשומה שאמורה למנוע אובדן הזמנה. הקוד המקורי נשמר בטקסט השגיאה.
 */
const normalizeErrorCode = (code) =>
  typeof code === "string" && KNOWN_ERROR_CODES.has(code) ? code : "order_create_failed";

// התראת מייל על הודעה שלא נקראה במלואה. גם כשנוצרה הזמנת שגיאה — מישהו צריך
// לדעת עכשיו, כי ההזמנה לא תילקט עד שיטופל.
const alertFailure = async (doc) => {
  if (!FAILURE_ALERT_EMAIL) return;

  const sourceLabel = doc.channel === "whatsapp" ? "ווצאפ" : "מייל";
  const senderLabel = doc.sender?.phone || doc.sender?.email || doc.sender?.raw || "לא ידוע";

  const unmatchedLines = (doc.matchedItems || [])
    .filter((i) => !i.product)
    .map((i) => `  • "${i.rawName}" — ${i.failReason || "לא זוהה"}`)
    .join("\n");

  const text = [
    doc.invoice
      ? `הזמנה ${doc.invoice} נכנסה בסטטוס "שגיאה בקריאה" ומחכה להשלמה.`
      : `הודעה שהגיעה ב${sourceLabel} לא הפכה להזמנה ודורשת טיפול.`,
    "",
    `שולח: ${senderLabel}`,
    doc.subject ? `נושא: ${doc.subject}` : null,
    `זמן קבלה: ${new Date(doc.receivedAt).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}`,
    `סיבה: ${doc.error || "לא ידועה"}`,
    unmatchedLines ? `\nפריטים שלא זוהו:\n${unmatchedLines}` : null,
    "",
    "--- ההודעה המקורית ---",
    String(doc.rawText || "").slice(0, 4000),
    "",
    doc.invoice
      ? `לצפייה בהזמנה: ${process.env.ADMIN_URL || ""}/order/${doc.order}`
      : `לטיפול בדשבורד: ${process.env.ADMIN_URL || ""}/incoming-orders`,
  ]
    .filter((line) => line !== null)
    .join("\n");

  await sendEmailSilent({
    from: `"${process.env.COMPANY_NAME || "Store"}" <${process.env.EMAIL_USER}>`,
    to: FAILURE_ALERT_EMAIL,
    subject: doc.invoice
      ? `⚠️ הזמנה ${doc.invoice} מ${sourceLabel} דורשת השלמה`
      : `⚠️ הודעה מ${sourceLabel} דורשת טיפול — ${senderLabel}`,
    text,
  }).catch((err) =>
    console.log(`[ingestion] כשל בשליחת התראת כשל: ${err.message}`)
  );
};

// שמירת פריט בפורמט של המודל (בלי המסמך המלא של המוצר).
// ‏unitPrice הוא המחיר שההזמנה תיווצר איתו בפועל — כלומר מחירון הלקוח כשיש לו
// כזה. הוא מוצג במסך קליטת ההזמנות, ומחיר קטלוג שם היה סותר את סכום ההזמנה.
const toMatchedItemDoc = (item, priceMap = null) => ({
  rawName: item.rawName,
  quantity: item.quantity,
  quantityAssumed: Boolean(item.quantityAssumed),
  unit: item.unit,
  note: item.note,
  product: item.product?._id,
  productTitle: item.product?.title?.he || item.productTitle,
  sku: item.product?.sku,
  unitPrice: item.product ? effectivePrice(priceMap, item.product) : undefined,
  confidence: item.confidence,
  matchScore: item.matchScore,
  decidedBy: item.decidedBy,
  alternatives: item.alternatives || [],
  failReason: item.failReason,
});

/**
 * העיבוד עצמו — מקבל מסמך IncomingOrder שכבר נשמר ומריץ עליו את כל השלבים.
 * מפריד בין הקליטה (שחייבת להצליח תמיד) לבין העיבוד (שיכול להיכשל).
 *
 * @param {Object} doc - מסמך IncomingOrder
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false] - להריץ את כל שלבי הקריאה וההתאמה
 *        אבל לעצור לפני יצירת ההזמנה. לכיול על הזמנות אמיתיות בלי להזרים
 *        הזמנות בדיקה למערכת ובלי להוריד מלאי.
 */
const processIncomingOrder = async (doc, { dryRun = false } = {}) => {
  doc.attempts = (doc.attempts || 0) + 1;
  doc.error = undefined;
  doc.errorCode = null;

  // מה שנאסף עד כה — משמש ליצירת הזמנת שגיאה אם משהו ייכשל בהמשך
  let customer = null;
  let parsed = null;
  let matchedItems = [];
  let unmatchedItems = [];
  let deliveryInfo = null;
  // מחירון הלקוח. ‏undefined = עוד לא נשלף (ואז createOrder ישלוף בעצמו),
  // ‏null = ללקוח אין מחירון והוא משלם את מחירי הקטלוג.
  let priceMap;
  // המזהה שדרכו זוהה הלקוח בפלטפורמה — נספר על המיפוי עצמו כשההזמנה נוצרת,
  // כדי שהמסך יראה איזה מיפוי באמת בשימוש ואיזה נשאר מיפוי על הנייר.
  let platformMappingKey = null;

  /**
   * סיום בכשל: יוצר הזמנת שגיאה אם יש לקוח לשייך אליו, ומעדכן את הרשומה.
   * בלי לקוח אין הזמנה (user הוא שדה חובה ב-Order), ואז ההודעה נשארת
   * במסך "קליטת הזמנות" בלבד.
   */
  const failWith = async (rawCode, message) => {
    const code = normalizeErrorCode(rawCode);
    // אם הקוד המקורי לא היה מוכר, שומרים אותו בטקסט כדי שלא ייעלם מהתחקור
    const fullMessage =
      code === "order_create_failed" && rawCode && rawCode !== code
        ? `${message} [קוד מקורי: ${rawCode}]`
        : message;

    doc.status = "failed";
    doc.errorCode = code;
    doc.error = fullMessage;
    log(doc, "error", `${code}: ${fullMessage}`);

    if (customer && !dryRun) {
      try {
        // הגנה מפני הזמנה כפולה: אם בשלב מאוחר נכשל משהו *אחרי* שההזמנה
        // התקינה כבר נשמרה, יצירת הזמנת שגיאה כאן הייתה מייצרת שתי הזמנות
        // לאותה הודעה. בודקים מול הקישור ההפוך לפני שיוצרים.
        const existingOrder = await Order.findOne({ incomingOrder: doc._id }).select(
          "invoice ingestionError"
        );
        if (existingOrder) {
          doc.order = existingOrder._id;
          doc.invoice = existingOrder.invoice;
          log(
            doc,
            "order",
            `כבר קיימת הזמנה ${existingOrder.invoice} להודעה הזו — לא נוצרה הזמנת שגיאה נוספת`
          );
          await doc.save().catch((saveErr) =>
            console.error(`[ingestion] כשל בשמירת רשומת הכשל: ${saveErr.message}`)
          );
          await alertFailure(doc);
          return doc;
        }

        const errorOrder = await createErrorOrder({
          items: matchedItems,
          unmatched: unmatchedItems,
          customer,
          deliveryInfo,
          parsed,
          channel: doc.channel,
          incomingOrder: doc,
          errorCode: code,
          errorMessage: fullMessage,
          confidence: doc.confidence,
          priceMap,
        });
        doc.order = errorOrder._id;
        doc.invoice = errorOrder.invoice;
        log(
          doc,
          "order",
          `נוצרה הזמנת שגיאה ${errorOrder.invoice} עם ${matchedItems.length} פריטים`
        );
      } catch (createErr) {
        // גם יצירת הזמנת השגיאה נכשלה — ההודעה עדיין מתועדת ומדווחת
        log(doc, "error", `כשל גם ביצירת הזמנת שגיאה: ${createErr.message}`);
        console.error(createErr.stack);
      }
    } else if (!customer) {
      log(doc, "order", "אין לקוח לשייך — לא נוצרה הזמנה, ההודעה נשארת לטיפול");
    }

    await doc.save().catch((saveErr) =>
      console.error(`[ingestion] כשל בשמירת רשומת הכשל: ${saveErr.message}`)
    );
    await alertFailure(doc);
    return doc;
  };

  try {
    // ── 1. ניתוח ההודעה (מנוע פנימי, ו-AI רק כנפילה אם הודלק) ──
    parsed = await analyzeMessage(doc);

    // ── 1ב. ההזמנה יושבת מעבר לקישור ──
    //
    // רק אחרי שהניתוח לא מצא פריטים, ובכוונה: פתיחת דפדפן היא הפעולה היקרה
    // ביותר בצינור (שנייה וכ-100MB), ומייל שההזמנה כתובה בו בגוף — כלומר
    // הרוב — לא משלם עליה כלל. מייל של פלטפורמה, לעומת זאת, *לעולם* לא
    // ייקרא בלעדיה: בגוף שלו אין שורות הזמנה, רק כפתור.
    if (!parsed.isOrder && doc.links?.length) {
      const followed = await followLinksForDoc(doc);

      if (followed.enriched) {
        // אותו נתח בדיוק, על טקסט שכולל עכשיו את תוכן הדף. הפרסר אינו יודע
        // ואינו מתעניין מאיפה הטקסט בא — וזה מה שהופך את המנגנון לגנרי:
        // פלטפורמה חדשה אינה דורשת שורת קוד בפרסר.
        parsed = await analyzeMessage(doc);

        // ── דף שנפתח הוא הזמנה, גם אם לא הצלחנו לקרוא אותה ──
        //
        // הקישור נפתח כי כפתור במייל אמר "לצפייה בהזמנה". סגירת הרשומה
        // כ-"not_an_order" הייתה מעבירה אותה ללשונית שאין עליה פעולה ואף אחד
        // לא עובר עליה — כלומר הזמנה אמיתית נקברת בשקט. פורמט דף שאינו מוכר
        // הוא כשל קריאה שדורש עין, לא "זו לא הזמנה".
        if (!parsed.isOrder) {
          doc.parsed = parsed;
          return failWith(
            "no_items",
            `הדף נפתח ונקרא (${doc.linkFollow?.chars || 0} תווים), אבל לא זוהו בו שורות הזמנה — ` +
              `ייתכן שזה פורמט דף שאינו מוכר למערכת`
          );
        }
      } else if (followed.duplicateOf) {
        // ההזמנה כבר במערכת. הרשומה נשמרת עם הפניה אליה — כדי שמי שמחפש
        // את המייל הזה יראה מיד לאן הוא הוביל, ולא יחשוב שהוא נעלם.
        doc.parsed = parsed;
        // רק הפניה אמיתית להזמנה. ‏_id של הרשומה האחרת אינו מזהה הזמנה,
        // והצבתו כאן הייתה יוצרת קישור שבור שמסך ההזמנה ינסה לטעון.
        if (followed.duplicateOf.order) doc.order = followed.duplicateOf.order;
        doc.invoice = followed.duplicateOf.invoice;
        doc.status = "ignored";
        log(
          doc,
          "link",
          `הודעה חוזרת על הזמנה ${followed.duplicateOf.invoice} שכבר נקלטה`
        );
        await doc.save();
        return doc;
      } else if (followed.errorCode) {
        doc.parsed = parsed;
        return failWith(followed.errorCode, followed.error);
      }
    }

    doc.parsed = parsed;

    if (!parsed.isOrder) {
      // הודעה שאינה הזמנה לא מייצרת הזמנה, גם לא הזמנת שגיאה.
      // תלונה על תמרים אינה סיבה לשלוח תמרים.
      //
      // אבל: "לא זיהיתי פריטים" אינו זהה ל-"זו לא הזמנה". פורמט הזמנה שאינו
      // מוכר למערכת חייב להגיע לעיני אדם ולא להיקבר בלשונית שאף אחד לא בודק.
      if (parsed.certainNotOrder === false) {
        return failWith(
          "no_items",
          parsed.notAnOrderReason ||
            "לא זוהו פריטים בהודעה — ייתכן שזה פורמט שאינו מוכר למערכת"
        );
      }

      doc.status = "not_an_order";
      log(doc, "extract", `אינה הזמנה: ${parsed.notAnOrderReason || "לא צוין"}`);
      await doc.save();
      return doc;
    }

    // ── 2. לקוח ──
    // מוקדם בכוונה: בלי לקוח אין הזמנה, גם לא הזמנת שגיאה.
    //
    // ── מייל של פלטפורמה הוא מסלול נפרד ──
    //
    // בכל שאר הערוצים כתובת השולח היא מזהה מאומת של הלקוח, וזה מה שכל
    // resolveCustomer בנוי עליו. במייל של פלטפורמה השולח הוא no-reply@ שלה,
    // ואותה כתובת בדיוק שולחת את ההזמנות של **כל** המסעדות. שימוש במסלול
    // הרגיל היה יוצר כרטיס לקוח אחד בשם הפלטפורמה ומצמיד אליו את כולן.
    if (doc.platform?.ref) {
      const platformCustomer = await resolvePlatformCustomer(doc, parsed);
      if (!platformCustomer) {
        return failWith(
          "platform_customer_unmapped",
          describeUnmappedCustomer(doc)
        );
      }
      customer = platformCustomer.customer;
      platformMappingKey = platformCustomer.mappingKey || null;
      doc.resolved.customer = customer._id;
      doc.resolved.customerWasCreated = false;
      log(doc, "customer", `זוהה לפי ${platformCustomer.via}: ${customer.name} (${customer._id})`);
    } else {
      try {
        const resolved = await resolveCustomer({
          parsedCustomer: parsed.customer,
          sender: doc.sender,
          channel: doc.channel,
          // הרצה יבשה לא משאירה כרטיס לקוח חדש במערכת
          allowCreate: !dryRun,
        });
        customer = resolved.customer;
        doc.resolved.customer = customer._id;
        doc.resolved.customerWasCreated = resolved.wasCreated;
        log(
          doc,
          "customer",
          `${resolved.wasCreated ? "נוצר לקוח חדש" : "זוהה לקוח קיים"}: ${customer.name} (${customer._id})`
        );
      } catch (err) {
        return failWith(err.code || "customer_unresolved", err.message);
      }
    }

    // ── 2ב. מחירון הלקוח ──
    //
    // נשלף פעם אחת ומועבר לכל השלבים שצריכים מחיר: בדיקת הזמינות (מוצר בלי
    // מחיר בקטלוג אך עם מחיר במחירון אינו נחסם), המחיר שמוצג במסך הקליטה,
    // ותמחור ההזמנה עצמה. שליפה נפרדת בכל שלב הייתה מאפשרת לשניים מהם לראות
    // מחירונים שונים אם יובא מחירון חדש בדיוק באמצע העיבוד.
    priceMap = await getCustomerPriceMap(customer._id);
    if (priceMap) {
      log(doc, "customer", `ללקוח יש מחירון פרטי (${priceMap.size} מק"טים)`);
    }

    // ── 2ג. מה הלקוח קונה בפועל ──
    //
    // נשלף כאן ולא בתוך resolveItems מאותה סיבה שהמחירון נשלף כאן: שאילתה אחת
    // להזמנה במקום אחת לכל שורה. הפרופיל משמש כשובר שוויון בין מועמדים שמנוע
    // ההתאמה כבר הביא — ראה utils/purchaseHistoryRanking.
    //
    // כשל בשליפה אינו מפיל את הקליטה: ההיסטוריה היא שכבת שיפור ולא תלות, ובלעדיה
    // הצינור מתנהג בדיוק כמו קודם. נפילה כאן הייתה הופכת תקלה במסד לכשל של
    // ההזמנה כולה.
    let historyProfile = null;
    try {
      historyProfile = await getCustomerPurchaseProfile(customer._id);
      if (historyProfile) {
        log(
          doc,
          "customer",
          `ללקוח יש היסטוריית רכישות (${historyProfile.size} מוצרים)`
        );
      }
    } catch (err) {
      console.log(`[ingestion] שליפת היסטוריית הלקוח נכשלה: ${err.message}`);
    }

    // ── 3. התאמת הפריטים לקטלוג ──
    const { items, unmatched, dropped } = await resolveItems(parsed.items, {
      contextText: doc.rawText,
      priceMap,
      historyProfile,
      // הלקוח כבר נפתר בשלב 2, ולכן אפשר להעדיף את ההכרעות שנשמרו *עבורו*
      // על פני הכרעות כלל-מערכתיות. ראה utils/productAliases.
      customerId: customer._id,
    });
    matchedItems = items;
    unmatchedItems = unmatched;
    doc.matchedItems = [...items, ...unmatched].map((item) =>
      toMatchedItemDoc(item, priceMap)
    );

    // ── שורה שהכמות שלה הונחה ולא נמצא לה מוצר ──
    //
    // היא חוזרת להיות שורה מדולגת: מופיעה במסך הקליטה ואינה מפילה את ההזמנה.
    //
    // וחשוב לא פחות — הטקסט שלה חוזר להערת ההזמנה. הערת ההזמנה נבנית מהשורות
    // שאינן פריט (extractOrderNote), ומרגע שהשורה נקראה כפריט היא הוחרגה
    // ממנה. בלי ההחזרה הזו הוראה כמו "לשלוח אחרי 4" הייתה נעלמת מההזמנה
    // בשקט — בדיוק הכשל שהשינוי הזה בא לתקן, רק בכיוון ההפוך.
    if (dropped?.length) {
      parsed.skippedRows = [
        ...(parsed.skippedRows || []),
        ...dropped.map((d) => ({ raw: d.rawName, reason: d.reason })),
      ];

      const existingNote = parsed.note || "";
      const restored = [
        ...new Set(
          dropped.map((d) => d.rawName).filter((text) => text && !existingNote.includes(text))
        ),
      ];
      if (restored.length) {
        parsed.note = [existingNote, ...restored]
          .filter(Boolean)
          .join(" | ")
          // אותה תקרה כמו ב-extractOrderNote — ההערה נכנסת ל-customer_note
          .slice(0, 500);
      }

      doc.parsed = parsed;
      doc.markModified("parsed");
      log(doc, "match", `שורות שלא היו פריט: ${dropped.map((d) => d.rawName).join(", ")}`);
    }

    log(doc, "match", `הותאמו ${items.length}, לא זוהו ${unmatched.length}`);

    // ── 4. יעד המשלוח ──
    // נפתר לפני בדיקות הפריטים, כדי שגם הזמנת שגיאה תקבל כתובת אם היא זמינה.
    let deliveryError = null;
    try {
      deliveryInfo = await resolveDelivery({
        parsedDelivery: parsed.delivery,
        customer,
      });
      doc.resolved.shippingOption = deliveryInfo.shippingOption;
      doc.resolved.city = deliveryInfo.city;
      doc.resolved.deliveryPrice = deliveryInfo.delivery?.price;
      log(
        doc,
        "delivery",
        deliveryInfo.shippingOption === "1" ? "איסוף עצמי" : `משלוח ל${deliveryInfo.city}`
      );
    } catch (err) {
      deliveryError = err;
      log(doc, "delivery", `כתובת לא נפתרה: ${err.message}`);
    }

    // ── 5. ביטחון כולל ──
    // החוליה החלשה קובעת: הביטחון הנמוך מבין הפריטים ומהחילוץ עצמו.
    const itemConfidences = items.map((i) => i.confidence);
    doc.confidence = items.length
      ? Math.round(Math.min(Number(parsed.confidence) || 0, ...itemConfidences) * 100) / 100
      : 0;

    // ── 6. הכרעה: הזמנה תקינה או הזמנת שגיאה ──

    if (!parsed.items.length) {
      return failWith("no_items", "ההודעה זוהתה כהזמנה אבל לא נמצאו בה פריטים");
    }

    // הודעת הכשל נשארת קצרה בכוונה: הסיבה המלאה של כל פריט כבר מוצגת לצידו
    // ברשימת הפריטים, ושכפולה לכאן הפך את ההודעה לפסקה שאיש לא קרא עד סופה.
    if (!items.length) {
      return failWith(
        "items_unmatched",
        `לא זוהה אף מוצר: ${unmatched.map((i) => `"${i.rawName}"`).join(", ")}`
      );
    }

    if (unmatched.length && !ALLOW_PARTIAL) {
      return failWith(
        "items_unmatched",
        `לא נכנסו להזמנה: ${unmatched.map((i) => `"${i.rawName}"`).join(", ")}`
      );
    }

    if (deliveryError) {
      return failWith(deliveryError.code || "address_unresolved", deliveryError.message);
    }

    if (doc.confidence < MIN_ORDER_CONFIDENCE) {
      return failWith(
        "low_confidence",
        "הקריאה לא הייתה ודאית — יש לעבור על הפריטים מול ההודעה המקורית"
      );
    }

    // ── 7. יצירת ההזמנה ──
    if (dryRun) {
      log(doc, "dry-run", "כל השלבים עברו — עצירה לפני יצירת ההזמנה");
      doc.status = "received";
      await doc.save();
      return doc;
    }

    let order;
    try {
      order = await createOrderFromParsed({
        items,
        customer,
        deliveryInfo,
        parsed,
        channel: doc.channel,
        incomingOrder: doc,
        priceMap,
      });
    } catch (err) {
      // כשל מלאי / מתחת למינימום / תקלה טכנית — הזמנת שגיאה במקום כלום
      return failWith(err.code || "order_create_failed", err.message);
    }

    doc.status = "order_created";
    doc.order = order._id;
    doc.invoice = order.invoice;
    log(doc, "order", `נוצרה הזמנה ${order.invoice} בסך ${order.total} ₪`);
    await doc.save();

    // מונה במרשם הפלטפורמות. הוא התשובה ל"דרך מי בכלל מגיעות אליי הזמנות"
    // בלי שאיש יצטרך לנחש, ולכן הוא נספר על הזמנה שהושלמה ולא על מייל שנכנס.
    if (doc.platform?.ref) {
      await recordOrderRead(doc.platform.ref, { mappingKey: platformMappingKey }).catch((err) =>
        console.log(`[ingestion] עדכון מונה הפלטפורמה נכשל: ${err.message}`)
      );
    }

    return doc;
  } catch (err) {
    // כשל לא צפוי (LLM, רשת, DB) — אותו מסלול כשל, כולל הזמנת שגיאה אם אפשר
    console.error(err.stack);
    return failWith(err.code || "llm_failed", err.message);
  }
};

// ─────────────────────────────────────────────────────────────
//  צבירת הודעות ווצאפ
// ─────────────────────────────────────────────────────────────

/**
 * חלון השקט לפני שמתחילים לעבד הודעת ווצאפ, בדקות.
 *
 * 0 = בלי צבירה (כל הודעה מעובדת מיד, ההתנהגות שהייתה לפני התוספת הזו).
 */
const COLLECT_WINDOW_MS = () => {
  const raw = process.env.WHATSAPP_COLLECT_WINDOW_MINUTES;
  const minutes = raw === undefined || raw === "" ? 15 : Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 0;
};

// ── תקרה קשיחה לזמן ההמתנה ──
//
// חלון השקט נדחה בכל הודעה חדשה, ולכן לקוח שמנהל שיחה ארוכה אחרי שכתב את
// ההזמנה היה דוחה אותה שוב ושוב — הזמנה יכולה הייתה להמתין שעה. מרגע ההודעה
// הראשונה יש גבול, וממנו העיבוד מתחיל בין אם הלקוח סיים ובין אם לא.
const COLLECT_MAX_WAIT_MS = () => {
  const raw = process.env.WHATSAPP_COLLECT_MAX_WAIT_MINUTES;
  const minutes = Number(raw);
  if (Number.isFinite(minutes) && minutes > 0) return minutes * 60 * 1000;
  return COLLECT_WINDOW_MS() * 3;
};

// מעבר לזה כבר לא מדובר בהזמנה שנכתבה בכמה שורות אלא בשיחה. הרשומה משוחררת
// לעיבוד, וההודעה הבאה תפתח רשומה חדשה — כדי שמסמך אחד לא יגדל בלי גבול.
const MAX_COLLECTED_MESSAGES = 40;

// אותו שיקול, במידה של תווים ולא של הודעות: ה-webhook מגביל כל הודעה ל-100K
// תווים, ובלי תקרה כאן 40 הודעות כאלה היו מסמך של 8MB — מול תקרת 16MB של
// מונגו. הזמנה אמיתית רחוקה מכאן בשני סדרי גודל.
const MAX_COLLECTED_CHARS = 40_000;

/**
 * צירוף הודעת ווצאפ לרשומה פתוחה של אותו שולח, או פתיחת רשומה חדשה.
 *
 * ── למה זה קיים ──
 *
 * לקוח בווצאפ כותב כמו שמדברים: "היי" בהודעה אחת, "3 מגבות נייר" בשנייה,
 * "מתקן סבון" בשלישית. כל הודעה נקראה בנפרד, ולכן נפתחו שתי הזמנות נפרדות
 * (שתי תעודות משלוח, ליקוט כפול), והשורה בלי הכמות לא נכנסה בכלל — הודעה
 * חייבת כמות מפורשת אחת לפחות כדי להיחשב הזמנה. בנתוני האמת: 10 הודעות
 * רצופות מאותו לקוח בתוך 5 דקות → 2 הזמנות.
 *
 * הספירה היא של **שקט מהשולח** ולא של זמן מההודעה הראשונה: כל הודעה חדשה
 * דוחה את המועד קדימה, אחרת לקוח שמקליד לאט היה נחתך באמצע.
 *
 * @returns {Promise<Object|null>} הרשומה שההודעה צורפה אליה, או null כשאין
 *          למה לצרף (אין טלפון לקבץ לפיו) והעיבוד צריך להימשך כרגיל.
 */
const collectWhatsappMessage = async ({
  externalId,
  text,
  sender = {},
  attachments = [],
  receivedAt,
}) => {
  const phone = canonicalPhone(sender.phone);
  // בלי טלפון אין מפתח לקיבוץ. עדיף לעבד מיד מאשר לצבור לתוך ערימה משותפת
  // של שולחים שונים.
  if (!phone) return null;

  const now = new Date();
  // ראה toValidDate: עדכון בצינור אגרגציה אינו עובר את המרת הטיפוסים של
  // mongoose, ולכן חותמת זמן פגומה הייתה נכתבת כמו שהיא לשדה שמוגדר כתאריך.
  const arrivedAt = toValidDate(receivedAt) || now;
  const processAfter = new Date(now.getTime() + COLLECT_WINDOW_MS());
  const entry = { externalId, text: String(text), receivedAt: arrivedAt };

  // ── עדכון אטומי, ולא קריאה-שינוי-כתיבה ──
  //
  // שתי הודעות שמגיעות באותה שנייה הן שתי בקשות HTTP נפרדות. קריאת המסמך,
  // שרשור בזיכרון ושמירה היו מאבדים את אחת מהן בשקט. צינור העדכון עושה את
  // השרשור בתוך המסד, בפעולה אחת.
  //
  // ‏$literal הכרחי: טקסט שמתחיל ב-"$" ("$100 לשלם") היה מתפרש כנתיב שדה
  // ומוחלף בערך אחר לגמרי.
  const appendToOpenRecord = () =>
    IncomingOrder.findOneAndUpdate(
      { channel: "whatsapp", "sender.phone": phone, status: "collecting" },
      [
        {
          $set: {
            rawText: { $concat: ["$rawText", "\n", { $literal: String(text) }] },
            messages: {
              $concatArrays: [{ $ifNull: ["$messages", []] }, { $literal: [entry] }],
            },
            attachments: {
              $concatArrays: [{ $ifNull: ["$attachments", []] }, { $literal: attachments }],
            },
            // הקטן מבין "חלון שקט מעכשיו" ל"תקרה מההודעה הראשונה"
            processAfter: {
              $min: [
                { $literal: processAfter },
                { $add: ["$createdAt", COLLECT_MAX_WAIT_MS()] },
              ],
            },
            lastMessageAt: { $literal: arrivedAt },
            // שם השולח מתעדכן אם הגיע רק בהודעה מאוחרת יותר
            "sender.name": { $ifNull: ["$sender.name", { $literal: sender.name || null }] },
          },
        },
      ],
      { new: true, sort: { createdAt: -1 } }
    );

  const updated = await appendToOpenRecord();

  if (updated) {
    // הרשומה התארכה מדי — משחררים אותה לעיבוד בסבב הקרוב
    const tooManyMessages = (updated.messages?.length || 0) >= MAX_COLLECTED_MESSAGES;
    const tooLong = (updated.rawText?.length || 0) >= MAX_COLLECTED_CHARS;
    if (tooManyMessages || tooLong) {
      updated.processAfter = new Date();
      await updated.save();
      console.log(
        `[ingestion] הרשומה של ${phone} הגיעה ל-${updated.messages.length} הודעות ` +
          `ו-${updated.rawText.length} תווים — משוחררת לעיבוד`
      );
      return updated;
    }

    console.log(
      `[ingestion] ${externalId} צורפה לרשומה הפתוחה של ${phone} ` +
        `(${updated.messages?.length || 1} הודעות, עיבוד ב-${updated.processAfter?.toLocaleTimeString("he-IL")})`
    );
    return updated;
  }

  const doc = new IncomingOrder({
    channel: "whatsapp",
    externalId,
    sender: {
      name: sender.name,
      phone,
      email: sender.email ? String(sender.email).toLowerCase().trim() : undefined,
      raw: sender.raw,
    },
    rawText: String(text),
    attachments,
    receivedAt: arrivedAt,
    messages: [entry],
    processAfter,
    lastMessageAt: arrivedAt,
    status: "collecting",
  });

  try {
    await doc.save();
  } catch (err) {
    // ── מי שהפסיד במרוץ מצטרף, לא פותח רשומה שנייה ──
    //
    // האינדקס הייחודי החלקי על (sender.phone, status: collecting) הוא מה
    // שהופך את המרוץ לשגיאה במקום לרשומה כפולה. כאן מתקנים אותה: מנסים שוב
    // לצרף, והפעם הרשומה של המנצח כבר קיימת.
    if (err.code === 11000) {
      // אותה הודעה בדיוק נשלחה פעמיים — מחזירים את מה שכבר נשמר
      const byExternalId = await IncomingOrder.findOne({ externalId });
      if (byExternalId) return byExternalId;

      const retried = await appendToOpenRecord();
      if (retried) {
        console.log(`[ingestion] ${externalId} צורפה אחרי מרוץ על רשומת הצבירה של ${phone}`);
        return retried;
      }

      // הרשומה של המנצח שוחררה לעיבוד בין הכישלון לניסיון החוזר. אין למה
      // לצרף, ולכן ההודעה תעובד בפני עצמה — בדיוק כמו לפני הצבירה.
      console.warn(
        `[ingestion] ${externalId}: רשומת הצבירה של ${phone} נעלמה בין הניסיונות — עיבוד בנפרד`
      );
      return null;
    }
    throw err;
  }

  console.log(
    `[ingestion] נפתחה רשומת צבירה ל-${phone} — עיבוד ב-${processAfter.toLocaleTimeString("he-IL")}`
  );
  return doc;
};

/**
 * צירוף הודעה של שולח לא מוכר לרשומת "שולח לא מוכר" פתוחה של אותו מספר.
 *
 * ── למה זה קיים ──
 *
 * הרשימה הלבנה נאכפת בכניסה, לפני הצבירה, ולכן שולח שאינו לקוח אינו מקבל
 * רשומת `collecting` לקבץ אליה. בלי הקיבוץ הזה עשר הודעות רצופות מאותו מספר
 * לא-מוכר היו עשר שורות בלשונית "שולח לא מוכר" — ולחיצה על "לקוח חדש" הייתה
 * קוראת כל אחת בנפרד, כלומר בדיוק פיצול ההזמנה שהצבירה נועדה למנוע.
 *
 * הקיבוץ הוא לפי אותו חלון שקט של הצבירה הרגילה, ובכפוף לאותן תקרות. אין כאן
 * `processAfter`: רשומה של שולח לא מוכר אינה ממתינה לעיבוד, היא ממתינה לאדם.
 *
 * @returns {Promise<Object|null>} הרשומה שההודעה צורפה אליה, או null כשאין למה
 *          לצרף — ואז נפתחת רשומה חדשה.
 */
const appendToUnknownSenderRecord = async ({
  phone,
  name,
  externalId,
  text,
  attachments = [],
  receivedAt,
}) => {
  const windowMs = COLLECT_WINDOW_MS();
  // צבירה מכובה = כל הודעה עומדת בפני עצמה, גם כאן
  if (!windowMs || !phone) return null;

  const cutoff = new Date(receivedAt.getTime() - windowMs);
  const entry = { externalId, text: String(text), receivedAt };
  // עדכון בצינור אגרגציה עוקף את המרת הטיפוסים של mongoose, ולכן ‏null היה
  // נכתב כמו שהוא ומאפס את המערך הקיים ($concatArrays עם null מחזיר null).
  const incoming = Array.isArray(attachments) ? attachments : [];

  // הצירוף עצמו אטומי (עדכון אחד במסד), ומול הודעות מקבילות מגן התור שב-
  // withPhoneQueue — כאן אין אינדקס ייחודי שיתפוס מרוץ. ‏receivedAt חייב
  // להיות Date תקין; הקורא מנרמל אותו (toValidDate) לפני הקריאה.
  return IncomingOrder.findOneAndUpdate(
    {
      channel: "whatsapp",
      "sender.phone": phone,
      status: "unknown_sender",
      lastMessageAt: { $gte: cutoff },
      // אותן תקרות של הצבירה: מעבר להן זו שיחה ולא הזמנה
      $expr: {
        $and: [
          { $lt: [{ $size: { $ifNull: ["$messages", []] } }, MAX_COLLECTED_MESSAGES] },
          { $lt: [{ $strLenCP: { $ifNull: ["$rawText", ""] } }, MAX_COLLECTED_CHARS] },
        ],
      },
    },
    [
      {
        $set: {
          rawText: { $concat: ["$rawText", "\n", { $literal: String(text) }] },
          messages: {
            $concatArrays: [{ $ifNull: ["$messages", []] }, { $literal: [entry] }],
          },
          attachments: {
            $concatArrays: [{ $ifNull: ["$attachments", []] }, { $literal: incoming }],
          },
          lastMessageAt: { $literal: receivedAt },
          "sender.name": { $ifNull: ["$sender.name", { $literal: name || null }] },
        },
      },
    ],
    { new: true, sort: { lastMessageAt: -1 } }
  );
};

// ── תור לכל מספר, לקליטת שולחים לא מוכרים ──
//
// ברשומת הצבירה הרגילה האינדקס הייחודי החלקי הוא שמונע שתי רשומות למספר אחד.
// כאן אין אינדקס כזה ולא יכול להיות: לאותו מספר יש רשומות "שולח לא מוכר"
// רבות לאורך הזמן, והייחודיות הייתה חוסמת את השנייה.
//
// בלי סריאליזציה, פרץ הודעות שמגיע בבת אחת — בדיוק מה שקורה כששרת הווצאפ
// מתחבר מחדש ומזרים backlog — היה מפצל את אותה הזמנה לכמה שורות בלשונית,
// ולחיצה על "לקוח חדש" על כל אחת הייתה יוצרת כמה הזמנות. נמדד: 5 הודעות
// במקביל → 4 רשומות.
//
// **מגבלה מפורשת**: התור חי בזיכרון התהליך. בפריסה מרובת תהליכים (cluster,
// serverless) הוא מגן רק בתוך כל תהליך, ואז הגנת הנפילה היא זו שממילא קיימת:
// שורה עודפת בלשונית, בלי אובדן הודעה. אין כאן נעילה מקוננת ולכן אין סיכון
// לקיפאון, והמפתח נמחק כשהתור מתרוקן.
const unknownSenderQueues = new Map();

const withPhoneQueue = (phone, task) => {
  const previous = unknownSenderQueues.get(phone) || Promise.resolve();
  // ‏catch לפני ההמשך: כשל של הודעה אחת לא יפיל את מי שממתין אחריה
  const current = previous.then(task, task);
  unknownSenderQueues.set(phone, current);

  current
    .catch(() => {})
    .then(() => {
      // מנקים רק אם לא נכנס מישהו אחרי — אחרת נמחק תור פעיל
      if (unknownSenderQueues.get(phone) === current) unknownSenderQueues.delete(phone);
    });

  return current;
};

/**
 * שמירת הודעה משולח שאינו לקוח, בלי לקרוא אותה.
 *
 * ההודעה **לא** נעלמת: היא נשמרת בסטטוס `unknown_sender` ומופיעה בלשונית
 * "שולח לא מוכר", עם כפתור "לקוח חדש" שיוצר לקוח וקורא אותה מחדש.
 */
/**
 * הודעה מפלטפורמה שטרם אושרה.
 *
 * הרשומה נשמרת במלואה — כולל הקישור — ומחכה לאישור אחד. אחריו "עבד מחדש"
 * קורא אותה בלי שאיש יעתיק ממנה דבר.
 *
 * ── למה סטטוס נפרד ולא "שולח לא מוכר" ──
 *
 * הפעולה שמוצעת על "שולח לא מוכר" היא "צור לקוח מהשולח הזה". על מייל של
 * פלטפורמה היא הייתה יוצרת כרטיס לקוח בשם "Zestt" עם הכתובת no-reply@,
 * ומצמידה אליו את ההזמנות של כל המסעדות — כולל את המחירון ואת היסטוריית
 * ההזמנות. הפעולה הנכונה כאן היא אישור הפלטפורמה, פעם אחת.
 */
const registerPlatformMessage = async ({
  channel,
  externalId,
  text,
  sender,
  subject,
  attachments,
  receivedAt,
  links = [],
  platform,
  reason,
}) => {
  // פלטפורמה שנדחתה במפורש אינה חוזרת למסך האישורים בכל מייל. הרשומה כן
  // נשמרת — הודעה לא נעלמת בשקט, גם כשהוחלט לא לקרוא אותה.
  const isBlocked = platform?.status === "blocked";

  const doc = new IncomingOrder({
    channel,
    externalId,
    sender,
    subject,
    rawText: String(text),
    attachments,
    receivedAt: toValidDate(receivedAt) || new Date(),
    ...(links.length ? { links } : {}),
    ...(platform
      ? {
          platform: {
            ref: platform._id,
            key: platform.key,
            name: platform.name,
            status: platform.status,
          },
        }
      : {}),
    status: isBlocked ? "ignored" : "platform_pending",
  });

  log(doc, "platform", reason || "פלטפורמת הזמנות שטרם אושרה");
  if (links[0]?.url) {
    log(doc, "platform", `הקישור בהודעה: ${links[0].url}`);
  }

  try {
    await doc.save();
  } catch (err) {
    if (err.code === 11000) {
      const dup = await IncomingOrder.findOne({ externalId });
      if (dup) return dup;
    }
    throw err;
  }

  return doc;
};

const rejectUnknownSender = async ({
  channel,
  externalId,
  text,
  sender,
  subject,
  attachments,
  receivedAt,
  reason,
  links = [],
}) => {
  // ‏receivedAt מגיע מקלט חיצוני (חותמת הזמן של ווצאפ, כותרת Date של מייל).
  // הקיבוץ מחשב איתו הפרש זמנים, ומחרוזת או תאריך לא חוקי היו מפילים את
  // הקליטה — וה-webhook כבר ענה 202, כלומר ההודעה הייתה נעלמת.
  const arrivedAt = toValidDate(receivedAt) || new Date();

  const createRecord = async () => {
    const doc = new IncomingOrder({
      channel,
      externalId,
      sender,
      subject,
      rawText: String(text),
      attachments,
      receivedAt: arrivedAt,
      // הקישורים נשמרים גם כאן. הודעה שנדחתה יכולה להתברר כהזמנה אמיתית
      // (לקוח חדש, פלטפורמה שתאושר), ובלי הקישור ההרצה החוזרת הייתה מנתחת
      // שוב את אותו מייל ריק — כלומר האישור לא היה משנה דבר.
      ...(links.length ? { links } : {}),
      // הודעות ווצאפ מקובצות לפי המערך הזה — ראה appendToUnknownSenderRecord
      ...(channel === "whatsapp"
        ? {
            messages: [{ externalId, text: String(text), receivedAt: arrivedAt }],
            lastMessageAt: arrivedAt,
          }
        : {}),
      status: "unknown_sender",
    });

    log(doc, "whitelist", reason);

    try {
      await doc.save();
    } catch (err) {
      // אותה הודעה נקלטה במקביל — מחזירים את מה שכבר נשמר
      if (err.code === 11000) {
        const dup = await IncomingOrder.findOne({ externalId });
        if (dup) return dup;
      }
      throw err;
    }

    return doc;
  };

  // מייל אינו נצבר (הוא מגיע כמסמך שלם), והודעת ווצאפ בלי טלפון אין לפי מה
  // לקבץ — בשני המקרים כל הודעה עומדת בפני עצמה, בלי תור.
  if (channel !== "whatsapp" || !sender.phone) return createRecord();

  return withPhoneQueue(sender.phone, async () => {
    const joined = await appendToUnknownSenderRecord({
      phone: sender.phone,
      name: sender.name,
      externalId,
      text,
      attachments,
      receivedAt: arrivedAt,
    });

    if (joined) {
      console.log(
        `[ingestion] ${externalId} צורפה לרשומת השולח הלא-מוכר של ${sender.phone} ` +
          `(${joined.messages?.length || 1} הודעות)`
      );
      return joined;
    }

    return createRecord();
  });
};

// סבב שחרור פעיל כרגע (ראה releaseCollectedMessages)
let isReleasing = false;

/**
 * שחרור רשומות שחלון השקט שלהן נגמר. נקרא ע"י ה-cron, וגם ידנית מהדשבורד.
 *
 * @param {Object} [options]
 * @param {string} [options.id] - שחרור רשומה מסוימת לפני הזמן ("עבד עכשיו")
 * @returns {Promise<Array>} הרשומות שעובדו
 */
const releaseCollectedMessages = async ({ id } = {}) => {
  // סבב אחד בכל רגע נתון — אותה תבנית כמו בסריקת המייל (isRunning).
  // עיבוד רשומה לוקח שניות, ה-cron רץ כל דקה, ובלי הדגל סבבים היו נערמים זה
  // על זה. השחרור הידני ("עבד עכשיו") אינו נחסם: הוא מטפל ברשומה מסוימת,
  // והתפיסה האטומית ממילא מונעת עיבוד כפול.
  if (!id) {
    if (isReleasing) return [];
    isReleasing = true;
  }

  try {
    return await releaseDue(id);
  } finally {
    if (!id) isReleasing = false;
  }
};

const releaseDue = async (id) => {
  const filter = id
    ? { _id: id, status: "collecting" }
    : { status: "collecting", processAfter: { $lte: new Date() } };

  // תקרה לכל סבב: אם הצטברו הרבה, עדיף שהסבב הבא ימשיך מאשר שדקה אחת תנסה
  // לעבד הכול ותיתקע.
  const due = await IncomingOrder.find(filter).sort({ processAfter: 1 }).limit(20);
  const processed = [];

  for (const candidate of due) {
    // ── תפיסה אטומית ──
    // מעבר ל-"received" הוא מה שמונע משני סבבים (או מ-cron ומלחיצה ידנית)
    // לעבד את אותה רשומה פעמיים ולייצר שתי הזמנות.
    const claimed = await IncomingOrder.findOneAndUpdate(
      { _id: candidate._id, status: "collecting" },
      { $set: { status: "received" }, $unset: { processAfter: "" } },
      { new: true }
    );
    if (!claimed) continue;

    try {
      processed.push(await finishIngestion(claimed));
    } catch (err) {
      console.error(`[ingestion] כשל בעיבוד רשומה שנצברה ${claimed._id}: ${err.message}`);
    }
  }

  return processed;
};

/**
 * קליטת הודעה נכנסת.
 *
 * @param {Object} input
 * @param {"email"|"whatsapp"|"manual"} input.channel
 * @param {string} input.externalId - מזהה ההודעה במקור (למניעת כפילות)
 * @param {string} input.text - גוף ההודעה
 * @param {Object} [input.sender] - { name, phone, email, raw }
 * @param {string} [input.subject]
 * @param {Array}  [input.attachments]
 * @param {Date}   [input.receivedAt]
 * @param {boolean} [input.dryRun] - לעצור לפני יצירת ההזמנה (כיול)
 * @param {Array} [input.links] - קישורי הזמנה שזוהו בגוף המייל
 * @returns {Promise<Object>} מסמך IncomingOrder
 */
const ingestMessage = async ({
  channel,
  externalId,
  text,
  sender = {},
  subject,
  attachments = [],
  receivedAt,
  dryRun = false,
  // קישורים שזוהו בגוף המייל כמועמדים ל"ההזמנה נמצאת כאן". מגיעים מקוראי
  // המייל (lib/imap-reader, lib/gmail-reader), שם עדיין קיים ה-HTML של
  // ההודעה — אחרי ההמרה לטקסט אין יותר כתובות, ולכן החילוץ לא יכול לחכות
  // לכאן. ראה lib/link-follower/extractLinks.
  links = [],
}) => {
  if (!externalId) throw new Error("externalId חסר — בלעדיו אין הגנה מפני כפילות");
  if (!text || !String(text).trim()) {
    throw new Error("הודעה ריקה — אין מה לעבד");
  }

  // ── מניעת כפילות ──
  // נבדק גם מול הודעות שצורפו לרשומה פתוחה, ולא רק מול externalId הראשי:
  // שרת הווצאפ שולח שוב אחרי timeout, וההודעה השנייה הייתה נדבקת לרשומה
  // בפעם השנייה — כלומר "3 מגבות נייר" היה הופך ל-6.
  const existing = await IncomingOrder.findOne({
    $or: [{ externalId }, { "messages.externalId": externalId }],
  });
  if (existing) {
    console.log(
      `[ingestion] הודעה ${externalId} כבר נקלטה (סטטוס ${existing.status}) — מדלג`
    );
    return existing;
  }

  const normalizedSender = {
    name: sender.name,
    phone: canonicalPhone(sender.phone) || undefined,
    email: sender.email ? String(sender.email).toLowerCase().trim() : undefined,
    raw: sender.raw,
  };

  // ── רשימה לבנה: בכניסה, לפני הצבירה ──
  //
  // הבדיקה נאכפת גם בשחרור מהצבירה (finishIngestion), אבל כאן היא מקדימה את
  // הצבירה עצמה — אחרת הודעה משולח לא מוכר הייתה יושבת את כל חלון השקט
  // בלשונית "ממתין להודעות", ורק בסופו מתגלה כמה שהיא: הודעה שלא נקראת.
  //
  // המחיר: לקוח שנוסף למערכת *בזמן* החלון כבר לא מורווח בדיעבד. במקומו יש
  // "לקוח חדש" בלשונית "שולח לא מוכר", שיוצר את הלקוח וקורא את ההודעה מחדש.
  // קישורים תקינים בלבד, ובתקרה — הרשימה נשמרת ברשומה ומוצגת במסך
  const orderLinks = (Array.isArray(links) ? links : [])
    .filter((link) => link?.url)
    .slice(0, 5);

  const intakeCheck = await isAllowedSender({
    sender: normalizedSender,
    channel,
    // מה שהופך "שולח לא מוכר" ל"פלטפורמה שטרם אושרה"
    hasOrderLinks: orderLinks.length > 0,
  });

  let platform = intakeCheck.platform || null;
  // הרישום במרשם נעשה בשני מסלולים (פלטפורמה חדשה ופלטפורמה מאושרת), והדגל
  // מונע רישום כפול — שהיה מנפח את מונה המיילים פי שתיים.
  let sightingRecorded = false;

  const noteSighting = async () => {
    sightingRecorded = true;
    return recordSighting({
      senderEmail: normalizedSender.email,
      senderName: normalizedSender.name,
      subject,
      links: orderLinks,
    }).catch((err) => {
      console.log(`[ingestion] רישום הפלטפורמה נכשל: ${err.message}`);
      return null;
    });
  };

  if (!intakeCheck.allowed) {
    // ── פלטפורמה, או סתם שולח לא מוכר ──
    //
    // מייל עם קישור להזמנה משולח שאינו לקוח הוא כמעט תמיד פלטפורמת הזמנות.
    // הוא נרשם במרשם — וזה מה שמאפשר לענות על "מי בכלל שולח לי ככה" בלי
    // שאיש ידע זאת מראש.
    const looksLikePlatform =
      channel === "email" && orderLinks.length > 0 && intakeCheck.platformStatus !== null;

    if (looksLikePlatform) {
      platform = await noteSighting();

      // ‏status="approved" כאן קורה בשני מצבים: דגל האישור האוטומטי, או
      // אישור שנעשה בין הבדיקה לרישום. בשניהם ממשיכים כרגיל ולא חוסמים.
      if (!platform || platform.status !== "approved") {
        return registerPlatformMessage({
          channel,
          externalId,
          text,
          sender: normalizedSender,
          subject,
          attachments,
          receivedAt,
          links: orderLinks,
          platform,
          reason: intakeCheck.reason,
        });
      }
    } else {
      return rejectUnknownSender({
        channel,
        externalId,
        text,
        sender: normalizedSender,
        subject,
        attachments,
        receivedAt,
        links: orderLinks,
        reason: intakeCheck.reason,
      });
    }
  }

  // ── פלטפורמה מאושרת: אותו רישום, בשביל המונים ──
  //
  // בלי זה המונים היו נשארים על אפס בדיוק לפלטפורמות שעובדות: הרישום היה
  // קורה רק במסלול הדחייה, כלומר רק עד האישור. המסך היה מראה "0 מיילים" לצד
  // "14 הזמנות", ו"נראתה לאחרונה" היה קופא בתאריך האישור.
  if (platform && !sightingRecorded) {
    platform = (await noteSighting()) || platform;
  }

  // ── צבירת הודעות המשך בווצאפ ──
  //
  // ראה collectWhatsappMessage. בערוצים אחרים אין מה לצבור: מייל מגיע כמסמך
  // שלם, והרצה ידנית היא כלי בדיקה שחייב להחזיר תשובה מיד.
  if (channel === "whatsapp" && !dryRun && COLLECT_WINDOW_MS() > 0) {
    const collected = await collectWhatsappMessage({
      externalId,
      text,
      sender,
      attachments,
      receivedAt,
    });
    if (collected) return collected;
  }

  const doc = new IncomingOrder({
    channel,
    externalId,
    sender: normalizedSender,
    subject,
    rawText: String(text),
    attachments,
    receivedAt: receivedAt || new Date(),
    status: "received",
    ...(orderLinks.length ? { links: orderLinks } : {}),
    ...(platform
      ? {
          platform: {
            ref: platform._id,
            key: platform.key,
            name: platform.name,
            status: platform.status,
          },
        }
      : {}),
  });

  try {
    await doc.save();
  } catch (err) {
    // מקרה תחרות: שני תהליכים קלטו את אותה הודעה בו-זמנית
    if (err.code === 11000) {
      const dup = await IncomingOrder.findOne({ externalId });
      if (dup) return dup;
    }
    throw err;
  }

  return finishIngestion(doc, { dryRun });
};

/**
 * מהרשומה השמורה ועד ההזמנה: רשימה לבנה ואז עיבוד.
 *
 * מופרד מ-ingestMessage כי יש לו שני נתיבי כניסה — הודעה שנקלטה עכשיו, והודעה
 * שהמתינה בחלון הצבירה ושוחררה בידי ה-cron. שכפול הבדיקה בשניהם היה מזמין
 * מצב שבו הרשימה הלבנה נאכפת רק באחד מהם.
 *
 * הבדיקה כאן אינה כפילות מיותרת של הבדיקה בכניסה: רשומה שנצברה משתחררת דקות
 * אחרי שנקלטה, והלקוח יכול היה להימחק בינתיים.
 *
 * ‏reprocess **אינו** עובר כאן אלא ישר ל-processIncomingOrder, וזה מכוון:
 * הרצה חוזרת היא פעולה של אדמין, ובמסלול "לקוח חדש" הלקוח נוצר רגע לפניה.
 */
const finishIngestion = async (doc, { dryRun = false } = {}) => {
  // ── רשימה לבנה: קוראים רק מלקוחות שקיימים במערכת ──
  //
  // נבדק *לפני* כל ניתוח, כדי שהודעה משולח לא מוכר לא תעלה כלום ולא תיכנס
  // לתיבת הטיפול. ההודעה כן נשמרת — כדי שהזמנה של לקוח חדש לא תיעלם בשקט,
  // והיא מופיעה בלשונית "שולח לא מוכר" עם אפשרות ליצור לקוח ולקרוא מחדש.
  const senderCheck = await isAllowedSender({
    sender: doc.sender,
    channel: doc.channel,
    hasOrderLinks: Boolean(doc.links?.length),
  });
  if (!senderCheck.allowed) {
    // רשומה של פלטפורמה חוזרת ללשונית הפלטפורמות ולא לזו של שולח לא מוכר.
    // המצב הזה קורה כשהאישור נשלל בין הקליטה לעיבוד, או כשהודעה שנצברה
    // משתחררת אחרי שהפלטפורמה נחסמה.
    doc.status = doc.platform?.ref || senderCheck.platform ? "platform_pending" : "unknown_sender";
    log(doc, "whitelist", senderCheck.reason);
    await doc.save();
    return doc;
  }

  if (senderCheck.matchedBy && senderCheck.matchedBy !== "channel-exempt") {
    log(doc, "whitelist", `השולח מאושר (${senderCheck.matchedBy})`);
  }

  return processIncomingOrder(doc, { dryRun });
};

/**
 * הרצה חוזרת אחרי תיקון הסיבה (למשל הוספת המוצר החסר לקטלוג).
 *
 * הזמנת שגיאה שנוצרה בריצה הקודמת נמחקת לפני הריצה החדשה: היא לא הורידה מלאי,
 * לא נכנסה לדוחות ולא נשלחה ללקוח, ולכן אין מה לשמר בה — ולהשאיר אותה היה
 * מייצר שתי הזמנות לאותה הודעה.
 *
 * הזמנה תקינה שכבר נוצרה *אינה* נמחקת, וההרצה החוזרת נחסמת.
 */
const reprocess = async (incomingOrderId) => {
  const doc = await IncomingOrder.findById(incomingOrderId);
  if (!doc) throw new Error("הודעה נכנסת לא נמצאה");

  if (doc.status === "order_created") {
    throw new Error(
      `ההודעה כבר הפכה להזמנה ${doc.invoice} — הרצה חוזרת תיצור הזמנה כפולה`
    );
  }

  // ── הודעה מפלטפורמה שטרם אושרה ──
  //
  // ‏reprocess הוא נתיב אדמין ולכן פטור מהרשימה הלבנה — וזה בסדר כשמדובר
  // בלקוח. כאן זה היה שער עוקף: "נסה שוב" על הודעה מפלטפורמה לא מאושרת היה
  // גורם לשרת לפתוח קישור מכתובת שאיש לא אישר, כלומר בדיוק מה שהאישור נועד
  // למנוע — ובלי שמי שלחץ ידע שזו המשמעות.
  //
  // התנאי הוא על **מצב הפלטפורמה עכשיו** ולא על הסטטוס ששמור ברשומה: אחרי
  // אישור, ההודעות שנותרו בתור (מעבר לתקרת האצווה) עדיין נושאות
  // ‏platform.status="pending" ברשומה, והרצה חוזרת עליהן חייבת לעבוד.
  if (doc.status === "platform_pending" && doc.platform?.ref) {
    const platform = await OrderPlatform.findById(doc.platform.ref).select("status name key");
    if (!platform || platform.status !== "approved") {
      throw new Error(
        `ההודעה הגיעה מ${platform?.name || doc.platform.name || "פלטפורמה"} שטרם אושרה. ` +
          `יש לאשר את הפלטפורמה במסך "פלטפורמות הזמנות" — אישור אחד קורא גם את ההודעה הזו ` +
          `וגם את כל מה שיגיע ממנה בעתיד.`
      );
    }
  }

  // ── רשומה שעדיין צוברת עוברת דרך השחרור ולא דרך המסלול הרגיל ──
  //
  // המסלול הרגיל קורא, משנה סטטוס ושומר — שלושה שלבים שה-cron יכול להיכנס
  // באמצעם ולתפוס את אותה רשומה, כלומר שתי הזמנות מאותן הודעות. השחרור תופס
  // את הרשומה בפעולה אטומית אחת, ולכן רק אחד מהם מנצח.
  if (doc.status === "collecting") {
    const [released] = await releaseCollectedMessages({ id: incomingOrderId });
    if (released) return released;
    // ה-cron הקדים — הרשומה כבר בעיבוד או עובדה
    return IncomingOrder.findById(incomingOrderId);
  }

  // מחיקת הזמנות השגיאה מהריצה הקודמת.
  //
  // מחפשים לפי הקישור ההפוך (incomingOrder) ולא רק לפי doc.order: אם בריצה
  // הקודמת ההזמנה נוצרה אבל שמירת הרשומה נכשלה, doc.order ריק — והזמנת שגיאה
  // "יתומה" הייתה נשארת ומצטרפת להזמנה החדשה, כלומר שתי הזמנות לאותה הודעה.
  // התנאי על ingestionError.code מבטיח שלא נמחק בטעות הזמנה תקינה.
  const previousErrorOrders = await Order.find({
    incomingOrder: doc._id,
    "ingestionError.code": { $exists: true, $ne: null },
    // הזמנה שאדם כבר אישר אינה נמחקת — היא הפכה להזמנה אמיתית
    "ingestionError.resolvedAt": null,
  }).select("invoice");

  for (const previous of previousErrorOrders) {
    await Order.findByIdAndDelete(previous._id);
    console.log(`[ingestion] הזמנת השגיאה ${previous.invoice} נמחקה לפני הרצה חוזרת`);
    doc.logs.push({
      at: new Date(),
      step: "retry",
      message: `הזמנת השגיאה ${previous.invoice} נמחקה לפני הרצה חוזרת`,
    });
  }

  doc.order = undefined;
  doc.invoice = undefined;

  // איפוס תוצאות הריצה הקודמת
  doc.matchedItems = [];
  doc.confidence = 0;
  doc.resolved = {};
  doc.status = "received";

  return processIncomingOrder(doc);
};

/**
 * האם ההודעה הזו כבר נקלטה בעבר.
 *
 * מאפשר לקוראי המייל לדלג על הודעה בלי להוריד את גוף ההודעה מהשרת. זה נדרש
 * במיוחד להודעות שאינן מלקוחות: הן במכוון אינן מסומנות כנקראו ואינן מתויגות,
 * ולכן חוזרות בכל סריקה — ובלי הבדיקה הזו גוף ההודעה היה נמשך מחדש כל 2 דקות
 * במשך כל חלון הסריקה.
 *
 * @param {string} externalId
 * @returns {Promise<boolean>}
 */
const isAlreadyIngested = async (externalId) => {
  if (!externalId) return false;
  // גם הודעה שצורפה לרשומה פתוחה נחשבת שנקלטה: היא אינה ה-externalId הראשי של
  // אף רשומה, ובלי הבדיקה הזו שליחה חוזרת מהשרת של ווצאפ הייתה מפרסרת את
  // הקבצים שלה שוב לפני ש-ingestMessage דוחה אותה.
  const existing = await IncomingOrder.findOne({
    $or: [{ externalId }, { "messages.externalId": externalId }],
  })
    .select("_id")
    .lean();
  return Boolean(existing);
};

module.exports = {
  ingestMessage,
  isAlreadyIngested,
  reprocess,
  processIncomingOrder,
  releaseCollectedMessages,
  COLLECT_WINDOW_MS,
  MIN_ORDER_CONFIDENCE,
  ALLOW_PARTIAL,
};

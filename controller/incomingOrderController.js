// controller/incomingOrderController.js
//
// שני סוגי נקודות קצה:
//   • webhook לשרת הווצאפ — כאן נכנסות הודעות ווצאפ בזמן אמת.
//   • API לדשבורד — צפייה בהודעות שנקלטו, טיפול בכשלים, סריקת מייל ידנית.
//
// סריקת המייל מתוזמנת בתחתית הקובץ (אותה תבנית כמו הקרונים הקיימים במערכת).

require("dotenv").config();
const cron = require("node-cron");

const IncomingOrder = require("../models/IncomingOrder");
const Order = require("../models/Order");
const Status = require("../models/Status");
const logStatusChange = require("../utils/logStatusChange");
const { handleProductQuantity } = require("../lib/stock-controller/others");
const { sendOrderNotificationEmail } = require("../lib/email-sender/sender");
const { ingestMessage, reprocess, isAlreadyIngested } = require("../lib/order-ingestion");
const { checkStock } = require("../lib/order-ingestion/createOrder");
const { pollOnce, isMailConfigured, getActiveChannel } = require("../lib/mail-reader");
const { getIngestionErrorStatusId } = require("../utils/ingestionStatus");
const {
  refresh: refreshSenderWhitelist,
  stats: senderWhitelistStats,
  isAllowedSender,
} = require("../lib/order-ingestion/senderWhitelist");
const { readAttachment, MAX_ATTACHMENT_BYTES } = require("../lib/attachment-reader");
const Customer = require("../models/Customer");
const { canonicalPhone } = require("../utils/phone");

/**
 * שם אדמין לתצוגה.
 *
 * `Admin.name` הוא מסוג Object בסכמה ({ he, en }), ולכן req.user.name הוא אובייקט —
 * לא מחרוזת. שמירתו הישירה בשדה String גורמת לשגיאת ולידציה (ולא ל-"[object Object]"),
 * כלומר כל פעולה שניסתה לרשום את שם המבצע נכשלה.
 */
const adminDisplayName = (user) => {
  const name = user?.name;
  if (!name) return "אדמין";
  if (typeof name === "string") return name;
  return name.he || name.en || user.email || "אדמין";
};

// ─────────────────────────────────────────────────────────────
//  ווצאפ — webhook
// ─────────────────────────────────────────────────────────────

// מקסימום קבצים בהודעת ווצאפ אחת. הודעה עם יותר מזה אינה הזמנה אלא תקלה
// בצד השולח, וכל קובץ עולה פרסור.
const MAX_WHATSAPP_ATTACHMENTS = Number(process.env.WHATSAPP_MAX_ATTACHMENTS) || 5;

// ── נרמול הקלט של ה-webhook ──
//
// זו נקודת כניסה חיצונית, והשדות נשמרים היישר לסכמה של IncomingOrder. ערך
// מהסוג הלא נכון אינו נדחה בשקט — הוא **מפיל את השמירה** ב-CastError, ואז
// ההודעה נעלמת עם שורת לוג בלבד. אובייקט בשדה String ו-timestamp שאינו מספר
// הם בדיוק המקרים האלה, ולכן שום שדה לא נלקח כמו שהוא.

const sanitizeText = (value, maxLength = 500) =>
  typeof value === "string" || typeof value === "number"
    ? String(value).trim().slice(0, maxLength)
    : "";

/**
 * ‏timestamp של ווצאפ הוא **שניות**. ערך לא מספרי היה יוצר Invalid Date
 * ומפיל את השמירה; ערך במילישניות היה יוצר תאריך בשנת 57000. בשני המקרים
 * עדיף זמן הקליטה בפועל על פני איבוד ההודעה.
 */
const parseTimestamp = (value) => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date();

  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return new Date();

  // סטייה של יותר משנה קדימה אינה זמן אמיתי אלא יחידות שגויות
  if (date.getTime() > Date.now() + 365 * 24 * 60 * 60 * 1000) return new Date();

  return date;
};

/**
 * פענוח הקבצים שהגיעו ב-webhook, קריאתם, והחזרת הטקסט שחולץ.
 *
 * ההבדל היחיד מהמייל: כאן הקובץ מגיע כ-base64 בגוף הבקשה ולא כחלק MIME שכבר
 * פורק, ולכן הגודל נמדד אחרי הפענוח ולא נלקח מהצהרה של השולח.
 *
 * ‏Buffer.from(..., "base64") **אינו זורק** על קלט פגום — הוא מתעלם מתווים
 * שאינם base64. לכן אין מה לעטוף ב-try; מה שכן נבדק הוא שיצא ממנו משהו.
 * קובץ שיצא מעוות ייפול בהמשך אצל הפרסר עצמו, עם סיבה מפורשת.
 *
 * מה שזהה למייל: הרשימה הלבנה נבדקת **לפני** שנוגעים בקובץ. פרסור קובץ הוא
 * הרצת קוד על קלט לא מהימן, ואסור שמספר שאינו לקוח יוכל להזרים קובץ לפרסר.
 */
const readWhatsappAttachments = async (attachments, { allowed }) => {
  const summaries = [];
  const texts = [];

  for (const att of attachments.slice(0, MAX_WHATSAPP_ATTACHMENTS)) {
    // שם וסוג נשמרים ברשומה, ולכן הם נחתכים לאורך סביר ולא נלקחים כמו שהם
    const filename = sanitizeText(att?.filename, 255) || "ללא שם";
    const mimeType = sanitizeText(att?.mimeType, 120) || undefined;

    // ‏base64 הוא תמיד מחרוזת ב-JSON. כל דבר אחר אינו קובץ.
    const data = typeof att?.data === "string" ? att.data : "";

    const content = allowed && data ? Buffer.from(data, "base64") : null;

    if (content && content.length === 0) {
      summaries.push({
        filename,
        mimeType,
        size: 0,
        read: false,
        error: "הקובץ הגיע ריק או שאינו base64 תקין",
      });
      continue;
    }

    // כששולח אינו מאושר הקובץ אינו מפוענח בכלל, ולכן הגודל נאמד מאורך ה-base64
    // (‏4 תווים לכל 3 בתים) — כדי שברשומה יופיע גודל אמיתי ולא אפס.
    const estimatedSize = Math.floor((data.length * 3) / 4);

    const { summary, text } = await readAttachment({
      filename,
      mimeType,
      size: content ? content.length : Number(att?.size) || estimatedSize,
      content,
      allowed,
    });

    if (text) texts.push(text);
    summaries.push(summary);
  }

  if (attachments.length > MAX_WHATSAPP_ATTACHMENTS) {
    summaries.push({
      filename: `(עוד ${attachments.length - MAX_WHATSAPP_ATTACHMENTS} קבצים)`,
      read: false,
      error: `בהודעה היו ${attachments.length} קבצים — נקראו ${MAX_WHATSAPP_ATTACHMENTS} הראשונים`,
    });
  }

  return { summaries, texts };
};

/**
 * POST /api/incoming-orders/whatsapp
 * נקרא ע"י שרת הווצאפ על כל הודעה פרטית נכנסת שאינה תשובת סקר.
 *
 * מאובטח ע"י המידלוור isWhatsappServer (x-api-key או טוקן אדמין).
 *
 * גוף הבקשה:
 *   {
 *     messageId, phone, name?, text?, timestamp?,
 *     attachments?: [{ filename, mimeType, data }]   // data = base64
 *   }
 *
 * ‏text או attachments — לפחות אחד מהם. הודעה שכולה קובץ (הזמנה שנשלחה כאקסל
 * או כ-PDF) היא מקרה לגיטימי לגמרי, ולכן text אינו חובה כשיש קובץ.
 *
 * מחזיר תשובה מיד ומעבד ברקע: שרת הווצאפ לא צריך להמתין ל-OpenAI, ו-timeout
 * שלו לא אמור לגרום לשליחה חוזרת של אותה הודעה.
 */
const receiveWhatsappMessage = async (req, res) => {
  const messageId = sanitizeText(req.body?.messageId, 200);
  const phone = sanitizeText(req.body?.phone, 40);
  const name = sanitizeText(req.body?.name, 120);
  const bodyText = sanitizeText(req.body?.text, 100_000);
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];

  if (!messageId) {
    return res.status(400).send({ success: false, message: "messageId חסר" });
  }
  if (!phone) {
    return res.status(400).send({ success: false, message: "phone חסר" });
  }
  if (!bodyText && !attachments.length) {
    return res.status(400).send({ success: false, message: "אין text ואין attachments" });
  }

  // תשובה מיידית — העיבוד ממשיך ברקע
  res.status(202).send({ success: true, message: "ההודעה נקלטה לעיבוד" });

  const externalId = `whatsapp:${messageId}`;

  try {
    const sender = {
      phone,
      name: name || undefined,
      raw: phone,
    };

    let attachmentSummaries = [];
    let attachmentTexts = [];

    if (attachments.length) {
      // ‏ingestMessage בודק כפילות בעצמו, אבל רק **אחרי** השלב הזה. שרת ווצאפ
      // ששולח שוב אחרי timeout היה גורם לפרסור חוזר של אותו קובץ בכל ניסיון —
      // עבודה מיותרת על קלט לא מהימן. בדיקה אחת באינדקס חוסכת את זה.
      //
      // כשל בבדיקה עצמה (מסד לא זמין) אינו עוצר: ingestMessage בודק שוב,
      // ובסופו של דבר האינדקס הייחודי על externalId הוא מה שמונע כפילות.
      let alreadyIngested = false;
      try {
        alreadyIngested = await isAlreadyIngested(externalId);
      } catch (err) {
        console.warn(`[whatsapp-webhook] בדיקת כפילות נכשלה: ${err.message}`);
      }

      if (alreadyIngested) {
        console.log(`[whatsapp-webhook] ${messageId} כבר נקלטה — מדלג`);
        return;
      }

      // אותה בדיקה שתיעשה שוב בתוך ingestMessage. היא נעשית כאן מוקדם רק כדי
      // שקובץ משולח לא מוכר לא יגיע לפרסר בכלל; היא זולה (רשימה בזיכרון).
      //
      // אם היא נכשלת — לא מפילים את ההודעה. מתייחסים לשולח כלא מאושר, כלומר
      // הקובץ לא נקרא, וההודעה ממשיכה בצינור. איבוד הקובץ עדיף על איבוד ההודעה.
      let senderAllowed = false;
      try {
        senderAllowed = (await isAllowedSender({ sender, channel: "whatsapp" })).allowed;
      } catch (err) {
        console.warn(`[whatsapp-webhook] בדיקת הרשימה הלבנה נכשלה: ${err.message}`);
      }

      const result = await readWhatsappAttachments(attachments, { allowed: senderAllowed });
      attachmentSummaries = result.summaries;
      attachmentTexts = result.texts;
    }

    // הודעה שכולה קובץ שלא נקרא (תמונה, הקלטה קולית, PDF סרוק) עוברת בצינור
    // בכל זאת, עם שורת הסבר במקום הטקסט — בדיוק כמו מייל בלי טקסט קריא.
    // אחרת הזמנה שלקוח אמיתי שלח כתצלום פשוט נעלמת בלי שאיש יידע עליה.
    const combined = [bodyText, ...attachmentTexts].filter(Boolean).join("\n\n");

    const textForIngestion =
      combined ||
      "[הודעת ווצאפ ללא טקסט קריא — ייתכן שההזמנה נשלחה כתמונה או כקובץ סרוק]" +
        (attachmentSummaries.length
          ? `\nקבצים מצורפים: ${attachmentSummaries.map((a) => a.filename).join(", ")}`
          : "");

    const doc = await ingestMessage({
      channel: "whatsapp",
      externalId,
      text: textForIngestion,
      sender,
      attachments: attachmentSummaries,
      receivedAt: parseTimestamp(req.body?.timestamp),
    });

    const read = attachmentSummaries.filter((a) => a.read).length;
    console.log(
      `[whatsapp-webhook] ${messageId} → ${doc.status}` +
        (attachmentSummaries.length ? ` (${read}/${attachmentSummaries.length} קבצים נקראו)` : "") +
        (doc.invoice ? ` (הזמנה ${doc.invoice})` : "")
    );
  } catch (err) {
    // התשובה כבר נשלחה — כאן רק רושמים
    console.error(`[whatsapp-webhook] כשל בקליטת ${messageId}: ${err.message}`);
  }
};

// הודעה נשארת בסטטוס "received" גם כשהשרת נפל באמצע העיבוד — ואז אין מי
// שימשיך אותה. אין ללשונית "בעיבוד" מקום קבוע בדשבורד (במצב תקין הסטטוס חולף
// תוך שניות), ולכן הדשבורד צריך סימן שאומר "יש כאן משהו תקוע באמת".
//
// מה *לא* נחשב תקוע:
//   • הודעה צעירה — סריקת המייל רצה כל 2 דקות, ובזמן העיבוד ההודעה עדיין
//     בסטטוס הזה באופן תקין.
//   • ערוץ "manual" — כלי הכיול (POST /test) רץ כברירת מחדל כהרצה יבשה
//     שנעצרת לפני יצירת ההזמנה ומשאירה את הרשומה ב-"received" בכוונה.
//     בלי החרגה כאן כל בדיקת כיול הייתה מדליקה התראה שלעולם לא נכבית.
const STUCK_IN_PROCESSING_MS = 10 * 60 * 1000;

// הגדרה אחת, לספירה ולרשימה כאחד — אחרת התג היה אומר 1 והרשימה מציגה 12.
const stuckInProcessingFilter = () => ({
  status: "received",
  channel: { $ne: "manual" },
  createdAt: { $lt: new Date(Date.now() - STUCK_IN_PROCESSING_MS) },
});

// ─────────────────────────────────────────────────────────────
//  דשבורד
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/incoming-orders
 * פרמטרים: status, channel, search, page, limit
 *
 * status מקבל גם את הערך המיוחד "stuck" — הודעות שנתקעו בעיבוד. זה אינו סטטוס
 * במסד הנתונים אלא סינון (ראה STUCK_IN_PROCESSING_MS), והוא מוגדר כאן ולא
 * בצד הלקוח כדי שהספירה בלשונית והשורות ברשימה יגיעו מאותה הגדרה בדיוק.
 */
const getAllIncomingOrders = async (req, res) => {
  try {
    // req.query יכול להכיל אובייקטים ומערכים (?status[$ne]=x), ולא רק מחרוזות.
    // בלי הכפייה הזו אפשר היה להזריק אופרטורים של מונגו לתוך השאילתה.
    const asText = (value) => (typeof value === "string" ? value.trim() : "");
    const status = asText(req.query.status);
    const channel = asText(req.query.channel);
    const search = asText(req.query.search);
    const { page, limit } = req.query;

    // עמוד שלילי היה מייצר skip שלילי — שגיאת מונגו, כלומר 500 על קלט תמים.
    // התקרה על limit מונעת שליפה של כל האוסף בבקשה אחת.
    const pages = Math.max(1, Math.floor(Number(page)) || 1);
    const limits = Math.min(200, Math.max(1, Math.floor(Number(limit)) || 20));
    const skip = (pages - 1) * limits;

    const query = {};
    if (status === "stuck") {
      Object.assign(query, stuckInProcessingFilter());
    } else if (status && status !== "all") {
      query.status = status;
    }
    if (channel && channel !== "all") query.channel = channel;

    if (search) {
      // בריחה מתווים מיוחדים כדי שקלט חופשי לא ישבור את ה-regex
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "i");
      const asNumber = Number(search);

      query.$or = [
        { rawText: regex },
        { subject: regex },
        { "sender.phone": regex },
        { "sender.email": regex },
        { "sender.name": regex },
        ...(Number.isFinite(asNumber) ? [{ invoice: asNumber }] : []),
      ];
    }

    const [docs, totalDoc, counts, stuckCount] = await Promise.all([
      IncomingOrder.find(query)
        .populate({ path: "resolved.customer", select: "name lastName email phone" })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limits)
        .lean(),
      IncomingOrder.countDocuments(query),
      // ספירה לפי סטטוס לתגי הסינון — תמיד על כל הרשומות, לא על הסינון הנוכחי
      IncomingOrder.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      // כמה הודעות באמת תקועות בעיבוד — תמיד על כל הרשומות, כמו שאר הספירות.
      // משתמש באינדקס { status: 1, createdAt: -1 } הקיים.
      IncomingOrder.countDocuments(stuckInProcessingFilter()),
    ]);

    const countByStatus = counts.reduce((acc, c) => {
      acc[c._id] = c.count;
      return acc;
    }, {});

    res.send({
      incomingOrders: docs,
      totalDoc,
      pages,
      limits,
      countByStatus,
      stuckCount,
    });
  } catch (err) {
    console.log("getAllIncomingOrders error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/**
 * GET /api/incoming-orders/:id
 */
const getIncomingOrderById = async (req, res) => {
  try {
    const doc = await IncomingOrder.findById(req.params.id)
      .populate({ path: "resolved.customer", select: "name lastName email phone address" })
      .populate({ path: "order", select: "invoice total status createdAt" })
      .populate({ path: "matchedItems.product", select: "title sku prices stock image" });

    if (!doc) return res.status(404).send({ message: "ההודעה לא נמצאה" });

    res.send(doc);
  } catch (err) {
    console.log("getIncomingOrderById error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/**
 * POST /api/incoming-orders/:id/retry
 * הרצה חוזרת של הודעה שנכשלה. נחסם אם כבר נוצרה ממנה הזמנה.
 */
const retryIncomingOrder = async (req, res) => {
  try {
    const doc = await reprocess(req.params.id);
    res.send({
      message:
        doc.status === "order_created"
          ? `נוצרה הזמנה ${doc.invoice}`
          : `העיבוד הסתיים בסטטוס "${doc.status}"`,
      incomingOrder: doc,
    });
  } catch (err) {
    console.log("retryIncomingOrder error: ", err);
    res.status(400).send({ message: err.message });
  }
};

/**
 * PUT /api/incoming-orders/:id/ignore
 * סימון ידני של הודעה כלא רלוונטית, כדי שתצא מרשימת הטיפול.
 */
const ignoreIncomingOrder = async (req, res) => {
  try {
    const doc = await IncomingOrder.findById(req.params.id);
    if (!doc) return res.status(404).send({ message: "ההודעה לא נמצאה" });

    if (doc.status === "order_created") {
      return res
        .status(400)
        .send({ message: `ההודעה כבר הפכה להזמנה ${doc.invoice} ואי אפשר להתעלם ממנה` });
    }

    // אם נוצרה הזמנת שגיאה — היא נמחקת. בלי זה היא הייתה נשארת במסך ההזמנות
    // לנצח, בזמן שההודעה שיצרה אותה סומנה כלא רלוונטית. מותר למחוק כי היא לא
    // הורידה מלאי, לא נכנסה לדוחות ולא נשלחה ללקוח.
    const removedOrders = [];
    const errorOrders = await Order.find({
      incomingOrder: doc._id,
      "ingestionError.code": { $exists: true, $ne: null },
      "ingestionError.resolvedAt": null,
    }).select("invoice");

    for (const errorOrder of errorOrders) {
      await Order.findByIdAndDelete(errorOrder._id);
      removedOrders.push(errorOrder.invoice);
    }

    doc.status = "ignored";
    doc.order = undefined;
    doc.invoice = undefined;
    doc.logs.push({
      at: new Date(),
      step: "manual",
      message:
        `סומן כלא רלוונטי ע"י ${adminDisplayName(req.user)}` +
        (removedOrders.length ? ` — נמחקו הזמנות שגיאה: ${removedOrders.join(", ")}` : ""),
    });
    await doc.save();

    res.send({
      message: removedOrders.length
        ? `ההודעה סומנה כלא רלוונטית והזמנת השגיאה ${removedOrders.join(", ")} נמחקה`
        : "ההודעה סומנה כלא רלוונטית",
      incomingOrder: doc,
    });
  } catch (err) {
    console.log("ignoreIncomingOrder error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/**
 * POST /api/incoming-orders/order/:orderId/approve
 *
 * אישור הזמנה שנכנסה ב"שגיאה בקריאה", אחרי שאדם בדק והשלים אותה.
 *
 * זה הנתיב הנכון לאשר הזמנה כזו, ולא שינוי סטטוס ידני: שינוי סטטוס במערכת
 * *אינו* מוריד מלאי (המלאי יורד רק ב-WebHook של Cardcom), ולכן הזמנה שהועברה
 * ידנית ל"בטיפול" הייתה נלקטת בלי שהמלאי עודכן. כאן נעשות כל הפעולות שחסרות:
 * בדיקת מלאי, הורדת מלאי, סימון השגיאה כמטופלת, והתראת מייל.
 */
const approveErrorOrder = async (req, res) => {
  try {
    const approvedBy = adminDisplayName(req.user);

    const order = await Order.findById(req.params.orderId).populate("status");
    if (!order) {
      return res.status(404).send({ message: "ההזמנה לא נמצאה" });
    }

    if (!order.ingestionError?.code) {
      return res
        .status(400)
        .send({ message: "ההזמנה הזו אינה הזמנת שגיאה — אין מה לאשר" });
    }

    if (order.ingestionError.resolvedAt) {
      return res.status(400).send({
        message: `ההזמנה כבר אושרה ב-${new Date(
          order.ingestionError.resolvedAt
        ).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })}`,
      });
    }

    if (!order.cart?.length) {
      return res.status(400).send({
        message:
          "אין פריטים בהזמנה. יש לתקן את הסיבה ולהריץ את ההודעה שוב, או להוסיף פריטים להזמנה קודם.",
      });
    }

    // ההזמנה חייבת להיות עדיין ב"שגיאה בקריאה". אם מישהו שינה את הסטטוס ידנית
    // (בוטלה, נמסרה, בליקוט) — אישור כאן היה מחזיר אותה לבטיפול ומוריד מלאי
    // בפעם השנייה.
    const errorStatusId = await getIngestionErrorStatusId();
    if (!errorStatusId || String(order.status?._id) !== String(errorStatusId)) {
      return res.status(409).send({
        message: `סטטוס ההזמנה שונה ידנית ל"${
          order.status?.heName || order.status?.name || "לא ידוע"
        }". יש לטפל בה דרך מסך ההזמנות.`,
      });
    }

    // בדיקת מלאי לפני אישור — ייתכן שעבר זמן מאז הקליטה
    const itemsForCheck = order.cart.map((item) => ({
      product: { _id: item._id, title: item.title },
      quantity: item.quantity,
      rawName: item.title?.he || item.sku,
    }));
    const { problems } = await checkStock(itemsForCheck);
    if (problems.length) {
      return res
        .status(409)
        .send({ message: `אין מלאי מספיק: ${problems.join("; ")}` });
    }

    const processingStatus = await Status.findOne({ name: "Processing" });
    if (!processingStatus) {
      return res.status(500).send({ message: 'סטטוס "Processing" לא נמצא במערכת' });
    }

    const previousStatusName = order.status?.heName || order.status?.name || "שגיאה בקריאה";

    // ── תפיסה אטומית ──
    // שתי לחיצות במקביל (שני עובדים, או לחיצה כפולה) היו עוברות את הבדיקות
    // למעלה בשתי הבקשות, ואז המלאי היה יורד פעמיים. העדכון המותנה הזה מבטיח
    // שרק בקשה אחת "תופסת" את ההזמנה, והשנייה תקבל 409.
    const claimed = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: errorStatusId,
        "ingestionError.resolvedAt": null,
      },
      {
        $set: {
          status: processingStatus._id,
          "ingestionError.resolvedAt": new Date(),
          "ingestionError.resolvedBy": approvedBy,
        },
      },
      { new: true }
    );

    if (!claimed) {
      return res.status(409).send({
        message: "ההזמנה אושרה או שונתה בו-זמנית ע\"י מישהו אחר. רענן את הדף.",
      });
    }

    await logStatusChange({
      from: previousStatusName,
      to: "Processing",
      functionName: `approveErrorOrder:${approvedBy}`,
      order: claimed,
    });

    // הורדת מלאי — לא נעשתה ביצירת הזמנת השגיאה.
    // רק אחרי התפיסה האטומית, כדי שלא תרוץ פעמיים.
    try {
      await handleProductQuantity(claimed.cart);
    } catch (stockError) {
      console.error(
        `[approveErrorOrder] כשל בהורדת מלאי להזמנה ${claimed.invoice}: ${stockError.message}`
      );
    }

    // עכשיו מותר להודיע — ההזמנה אושרה ע"י אדם
    try {
      await sendOrderNotificationEmail(claimed, claimed.user_info);
    } catch (emailError) {
      console.error(
        `[approveErrorOrder] כשל בשליחת התראת מייל להזמנה ${claimed.invoice}: ${emailError.message}`
      );
    }

    // הוצאת ההודעה מרשימת הטיפול
    if (claimed.incomingOrder) {
      await IncomingOrder.findByIdAndUpdate(claimed.incomingOrder, {
        status: "order_created",
        $push: {
          logs: {
            at: new Date(),
            step: "manual",
            message: `הזמנת השגיאה ${claimed.invoice} אושרה ע"י ${approvedBy}`,
          },
        },
      });
    }

    res.send({
      message: `הזמנה ${claimed.invoice} אושרה והועברה לבטיפול. המלאי עודכן.`,
      order: claimed,
    });
  } catch (err) {
    console.log("approveErrorOrder error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/**
 * POST /api/incoming-orders/order/:orderId/retry
 *
 * הרצה חוזרת של ההודעה שממנה נוצרה הזמנת השגיאה — לשימוש מתוך מסך ההזמנה.
 * הזמנת השגיאה נמחקת ובמקומה נוצרת הזמנה נקייה (או שגיאה חדשה).
 */
const retryFromOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId).select(
      "incomingOrder ingestionError invoice"
    );
    if (!order) {
      return res.status(404).send({ message: "ההזמנה לא נמצאה" });
    }
    if (!order.incomingOrder) {
      return res
        .status(400)
        .send({ message: "ההזמנה לא נוצרה מהודעה נכנסת — אין מה להריץ שוב" });
    }

    const doc = await reprocess(order.incomingOrder);

    res.send({
      message:
        doc.status === "order_created"
          ? `נוצרה הזמנה ${doc.invoice}`
          : `העיבוד הסתיים בסטטוס "${doc.status}"${doc.invoice ? ` (הזמנה ${doc.invoice})` : ""}`,
      incomingOrder: doc,
      newOrderId: doc.order,
    });
  } catch (err) {
    console.log("retryFromOrder error: ", err);
    res.status(400).send({ message: err.message });
  }
};

/**
 * POST /api/incoming-orders/:id/approve-sender
 *
 * "השולח הזה הוא לקוח חדש שלנו" — יוצר כרטיס לקוח מפרטי השולח, מרענן את
 * הרשימה הלבנה, וקורא את ההודעה מחדש.
 *
 * זה מה שמונע מהרשימה הלבנה להיות חור שקט: הזמנה של לקוח חדש נשמרת, נראית
 * בדשבורד, ובלחיצה אחת הופכת ללקוח + הזמנה.
 */
const approveSenderAndReprocess = async (req, res) => {
  try {
    const doc = await IncomingOrder.findById(req.params.id);
    if (!doc) return res.status(404).send({ message: "ההודעה לא נמצאה" });

    if (doc.status !== "unknown_sender") {
      return res.status(400).send({
        message: `ההודעה אינה בסטטוס "שולח לא מוכר" (סטטוס נוכחי: ${doc.status})`,
      });
    }

    const email = doc.sender?.email ? String(doc.sender.email).toLowerCase().trim() : null;
    const phone = canonicalPhone(doc.sender?.phone);

    if (!email && !phone) {
      return res
        .status(400)
        .send({ message: "אין מייל ואין טלפון בשולח — לא ניתן ליצור ממנו לקוח" });
    }

    // ייתכן שהלקוח נוסף בינתיים ידנית — לא יוצרים כפילות
    let customer = null;
    if (email) customer = await Customer.findOne({ email });

    let created = false;
    if (!customer) {
      // שם מהבקשה אם נשלח, אחרת שם השולח מהערוץ, אחרת לפי המזהה
      const name =
        String(req.body?.name || doc.sender?.name || "").trim() ||
        (phone ? `לקוח ${phone}` : email);

      customer = new Customer({
        name,
        lastName: String(req.body?.lastName || "").trim(),
        // לקוח ווצאפ בלי מייל מקבל מייל סינתטי, כמו בשאר הצינור
        email: email || `wa-${phone}@whatsapp.local`,
        phone: phone || "",
        isRegistered: false,
      });

      try {
        await customer.save();
        created = true;
      } catch (err) {
        if (err.code === 11000) {
          customer = await Customer.findOne({ email: customer.email });
          if (!customer) throw err;
        } else {
          throw err;
        }
      }
    }

    // הרשימה הלבנה מוחזקת בזיכרון — בלי רענון מיידי ההודעה הייתה נדחית שוב
    await refreshSenderWhitelist();

    doc.logs.push({
      at: new Date(),
      step: "manual",
      message: `${created ? "נוצר" : "שויך"} לקוח ${customer.name} (${customer._id}) ע"י ${adminDisplayName(req.user)}`,
    });
    doc.status = "received";
    await doc.save();

    const processed = await reprocess(doc._id);

    res.send({
      message: `${created ? "נוצר לקוח חדש" : "זוהה לקוח קיים"}: ${customer.name}. ${
        processed.status === "order_created"
          ? `נוצרה הזמנה ${processed.invoice}`
          : `העיבוד הסתיים בסטטוס "${processed.status}"`
      }`,
      customer: { _id: customer._id, name: customer.name, email: customer.email, phone: customer.phone },
      created,
      incomingOrder: processed,
    });
  } catch (err) {
    console.log("approveSenderAndReprocess error: ", err);
    res.status(400).send({ message: err.message });
  }
};

/**
 * GET /api/incoming-orders/whitelist/stats
 * מצב הרשימה הלבנה — כמה לקוחות מאושרים ומתי נטענה.
 */
const getWhitelistStats = async (req, res) => {
  try {
    res.send(await senderWhitelistStats());
  } catch (err) {
    console.log("getWhitelistStats error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/**
 * POST /api/incoming-orders/whitelist/refresh
 * טעינה מחדש של הרשימה הלבנה — לשימוש אחרי הוספת לקוחות בכמות.
 */
const refreshWhitelist = async (req, res) => {
  try {
    await refreshSenderWhitelist();
    res.send({ message: "הרשימה הלבנה נטענה מחדש", ...(await senderWhitelistStats()) });
  } catch (err) {
    console.log("refreshWhitelist error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/**
 * POST /api/incoming-orders/scan-email
 * סריקת מייל ידנית מהדשבורד (בלי לחכות לקרון).
 */
const scanEmailNow = async (req, res) => {
  try {
    if (!isMailConfigured()) {
      return res.status(400).send({
        message:
          "קליטת מייל אינה מוגדרת. יש להגדיר IMAP_USER ו-IMAP_PASS ב-.env — ראה ORDER-INGESTION.md.",
      });
    }

    // חסימת max: כל הודעה נסרקת עולה קריאה ל-OpenAI, ובקשה עם max=5000
    // הייתה מייצרת עלות חריגה וריצה ארוכה. 100 הוא גם התקרה של Gmail API.
    const requestedMax = Number(req.body?.max);
    const max = Number.isFinite(requestedMax)
      ? Math.min(Math.max(1, Math.floor(requestedMax)), 100)
      : undefined;

    const result = await pollOnce({ query: req.body?.query, max });

    res.send({
      message:
        result.skipped === "already-running"
          ? "סריקה כבר רצה כרגע — נסה שוב בעוד רגע"
          : `נסרקו ${result.scanned} הודעות, ${result.ingested} נקלטו`,
      ...result,
    });
  } catch (err) {
    console.log("scanEmailNow error: ", err);
    res.status(500).send({ message: err.message });
  }
};

/**
 * POST /api/incoming-orders/test
 * הרצת טקסט חופשי דרך כל הצינור, בלי מייל ובלי ווצאפ.
 * שימושי לכיול הפרומפט על הזמנות אמיתיות לפני שמפעילים את הקליטה.
 *
 * ברירת המחדל היא **הרצה יבשה**: כל שלבי הקריאה וההתאמה רצים, אבל הזמנה
 * אינה נוצרת והמלאי אינו יורד. זו נקודת קצה לכיול, ולא היה נכון שכלי בדיקה
 * יזרים הזמנות אמיתיות למערכת. ליצירת הזמנה בפועל יש לשלוח real: true.
 */
const testIngestion = async (req, res) => {
  try {
    const { text, phone, email, name, real } = req.body || {};
    if (!text || !String(text).trim()) {
      return res.status(400).send({ message: "text חסר" });
    }

    const doc = await ingestMessage({
      channel: "manual",
      // חותמת זמן במזהה כדי שאפשר יהיה להריץ את אותו טקסט שוב בכיול
      externalId: `manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      text: String(text),
      sender: { phone, email, name },
      dryRun: real !== true,
    });

    res.send({
      dryRun: real !== true,
      message:
        real === true
          ? "הרצה מלאה — נוצרה הזמנה אם הקריאה הצליחה"
          : "הרצה יבשה — לא נוצרה הזמנה ולא ירד מלאי",
      incomingOrder: doc,
    });
  } catch (err) {
    console.log("testIngestion error: ", err);
    res.status(500).send({ message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
//  תזמון סריקת המייל
// ─────────────────────────────────────────────────────────────

// ברירת מחדל: כל 2 דקות. הזמנה שנשלחת במייל צריכה להיכנס מהר, וכל סריקה
// בלי הודעות חדשות היא קריאת API אחת זולה (בלי LLM).
const MAIL_CRON = process.env.MAIL_POLL_CRON || process.env.GMAIL_POLL_CRON || "*/2 * * * *";

// MAIL_POLLING_ENABLED הוא השם הנוכחי; GMAIL_POLLING_ENABLED נתמך לתאימות אחורה
const pollingEnabled =
  process.env.MAIL_POLLING_ENABLED === "true" ||
  process.env.GMAIL_POLLING_ENABLED === "true";

if (pollingEnabled) {
  if (!isMailConfigured()) {
    console.warn(
      "[mail] MAIL_POLLING_ENABLED=true אבל אין תצורת התחברות לתיבה — הסריקה לא תופעל"
    );
  } else {
    cron.schedule(MAIL_CRON, async () => {
      try {
        await pollOnce();
      } catch (err) {
        console.error(`[mail] כשל בסריקה המתוזמנת: ${err.message}`);
      }
    });
    console.log(
      `[mail] סריקת הזמנות מהמייל מתוזמנת (${MAIL_CRON}, ערוץ: ${getActiveChannel()})`
    );
  }
} else {
  console.log(
    "[mail] סריקת הזמנות מהמייל כבויה (להפעלה: MAIL_POLLING_ENABLED=true)"
  );
}

module.exports = {
  receiveWhatsappMessage,
  getAllIncomingOrders,
  getIncomingOrderById,
  retryIncomingOrder,
  ignoreIncomingOrder,
  approveErrorOrder,
  retryFromOrder,
  approveSenderAndReprocess,
  getWhitelistStats,
  refreshWhitelist,
  scanEmailNow,
  testIngestion,
};

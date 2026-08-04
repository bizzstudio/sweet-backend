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
//   4. התאמת הפריטים לקטלוג + פתירת יעד המשלוח.
//   5. הכול נקרא → הזמנה ב"בטיפול". משהו לא נקרא → הזמנה ב"שגיאה בקריאה",
//      עם מה שכן נקרא.
//
// כל הודעה מקבלת גם רשומת IncomingOrder — יומן ביקורת מול הטקסט המקורי.

const IncomingOrder = require("../../models/IncomingOrder");
const { INCOMING_ORDER_ERROR_CODES } = require("../../models/IncomingOrder");
const Order = require("../../models/Order");
const { extractOrder } = require("./llm");
const { parseOrderText } = require("./tableParser");
const { resolveItems, resolveCustomer, resolveDelivery } = require("./resolvers");
const { isAllowedSender } = require("./senderWhitelist");
const { createOrderFromParsed, createErrorOrder } = require("./createOrder");
const { sendEmailSilent } = require("../email-sender/sender");
const { canonicalPhone } = require("../../utils/phone");

// ביטחון כולל מתחת לסף הזה → הזמנת שגיאה במקום הזמנה תקינה
const MIN_ORDER_CONFIDENCE = Number(process.env.INGESTION_MIN_ORDER_CONFIDENCE) || 0.7;

// האם לקבל הזמנה חלקית כתקינה כשחלק מהפריטים לא זוהו.
// ברירת המחדל false: הזמנה חלקית שנכנסת ל"בטיפול" תילקט ותישלח בלי מוצר
// שהלקוח ביקש, ואף אחד לא יידע. עם false היא נכנסת ל"שגיאה בקריאה" — כלומר
// עדיין נכנסת למערכת, אבל לא תילקט לפני שאדם אישר אותה.
const ALLOW_PARTIAL = process.env.INGESTION_ALLOW_PARTIAL === "true";

const FAILURE_ALERT_EMAIL =
  process.env.INGESTION_ALERT_EMAIL ||
  process.env.ADD_ORDER_ERROR_ALERT_EMAIL ||
  process.env.OUR_EMAIL;

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

// שמירת פריט בפורמט של המודל (בלי המסמך המלא של המוצר)
const toMatchedItemDoc = (item) => ({
  rawName: item.rawName,
  quantity: item.quantity,
  quantityAssumed: Boolean(item.quantityAssumed),
  unit: item.unit,
  note: item.note,
  product: item.product?._id,
  productTitle: item.product?.title?.he || item.productTitle,
  sku: item.product?.sku,
  unitPrice: item.product?.prices?.price,
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

    // ── 3. התאמת הפריטים לקטלוג ──
    const { items, unmatched, dropped } = await resolveItems(parsed.items, {
      contextText: doc.rawText,
    });
    matchedItems = items;
    unmatchedItems = unmatched;
    doc.matchedItems = [...items, ...unmatched].map(toMatchedItemDoc);

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
  const arrivedAt = receivedAt || now;
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
    sender: {
      name: sender.name,
      phone: canonicalPhone(sender.phone) || undefined,
      email: sender.email ? String(sender.email).toLowerCase().trim() : undefined,
      raw: sender.raw,
    },
    subject,
    rawText: String(text),
    attachments,
    receivedAt: receivedAt || new Date(),
    status: "received",
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
 */
const finishIngestion = async (doc, { dryRun = false } = {}) => {
  // ── רשימה לבנה: קוראים רק מלקוחות שקיימים במערכת ──
  //
  // נבדק *לפני* כל ניתוח, כדי שהודעה משולח לא מוכר לא תעלה כלום ולא תיכנס
  // לתיבת הטיפול. ההודעה כן נשמרת — כדי שהזמנה של לקוח חדש לא תיעלם בשקט,
  // והיא מופיעה בלשונית "שולח לא מוכר" עם אפשרות ליצור לקוח ולקרוא מחדש.
  const senderCheck = await isAllowedSender({ sender: doc.sender, channel: doc.channel });
  if (!senderCheck.allowed) {
    doc.status = "unknown_sender";
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

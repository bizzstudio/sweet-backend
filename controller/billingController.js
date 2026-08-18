// controller/billingController.js
//
// נקודות הקצה של החיוב: תעודות משלוח, סגירת חודש, זיכוי וקבלה.
//
// כל הפעולות שמפיקות מסמך ב-iCount מוגנות ב-isAdmin (ראו routes/billingRoutes)
// ואינן חשופות ללקוח. מסמך מס אינו ניתן למחיקה, ולכן אין כאן שום מסלול
// שמפיק מסמך כתופעת לוואי של פעולה אחרת.

const mongoose = require("mongoose");
const DeliveryNote = require("../models/DeliveryNote");
const Quote = require("../models/Quote");
const Customer = require("../models/Customer");
const deliveryNotes = require("../lib/billing/deliveryNotes");
const monthlyBilling = require("../lib/billing/monthlyBilling");
const quotes = require("../lib/billing/quotes");
const { priceItemsForCustomer, priceQuality } = require("../lib/billing/pricing");
const { listInvoices } = require("../lib/billing/invoices");
const { listReceipts, isDayString } = require("../lib/billing/receipts");
const { calculateVat } = require("../lib/billing/vat");
const {
  createReceipt,
  getDocument,
  DOC_TYPES,
  autoEmailEnabled,
} = require("../lib/icount/documents");
const { syncCustomer } = require("../lib/icount/clients");
const { ping } = require("../lib/icount/client");
const { isDemoMode, modeLabel } = require("../lib/icount/mode");
const demo = require("../lib/billing/demo");
const ledger = require("../lib/billing/ledger");

// תקרות על קלט מהרשת. limit לא חסום מאפשר לבקשה אחת לשלוף את כל
// הקולקציה, ומערך פריטים לא חסום מאפשר להעמיס את התמחור בשאילתה ענקית.
const MAX_PAGE_SIZE = 200;
const MAX_ITEMS_PER_REQUEST = 500;

// מזהה שאינו ObjectId תקין מפוצץ את mongoose (new ObjectId זורק), ובלי
// הבדיקה כתובת שגויה מחזירה 500 עם stack trace במקום 400 ברור.
const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id || ""));

// בחירת התעודות להפקה. מזהה לא תקין נדחה מיד ואינו מסונן בשקט: סינון היה
// מפיק חשבונית על פחות תעודות ממה שסומן במסך, בלי שאיש ידע.
//
// מחזיר {error} ולא זורק — כדי שהקורא יחזיר 400 (בקשה שגויה) ולא 500,
// ששמור לתקלה בשרת.
const parseNoteIds = (raw) => {
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw)) return { error: "רשימת התעודות חייבת להיות מערך" };

  const list = raw.map((v) => String(v).trim()).filter(Boolean);

  // רשימה ריקה שנשלחה במפורש היא "לא נבחרה אף תעודה", ולא "קח הכל".
  // ההבדל הוא בין בקשה שנדחית לבין חיוב של כל התעודות הפתוחות של הלקוח.
  if (!list.length) return { error: "לא נבחרה אף תעודה להפקה" };

  if (list.length > MAX_ITEMS_PER_REQUEST) {
    return { error: `אפשר לבחור עד ${MAX_ITEMS_PER_REQUEST} תעודות בפעולה אחת` };
  }

  const bad = list.find((id) => !isValidId(id));
  if (bad) return { error: `מזהה תעודה לא תקין: ${bad}` };

  // כפילות ברשימה אינה מזיקה ($in מתעלם ממנה), אבל היא מעוותת את הספירה
  // שמוצגת בהודעה למשתמש
  return { noteIds: [...new Set(list)] };
};

const safePaging = ({ page, limit }) => {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(limit) || 50));
  return { page: p, limit: l, skip: (p - 1) * l };
};

// isAdmin (config/auth) מגדיר req.user ולא req.admin. admin.name יכול להיות
// אובייקט רב-לשוני ({he, en}) ולא מחרוזת, ולכן לא נשלף ישירות — "[object
// Object]" בשדה "מי הפיק" הוא גרוע יותר מ"אדמין".
const adminName = (req) => {
  const user = req.user;
  if (!user) return "אדמין";
  if (user.email) return user.email;
  if (typeof user.name === "string") return user.name;
  return user.name?.he || user.name?.en || "אדמין";
};

// ---------- תעודות משלוח ----------

const createDeliveryNote = async (req, res) => {
  try {
    const { note, created, pendingManual, reason } = await deliveryNotes.createFromOrder(
      req.params.orderId,
      { issuedBy: adminName(req) }
    );

    // הזמנה שכולה סחורה נשקלת — אין חלק אוטומטי להפיק, וזה מצב תקין.
    // 200 ולא 400: הבקשה הצליחה, פשוט אין תעודה אוטומטית, והמסך צריך
    // להפנות להקלדה ידנית ולא להציג שגיאה אדומה.
    if (!note && reason === "manualOnly") {
      return res.status(200).send({
        message:
          "כל שורות ההזמנה הן סחורה שנשקלת — יש להפיק תעודת משלוח ידנית עם המשקל בפועל",
        created: false,
        note: null,
        pendingManual,
        invoices: [],
      });
    }

    // לקוח במסלול perDelivery מחויב מיד. כאן ממתינים לתוצאה (בשונה
    // מהמסלול האוטומטי) כדי שהמסך יוכל להציג את מספר החשבונית שהופקה
    // ולא רק את מספר התעודה.
    let billed = null;
    if (created) {
      billed = await monthlyBilling.billNoteImmediately(note._id);
    }

    const invoiceNums = (billed?.invoices || []).map((i) => i.docNum).join(", ");
    const manualNote = pendingManual?.length
      ? ` · ${pendingManual.length} שורות נשקלות ממתינות לתעודה ידנית`
      : "";

    res.status(created ? 201 : 200).send({
      message:
        (!created
          ? `תעודת משלוח ${note.number} כבר קיימת להזמנה זו`
          : invoiceNums
            ? `תעודת משלוח ${note.number} נוצרה וחשבונית ${invoiceNums} הופקה`
            : `תעודת משלוח ${note.number} נוצרה`) + manualNote,
      created,
      // המסך צריך לרענן את התעודה כדי לראות את מצב החיוב המעודכן
      note: billed ? ledger.normalize(await DeliveryNote.findById(note._id).lean()) : note,
      pendingManual: pendingManual || [],
      invoices: billed?.invoices || [],
    });
  } catch (err) {
    res.status(400).send({ message: err.message });
  }
};

/**
 * הפקת תעודת משלוח ידנית — הסחורה שנשקלת.
 *
 * זו הנקודה שבה המשקל שנשקל בפועל נכנס למערכת. החשבונית החודשית נבנית
 * מהתעודות, ולכן מכאן והלאה החיוב הוא על מה שנשקל ולא על מה שהוזמן.
 */
const createManualDeliveryNote = async (req, res) => {
  try {
    const { customer, order, items, manualReference, issuedAt, notes, shippingCost, discount, idempotencyKey } =
      req.body || {};

    if (Array.isArray(items) && items.length > MAX_ITEMS_PER_REQUEST) {
      return res
        .status(400)
        .send({ message: `יותר מ-${MAX_ITEMS_PER_REQUEST} שורות בבקשה אחת` });
    }
    if (customer && !isValidId(customer)) {
      return res.status(400).send({ message: "מזהה לקוח לא תקין" });
    }
    if (order && !isValidId(order)) {
      return res.status(400).send({ message: "מזהה הזמנה לא תקין" });
    }

    const { note, created, quality } = await deliveryNotes.createManual({
      customerId: customer,
      orderId: order,
      items,
      manualReference,
      issuedAt,
      notes,
      shippingCost,
      discount,
      idempotencyKey,
      issuedBy: adminName(req),
    });

    // אותו מסלול כמו בתעודה האוטומטית: לקוח perDelivery מקבל חשבונית מיד
    let billed = null;
    if (created) {
      billed = await monthlyBilling.billNoteImmediately(note._id);
    }

    const invoiceNums = (billed?.invoices || []).map((i) => i.docNum).join(", ");

    res.status(created ? 201 : 200).send({
      message: !created
        ? `תעודת משלוח ${note.number} כבר הופקה`
        : invoiceNums
          ? `תעודת משלוח ידנית ${note.number} נוצרה וחשבונית ${invoiceNums} הופקה`
          : `תעודת משלוח ידנית ${note.number} נוצרה`,
      created,
      note: billed ? ledger.normalize(await DeliveryNote.findById(note._id).lean()) : note,
      quality,
      invoices: billed?.invoices || [],
    });
  } catch (err) {
    res.status(400).send({ message: err.message });
  }
};

/**
 * השורות הנשקלות של הזמנה שעדיין לא הוקלדו בתעודה ידנית.
 *
 * זה מה שממלא מראש את הטופס: המשקל שהוזמן מוצג ככמות התחלתית, והמשתמשת
 * מתקנת אותו למה שנשקל בפועל.
 */
const getPendingManualItems = async (req, res) => {
  try {
    if (!isValidId(req.params.orderId)) {
      return res.status(400).send({ message: "מזהה הזמנה לא תקין" });
    }
    res.send(await deliveryNotes.pendingManualItems(req.params.orderId));
  } catch (err) {
    res.status(400).send({ message: err.message });
  }
};

const getDeliveryNotes = async (req, res) => {
  try {
    const { status, month, customer, kind } = req.query;
    const { page, limit, skip } = safePaging(req.query);

    const query = {};
    // "פתוחה" בדמו אינה רק billing.demo.status === "open": תעודה שהדמו
    // מעולם לא נגע בה אין לה שדה כזה בכלל, והשוואה ישירה הייתה מסתירה
    // בדיוק את התעודות שממתינות לחיוב. "בוטלה" נשאר על הרישום האמיתי,
    // כי ביטול תעודה אינו פעולת חיוב.
    if (status === "open") Object.assign(query, ledger.openQuery());
    else if (status === "cancelled") query["billing.status"] = "cancelled";
    else if (status) query[ledger.f("status")] = status;
    if (month) query["billing.billingMonth"] = month;
    if (customer) query.customer = customer;
    // תעודות ישנות נוצרו לפני שהשדה קיים והן כולן אוטומטיות. סינון על
    // "auto" חייב לכלול גם אותן, אחרת המסך היה נראה ריק
    if (kind === "auto") query.kind = { $ne: "manual" };
    else if (kind === "manual") query.kind = "manual";

    const [notes, total] = await Promise.all([
      DeliveryNote.find(query).sort({ number: -1 }).skip(skip).limit(limit).lean(),
      DeliveryNote.countDocuments(query),
    ]);

    // המסך מקבל את מצב הכיס הפעיל תחת billing, ולכן אינו יודע דבר על דמו
    res.send({ notes: ledger.normalizeAll(notes), total, page, limit });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

const getDeliveryNote = async (req, res) => {
  try {
    const note = ledger.normalize(await DeliveryNote.findById(req.params.id).lean());
    if (!note) return res.status(404).send({ message: "תעודה לא נמצאה" });
    // totals מחושב בשרת ולא בדפדפן, כדי שלא יהיו שני חישובי מע"מ שיכולים
    // להיפרד. המסמך המודפס רק מציג את מה שמגיע מכאן.
    res.send({ ...note, totals: calculateVat(note) });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

/**
 * התעודות של הזמנה מסוימת.
 *
 * קיים כדי שמסך ההזמנה לא יצטרך לשלוף רשימת תעודות ולסנן בצד הלקוח —
 * פתרון שנשבר בשקט ברגע שמספר התעודות עובר את גודל העמוד.
 *
 * להזמנה יכולות להיות כמה תעודות: אחת אוטומטית על מה שנמכר ביחידות, ועוד
 * אחת או יותר ידניות על הסחורה שנשקלה. השדה `note` נשאר ומצביע על
 * האוטומטית, כדי שקוד קיים שקורא אותו לא ישבר.
 */
const getDeliveryNoteByOrder = async (req, res) => {
  try {
    // בלי הבדיקה מזהה פגום מפיל את mongoose ב-CastError ומחזיר 500 עם
    // stack trace, במקום תשובה ברורה
    if (!isValidId(req.params.orderId)) {
      return res.status(400).send({ message: "מזהה הזמנה לא תקין" });
    }

    const notes = ledger.normalizeAll(
      await DeliveryNote.find({ order: req.params.orderId }).sort({ number: 1 }).lean()
    );

    // 200 עם null ולא 404: "אין תעודה" הוא מצב תקין ולא שגיאה, והמסך
    // צריך להבדיל בינו לבין כשלון בקריאה
    res.send({
      note: notes.find((n) => n.kind !== "manual") || null,
      notes,
      manualNotes: notes.filter((n) => n.kind === "manual"),
    });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

/**
 * רשימת החשבוניות שהופקו, עם מצב התשלום ומועד הפירעון.
 * זה המסך של "מי חייב לי כסף" ושל רישום תשלומים.
 */
const getInvoices = async (req, res) => {
  try {
    const { status, customer } = req.query;
    const { isConfirmed } = require("../lib/billing/paymentTerms");

    res.send({
      invoices: await listInvoices({ customerId: customer, status }),
      // המסך חייב לדעת שמועדי הפירעון מבוססים על מיפוי שטרם אושר,
      // אחרת ירדפו אחרי כסף בתאריך שגוי
      termsConfirmed: isConfirmed(),
    });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

const cancelDeliveryNote = async (req, res) => {
  try {
    const note = await deliveryNotes.cancel(req.params.id, req.body?.reason);
    res.send({ message: `תעודה ${note.number} בוטלה`, note });
  } catch (err) {
    res.status(400).send({ message: err.message });
  }
};

// ---------- סגירת חודש ----------

/**
 * תצוגה מקדימה: מה ייווצר אם נסגור את החודש. לא מפיק כלום.
 * זה המסך שהלקוחה אמורה לראות לפני שהיא לוחצת על ההפקה.
 */
const previewMonth = async (req, res) => {
  try {
    // מזהה שאינו ObjectId מגיע ל-mongoose וזורק CastError — 500 עם stack
    // trace במקום הסבר. הבדיקה כאן הופכת אותו ל-400 מובן.
    if (req.query.customer && !isValidId(req.query.customer)) {
      return res.status(400).send({ message: "מזהה לקוח לא תקין" });
    }

    const result = await monthlyBilling.closeMonth({
      month: req.query.month,
      customerId: req.query.customer,
      dryRun: true,
    });
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

/**
 * הלקוחות שיש להם תעודות פתוחות בחודש — למילוי בורר הלקוח במסך.
 */
const openCustomers = async (req, res) => {
  try {
    res.send(await monthlyBilling.openCustomers({ month: req.query.month }));
  } catch (err) {
    // חודש בפורמט שגוי הוא בקשה פסולה, לא תקלת שרת
    res.status(/חודש לא תקין/.test(err.message) ? 400 : 500).send({ message: err.message });
  }
};

/**
 * ההודעה שמוצגת אחרי ההפקה.
 *
 * שלושה מצבים שונים, ואסור שיישמעו אותו דבר:
 *   - לא הופק כלום. קורה כשמישהו אחר חייב את אותן תעודות בין התצוגה
 *     המקדימה ללחיצה, או כשאין תעודות פתוחות. "0 חשבוניות הופקו" בנוסח
 *     של הצלחה נקרא כמו תקלה.
 *   - הפקה על תעודות שנבחרו. "חודש 2026-08 נסגר" על שתי תעודות באמצע
 *     החודש הוא פשוט לא נכון, ומי שקורא יחשוב שהחודש טופל.
 *   - סגירת חודש מלאה.
 */
const closeMessage = (result, noteIds) => {
  if (!result.invoicesCreated) {
    return noteIds
      ? "לא הופקה אף חשבונית — התעודות שנבחרו כבר חויבו או שאינן פתוחות"
      : `אין תעודות פתוחות לחיוב בחודש ${result.month}`;
  }

  if (result.selectionUsed) {
    const rest = result.remainingOpen
      ? `. ${result.remainingOpen} תעודות נשארו פתוחות ויחויבו בסגירת החודש`
      : "";
    return `הופקו ${result.invoicesCreated} חשבוניות על ${noteIds.length} תעודות שנבחרו${rest}`;
  }

  return `חודש ${result.month} נסגר — ${result.invoicesCreated} חשבוניות ל-${result.customersProcessed} לקוחות`;
};

/**
 * סגירת חודש בפועל — מפיק חשבוניות מס ב-iCount.
 *
 * דורש confirm:true בגוף הבקשה. חשבונית מס אינה ניתנת לביטול אלא בזיכוי,
 * ובקשה שנשלחה בטעות (רענון דף, לחיצה כפולה) לא צריכה להיות מספיקה.
 */
const closeMonth = async (req, res) => {
  try {
    if (req.body?.confirm !== true) {
      return res.status(400).send({
        message:
          "סגירת חודש מפיקה חשבוניות מס שלא ניתן למחוק. יש לשלוח confirm:true לאישור.",
      });
    }

    if (req.body.customer && !isValidId(req.body.customer)) {
      return res.status(400).send({ message: "מזהה לקוח לא תקין" });
    }

    // כל הולידציות לפני releaseStuckClaims: בקשה פסולה לא צריכה לגעת במסד.
    const { noteIds, error } = parseNoteIds(req.body.notes);
    if (error) return res.status(400).send({ message: error });
    if (noteIds && !req.body.customer) {
      return res
        .status(400)
        .send({ message: "בחירת תעודות ספציפיות אפשרית רק כשנבחר לקוח בודד" });
    }

    // תעודות שנתקעו מריצה קודמת שקרסה — משחררים לפני שמתחילים, אחרת הן
    // לא ייכללו בחיוב וייפלו בין הכסאות.
    await monthlyBilling.releaseStuckClaims();

    const result = await monthlyBilling.closeMonth({
      month: req.body.month,
      customerId: req.body.customer,
      noteIds,
      // רק בוליאני מפורש מהבקשה גובר על המדיניות. body בלי השדה חייב
      // להישאר undefined ולא false — אחרת כל לחיצה במסך הייתה מבטלת בשקט
      // את השליחה האוטומטית ללקוח.
      emailDocument:
        typeof req.body.emailDocument === "boolean" ? req.body.emailDocument : undefined,
    });

    res.send({ message: closeMessage(result, noteIds), ...result });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

// ---------- זיכוי ----------

const creditInvoice = async (req, res) => {
  try {
    const { icountDocNum, reason, reopenNotes = true } = req.body || {};
    if (!icountDocNum) {
      return res.status(400).send({ message: "חסר מספר החשבונית לזיכוי" });
    }
    if (!reason) {
      // הסיבה מודפסת על המסמך ונדרשת להסבר מול רואה החשבון
      return res.status(400).send({ message: "חובה לציין סיבת זיכוי" });
    }

    const result = await monthlyBilling.creditInvoice({ icountDocNum, reason, reopenNotes });
    res.send({
      message: `חשבונית זיכוי ${result.creditDocNum} הופקה בגין חשבונית ${icountDocNum}`,
      ...result,
    });
  } catch (err) {
    res.status(400).send({ message: err.message });
  }
};

// ---------- קבלה ----------

const createReceiptForPayment = async (req, res) => {
  try {
    const { customer, amount, method, forInvoices, details, emailDocument } = req.body || {};
    if (!customer) return res.status(400).send({ message: "חסר מזהה לקוח" });

    const invoices = Array.isArray(forInvoices) ? forInvoices.filter(Boolean) : [];

    // קבלה כפולה על אותה חשבונית היא מסמך מס מיותר שאי אפשר למחוק, והיא
    // גם מציגה את הלקוח כמי ששילם פעמיים. הבדיקה היא על התעודות שלנו כי
    // הן המקום היחיד שבו רשום שהתשלום כבר התקבל.
    //
    // זו הגנה מפני לחיצה כפולה ומפני שני משתמשים במקביל, לא נעילה מלאה:
    // חלון של מילישניות בין הבדיקה להפקה נשאר. נעילה אמיתית הייתה דורשת
    // ישות "חשבונית" משלנו, ובנקודה הזו העלות גדולה מהסיכון.
    if (invoices.length) {
      const alreadyPaid = await DeliveryNote.findOne({
        customer,
        [ledger.f("icountDocNum")]: { $in: invoices },
        [ledger.f("paidAt")]: { $ne: null },
      })
        .select("billing")
        .lean();

      if (alreadyPaid) {
        const paid = ledger.of(alreadyPaid);
        return res.status(409).send({
          message:
            `כבר נרשם תשלום לחשבונית ${paid.icountDocNum}` +
            (paid.receiptDocNum
              ? ` (קבלה ${paid.receiptDocNum})`
              : "") +
            ". לתשלום נוסף יש להפיק קבלה ידנית ב-iCount.",
        });
      }
    }

    const doc = await createReceipt({
      customerId: customer,
      amount: Number(amount),
      method,
      forInvoices: invoices,
      details: details || {},
      emailDocument: typeof emailDocument === "boolean" ? emailDocument : undefined,
    });

    // סימון התעודות של אותן חשבוניות כמשולמות. בלי זה החשבונית הייתה
    // ממשיכה להופיע כחוב בדוח הגבייה גם אחרי שהכסף התקבל.
    //
    // אחרי ההפקה ולא לפניה: הקבלה כבר קיימת ב-iCount ואי אפשר לבטלה,
    // ולכן סימון מוקדם היה יוצר "שולם" על קבלה שלא נוצרה. כשלון בסימון
    // אינו מפיל את התשובה — הקבלה תקינה — אבל נרשם ללוג.
    let marked = 0;
    if (invoices.length) {
      try {
        const upd = await DeliveryNote.updateMany(
          {
            customer,
            [ledger.f("icountDocNum")]: { $in: invoices },
            [ledger.f("status")]: "billed",
          },
          {
            $set: {
              [ledger.f("receiptDocNum")]: doc.docNum,
              [ledger.f("receiptDocUrl")]: doc.url || null,
              [ledger.f("receiptEmailedTo")]: doc.emailedTo || null,
              [ledger.f("paidAt")]: new Date(),
            },
          }
        );
        marked = upd.modifiedCount;
      } catch (markErr) {
        console.error(
          `[billing] קבלה ${doc.docNum} הופקה אך סימון התשלום נכשל: ${markErr.message}\n` +
            `          חשבוניות: ${invoices.join(", ")} — יש לסמן ידנית`
        );
      }
    }

    res.send({
      message: `קבלה ${doc.docNum} הופקה${marked ? ` · ${marked} תעודות סומנו כמשולמות` : ""}`,
      notesMarkedPaid: marked,
      ...doc,
    });
  } catch (err) {
    res.status(400).send({ message: err.message });
  }
};

/**
 * כל הקבלות שהופקו דרך המערכת, לפי טווח תאריכי תשלום ולקוח.
 *
 * הרשימה נבנית מהתעודות שסומנו כמשולמות (lib/billing/receipts), ולכן
 * הסכום שבה הוא אומדן וקבלה שהופקה ידנית ב-iCount לא תופיע. המסך אומר
 * את זה במפורש כדי שלא ישמש להתאמת בנק.
 */
const getReceipts = async (req, res) => {
  try {
    const { customer, from, to } = req.query;

    // מזהה פסול היה מפוצץ את השאילתה ב-CastError ומחזיר 500 סתמי
    if (customer && !isValidId(customer)) {
      return res.status(400).send({ message: "מזהה לקוח לא תקין" });
    }
    // תאריך פסול לא נבלע בשקט: סינון שלא סונן מציג רשימה מלאה שנראית
    // כמו התוצאה של הטווח שנבחר
    for (const [label, value] of [["ההתחלה", from], ["הסיום", to]]) {
      if (value && !isDayString(value)) {
        return res
          .status(400)
          .send({ message: `תאריך ${label} אינו תקין (נדרש YYYY-MM-DD)` });
      }
    }
    if (isDayString(from) && isDayString(to) && from > to) {
      return res.status(400).send({ message: "תאריך הסיום מוקדם מתאריך ההתחלה" });
    }

    res.send({ receipts: await listReceipts({ customerId: customer, from, to }) });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

// ---------- הצעות מחיר ----------

/**
 * תמחור מקדים — מה יעלו הפריטים ללקוח הזה, לפני שמפיקים משהו.
 * זה מה שמאפשר למסך להציג מחירים תוך כדי בניית ההצעה.
 */
const priceItems = async (req, res) => {
  try {
    const { customer, items } = req.body || {};
    if (!customer) return res.status(400).send({ message: "חסר מזהה לקוח" });
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).send({ message: "חסרים פריטים" });
    }
    if (items.length > MAX_ITEMS_PER_REQUEST) {
      return res.status(400).send({
        message: `יותר מדי פריטים בבקשה (${items.length}). המקסימום הוא ${MAX_ITEMS_PER_REQUEST}`,
      });
    }

    const priced = await priceItemsForCustomer(customer, items);
    res.send({ items: priced, quality: priceQuality(priced) });
  } catch (err) {
    res.status(400).send({ message: err.message });
  }
};

const createQuote = async (req, res) => {
  try {
    const { customer, items, validDays, discount, notes } = req.body || {};
    if (!customer) return res.status(400).send({ message: "חסר מזהה לקוח" });
    if (Array.isArray(items) && items.length > MAX_ITEMS_PER_REQUEST) {
      return res.status(400).send({
        message: `יותר מדי פריטים בהצעה (${items.length}). המקסימום הוא ${MAX_ITEMS_PER_REQUEST}`,
      });
    }

    const result = await quotes.create({
      customerId: customer,
      items,
      validDays: Number(validDays) || 30,
      discount: Number(discount) || 0,
      notes,
      createdBy: adminName(req),
    });

    res.status(201).send({
      message: `הצעת מחיר ${result.quote.number} הופקה`,
      ...result,
    });
  } catch (err) {
    res.status(400).send({ message: err.message });
  }
};

const getQuotes = async (req, res) => {
  try {
    const { status, customer } = req.query;
    const { page, limit, skip } = safePaging(req.query);

    const query = {};
    if (status) query.status = status;
    if (customer) query.customer = customer;

    const [list, total] = await Promise.all([
      Quote.find(query).sort({ number: -1 }).skip(skip).limit(limit).lean(),
      Quote.countDocuments(query),
    ]);

    res.send({ quotes: list, total, page, limit });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

const getQuote = async (req, res) => {
  try {
    const quote = await Quote.findById(req.params.id).lean();
    if (!quote) return res.status(404).send({ message: "הצעת מחיר לא נמצאה" });
    res.send({ ...quote, totals: calculateVat(quote) });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

const acceptQuote = async (req, res) => {
  try {
    const quote = await quotes.accept(req.params.id, { orderId: req.body?.orderId });
    res.send({ message: `הצעה ${quote.number} סומנה כמאושרת`, quote });
  } catch (err) {
    res.status(400).send({ message: err.message });
  }
};

const rejectQuote = async (req, res) => {
  try {
    const quote = await quotes.reject(req.params.id, req.body?.reason);
    res.send({ message: `הצעה ${quote.number} סומנה כנדחתה`, quote });
  } catch (err) {
    res.status(400).send({ message: err.message });
  }
};

// ---------- כללי ----------

/**
 * חשבוניות של לקוח — הבסיס למסך "מה הלקוח חייב" בכרטיס הלקוח.
 */
const getCustomerOpenInvoices = async (req, res) => {
  try {
    const invoices = await listInvoices({ customerId: req.params.customerId });
    res.send({ invoices });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

/**
 * כל המסמכים של לקוח במקום אחד: תעודות משלוח, חשבוניות והצעות מחיר.
 *
 * מאוחד בקריאה אחת ולא שלוש: כרטיס הלקוח נטען פעם אחת, ושלוש קריאות
 * מקבילות רק היו מאיטות אותו בלי להוסיף דבר.
 *
 * הכל מוחזר בלי הגבלה — לקוח ותיק צובר מאות תעודות ורוצים לראות את
 * כולן. כדי שזה לא ינפח את הבקשה, מערך השורות עצמו לא נשלח: הוא נחוץ
 * רק כדי להציג "16 שורות", ולכן נספר בשרת ב-$size. תעודה ממוצעת היא
 * עשרות שורות, ומאות תעודות עם השורות שלהן היו מגיעות למגה-בייטים.
 */
const getCustomerDocuments = async (req, res) => {
  try {
    const { customerId } = req.params;
    if (!isValidId(customerId)) {
      return res.status(400).send({ message: "מזהה לקוח לא תקין" });
    }

    const [notes, openNotes, quoteList, invoices, receiptList, customer] = await Promise.all([
      DeliveryNote.aggregate([
        // ההמרה לכיס הפעיל נעשית אחרי השליפה (ledger.normalizeAll למטה) —
        // בלעדיה כרטיס הלקוח היה המסך היחיד שמציג את הרישום האמיתי בזמן
        // שכל השאר מציגים דמו
        { $match: { customer: new mongoose.Types.ObjectId(String(customerId)) } },
        { $sort: { number: -1 } },
        {
          $project: {
            number: 1,
            issuedAt: 1,
            total: 1,
            billing: 1,
            // כרטיס הלקוח צריך להבדיל בין תעודה מהזמנה לתעודת משקל ידנית —
            // בלי זה שתי תעודות לאותו יום נראות כמו כפילות
            kind: 1,
            manualReference: 1,
            itemCount: { $size: { $ifNull: ["$items", []] } },
          },
        },
      ]),
      DeliveryNote.countDocuments({ customer: customerId, ...ledger.openQuery() }),
      Quote.aggregate([
        { $match: { customer: new mongoose.Types.ObjectId(String(customerId)) } },
        { $sort: { number: -1 } },
        {
          $project: {
            number: 1,
            createdAt: 1,
            total: 1,
            status: 1,
            validUntil: 1,
            itemCount: { $size: { $ifNull: ["$items", []] } },
          },
        },
      ]),
      listInvoices({ customerId }),
      // הקבלות של הלקוח. אותה פונקציה שמזינה את מסך הקבלות — כדי שכרטיס
      // הלקוח לא יחשב "מה שולם" בדרך משלו ויסתור את המסך המלא
      listReceipts({ customerId }),
      // רק השם, לכותרת מסך "מסמכי לקוח". נשלף כאן ולא בקריאה נפרדת
      // לכרטיס הלקוח: זו שאילתה אחת על המפתח הראשי, בתוך אותו Promise.all,
      // והיא חוסכת מהדפדפן למשוך את מסמך הלקוח המלא (שכולל גם את הסיסמה)
      // רק כדי להציג שם
      Customer.findById(customerId).select("name lastName").lean(),
    ]);

    res.send({
      // null כשהמזהה תקין אבל אין לקוח כזה — המסך מבדיל בין "לקוח בלי
      // מסמכים" לבין "לקוח שלא קיים", שנראים אחרת לגמרי למי שמסתכל
      customer: customer
        ? { _id: customer._id, name: customer.name, lastName: customer.lastName }
        : null,
      deliveryNotes: {
        items: ledger.normalizeAll(notes),
        total: notes.length,
        open: openNotes,
      },
      invoices: {
        items: invoices,
        total: invoices.length,
        unpaid: invoices.filter((i) => !i.isPaid).length,
        overdue: invoices.filter((i) => i.isOverdue).length,
        owed: Number(
          invoices.filter((i) => !i.isPaid).reduce((s, i) => s + i.grossEstimate, 0).toFixed(2)
        ),
      },
      receipts: {
        items: receiptList,
        total: receiptList.length,
        // אומדן ולא סכום מחייב, כמו בכל מקום שבו הסכום מחושב מהתעודות
        // ולא נקרא מהמסמך עצמו
        paidEstimate: Number(
          receiptList.reduce((s, r) => s + r.grossEstimate, 0).toFixed(2)
        ),
      },
      quotes: {
        items: quoteList,
        total: quoteList.length,
        open: quoteList.filter((q) => q.status === "open").length,
      },
    });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

/**
 * הסכום האמיתי של חשבונית, מ-iCount.
 *
 * הרשימה מציגה אומדן שמחושב מהתעודות שלנו. לפני רישום תשלום צריך את
 * המספר המחייב — הוא זה שהלקוח משלם, והוא זה שרואה החשבון יראה. קריאה
 * אחת ל-iCount ברגע שפותחים את הדיאלוג, ולא בטעינת כל הרשימה.
 */
const getInvoiceTotal = async (req, res) => {
  try {
    const doc = await getDocument(DOC_TYPES.INVOICE, req.params.docnum);
    const total = Number(doc.totalwithvat ?? doc.doc_total ?? 0);

    res.send({
      docNum: req.params.docnum,
      totalWithVat: total,
      totalBeforeVat: Number(doc.totalsum ?? 0),
      vat: Number(doc.totalvat ?? 0),
      // paid/remaining מאפשרים לזהות תשלום חלקי קודם שנרשם ישירות ב-iCount
      remaining: doc.remaining !== undefined ? Number(doc.remaining) : null,
    });
  } catch (err) {
    // אי אפשר להגיע ל-iCount — לא חוסמים את רישום התשלום, המסך ייפול
    // לאומדן ויציין זאת
    res.status(502).send({ message: err.message });
  }
};

/** מסמך מ-iCount לפי סוג ומספר — לתצוגה באדמין. */
const getIcountDocument = async (req, res) => {
  try {
    const { doctype, docnum } = req.params;
    if (!Object.values(DOC_TYPES).includes(doctype)) {
      return res.status(400).send({ message: `סוג מסמך לא נתמך: ${doctype}` });
    }
    res.send(await getDocument(doctype, docnum));
  } catch (err) {
    res.status(404).send({ message: err.message });
  }
};

/** סנכרון כרטיס לקוח בודד ל-iCount. */
const syncCustomerToIcount = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.customerId).select("+erp").lean();
    if (!customer) return res.status(404).send({ message: "לקוח לא נמצא" });

    const { clientId, action } = await syncCustomer(customer);
    res.send({
      message: action === "created" ? "כרטיס הלקוח נוצר ב-iCount" : "כרטיס הלקוח עודכן ב-iCount",
      clientId,
      action,
    });
  } catch (err) {
    res.status(400).send({ message: err.message });
  }
};

/**
 * המצב הפעיל בלבד — בלי לגעת ב-iCount.
 *
 * icountStatus מתחבר מחדש בכל קריאה (ping מאפס את ה-session בכוונה, כדי
 * שהתשובה תהיה בדיקה אמיתית). הבאנר "מצב דמו" יושב על ארבעה מסכים, ואם
 * הוא היה קורא לשם — כל טעינת מסך חיוב הייתה התחברות נוספת ל-iCount,
 * ותקלת רשת אצלם הייתה תולה את המסך עד 30 שניות על שורת אזהרה.
 *
 * ה-cid מגיע מהסביבה ולא מ-iCount, ולכן אין כאן שום קריאה יוצאת.
 */
const icountMode = async (req, res) => {
  try {
    const demo = isDemoMode();
    res.send({
      mode: modeLabel(),
      demo,
      cid: (demo ? process.env.ICOUNT_DEMO_CID : process.env.ICOUNT_CID) || null,
      // מסך סגירת החודש מאתחל ממנו את תיבת "לשלוח במייל", ולכן הוא חייב
      // להופיע כאן בדיוק כמו ב-icountStatus. בדמו התשובה היא תמיד false —
      // baseDoc לא ישלח בשום מקרה, ותיבה מסומנת הייתה משקרת.
      emailDocuments: demo ? false : autoEmailEnabled(),
    });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

/** בדיקת חיבור ל-iCount — למסך ההגדרות באדמין. */
const icountStatus = async (req, res) => {
  // מדיניות השליחה במייל (BILLING_EMAIL_DOCUMENTS) חוזרת בשני המסלולים:
  // המסכים מציגים לפיה את מצב ההתחלה של תיבת "שלח ללקוח", ותיבה שמנחשת
  // "כן" בזמן שהמדיניות כבויה הייתה מדליקה שליחה שמישהו כיבה בכוונה.
  // בדמו baseDoc חוסם שליחה בכל מקרה, ולכן "המדיניות פעילה" הוא דיווח
  // שקרי — המסך היה מסמן תיבת שליחה על מסמכים שלא יישלחו
  const emailDocuments = isDemoMode() ? false : autoEmailEnabled();

  try {
    res.send({ connected: true, emailDocuments, ...(await ping()) });
  } catch (err) {
    // גם כשהחיבור נכשל הממשק חייב לדעת באיזה מצב הוא. אחרת מסך שלא הצליח
    // להתחבר ייראה זהה בדמו ובאמת, וזו הטעות היקרה מכולן.
    res.status(503).send({
      connected: false,
      emailDocuments,
      mode: modeLabel(),
      demo: isDemoMode(),
      message: err.message,
    });
  }
};

// --- מסך הדמו ---
//
// כל המסלולים כאן נופלים ב-409 כשהמערכת מחוברת לחשבון האמיתי (assertDemo
// בתוך lib/billing/demo). 409 ולא 400: הבקשה תקינה, המצב הוא שאינו מתאים.

const demoError = (res, err) =>
  res.status(/רק כש-ICOUNT_MODE=demo/.test(err.message) ? 409 : 400).send({
    message: err.message,
    demo: isDemoMode(),
  });

/** רשימות למילוי הטפסים במסך הדמו. */
const demoOptions = async (req, res) => {
  try {
    const [{ customers, total }, notes] = await Promise.all([
      demo.listDemoCustomers(),
      demo.listDemoSources(),
    ]);
    res.send({
      demo: isDemoMode(),
      customers,
      deliveryNotes: notes,
      sampleItems: demo.SAMPLE_ITEMS,
      // כמה לקוחות באמת קיימים. כשהמספר גדול מאורך הרשימה המסך מציין
      // זאת, במקום להציג רשימה חלקית כאילו היא מלאה
      customersTotal: total,
    });
  } catch (err) {
    demoError(res, err);
  }
};

/** הפקת חשבונית הדגמה. */
const createDemoInvoice = async (req, res) => {
  try {
    const { deliveryNoteId, customerId } = req.body || {};
    if (deliveryNoteId && !isValidId(deliveryNoteId)) {
      return res.status(400).send({ message: "מזהה תעודת משלוח אינו תקין" });
    }
    if (customerId && !isValidId(customerId)) {
      return res.status(400).send({ message: "מזהה לקוח אינו תקין" });
    }
    res.send(await demo.issueDemoInvoice({ deliveryNoteId, customerId }));
  } catch (err) {
    demoError(res, err);
  }
};

/** הסכומים כפי ש-iCount מחזיר אותם, לצד האומדן שלנו. */
const getDemoTotal = async (req, res) => {
  try {
    res.send(await demo.fetchDemoTotal(req.params.docnum));
  } catch (err) {
    demoError(res, err);
  }
};

/** זיכוי חשבונית הדגמה. */
const createDemoCredit = async (req, res) => {
  try {
    const { docNum, reason } = req.body || {};
    if (!docNum) return res.status(400).send({ message: "חסר מספר חשבונית לזיכוי" });
    res.send(await demo.issueDemoCredit({ docNum, reason }));
  } catch (err) {
    demoError(res, err);
  }
};

/** קבלה על חשבונית הדגמה. */
const createDemoReceipt = async (req, res) => {
  try {
    const { docNum, method, amount } = req.body || {};
    if (!docNum) return res.status(400).send({ message: "חסר מספר חשבונית לקבלה" });
    res.send(await demo.issueDemoReceipt({ docNum, method, amount }));
  } catch (err) {
    demoError(res, err);
  }
};

module.exports = {
  createDeliveryNote,
  createManualDeliveryNote,
  getPendingManualItems,
  getDeliveryNotes,
  getDeliveryNote,
  getDeliveryNoteByOrder,
  getInvoices,
  getInvoiceTotal,
  cancelDeliveryNote,
  previewMonth,
  openCustomers,
  closeMonth,
  creditInvoice,
  createReceiptForPayment,
  getReceipts,
  priceItems,
  createQuote,
  getQuotes,
  getQuote,
  acceptQuote,
  rejectQuote,
  getCustomerOpenInvoices,
  getCustomerDocuments,
  icountMode,
  demoOptions,
  createDemoInvoice,
  createDemoCredit,
  createDemoReceipt,
  getDemoTotal,
  getIcountDocument,
  syncCustomerToIcount,
  icountStatus,
};

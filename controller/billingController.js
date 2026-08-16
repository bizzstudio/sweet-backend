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
const { calculateVat } = require("../lib/billing/vat");
const { createReceipt, getDocument, DOC_TYPES } = require("../lib/icount/documents");
const { syncCustomer } = require("../lib/icount/clients");
const { ping } = require("../lib/icount/client");

// תקרות על קלט מהרשת. limit לא חסום מאפשר לבקשה אחת לשלוף את כל
// הקולקציה, ומערך פריטים לא חסום מאפשר להעמיס את התמחור בשאילתה ענקית.
const MAX_PAGE_SIZE = 200;
const MAX_ITEMS_PER_REQUEST = 500;

// מזהה שאינו ObjectId תקין מפוצץ את mongoose (new ObjectId זורק), ובלי
// הבדיקה כתובת שגויה מחזירה 500 עם stack trace במקום 400 ברור.
const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id || ""));

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
      note: billed ? await DeliveryNote.findById(note._id).lean() : note,
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
      note: billed ? await DeliveryNote.findById(note._id).lean() : note,
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
    if (status) query["billing.status"] = status;
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

    res.send({ notes, total, page, limit });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

const getDeliveryNote = async (req, res) => {
  try {
    const note = await DeliveryNote.findById(req.params.id).lean();
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

    const notes = await DeliveryNote.find({ order: req.params.orderId })
      .sort({ number: 1 })
      .lean();

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

    // תעודות שנתקעו מריצה קודמת שקרסה — משחררים לפני שמתחילים, אחרת הן
    // לא ייכללו בחיוב וייפלו בין הכסאות.
    await monthlyBilling.releaseStuckClaims();

    const result = await monthlyBilling.closeMonth({
      month: req.body.month,
      customerId: req.body.customer,
      emailDocument: req.body.emailDocument === true,
    });

    res.send({
      message: `חודש ${result.month} נסגר — ${result.invoicesCreated} חשבוניות ל-${result.customersProcessed} לקוחות`,
      ...result,
    });
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
        "billing.icountDocNum": { $in: invoices },
        "billing.paidAt": { $ne: null },
      })
        .select("billing.icountDocNum billing.receiptDocNum")
        .lean();

      if (alreadyPaid) {
        return res.status(409).send({
          message:
            `כבר נרשם תשלום לחשבונית ${alreadyPaid.billing.icountDocNum}` +
            (alreadyPaid.billing.receiptDocNum
              ? ` (קבלה ${alreadyPaid.billing.receiptDocNum})`
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
      emailDocument: emailDocument === true,
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
          { customer, "billing.icountDocNum": { $in: invoices }, "billing.status": "billed" },
          {
            $set: {
              "billing.receiptDocNum": doc.docNum,
              "billing.receiptDocUrl": doc.url || null,
              "billing.paidAt": new Date(),
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

    const [notes, openNotes, quoteList, invoices, customer] = await Promise.all([
      DeliveryNote.aggregate([
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
      DeliveryNote.countDocuments({ customer: customerId, "billing.status": "open" }),
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
        items: notes,
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

/** בדיקת חיבור ל-iCount — למסך ההגדרות באדמין. */
const icountStatus = async (req, res) => {
  try {
    res.send({ connected: true, ...(await ping()) });
  } catch (err) {
    res.status(503).send({ connected: false, message: err.message });
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
  closeMonth,
  creditInvoice,
  createReceiptForPayment,
  priceItems,
  createQuote,
  getQuotes,
  getQuote,
  acceptQuote,
  rejectQuote,
  getCustomerOpenInvoices,
  getCustomerDocuments,
  getIcountDocument,
  syncCustomerToIcount,
  icountStatus,
};

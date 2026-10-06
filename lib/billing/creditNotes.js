// lib/billing/creditNotes.js
//
// תעודת משלוח זיכוי, וחשבונית הזיכוי שמופקת ממנה.
//
// שני מסמכים, מסלול אחד:
//
//   תעודת משלוח זיכוי — נבנית ומודפסת אצלנו (models/CreditNote). היא מה
//                        שהנהג מחתים כשסחורה חוזרת, ואינה מסמך מס.
//   חשבונית זיכוי      — מסמך המס ב-iCount (doctype refund), שנבנה מהתעודה.
//
// "חשבונית זיכוי חדשה" במסך היא שני השלבים ברצף: התעודה נשמרת, ומיד
// מופקת ממנה החשבונית. אין מסלול שמפיק חשבונית זיכוי בלי תעודה מאחוריה —
// כמו שאין חשבונית בלי תעודת משלוח — כי התעודה היא הרישום היחיד שלנו של
// מה זוכה ולמה.
//
// זה אינו ביטול חשבונית. ביטול מלא (זיכוי על כל החשבונית, והחזרת התעודות
// שלה למצב פתוח) נשאר ב-monthlyBilling.creditInvoice. כאן מזכים סכום או
// סחורה מסוימים, והתעודות של החשבונית המקורית אינן משתנות.

const crypto = require("crypto");
const mongoose = require("mongoose");
const Counter = require("../../models/Counter");
const CreditNote = require("../../models/CreditNote");
const DeliveryNote = require("../../models/DeliveryNote");
const Customer = require("../../models/Customer");
const { createCreditNote } = require("../icount/documents");
const { isDemoMode } = require("../icount/mode");
const deliveryNotes = require("./deliveryNotes");
const { discountPercentFor, discountAmount } = require("./pricing");
const { contactPhoneOf } = require("./contactPhone");
const { addressOf } = require("./customerAddress");
const { calculateVat } = require("./vat");
const ledger = require("./ledger");

const COUNTER_ID = "credit_note";
// סדרה משלה, רחוקה מתעודות המשלוח (1000) ומהצעות המחיר (5000), כדי
// שמספר על נייר יזהה את סוג המסמך
const FIRST_NUMBER = 9000;

const MAX_REASON_CHARS = 300;
const MAX_NAME_CHARS = 200;
const MAX_NOTES_CHARS = 1000;
// סטייה מותרת בין אומדן הברוטו שלנו לסכום שב-iCount (עיגולי מע"מ)
const OVER_CREDIT_TOLERANCE = 1;
const MAX_IDEMPOTENCY_KEY = 200;

const money = (n) => Number((Number(n) || 0).toFixed(2));

/** מספר רץ לתעודות הזיכוי. אותו מנגנון אטומי כמו בהצעות המחיר. */
const nextNumber = async () => {
  const existing = await Counter.findById(COUNTER_ID).select("_id").lean();
  if (!existing) {
    const highest = await CreditNote.findOne().sort({ number: -1 }).select("number").lean();
    await Counter.updateOne(
      { _id: COUNTER_ID },
      { $setOnInsert: { seq: Math.max(highest?.number || 0, FIRST_NUMBER - 1) } },
      { upsert: true }
    ).catch((err) => {
      if (err.code !== 11000) throw err;
    });
  }

  const counter = await Counter.findByIdAndUpdate(
    COUNTER_ID,
    { $inc: { seq: 1 } },
    { new: true }
  );
  if (!counter) throw new Error("הקצאת מספר תעודת זיכוי נכשלה");
  return counter.seq;
};

const hasValue = (v) => v !== undefined && v !== null && v !== "";

/**
 * בניית השורות והסכומים של זיכוי — בלי לשמור דבר.
 *
 * משותף לתצוגה המקדימה ולהפקה, כדי שהסכום שעל המסך יהיה הסכום שעל המסמך.
 *
 * שני סוגי שורות:
 *   - מוצר מהקטלוג ({sku, quantity, unitPrice?}) — מתומחר כמו בתעודת משלוח:
 *     מחירון הלקוח, אחריו מחיר הקטלוג, ומחיר שהוקלד גובר על שניהם.
 *   - שורה חופשית ({name, quantity, unitPrice}) — "הפרש מחיר", "פיצוי על
 *     איחור". אין לה מק"ט, ולכן המחיר חובה.
 *
 * @param {boolean} [p.requirePrice=true] - לחסום מוצר שלא נמצא לו מחיר.
 *        התצוגה המקדימה מעבירה false כדי להציג את השורה ולבקש מחיר
 */
const build = async ({
  customerId,
  items,
  discount = 0,
  applyCustomerDiscount = true,
  requirePrice = true,
}) => {
  if (!mongoose.Types.ObjectId.isValid(String(customerId || ""))) {
    throw new Error("יש לבחור לקוח");
  }
  if (!Array.isArray(items) || !items.length) {
    throw new Error("זיכוי חייב לכלול לפחות שורה אחת");
  }

  const customer = await Customer.findById(customerId).select("+erp").lean();
  if (!customer) throw new Error("הלקוח לא נמצא");

  const raw = items.map((i) => ({
    sku: String(i?.sku || "").trim(),
    name: String(i?.name || "").trim(),
    quantity: Number(i?.quantity),
    unitPrice: i?.unitPrice,
    isVatFree: Boolean(i?.isVatFree),
  }));

  const empty = raw.findIndex((i) => !i.sku && !i.name);
  if (empty !== -1) throw new Error(`שורה ${empty + 1} ריקה — יש לבחור מוצר או להקליד תיאור`);

  const catalogRows = raw.filter((i) => i.sku);
  const built = catalogRows.length
    ? await deliveryNotes.buildPricedItems(customerId, catalogRows, { requirePrice })
    : { items: [], priced: [] };

  // buildPricedItems מחזיר את השורות באותו סדר שבו קיבל אותן, ולכן אפשר
  // לשזור אותן בחזרה בין השורות החופשיות לפי המיקום
  let nextCatalog = 0;
  const finalItems = raw.map((row, index) => {
    if (row.sku) {
      const item = built.items[nextCatalog];
      const source = hasValue(row.unitPrice) ? "manual" : built.priced[nextCatalog].source;
      nextCatalog++;
      return { ...item, source };
    }

    if (!Number.isFinite(row.quantity) || row.quantity <= 0) {
      throw new Error(`כמות חייבת להיות גדולה מאפס בשורה ${index + 1}`);
    }
    const unitPrice = Number(row.unitPrice);
    if (!hasValue(row.unitPrice) || !Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new Error(`יש להקליד מחיר לשורה "${row.name}"`);
    }
    if (row.name.length > MAX_NAME_CHARS) {
      throw new Error(`תיאור השורה ארוך מ-${MAX_NAME_CHARS} תווים`);
    }

    return {
      name: row.name,
      quantity: row.quantity,
      unitPrice,
      lineTotal: money(unitPrice * row.quantity),
      isVatFree: row.isVatFree,
      source: "manual",
    };
  });

  const subTotal = money(finalItems.reduce((s, i) => s + i.lineTotal, 0));

  const manualDiscount = Number(discount) || 0;
  if (manualDiscount < 0) throw new Error("הנחה לא יכולה להיות שלילית");

  // ההנחה הקבועה של הלקוח יורדת גם מהזיכוי: הוא שילם על הסחורה אחרי
  // ההנחה, וזיכוי במחיר המלא היה מחזיר לו יותר ממה שחויב. אפשר לכבות
  // אותה בטופס — בזיכוי על סכום שסוכם ("הפרש מחיר 50 ₪") היא אינה במקום.
  const customerPercent = await discountPercentFor(customer);
  const customerDiscount = applyCustomerDiscount
    ? discountAmount(Math.max(0, subTotal - manualDiscount), customerPercent)
    : 0;
  const totalDiscount = money(manualDiscount + customerDiscount);

  if (totalDiscount > subTotal) {
    throw new Error(`ההנחה (${totalDiscount}) גדולה מסכום הזיכוי (${subTotal.toFixed(2)})`);
  }

  const total = money(subTotal - totalDiscount);

  return {
    customer,
    items: finalItems,
    subTotal,
    discount: totalDiscount,
    discountPercent: customerDiscount > 0 ? customerPercent : 0,
    customerDiscount,
    // האחוז של הלקוח גם כשלא הוחל — המסך מציג לפיו את תיבת הסימון
    customerDiscountPercent: customerPercent,
    total,
    totals: calculateVat({ items: finalItems, subTotal, discount: totalDiscount }),
  };
};

/** תצוגה מקדימה: השורות המתומחרות והסכומים, בלי לשמור. */
const preview = async (input) => {
  const { customer, ...result } = await build({ ...input, requirePrice: false });
  return result;
};

/**
 * בדיקת החשבונית שהזיכוי יקושר אליה.
 *
 *   1. היא חייבת להיות חשבונית פעילה של אותו לקוח. מספר שהוקלד בטעות היה
 *      מקשר ב-iCount זיכוי של לקוח אחד לחשבונית של אחר.
 *   2. סך הזיכויים שקושרו אליה, יחד עם הזיכוי הזה, אינו יכול לעלות על
 *      סכום החשבונית — אחרת הלקוח מקבל בחזרה יותר ממה שחויב.
 *
 * הבדיקה השנייה נשענת על אומדן הברוטו שלנו ולא על iCount, ואינה נעילה:
 * שתי תעודות שמופקות באותה שנייה מול אותה חשבונית יכולות לעבור יחד. היא
 * עוצרת את הטעות הנפוצה (זיכוי כפול על אותה סחורה), לא כל מרוץ.
 *
 * @param {object} p
 * @param {number} p.amount    - הזיכוי הנוכחי, כולל מע"מ
 * @param {string} [p.exceptId] - התעודה הנוכחית, כדי שלא תיספר פעמיים
 */
const assertInvoiceCanBeCredited = async ({ customerId, docNum, amount, exceptId }) => {
  const invoiceNotes = await DeliveryNote.find({
    customer: customerId,
    [ledger.f("icountDocNum")]: docNum,
    [ledger.f("status")]: "billed",
  })
    .select("items subTotal shippingCost discount")
    .lean();

  if (!invoiceNotes.length) {
    throw new Error(
      `חשבונית ${docNum} לא נמצאה בין החשבוניות הפעילות של הלקוח. ` +
        `אם היא בוטלה בינתיים — יש להפיק זיכוי חדש בלי קישור לחשבונית`
    );
  }

  const invoiceGross = money(invoiceNotes.reduce((s, n) => s + calculateVat(n).total, 0));

  const earlier = await CreditNote.find({
    customer: customerId,
    [ledger.f("status")]: "billed",
    [ledger.f("originalDocNum")]: docNum,
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  })
    .select("items subTotal discount")
    .lean();
  const alreadyCredited = money(earlier.reduce((s, n) => s + calculateVat(n).total, 0));

  if (alreadyCredited + amount > invoiceGross + OVER_CREDIT_TOLERANCE) {
    throw new Error(
      `הזיכוי (${amount.toFixed(2)} ₪) גדול ממה שנותר בחשבונית ${docNum}: ` +
        `סכום החשבונית ${invoiceGross.toFixed(2)} ₪` +
        (alreadyCredited > 0 ? `, וכבר זוכו ממנה ${alreadyCredited.toFixed(2)} ₪` : "") +
        ` (כולל מע"מ)`
    );
  }
};

const cleanDocNum = (value) => String(value ?? "").trim() || undefined;

const cleanReason = (value) => {
  const reason = String(value || "").trim();
  // הסיבה מודפסת על המסמך ונדרשת להסבר מול רואה החשבון
  if (!reason) throw new Error("חובה לציין סיבת זיכוי");
  if (reason.length > MAX_REASON_CHARS) {
    throw new Error(`סיבת הזיכוי ארוכה מ-${MAX_REASON_CHARS} תווים`);
  }
  return reason;
};

const safeIdempotencyKey = (value) => {
  if (!hasValue(value)) return undefined;
  if (typeof value !== "string") throw new Error("מפתח ייחודיות חייב להיות מחרוזת");
  const key = value.trim();
  if (key.length > MAX_IDEMPOTENCY_KEY) {
    throw new Error(`מפתח ייחודיות ארוך מ-${MAX_IDEMPOTENCY_KEY} תווים`);
  }
  return key || undefined;
};

/**
 * יצירת תעודת משלוח זיכוי.
 *
 * @param {object} p
 * @param {string} p.customerId
 * @param {Array}  p.items - ראה build
 * @param {string} p.reason
 * @param {string} [p.originalDocNum] - החשבונית שהזיכוי מתייחס אליה
 * @param {string} [p.idempotencyKey] - שליחה חוזרת מחזירה את התעודה הקיימת
 * @returns {Promise<{note, created: boolean}>}
 */
const create = async ({
  customerId,
  items,
  reason,
  notes,
  discount = 0,
  applyCustomerDiscount = true,
  originalDocNum,
  issuedBy,
  idempotencyKey,
}) => {
  const safeKey = safeIdempotencyKey(idempotencyKey);
  if (safeKey) {
    const already = await CreditNote.findOne({ idempotencyKey: safeKey }).lean();
    if (already) return { note: already, created: false };
  }

  const cleanedReason = cleanReason(reason);
  const built = await build({ customerId, items, discount, applyCustomerDiscount });

  if (!(built.total > 0)) throw new Error("סכום הזיכוי חייב להיות גדול מאפס");

  const cleanedNotes = String(notes || "").trim();
  if (cleanedNotes.length > MAX_NOTES_CHARS) {
    throw new Error(`ההערות ארוכות מ-${MAX_NOTES_CHARS} תווים`);
  }

  const docNum = cleanDocNum(originalDocNum);
  if (docNum) {
    await assertInvoiceCanBeCredited({
      customerId: built.customer._id,
      docNum,
      amount: built.totals.total,
    });
  }

  // מספר החשבונית שייך לספרים שבהם היא הופקה, ולכן נשמר בכיס הפעיל
  const pocket = docNum ? { originalDocNum: docNum } : {};
  const billing = isDemoMode()
    ? { status: "open", demo: { status: "open", ...pocket } }
    : { status: "open", ...pocket };

  const { customer } = built;
  const erp = customer.erp || {};

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const note = await CreditNote.create({
        number: await nextNumber(),
        customer: customer._id,
        customerSnapshot: {
          name: [customer.name, customer.lastName].filter(Boolean).join(" ").trim(),
          customerNumber: erp.customerNumber,
          vatId: erp.idNumber,
          ...addressOf(customer),
          contactPerson: erp.contactPerson,
          contactPhone: contactPhoneOf(customer),
        },
        // source הוא לתצוגה המקדימה בלבד ואינו נשמר (אינו בסכמה)
        items: built.items,
        subTotal: built.subTotal,
        discount: built.discount,
        discountPercent: built.discountPercent,
        customerDiscount: built.customerDiscount,
        total: built.total,
        reason: cleanedReason,
        notes: cleanedNotes || undefined,
        issuedBy,
        idempotencyKey: safeKey,
        billing,
      });
      return { note: note.toObject(), created: true };
    } catch (err) {
      if (err.code !== 11000) throw err;

      if (safeKey && String(err.message).includes("idempotencyKey")) {
        const raced = await CreditNote.findOne({ idempotencyKey: safeKey }).lean();
        if (raced) return { note: raced, created: false };
      }
      console.warn(`[credit-note] התנגשות מספר בניסיון ${attempt} — מנסה שוב`);
    }
  }

  throw new Error("הפקת תעודת זיכוי נכשלה אחרי 5 ניסיונות");
};

const describeCredit = (note, originalDocNum) =>
  [
    `זיכוי — ${note.reason}`,
    `תעודת זיכוי ${note.number}`,
    originalDocNum ? `בגין חשבונית ${originalDocNum}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

/**
 * הפקת חשבונית זיכוי ב-iCount מתעודת זיכוי פתוחה.
 *
 * אותה הגנה בת שלושה שלבים כמו בחיוב: תפיסה אטומית של התעודה (open →
 * billing), הפקה ב-iCount, וסימון. חשבונית זיכוי היא מסמך מס שאי אפשר
 * למחוק, ולכן לחיצה כפולה או שני מסכים פתוחים אסור שיפיקו שתיים.
 *
 * @param {string} noteId
 * @param {object} [opts]
 * @param {string} [opts.originalDocNum] - קישור לחשבונית; גובר על מה שנשמר בתעודה
 * @param {boolean} [opts.emailDocument] - undefined = לפי המדיניות (שליחה)
 * @returns {Promise<{note, creditDocNum, url, emailedTo}>}
 */
const issueInvoice = async (noteId, { originalDocNum, emailDocument } = {}) => {
  const current = await CreditNote.findById(noteId).lean();
  if (!current) throw new Error("תעודת הזיכוי לא נמצאה");

  const docNum = cleanDocNum(originalDocNum) || ledger.of(current).originalDocNum;
  // נבדק שוב ברגע ההפקה ולא רק ביצירה: בין לבין החשבונית יכלה להתבטל,
  // או שזיכוי אחר כבר ניצל את מה שנותר בה
  if (docNum) {
    await assertInvoiceCanBeCredited({
      customerId: current.customer,
      docNum,
      amount: calculateVat(current).total,
      exceptId: current._id,
    });
  }

  const claimToken = crypto.randomUUID();
  const note = await CreditNote.findOneAndUpdate(
    { _id: current._id, ...ledger.openQuery() },
    {
      $set: {
        [ledger.f("status")]: "billing",
        [ledger.f("claimToken")]: claimToken,
        [ledger.f("claimedAt")]: new Date(),
      },
    },
    { new: true }
  ).lean();

  if (!note) {
    const state = ledger.normalize(current).billing?.status;
    throw new Error(
      state === "billed"
        ? `לתעודת זיכוי ${current.number} כבר הופקה חשבונית זיכוי ${ledger.of(current).creditDocNum}`
        : state === "cancelled"
        ? `תעודת זיכוי ${current.number} בוטלה`
        : `תעודת זיכוי ${current.number} נמצאת כרגע בהפקה — יש לרענן את המסך`
    );
  }

  let doc;
  try {
    doc = await createCreditNote({
      customerId: note.customer,
      originalDocNum: docNum,
      unlinked: !docNum,
      items: note.items,
      discount: note.discount,
      description: describeCredit(note, docNum),
      emailDocument,
    });
  } catch (err) {
    // שום מסמך לא נוצר — התעודה חוזרת למצב פתוח ואפשר לנסות שוב
    await CreditNote.updateOne(
      { _id: note._id, [ledger.f("claimToken")]: claimToken },
      {
        $set: { [ledger.f("status")]: "open" },
        $unset: { [ledger.f("claimToken")]: "", [ledger.f("claimedAt")]: "" },
      }
    );
    throw new Error(`הפקת חשבונית הזיכוי נכשלה: ${err.message}`);
  }

  // אותה רשת ביטחון כמו בחשבונית: משווים את מה ש-iCount החזיר למה שחושב
  // אצלנו. אי-התאמה אינה מפילה (המסמך כבר בספרים) אבל חייבת לצעוק.
  const expected = calculateVat(note).total;
  const reported = Number(doc.total);
  if (Number.isFinite(reported) && Math.abs(Math.abs(reported) - expected) > 1) {
    console.error(
      `[billing] ⚠️ פער בין הסכום שחושב אצלנו לסכום שב-iCount על חשבונית זיכוי ${doc.docNum} ` +
        `(תעודת זיכוי ${note.number}): אצלנו ${expected.toFixed(2)} ₪ · ב-iCount ${reported.toFixed(2)} ₪`
    );
  }

  try {
    const marked = await CreditNote.findOneAndUpdate(
      { _id: note._id },
      {
        $set: {
          [ledger.f("status")]: "billed",
          [ledger.f("creditDocNum")]: doc.docNum,
          [ledger.f("creditDocUrl")]: doc.url || null,
          [ledger.f("creditDocEmailedTo")]: doc.emailedTo || null,
          [ledger.f("billedAt")]: new Date(),
          ...(docNum ? { [ledger.f("originalDocNum")]: docNum } : {}),
        },
        $unset: { [ledger.f("claimToken")]: "", [ledger.f("claimedAt")]: "" },
      },
      { new: true }
    ).lean();

    return {
      // null רק אם התעודה נמחקה מהמסד באמצע ההפקה; החשבונית בכל מקרה קיימת
      note: marked || note,
      creditDocNum: doc.docNum,
      url: doc.url,
      emailedTo: doc.emailedTo || null,
    };
  } catch (markErr) {
    // המצב היחיד שדורש יד אדם: החשבונית קיימת ב-iCount אבל התעודה לא
    // סומנה. הפקה חוזרת תזכה את הלקוח פעמיים.
    console.error(
      `[billing] ⚠️ קריטי: חשבונית זיכוי ${doc.docNum} הופקה מתעודת זיכוי ${note.number} ` +
        `אך סימון התעודה נכשל.\n` +
        `          חובה לסמן ידנית לפני הפקה נוספת, אחרת ייווצר זיכוי כפול.\n` +
        `          שגיאה: ${markErr.message}`
    );
    throw new Error(
      `חשבונית זיכוי ${doc.docNum} הופקה ב-iCount, אך הסימון על תעודה ${note.number} נכשל. ` +
        `אין להפיק שוב — יש לפנות לתמיכה.`
    );
  }
};

/**
 * ביטול תעודת זיכוי שעוד לא הופקה לה חשבונית.
 *
 * אחרי שהופקה חשבונית זיכוי אין ביטול: היא מסמך מס, והתיקון שלה הוא
 * חשבונית חדשה ללקוח.
 */
const cancel = async (noteId, reason) => {
  const note = await CreditNote.findOneAndUpdate(
    { _id: noteId, ...ledger.openQuery() },
    {
      $set: {
        "billing.status": "cancelled",
        "billing.cancelReason": String(reason || "").trim() || "בוטלה מהמסך",
        "billing.cancelledAt": new Date(),
      },
    },
    { new: true }
  ).lean();
  if (note) return note;

  const current = await CreditNote.findById(noteId).lean();
  if (!current) throw new Error("תעודת הזיכוי לא נמצאה");

  const state = ledger.normalize(current).billing?.status;
  throw new Error(
    state === "billed"
      ? `לתעודת זיכוי ${current.number} כבר הופקה חשבונית זיכוי ` +
        `${ledger.of(current).creditDocNum} — מסמך מס אינו ניתן לביטול`
      : state === "cancelled"
      ? `תעודת זיכוי ${current.number} כבר בוטלה`
      : `תעודת זיכוי ${current.number} נמצאת כרגע בהפקה ואי אפשר לבטל אותה`
  );
};

/**
 * שחרור תעודות שנתקעו במצב "billing" — תהליך שנפל בין התפיסה להפקה.
 * נקרא מאותו cron שמשחרר תעודות משלוח תקועות.
 */
const releaseStuckClaims = async ({ olderThanMinutes = 30 } = {}) => {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);

  const release = (prefix) =>
    CreditNote.updateMany(
      { [`${prefix}.status`]: "billing", [`${prefix}.claimedAt`]: { $lt: cutoff } },
      {
        $set: { [`${prefix}.status`]: "open" },
        $unset: { [`${prefix}.claimToken`]: "", [`${prefix}.claimedAt`]: "" },
      }
    );

  // שני הכיסים תמיד, כמו בתעודות המשלוח
  const [real, demo] = await Promise.all([release("billing"), release(ledger.DEMO_PREFIX)]);
  const released = real.modifiedCount + demo.modifiedCount;
  if (released) console.warn(`[billing] שוחררו ${released} תעודות זיכוי שנתקעו בהפקה`);
  return released;
};

/**
 * חשבוניות הזיכוי שהופקו מתעודות זיכוי, לפי מספר החשבונית שאליה קושרו.
 * רשימת החשבוניות מצרפת אותן לזיכויים שהיא כבר מציגה.
 *
 * @param {object} p
 * @param {string[]} p.docNums
 * @param {string} [p.customerId]
 * @param {object} [p.books] - הספרים לקריאה (ledger או ledger.real)
 * @returns {Promise<Array>}
 */
const listForInvoices = async ({ docNums, customerId, books = ledger }) => {
  if (!docNums?.length) return [];

  const query = {
    [books.f("status")]: "billed",
    [books.f("originalDocNum")]: { $in: docNums },
  };
  if (customerId) query.customer = customerId;

  const notes = await CreditNote.find(query)
    .select("number customer items subTotal discount reason billing")
    .lean();

  return notes.map((note) => {
    const pocket = books === ledger ? ledger.of(note) : note.billing || {};
    return {
      customer: note.customer,
      creditDocNum: pocket.creditDocNum,
      creditDocUrl: pocket.creditDocUrl || null,
      originalDocNum: pocket.originalDocNum,
      reason: note.reason,
      creditedAt: pocket.billedAt || null,
      // זיכוי חלקי: החשבונית המקורית בתוקף, ורק הסכום הזה זוכה ממנה
      partial: true,
      creditNoteId: note._id,
      creditNoteNumber: note.number,
      grossEstimate: calculateVat(note).total,
    };
  });
};

module.exports = {
  build,
  preview,
  create,
  issueInvoice,
  cancel,
  releaseStuckClaims,
  listForInvoices,
};

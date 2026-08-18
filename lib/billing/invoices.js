// lib/billing/invoices.js
//
// תצוגת החשבוניות שהופקו.
//
// אין אצלנו ישות "חשבונית" — החשבונית חיה ב-iCount, ומה שיש לנו הוא
// תעודות המשלוח שהיא סגרה. לכן "רשימת החשבוניות" היא תמיד קיבוץ של
// תעודות לפי billing.icountDocNum.
//
// הקיבוץ הזה נדרש בשלושה מקומות (כרטיס לקוח, דוח גבייה, מסך החשבוניות),
// והוא יושב כאן ולא משוכפל — שלוש גרסאות שמחשבות סכום קצת אחרת הן בדיוק
// הדרך שבה מסך אחד מראה חוב ומסך אחר מראה שולם.

const DeliveryNote = require("../../models/DeliveryNote");
const Customer = require("../../models/Customer");
const { dueDateFor } = require("./paymentTerms");
const ledger = require("./ledger");
const { calculateVat } = require("./vat");

/**
 * @param {object} [opts]
 * @param {string} [opts.customerId]  - סינון ללקוח אחד
 * @param {"paid"|"unpaid"|"overdue"} [opts.status]
 * @param {Date}   [opts.asOf]        - נקודת הזמן לחישוב איחור
 * @returns {Promise<Array>}
 */
/** הסכום ברוטו של תעודה, לפי כללי המע"מ המשותפים (lib/billing/vat). */
const grossOfNote = (note) => calculateVat(note).total;

const listInvoices = async ({ customerId, status, asOf = new Date() } = {}) => {
  // billedQuery ו-normalizeAll הם כל מה שמצב הדמו דורש כאן: השאילתה
  // פונה לכיס הפעיל, והתעודות מגיעות עם billing שכבר מכיל את מצב הדמו.
  // כל השאר בקובץ אינו יודע שיש מצב כזה, וזו הנקודה.
  const query = ledger.billedQuery();
  if (customerId) query.customer = customerId;

  // items נדרש לחישוב המע"מ הנכון (שורות פטורות), ולכן נשלף למרות שהוא
  // מייקר את השאילתה. select חלקי על תת-שדות של items אינו שווה את
  // הסיבוך — התעודות הן עשרות שורות, לא אלפים.
  const notes = ledger.normalizeAll(
    await DeliveryNote.find(query)
      .select("number customer customerSnapshot total subTotal shippingCost discount items billing")
      .lean()
  );

  // קיבוץ לפי לקוח+מסמך. המפתח כולל את הלקוח כי מספרי מסמך ב-iCount
  // ייחודיים לחשבון ולא ללקוח, וצירוף בטעות של שני לקוחות תחת מסמך אחד
  // היה יוצר חוב על שם הלקוח הלא נכון.
  const grouped = new Map();

  for (const note of notes) {
    const docNum = note.billing?.icountDocNum;
    if (!docNum) continue;

    const key = `${note.customer}|${docNum}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        docNum,
        customer: note.customer,
        customerName: note.customerSnapshot?.name || "—",
        customerNumber: note.customerSnapshot?.customerNumber || null,
        billedAt: note.billing.billedAt || null,
        netTotal: 0,
        grossEstimate: 0,
        notes: [],
        // תשלום נרשם על כל התעודות של החשבונית יחד, ולכן מספיק לקרוא
        // אותו מהראשונה שנתקלים בה
        icountDocUrl: note.billing.icountDocUrl || null,
        // למי נשלחה החשבונית במייל. null = לא נשלחה, וזו התשובה היחידה
        // שיש ל"האם הלקוח קיבל אותה" חודשים אחרי ההפקה.
        emailedTo: note.billing.icountDocEmailedTo || null,
        receiptDocNum: note.billing.receiptDocNum || null,
        receiptDocUrl: note.billing.receiptDocUrl || null,
        receiptEmailedTo: note.billing.receiptEmailedTo || null,
        paidAt: note.billing.paidAt || null,
        // כל הזיכויים שהוצאו מול התעודות של החשבונית הזו
        credits: [],
      });
    }

    const entry = grouped.get(key);
    entry.netTotal = Number((entry.netTotal + (note.total || 0)).toFixed(2));
    entry.grossEstimate = Number((entry.grossEstimate + grossOfNote(note)).toFixed(2));
    entry.notes.push(note.number);
    if (note.billing.paidAt && !entry.paidAt) {
      entry.paidAt = note.billing.paidAt;
      entry.receiptDocNum = note.billing.receiptDocNum || null;
      entry.receiptDocUrl = note.billing.receiptDocUrl || null;
      entry.receiptEmailedTo = note.billing.receiptEmailedTo || null;
    }

    // התעודה הראשונה בקבוצה עשויה להיות דווקא זו שלא נשמרה בה הכתובת
    // (תעודה ישנה מלפני השדה). מספיקה אחת עם ערך כדי לדעת שהמסמך נשלח.
    if (!entry.emailedTo && note.billing.icountDocEmailedTo) {
      entry.emailedTo = note.billing.icountDocEmailedTo;
    }

    // זיכויים שנוגעים לחשבונית הזו. תעודות רבות חולקות אותו זיכוי,
    // ולכן מסננים כפילויות לפי מספר המסמך.
    for (const credit of note.billing.credits || []) {
      if (credit.originalDocNum !== docNum) continue;
      if (entry.credits.some((c) => c.creditDocNum === credit.creditDocNum)) continue;
      entry.credits.push(credit);
    }
  }

  // כל הלקוחות בשאילתה אחת ולא findById בתוך הלולאה. עם מאות לקוחות
  // הגרסה הקודמת הייתה מאות הלוך-ושוב למסד לכל טעינת מסך.
  const customerIds = [...new Set([...grouped.values()].map((e) => String(e.customer)))];
  const customerDocs = await Customer.find({ _id: { $in: customerIds } })
    .select("+erp name")
    .lean();
  const customerById = new Map(customerDocs.map((c) => [String(c._id), c]));

  const out = [];

  for (const entry of grouped.values()) {
    const customer = customerById.get(String(entry.customer));

    let dueDate = null;
    let termsLabel = null;
    let termsConfirmed = true;

    if (entry.billedAt && customer) {
      const terms = dueDateFor(entry.billedAt, customer);
      dueDate = terms.dueDate;
      termsLabel = terms.label;
      termsConfirmed = terms.confirmed;
    }

    const isPaid = Boolean(entry.paidAt);
    const isOverdue = !isPaid && dueDate && dueDate <= asOf;

    out.push({
      ...entry,
      notes: entry.notes.sort((a, b) => a - b),
      dueDate,
      termsLabel,
      termsConfirmed,
      isPaid,
      isOverdue: Boolean(isOverdue),
      // ימי איחור רק כשיש איחור. מספר שלילי ("עוד 12 יום") שייך לתצוגה,
      // ולא צריך להתחפש לאיחור
      daysLate: isOverdue ? Math.floor((asOf - dueDate) / 86400000) : 0,
    });
  }

  const filtered = out.filter((inv) => {
    if (status === "paid") return inv.isPaid;
    if (status === "unpaid") return !inv.isPaid;
    if (status === "overdue") return inv.isOverdue;
    return true;
  });

  // הכי דחוף למעלה: איחור ארוך קודם, ואחריו החדש ביותר
  return filtered.sort((a, b) => {
    if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
    if (a.daysLate !== b.daysLate) return b.daysLate - a.daysLate;
    return new Date(b.billedAt || 0) - new Date(a.billedAt || 0);
  });
};

module.exports = { listInvoices };

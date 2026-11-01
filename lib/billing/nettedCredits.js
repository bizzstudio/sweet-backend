// lib/billing/nettedCredits.js
//
// תעודות זיכוי שנסגרו בתוך חשבונית חודשית (status "netted").
//
// החשבונית אצלנו היא קיבוץ של תעודות המשלוח שלה, ותעודת הזיכוי אינה אחת
// מהן. לכן כל מקום שמסכם חשבונית מתעודות (רשימת החשבוניות, הקבלות, הנספח,
// היתרה) חייב להפחית אותן — אחרת הוא מציג יותר ממה שעל המסמך.
//
// קובץ נפרד ולא חלק מ-creditNotes.js: הוא נקרא גם מ-customerBalance, ש-
// creditNotes עצמו תלוי בו.

const CreditNote = require("../../models/CreditNote");
const ledger = require("./ledger");
const { calculateVat } = require("./vat");

/**
 * @param {object} p
 * @param {string[]} p.docNums - מספרי החשבוניות
 * @param {string} [p.customerId]
 * @param {object} [p.books] - הספרים לקריאה (ledger או ledger.real)
 * @returns {Promise<Map<string, Array>>} מפתח: "<לקוח>|<מספר חשבונית>"
 */
const nettedInto = async ({ docNums, customerId, books = ledger }) => {
  const nums = [...new Set((docNums || []).filter(Boolean).map(String))];
  const out = new Map();
  if (!nums.length) return out;

  const query = {
    [books.f("status")]: "netted",
    [books.f("invoiceDocNum")]: { $in: nums },
  };
  if (customerId) query.customer = customerId;

  const notes = await CreditNote.find(query)
    .select("number customer items subTotal discount total reason notes issuedAt billing")
    .sort({ number: 1 })
    .lean();

  for (const note of notes) {
    const pocket = books === ledger ? ledger.of(note) : note.billing || {};
    const key = `${note.customer}|${pocket.invoiceDocNum}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push({
      _id: note._id,
      number: note.number,
      reason: note.reason,
      notes: note.notes || "",
      issuedAt: note.issuedAt,
      subTotal: Number(note.subTotal) || 0,
      discount: Number(note.discount) || 0,
      net: Number(note.total) || 0,
      gross: calculateVat(note).total,
    });
  }

  return out;
};

module.exports = { nettedInto };

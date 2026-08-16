// lib/billing/paymentTerms.js
//
// תרגום קוד תנאי התשלום מההנהח"ש למועד פירעון בפועל.
//
// ⚠️ הטבלה למטה אינה מאומתת.
//
// erp.paymentTerms מגיע מיבוא האקסל ומכיל קודים, לא ימים. הפילוח בפועל
// (769 לקוחות, נמדד 13/08/26):
//
//     0  → 464 לקוחות      -1 → 235 לקוחות      null → 57
//     5  →   4             7  →   3             3    →  2
//     1  →   2             4  →   1             17   →  1
//
// הערכים 0 ו--1 מכסים 699 מתוך 712, ולכן ברור שהם ברירות מחדל ולא "0 ימים"
// ו-"מינוס יום". iCount מחזיק את אותו שדה (payment_terms) והחברה עצמה
// מוגדרת שם -1, מה שמחזק שזו ברירת מחדל משותפת לשתי המערכות.
//
// אי אפשר לגזור את המשמעות מהנתונים בלבד — מה ש-5 או 7 אומרים בהנהח"ש
// של הלקוחה הוא ידע שנמצא אצלה או אצל רואה החשבון.
//
// עד לאישור: כל קוד לא מוכר מקבל NET_30, וההפרש נרשם ללוג. אין כאן ניחוש
// שקט — פונקציה שמחזירה מועד פירעון שגוי בשקט הייתה גורמת לרדיפה אחרי
// כסף בתאריך הלא נכון.

// ימי אשראי לכל קוד. לעדכן ברגע שהמשמעות מאושרת.
const TERMS_BY_CODE = {
  // ברירות המחדל — 699 מתוך 712 הלקוחות. מסומנות שוטף+30 עד לאישור.
  0: { days: 30, label: "שוטף + 30", confirmed: false },
  "-1": { days: 30, label: "שוטף + 30", confirmed: false },

  1: { days: 30, label: "שוטף + 30", confirmed: false },
  3: { days: 30, label: "שוטף + 30", confirmed: false },
  4: { days: 30, label: "שוטף + 30", confirmed: false },
  5: { days: 30, label: "שוטף + 30", confirmed: false },
  7: { days: 30, label: "שוטף + 30", confirmed: false },
  17: { days: 30, label: "שוטף + 30", confirmed: false },
};

const DEFAULT_TERMS = { days: 30, label: "שוטף + 30 (ברירת מחדל)", confirmed: false };

/** האם כל הטבלה אושרה. כל עוד לא — מסכי החיוב מציגים אזהרה. */
const isConfirmed = () => Object.values(TERMS_BY_CODE).every((t) => t.confirmed);

/**
 * תנאי התשלום של לקוח.
 *
 * @param {object} customer - חייב לכלול erp (נשלף עם select('+erp'))
 */
const forCustomer = (customer) => {
  const code = customer?.erp?.paymentTerms;
  if (code === undefined || code === null) return DEFAULT_TERMS;

  const terms = TERMS_BY_CODE[String(code)];
  if (terms) return terms;

  console.warn(
    `[billing] קוד תנאי תשלום לא מוכר: ${code} (לקוח ${customer.erp?.customerNumber}) — משתמש בברירת מחדל`
  );
  return DEFAULT_TERMS;
};

/**
 * מועד הפירעון של חשבונית.
 *
 * "שוטף + N" בישראל אינו "N ימים מהחשבונית" אלא "N ימים מסוף החודש שבו
 * הופקה החשבונית". חשבונית מ-3 בינואר בשוטף+30 נפרעת ב-2 במרץ ולא ב-2
 * בפברואר. חישוב לפי תאריך החשבונית היה מקדים כל תשלום בכמעט חודש.
 *
 * @param {Date|string} invoiceDate
 * @param {object} customer
 * @returns {{dueDate: Date, days: number, label: string, confirmed: boolean}}
 */
const dueDateFor = (invoiceDate, customer) => {
  const terms = forCustomer(customer);
  const issued = new Date(invoiceDate);

  // סוף החודש שבו הופקה החשבונית. יום 0 של החודש הבא = היום האחרון של הנוכחי.
  const endOfMonth = new Date(issued.getFullYear(), issued.getMonth() + 1, 0);
  const dueDate = new Date(endOfMonth);
  dueDate.setDate(dueDate.getDate() + terms.days);

  return { dueDate, ...terms };
};

module.exports = {
  TERMS_BY_CODE,
  DEFAULT_TERMS,
  forCustomer,
  dueDateFor,
  isConfirmed,
};

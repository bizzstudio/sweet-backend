// lib/billing/debtReport.js
//
// כמה כל לקוח חייב, לפי חודש: "אוקטובר 9,000, נובמבר 8,000" (בקשת הלקוחה,
// 01/11/2026).
//
// נבנה מ-listInvoices, כדי שהסכום כאן יהיה הסכום שבמסך החשבוניות. החודש הוא
// חודש החיוב של התעודות ולא יום ההפקה: חשבונית אוקטובר שהופקה ב-1 בנובמבר
// היא חוב של אוקטובר.
//
// יתרת הלקוח (זכות מתשלום עודף או מחשבונית זיכוי, חוב מתשלום חסר) אינה שייכת
// לחודש, ולכן היא מוצגת לצד הסכום ולא בתוכו, ו-netDue הוא מה שנשאר אחריה.
// גם חשבונית זיכוי שקושרה לחשבונית נרשמת ביתרה ומתקזזת ממנה (lib/billing/
// customerBalance), ולכן היא לא יורדת מהחודש: הפחתה כאן הייתה סופרת אותה פעמיים.
//
// הסכומים הם אומדן כולל מע"מ, כמו ברשימת החשבוניות. המקור המחייב הוא iCount.

const { listInvoices } = require("./invoices");
const { balancesOf } = require("./customerBalance");
const { billingMonthOf } = require("./deliveryNotes");

const money = (n) => Number((Number(n) || 0).toFixed(2));

const byMonth = (map) =>
  [...map.entries()]
    .map(([month, row]) => ({ month, count: row.count, amount: money(row.amount) }))
    .sort((a, b) => a.month.localeCompare(b.month));

const addTo = (map, month, amount) => {
  if (!map.has(month)) map.set(month, { count: 0, amount: 0 });
  const row = map.get(month);
  row.count += 1;
  row.amount += amount;
};

/**
 * @param {object} [opts]
 * @param {string} [opts.customerId] - לקוח אחד
 * @returns {Promise<{months: Array, customers: Array, total: number}>}
 */
const debtReport = async ({ customerId } = {}) => {
  const invoices = await listInvoices({ customerId, status: "unpaid" });

  const customers = new Map();
  const totals = new Map();

  for (const inv of invoices) {
    const due = money(inv.grossEstimate);
    const month = inv.billingMonth || (inv.billedAt ? billingMonthOf(new Date(inv.billedAt)) : "—");
    const key = String(inv.customer);
    if (!customers.has(key)) {
      customers.set(key, {
        customerId: key,
        name: inv.customerName,
        customerNumber: inv.customerNumber,
        months: new Map(),
      });
    }
    addTo(customers.get(key).months, month, due);
    addTo(totals, month, due);
  }

  const balances = await balancesOf([...customers.keys()]);

  const rows = [...customers.values()]
    .map((c) => {
      const months = byMonth(c.months);
      const total = money(months.reduce((s, m) => s + m.amount, 0));
      const balance = balances.get(c.customerId) || 0;
      return { ...c, months, total, balance, netDue: money(total - balance) };
    })
    .sort((a, b) => b.total - a.total);

  const months = byMonth(totals);
  return { months, customers: rows, total: money(months.reduce((s, m) => s + m.amount, 0)) };
};

module.exports = { debtReport };

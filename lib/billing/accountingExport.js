// lib/billing/accountingExport.js
//
// ייצוא מסמכי המס להנהלת החשבונות (בקשת הלקוחה, 04/11/2026): כל החשבוניות,
// הזיכויים והקבלות בטווח תאריכים, לפי סוג.
//
// המקור הוא iCount (doc/search) ולא המסד שלנו, וזה מכוון: הנהלת החשבונות
// רושמת את מה שהופק בפועל. אצלנו הסכום של חשבונית נבנה מחדש מהתעודות
// (אומדן), זיכוי של חשבונית שלמה לא שומר סכום, ומסמך שהופק ידנית ב-iCount
// לא קיים אצלנו בכלל.
//
// מספר הלקוח הוא custom_client_id — המספר של מנוע, שנשלח בכרטיס הלקוח
// (lib/icount/clients). כך השורות נקלטות במנוע בלי טבלת התאמה.
//
// מסמך שבוטל נשאר בייצוא, יחד עם חשבונית הזיכוי שביטלה אותו: שניהם מסמכי
// מס שהופקו, והנהלת החשבונות צריכה את שניהם כדי שהסכום יתאזן.

const { call } = require("../icount/client");

// הסדר כאן הוא סדר הסוגים במסך ובאקסל
const DOC_TYPES = {
  invoice: "חשבונית מס",
  invrec: "חשבונית מס קבלה",
  refund: "חשבונית זיכוי",
  receipt: "קבלה",
};

// מסמכים שמקטינים את ההכנסה. מוצגים בסימן מינוס כדי שסכום עמודה יהיה נכון
const NEGATIVE = new Set(["refund"]);

// מסמכים שאין בהם מע"מ — רק תקבול
const PAYMENT_ONLY = new Set(["receipt"]);

const PAYMENT_METHODS = [
  ["has_cash", "מזומן"],
  ["has_bt", "העברה בנקאית"],
  ["has_cheques", "צ'קים"],
  ["has_cc", "אשראי"],
  ["has_pp", "PayPal"],
];

// iCount מחזיר שגיאת too_many_results כשיש יותר מ-1000 תוצאות לשאילתה, גם
// עם limit. לכן שואלים חודש-חודש, ובתוך חודש עוברים בעמודים
const MAX_RESULTS = 1000;
const PAGE = 500;

// חודש עמוס לוקח כ-2.5 שניות מול iCount (נמדד 04/11/2026), והדפדפן מוותר
// אחרי 50. לכן עד שנה, ושלושה חודשים במקביל
const MAX_MONTHS = 13;
const PARALLEL_MONTHS = 3;

const EXEMPT_ROUNDING = 0.1;

// שגיאה בבקשה עצמה (טווח, סוג) — 400 ולא 500
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

const money = (n) =>Number((Number(n) || 0).toFixed(2));

const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** [from, to] → טווחים של חודש קלנדרי לכל היותר, כמחרוזות YYYY-MM-DD. */
const monthChunks = (from, to) => {
  const chunks = [];
  let start = from;
  while (start <= to) {
    const [y, m] = start.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const monthEnd = `${start.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
    const end = monthEnd < to ? monthEnd : to;
    chunks.push([start, end]);
    const next = new Date(Date.UTC(y, m, 1));
    start = next.toISOString().slice(0, 10);
  }
  return chunks;
};

const shiftDay = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// יותר מ-1000 מסמכים בטווח: חוצים אותו לשניים ושואלים כל חצי לבד
const fetchHalves = async (start, end, doctypes) => {
  const days = (Date.parse(end) - Date.parse(start)) / 86400000;
  const mid = shiftDay(start, Math.floor(days / 2));
  return [
    ...(await fetchRange(start, mid, doctypes)),
    ...(await fetchRange(shiftDay(mid, 1), end, doctypes)),
  ];
};

const fetchRange = async (start, end, doctypes) => {
  const docs = [];
  for (let offset = 0; ; offset += PAGE) {
    let res;
    try {
      res = await call("doc/search", {
        start_date: start,
        end_date: end,
        doctype: doctypes,
        detail_level: 9,
        get_base_docs: true,
        max_results: MAX_RESULTS,
        limit: PAGE,
        offset,
        sort_field: "docnum",
      });
    } catch (err) {
      // חודש בלי מסמכים חוזר מ-iCount כשגיאה ולא כרשימה ריקה
      if (err.reason === "no_results_found") break;
      if (err.reason === "too_many_results" && start < end) return fetchHalves(start, end, doctypes);
      throw err;
    }
    const list = Array.isArray(res?.results_list) ? res.results_list : [];
    docs.push(...list);
    if (list.length < PAGE || docs.length >= Number(res?.results_count || 0)) break;
  }
  return docs;
};

/**
 * פיצול סכום לפני מע"מ לחייב ולפטור.
 *
 * totalsum_exempt של iCount חוזר 0 גם בחשבונית שכולה פטורה (נבדק על 2205,
 * 04/11/2026), ולכן החלק החייב נגזר מהמע"מ עצמו. הפיצול עשוי לזוז באגורה או
 * שתיים בין החייב לפטור, אבל חייב + פטור + מע"מ = הסה"כ תמיד, בדיוק.
 */
const splitNet = (net, vat, vatPercent) => {
  const rate = Number(vatPercent) / 100;
  if (!rate || !vat) return { taxable: 0, exempt: net };
  const taxable = Math.min(net, money(vat / rate));
  const exempt = money(net - taxable);
  // שארית של אגורות היא עיגול המע"מ ולא שורה פטורה: בחשבונית 2000, שכולה
  // חייבת, 44.85 / 0.18 נותן 249.17 מתוך 249.18
  if (Math.abs(exempt) < EXEMPT_ROUNDING) return { taxable: net, exempt: 0 };
  return { taxable, exempt };
};

const statusOf = (doc) => {
  if (doc.is_cancelled) return "בוטל";
  if (doc.is_cancellation) return "ביטול";
  if (PAYMENT_ONLY.has(doc.doctype) || doc.doctype === "refund") return "";
  return { 0: "פתוחה", 1: "שולמה", 2: "שולמה חלקית" }[Number(doc.status)] || "";
};

const toRow = (doc) => {
  const type = doc.doctype;
  const sign = NEGATIVE.has(type) ? -1 : 1;
  const base = (doc.based_on || [])
    .map((b) => `${DOC_TYPES[b.doctype] || b.doctype} ${b.docnum}`)
    .join(", ");

  let amounts;
  if (PAYMENT_ONLY.has(type)) {
    amounts = { net: null, taxable: null, exempt: null, vat: null, gross: money(doc.total) };
  } else {
    const net = money(doc.afterdiscount ?? doc.totalsum);
    const vat = money(doc.totalvat);
    const { taxable, exempt } = splitNet(net, vat, doc.vat_percent);
    amounts = { net, taxable, exempt, vat, gross: money(doc.totalwithvat ?? doc.total) };
  }
  for (const key of Object.keys(amounts)) {
    if (amounts[key] !== null && sign < 0) amounts[key] = money(-amounts[key]);
  }

  return {
    type,
    typeLabel: DOC_TYPES[type] || type,
    docNum: String(doc.docnum),
    date: doc.dateissued,
    customerNumber: doc.custom_client_id || "",
    customerName: doc.client_name || "",
    vatId: doc.client_idno || "",
    ...amounts,
    discount: doc.discount ? money(sign * Number(doc.discount)) : 0,
    paymentMethod: PAYMENT_METHODS.filter(([flag]) => Number(doc[flag])).map(([, t]) => t).join(", "),
    status: statusOf(doc),
    basedOn: base,
    allocationNumber: doc.invoice_reference_number || "",
    url: doc.doc_url || "",
  };
};

const emptyTotal = () => ({ count: 0, net: 0, taxable: 0, exempt: 0, vat: 0, gross: 0 });

/**
 * @param {{from: string, to: string, types?: string[]}} opts
 * @returns {{from, to, types, rows, totals: {[type]: total}}}
 */
const accountingExport = async ({ from, to, types } = {}) => {
  if (!isDay(from) || !isDay(to)) throw badRequest("נדרש טווח תאריכים מלא");
  if (from > to) throw badRequest("תאריך הסיום מוקדם מתאריך ההתחלה");

  const wanted = (types && types.length ? types : Object.keys(DOC_TYPES)).filter((t) => DOC_TYPES[t]);
  if (!wanted.length) throw badRequest("לא נבחר סוג מסמך");

  const chunks = monthChunks(from, to);
  if (chunks.length > MAX_MONTHS) throw badRequest("ניתן לייצא טווח של עד שנה בכל פעם");

  const docs = [];
  for (let i = 0; i < chunks.length; i += PARALLEL_MONTHS) {
    const batch = chunks.slice(i, i + PARALLEL_MONTHS);
    const results = await Promise.all(batch.map(([start, end]) => fetchRange(start, end, wanted)));
    for (const list of results) docs.push(...list);
  }

  const order = Object.keys(DOC_TYPES);
  const rows = docs
    .filter((doc) => wanted.includes(doc.doctype))
    .map(toRow)
    .sort(
      (a, b) =>
        order.indexOf(a.type) - order.indexOf(b.type) ||
        a.date.localeCompare(b.date) ||
        Number(a.docNum) - Number(b.docNum)
    );

  const totals = {};
  for (const type of wanted) totals[type] = emptyTotal();
  for (const row of rows) {
    const t = totals[row.type];
    t.count += 1;
    for (const key of ["net", "taxable", "exempt", "vat", "gross"]) t[key] = money(t[key] + (row[key] || 0));
  }

  return { from, to, types: wanted, typeLabels: DOC_TYPES, rows, totals };
};

module.exports = { accountingExport, DOC_TYPES, monthChunks, splitNet, toRow };

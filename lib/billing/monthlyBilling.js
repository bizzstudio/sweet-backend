// lib/billing/monthlyBilling.js
//
// סגירת חודש: כל תעודות המשלוח הפתוחות של לקוח בחודש נתון נסגרות לחשבונית
// אחת ב-iCount. לקוח שמוגדר לו splitInvoiceByCategory מקבל חשבונית נפרדת
// לכל קטגוריה.
//
// הסיכון המרכזי כאן הוא חיוב כפול. חשבונית ב-iCount היא מסמך מס — אי אפשר
// למחוק אותה, רק להוציא זיכוי. לכן הזרימה היא שלושה שלבים:
//
//   1. תפיסה  — updateMany אטומי שמסמן את התעודות כ-"billing" עם טוקן ריצה.
//                רק תעודות שהיו "open" נתפסות, ולכן ריצה מקבילה תמצא 0.
//   2. הפקה   — פונים ל-iCount עם מה שנתפס בפועל.
//   3. סימון  — התעודות מסומנות "billed" עם מספר החשבונית.
//
// אם שלב 2 נכשל, שלב 1 מתבטל והתעודות חוזרות ל-"open".
// אם שלב 3 נכשל אחרי שהחשבונית כבר הופקה — זה המצב היחיד שדורש טיפול ידני,
// והוא נרשם ללוג עם מספר החשבונית כדי שאפשר יהיה להשלים אותו.

const crypto = require("crypto");
const DeliveryNote = require("../../models/DeliveryNote");
const CreditNote = require("../../models/CreditNote");
const Customer = require("../../models/Customer");
const { createInvoice, createCreditNote } = require("../icount/documents");
const { isDemoMode } = require("../icount/mode");
const ledger = require("./ledger");
const { billingMonthOf } = require("./deliveryNotes");
const { calculateVat } = require("./vat");
const { loadSummaryLines } = require("./summaryLines");
const customerBalance = require("./customerBalance");

/** החודש הקודם בפורמט YYYY-MM. ברירת המחדל של סגירת חודש. */
const previousMonth = (from = new Date()) => {
  const iso = from.toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
  const [year, month] = iso.split("-").map(Number);
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, "0")}`;
};

/**
 * האם התאריך הוא היום האחרון של החודש (28/29/30/31, תלוי בחודש), שעון ישראל.
 *
 * זהו יום הסגירה. הבדיקה מחושבת ולא מקובעת — פברואר מתחלף בין 28 ל-29,
 * וכל רשימה קשיחה של ימים הייתה מפספסת חודש אחת לארבע שנים.
 */
const isLastDayOfMonth = (from = new Date()) => {
  const [year, month, day] = from
    .toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" })
    .split("-")
    .map(Number);

  // יום 0 של החודש הבא = היום האחרון של החודש הנוכחי
  return day === new Date(Date.UTC(year, month, 0)).getUTCDate();
};

/** עיגול לאגורות. */
const money = (n) => Number((Number(n) || 0).toFixed(2));

/**
 * הקטגוריה שאליה שייכת התעודה כולה — זו שרוב כספה נמצא בה.
 *
 * תעודה מעורבת (כיבוד + חד פעמי באותו משלוח) מקבלת את הקטגוריה הדומיננטית
 * ולא מתפצלת בין שתי חשבוניות. זו החלטה מכוונת, ולא קיצור דרך:
 *
 *   אין אצלנו ישות "חשבונית" — החשבונית חיה ב-iCount, והקשר אליה נשמר
 *   על התעודה (billing.icountDocNum, receiptDocNum, credits). תעודה
 *   שנחצתה בין שתי חשבוניות יכולה להחזיק רק אחת מהן, ולכן היא הייתה
 *   נספרת פעמיים ברשימת החשבוניות, מסומנת כשולמה כששולמה רק אחת מהן,
 *   ומזוכה במלואה בזיכוי של אחת מהן.
 *
 * הפירוט לפי קטגוריה לא הולך לאיבוד: הוא מופיע כשורות ריכוז *בתוך*
 * החשבונית (summarizeItems), וזה ממילא מה שהתבקש.
 */
const dominantCategory = (note) => {
  const totals = new Map();
  for (const item of note.items || []) {
    const key = item.categoryName || "כללי";
    totals.set(key, (totals.get(key) || 0) + (Number(item.lineTotal) || 0));
  }
  if (!totals.size) return "כללי";

  // שובר שוויון לפי סדר אלפביתי, כדי ששתי ריצות על אותם נתונים יקבצו
  // באותו אופן. Map שומר סדר הכנסה, ובלי זה הקיבוץ תלוי בסדר השורות.
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "he"))[0][0];
};

// הקטגוריות שיוצאות לחשבונית נפרדת אצל לקוח עם separateDisposablesInvoice
// או separateFruitInvoice. "פירות" הוא גם השם של השורה הפטורה בריכוז.
const DISPOSABLES_CATEGORY = 'ח.ניקוי+ח"פ';
const FRUIT_CATEGORY = "פירות";

/**
 * לאיזו חשבונית שייכת תעודה: null = חשבונית אחת לכולן. separateDisposables
 * מוציא את התעודות שרובן חד פעמי, separateFruit את אלו שרובן פירות (בקשה
 * 29/10/2026: פירות לבד, כיבוד וחד פעמי יחד), וכל השאר בחשבונית אחת. שניהם
 * יחד — שלוש חשבוניות. משמש גם את התצוגה המקדימה, כדי שמספר החשבוניות
 * במסך יהיה מה שיופק.
 */
const invoiceKeyOf = (splitByCategory, separateDisposables, separateFruit = false) => {
  if (splitByCategory) return dominantCategory;
  if (!separateDisposables && !separateFruit) return null;
  const rest = !separateFruit ? "מזון ופירות" : !separateDisposables ? "מזון וחד פעמי" : "מזון";
  return (note) => {
    const key = dominantCategory(note);
    // אותו מבחן כמו בשם השורה (isDisposablesNote): גם תעודה שמוצריה רשומים
    // תחת מזון אבל ההערה עליה "חד פעמי". עד 29/10/2026 היא נכנסה לחשבונית
    // המזון, ובחירה ידנית של תעודות החד פעמי הפיקה שתי חשבוניות
    if (separateDisposables && isDisposablesNote(note)) return DISPOSABLES_CATEGORY;
    if (separateFruit && key === FRUIT_CATEGORY) return FRUIT_CATEGORY;
    return rest;
  };
};

/**
 * קיבוץ התעודות לחשבוניות.
 *
 * בלי פיצול — חשבונית אחת עם כל התעודות.
 * עם פיצול — חשבונית לכל קטגוריה, כשכל תעודה נכנסת בשלמותה לקטגוריה
 * הדומיננטית שלה (ראה dominantCategory).
 *
 * כל קבוצה נושאת גם את ההנחה ואת דמי המשלוח של התעודות שבה.
 *
 * ⚠️ עד 30/08/26 שני אלה לא נשלחו ל-iCount בכלל: החשבונית נבנתה מהשורות
 *    בלבד, ולכן לקוח עם הנחה או עם דמי משלוח על התעודה חויב בסכום שאינו
 *    תואם את התעודה שקיבל ביד. כאן הם חוזרים לחשבונית.
 */
const groupIntoInvoices = (notes, splitByCategory, separateDisposables = false, separateFruit = false) => {
  const build = (key, label, list) => ({
    key,
    label,
    notes: list,
    items: list.flatMap((n) => n.items),
    discount: money(list.reduce((s, n) => s + (Number(n.discount) || 0), 0)),
    shipping: money(list.reduce((s, n) => s + (Number(n.shippingCost) || 0), 0)),
  });

  const keyOf = invoiceKeyOf(splitByCategory, separateDisposables, separateFruit);
  if (!keyOf) return [build(null, null, notes)];

  const groups = new Map();
  for (const note of notes) {
    const key = keyOf(note);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(note);
  }

  return [...groups.entries()].map(([key, list]) => build(key, key, list));
};

// שמות השורות, וגם המפתחות שלפיהם מוצר ריכוז ממופה ב-billingSummaryLines
// (scripts/summary-line-map.js --set "מזון=…"). הפטורה — FRUIT_CATEGORY.
const TAXABLE_LINE = "מזון";

// תעודת חד פעמי: לפי הקטגוריה הדומיננטית, או לפי ההערה שעליה כשהיא
// מזכירה חד פעמי ולא כיבוד/אוכל. תעודה שרובה פירות לא נחשבת חד פעמי
// גם אם ההערה אומרת זאת.
const DISPOSABLES_REMARK = /חד[\s-]?פעמי|ח["״]פ/;
const FOOD_REMARK = /כיבוד|אוכל|מזון/;
const isDisposablesNote = (note) => {
  const key = dominantCategory(note);
  if (key === DISPOSABLES_CATEGORY) return true;
  if (key === FRUIT_CATEGORY) return false;
  const remark = String(note.notes || "");
  return DISPOSABLES_REMARK.test(remark) && !FOOD_REMARK.test(remark);
};

/**
 * שם השורה החייבת בריכוז. אצל לקוח עם פיצול, חשבונית שכל התעודות בה
 * מאותה קטגוריה נקראת בשמה ("ריכוז תעודות משלוח חלב"), וח.ניקוי+ח"פ
 * נקראת "חד פעמי". פירות נשארים "מזון": השורה הפטורה כבר נקראת "פירות",
 * ושתי שורות באותו שם היו מבלבלות. נגזר מהתעודות ולא מהקבוצה, כדי
 * שהזיכוי — שמקבל רק את התעודות — ייבנה באותו שם.
 *
 * חשבונית שכל התעודות בה חד פעמי נקראת "חד פעמי" גם בלי הגדרת פיצול
 * (בקשה 29/10/2026): בסגירה ידנית היא בוחרת את תעודות החד פעמי לבד, ועד
 * אז יצא "ריכוז תעודות משלוח מזון". ראה isDisposablesNote.
 */
const taxableLabelFor = (notes, billing) => {
  if (notes.length && notes.every(isDisposablesNote)) return "חד פעמי";
  if (
    !billing?.splitInvoiceByCategory &&
    !billing?.separateDisposablesInvoice &&
    !billing?.separateFruitInvoice
  )
    return TAXABLE_LINE;
  const keys = new Set(notes.map(dominantCategory));
  if (keys.size !== 1) return TAXABLE_LINE;
  const [key] = keys;
  if (key === DISPOSABLES_CATEGORY) return "חד פעמי";
  // separateDisposables/separateFruit מקבצים את כל השאר יחד — שם קטגוריה
  // בודדת לא מתאר אותו
  if (!billing.splitInvoiceByCategory || key === FRUIT_CATEGORY || key === "כללי") return TAXABLE_LINE;
  return key;
};

/**
 * שורות מרוכזות: שורה אחת חייבת במע"מ ושורה אחת פטורה, במקום כל שורות
 * המוצרים. הפירוט המלא נשאר אצלנו על התעודות ובנספח ‎/invoice-summary,
 * וזה מה שהלקוח מצליב בפועל.
 *
 * בקשת הלקוחה (28/10/2026, על חשבונית 2092): "הפרדה רק של פירות ושל
 * כיבוד, בגלל המע"מ". עד אז יצאה שורה לכל קטגוריה (מזון, ח.ניקוי+ח"פ,
 * כללית…), והיא לא רצתה להפריד אותן. בהקלטה שאחריה (10:52) דייקה את
 * השם: "ריכוז מזון וריכוז פירות" — החד פעמי והכללית נכנסים למזון.
 *
 * הפיצול לפי מע"מ הוא לא קוסמטיקה: איחוד חייב ופטור לשורה אחת היה מחייב
 * מע"מ על מה שפטור ממנו — או פוטר את מה שחייב. לכן גם פרי חייב במע"מ
 * נכנס לשורת המזון, ומוצר פטור שאינו פרי לשורה הפטורה.
 */
const summarizeItems = (items, summaryLines = null, taxableLabel = TAXABLE_LINE) => {
  const buckets = new Map();

  for (const item of items) {
    const vatFree = Boolean(item.isVatFree);
    if (!buckets.has(vatFree)) buckets.set(vatFree, { vatFree, total: 0, allFruit: true });
    const bucket = buckets.get(vatFree);
    bucket.total += Number(item.lineTotal) || 0;
    if (item.categoryName !== FRUIT_CATEGORY) bucket.allFruit = false;
  }

  // קבוצה שכל שורותיה ב-0 אינה חיוב, ושורת "0 ₪" על החשבונית רק מבלבלת.
  // החייבת קודם, כמו בחשבוניות שהלקוח מכיר.
  const active = [false, true]
    .map((vatFree) => buckets.get(vatFree))
    .filter((b) => b && money(b.total) > 0);

  const rows = active.map((b) => {
    // השורה הפטורה נקראת "פירות" רק כשהיא באמת כולה פירות; אחרת שם כזה
    // היה מתאר לא נכון מוצר פטור מקטגוריה אחרת, והיא נופלת למוצר הפטור
    const category = b.vatFree ? (b.allFruit ? FRUIT_CATEGORY : null) : taxableLabel;

    // מוצר הריכוז מהקטלוג (ראה lib/billing/summaryLines). הוא זה שמעניק
    // לשורה ברקוד — העמודה שרואה החשבון מצליב מולה, ושבחשבוניות
    // הקודמות של הלקוח אף פעם לא הייתה ריקה.
    const product = summaryLines?.for(category, b.vatFree) || null;

    const label = category || 'פטור ממע"מ';

    return {
      name: `ריכוז תעודות משלוח ${label}`,
      quantity: 1,
      unitPrice: money(b.total),
      lineTotal: money(b.total),
      isVatFree: b.vatFree,
      sku: product?.sku,
      barcode: product?.barcode,
    };
  });

  // ריכוז שהתרוקן לגמרי (כל התעודות ב-0) חוזר לשורות המקוריות, כי חשבונית
  // בלי שורות נדחית ב-iCount ותפיל את כל הסגירה
  return rows.length ? rows : items;
};

/**
 * שורות מאוחדות: שורה אחת לכל מוצר, עם סך הכמות מכל התעודות.
 *
 * בקשת הלקוחה (07/10/2026), לשניים-שלושה לקוחות שרוצים לראות מה קנו ולא
 * "ריכוז תעודות משלוח" — כמו בחשבונית שמנוע הפיק להם. פירוט רגיל חוזר על
 * אותו מוצר פעם לכל תעודה, ואצל לקוח עם משלוח יומי זו חשבונית של עשרות
 * עמודים.
 *
 * מוצר שנמכר במהלך החודש בשני מחירים נשאר בשתי שורות, אחת לכל מחיר. מחיר
 * ממוצע היה נשלח ל-iCount עם ארבע ספרות אחרי הנקודה, ואיך הוא מעגל מחיר
 * כזה לא אומת — בעוד ששורה במחיר שכבר מופיע על התעודה היא בדיוק מה
 * שנשלח היום.
 *
 * iCount מחשב כל שורה בעצמו (כמות × מחיר). מחיר במחירון הוא לרוב מחיר
 * כולל מע"מ חלקי 1.18 (12.9166…), וכל שורה עוגלה לאגורה בנפרד — ולכן
 * המכפלה המאוחדת יוצאת לפעמים אגורה שונה מסכום השורות. במקרה כזה המחיר
 * של השורה המאוחדת הוא סכום השורות חלקי הכמות: המחיר המודפס (באגורות)
 * זהה, והסכום זהה. עד 29/10/2026 קבוצה כזו נשארה לא מאוחדת, וזה מה שראתה
 * הלקוחה בחשבונית 2145 (קפה עלית עם הל ב-3 שורות). קבוצה שגם כך אינה
 * מסתדרת — נשארת כמות שהיא; הסכום קודם לקיצור.
 */
/**
 * מחיר יחידה לשורה מאוחדת, כך ש-iCount יחשב כמות × מחיר = total בדיוק.
 *
 * כמה שפחות ספרות אחרי הנקודה (2, 3, 4): כמה ספרות iCount שומר לא
 * תועד. 3 לפחות ידוע — חשבונית 2145 חישבה 3 × 12.92 = 38.75, כלומר
 * המחיר הלא מעוגל נשמר. מכפלה שיוצאת בדיוק על חצי אגורה נפסלת, כי שם
 * העיגול שלנו (toFixed) ושל iCount יכולים להתפצל.
 *
 * @returns {number|null} null — אין מחיר שמסתדר; השורות נשארות נפרדות
 */
const fitUnitPrice = (total, quantity) => {
  for (const digits of [2, 3, 4]) {
    const price = Number((total / quantity).toFixed(digits));
    const cents = quantity * price * 100;
    if (Math.abs(cents - Math.floor(cents) - 0.5) < 1e-6) continue;
    if (money(quantity * price) === total) return price;
  }
  return null;
};

const mergeProductLines = (items) => {
  const groups = new Map();

  for (const item of items) {
    // המפתח הוא מה שמודפס על השורה — השם, המחיר באגורות והמע"מ — ולא
    // productId או הברקוד: שתי שורות שנראות זהות על החשבונית מתאחדות גם
    // כשהן שתי רשומות כפולות בקטלוג (עם ברקודים שונים), ושתיים שנראות
    // שונות לעולם לא. ברקוד כפול בקטלוג (7 קבוצות) אינו מחבר מוצרים לא
    // קשורים, כי השם במפתח.
    const key = [item.name, item.isVatFree ? 1 : 0, money(item.unitPrice)].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const out = [];
  for (const lines of groups.values()) {
    if (lines.length === 1) {
      out.push(lines[0]);
      continue;
    }

    // 4 ספרות: כמות יכולה להיות משקל, וסכימת שברים בינאריים משאירה זנב
    const quantity = Number(lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0).toFixed(4));
    const lineTotal = money(lines.reduce((s, l) => s + (Number(l.lineTotal) || 0), 0));
    let unitPrice = Number(lines[0].unitPrice);
    const samePrice = lines.every((l) => Number(l.unitPrice) === unitPrice);

    if (quantity > 0 && (!samePrice || money(quantity * unitPrice) !== lineTotal)) {
      unitPrice = fitUnitPrice(lineTotal, quantity);
    }

    if (
      quantity <= 0 ||
      unitPrice === null ||
      money(quantity * unitPrice) !== lineTotal ||
      money(unitPrice) !== money(lines[0].unitPrice)
    ) {
      out.push(...lines);
      continue;
    }

    out.push({ ...lines[0], quantity, unitPrice, lineTotal });
  }

  return out;
};

/**
 * האם לאחד מוצר שחוזר בכמה תעודות לשורה אחת (mergeProductLines).
 *
 * רלוונטי רק לחשבונית מפורטת — מרוכזת ממילא אינה מציגה מוצרים. חשבונית
 * מיידית אינה מתאחדת: היא נמסרת במקום תעודת המשלוח וצריכה להיראות כמוה,
 * ולקוח perDelivery אינו מאחד גם בהפקה ידנית — מאותה סיבה שאינו מרכז
 * (ראה shouldSummarize).
 */
const shouldMergeProducts = (customer, { summarize = false, immediate = false } = {}) =>
  !summarize &&
  !immediate &&
  customer?.billing?.mode !== "perDelivery" &&
  customer?.billing?.mergeInvoiceProducts === true;

// גבול אורך לטקסט החופשי שנשלח ל-iCount (hwc). אורך השדה אינו מתועד;
// 1,966 תווים נשמרו במלואם בדמו (19/10/2026). חשבונית שנדחית מפילה את
// החיוב של אותו לקוח, ולכן תקציב שמרני עדיף על הימור.
const MAX_DESCRIPTION_CHARS = 2000;

/**
 * הטקסט החופשי של החשבונית (hwc, מודפס מתחת לסיכום): ההערות שנכתבו על
 * התעודות שהיא מחייבת, כל הערה שונה פעם אחת, לפי סדר התעודות.
 *
 * בקשת הלקוחה (20/10/2026): בלי "חיוב חודש / הופקה / ריכוז תעודות" —
 * רק מה שהיא כתבה. הפירוט לפי תעודה נשאר בנספח ‎/invoice-summary.
 */
const invoiceRemarks = (notes) => {
  const ordered = [...notes].sort((a, b) => a.number - b.number);
  const seen = new Set();
  const lines = [];
  for (const n of ordered) {
    const text = String(n.notes || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
  }
  return capDescription(lines.join("\n"));
};

/** חיתוך הטקסט החופשי לגבול האורך של hwc. ריק → undefined (לא נשלח). */
const capDescription = (text) =>
  text && text.length > MAX_DESCRIPTION_CHARS
    ? `${text.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
    : text || undefined;

/**
 * מצמיד את מספר הזמנת הרכש של הלקוח (billing.purchaseOrderNumber) לראש
 * הטקסט החופשי של החשבונית. בלי מספר — הטקסט חוזר כמו שהוא.
 */
const withPurchaseOrder = (customer, remarks) => {
  const po = String(customer?.billing?.purchaseOrderNumber || "").trim();
  if (!po) return remarks;
  return [`מספר הזמנת רכש: ${po}`, remarks].filter(Boolean).join("\n");
};

/**
 * הערה שהוקלדה במסך סגירת החודש לפני ההפקה ("כיבוד אוכל חד פעמי") —
 * בקשה 29/10/2026. נכנסת לפני ההערות שעל התעודות.
 */
const withTypedRemarks = (typed, remarks) =>
  [String(typed || "").trim(), remarks].filter(Boolean).join("\n") || undefined;

/**
 * האם לרכז את שורות החשבונית לשורה אחת לכל קטגוריה.
 *
 * שלושה תנאים, וכל אחד מהם לבדו מספיק כדי לפרט:
 *
 *   1. הגדרת הלקוח (summarizeInvoiceLines). ברירת המחדל היא ריכוז —
 *      וזו הצורה שהתבקשה (30/08/26).
 *   2. חשבונית מיידית (immediate) אינה מרכזת לעולם. היא מתארת משלוח
 *      אחד, והיא המסמך שנמסר ללקוח *במקום* תעודת משלוח — כלומר היא
 *      הנייר היחיד שאומר לו מה קיבל. "ריכוז תעודות משלוח — מזון" על
 *      משלוח בודד אינו מסמך שאפשר לבדוק מולו.
 *   3. לקוח במסלול perDelivery אינו מרכז גם כשמפיקים לו ידנית מהמסך,
 *      כדי שכל החשבוניות שלו ייראו אותו דבר.
 *
 * הכלל יושב כאן ולא בכל קורא בנפרד, כי הזיכוי חייב להיבנות בדיוק כמו
 * החשבונית שהוא מבטל.
 */
const shouldSummarize = (customer, immediate = false) => {
  if (immediate) return false;
  if (customer?.billing?.mode === "perDelivery") return false;
  return customer?.billing?.summarizeInvoiceLines !== false;
};

/** שורת דמי משלוח על החשבונית. חייבת במע"מ תמיד, כמו בכל חישוב אצלנו. */
const shippingLine = (amount) => ({
  name: "דמי משלוח",
  quantity: 1,
  unitPrice: money(amount),
  lineTotal: money(amount),
  isVatFree: false,
});

/**
 * תפיסה אטומית של תעודות לחיוב.
 *
 * זהו הלב של ההגנה מפני חיוב כפול: רק תעודות שהיו "open" נתפסות, ולכן
 * ריצה מקבילה — או לחיצה כפולה, או חיוב מיידי שחופף לסגירת חודש — תמצא
 * 0 ולא תפיק כלום.
 *
 * @returns {Promise<Array>} התעודות שנתפסו בפועל
 */
const claimNotes = async (query, claimToken) => {
  const claim = await DeliveryNote.updateMany(query, {
    $set: {
      [ledger.f("status")]: "billing",
      [ledger.f("claimToken")]: claimToken,
      [ledger.f("claimedAt")]: new Date(),
    },
  });

  if (!claim.modifiedCount) return [];
  return DeliveryNote.find({ [ledger.f("claimToken")]: claimToken }).lean();
};

/**
 * הפקת החשבוניות לתעודות שנתפסו, וסימונן.
 *
 * משותף לסגירת החודש ולחיוב המיידי (perDelivery) — שני המסלולים עושים
 * בדיוק את אותו דבר, ורק היקף התעודות שונה. שני מימושים היו נפרדים
 * ביום שמישהו יתקן באג באחד מהם.
 *
 * @returns {Promise<Array>} החשבוניות שהופקו
 * @throws  שגיאה עם partialInvoices — מה שכן הופק לפני הכשלון
 */
const billClaimedNotes = async ({ customer, notes, claimToken, label, emailDocument, immediate = false, detailed = false, remarks }) => {
  const release = () =>
    DeliveryNote.updateMany(
      { [ledger.f("claimToken")]: claimToken, [ledger.f("status")]: "billing" },
      {
        $set: { [ledger.f("status")]: "open" },
        $unset: { [ledger.f("claimToken")]: "", [ledger.f("claimedAt")]: "" },
      }
    );

  const groups = groupIntoInvoices(
    notes,
    customer.billing?.splitInvoiceByCategory,
    customer.billing?.separateDisposablesInvoice,
    customer.billing?.separateFruitInvoice
  );
  // detailed — חשבונית מפורטת שהתבקשה במפורש על תעודה/הזמנה בודדת (ראה
  // billNotesNow). גוברת על הגדרת הריכוז של הלקוח.
  const summarize = !detailed && shouldSummarize(customer, immediate);
  // נטען פעם אחת לכל החשבוניות של הלקוח, ולא לכל קבוצה בנפרד
  const summaryLines = summarize ? await loadSummaryLines() : null;
  const merge = shouldMergeProducts(customer, { summarize, immediate });
  const invoices = [];

  for (const group of groups) {
    try {
      // מערך חדש ולא דחיפה לתוך group.items: הוא מוחזר גם לתצוגה המקדימה,
      // ושורת משלוח שנדחפה אליו הייתה מופיעה שם כאילו היא מוצר
      const lines = [
        ...(summarize
          ? summarizeItems(group.items, summaryLines, taxableLabelFor(group.notes, customer.billing))
          : merge
            ? mergeProductLines(group.items)
            : group.items),
      ];
      if (group.shipping > 0) lines.push(shippingLine(group.shipping));

      const doc = await createInvoice({
        customerId: customer._id,
        items: lines,
        // רק ההערות שהמשתמשת כתבה על התעודות ("עבור מי, באישור מי").
        // עד 20/10/2026 נשלח כאן describeInvoice ("חיוב חודש… ריכוז תעודות
        // משלוח…"), והלקוחה ביקשה להוריד אותו; ההערה שלה לא נשלחה כלל.
        //
        // בסגירת החודש — בלי הערות (בקשה 28/10/2026): רשימת "קומה 22
        // כיבוד, קומה 23 כיבוד…" מתחת לסיכום כפלה את הנספח, שבו כל הערה
        // כבר עומדת ליד התעודה שלה. נשארות רק בחשבונית על תעודה בודדת.
        //
        // מספר הזמנת הרכש של הלקוח (אם הוגדר) מודפס תמיד, בשורה הראשונה.
        // אחריו ההערה שהוקלדה במסך הסגירה (remarks), אם הוקלדה — על כל
        // החשבוניות של הלקוח בהפקה הזו, גם כשהן מפוצלות.
        // החיתוך על הטקסט המלא, כולל שורת הרכש — עד 29/10/2026 היא
        // נוספה אחרי החיתוך ויכלה לעבור את הגבול.
        description: capDescription(
          withPurchaseOrder(
            customer,
            withTypedRemarks(
              remarks,
              detailed || immediate ? invoiceRemarks(group.notes) : undefined
            )
          )
        ),
        // ההנחה שעל התעודות. עד 30/08/26 היא לא נשלחה כלל, והלקוח חויב
        // על הסכום המלא בזמן שהתעודה שבידו הראתה הנחה.
        discount: group.discount,
        emailDocument,
      });

      // ── רשת ביטחון על הסכום ──
      //
      // אנחנו שולחים שורות נטו ומבקשים מ-iCount להוסיף מע"מ, ובנוסף
      // שולחים discount_amount ברמת המסמך. איך iCount מחלק הנחה כזו בין
      // שורות חייבות לפטורות אינו מתועד, ולא היה לנו מסמך אמיתי לאמת
      // מולו — זו נקודת החיבור היחידה כאן שלא נבדקה מקצה לקצה.
      //
      // לכן משווים את מה שהוא החזיר למה שאנחנו חישבנו. אי-התאמה אינה
      // מפילה את ההפקה (המסמך כבר קיים בספרים, וזריקה כאן רק הייתה
      // משאירה אותו בלי סימון על התעודות) — אבל היא חייבת לצעוק, כדי
      // שהיא תתגלה בחשבונית הראשונה ולא בביקורת.
      const expected = calculateVat({
        subTotal: money(group.items.reduce((s, i) => s + i.lineTotal, 0)),
        items: group.items,
        shippingCost: group.shipping,
        discount: group.discount,
      }).total;
      const reported = Number(doc.total);

      if (Number.isFinite(reported) && Math.abs(reported - expected) > 1) {
        console.error(
          `[billing] ⚠️ פער בין הסכום שחושב אצלנו לסכום שב-iCount על חשבונית ${doc.docNum} (${label}):\n` +
            `          אצלנו ${expected.toFixed(2)} ₪ · ב-iCount ${reported.toFixed(2)} ₪ · הפרש ${(reported - expected).toFixed(2)} ₪\n` +
            `          שורות ${money(group.items.reduce((s, i) => s + i.lineTotal, 0))} · ` +
            `משלוח ${group.shipping} · הנחה ${group.discount} · ` +
            `${group.items.some((i) => i.isVatFree) ? "יש שורות פטורות" : "אין שורות פטורות"}\n` +
            `          המסמך תקף וקיים בספרים — יש לבדוק את חלוקת ההנחה מול המע"מ.`
        );
      }

      try {
        await DeliveryNote.updateMany(
          { _id: { $in: group.notes.map((n) => n._id) } },
          {
            $set: {
              [ledger.f("status")]: "billed",
              [ledger.f("icountDocNum")]: doc.docNum,
              [ledger.f("icountDocType")]: doc.doctype,
              [ledger.f("icountDocUrl")]: doc.url || null,
              [ledger.f("icountDocEmailedTo")]: doc.emailedTo || null,
              // איך נבנו שורות החשבונית — כדי שהזיכוי והתיקון ייבנו
              // בדיוק אותו דבר גם כשהגדרת הלקוח שונה
              [ledger.f("icountDocSummarized")]: summarize,
              [ledger.f("icountDocMerged")]: merge,
              [ledger.f("billedAt")]: new Date(),
            },
            $unset: { [ledger.f("claimToken")]: "", [ledger.f("claimedAt")]: "" },
          }
        );
      } catch (markErr) {
        // המצב היחיד שדורש יד אדם: החשבונית קיימת ב-iCount אבל התעודות
        // לא סומנו. הרצה חוזרת תחייב שוב, ולכן זה חייב לצעוק.
        console.error(
          `[billing] ⚠️ קריטי: חשבונית ${doc.docNum} הופקה ל-${label} אך סימון התעודות נכשל.\n` +
            `          תעודות: ${group.notes.map((n) => n.number).join(", ")}\n` +
            `          חובה לסמן ידנית לפני הרצה נוספת, אחרת ייווצר חיוב כפול.\n` +
            `          שגיאה: ${markErr.message}`
        );
        throw markErr;
      }

      invoices.push({
        demo: isDemoMode(),
        category: group.label,
        docNum: doc.docNum,
        url: doc.url,
        // null = לא נשלחה. חייב לטפס עד הדוח: לקוח בלי מייל תקין מקבל
        // חשבונית שקיימת רק ב-iCount, ורק כאן אפשר לראות את זה.
        emailedTo: doc.emailedTo || null,
        noteCount: group.notes.length,
        // סכום השורות, ולצידו מה שבאמת חויב אחרי משלוח והנחה. שני המספרים
        // ולא אחד: המסך מציג "סכום החשבונית", והוא חייב להסכים עם המסמך
        itemsTotal: money(group.items.reduce((s, i) => s + i.lineTotal, 0)),
        discount: group.discount,
        shipping: group.shipping,
        summarized: summarize,
        merged: merge,
        netTotal: money(
          group.items.reduce((s, i) => s + i.lineTotal, 0) + group.shipping - group.discount
        ),
      });
    } catch (err) {
      // משחררים רק את מה שעוד לא חויב. קבוצה שכבר הופקה נשארת billed.
      await release();

      // לקוח עם פיצול לפי קטגוריה מפיק כמה חשבוניות. אם השנייה נכשלה,
      // הראשונה כבר קיימת ב-iCount ואי אפשר למחוק אותה — ולכן היא חייבת
      // להופיע בדוח.
      const error = new Error(`חיוב ${label} נכשל: ${err.message}`);
      error.partialInvoices = invoices;
      throw error;
    }
  }

  return invoices;
};

/**
 * סגירת החודש ללקוח בודד.
 *
 * @param {Array<string>} [opts.noteIds] - הפקה על תעודות נבחרות בלבד ולא על
 *        כל מה שפתוח. הסינון *מצטרף* לתנאים ולא מחליף אותם: תעודה שכבר
 *        חויבה או בוטלה לא תחזור לחיוב רק מפני שסומנה במסך.
 * @param {boolean} [opts.includeNotes] - לצרף לתצוגה המקדימה את פירוט
 *        התעודות. מיועד למסך של לקוח בודד; בתצוגה מקדימה של כל הלקוחות
 *        זה עשרות אלפי שורות שאיש אינו קורא.
 * @returns {Promise<{customerId, customerName, invoices: Array, skipped?: string}>}
 */
const closeCustomerMonth = async (
  customer,
  month,
  { dryRun = false, emailDocument, noteIds, includeNotes = false, detailed = false, remarks } = {}
) => {
  const claimToken = crypto.randomUUID();
  const label = `${customer.erp?.customerNumber || "?"} — ${customer.name}`;
  const splitByCategory = Boolean(customer.billing?.splitInvoiceByCategory);
  const separateDisposables = Boolean(customer.billing?.separateDisposablesInvoice);
  const separateFruit = Boolean(customer.billing?.separateFruitInvoice);
  const invoiceKey =
    invoiceKeyOf(splitByCategory, separateDisposables, separateFruit) || dominantCategory;
  const summarizeLines = !detailed && shouldSummarize(customer);
  const mergeLines = shouldMergeProducts(customer, { summarize: summarizeLines });

  // אותו טווח כמו ב-closeMonth: כל מה שפתוח עד החודש הנדרש כולל, ולא
  // החודש הנדרש בלבד. אחרת תעודה שזוכתה או שנכשלה בחודש קודם הייתה
  // נשארת פתוחה לנצח.
  const openQuery = {
    customer: customer._id,
    ...ledger.openQuery(),
    "billing.billingMonth": { $lte: month },
  };

  if (noteIds?.length) openQuery._id = { $in: noteIds };

  if (dryRun) {
    const notes = await DeliveryNote.find(openQuery).lean();

    // פירוט התעודות עצמן — זה מה שמאפשר לבחור במסך אילו מהן להפיק.
    //
    // netTotal הוא סכום השורות בלבד, ולצידו discount ו-shippingCost בנפרד.
    // עד 30/08/26 השניים לא נשלחו ל-iCount ולכן לא היה בהם צורך כאן; היום
    // הם חלק מהחשבונית, והמסך חייב אותם כדי שהסכום שהוא מציג על בחירה
    // חלקית יהיה מה שיופק בפועל.
    const noteDetails = () =>
      notes
        .map((n) => ({
          id: String(n._id),
          number: n.number,
          kind: n.kind || "auto",
          orderNumber: n.orderNumber || null,
          issuedAt: n.issuedAt,
          billingMonth: n.billing?.billingMonth || null,
          itemCount: n.items.length,
          // ההערה שהוקלדה בתעודה ("קומה 31 כיבוד") — לפיה מזהים תעודה בסגירה
          note: String(n.notes || "").trim(),
          netTotal: Number(n.items.reduce((s, i) => s + i.lineTotal, 0).toFixed(2)),
          discount: money(n.discount),
          shippingCost: money(n.shippingCost),
          // הקטגוריות שבתעודה — לתצוגה בלבד
          categories: [...new Set(n.items.map((i) => i.categoryName || "כללי"))],
          // הקטגוריה שאליה התעודה כולה תשויך אצל לקוח עם פיצול.
          //
          // מגיע מהשרת ולא מחושב במסך: הקיבוץ הוא ברמת התעודה
          // (dominantCategory) ולא ברמת השורה, ומסך שסופר את איחוד
          // categories היה מציג יותר חשבוניות ממה שיופקו בפועל.
          invoiceCategory: invoiceKey(n),
        }))
        .sort((a, b) => a.number - b.number);

    if (!notes.length) {
      return {
        customerId: customer._id,
        customerName: label,
        invoices: [],
        splitByCategory,
        separateDisposables,
        separateFruit,
        ...(includeNotes ? { notes: [] } : {}),
        skipped: "אין תעודות פתוחות",
      };
    }

    const groups = groupIntoInvoices(notes, splitByCategory, separateDisposables, separateFruit);
    const previewLines = summarizeLines ? await loadSummaryLines() : null;
    return {
      customerId: customer._id,
      customerName: label,
      splitByCategory,
      separateDisposables,
      separateFruit,
      summarizeLines,
      invoices: groups.map((g) => ({
        category: g.label,
        noteCount: g.notes.length,
        // כמה שורות באמת יופיעו על החשבונית — אחרי ריכוז זו שורה לקטגוריה
        // ולא שורה למוצר, והתצוגה המקדימה חייבת להראות את מה שיופק
        itemCount: summarizeLines
          ? summarizeItems(g.items, previewLines).length
          : mergeLines
            ? mergeProductLines(g.items).length
            : g.items.length,
        detailCount: g.items.length,
        summarized: summarizeLines,
        merged: mergeLines,
        itemsTotal: money(g.items.reduce((s, i) => s + i.lineTotal, 0)),
        discount: g.discount,
        shipping: g.shipping,
        netTotal: money(
          g.items.reduce((s, i) => s + i.lineTotal, 0) + g.shipping - g.discount
        ),
      })),
      ...(includeNotes ? { notes: noteDetails() } : {}),
    };
  }

  const claimed = await claimNotes(openQuery, claimToken);
  if (!claimed.length) {
    return { customerId: customer._id, customerName: label, invoices: [], skipped: "אין תעודות פתוחות" };
  }

  // מה שנשאר פתוח אחרי התפיסה. נמדד רק בהפקה על תעודות נבחרות — בסגירה
  // רגילה נתפס הכל ואין מה לספור, וספירה מיותרת בלולאה על מאות לקוחות
  // היא שאילתה לכל אחד מהם.
  //
  // התוצאה חוזרת למסך ("נשארו N תעודות פתוחות"). בחירה שכיסתה את כל
  // התעודות הפתוחות אינה "חיוב חלקי", גם אם נשלחה כרשימה מפורשת.
  const remainingOpen = noteIds?.length
    ? await DeliveryNote.countDocuments({
        customer: customer._id,
        ...ledger.openQuery(),
        "billing.billingMonth": { $lte: month },
      })
    : 0;

  const invoices = await billClaimedNotes({
    customer,
    notes: claimed,
    claimToken,
    label,
    emailDocument,
    detailed,
    remarks,
  });

  return { customerId: customer._id, customerName: label, invoices, remainingOpen };
};

/**
 * חיוב מיידי של תעודה בודדת — למסלול perDelivery.
 *
 * חלק מהלקוחות (3-4 נכון ל-16/08/26) מקבלים חשבונית מס עם כל משלוח ולא
 * תעודת משלוח וחשבונית מרכזת בסוף החודש. התעודה עדיין נוצרת ונשמרת —
 * היא צילום המצב שממנו נבנית החשבונית ובסיס כל הדיווח — אבל היא נסגרת
 * מיד, והמסמך שנמסר ללקוח הוא החשבונית.
 *
 * משתמש באותה תפיסה אטומית כמו סגירת החודש, ולכן חיוב מיידי שחופף
 * לסגירת חודש (או ריצה כפולה) לא יכול להפיק שתי חשבוניות לאותה תעודה.
 *
 * לא זורק: הוא נקרא מתוך זרימת עדכון סטטוס ההזמנה, וכשלון בהפקת חשבונית
 * אסור שיפיל את סימון ההזמנה כנמסרה. תעודה שלא חויבה נשארת פתוחה,
 * ותיאסף בסגירת החודש כרשת ביטחון.
 *
 * @returns {Promise<{invoices: Array}|null>}
 */
const billNoteImmediately = async (noteId) => {
  // כל הגוף עטוף, כולל שליפות המסד. הפונקציה נקראת גם fire-and-forget
  // מזרימת עדכון הסטטוס, ודחייה שאינה נתפסת מפילה את התהליך כולו
  // (Node 24: unhandled rejection = יציאה). תקלת מסד רגעית בזמן מסירה
  // אינה סיבה להפיל את השרת.
  let note = null;
  let label = "?";

  try {
    note = await DeliveryNote.findById(noteId).select("customer number billing").lean();
    if (!note) return null;
    // שני הכיסים נבדקים: בדמו התעודה חייבת להיות פתוחה גם באמת (לא
    // בוטלה, לא חויבה בחשבון האמיתי) וגם בכיס הדמו
    if (note.billing?.status !== "open") return null;
    if (ledger.of(note).status && ledger.of(note).status !== "open") return null;

    const customer = await Customer.findById(note.customer).select("+erp").lean();
    if (!customer) return null;
    if (customer.billing?.mode !== "perDelivery") return null;

    label = `${customer.erp?.customerNumber || "?"} — ${customer.name}`;
    const claimToken = crypto.randomUUID();

    const claimed = await claimNotes(
      { _id: note._id, ...ledger.openQuery() },
      claimToken
    );
    // 0 = מישהו אחר תפס אותה בינתיים (סגירת חודש שרצה במקביל). זו התנהגות
    // תקינה ולא שגיאה — התעודה תחויב שם.
    if (!claimed.length) return null;

    const invoices = await billClaimedNotes({
      customer,
      notes: claimed,
      claimToken,
      label,
      immediate: true,
      // בלי כפייה: החשבונית נשלחת ללקוח לפי מדיניות השליחה הכללית, בדיוק
      // כמו בסגירת החודש. אצל לקוח perDelivery זה המסמך שהוא מקבל במקום
      // תעודת משלוח, ולכן הוא צריך להגיע אליו מיד.
    });

    console.log(
      `[billing] חשבונית ${invoices.map((i) => i.docNum).join(", ")} הופקה מיידית ` +
        `לתעודה ${note.number} (${label})`
    );
    return { invoices };
  } catch (err) {
    console.error(
      `[billing] חיוב מיידי של תעודה ${note?.number ?? noteId} (${label}) נכשל: ${err.message}\n` +
        `          התעודה נשארה פתוחה ותיאסף בסגירת החודש.`
    );
    return null;
  }
};

/**
 * חיוב מיידי של תעודות נבחרות, בלי קשר למסלול החיוב של הלקוח.
 *
 * זה מה שעומד מאחורי "הפוך תעודה לחשבונית" ומאחורי הפקת חשבונית ישירות
 * מהצעת מחיר. השוני מ-billNoteImmediately הוא בכוונה: זו פעולה שמישהו
 * לחץ עליה, ולכן היא אינה מותנית ב-mode === "perDelivery" והיא *כן*
 * זורקת כשהיא נכשלת — מי שלחץ צריך לדעת.
 *
 * החודש נגזר מהתעודות עצמן ולא מהיום: תעודה מחודש שעבר שמחייבים אותה
 * היום שייכת לחודש שבו נמסרה הסחורה.
 *
 * @param {object} p
 * @param {string} p.customerId
 * @param {Array<string>} p.noteIds
 * @param {boolean} [p.detailed] - חשבונית מפורטת: כל שורת מוצר מופיעה על
 *        החשבונית, גם אצל לקוח שהחשבונית החודשית שלו מרוכזת. זה מה שעומד
 *        מאחורי "הפק חשבונית מפורטת" על תעודה/הזמנה בודדת (בקשת הלקוחה,
 *        04/10/2026) — "ריכוז תעודות משלוח — מזון" על הזמנה אחת אינו
 *        מסמך שאפשר לבדוק מולו.
 * @returns {Promise<{invoices: Array, customerName: string}>}
 */
const billNotesNow = async ({ customerId, noteIds, emailDocument, detailed = false }) => {
  if (!noteIds?.length) throw new Error("לא נבחרו תעודות לחיוב");

  const customer = await Customer.findById(customerId).select("+erp").lean();
  if (!customer) throw new Error("הלקוח לא נמצא");

  const notes = await DeliveryNote.find({ _id: { $in: noteIds }, customer: customerId })
    .select("number billing.billingMonth")
    .lean();

  if (notes.length !== noteIds.length) {
    throw new Error("חלק מהתעודות אינן שייכות ללקוח הזה");
  }

  // החודש המאוחר ביותר מבין התעודות: closeCustomerMonth אוסף
  // billingMonth <= month, ולכן חודש מוקדם מדי היה משאיר חלק מהן בחוץ.
  const month = notes
    .map((n) => n.billing?.billingMonth)
    .filter(Boolean)
    .sort()
    .pop() || previousMonth();

  const result = await closeCustomerMonth(customer, month, {
    noteIds: noteIds.map(String),
    emailDocument,
    detailed,
  });

  if (!result.invoices?.length) {
    throw new Error(
      result.skipped || "לא הופקה חשבונית — ייתכן שהתעודות כבר חויבו או שבוטלו"
    );
  }

  return result;
};

/**
 * סגירת חודש לכל הלקוחות.
 *
 * @param {object} opts
 * @param {string} [opts.month]      - YYYY-MM. ברירת מחדל: החודש הקודם
 * @param {boolean} [opts.dryRun]    - חישוב בלבד, בלי להפיק כלום
 * @param {string} [opts.customerId] - לקוח בודד
 * @param {Array<string>} [opts.noteIds] - תעודות נבחרות בלבד. דורש customerId:
 *        בחירה נקודתית היא פעולה על לקוח אחד, ורשימת מזהים חוצת-לקוחות
 *        הייתה מפיקה חשבוניות חלקיות לכמה לקוחות בלי שאיש התכוון לכך.
 * @param {boolean} [opts.emailDocument] - כפייה מפורשת של שליחה/אי-שליחה
 *        במייל. undefined (ברירת המחדל) = לפי BILLING_EMAIL_DOCUMENTS, שהיא
 *        שליחה. כך גם הסגירה האוטומטית וגם הידנית שולחות בלי לדעת על הדגל.
 * @param {boolean} [opts.allowCurrentMonth] - מתיר לסגור את החודש הנוכחי
 *        לכלל הלקוחות, אך ורק ביומו האחרון. מיועד לסגירה האוטומטית.
 */
const closeMonth = async ({
  month,
  dryRun = false,
  customerId,
  noteIds,
  emailDocument,
  allowCurrentMonth = false,
  remarks,
} = {}) => {
  const targetMonth = month || previousMonth();

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(targetMonth)) {
    throw new Error(`חודש לא תקין: "${targetMonth}". הפורמט הנדרש הוא YYYY-MM`);
  }

  if (noteIds?.length && !customerId) {
    throw new Error("בחירת תעודות ספציפיות אפשרית רק כשנבחר לקוח בודד");
  }

  // הערה מוקלדת שייכת לחשבונית של לקוח אחד; בסגירה גורפת היא הייתה
  // מודפסת על החשבוניות של כל הלקוחות
  if (String(remarks || "").trim() && !customerId) {
    throw new Error("הערה לחשבונית אפשרית רק כשנבחר לקוח בודד");
  }

  // הסגירה אוספת כל מה שפתוח *עד* החודש הנתון, ולכן חודש עתידי היה סוגר
  // גם את החודש הנוכחי שעדיין רץ — ומחייב לקוחות על סחורה שהם ימשיכו
  // לקבל. חודש עתידי חסום תמיד, בכל מסלול.
  //
  // בחודש הנוכחי מותרות שלוש כניסות בלבד:
  //   1. dryRun — אינו מפיק דבר, ולכן אין מה להגן עליו. זה גם מה שמאפשר
  //      לראות באמצע החודש מה פתוח כרגע ומי הלקוחות שיש להם תעודות.
  //   2. הסגירה האוטומטית ביום האחרון (allowCurrentMonth).
  //   3. הפקה ידנית ללקוח בודד — לקוח שביקש חשבונית באמצע החודש.
  //
  // מה שנשאר חסום הוא סגירה גורפת של חודש שעדיין רץ: לחיצה אחת כזו הייתה
  // מפיקה לכל הלקוחות חשבוניות חלקיות, ובלתי הפיכות.
  const currentMonth = billingMonthOf(new Date());
  const isClosingDay = allowCurrentMonth && isLastDayOfMonth();

  if (targetMonth > currentMonth) {
    throw new Error(
      `אי אפשר לחייב את חודש ${targetMonth} — הוא טרם התחיל. ` +
        `החודש האחרון שניתן לחייב הוא ${currentMonth}`
    );
  }

  if (targetMonth === currentMonth && !dryRun && !isClosingDay && !customerId) {
    throw new Error(
      `אי אפשר לסגור את חודש ${targetMonth} לכל הלקוחות — הוא טרם הסתיים. ` +
        `להפקה באמצע החודש יש לבחור לקוח מסוים. ` +
        `החודש האחרון שניתן לסגור במלואו הוא ${previousMonth()}`
    );
  }

  // אחרי בדיקות הקלט ולא לפניהן: בקשה שגויה אמורה לקבל את השגיאה שמסבירה
  // מה לא תקין בה, ולא הודעת דמו שמסתירה אותה.
  //
  // במצב דמו הסגירה *כן* רצה, במסלול המלא: אותו קיבוץ, אותו תיאור, אותן
  // קריאות ל-iCount. מה שלא קורה הוא הכתיבה למסד — התעודות אינן נתפסות
  // ואינן מסומנות כמחויבות (ראו claimNotes ו-billClaimedNotes), ולכן הן
  // ימשיכו לחיוב האמיתי כאילו לא קרה דבר. זו הדרך היחידה לראות את
  // הזרימה האמיתית בלי לשלם עליה במסמך מס.

  // רק לקוחות שיש להם תעודות פתוחות — אין טעם לעבור על 769 לקוחות כדי
  // לגלות שלרובם אין מה לחייב.
  //
  // כולל חודשים קודמים שנשארו פתוחים.
  //
  // תעודה יכולה להיות פתוחה בחודש ישן משתי סיבות: היא זוכתה וחזרה למצב
  // פתוח, או שהחיוב שלה נכשל בריצה קודמת. בשני המקרים היא חייבת להיסגר
  // בהזדמנות הבאה — סינון על החודש הנוכחי בלבד היה משאיר אותה פתוחה
  // לנצח, כי הסגירה האוטומטית מטפלת תמיד רק בחודש הקודם.
  const match = { ...ledger.openQuery(), "billing.billingMonth": { $lte: targetMonth } };
  if (customerId) match.customer = customerId;
  if (noteIds?.length) match._id = { $in: noteIds };

  const customerIds = await DeliveryNote.distinct("customer", match);

  const results = [];
  const failures = [];

  for (const id of customerIds) {
    const customer = await Customer.findById(id).select("+erp").lean();
    if (!customer) {
      failures.push({ customerId: id, message: "הלקוח לא נמצא במערכת" });
      continue;
    }

    try {
      results.push(
        await closeCustomerMonth(customer, targetMonth, {
          dryRun,
          emailDocument,
          noteIds,
          remarks,
          // רק כשנשאל על לקוח מסוים. תצוגה מקדימה של כל הלקוחות עם פירוט
          // כל תעודה היא מגה-בייטים שהמסך ממילא אינו מציג.
          includeNotes: Boolean(customerId),
        })
      );
    } catch (err) {
      failures.push({
        customerId: id,
        customerName: customer.name,
        message: err.message,
      });

      // חשבוניות שכן הופקו לפני הכשלון קיימות ב-iCount ולכן נספרות
      // ומוצגות, גם כשהלקוח מסומן ככשלון
      if (err.partialInvoices?.length) {
        results.push({
          customerId: id,
          customerName: customer.name,
          invoices: err.partialInvoices,
          partial: true,
        });
      }
    }
  }

  return {
    month: targetMonth,
    dryRun,
    // המסך והדוח חייבים להבדיל בין הפקה אמיתית להדגמה. שדה חסר כאן
    // פירושו מסך שמראה "12 חשבוניות הופקו" בלי לומר לאיזה חשבון.
    demo: isDemoMode(),
    // הפקה על רשימת תעודות מפורשת ולא על "כל מה שפתוח"
    selectionUsed: Boolean(noteIds?.length),
    // כמה תעודות נשארו פתוחות אחרי ההפקה. נמדד בתוך closeCustomerMonth
    // מיד אחרי התפיסה, ורק במסלול הבחירה
    remainingOpen: results.reduce((s, r) => s + (r.remainingOpen || 0), 0),
    // לקוח שהופקה לו חשבונית חלקית נספר פעם אחת בלבד — הוא גם ב-results
    // וגם ב-failures, ו-customersProcessed אמור לענות על "לכמה לקוחות
    // הופק משהו"
    customersProcessed: results.length,
    invoicesCreated: results.reduce((s, r) => s + r.invoices.length, 0),
    results,
    failures,
  };
};

/**
 * הלקוחות שיש להם תעודות פתוחות בחודש נתון — הרשימה שממנה בוחרים לקוח
 * במסך סגירת החודש.
 *
 * שאילתה נפרדת ולא נגזרת מתצוגה מקדימה מלאה: הבורר צריך להיטען מיד עם
 * המסך, ותצוגה מקדימה של כל הלקוחות שולפת את כל התעודות על כל שורותיהן.
 * כאן מספיק צירוף אחד במסד.
 *
 * הסכום הוא סכום השורות — מה שייכנס לחשבונית — ולא total שכולל משלוח והנחה.
 */
const openCustomers = async ({ month } = {}) => {
  const targetMonth = month || previousMonth();

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(targetMonth)) {
    throw new Error(`חודש לא תקין: "${targetMonth}". הפורמט הנדרש הוא YYYY-MM`);
  }

  const rows = await DeliveryNote.aggregate([
    { $match: { ...ledger.openQuery(), "billing.billingMonth": { $lte: targetMonth } } },
    {
      $group: {
        _id: "$customer",
        // מהצילום שעל התעודה, לא מהלקוח: זה מה שמודפס על התעודה עצמה
        snapshotName: { $last: "$customerSnapshot.name" },
        customerNumber: { $last: "$customerSnapshot.customerNumber" },
        noteCount: { $sum: 1 },
        netTotal: { $sum: { $sum: "$items.lineTotal" } },
      },
    },
    // הצילום חסר בתעודות ישנות, ובלעדיו הבורר מציג שורות בלי שם
    { $lookup: { from: "customers", localField: "_id", foreignField: "_id", as: "customer" } },
    { $unwind: { path: "$customer", preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        // מהלקוח כשהצילום ריק. "" הוא ערך אפשרי בצילום ולא רק null, ולכן
        // $ifNull לבדו אינו מספיק
        fallbackName: {
          $trim: {
            input: {
              $concat: [
                { $ifNull: ["$customer.name", ""] },
                " ",
                { $ifNull: ["$customer.lastName", ""] },
              ],
            },
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        id: { $toString: "$_id" },
        name: {
          $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$snapshotName", ""] } }, 0] }, "$snapshotName", "$fallbackName"],
        },
        customerNumber: { $ifNull: ["$customerNumber", "$customer.erp.customerNumber"] },
        noteCount: 1,
        netTotal: { $round: ["$netTotal", 2] },
      },
    },
    { $sort: { name: 1 } },
  ]);

  return { month: targetMonth, customers: rows };
};

/**
 * שחרור תעודות שנתקעו במצב "billing" — למשל אחרי קריסת שרת באמצע סגירת חודש.
 *
 * הסף חשוב: תעודה שנתפסה לפני דקה עשויה להיות בעיצומה של הפקה מול iCount,
 * ושחרור שלה היה גורם בדיוק לחיוב הכפול שהמנגנון בא למנוע.
 */
const releaseStuckClaims = async ({ olderThanMinutes = 30 } = {}) => {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);

  // שני הכיסים משוחררים תמיד, ולא רק הפעיל.
  //
  // הכיס האמיתי הוא הקריטי: תעודה שנתקעה ב-"billing" אינה נאספת לשום
  // חשבונית, ואם השרת רץ במצב דמו כשה-cron השעתי פועל — שחרור של הכיס
  // הפעיל בלבד היה מותיר תקיעה אמיתית ללא טיפול עד שמישהו יחזיר את
  // המערכת ל-live ויבחין בה. הרצה על כיס ריק לא עולה דבר.
  const release = (prefix) =>
    DeliveryNote.updateMany(
      { [`${prefix}.status`]: "billing", [`${prefix}.claimedAt`]: { $lt: cutoff } },
      {
        $set: { [`${prefix}.status`]: "open" },
        $unset: { [`${prefix}.claimToken`]: "", [`${prefix}.claimedAt`]: "" },
      }
    );

  const [real, demo] = await Promise.all([release("billing"), release(ledger.DEMO_PREFIX)]);

  if (real.modifiedCount) {
    console.warn(`[billing] שוחררו ${real.modifiedCount} תעודות שנתקעו במצב חיוב`);
  }
  if (demo.modifiedCount) {
    console.warn(`[billing] שוחררו ${demo.modifiedCount} תעודות שנתקעו בכיס הדמו`);
  }
  return real.modifiedCount + demo.modifiedCount;
};

/**
 * ביטול חשבונית שהופקה — מפיק חשבונית זיכוי ומחזיר את התעודות למצב פתוח.
 *
 * התעודות חוזרות ל-"open" ולא ל-"cancelled": הסחורה נמסרה, והחיוב עליה
 * עדיין צריך לקרות (בדרך כלל בחשבונית מתוקנת).
 */
const creditInvoice = async ({ icountDocNum, reason, reopenNotes = true }) => {
  const notes = await DeliveryNote.find({
    [ledger.f("icountDocNum")]: icountDocNum,
    [ledger.f("status")]: "billed",
  }).lean();

  if (!notes.length) {
    throw new Error(`לא נמצאו תעודות שחויבו בחשבונית ${icountDocNum}`);
  }

  const customerId = notes[0].customer;

  // זיכוי חלקי שכבר הופק מול החשבונית (מתעודת זיכוי, lib/billing/creditNotes).
  // הביטול כאן מזכה את החשבונית *במלואה*, ולכן יחד איתו הלקוח היה מקבל
  // בחזרה יותר ממה שחויב — במסמך מס שאי אפשר למחוק. נעצר לפני ההפקה.
  const partialCredits = await CreditNote.find({
    customer: customerId,
    [ledger.f("status")]: "billed",
    [ledger.f("originalDocNum")]: icountDocNum,
  })
    .select("billing")
    .lean();
  if (partialCredits.length) {
    throw new Error(
      `מול חשבונית ${icountDocNum} כבר הופקו חשבוניות זיכוי חלקיות ` +
        `(${partialCredits.map((c) => ledger.of(c).creditDocNum).join(", ")}). ` +
        `ביטול מלא היה מזכה את הלקוח פעמיים על אותו סכום — ` +
        `את היתרה יש לזכות בתעודת זיכוי נוספת מול החשבונית.`
    );
  }

  // הזיכוי חייב להיראות בדיוק כמו החשבונית שהוא מבטל — אותן שורות, אותה
  // שורת משלוח, אותה הנחה. זיכוי שנבנה אחרת מזכה סכום אחר, וההפרש נשאר
  // פתוח בספרים בלי שאיש רואה אותו.
  const customer = await Customer.findById(customerId).select("billing").lean();
  // אותו כלל בדיוק כמו בהפקה. ההבחנה היחידה שאי אפשר לשחזר בדיעבד היא
  // אם החשבונית המקורית הייתה מיידית — אבל היא רלוונטית רק ללקוח
  // perDelivery, וזה נבדק כאן ממילא. ההצגה שונה, הסכום זהה בשני המקרים.
  //
  // מ-04/10/2026 החשבונית רושמת על התעודות אם נבנתה מרוכזת, ואז הזיכוי
  // הולך לפיה ולא לפי ההגדרה הנוכחית — חשבונית מפורטת על הזמנה בודדת
  // אצל לקוח מרוכז הייתה מקבלת אחרת זיכוי מרוכז.
  const recorded = ledger.of(notes[0]).icountDocSummarized;
  const summarize = typeof recorded === "boolean" ? recorded : shouldSummarize(customer);

  const rawItems = notes.flatMap((n) => n.items);
  const shipping = money(notes.reduce((s, n) => s + (Number(n.shippingCost) || 0), 0));
  const discount = money(notes.reduce((s, n) => s + (Number(n.discount) || 0), 0));

  // חשבונית שאיחדה מוצרים מזוכה באותן שורות. אין נפילה להגדרת הלקוח:
  // חשבונית שאין עליה הסימון הופקה לפני שהאיחוד היה קיים.
  const merged = !summarize && ledger.of(notes[0]).icountDocMerged === true;

  const items = [
    ...(summarize
      ? summarizeItems(rawItems, await loadSummaryLines(), taxableLabelFor(notes, customer?.billing))
      : merged
        ? mergeProductLines(rawItems)
        : rawItems),
  ];
  if (shipping > 0) items.push(shippingLine(shipping));

  const doc = await createCreditNote({
    customerId,
    originalDocNum: icountDocNum,
    items,
    discount,
    reason,
  });

  // רישום הזיכוי נשמר תמיד, גם כשהתעודה חוזרת למצב פתוח. בלעדיו העקבות
  // נמחקות יחד עם icountDocNum ואי אפשר יהיה למצוא את מסמך הזיכוי.
  const creditEntry = {
    creditDocNum: doc.docNum,
    creditDocUrl: doc.url || null,
    originalDocNum: icountDocNum,
    reason,
    creditedAt: new Date(),
  };

  await DeliveryNote.updateMany(
    { _id: { $in: notes.map((n) => n._id) } },
    reopenNotes
      ? {
          $set: { [ledger.f("status")]: "open" },
          $push: { [ledger.f("credits")]: creditEntry },
          $unset: {
            [ledger.f("icountDocNum")]: "",
            [ledger.f("icountDocType")]: "",
            [ledger.f("icountDocUrl")]: "",
            [ledger.f("icountDocSummarized")]: "",
            [ledger.f("icountDocMerged")]: "",
            [ledger.f("billedAt")]: "",
            // תשלום שנרשם על החשבונית המזוכה אינו רלוונטי לחיוב החדש
            [ledger.f("receiptDocNum")]: "",
            [ledger.f("receiptDocUrl")]: "",
            [ledger.f("paidAt")]: "",
            [ledger.f("paidFromBalance")]: "",
          },
        }
      : {
          $set: { [ledger.f("status")]: "cancelled", [ledger.f("cancelReason")]: reason },
          $push: { [ledger.f("credits")]: creditEntry },
        }
  );

  // חשבונית ששולמה: מה שנסגר עליה חוזר ליתרת הזכות של הלקוח, ויתקזז
  // מהחשבונית הבאה שלו. אחרי הזיכוי ולא לפניו, ובלי להפיל — מסמך המס
  // כבר קיים, ויתרה שלא עודכנה מתוקנת ידנית בכרטיס הלקוח.
  let balanceCredited = 0;
  try {
    balanceCredited = await customerBalance.refundCancelledInvoice({
      customerId,
      docNum: icountDocNum,
      notes,
      creditDocNum: doc.docNum,
      reason,
    });
  } catch (balanceErr) {
    console.error(
      `[billing] זיכוי ${doc.docNum} הופק אך עדכון יתרת הלקוח נכשל: ${balanceErr.message}\n` +
        `          חשבונית ${icountDocNum} שולמה — יש לתקן את היתרה ידנית בכרטיס הלקוח`
    );
  }

  return { creditDocNum: doc.docNum, url: doc.url, noteCount: notes.length, balanceCredited };
};

module.exports = {
  closeMonth,
  openCustomers,
  billNoteImmediately,
  billNotesNow,
  closeCustomerMonth,
  creditInvoice,
  releaseStuckClaims,
  previousMonth,
  isLastDayOfMonth,
  groupIntoInvoices,
  summarizeItems,
  mergeProductLines,
  shouldSummarize,
  shouldMergeProducts,
  invoiceRemarks,
  withPurchaseOrder,
  withTypedRemarks,
  capDescription,
  taxableLabelFor,
  billingMonthOf,
};

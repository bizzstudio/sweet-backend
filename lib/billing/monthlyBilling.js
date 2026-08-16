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
const Customer = require("../../models/Customer");
const { createInvoice, createCreditNote } = require("../icount/documents");
const { billingMonthOf } = require("./deliveryNotes");

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

/**
 * קיבוץ התעודות לחשבוניות.
 *
 * בלי פיצול — חשבונית אחת עם כל השורות מכל התעודות.
 * עם פיצול — חשבונית לכל קטגוריה. שורה בלי קטגוריה נופלת לקבוצה "כללי"
 * ולא נעלמת; חשבונית חסרת שורות הייתה משמעותה שהלקוח לא חויב על מה שקיבל.
 */
const groupIntoInvoices = (notes, splitByCategory) => {
  if (!splitByCategory) {
    return [{ key: null, label: null, notes, items: notes.flatMap((n) => n.items) }];
  }

  const groups = new Map();

  for (const note of notes) {
    for (const item of note.items) {
      const key = item.categoryName || "כללי";
      if (!groups.has(key)) groups.set(key, { key, label: key, notes: new Set(), items: [] });
      const group = groups.get(key);
      group.items.push(item);
      group.notes.add(note);
    }
  }

  return [...groups.values()].map((g) => ({ ...g, notes: [...g.notes] }));
};

/**
 * טקסט שמופיע בראש החשבונית ומפרט אילו תעודות היא סוגרת. זה מה שמאפשר
 * ללקוח (ולרואה החשבון) להצליב בין החשבונית לתעודות שקיבל בפועל.
 */
const describeInvoice = (month, notes, categoryLabel, immediate = false) => {
  const numbers = notes.map((n) => n.number).sort((a, b) => a - b);

  // חשבונית מיידית מתארת משלוח בודד, לא חיוב חודשי. "חיוב חודש 2026-08"
  // על משלוח שיצא היום פשוט לא נכון, והטקסט הזה מודפס ומגיע ללקוח.
  if (immediate) {
    const head = categoryLabel ? `משלוח — ${categoryLabel}` : "משלוח";
    return `${head}\nתעודת משלוח: ${numbers.join(", ")}`;
  }

  // החודשים נגזרים מהתעודות עצמן ולא מפרמטר month, כי סגירה אוספת גם
  // תעודות פתוחות מחודשים קודמים (זיכוי או כשלון בריצה קודמת). כותרת
  // "חיוב חודש 08" על חשבונית שכוללת גם תעודות מ-07 היא פשוט לא נכונה.
  const months = [...new Set(notes.map((n) => n.billing?.billingMonth).filter(Boolean))].sort();
  const period =
    months.length <= 1 ? months[0] || month : `${months[0]} – ${months[months.length - 1]}`;

  const head = categoryLabel
    ? `חיוב חודש ${period} — ${categoryLabel}`
    : `חיוב חודש ${period}`;

  // רשימה ארוכה מדי הופכת את ראש המסמך לבלתי קריא. מעל 20 תעודות מציגים
  // טווח; הפירוט המלא נשאר אצלנו על התעודות עצמן.
  const list =
    numbers.length <= 20
      ? numbers.join(", ")
      : `${numbers[0]}–${numbers[numbers.length - 1]} (${numbers.length} תעודות)`;

  return `${head}\nתעודות משלוח: ${list}`;
};

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
      "billing.status": "billing",
      "billing.claimToken": claimToken,
      "billing.claimedAt": new Date(),
    },
  });

  if (!claim.modifiedCount) return [];
  return DeliveryNote.find({ "billing.claimToken": claimToken }).lean();
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
const billClaimedNotes = async ({ customer, notes, claimToken, label, month, emailDocument, immediate = false }) => {
  const release = () =>
    DeliveryNote.updateMany(
      { "billing.claimToken": claimToken, "billing.status": "billing" },
      { $set: { "billing.status": "open" }, $unset: { "billing.claimToken": "", "billing.claimedAt": "" } }
    );

  const groups = groupIntoInvoices(notes, customer.billing?.splitInvoiceByCategory);
  const invoices = [];

  for (const group of groups) {
    try {
      const doc = await createInvoice({
        customerId: customer._id,
        items: group.items,
        description: describeInvoice(month, group.notes, group.label, immediate),
        emailDocument,
      });

      try {
        await DeliveryNote.updateMany(
          { _id: { $in: group.notes.map((n) => n._id) } },
          {
            $set: {
              "billing.status": "billed",
              "billing.icountDocNum": doc.docNum,
              "billing.icountDocType": doc.doctype,
              "billing.icountDocUrl": doc.url || null,
              "billing.billedAt": new Date(),
            },
            $unset: { "billing.claimToken": "", "billing.claimedAt": "" },
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
        category: group.label,
        docNum: doc.docNum,
        url: doc.url,
        noteCount: group.notes.length,
        netTotal: Number(group.items.reduce((s, i) => s + i.lineTotal, 0).toFixed(2)),
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
 * @returns {Promise<{customerId, customerName, invoices: Array, skipped?: string}>}
 */
const closeCustomerMonth = async (customer, month, { dryRun = false, emailDocument = false } = {}) => {
  const claimToken = crypto.randomUUID();
  const label = `${customer.erp?.customerNumber || "?"} — ${customer.name}`;

  // אותו טווח כמו ב-closeMonth: כל מה שפתוח עד החודש הנדרש כולל, ולא
  // החודש הנדרש בלבד. אחרת תעודה שזוכתה או שנכשלה בחודש קודם הייתה
  // נשארת פתוחה לנצח.
  const openQuery = {
    customer: customer._id,
    "billing.status": "open",
    "billing.billingMonth": { $lte: month },
  };

  if (dryRun) {
    const notes = await DeliveryNote.find(openQuery).lean();
    if (!notes.length) return { customerId: customer._id, customerName: label, invoices: [], skipped: "אין תעודות פתוחות" };

    const groups = groupIntoInvoices(notes, customer.billing?.splitInvoiceByCategory);
    return {
      customerId: customer._id,
      customerName: label,
      invoices: groups.map((g) => ({
        category: g.label,
        noteCount: g.notes.length,
        itemCount: g.items.length,
        netTotal: Number(g.items.reduce((s, i) => s + i.lineTotal, 0).toFixed(2)),
      })),
    };
  }

  const claimed = await claimNotes(openQuery, claimToken);
  if (!claimed.length) {
    return { customerId: customer._id, customerName: label, invoices: [], skipped: "אין תעודות פתוחות" };
  }

  const invoices = await billClaimedNotes({
    customer,
    notes: claimed,
    claimToken,
    label,
    month,
    emailDocument,
  });

  return { customerId: customer._id, customerName: label, invoices };
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
    if (note.billing?.status !== "open") return null;

    const customer = await Customer.findById(note.customer).select("+erp").lean();
    if (!customer) return null;
    if (customer.billing?.mode !== "perDelivery") return null;

    label = `${customer.erp?.customerNumber || "?"} — ${customer.name}`;
    const claimToken = crypto.randomUUID();

    const claimed = await claimNotes(
      { _id: note._id, "billing.status": "open" },
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
      month: note.billing.billingMonth,
      immediate: true,
      emailDocument: false,
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
 * סגירת חודש לכל הלקוחות.
 *
 * @param {object} opts
 * @param {string} [opts.month]      - YYYY-MM. ברירת מחדל: החודש הקודם
 * @param {boolean} [opts.dryRun]    - חישוב בלבד, בלי להפיק כלום
 * @param {string} [opts.customerId] - לקוח בודד
 * @param {boolean} [opts.emailDocument]
 * @param {boolean} [opts.allowCurrentMonth] - מתיר לסגור את החודש הנוכחי,
 *        אך ורק ביומו האחרון. מיועד לסגירה האוטומטית של סוף החודש.
 */
const closeMonth = async ({
  month,
  dryRun = false,
  customerId,
  emailDocument = false,
  allowCurrentMonth = false,
} = {}) => {
  const targetMonth = month || previousMonth();

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(targetMonth)) {
    throw new Error(`חודש לא תקין: "${targetMonth}". הפורמט הנדרש הוא YYYY-MM`);
  }

  // הסגירה אוספת כל מה שפתוח *עד* החודש הנתון, ולכן חודש עתידי היה סוגר
  // גם את החודש הנוכחי שעדיין רץ — ומחייב לקוחות על סחורה שהם ימשיכו
  // לקבל. חודש עתידי חסום תמיד.
  //
  // החודש הנוכחי נסגר ביומו האחרון בלבד (30/31, ובפברואר 28/29) — וגם אז
  // רק בקריאה שביקשה זאת מפורשות, כלומר הסגירה האוטומטית. סגירה ידנית של
  // חודש שעדיין רץ נשארת חסומה כדי שלחיצה מוקדמת לא תפיק חשבוניות חלקיות.
  const currentMonth = billingMonthOf(new Date());
  const isClosingDay = allowCurrentMonth && isLastDayOfMonth();

  if (targetMonth > currentMonth || (targetMonth === currentMonth && !isClosingDay)) {
    throw new Error(
      `אי אפשר לסגור את חודש ${targetMonth} — הוא טרם הסתיים. ` +
        `החודש האחרון שניתן לסגור הוא ${previousMonth()}`
    );
  }

  // רק לקוחות שיש להם תעודות פתוחות — אין טעם לעבור על 769 לקוחות כדי
  // לגלות שלרובם אין מה לחייב.
  //
  // כולל חודשים קודמים שנשארו פתוחים.
  //
  // תעודה יכולה להיות פתוחה בחודש ישן משתי סיבות: היא זוכתה וחזרה למצב
  // פתוח, או שהחיוב שלה נכשל בריצה קודמת. בשני המקרים היא חייבת להיסגר
  // בהזדמנות הבאה — סינון על החודש הנוכחי בלבד היה משאיר אותה פתוחה
  // לנצח, כי הסגירה האוטומטית מטפלת תמיד רק בחודש הקודם.
  const match = { "billing.status": "open", "billing.billingMonth": { $lte: targetMonth } };
  if (customerId) match.customer = customerId;

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
      results.push(await closeCustomerMonth(customer, targetMonth, { dryRun, emailDocument }));
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
 * שחרור תעודות שנתקעו במצב "billing" — למשל אחרי קריסת שרת באמצע סגירת חודש.
 *
 * הסף חשוב: תעודה שנתפסה לפני דקה עשויה להיות בעיצומה של הפקה מול iCount,
 * ושחרור שלה היה גורם בדיוק לחיוב הכפול שהמנגנון בא למנוע.
 */
const releaseStuckClaims = async ({ olderThanMinutes = 30 } = {}) => {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);

  const res = await DeliveryNote.updateMany(
    { "billing.status": "billing", "billing.claimedAt": { $lt: cutoff } },
    { $set: { "billing.status": "open" }, $unset: { "billing.claimToken": "", "billing.claimedAt": "" } }
  );

  if (res.modifiedCount) {
    console.warn(`[billing] שוחררו ${res.modifiedCount} תעודות שנתקעו במצב חיוב`);
  }
  return res.modifiedCount;
};

/**
 * ביטול חשבונית שהופקה — מפיק חשבונית זיכוי ומחזיר את התעודות למצב פתוח.
 *
 * התעודות חוזרות ל-"open" ולא ל-"cancelled": הסחורה נמסרה, והחיוב עליה
 * עדיין צריך לקרות (בדרך כלל בחשבונית מתוקנת).
 */
const creditInvoice = async ({ icountDocNum, reason, reopenNotes = true }) => {
  const notes = await DeliveryNote.find({
    "billing.icountDocNum": icountDocNum,
    "billing.status": "billed",
  }).lean();

  if (!notes.length) {
    throw new Error(`לא נמצאו תעודות שחויבו בחשבונית ${icountDocNum}`);
  }

  const customerId = notes[0].customer;
  const items = notes.flatMap((n) => n.items);

  const doc = await createCreditNote({
    customerId,
    originalDocNum: icountDocNum,
    items,
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
          $set: { "billing.status": "open" },
          $push: { "billing.credits": creditEntry },
          $unset: {
            "billing.icountDocNum": "",
            "billing.icountDocType": "",
            "billing.icountDocUrl": "",
            "billing.billedAt": "",
            // תשלום שנרשם על החשבונית המזוכה אינו רלוונטי לחיוב החדש
            "billing.receiptDocNum": "",
            "billing.receiptDocUrl": "",
            "billing.paidAt": "",
          },
        }
      : {
          $set: { "billing.status": "cancelled", "billing.cancelReason": reason },
          $push: { "billing.credits": creditEntry },
        }
  );

  return { creditDocNum: doc.docNum, url: doc.url, noteCount: notes.length };
};

module.exports = {
  closeMonth,
  billNoteImmediately,
  closeCustomerMonth,
  creditInvoice,
  releaseStuckClaims,
  previousMonth,
  isLastDayOfMonth,
  groupIntoInvoices,
  billingMonthOf,
};

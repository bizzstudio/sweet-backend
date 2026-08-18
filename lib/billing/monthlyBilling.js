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
const { isDemoMode } = require("../icount/mode");
const ledger = require("./ledger");
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
const describeInvoice = (month, notes, categoryLabel, immediate = false, partial = false) => {
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

  // הפקה על חלק מהתעודות אינה החיוב של החודש, וכותרת שאומרת "חיוב חודש
  // 2026-08" על שלוש תעודות מתוך שתים-עשרה נקראת אצל הלקוח כחשבון החודשי
  // שלו. הוא יקבל בסוף החודש עוד אחת, על אותו חודש.
  const lead = partial ? `חיוב חלקי — חודש ${period}` : `חיוב חודש ${period}`;
  const head = categoryLabel ? `${lead} — ${categoryLabel}` : lead;

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
const billClaimedNotes = async ({ customer, notes, claimToken, label, month, emailDocument, immediate = false, partial = false }) => {
  const release = () =>
    DeliveryNote.updateMany(
      { [ledger.f("claimToken")]: claimToken, [ledger.f("status")]: "billing" },
      {
        $set: { [ledger.f("status")]: "open" },
        $unset: { [ledger.f("claimToken")]: "", [ledger.f("claimedAt")]: "" },
      }
    );

  const groups = groupIntoInvoices(notes, customer.billing?.splitInvoiceByCategory);
  const invoices = [];

  for (const group of groups) {
    try {
      const doc = await createInvoice({
        customerId: customer._id,
        items: group.items,
        description: describeInvoice(month, group.notes, group.label, immediate, partial),
        emailDocument,
      });

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
  { dryRun = false, emailDocument, noteIds, includeNotes = false } = {}
) => {
  const claimToken = crypto.randomUUID();
  const label = `${customer.erp?.customerNumber || "?"} — ${customer.name}`;
  const splitByCategory = Boolean(customer.billing?.splitInvoiceByCategory);

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
    // הסכום הוא סכום השורות, כלומר בדיוק מה שייכנס לחשבונית, ולא
    // note.total שכולל גם משלוח והנחה שאינם נשלחים ל-iCount.
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
          netTotal: Number(n.items.reduce((s, i) => s + i.lineTotal, 0).toFixed(2)),
          // הקטגוריות שבתעודה — המסך משתמש בהן כדי לחשב כמה חשבוניות
          // ייווצרו מהבחירה, אצל לקוח עם פיצול לפי קטגוריה
          categories: [...new Set(n.items.map((i) => i.categoryName || "כללי"))],
        }))
        .sort((a, b) => a.number - b.number);

    if (!notes.length) {
      return {
        customerId: customer._id,
        customerName: label,
        invoices: [],
        splitByCategory,
        ...(includeNotes ? { notes: [] } : {}),
        skipped: "אין תעודות פתוחות",
      };
    }

    const groups = groupIntoInvoices(notes, splitByCategory);
    return {
      customerId: customer._id,
      customerName: label,
      splitByCategory,
      invoices: groups.map((g) => ({
        category: g.label,
        noteCount: g.notes.length,
        itemCount: g.items.length,
        netTotal: Number(g.items.reduce((s, i) => s + i.lineTotal, 0).toFixed(2)),
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
  // התוצאה משמשת לשני דברים: הכותרת על המסמך שמגיע ללקוח, וההודעה שחוזרת
  // למסך. בחירה שכיסתה את כל התעודות הפתוחות אינה "חיוב חלקי", גם אם
  // נשלחה כרשימה מפורשת.
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
    month,
    emailDocument,
    partial: remainingOpen > 0,
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
      month: note.billing.billingMonth,
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
} = {}) => {
  const targetMonth = month || previousMonth();

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(targetMonth)) {
    throw new Error(`חודש לא תקין: "${targetMonth}". הפורמט הנדרש הוא YYYY-MM`);
  }

  if (noteIds?.length && !customerId) {
    throw new Error("בחירת תעודות ספציפיות אפשרית רק כשנבחר לקוח בודד");
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
          $set: { [ledger.f("status")]: "open" },
          $push: { [ledger.f("credits")]: creditEntry },
          $unset: {
            [ledger.f("icountDocNum")]: "",
            [ledger.f("icountDocType")]: "",
            [ledger.f("icountDocUrl")]: "",
            [ledger.f("billedAt")]: "",
            // תשלום שנרשם על החשבונית המזוכה אינו רלוונטי לחיוב החדש
            [ledger.f("receiptDocNum")]: "",
            [ledger.f("receiptDocUrl")]: "",
            [ledger.f("paidAt")]: "",
          },
        }
      : {
          $set: { [ledger.f("status")]: "cancelled", [ledger.f("cancelReason")]: reason },
          $push: { [ledger.f("credits")]: creditEntry },
        }
  );

  return { creditDocNum: doc.docNum, url: doc.url, noteCount: notes.length };
};

module.exports = {
  closeMonth,
  openCustomers,
  billNoteImmediately,
  closeCustomerMonth,
  creditInvoice,
  releaseStuckClaims,
  previousMonth,
  isLastDayOfMonth,
  groupIntoInvoices,
  billingMonthOf,
};

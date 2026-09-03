// lib/billing/reissue.js
//
// "תקן חשבונית והפק אותה מחדש".
//
// חשבונית מס אינה ניתנת לעריכה — לא אצלנו ולא ב-iCount. מרגע שהיא הופקה
// היא רשומה בספרים ומדווחת, והדרך היחידה לתקן אותה היא זיכוי מלא והפקה
// של חשבונית חדשה במקומה. זה בדיוק מה שהמודול הזה עושה, בפעולה אחת:
//
//   1. חשבונית זיכוי על מלוא הסכום (monthlyBilling.creditInvoice)
//   2. התעודות חוזרות למצב פתוח ומתוקנות (deliveryNotes.update)
//   3. חשבונית חדשה על אותן תעודות (monthlyBilling.billNotesNow)
//
// שלושת השלבים כבר היו קיימים בנפרד; מה שלא היה קיים הוא הרצף. בלעדיו
// התיקון דרש שלוש כניסות לשלושה מסכים, ובאמצע נשארה חשבונית מזוכה
// שאיש אינו זוכר להפיק מחדש.
//
// ⚠️ מה שקורה כאן אינו הפיך. הזיכוי הוא מסמך מס: הוא נכנס לספרים, מגיע
//    לרואה החשבון, וגם אם החשבונית החדשה תיכשל הוא יישאר. לכן:
//
//    א. כל מה שאפשר לאמת מאומת *לפני* הזיכוי (validateEdits) — מק"ט שלא
//       קיים, שורה בלי מחיר, הנחה גדולה מהסכום. שגיאה כזו אחרי הזיכוי
//       הייתה משאירה את הלקוח בלי חשבונית עד שמישהו יבחין.
//    ב. מה שנכשל *אחרי* הזיכוי אינו נזרק כשגיאה אלא חוזר ב-problems עם
//       stage. מי שלחץ חייב לדעת בדיוק היכן הדברים עצרו — "נכשל" סתם
//       משאיר אותו בלי לדעת אם יצא זיכוי.

const DeliveryNote = require("../../models/DeliveryNote");
const Customer = require("../../models/Customer");
const deliveryNotes = require("./deliveryNotes");
const monthlyBilling = require("./monthlyBilling");
const ledger = require("./ledger");
const { discountPercentFor, discountAmount } = require("./pricing");
const { isDemoMode } = require("../icount/mode");

const money = (n) => Number((Number(n) || 0).toFixed(2));

const israelDay = deliveryNotes.israelDay;

/**
 * התעודות שהחשבונית סגרה.
 *
 * דרך ledger, כמו כל השאר: במצב דמו החשבונית שמוצגת במסך היא של כיס
 * הדמו, ותיקון שלה חייב לעבוד על אותו כיס.
 */
const notesOfInvoice = async (icountDocNum) =>
  DeliveryNote.find({
    [ledger.f("icountDocNum")]: icountDocNum,
    [ledger.f("status")]: "billed",
  }).lean();

/**
 * בדיקת כל התיקונים מול הקטלוג והמחירון — לפני שיוצא הזיכוי.
 *
 * זו כל הסיבה שהפונקציה קיימת בנפרד: buildPricedItems הוא בדיוק החישוב
 * שהעריכה עצמה תעשה, ולכן הרצה שלו כאן מגלה מראש את מה שהיה מפיל את
 * העריכה אחרי שהזיכוי כבר הופק.
 *
 * @returns {Promise<void>} זורק עם הודעה בעברית על התיקון הראשון שנפסל
 */
const validateEdits = async (customerId, notesById, edits) => {
  const seen = new Set();
  const customer = await Customer.findById(customerId).select("+erp").lean();
  if (!customer) throw new Error("הלקוח של החשבונית לא נמצא");
  const percent = await discountPercentFor(customer);

  for (const edit of edits) {
    const id = String(edit.noteId || "");
    const note = notesById.get(id);
    if (!note) {
      throw new Error(`תעודה ${id} אינה חלק מהחשבונית הזו`);
    }
    if (seen.has(id)) {
      throw new Error(`תעודה ${note.number} נשלחה פעמיים באותה בקשה`);
    }
    seen.add(id);

    if (edit.remove) continue;

    // זורק על מק"ט שאינו בקטלוג, כמות לא חוקית או שורה בלי מחיר.
    // התוצאה משמשת גם לבדיקת ההנחה בהמשך, ולכן מחושבת פעם אחת.
    //
    // כן, זה מתמחר כל תעודה פעמיים — כאן ושוב בעריכה עצמה. זה נבחר
    // ביודעין: פנייה נוספת למחירון היא המחיר על כך שמק"ט שגוי לא יגלה
    // את עצמו רק אחרי שהזיכוי כבר הופק. הפעולה ידנית ונדירה, והתעודות
    // שנערכות הן בודדות.
    let items = note.items;
    if (edit.items !== undefined) {
      if (!Array.isArray(edit.items) || !edit.items.length) {
        throw new Error(`תעודה ${note.number}: תעודה חייבת לכלול לפחות שורה אחת`);
      }
      ({ items } = await deliveryNotes.buildPricedItems(customerId, edit.items));
    }

    if (edit.shippingCost !== undefined && Number(edit.shippingCost) < 0) {
      throw new Error(`תעודה ${note.number}: דמי משלוח לא יכולים להיות שליליים`);
    }
    if (edit.discount !== undefined && Number(edit.discount) < 0) {
      throw new Error(`תעודה ${note.number}: הנחה לא יכולה להיות שלילית`);
    }

    if (edit.issuedAt !== undefined) {
      const parsed = new Date(edit.issuedAt);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`תעודה ${note.number}: תאריך מסירה לא תקין`);
      }
      if (israelDay(parsed) > israelDay(new Date())) {
        throw new Error(`תעודה ${note.number}: לא ניתן לתארך תעודה לעתיד`);
      }
    }

    // אותה בדיקה שבעריכה עצמה, כאן כדי שהיא תיפול לפני הזיכוי ולא אחריו.
    // המספרים מחושבים באותו סדר כמו ב-deliveryNotes.update.
    const subTotal = money(items.reduce((s, i) => s + Number(i.lineTotal || 0), 0));
    const shipping =
      edit.shippingCost === undefined ? Number(note.shippingCost) || 0 : Number(edit.shippingCost) || 0;
    const previousManual = Math.max(
      0,
      money(Number(note.discount || 0) - Number(note.customerDiscount || 0))
    );
    const manual = edit.discount === undefined ? previousManual : Number(edit.discount) || 0;
    const total = money(manual + discountAmount(Math.max(0, subTotal - manual), percent));

    if (total > subTotal + shipping) {
      throw new Error(
        `תעודה ${note.number}: ההנחה (${total}) גדולה מסכום התעודה (${money(subTotal + shipping)})`
      );
    }
  }
};

/**
 * חשבוניות שתיקון שלהן רץ כרגע.
 *
 * הזיכוי נוצר ב-iCount *לפני* שהתעודות מסומנות, וזו פנייה שנמשכת שניות.
 * שתי בקשות שנכנסות לחלון הזה מפיקות שני מסמכי זיכוי על אותה חשבונית —
 * שני מסמכי מס שאי אפשר למחוק, ותיקון ידני מול רואה החשבון.
 *
 * ניסיון חוזר *אחרי* שהתיקון הסתיים כבר מוגן מעצמו: מספר החשבונית ירד
 * מהתעודות, והבקשה השנייה לא תמצא מה לזכות. מה שנשאר לכסות הוא החפיפה,
 * וזה בדיוק מה שהנעילה הזאת עושה.
 *
 * ⚠️ נעילה בתהליך ולא במסד: היא מכסה לחיצה כפולה, שני טאבים ושני
 *    משתמשים על אותו שרת — כלומר את מה שקורה בפועל. שני תהליכי Node
 *    במקביל היו עוקפים אותה, ולשם כך נדרשת נעילה במסד.
 */
const inFlight = new Set();

/**
 * זיכוי החשבונית, תיקון התעודות והפקת חשבונית חדשה במקומה.
 *
 * הגוף בלבד — הכניסה היא reissueInvoice, שמוסיף את בדיקות הקלט ואת
 * הנעילה מפני בקשה כפולה.
 *
 * @param {object} p
 * @param {string} p.icountDocNum      - החשבונית שמתקנים
 * @param {string} p.reason            - סיבת הזיכוי. מודפסת על מסמך הזיכוי
 * @param {Array}  [p.edits]           - תיקונים לתעודות. ריק = הפקה מחדש
 *        כמו שהיא (למשל חשבונית שיצאה ללקוח הלא נכון במייל).
 *        כל פריט: {noteId, items?, shippingCost?, discount?, issuedAt?,
 *        manualReference?, notes?, remove?}
 * @param {boolean} [p.allowPaid]      - אישור מפורש לתקן חשבונית ששולמה.
 *        בלעדיו חשבונית עם קבלה נדחית: הזיכוי מנתק את הקבלה מהחשבונית,
 *        והכסף שהתקבל נשאר בלי מסמך שמסביר אותו.
 * @param {boolean} [p.emailDocument]  - כפייה של שליחה/אי-שליחה במייל
 * @param {string} [p.changedBy]
 * @returns {Promise<object>}
 */
const runReissue = async ({
  icountDocNum,
  reason,
  edits = [],
  allowPaid = false,
  emailDocument,
  changedBy,
}) => {
  const notes = await notesOfInvoice(icountDocNum);
  if (!notes.length) {
    throw new Error(`לא נמצאו תעודות שחויבו בחשבונית ${icountDocNum}`);
  }

  // כל התעודות של חשבונית שייכות ללקוח אחד. אם לא — משהו שבור בנתונים,
  // והמשך היה מפיק חשבונית חדשה על שם הלקוח הראשון בלבד.
  const customerIds = [...new Set(notes.map((n) => String(n.customer)))];
  if (customerIds.length > 1) {
    throw new Error(
      `חשבונית ${icountDocNum} מקושרת ל-${customerIds.length} לקוחות — יש לטפל בה ידנית`
    );
  }
  const customerId = customerIds[0];

  const paid = notes.find((n) => ledger.of(n).paidAt);
  if (paid && !allowPaid) {
    const pocket = ledger.of(paid);
    throw new Error(
      `לחשבונית ${icountDocNum} כבר נרשם תשלום` +
        (pocket.receiptDocNum ? ` (קבלה ${pocket.receiptDocNum})` : "") +
        ". הזיכוי ינתק את הקבלה מהחשבונית, והיא תישאר ב-iCount בלי חשבונית מולה — " +
        "יש לאשר זאת במפורש ולטפל בקבלה מול ההנהלת חשבונות."
    );
  }

  const notesById = new Map(notes.map((n) => [String(n._id), n]));
  const list = Array.isArray(edits) ? edits : [];

  // מצב הדגמה: הזיכוי והחשבונית החדשה נרשמים בכיס הדמו ואינם נוגעים
  // בחיוב האמיתי, אבל עריכת תעודה וביטולה *כן* — deliveryNotes.update
  // כותב את השורות והסכומים לתעודה עצמה, ו-cancel מבטל אותה באמת.
  // תעודה שנראית בדמו כ"מחויבת" היא בפועל תעודה פתוחה של לקוח אמיתי,
  // ושינוי שלה בהדגמה הוא שינוי בסחורה שעוד תחויב.
  if (list.length && isDemoMode()) {
    throw new Error(
      "במצב הדגמה אי אפשר לתקן את תוכן התעודות — העריכה הייתה משנה את " +
        "התעודה האמיתית ולא את כיס הדמו. אפשר להפיק זיכוי וחשבונית חדשה בלי שינויים."
    );
  }

  // כל מה שאפשר לפסול נפסל כאן, לפני שיוצא מסמך מס. לפני ספירת ההסרות
  // ולא אחריה: הספירה סומכת על כך שכל מזהה שייך לחשבונית ומופיע פעם אחת,
  // ושתי אלה נבדקות כאן.
  await validateEdits(customerId, notesById, list);

  const removedIds = new Set(
    list.filter((e) => e.remove).map((e) => String(e.noteId))
  );
  if (removedIds.size === notes.length) {
    throw new Error(
      "כל התעודות סומנו להסרה — במקרה כזה מדובר בזיכוי בלבד ולא בהפקה מחדש. " +
        'יש להשתמש בכפתור "זיכוי".'
    );
  }

  // ── מכאן והלאה: כשלון אינו מבטל את מה שכבר קרה ──
  const problems = [];

  const credit = await monthlyBilling.creditInvoice({
    icountDocNum,
    reason: String(reason).trim(),
    reopenNotes: true,
  });

  const edited = [];
  const removed = [];

  for (const edit of list) {
    const note = notesById.get(String(edit.noteId));
    try {
      if (edit.remove) {
        await deliveryNotes.cancel(edit.noteId, `${reason} — הוסרה מהחשבונית`);
        removed.push(note.number);
        continue;
      }
      await deliveryNotes.update(edit.noteId, {
        items: edit.items,
        shippingCost: edit.shippingCost,
        discount: edit.discount,
        issuedAt: edit.issuedAt,
        manualReference: edit.manualReference,
        notes: edit.notes,
        changedBy,
        // בלי הדפסה: הסחורה כבר נמסרה מזמן, והמסמך שהלקוח מקבל על התיקון
        // הוא החשבונית החדשה. מי שכן צריך נייר מדפיס מהתעודה עצמה.
        reprint: false,
      });
      edited.push(note.number);
    } catch (err) {
      problems.push(`תעודה ${note?.number ?? edit.noteId}: ${err.message}`);
    }
  }

  // תעודה שהעריכה שלה נכשלה נשארת פתוחה עם התוכן הישן, ולכן היא כן
  // נכנסת לחשבונית החדשה. זו ההתנהגות הנכונה — הסחורה יצאה — וה-problem
  // שנרשם עליה אומר למי שלחץ מה עדיין לא תוקן.
  const toBill = notes
    .map((n) => String(n._id))
    .filter((id) => !removedIds.has(id));

  let invoices = [];
  try {
    const result = await monthlyBilling.billNotesNow({
      customerId,
      noteIds: toBill,
      emailDocument,
    });
    invoices = result.invoices || [];
  } catch (err) {
    // לקוח עם פיצול לפי קטגוריה מפיק כמה חשבוניות, והשנייה יכולה להיכשל
    // אחרי שהראשונה כבר קיימת ב-iCount. partialInvoices הוא הדרך היחידה
    // לדעת עליה — בלעדיו התשובה הייתה אומרת "לא הופקה חשבונית" בזמן
    // שמסמך מס כבר יצא ללקוח.
    invoices = err.partialInvoices || [];
    problems.push(`הפקת החשבונית החדשה נכשלה: ${err.message}`);
  }

  return {
    creditDocNum: credit.creditDocNum,
    creditDocUrl: credit.url || null,
    invoices,
    docNums: invoices.map((i) => i.docNum),
    editedNotes: edited,
    removedNotes: removed,
    noteCount: toBill.length,
    problems,
    // done = הכל עבר. credited = הזיכוי יצא והחשבונית החדשה לא —
    // התעודות פתוחות וממתינות, וזה מה שהמסך חייב לומר.
    stage: invoices.length ? (problems.length ? "partial" : "done") : "credited",
  };
};

const reissueInvoice = async (params = {}) => {
  const { icountDocNum, reason } = params;
  if (!icountDocNum) throw new Error("חסר מספר החשבונית");
  if (!reason || !String(reason).trim()) throw new Error("חובה לציין סיבת תיקון");

  const key = String(icountDocNum);
  if (inFlight.has(key)) {
    throw new Error(`תיקון החשבונית ${icountDocNum} כבר רץ כרגע — יש להמתין לסיומו`);
  }
  inFlight.add(key);

  // finally ולא ניקוי בסוף הגוף: תקלה שמפילה את התיקון חייבת לשחרר את
  // הנעילה, אחרת החשבונית הזו נחסמת עד להפעלה מחדש של השרת
  try {
    return await runReissue(params);
  } finally {
    inFlight.delete(key);
  }
};

module.exports = { reissueInvoice };

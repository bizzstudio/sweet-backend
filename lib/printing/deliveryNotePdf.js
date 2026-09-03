// lib/printing/deliveryNotePdf.js
//
// תעודת משלוח כ-PDF בגודל A4, לצורך הדפסה אוטומטית.
//
// הפריסה היא העתק של המסמך שמוצג באדמין (sweet-admin/src/pages/BillingDocument.jsx).
// היא נכתבה כאן מחדש בכוונה, ולא הוצאה משם לספרייה משותפת: המסך הוא React
// בתוך אפליקציית Vite עם Tailwind, והשרת צריך HTML עצמאי בלי שום תלות בבנייה
// של הפרונט. השכפול הזה הוא המחיר, והוא מוגבל למה שנראה על הנייר.
//
// ⚠️ שינוי בפריסה במסך צריך להגיע גם לכאן, אחרת המסמך המודפס אוטומטית
//    ייראה אחרת מזה שמדפיסים ידנית מהמסך.
//
// המזהה הראשון בטבלה הוא הברקוד, והמק"ט אחריו — כמו במסך. זו הבקשה של
// הלקוחה: הברקוד הוא מה שמופיע על האריזה ועל המדף, וזה מה שמצליבים מולו.
//
// ⚠️ הברקוד אינו ייחודי במסד (7 קבוצות של ברקוד כפול; ראה utils/barcode.js),
//    ולכן המק"ט נשאר בעמודה שלצידו ואינו נמחק — הוא ההכרעה כששני מוצרים
//    נושאים את אותו ברקוד. barcodeOf כבר מסנן את ערכי הזבל מהייבוא, ושורה
//    שאין לה ברקוד תקין מציגה "—" ומזוהה במק"ט בלבד.
//
// למה HTML → Chromium ולא ספריית PDF: עברית היא RTL עם BiDi (מספרים
// ומק"טים לטיניים בתוך טקסט עברי), וספריות PDF דורשות טיפול ידני בכל
// שורה כזו. לדפדפן זה מובן מאליו. אותו שיקול בדיוק נעשה בפרויקט האיכר.
//
// דרישת מערכת: puppeteer מוריד Chromium משלו, אבל **גופנים** הוא לוקח
// מהמערכת. על שרת לינוקס בלי גופן עברי המסמך יצא ריבועים. ראו print-agent/README.md.
//
// API חיצוני: generateDeliveryNotePdf(noteId) → Promise<Buffer>

const DeliveryNote = require("../../models/DeliveryNote");
const Setting = require("../../models/Setting");
const { calculateVat } = require("../billing/vat");

/**
 * התעודה אינה קיימת — כלומר נמחקה אחרי שנכנסה לתור.
 *
 * מחלקה נפרדת ולא Error רגיל, כדי שהקורא יוכל להבחין בין "אין מה להדפיס"
 * (סופי — אין טעם לנסות שוב) לבין "ההפקה נכשלה" (זמני — כדאי לנסות).
 */
class NoteNotFoundError extends Error {
  constructor(noteId) {
    super(`תעודה ${noteId} לא נמצאה — כנראה נמחקה אחרי שנכנסה לתור ההדפסה`);
    this.name = "NoteNotFoundError";
  }
}

// תקרת זמן להפקת מסמך אחד. Chromium שנתקע (דף שלא מסיים לצייר, תהליך
// בן שאיבד תגובה) היה משאיר את הבקשה תלויה לנצח ומחזיק דף פתוח בזיכרון,
// והסוכן היה מוותר בצד שלו בלי שהשרת ידע. עמוד A4 בלי משאבים חיצוניים
// נבנה בפחות משנייה; 30 שניות הן שוליים גדולים בכוונה.
const PDF_TIMEOUT_MS = 30 * 1000;

// מספר העותקים של כל תעודה. תעודת משלוח יוצאת לרוב בשניים — אחד ללקוח
// ואחד חוזר חתום — ואז כל עותק נושא כותרת משלו ("מקור" / "העתק").
// ברירת המחדל היא 1 כדי לא לשנות התנהגות בלי החלטה; שינוי ב-.env.
const COPY_LABELS = ["מקור", "העתק", "העתק נוסף"];
const copiesFromEnv = () => {
  const n = parseInt(process.env.DELIVERY_NOTE_COPIES || "1", 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, COPY_LABELS.length);
};

// ‏Chromium משותף לכל השרת ויושב ב-lib/headless-browser. הוא היה כאן, והוצא
// כשנוסף צרכן שני (פתיחת קישור הזמנה מהמייל) — שני דפדפנים היו מכפילים
// כ-100MB בשרת צר, ושתי העתקות של לוגיקת ההתאוששות היו נפרדות בעדכון הבא.
const { getBrowser, closeBrowser } = require("../headless-browser");


// בריחה מ-HTML. שם מוצר עם & או < היה שובר את המסמך בשקט — או גרוע מזה,
// מזריק תגית. הנתונים מגיעים מהקטלוג ומטפסים באדמין, כלומר לא נשלטים.
const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const money = (n) =>
  Number(n || 0).toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const hebDate = (d) =>
  d ? new Date(d).toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" }) : "—";

/** שורה בבלוק פרטים — מוחזרת ריקה כשאין ערך, כדי שלא תישאר תווית יתומה. */
const line = (label, value) =>
  value ? `<p class="sm">${label ? `${esc(label)} ` : ""}${esc(value)}</p>` : "";

const renderPage = ({ note, totals, company, copyLabel }) => {
  const snap = note.customerSnapshot || {};
  const items = Array.isArray(note.items) ? note.items : [];

  const rows = items
    .map(
      (item, i) => `
        <tr>
          <td>${i + 1}</td>
          <td class="id">${esc(item.barcode || "—")}</td>
          <td class="muted">${esc(item.sku || "—")}</td>
          <td>${esc(item.name)}${
            item.isVatFree ? ' <span class="muted xs">(פטור ממע"מ)</span>' : ""
          }</td>
          <td class="center">${esc(item.quantity)}</td>
          <td class="ltr-num">${money(item.unitPrice)}</td>
          <td class="ltr-num">${money(item.lineTotal)}</td>
        </tr>`
    )
    .join("");

  return `
  <section class="page">
    <header class="head">
      <div>
        <h1>${esc(company.name)}</h1>
        ${line("ח.פ", company.vatNumber)}
        ${line("", company.address)}
        ${line("טל'", company.phone)}
        ${line("", company.email)}
      </div>
      <div class="head-left">
        <h2>תעודת משלוח${copyLabel ? ` — ${esc(copyLabel)}` : ""}</h2>
        <p class="docnum">${esc(note.number)}</p>
        <p class="sm">תאריך: ${hebDate(note.issuedAt)}</p>
        ${note.orderNumber ? `<p class="sm">הזמנה: ${esc(note.orderNumber)}</p>` : ""}
        ${note.manualReference ? `<p class="sm">תעודה ידנית: ${esc(note.manualReference)}</p>` : ""}
      </div>
    </header>

    <div class="to">
      <p class="label">לכבוד</p>
      <p class="cust">${esc(snap.name || "—")}</p>
      ${line("מס' לקוח:", snap.customerNumber)}
      ${line("ח.פ:", snap.vatId)}
      ${line("", snap.address ? `${snap.address}${snap.city ? `, ${snap.city}` : ""}` : "")}
      ${line("איש קשר:", snap.contactPerson)}
    </div>

    <table class="items">
      <thead>
        <tr>
          <th>#</th>
          <th>ברקוד</th>
          <th>מק"ט</th>
          <th>תיאור</th>
          <th class="center">כמות</th>
          <th class="left">מחיר יח'</th>
          <th class="left">סה"כ</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="totals-wrap">
      <table class="totals">
        <tbody>
          <tr><td>סה"כ פריטים</td><td class="ltr-num">${money(totals.net)} ₪</td></tr>
          ${
            totals.shipping > 0
              ? `<tr><td>משלוח</td><td class="ltr-num">${money(totals.shipping)} ₪</td></tr>`
              : ""
          }
          ${
            totals.discount > 0
              ? `<tr><td>הנחה</td><td class="ltr-num">-${money(totals.discount)} ₪</td></tr>`
              : ""
          }
          <tr class="rule"><td>סה"כ לפני מע"מ</td><td class="ltr-num">${money(
            totals.beforeVat
          )} ₪</td></tr>
          <tr><td>מע"מ 18%</td><td class="ltr-num">${money(totals.vat)} ₪</td></tr>
          <tr class="grand"><td>סה"כ לתשלום</td><td class="ltr-num">${money(
            totals.total
          )} ₪</td></tr>
        </tbody>
      </table>
    </div>

    ${
      note.notes
        ? `<div class="notes"><p class="label">הערות</p><p class="sm pre">${esc(
            note.notes
          )}</p></div>`
        : ""
    }

    <footer>
      <p class="xs muted">
        תעודת משלוח זו אינה מהווה חשבונית מס. חשבונית מרכזת תופק בסוף החודש.
      </p>
      <div class="signatures">
        <div>חתימת המוסר</div>
        <div>חתימת המקבל</div>
      </div>
    </footer>
  </section>`;
};

const renderHtml = ({ note, totals, company, copies }) => {
  const labels = copies > 1 ? COPY_LABELS.slice(0, copies) : [null];
  const pages = labels.map((copyLabel) => renderPage({ note, totals, company, copyLabel })).join("");

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<title>תעודת משלוח ${esc(note.number)}</title>
<style>
  /* גופנים של המערכת בלבד — אין רשת בזמן ההדפסה, וגופן חיצוני היה
     נטען חלקית או בכלל לא, ומשנה את הפריסה בלי התראה. */
  * { box-sizing: border-box; }
  body {
    margin: 0;
    /* השמות מכסים גם שרת לינוקס וגם מק. באובונטו: fonts-noto-core מספק
       את Noto Sans Hebrew, ו-culmus את David/Frank Ruehl כגיבוי. */
    font-family: "Noto Sans Hebrew", "Noto Sans", "David CLM", "Frank Ruehl CLM",
      "DejaVu Sans", "Arial Hebrew", Arial, sans-serif;
    color: #111827;
    background: #fff;
    font-size: 12px;
  }
  /* עמוד לכל עותק. break-after על האחרון היה מוסיף עמוד ריק. */
  .page { padding: 14mm 12mm; page-break-after: always; }
  .page:last-child { page-break-after: auto; }

  h1 { font-size: 20px; margin: 0 0 2px; }
  h2 { font-size: 16px; margin: 0; }
  p  { margin: 2px 0; }
  .sm { font-size: 11px; }
  .xs { font-size: 10px; }
  .muted { color: #6b7280; }
  .center { text-align: center; }
  .pre { white-space: pre-wrap; }

  /* מספרים וסכומים מיושרים לשמאל ומסומנים LTR: בלי זה BiDi הופך
     "1,234.50 ₪" לסדר לא צפוי כשהוא צמוד לטקסט עברי. */
  .ltr-num { text-align: left; direction: ltr; unicode-bidi: embed; }
  /* יישור בלבד, בלי היפוך כיוון — לכותרות העמודות שמעל אותם מספרים.
     הן טקסט עברי, ו-direction:ltr היה מעיף את הגרש של "מחיר יח'" לצד הלא נכון. */
  .left { text-align: left; }

  .head {
    display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 2px solid #1f2937; padding-bottom: 10px;
  }
  .head-left { text-align: left; }
  .docnum { font-size: 26px; font-weight: 700; margin: 2px 0 6px; }

  .to { margin-top: 14px; padding-bottom: 10px; border-bottom: 1px solid #d1d5db; }
  .to .label { font-size: 11px; font-weight: 600; color: #6b7280; }
  .to .cust { font-size: 15px; font-weight: 600; }

  table.items { width: 100%; margin-top: 14px; border-collapse: collapse; font-size: 11px; }
  table.items th {
    background: #f3f4f6; border-bottom: 2px solid #9ca3af;
    padding: 6px 6px; text-align: right;
  }
  table.items td { padding: 5px 6px; border-bottom: 1px solid #e5e7eb; }
  /* המזהה הראשי מודגש, והמק"ט שלצידו אפור — כדי שיהיה ברור לפי מה
     מצליבים מול האריזה */
  table.items td.id { font-weight: 600; }
  /* שורה לא נחתכת בין עמודים כשהתעודה ארוכה מדף אחד */
  table.items tr { page-break-inside: avoid; }

  .totals-wrap { display: flex; justify-content: flex-start; margin-top: 14px; }
  table.totals { width: 70mm; font-size: 11px; border-collapse: collapse; }
  table.totals td { padding: 3px 0; }
  table.totals tr.rule td { border-top: 1px solid #d1d5db; }
  table.totals tr.grand td {
    border-top: 2px solid #1f2937; font-weight: 700; font-size: 13px; padding-top: 6px;
  }

  .notes { margin-top: 14px; padding-top: 8px; border-top: 1px solid #d1d5db; }
  .notes .label { font-size: 11px; font-weight: 600; }

  footer { margin-top: 22px; padding-top: 10px; border-top: 1px solid #d1d5db; }
  .signatures { display: flex; justify-content: space-between; margin-top: 26px; }
  .signatures div {
    width: 60mm; border-top: 1px solid #9ca3af; padding-top: 4px;
    text-align: center; font-size: 11px;
  }
</style>
</head>
<body>${pages}</body>
</html>`;
};

/**
 * מרוץ בין הבטחה לשעון. הטיימר משוחרר בכל מקרה, אחרת התהליך היה נשאר חי
 * עד שהוא פוקע גם כשההפקה הצליחה מזמן.
 */
const withTimeout = (promise, ms, message) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

/** פרטי החברה מההגדרות. נכשל בשקט — מסמך בלי כתובת עדיף על מסמך שלא הודפס. */
const loadCompany = async () => {
  try {
    const doc = await Setting.findOne({ name: "globalSetting" }).lean();
    const s = doc?.setting || {};
    return {
      name: s.company_name || s.shop_name || "",
      address: s.address || "",
      vatNumber: s.vat_number || "",
      email: s.email || "",
      phone: s.contact || "",
    };
  } catch (err) {
    console.error(`[print] טעינת פרטי החברה נכשלה: ${err.message}`);
    return { name: "", address: "", vatNumber: "", email: "", phone: "" };
  }
};

/**
 * מפיק את ה-PDF של תעודת משלוח.
 *
 * @param {string|ObjectId} noteId
 * @returns {Promise<{buffer: Buffer, filename: string, number: number}>}
 */
const generateDeliveryNotePdf = async (noteId) => {
  const note = await DeliveryNote.findById(noteId).lean();
  if (!note) throw new NoteNotFoundError(noteId);

  const [company, browser] = await Promise.all([loadCompany(), getBrowser()]);

  const html = renderHtml({
    note,
    totals: calculateVat(note),
    company,
    copies: copiesFromEnv(),
  });

  let page;
  try {
    page = await browser.newPage();
    // אין משאבים חיצוניים במסמך, ולכן domcontentloaded מספיק ו-networkidle0
    // רק היה מוסיף חצי שנייה של המתנה לכלום.
    page.setDefaultTimeout(PDF_TIMEOUT_MS);

    // אין שורת JavaScript אחת במסמך, ולכן כיבוי המנוע לא מוריד דבר —
    // אבל הוא סוגר את הנתיב שבו שם מוצר או הערה של לקוח (טקסט שמגיע
    // מבחוץ) היו יכולים להריץ קוד בתוך Chromium אם בריחת ה-HTML תישבר
    // אי פעם. שכבה שנייה, בחינם.
    await page.setJavaScriptEnabled(false);

    await page.setContent(html, { waitUntil: "domcontentloaded" });

    // ל-page.pdf אין timeout משלו בכל גרסאות puppeteer, ולכן המרוץ הזה
    // ולא הסתמכות על setDefaultTimeout לבדו.
    const pdf = await withTimeout(
      page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
      }),
      PDF_TIMEOUT_MS,
      `הפקת ה-PDF של תעודה ${note.number} לא הסתיימה בתוך ${PDF_TIMEOUT_MS / 1000} שניות`
    );

    const buffer = Buffer.from(pdf);
    // Chromium מחזיר לפעמים באפר ריק כשהדף נסגר תוך כדי. עדיף להיכשל כאן
    // עם הודעה ברורה מאשר לשלוח לסוכן קובץ שהמדפסת תדחה.
    if (buffer.slice(0, 4).toString() !== "%PDF") {
      throw new Error("יצירת ה-PDF החזירה קובץ לא תקין");
    }

    return { buffer, filename: `delivery-note-${note.number}.pdf`, number: note.number };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (_) {}
    }
  }
};

module.exports = { generateDeliveryNotePdf, closeBrowser, NoteNotFoundError };

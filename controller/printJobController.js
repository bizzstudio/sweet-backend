// controller/printJobController.js
//
// ה-API שסוכן ההדפסה (print-agent/) מדבר איתו. ארבע פעולות, כולן מאחורי
// PRINT_AGENT_TOKEN — הסוכן אינו משתמש באדמין ואין לו התחברות.
//
// זרימה אחת של הסוכן, כל POLL_INTERVAL_SECONDS שניות:
//
//   GET  /api/print-jobs/pending      → תופס עד 5 משימות ומקבל את רשימתן
//   GET  /api/print-jobs/:id/pdf      → מוריד את המסמך
//   POST /api/print-jobs/:id/printed  → יצא מהמדפסת
//   POST /api/print-jobs/:id/failed   → נכשל, עם ההודעה
//
// התפיסה ב-pending היא אטומית (findOneAndUpdate מ-pending ל-printing).
// בלעדיה שני סוכנים שרצים במקביל — או סוכן אחד שהופעל פעמיים על אותו
// מחשב — היו קוראים את אותה רשימה ומדפיסים כל תעודה פעמיים.
//
// כל דיווח סיום מותנה ב-status:"printing". זה לא קישוט: בזמן שהסוכן
// מדפיס יכול אדם ללחוץ "שלח שוב למדפסת", והמשימה מתאפסת ל-pending.
// דיווח לא מותנה היה דורס את הבקשה החדשה, והנייר השני לא היה יוצא לעולם.

const crypto = require("crypto");
const mongoose = require("mongoose");
const PrintJob = require("../models/PrintJob");
const { generateDeliveryNotePdf, NoteNotFoundError } = require("../lib/printing/deliveryNotePdf");

// משימה שנתפסה ולא נסגרה בתוך הזמן הזה נחשבת נטושה — המחשב כובה, הסוכן
// קרס, הרשת נפלה באמצע. היא חוזרת ל-pending בסבב הבא.
const STALE_LOCK_MS = 10 * 60 * 1000;

// אחרי כמה כשלונות מפסיקים לנסות. מדפסת ללא נייר מייצרת כשלון חוזר, ובלי
// התקרה הזו התור היה מנסה אותה משימה לנצח ומסתיר משימות חדשות.
const MAX_ATTEMPTS = 3;

// כמה משימות הסוכן מקבל בבת אחת. גדול מדי = נעילה ארוכה על משימות שממתינות
// בתור של מדפסת אחת ממילא.
const BATCH_SIZE = 5;

// מזהה פגום מפיל את mongoose ב-CastError, כלומר 500 עם stack trace במקום
// תשובה ברורה. הסוכן היה מדווח את זה ככשלון ומנסה שוב עד שהמשימה תינטש.
const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id || ""));

// ── אימות ─────────────────────────────────────────────────────────────────

/**
 * השוואה בזמן קבוע.
 *
 * `a !== b` יוצא ברגע שיש הבדל, וההפרש בזמן התגובה בין ניחוש שהתחיל נכון
 * לניחוש שנפסל מיד ניתן למדידה מהרשת. זו התקפה מוכרת על השוואת סודות,
 * והמחיר להימנע ממנה הוא שורה אחת.
 *
 * timingSafeEqual זורק כשהאורכים שונים, ולכן האורך נבדק קודם — ההשוואה
 * הזו כן דולפת את אורך הטוקן, וזה מידע חסר ערך לתוקף.
 */
const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a), "utf8");
  const bufB = Buffer.from(String(b), "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

const verifyPrintToken = (req, res, next) => {
  const token = process.env.PRINT_AGENT_TOKEN;

  // בלי טוקן מוגדר בשרת המסלול פתוח לכל העולם, ולכן הוא נסגר לגמרי ולא
  // "עובר בלי בדיקה". השגיאה מפורשת כדי שזו לא תהיה תעלומה בפריסה.
  if (!token) {
    console.error("[print] PRINT_AGENT_TOKEN אינו מוגדר — מסלולי ההדפסה חסומים");
    return res.status(503).json({ message: "הדפסה אינה מוגדרת בשרת" });
  }

  const auth = req.headers.authorization || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!provided || !safeEqual(provided, token)) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
};

// ── GET /api/print-jobs/pending ───────────────────────────────────────────
const getPendingJobs = async (req, res) => {
  try {
    // שחרור נעילות תקועות לפני השליפה, אחרת משימה שנתקעה ב-printing לא
    // תודפס לעולם ואיש לא ידע.
    await PrintJob.updateMany(
      { status: "printing", lockedAt: { $lt: new Date(Date.now() - STALE_LOCK_MS) } },
      { $set: { status: "pending", lockedAt: null } }
    );

    // הישנות קודם — תעודה שממתינה מאתמול לא נדחקת ע"י תעודה של עכשיו
    const candidates = await PrintJob.find({ status: "pending" })
      .sort({ createdAt: 1 })
      .limit(BATCH_SIZE)
      .lean();

    if (!candidates.length) return res.json([]);

    const claimed = [];
    for (const candidate of candidates) {
      const locked = await PrintJob.findOneAndUpdate(
        { _id: candidate._id, status: "pending" },
        { $set: { status: "printing", lockedAt: new Date() } },
        { new: true }
      );
      // null = סוכן אחר הקדים אותנו בדיוק כאן, או שהתעודה בוטלה בין
      // השליפה לתפיסה. שניהם תקינים — מדלגים.
      if (locked) {
        // ?? null ולא השדה הגולמי: express משמיט מה-JSON מפתח שערכו
        // undefined, וסוכן ה-PowerShell רץ תחת Set-StrictMode — גישה
        // לשדה שאינו קיים בתשובה הייתה זורקת אצלו ומפילה את כל סבב
        // ההדפסה, לא רק את המשימה הזו.
        claimed.push({
          _id: locked._id,
          docType: locked.docType,
          docId: locked.docId,
          docNumber: locked.docNumber ?? null,
        });
      }
    }

    return res.json(claimed);
  } catch (err) {
    console.error("[print] getPendingJobs:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/print-jobs/:id/pdf ───────────────────────────────────────────
const getJobPdf = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: "מזהה משימה לא תקין" });
    }

    const job = await PrintJob.findById(req.params.id).lean();
    if (!job) return res.status(404).json({ message: "משימת הדפסה לא נמצאה" });

    // הגנה קדימה: היום ה-enum במודל מתיר רק deliveryNote, אבל ברגע
    // שיתווסף סוג נוסף בלי טיפול כאן — הסוכן היה מקבל תעודת משלוח במקום
    // המסמך הנכון, וזו טעות שקטה.
    if (job.docType !== "deliveryNote") {
      return res.status(400).json({ message: `סוג מסמך לא נתמך: ${job.docType}` });
    }

    let pdf;
    try {
      pdf = await generateDeliveryNotePdf(job.docId);
    } catch (err) {
      // תעודה שנמחקה לא תחזור להיות קיימת בניסיון הבא. שלושה סבבים של
      // הורדה, כשלון והמתנה על מסמך שאינו קיים הם בזבוז שמסתיים באותה
      // תוצאה — ולכן המשימה נסגרת מיד, עם סיבה שקריאה במסך.
      if (err instanceof NoteNotFoundError) {
        await PrintJob.updateOne(
          { _id: job._id },
          { $set: { status: "failed", lockedAt: null, lastError: err.message } }
        );
        console.error(`[print] משימה ${job._id}: ${err.message} — נסגרה בלי ניסיונות נוספים`);
        return res.status(410).json({ message: err.message });
      }
      throw err;
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${pdf.filename}"`);
    res.setHeader("Content-Length", pdf.buffer.length);
    return res.end(pdf.buffer);
  } catch (err) {
    console.error("[print] getJobPdf:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/print-jobs/:id/printed ──────────────────────────────────────
const markPrinted = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: "מזהה משימה לא תקין" });
    }

    const job = await PrintJob.findOneAndUpdate(
      { _id: req.params.id, status: "printing" },
      { $set: { status: "printed", printedAt: new Date(), lockedAt: null, lastError: null } },
      { new: true }
    );

    if (!job) return respondToStaleReport(req, res, "printed");

    console.log(`[print] תעודה ${job.docNumber || job.docId} הודפסה`);
    res.json({ message: "סומן כהודפס", jobId: job._id });
  } catch (err) {
    console.error("[print] markPrinted:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/print-jobs/:id/failed ───────────────────────────────────────
// מחזיר ל-pending כל עוד לא מוצו הניסיונות; אחרת failed לטיפול ידני.
const markFailed = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: "מזהה משימה לא תקין" });
    }

    const error = String(req.body?.error || "שגיאה לא ידועה").slice(0, 2000);

    // שני שלבים, ובכוונה: בשלב הראשון הסטטוס **נשאר** printing, ולכן אף
    // סוכן לא יכול לתפוס את המשימה בין השניים. השלב השני מותנה גם הוא
    // ב-printing, כך שבקשת הדפסה חוזרת שנכנסה באמצע (והעבירה ל-pending)
    // אינה נדרסת.
    const job = await PrintJob.findOneAndUpdate(
      { _id: req.params.id, status: "printing" },
      { $inc: { attempts: 1 }, $set: { lastError: error } },
      { new: true }
    );

    if (!job) return respondToStaleReport(req, res, "failed");

    const status = job.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
    await PrintJob.updateOne(
      { _id: job._id, status: "printing" },
      { $set: { status, lockedAt: null } }
    );

    // אזהרה ולא console.log: תעודה שלא הודפסה היא סחורה שיוצאת בלי נייר,
    // וזה צריך להיראות בלוג.
    console.error(
      `[print] תעודה ${job.docNumber || job.docId} — ניסיון ${job.attempts}/${MAX_ATTEMPTS} נכשל: ${error}` +
        (status === "failed" ? " — ננטש, נדרשת הדפסה ידנית" : "")
    );

    res.json({ message: `סומן כ-${status}`, attempts: job.attempts });
  } catch (err) {
    console.error("[print] markFailed:", err);
    res.status(500).json({ message: err.message });
  }
};

/**
 * דיווח על משימה שכבר אינה ב-printing.
 *
 * שני מצבים אפשריים, ושניהם תקינים:
 *   - הנעילה שוחררה כנטושה והמשימה נתפסה מחדש (הסוכן איחר מ-STALE_LOCK_MS)
 *   - אדם לחץ "שלח שוב למדפסת" בזמן שהסוכן הדפיס
 *
 * בשניהם התשובה היא 200 ולא שגיאה: הסוכן סיים את מה שהיה עליו לעשות,
 * ותשובת שגיאה רק הייתה גורמת לו לנסות לדווח שוב על משימה שאינה שלו.
 */
const respondToStaleReport = async (req, res, kind) => {
  const exists = await PrintJob.exists({ _id: req.params.id });
  if (!exists) return res.status(404).json({ message: "משימת הדפסה לא נמצאה" });

  console.warn(
    `[print] דיווח "${kind}" על משימה ${req.params.id} שכבר אינה בהדפסה — ` +
      `כנראה הוגשה בקשת הדפסה חוזרת באמצע. הדיווח לא שינה דבר.`
  );
  return res.json({ message: "המשימה כבר אינה בהדפסה — הדיווח לא שינה דבר" });
};

module.exports = { verifyPrintToken, getPendingJobs, getJobPdf, markPrinted, markFailed };

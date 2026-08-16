// lib/billing/monthEndCron.js
//
// סגירת חודש אוטומטית. ביום האחרון של החודש (30, 31, ובפברואר 28/29) בשעה
// 23:00 (שעון ישראל) המערכת סוגרת את כל תעודות המשלוח הפתוחות של אותו חודש
// ומפיקה חשבוניות ב-iCount, ואז שולחת מייל עם מה שהופק.
//
// הסגירה היא של החודש שרץ, לא של הקודם: חשבונית אוגוסט יוצאת ב-31 באוגוסט.
// תעודה שתיפתח אחרי 23:00 באותו יום תישאר פתוחה ותיאסף בסגירה הבאה — הסגירה
// אוספת תמיד גם כל מה שנשאר פתוח מחודשים קודמים.
//
// ⚠️ זו פעולה בלתי הפיכה שרצה בלי אדם. חשבונית מס אינה ניתנת למחיקה, רק
//    לזיכוי — וכל זיכוי נרשם בספרים ומגיע לרואה החשבון. המשמעות: כל טעות
//    במחירים או בתעודות הופכת בלילה אחד לעשרות מסמכי מס שגויים.
//
//    כיבוי: BILLING_AUTO_CLOSE=false ב-.env. לא נדרש שינוי קוד.
//
// ההגנות שכן פועלות גם במצב אוטומטי:
//   - תפיסה אטומית של התעודות לפני הפנייה ל-iCount (אין חיוב כפול גם אם
//     הריצה חופפת ללחיצה ידנית)
//   - שחרור תעודות שנתקעו, כל שעה
//   - כשלון בלקוח אחד אינו עוצר את השאר; התעודות שלו נשארות פתוחות

const cron = require("node-cron");
const {
  closeMonth,
  previousMonth,
  isLastDayOfMonth,
  releaseStuckClaims,
  billingMonthOf,
} = require("./monthlyBilling");
const { sendEmailSilent } = require("../email-sender/sender");

// ברירת המחדל היא אוטומטי. רק "false" מפורש מכבה — ערך חסר או שגוי לא
// אמור להשתיק בשקט תהליך שהלקוחה ביקשה שירוץ.
const isAutoEnabled = () =>
  String(process.env.BILLING_AUTO_CLOSE ?? "true").toLowerCase() !== "false";

const shekel = (n) =>
  Number(n || 0).toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const recipients = () =>
  (process.env.BILLING_REPORT_EMAIL || process.env.ADMINS_EMAILS || process.env.EMAIL_USER || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

const rowsHtml = (results, withDocNum) =>
  results
    .flatMap((r) =>
      r.invoices.map(
        (inv) => `
        <tr>
          <td style="padding:6px 10px;border-bottom:1px solid #eee">${r.customerName}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee">${inv.category || "—"}</td>
          ${withDocNum ? `<td style="padding:6px 10px;border-bottom:1px solid #eee;font-family:monospace">${inv.docNum}</td>` : ""}
          <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center">${inv.noteCount}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:left">${shekel(inv.netTotal)} ₪</td>
        </tr>`
      )
    )
    .join("");

const buildBody = (result, adminUrl) => {
  const net = result.results.reduce(
    (s, r) => s + r.invoices.reduce((a, i) => a + i.netTotal, 0),
    0
  );

  return `
    <div dir="rtl" style="font-family:Arial,sans-serif;color:#222">
      <h2>סגירת חודש ${result.month} — הושלמה</h2>
      <p style="background:#ecfdf5;padding:10px;border-right:4px solid #10b981">
        הופקו <strong>${result.invoicesCreated} חשבוניות מס</strong> ל-${result.customersProcessed}
        לקוחות, בסך <strong>${shekel(net)} ₪</strong> לפני מע"מ
        (כ-${shekel(net * 1.18)} ₪ כולל).
      </p>
      <p><a href="${adminUrl}/monthly-billing" style="background:#10b981;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">פתיחת מסך החיוב</a></p>
      <table style="border-collapse:collapse;margin-top:16px;font-size:14px">
        <thead>
          <tr style="background:#f5f5f5">
            <th style="padding:6px 10px;text-align:right">לקוח</th>
            <th style="padding:6px 10px;text-align:right">קטגוריה</th>
            <th style="padding:6px 10px;text-align:right">חשבונית</th>
            <th style="padding:6px 10px">תעודות</th>
            <th style="padding:6px 10px;text-align:left">לפני מע"מ</th>
          </tr>
        </thead>
        <tbody>${rowsHtml(result.results, true)}</tbody>
      </table>
      ${
        result.failures.length
          ? `<div style="margin-top:16px;background:#fef2f2;padding:10px;border-right:4px solid #dc2626">
               <strong style="color:#b91c1c">${result.failures.length} לקוחות נכשלו — התעודות שלהם נשארו פתוחות ולא חויבו:</strong>
               <ul style="color:#b91c1c">${result.failures
                 .map((f) => `<li>${f.customerName || f.customerId}: ${f.message}</li>`)
                 .join("")}</ul>
             </div>`
          : ""
      }
    </div>`;
};

/**
 * הריצה החודשית. מיוצאת כדי שאפשר יהיה להריץ ידנית לבדיקה.
 *
 * ביום האחרון של החודש — סוגרת את החודש הזה. בכל יום אחר (הרצת בדיקה) —
 * את החודש הקודם.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] - חישוב בלבד, בלי להפיק
 */
const runMonthEnd = async ({ dryRun = false } = {}) => {
  // הזמן נלכד פעם אחת, לפני כל await. הריצה מתחילה ב-23:00 ויכולה לחצות
  // חצות: חישוב מחדש אחרי שחרור התעודות היה מקבל "1 בספטמבר", מכוון את
  // הסגירה לספטמבר שטרם התחיל — ואוגוסט לא היה נסגר כלל.
  const startedAt = new Date();

  // ביום הסגירה נסגר החודש שרץ עכשיו. הרצה ידנית באמצע החודש (בדיקה) סוגרת
  // את החודש הקודם, כי החודש הנוכחי עדיין באמת לא הסתיים.
  const isClosingDay = isLastDayOfMonth(startedAt);
  const month = isClosingDay ? billingMonthOf(startedAt) : previousMonth(startedAt);

  // תעודות שנתקעו מריצה קודמת שקרסה לא היו נכללות בחיוב, והלקוח היה
  // מקבל חשבונית חסרה בלי שאף אחד יידע
  await releaseStuckClaims();

  // אם השחרור גלש מעבר לחצות, החודש שנלכד הפך לחודש קודם — והשומר
  // הרגיל מתיר אותו ממילא, גם בלי הדגל
  const result = await closeMonth({ month, dryRun, allowCurrentMonth: isClosingDay });

  if (!result.invoicesCreated) {
    console.log(`[billing] אין תעודות פתוחות לחודש ${month} — לא הופק דבר`);
    return result;
  }

  console.log(
    `[billing] חודש ${month} נסגר${dryRun ? " (הרצה יבשה)" : ""}: ` +
      `${result.invoicesCreated} חשבוניות ל-${result.customersProcessed} לקוחות` +
      (result.failures.length ? ` · ${result.failures.length} כשלונות` : "")
  );

  const to = recipients();
  if (!to.length) {
    console.warn("[billing] לא הוגדרו נמענים — הסיכום לא נשלח");
    return result;
  }

  await sendEmailSilent({
    from: `"${process.env.COMPANY_NAME}" <${process.env.EMAIL_USER}>`,
    to: to.join(","),
    subject: `סגירת חודש ${month} — ${result.invoicesCreated} חשבוניות הופקו`,
    html: buildBody(result, process.env.ADMIN_URL || ""),
  }).catch((err) => console.error("[billing] שליחת סיכום נכשלה:", err.message));

  return result;
};

/**
 * רישום ה-cron. נקרא פעם אחת בעליית השרת.
 */
const register = () => {
  // node-cron אינו תומך ב-"L" (יום אחרון), ולכן הביטוי מכסה את כל הימים
  // שיכולים להיות אחרונים, והבדיקה בפנים מוודאת שזה באמת היום האחרון.
  cron.schedule(
    "0 23 28-31 * *",
    () => {
      if (!isLastDayOfMonth()) return;

      if (!isAutoEnabled()) {
        console.log("[billing] סגירה אוטומטית מכובה (BILLING_AUTO_CLOSE=false) — מדלג");
        return;
      }
      runMonthEnd().catch((err) =>
        console.error("[billing] סגירת חודש אוטומטית נכשלה:", err.message)
      );
    },
    { timezone: "Asia/Jerusalem" }
  );

  // שחרור תעודות תקועות כל שעה, גם כשהסגירה האוטומטית מכובה
  cron.schedule("0 * * * *", () => {
    releaseStuckClaims().catch((err) =>
      console.error("[billing] שחרור תעודות תקועות נכשל:", err.message)
    );
  });

  console.log(
    isAutoEnabled()
      ? "[billing] סגירת חודש אוטומטית פעילה (היום האחרון בחודש, 23:00, שעון ישראל)"
      : "[billing] סגירת חודש אוטומטית מכובה — ההפקה ידנית בלבד"
  );
};

module.exports = { register, runMonthEnd, isAutoEnabled };

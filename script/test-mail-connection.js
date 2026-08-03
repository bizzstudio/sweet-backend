// script/test-mail-connection.js
//
// בדיקה שההתחברות לתיבת המייל עובדת, בלי לגעת בהודעות ובלי DB.
//
// הרצה:   npm run mail:test
//
// מתחבר בקריאה בלבד (readOnly), סופר כמה הודעות יש ולא מסמן כלום.

require("dotenv").config();
const { testConnection, isImapConfigured } = require("../lib/imap-reader");

const run = async () => {
  if (!isImapConfigured()) {
    console.error(
      "\nחסרים EMAIL_USER ו/או EMAIL_PASS ב-.env.\n" +
        "EMAIL_PASS היא סיסמת אפליקציה של גוגל (16 תווים), לא סיסמת החשבון.\n" +
        "הפקה: https://myaccount.google.com/apppasswords\n" +
        "אם ההזמנות מגיעות לתיבה אחרת מזו ששולחת — הגדר IMAP_USER ו-IMAP_PASS.\n"
    );
    process.exit(1);
  }

  try {
    const info = await testConnection();

    console.log("\n────────────────────────────────────────────────────────");
    console.log("החיבור הצליח");
    console.log(`  תיבה:            ${info.user}`);
    console.log(`  שרת:             ${info.host}`);
    console.log(`  תיקייה:          ${info.mailbox}`);
    console.log(`  סה"כ הודעות:     ${info.total}`);
    console.log(`  לא נקראו:        ${info.unread}`);
    console.log(
      `  בחלון הסריקה:    ${info.toScan}  (${info.sinceDays} ימים אחורה, נקראו או לא)`
    );
    console.log(
      "\nהסריקה אינה מדלגת על הודעות שנקראו — פתיחת מייל בג'ימייל אינה מסתירה" +
        "\nאותו מהמערכת. מה שכבר נקלט מזוהה לפי Message-ID ולא נקלט שוב." +
        "\nלשינוי החלון: MAIL_SINCE_DAYS ב-.env."
    );

    if (process.env.INGESTION_USE_EXTERNAL_AI === "true") {
      console.log("\n⚠️  AI חיצוני מודלק — כל הודעה שנסרקת עלולה להיות קריאה בתשלום.");
    }
    console.log("────────────────────────────────────────────────────────\n");
    process.exit(0);
  } catch (err) {
    // imapflow מחזיר "Command failed" בלי פרטים; התשובה של השרת היא המידע האמיתי
    const detail = err.responseText || err.serverResponseCode || "";
    console.error(`\nההתחברות נכשלה: ${err.message}${detail ? `\nתשובת השרת: ${detail}` : ""}\n`);

    // סיסמת אפליקציה של גוגל היא תמיד 16 תווים. אורך אחר = טקסט שנדבק בטעות,
    // וזו הטעות הנפוצה ביותר כאן.
    const pass = process.env.IMAP_PASS || process.env.EMAIL_PASS || "";
    const source = process.env.IMAP_PASS ? "IMAP_PASS" : "EMAIL_PASS";
    if (pass.replace(/\s/g, "").length !== 16) {
      console.error(
        `⚠️  ${source} הוא באורך ${pass.length} תווים. סיסמת אפליקציה של גוגל היא תמיד 16.\n` +
          "   בדוק שלא נדבק שם טקסט אחר.\n"
      );
    }
    if (process.env.IMAP_USER || process.env.IMAP_PASS) {
      console.error(
        "ℹ️  מוגדרים IMAP_USER/IMAP_PASS והם גוברים על EMAIL_USER/EMAIL_PASS.\n" +
          "   אם ההזמנות מגיעות לאותה תיבה ששולחת — מחק את שתי השורות האלה.\n"
      );
    }

    if (err.code === "ETIMEOUT" || /timeout/i.test(err.message)) {
      console.error(
        "החיבור נתקע ולא נענה. בגוגל זה קורה גם על סיסמה שגויה, לא רק על תקלת רשת —\n" +
          "בדוק קודם את הסיסמה, ורק אחר כך את החיבור לאינטרנט או חסימת פורט 993.\n"
      );
    }

    if (/AUTHENTICATIONFAILED|Invalid credentials/i.test(err.message)) {
      console.error(
        "סיבות נפוצות:\n" +
          "  • הסיסמה אינה סיסמת אפליקציה אלא סיסמת החשבון\n" +
          "  • אימות דו-שלבי אינו מופעל בתיבה\n" +
          "  • גישת IMAP כבויה בהגדרות Gmail (הגדרות → העברה ו-POP/IMAP)\n" +
          "  • בתיבת Workspace: מנהל הדומיין חוסם סיסמאות אפליקציה\n"
      );
    }

    process.exit(1);
  }
};

run();

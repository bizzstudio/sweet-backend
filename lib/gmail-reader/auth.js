// lib/gmail-reader/auth.js
//
// חיבור לתיבת המייל של החנות ב-Gmail / Google Workspace.
//
// נתמכות שתי דרכי הזדהות, והמערכת בוחרת לפי מה שמוגדר ב-.env:
//
//   א. Domain-wide delegation (מומלץ ל-Workspace)
//      חשבון שירות שמורשה להתחזות לתיבה. עובד לנצח בלי חידוש טוקנים.
//      דורש: GOOGLE_SERVICE_ACCOUNT_JSON (או קובץ חשבון השירות הקיים) + GMAIL_USER,
//      ואישור חד-פעמי של מנהל ה-Workspace ל-Client ID עם ההרשאה gmail.modify.
//
//   ב. OAuth Refresh Token (עובד גם ל-Gmail פרטי)
//      דורש: GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET, GMAIL_OAUTH_REFRESH_TOKEN.
//      את ה-refresh token מפיקים פעם אחת עם: npm run gmail:token
//
// ההרשאה gmail.modify נדרשת (ולא gmail.readonly) כי אחרי קליטת הודעה אנחנו
// מסמנים אותה כנקראה ומתייגים אותה — כך היא לא נקלטת שוב.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

// אותו קובץ חשבון שירות שמשמש כבר להעלאה ל-Drive (utils/driveUploader.js)
const serviceAccountPath = path.join(__dirname, "..", "..", "utils", "upload-images-435010-b13a3e3ba095.json");

const loadServiceAccount = () => {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch (err) {
      throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON אינו JSON תקין: ${err.message}`);
    }
  }
  if (fs.existsSync(serviceAccountPath)) {
    return require(serviceAccountPath);
  }
  return null;
};

/**
 * מחזיר לקוח Gmail מוכן לשימוש, או זורק שגיאה מפורשת אם אין תצורה.
 * @returns {{gmail: Object, userId: string, method: string}}
 */
const getGmailClient = () => {
  // ── ב. OAuth Refresh Token ──
  // נבדק ראשון: אם הוגדר במפורש, זו הכוונה של המשתמש.
  const {
    GMAIL_OAUTH_CLIENT_ID,
    GMAIL_OAUTH_CLIENT_SECRET,
    GMAIL_OAUTH_REFRESH_TOKEN,
  } = process.env;

  if (GMAIL_OAUTH_CLIENT_ID && GMAIL_OAUTH_CLIENT_SECRET && GMAIL_OAUTH_REFRESH_TOKEN) {
    const oAuth2Client = new google.auth.OAuth2(
      GMAIL_OAUTH_CLIENT_ID,
      GMAIL_OAUTH_CLIENT_SECRET,
      "http://localhost:5555/oauth2callback"
    );
    oAuth2Client.setCredentials({ refresh_token: GMAIL_OAUTH_REFRESH_TOKEN });

    return {
      gmail: google.gmail({ version: "v1", auth: oAuth2Client }),
      // "me" = התיבה שאישרה את ההרשאה
      userId: "me",
      method: "oauth",
    };
  }

  // ── א. Domain-wide delegation ──
  const gmailUser = process.env.GMAIL_USER;
  const serviceAccount = loadServiceAccount();

  if (gmailUser && serviceAccount) {
    const auth = new google.auth.JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: GMAIL_SCOPES,
      // התחזות לתיבה של החנות — זה מה שדורש את אישור מנהל ה-Workspace
      subject: gmailUser,
    });

    return {
      gmail: google.gmail({ version: "v1", auth }),
      userId: gmailUser,
      method: "service-account",
    };
  }

  throw new Error(
    "קליטת מייל אינה מוגדרת. יש להגדיר או GMAIL_USER + חשבון שירות עם domain-wide delegation, " +
      "או GMAIL_OAUTH_CLIENT_ID + GMAIL_OAUTH_CLIENT_SECRET + GMAIL_OAUTH_REFRESH_TOKEN."
  );
};

// האם קליטת המייל מוגדרת בכלל (בלי לזרוק) — לשימוש בהפעלת ה-cron
const isGmailConfigured = () => {
  try {
    getGmailClient();
    return true;
  } catch {
    return false;
  }
};

module.exports = {
  getGmailClient,
  isGmailConfigured,
  GMAIL_SCOPES,
};

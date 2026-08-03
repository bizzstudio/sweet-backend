// script/get-gmail-token.js
//
// הפקת refresh token חד-פעמית לתיבת המייל של החנות.
//
// דרוש רק אם בוחרים בדרך ההזדהות השנייה (OAuth). אם התיבה ב-Google Workspace
// ומעדיפים חשבון שירות עם domain-wide delegation — אין צורך בסקריפט הזה.
//
// הרצה:   npm run gmail:token
//
// לפני ההרצה, ב-Google Cloud Console:
//   1. הפעל את Gmail API בפרויקט.
//   2. צור OAuth client מסוג "Web application".
//   3. הוסף ל-Authorized redirect URIs בדיוק:  http://localhost:5555/oauth2callback
//   4. שים ב-.env:  GMAIL_OAUTH_CLIENT_ID ו-GMAIL_OAUTH_CLIENT_SECRET
//
// בסוף הריצה תקבל GMAIL_OAUTH_REFRESH_TOKEN להעתקה ל-.env.

require("dotenv").config();
const http = require("http");
const { google } = require("googleapis");
const { GMAIL_SCOPES } = require("../lib/gmail-reader/auth");

const PORT = 5555;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const { GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET } = process.env;

if (!GMAIL_OAUTH_CLIENT_ID || !GMAIL_OAUTH_CLIENT_SECRET) {
  console.error(
    "\nחסרים GMAIL_OAUTH_CLIENT_ID ו/או GMAIL_OAUTH_CLIENT_SECRET ב-.env.\n" +
      "צור OAuth client ב-Google Cloud Console והוסף אותם לקובץ, ואז הרץ שוב.\n"
  );
  process.exit(1);
}

const oAuth2Client = new google.auth.OAuth2(
  GMAIL_OAUTH_CLIENT_ID,
  GMAIL_OAUTH_CLIENT_SECRET,
  REDIRECT_URI
);

const authUrl = oAuth2Client.generateAuthUrl({
  // offline הוא מה שמחזיר refresh token
  access_type: "offline",
  scope: GMAIL_SCOPES,
  // prompt=consent מכריח החזרת refresh token חדש גם אם כבר אישרת בעבר
  prompt: "consent",
});

console.log("\n────────────────────────────────────────────────────────");
console.log("פתח את הקישור הבא בדפדפן והתחבר *עם התיבה של החנות*:\n");
console.log(authUrl);
console.log("\nממתין לאישור...");
console.log("────────────────────────────────────────────────────────\n");

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/oauth2callback")) {
    res.writeHead(404).end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  const respond = (message) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<html dir="rtl"><body style="font-family:sans-serif;padding:40px">
      <h2>${message}</h2><p>אפשר לסגור את החלון ולחזור לטרמינל.</p></body></html>`);
  };

  if (error) {
    respond(`האישור נדחה: ${error}`);
    console.error(`\nהאישור נדחה: ${error}\n`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    respond("לא התקבל קוד אישור.");
    return;
  }

  try {
    const { tokens } = await oAuth2Client.getToken(code);

    if (!tokens.refresh_token) {
      respond("לא התקבל refresh token.");
      console.error(
        "\nלא התקבל refresh token. בדרך כלל זה קורה כשהאישור כבר ניתן בעבר —\n" +
          "בטל את הגישה בכתובת https://myaccount.google.com/permissions והרץ שוב.\n"
      );
      server.close();
      process.exit(1);
    }

    // אימות שהטוקן אכן עובד, ואיזו תיבה הוא פותח
    oAuth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: "v1", auth: oAuth2Client });
    const profile = await gmail.users.getProfile({ userId: "me" });

    respond(`החיבור הצליח לתיבה ${profile.data.emailAddress}`);

    console.log("\n────────────────────────────────────────────────────────");
    console.log(`התיבה שחוברה: ${profile.data.emailAddress}`);
    console.log(`הודעות בתיבה: ${profile.data.messagesTotal}`);
    console.log("\nהוסף ל-.env את השורה הבאה:\n");
    console.log(`GMAIL_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log("\nואז הפעל את הסריקה:\n");
    console.log("GMAIL_POLLING_ENABLED=true");
    console.log("────────────────────────────────────────────────────────\n");

    server.close();
    process.exit(0);
  } catch (err) {
    respond(`שגיאה בהחלפת הקוד בטוקן: ${err.message}`);
    console.error(`\nשגיאה: ${err.message}\n`);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`(מאזין על ${REDIRECT_URI})`);
});

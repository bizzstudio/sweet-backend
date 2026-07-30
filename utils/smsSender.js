// utils/smsSender.js — שליחת SMS דרך ספק SMS4FREE
// התיעוד: POST JSON אל https://api.sms4free.co.il/ApiSMS/v2/SendSMS
const axios = require("axios");

const SMS4FREE_URL = "https://api.sms4free.co.il/ApiSMS/v2/SendSMS";

// תיאורי קודי השגיאה של הספק (status שלילי או 0)
const SMS_ERRORS = {
  "0": "שגיאה כללית בשליחת ההודעה",
  "-1": "מפתח / שם משתמש / סיסמה שגויים",
  "-2": "שם או מספר שולח שגוי",
  "-3": "לא נמצאו נמענים",
  "-4": "יתרת הודעות נמוכה - יש לרכוש חבילה",
  "-5": "תוכן ההודעה אינו מתאים",
  "-6": "יש לאמת את מספר השולח מול הספק",
};

/**
 * שולח הודעת SMS אחת.
 * @param {string} recipient - מספר הנמען בפורמט מקומי, למשל 05XXXXXXXX
 * @param {string} message   - תוכן ההודעה
 * @returns {Promise<{status:number, message:string}>}
 */
async function sendSms(recipient, message) {
  const body = {
    key: process.env.SMS4FREE_KEY,
    user: process.env.SMS4FREE_USER,
    pass: process.env.SMS4FREE_PASS,
    sender: process.env.SMS4FREE_SENDER || process.env.SMS4FREE_USER,
    recipient,
    msg: message,
  };

  // validateStatus: () => true - לא זורקים על 4xx/5xx כדי לקרוא את גוף התשובה
  // ולחשוף את סיבת השגיאה האמיתית של הספק (במקום "Request failed with status code 400")
  const response = await axios.post(SMS4FREE_URL, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 15000,
    validateStatus: () => true,
  });

  const data = response.data;

  // status גדול מ-0 = מספר הנמענים שאליהם נשלח בהצלחה
  const status = Number(data?.status);
  if (!(status > 0)) {
    const reason =
      SMS_ERRORS[String(status)] || data?.message || `HTTP ${response.status}`;
    const err = new Error(`SMS4FREE send failed (status=${status}): ${reason}`);
    err.smsStatus = status;
    err.smsReason = reason;
    throw err;
  }

  return data; // { status, message }
}

module.exports = { sendSms, SMS_ERRORS };

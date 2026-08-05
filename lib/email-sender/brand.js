// lib/email-sender/brand.js
// מקור אמת יחיד למיתוג בתבניות המייל.
//
// הלוגו נבנה כ-HTML/CSS ולא כתמונה מרוחקת, מכיוון שרוב תוכנות הדואר חוסמות
// תמונות חיצוניות כברירת מחדל — כך הלוגו נראה תמיד, ואין תלות באחסון חיצוני.
// העיצוב זהה לקובצי הלוגו שבחנות (‎/logo/logo-full.png‎): אותיות כהות עם קו
// מתאר ירוק, ללא רקע וללא מסגרת חיצונית.
//
// קו המתאר נעשה ב-text-shadow (ארבעה כיוונים) ולא ב-webkit-text-stroke, שאינו
// נתמך בדואר. ב-Outlook הצללית מתעלמת והטקסט פשוט נשאר כהה — נפילה נקייה.

const GREEN = "#0d9e6d"; // צבע ההדגשה של האדמין — מילוי האותיות והשורות המשניות
const GREEN_DEEP = "#006300"; // mainColor.dark — קו המתאר של האותיות

const LEGAL_NAME = "מתוקיה של בני";
const ADDRESS = "כינרת 13, בני ברק · מיקוד 5120263";
const PHONES = "טל/פקס: 03-6726954 · פקס: 077-4341920 / 077-4341966";

const FONT = "Assistant, 'Segoe UI', Arial, Helvetica, sans-serif";

// כתובת הלוגו כקובץ תמונה — לשימוש היכן שצריך URL אמיתי (למשל חשבונית PDF).
const STORE_URL = (process.env.STORE_URL || "").replace(/\/+$/, "");
const LOGO_IMAGE_URL = STORE_URL ? `${STORE_URL}/logo/logo-full.png` : "";

/**
 * בלוק הלוגו לכותרת המייל.
 * @param {{compact?: boolean}} [opts] compact = שם בלבד, בלי פרטי הקשר.
 * @returns {string} HTML בטוח לדואר (טבלאות + עיצוב inline בלבד).
 */
function logoBlock({ compact = false } = {}) {
  const details = compact
    ? ""
    : `
              <div style="font-size:13px;font-weight:600;color:${GREEN};padding-top:9px;line-height:1.5;">${ADDRESS}</div>
              <div style="font-size:12px;font-weight:500;color:${GREEN};padding-top:2px;line-height:1.5;">${PHONES}</div>`;

  return `
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center" style="border-collapse:separate;margin:0 auto;">
        <tbody>
          <tr>
            <td dir="rtl" align="center" style="padding:10px 16px;text-align:center;font-family:${FONT};">
              <div style="font-size:24px;font-weight:700;color:${GREEN};line-height:1.35;white-space:nowrap;text-shadow:-1px -1px 0 ${GREEN_DEEP},1px -1px 0 ${GREEN_DEEP},-1px 1px 0 ${GREEN_DEEP},1px 1px 0 ${GREEN_DEEP};">${LEGAL_NAME}</div>${details}
            </td>
          </tr>
        </tbody>
      </table>`;
}

module.exports = {
  GREEN,
  GREEN_DEEP,
  LEGAL_NAME,
  ADDRESS,
  PHONES,
  STORE_URL,
  LOGO_IMAGE_URL,
  logoBlock,
};

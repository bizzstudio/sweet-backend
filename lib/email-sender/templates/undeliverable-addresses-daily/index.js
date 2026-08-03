// lib/email-sender/templates/undeliverable-addresses-daily/index.js
const { logoBlock } = require("../../brand");

const reasonLabel = (reason) => {
  if (reason === 'no_delivery_days') return 'אין ימי משלוח לעיר';
  return 'אין יעד משלוח לעיר';
};

const undeliverableAddressesDailyBody = (rows, dateLabel) => {
  const rowsHtml = rows
    .map(
      (row) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-size:13px;color:#374151;">
            ${row.createdAt ? new Date(row.createdAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : '—'}
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-size:13px;color:#374151;">
            ${row.customerName || '—'}
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-size:13px;color:#374151;direction:ltr;">
            ${row.customerPhone || '—'}
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-size:13px;color:#374151;">
            ${row.cityNameHe || '—'}
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-size:13px;color:#374151;">
            ${reasonLabel(row.reason)}
          </td>
        </tr>`
    )
    .join('');

  return `
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;direction:rtl;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 0;">
    <tr>
      <td align="center">
        <div style="padding-bottom:20px;">${logoBlock()}</div>
        <table width="700" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:#dc2626;padding:24px 32px;text-align:right;">
              <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">
                📍 כתובות שלא נמצאו – ${dateLabel}
              </h1>
              <p style="margin:6px 0 0;color:#fecaca;font-size:13px;">
                ${rows.length} רשומות נמצאו עבור יום זה
              </p>
            </td>
          </tr>

          <!-- Table -->
          <tr>
            <td style="padding:24px 32px;">
              <p style="margin:0 0 16px;font-size:13px;color:#6b7280;">
                להלן רשימת הכתובות שניסו לרכוש משלוח אך לא נמצא עבורן יעד משלוח או ימי חלוקה.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                <thead>
                  <tr style="background:#f9fafb;">
                    <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">תאריך ושעה</th>
                    <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">שם הלקוח</th>
                    <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">טלפון</th>
                    <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">עיר</th>
                    <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">סיבה</th>
                  </tr>
                </thead>
                <tbody>
                  ${rowsHtml}
                </tbody>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f9fafb;padding:16px 32px;text-align:right;border-top:1px solid #e5e7eb;">
              <p style="margin:0;font-size:12px;color:#9ca3af;">
                דוח זה נשלח אוטומטית בסוף כל יום. © ${process.env.COMPANY_NAME || ''}
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

module.exports = { undeliverableAddressesDailyBody };

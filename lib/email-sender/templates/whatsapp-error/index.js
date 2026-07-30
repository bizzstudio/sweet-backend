const whatsappErrorEmailBody = (option) => {
  const { failedMessages, timestamp, serverInfo } = option;

  // יצירת HTML table עבור כל הודעה שנכשלה
  const messagesTableRows = failedMessages.map((msg, index) => `
    <tr style="border-bottom: 1px solid #e5e7eb;">
      <td style="padding: 12px; border: 1px solid #e5e7eb; background-color: ${index % 2 === 0 ? '#f9fafb' : '#ffffff'}; font-size: 14px;">${index + 1}</td>
      <td style="padding: 12px; border: 1px solid #e5e7eb; background-color: ${index % 2 === 0 ? '#f9fafb' : '#ffffff'}; font-size: 14px; font-weight: bold; color: #dc2626;">${msg.orderInvoice || 'לא זמין'}</td>
      <td style="padding: 12px; border: 1px solid #e5e7eb; background-color: ${index % 2 === 0 ? '#f9fafb' : '#ffffff'}; font-size: 14px; direction: ltr;">${msg.userPhone || 'לא זמין'}</td>
      <td style="padding: 12px; border: 1px solid #e5e7eb; background-color: ${index % 2 === 0 ? '#f9fafb' : '#ffffff'}; font-size: 14px;">
        <span style="padding: 4px 8px; border-radius: 4px; background-color: ${msg.messageType === 'survey' ? '#fef3c7' : msg.messageType === 'order-ready' ? '#dbeafe' : '#f3f4f6'}; color: ${msg.messageType === 'survey' ? '#92400e' : msg.messageType === 'order-ready' ? '#1e40af' : '#374151'}; font-size: 12px; font-weight: 500;">
          ${msg.messageType === 'survey' ? 'הודעת סקר שביעות רצון' : msg.messageType === 'order-ready' ? 'הודעת הזמנה מוכנה' : msg.messageType || 'לא ידוע'}
        </span>
      </td>
      <td style="padding: 12px; border: 1px solid #e5e7eb; background-color: ${index % 2 === 0 ? '#f9fafb' : '#ffffff'}; font-size: 13px; direction: ltr; font-family: monospace; color: #ef4444; max-width: 300px; word-break: break-word;">${msg.errorMessage || 'לא זמין'}</td>
      <td style="padding: 12px; border: 1px solid #e5e7eb; background-color: ${index % 2 === 0 ? '#f9fafb' : '#ffffff'}; font-size: 12px; color: #6b7280; direction: ltr; font-family: monospace;">${new Date(msg.timestamp).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}</td>
    </tr>
  `).join('');

  return `
<html
  xmlns="http://www.w3.org/1999/xhtml"
  xmlns:v="urn:schemas-microsoft-com:vml"
  xmlns:o="urn:schemas-microsoft-com:office:office"
>
  <head>
    <title>שגיאה בשליחת הודעות WhatsApp - תמרים בתומר</title>
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style type="text/css">
      #outlook a { padding: 0; } 
      body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; } 
      table, td { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
      img { border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; } 
      p { display: block; margin: 13px 0; }
      .error-container { background-color: #fef2f2; border: 2px solid #fecaca; border-radius: 8px; padding: 16px; margin: 20px 0; }
      .error-title { color: #dc2626; font-size: 20px; font-weight: bold; margin-bottom: 10px; }
      .summary-box { background-color: #f0f9ff; border: 1px solid #bae6fd; border-radius: 6px; padding: 15px; margin: 15px 0; }
      .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 15px 0; }
      .info-item { background-color: #f8fafc; padding: 12px; border-radius: 6px; border-left: 4px solid #3b82f6; }
      .info-label { font-weight: bold; color: #374151; font-size: 14px; margin-bottom: 4px; }
      .info-value { color: #6b7280; font-size: 13px; font-family: monospace; }
      .messages-table { width: 100%; border-collapse: collapse; margin: 20px 0; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
      .table-header { background-color: #1f2937; color: white; font-weight: bold; }
      .table-header th { padding: 15px 12px; border: 1px solid #374151; font-size: 14px; text-align: center; }
      .urgent-notice { background-color: #fef3c7; border: 2px solid #f59e0b; border-radius: 8px; padding: 15px; margin: 20px 0; }
      .urgent-notice h3 { color: #92400e; margin: 0 0 10px 0; font-size: 16px; }
    </style>
  </head>

  <body style="word-spacing:normal;background-color:#f2f3f8;">
    <div style="background-color:#f2f3f8; padding-bottom:50px;">
      
      <!-- Header with Logo -->
      <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#f2f3f8; max-width: 800px; margin: 0 auto;">
        <tbody>
          <tr>
            <td>
              <div style="margin:30px auto;max-width:800px; height:80px">
                <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="width:100%;">
                  <tbody>
                    <tr>
                      <td style="direction:ltr;font-size:0px;padding:20px 0;padding-bottom:0;text-align:center;">
                        <div style="font-size:0px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%;">
                          <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="vertical-align:top;" width="100%">
                            <tbody>
                              <tr>
                                <td align="center" style="font-size:0px;padding:10px 25px;word-break:break-word;">
                                  <img alt="תמרים בתומר" height="auto" src="https://i.imgur.com/5zixCOQ.png" style="border:0;display:block;outline:none;text-decoration:none;height:auto;width:140px;font-size:13px;padding-bottom:30px;" width="140" height="140" />
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- Main Content -->
      <div style="background:#ffffff;background-color:#ffffff;margin:0px auto;max-width:800px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
        <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="background:#ffffff;background-color:#ffffff;width:100%;">
          <tbody>
            <tr>
              <td style="direction:rtl;font-size:0px;padding:30px;text-align:right;">
                
                <!-- Error Alert -->
                <div class="error-container">
                  <div class="error-title">🚨 התרחשה שגיאה בשליחת הודעות WhatsApp</div>
                  <p style="color: #7f1d1d; font-size: 16px; margin: 0;">
                    זוהו ${failedMessages.length} הודעות ש<strong>נכשלו בשליחה</strong> מהשרת WhatsApp של תמרים בתומר.
                  </p>
                </div>

                <!-- Summary Box -->
                <div class="summary-box">
                  <h3 style="color: #1e40af; margin: 0 0 15px 0; font-size: 18px;">📊 סיכום השגיאות:</h3>
                  <div style="display: flex; justify-content: space-between; flex-wrap: wrap; gap: 15px;">
                    <div style="background-color: white; padding: 12px; border-radius: 6px; border: 1px solid #bae6fd; min-width: 120px; text-align: center;">
                      <div style="font-size: 24px; font-weight: bold; color: #dc2626;">${failedMessages.length}</div>
                      <div style="font-size: 12px; color: #6b7280;">הודעות שנכשלו</div>
                    </div>
                    <div style="background-color: white; padding: 12px; border-radius: 6px; border: 1px solid #bae6fd; min-width: 120px; text-align: center;">
                      <div style="font-size: 24px; font-weight: bold; color: #f59e0b;">${[...new Set(failedMessages.map(m => m.messageType))].length}</div>
                      <div style="font-size: 12px; color: #6b7280;">סוגי הודעות</div>
                    </div>
                    <div style="background-color: white; padding: 12px; border-radius: 6px; border: 1px solid #bae6fd; min-width: 120px; text-align: center;">
                      <div style="font-size: 24px; font-weight: bold; color: #059669;">${[...new Set(failedMessages.map(m => m.userPhone))].length}</div>
                      <div style="font-size: 12px; color: #6b7280;">לקוחות מושפעים</div>
                    </div>
                  </div>
                </div>

                <!-- Server Info -->
                <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 20px 0;">
                  <h3 style="color: #374151; margin: 0 0 15px 0; font-size: 16px;">🖥️ פרטי השרת:</h3>
                  <div class="info-grid">
                    <div class="info-item">
                      <div class="info-label">זמן השגיאה:</div>
                      <div class="info-value">${new Date(timestamp).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'full', timeStyle: 'medium' })}</div>
                    </div>
                    <div class="info-item">
                      <div class="info-label">סביבת העבודה:</div>
                      <div class="info-value">${serverInfo?.environment || 'לא זמין'}</div>
                    </div>
                  </div>
                </div>

                <!-- Urgent Notice -->
                <table border="0" cellpadding="0" cellspacing="0" style="width: 100%; background-color: #fef3c7; border: 2px solid #f59e0b; border-radius: 8px; margin-bottom: 20px;">
                  <tr>
                    <td style="padding: 20px;">
                      <h3 style="color: #92400e; margin: 0 0 15px 0; font-size: 16px;">⚠️ פעולות נדרשות:</h3>
                      <table border="0" cellpadding="0" cellspacing="0" style="width: 100%;">
                        <tr>
                          <td style="color: #92400e; font-size: 14px; line-height: 1.6;">
                            • בדוק את מצב חיבור השרת WhatsApp<br>
                            • וודא שהשירות פועל כראוי<br>
                            • שקול לשלוח מחדש את ההודעות שנכשלו<br>
                            • בדוק את לוגים המפורטים בשרת
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

                <!-- Failed Messages Table -->
                <div style="margin: 30px 0;">
                  <h3 style="color: #374151; margin: 0 0 15px 0; font-size: 18px;">📋 פירוט הודעות שנכשלו:</h3>
                  <div style="overflow-x: auto;">
                    <table class="messages-table">
                      <thead class="table-header">
                        <tr>
                          <th>#</th>
                          <th>מספר הזמנה</th>
                          <th>טלפון לקוח</th>
                          <th>סוג הודעה</th>
                          <th>שגיאה</th>
                          <th>זמן</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${messagesTableRows}
                      </tbody>
                    </table>
                  </div>
                </div>

                <!-- Actions Section -->
                <table border="0" cellpadding="0" cellspacing="0" style="width: 100%; background-color: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; margin-bottom: 20px;">
                  <tr>
                    <td style="padding: 20px;">
                      <h3 style="color: #1e40af; margin: 0 0 15px 0; font-size: 16px;">🛠️ פעולות מומלצות:</h3>
                      <table border="0" cellpadding="0" cellspacing="0" style="width: 100%;">
                        <tr>
                          <td style="color: #374151; font-size: 14px; line-height: 1.8;">
                            <strong>1. בדיקה מיידית:</strong> התחבר לממשק ניהול WhatsApp ובדוק את סטטוס החיבור<br>
                            <strong>2. בדיקת לוגים:</strong> עיין בלוגים של השרת לפרטים נוספים על השגיאות<br>
                            <strong>3. שליחה מחדש:</strong> שקול לשלוח מחדש את ההודעות שנכשלו ללקוחות המושפעים<br>
                            <strong>4. בדיקת תקשורת:</strong> וודא שהחיבור לשרת WhatsApp יציב<br>
                            <strong>5. עדכון לקוחות:</strong> במידת הצורך, עדכן את הלקוחות בערוצים אחרים
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

                <!-- Footer -->
                <div style="text-align: center; margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
                  <p style="color: #6b7280; font-size: 14px; margin: 0;">
                    מייל זה נשלח אוטומטית ממערכת ניטור השגיאות של תמרים בתומר
                  </p>
                  <p style="color: #9ca3af; font-size: 12px; margin: 5px 0 0 0;">
                    ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}
                  </p>
                </div>

              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </body>
</html>
`;
};

module.exports = { whatsappErrorEmailBody }; 
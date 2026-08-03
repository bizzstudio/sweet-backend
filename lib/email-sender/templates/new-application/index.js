const { logoBlock } = require("../../brand");

const newApplicationBody = (option) => {
  return `
<html
  xmlns="http://www.w3.org/1999/xhtml"
  xmlns:v="urn:schemas-microsoft-com:vml"
  xmlns:o="urn:schemas-microsoft-com:office:office"
>

  <head>
  <title>המתוקים של בני</title>
    <!--[if !mso]><!-->
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <!--<![endif]-->
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style type="text/css">
      #outlook a { padding: 0; } body { margin: 0; padding: 0;
      -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; } table, td {
      border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
      img { border: 0; height: auto; line-height: 100%; outline: none;
      text-decoration: none; -ms-interpolation-mode: bicubic; } p { display:
      block; margin: 13px 0; } #common_table{ border: 1px solid lightgrey;
      border-collapse: collapse; }

    </style>

    <style type="text/css">
      @media only screen and (min-width:480px) { .mj-column-per-100 { width:
      100% !important; max-width: 100%; } .mj-column-per-50 { width: 50%
      !important; max-width: 50%; } }

    </style>
    <style media="screen and (min-width:480px)">
      .moz-text-html .mj-column-per-100 { width: 100% !important; max-width:
      100%; } .moz-text-html .mj-column-per-50 { width: 50% !important;
      max-width: 50%; }

    </style>
    <style type="text/css">
      @media only screen and (max-width:480px) { table.mj-full-width-mobile {
      width: 100% !important; } td.mj-full-width-mobile { width: auto
      !important; } }

    </style>
  </head>

  <body style="word-spacing:normal;background-color:#f2f3f8;">
    <div style="background-color:#f2f3f8; padding-bottom:100px;">
      <table
        align="center"
        border="0"
        cellpadding="0"
        cellspacing="0"
        role="presentation"
        style="background-color:#f2f3f8;"
      >
        <tbody>
          <tr>
            <td>

              <div style="margin:30px auto;max-width:600px; height:80px">
                <table
                  align="center"
                  border="0"
                  cellpadding="0"
                  cellspacing="0"
                  role="presentation"
                  style="width:100%;"
                >
                  <tbody>
                    <tr>
                      <td
                        style="direction:rtl;font-size:0px;padding:20px 0;padding-bottom:0;text-align:center;"
                      >

                        <div
                          class="mj-column-per-100 mj-outlook-group-fix"
                          style="font-size:0px;text-align:right;direction:rtl;display:inline-block;vertical-align:top;width:100%;"
                        >
                          <table
                            border="0"
                            cellpadding="0"
                            cellspacing="0"
                            role="presentation"
                            style="vertical-align:top;"
                            width="100%"
                          >
                            <tbody>
                              <tr>
                                <td
                                  align="center"
                                  style="font-size:0px;padding:10px 25px;word-break:break-word;"
                                >
                                  <table
                                    border="0"
                                    cellpadding="0"
                                    cellspacing="0"
                                    role="presentation"
                                    style="border-collapse:collapse;border-spacing:0px;"
                                  >
                                    <tbody>
                                       <tr>
                                      <td align="center" style="padding-bottom:30px;">
                                        ${logoBlock()}
                                      </td>
                                    </tr>
                                    </tbody>
                                  </table>
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

      <div
        style="background:#ffffff;background-color:#ffffff;margin:0px auto;max-width:600px;"
      >
        <table
          align="center"
          border="0"
          cellpadding="0"
          cellspacing="0"
          role="presentation"
          style="background:#ffffff;background-color:#ffffff;width:100%;"
        >
          <tbody>
            <tr>
              <td
                style="direction:rtl;font-size:0px;padding:0 0 20px;padding-left:15px;padding-right:15px;text-align:center;padding-top: 20px;"
              >

                <div
                  class="mj-column-per-100 mj-outlook-group-fix"
                  style="font-size:15px;text-align:right;direction:rtl;vertical-align:top;width:100%;background:#ffffff;background-color:#ffffff"
                >
                  <h2 style="margin-top:57px;margin-bottom:20px; text-align:center; color:#c09c0f;">התקבלה פנייה חדשה באתר</h2>
                  <p style="margin-bottom:20px;">התקבלה פנייה חדשה מאת <strong>${option.name}</strong> בנושא "<strong>${option.subject}</strong>".</p>

                  <div style="background-color:#f7f7f7; padding:15px; border-radius:5px; margin-bottom:20px;">
                    <h3 style="margin-top:0; color:#c09c0f;">פרטי הפנייה:</h3>
                    <table style="width:100%; border-collapse:collapse;">
                      <tr>
                        <td style="padding:8px 0; border-bottom:1px solid #eee; width:40%;"><strong>שם:</strong></td>
                        <td style="padding:8px 0; border-bottom:1px solid #eee;">${option.name}</td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0; border-bottom:1px solid #eee;"><strong>דוא"ל:</strong></td>
                        <td style="padding:8px 0; border-bottom:1px solid #eee;">${option.email}</td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0; border-bottom:1px solid #eee;"><strong>נושא:</strong></td>
                        <td style="padding:8px 0; border-bottom:1px solid #eee;">${option.subject}</td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0; vertical-align:top;"><strong>הודעה:</strong></td>
                        <td style="padding:8px 0; white-space: pre-wrap;">${option.message}</td>
                      </tr>
                    </table>
                  </div>

                  <p style="margin-top: 40px; text-align:center;">בברכה,<br /><strong>מערכת המתוקים של בני</strong>
                </div>

              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div
        style="background:#ffffff;background-color:#ffffff;margin:0px auto;max-width:600px;"
      >
        <table
          align="center"
          border="0"
          cellpadding="0"
          cellspacing="0"
          role="presentation"
          style="width:100%; margin-bottom:0px;"
        >
          <tbody>
            <tr>
              <td>
                <div style="margin:25px auto;max-width:600px;">
                  <table
                    align="center"
                    border="0"
                    cellpadding="0"
                    cellspacing="0"
                    role="presentation"
                    style="width:100%;"
                  >
                    <tbody>
                      <tr>
                        <td
                          style="direction:rtl;font-size:0px;margin-top:40px 0;text-align:center; border-top: 1px solid lightgray;"
                        >
                          <div style="margin:0px auto;max-width:600px;">
                            <table
                              align="center"
                              border="0"
                              cellpadding="0"
                              cellspacing="0"
                              role="presentation"
                              style="width:100%;"
                            >
                              <tbody>
                                <tr>
                                  <td
                                    style="direction:rtl;font-size:0px;padding:20px 0;text-align:center;"
                                  >
                                    <div
                                      class="mj-column-per-100 mj-outlook-group-fix"
                                      style="font-size:0px;text-align:right;direction:rtl;display:inline-block;vertical-align:top;width:100%;"
                                    >
                                      <table
                                        border="0"
                                        cellpadding="0"
                                        cellspacing="0"
                                        role="presentation"
                                        width="100%"
                                      >
                                        <tbody>
                                          <tr>
                                            <td
                                              style="vertical-align:top;padding:0;"
                                            >
                                              <table
                                                border="0"
                                                cellpadding="0"
                                                cellspacing="0"
                                                role="presentation"
                                                style
                                                width="100%"
                                              >
                                                <tbody>
                                                  <tr>
                                                    <td
                                                      align="center"
                                                      style="font-size:0px;padding:0px 20px;word-break:break-word;"
                                                    >
                                                      <div
                                                        style="padding-top:10px; font-family:'Helvetica Neue', Helvetica, Arial, sans-serif;font-size:11px;font-weight:400;line-height:16px;text-align:center;color:#8a8a8a;"
                                                      >
                                                        <p
                                                          style="font-family:'Helvetica Neue', Helvetica, Arial, sans-serif;font-size:11px;font-weight:400;line-height:16px;text-align:center;color:#303030;"
                                                        >
                                                          &copy; המתוקים של בני, כל הזכויות שמורות.</p></div>
                                                    </td>
                                                  </tr>
                                                </tbody>
                                              </table>
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

module.exports = { newApplicationBody };
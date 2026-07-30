const customerInvoiceEmailBody = (option) => {
  return `<html
  xmlns='http://www.w3.org/1999/xhtml'
  xmlns:v='urn:schemas-microsoft-com:vml'
  xmlns:o='urn:schemas-microsoft-com:office:office'
  dir="rtl"
>

  <head>
    <title>תמרים בתומר</title>
    <!--[if !mso]><!-->
    <meta http-equiv='X-UA-Compatible' content='IE=edge' />
    <!--<![endif]-->
    <meta http-equiv='Content-Type' content='text/html; charset=UTF-8' />
    <meta name='viewport' content='width=device-width, initial-scale=1' />
    <style type='text/css'>
      #outlook a { padding: 0; } body { margin: 0; padding: 0;
      -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; } table, td {
      border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
      img { border: 0; height: auto; line-height: 100%; outline: none;
      text-decoration: none; -ms-interpolation-mode: bicubic; } p { display:
      block; margin: 13px 0; } #common_table{ border: 1px solid lightgrey;
      border-collapse: collapse; }

    </style>

    <style type='text/css'>
      @media only screen and (min-width:480px) { .mj-column-per-100 { width:
      100% !important; max-width: 100%; } .mj-column-per-50 { width: 50%
      !important; max-width: 50%; } }

    </style>
    <style media='screen and (min-width:480px)'>
      .moz-text-html .mj-column-per-100 { width: 100% !important; max-width:
      100%; } .moz-text-html .mj-column-per-50 { width: 50% !important;
      max-width: 50%; }

    </style>
    <style type='text/css'>
      @media only screen and (max-width:480px) { table.mj-full-width-mobile {
      width: 100% !important; } td.mj-full-width-mobile { width: auto
      !important; } }

    </style>
  </head>

  <body style='word-spacing:normal;background-color:#f2f3f8; direction:rtl; text-align:right;'>
    <div style='background-color:#f2f3f8; padding-bottom:100px;'>
      <table
        align='center'
        border='0'
        cellpadding='0'
        cellspacing='0'
        role='presentation'
        style='background-color:#f2f3f8;'
      >
        <tbody>
          <tr>
            <td>

              <div style='margin:30px auto;max-width:600px; height:80px'>
                <table
                  align='center'
                  border='0'
                  cellpadding='0'
                  cellspacing='0'
                  role='presentation'
                  style='width:100%;'
                >
                  <tbody>
                    <tr>
                      <td
                        style='direction:ltr;font-size:0px;padding:20px 0;padding-bottom:0;text-align:center;'
                      >

                        <div
                          class='mj-column-per-100 mj-outlook-group-fix'
                          style='font-size:0px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%;'
                        >
                          <table
                            border='0'
                            cellpadding='0'
                            cellspacing='0'
                            role='presentation'
                            style='vertical-align:top;'
                            width='100%'
                          >
                            <tbody>
                              <tr>
                                <td
                                  align='center'
                                  style='font-size:0px;padding:10px 25px;word-break:break-word;'
                                >
                                  <table
                                    border='0'
                                    cellpadding='0'
                                    cellspacing='0'
                                    role='presentation'
                                    style='border-collapse:collapse;border-spacing:0px;'
                                  >
                                    <tbody>
                                      <tr>
                                        <td style='width:150px;'>
                                          <!-- replace image cdn -->
                                          <img
                                            alt
                                            height='auto'
                                            src='https://i.imgur.com/5zixCOQ.png'
                                            style='border:0;display:block;outline:none;text-decoration:none;height:auto;width:140px;font-size:13px;padding-bottom:30px;'
                                            width='140'
                                            height='140'
                                          />
                                        </td>
                                      </tr>
                                    </tbody>
                                  </table>
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                        <!--[if mso | IE]></td></tr></table><![endif]-->
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <!--[if mso | IE]></td></tr></table><![endif]-->
            </td>
          </tr>
        </tbody>
      </table>

      <div
        style='background:#ffffff;background-color:#ffffff;margin:0px auto;max-width:600px;'
      >
        <table
          align='center'
          border='0'
          cellpadding='0'
          cellspacing='0'
          role='presentation'
          style='background:#ffffff;background-color:#ffffff;width:100%;'
        >
          <tbody>
            <tr>
              <td
                style='direction:rtl;font-size:0px;padding:0 0 20px;padding-left:15px;padding-right:15px;text-align:right;padding-top: 20px;'
              >

                <div
                  class='mj-column-per-100 mj-outlook-group-fix'
                  style='font-size:15px;text-align:right;direction:rtl;display:inline-block;vertical-align:top;width:100%;background:#ffffff;background-color:#ffffff'
                >
                  <!--start email_template -->
                  <table class='common_table' style='width: 100%;'>
                    <thead>
                      <tr>

                        <th style='padding: 2px 4px; font-size:25px;text-transform: uppercase'>חשבונית</th>

                      </tr>
                    </thead>
                    <tbody>

                      <tr>

                        <td
                          style='padding:0px; margin:0px; font-size:12px'
                        >
                         <p>סטטוס: ${option.status}</p>
                         <p>מספר עוסק: ${option.vat_number}</p>
                        </td>

                        <td
                          style='padding: 2px 4px;text-align:end;font-size:12px;'
                        >

                          <p style='margin:0px; font-size:14; text-transform: uppercase'>${
                            option.company_name || ""
                          }</p>
                    
                          <p style='margin:0px;'>${
                            option.company_address || ""
                          }</p>
                          <p style='margin:0px;'>
                     
                          ${option.company_phone || ""}</p>
                          <p style='margin:0px;'> ${
                            option.company_email || ""
                          }</p>
                          <p style='margin:0px;'> ${
                            option.company_website || ""
                          }</p>
                        </td>

                      </tr>

                    </tbody>
                  </table>
                  <!--end email_template -->
                </div>

              </td>
            </tr>
          </tbody>
        </table>

      </div>

      <div
        style='background:#ffffff;background-color:#ffffff;margin:0px auto;max-width:600px;'
      >
        <table
          align='center'
          border='0'
          cellpadding='0'
          cellspacing='0'
          role='presentation'
          style='background:#ffffff;background-color:#ffffff;width:100%;'
        >
          <tbody>
            <tr>
              <td
                style='direction:ltr;font-size:0px;padding:0 0 20px;padding-left:15px;padding-right:15px;text-align:center;padding-top: 20px;'
              >

                <div
                  class='mj-column-per-100 mj-outlook-group-fix'
                  style='font-size:15px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%;background:#ffffff;background-color:#ffffff'
                >
                  <!--start email_template -->
                  <table class='common_table' style='width: 100%;'>
                    <thead>
                      <tr>

                        <th style='padding: 2px 4px;font-size:13px; text-transform: uppercase'>תאריך</th>
                        <th style='padding: 2px 4px;font-size:13px; text-transform: uppercase'>חשבון</th>
                        <th style='padding: 2px 4px;font-size:13px; text-transform: uppercase'>שיטה</th>

                        <th style='padding: 2px 4px; text-align:end;font-size:13px; text-transform: uppercase'>לקוח</th>

                      </tr>
                    </thead>
                    <tbody>

                      <tr>

                        <td
                          style='padding: 2px 4px;text-align:justify; font-size:12px'
                        >
                          ${option.date}
                        </td>
                        <td
                          style='padding: 2px 4px;text-align:justify;font-size:12px'
                        >
                          #${option.invoice}
                        </td>

                        <td
                          style='padding: 2px 4px;text-align:justify;font-size:12px;font-weight : bold'
                        >
                          ${option.method}
                        </td>

                        <td
                          style='padding: 2px 4px;text-align:end;font-size:12px;'
                        >
                          ${option.name || ""}
                          <p style='margin:0px;'>${option.email || ""}</p>
                          <p style='margin:0px;'> ${option.phone || ""}</p>
                          ${option.address || ""}
                        </td>

                      </tr>

                    </tbody>
                  </table>
                  <!--end email_template -->
                </div>

              </td>
            </tr>
          </tbody>
        </table>

      </div>

      <div
        class='body-section'
        style='margin: 0px auto; max-width: 600px; border border-radius:4px'
      >
        <table
          align='center'
          cellpadding='0'
          cellspacing='0'
          role='presentation'
          style='width:100%;'
        >
          <tbody>
            <tr>
              <td
                style='direction:ltr;font-size:0px;padding:20px 0;padding-bottom:0;padding-top:0;text-align:center;'
              >

                <div
                  style='background:#ffffff;background-color:#ffffff;margin:0px auto;max-width:600px;'
                >
                  <table
                    align='center'
                    border='0'
                    cellpadding='0'
                    cellspacing='0'
                    role='presentation'
                    style='background:#ffffff;background-color:#ffffff;width:100%;'
                  >
                    <tbody>
                      <tr>
                        <td
                          style='direction:ltr;font-size:0px;padding:0 0 20px;padding-left:15px;padding-right:15px;text-align:center;padding-top: 20px;'
                        >

                          <div
                            class='mj-column-per-100 mj-outlook-group-fix'
                            style='font-size:15px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%;background:#ffffff;background-color:#ffffff'
                          >
                            <!--start email_template -->
                            <table class='common_table' style='width: 100%;'>
                              <thead>
                                <tr>

                                  <th
                                    id='common_table'
                                    style='padding: 2px 4px;font-size:13px; text-transform: uppercase'
                                  >שם</th>
                                  <th
                                    id='common_table'
                                    style='padding: 2px 4px;font-size:13px; text-transform: uppercase'
                                  >כמות</th>
                                  <th
                                    id='common_table'
                                    style='padding: 2px 4px; text-align:end;font-size:13px; text-transform: uppercase'
                                  >מחיר</th>
                                  <th
                                    id='common_table'
                                    style='padding: 2px 4px; text-align:end;font-size:13px; text-transform: uppercase'
                                  >סה"כ מחיר</th>

                                </tr>
                              </thead>
                              <tbody>

                                ${option.cart
                                  .map((item) => {
                                    return `
                                <tr>

                                  <td
                                    id='common_table'
                                    style='padding: 2px 4px;'
                                  >
                                    ${item.title.substring(0, 15)}
                                  </td>
                                  <td
                                    id='common_table'
                                    style='padding: 2px 4px;'
                                  >
                                    ${item.quantity}
                                  </td>
                                  <td
                                    id='common_table'
                                    style='padding: 2px 4px;text-align:end'
                                  >
                                    ${option.currency}${item.price}
                                  </td>
                                  <td
                                    id='common_table'
                                    style='padding: 2px 4px; text-align:end'
                                  >
                                    ${option.currency}${(
                                      item.price * item.quantity
                                    ).toFixed(2)}
                                  </td>

                                </tr>`;
                                  })
                                  .join("")}

                              </tbody>
                            </table>

                            <!--end email_template -->
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
      <!--[if mso | IE]></td></tr></table><![endif]-->

      <div
        style='background:#ffffff;background-color:#ffffff;margin:0px auto;max-width:600px;'
      >
        <table
          align='center'
          border='0'
          cellpadding='0'
          cellspacing='0'
          role='presentation'
          style='background:#ffffff;background-color:#ffffff;width:100%;'
        >
          <tbody>
            <tr>
              <td
                style='direction:ltr;font-size:0px;padding:0 0 20px;padding-left:15px;padding-right:15px;text-align:center;padding-top: 20px;'
              >

                <div
                  class='mj-column-per-100 mj-outlook-group-fix'
                  style='margin-left:15px; font-size:15px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%;background:#ffffff;background-color:#ffffff'
                >
                  <!--start email_template -->
                  <table class='common_table' style='width: 100%;'>
                    <thead>
                      <tr>

                        <th style='padding: 2px 4px;text-transform: uppercase; font-size:13px;'>סכום ביניים</th>
                        <th style='padding: 2px 4px;text-transform: uppercase; font-size:13px;'>מע"מ</th>
                        <th style='padding: 2px 4px;text-transform: uppercase; font-size:13px;'>משלוח</th>
                        <th style='padding: 2px 4px;text-transform: uppercase; font-size:13px;'>הנחה</th>
                        <th style='padding: 2px 4px;text-transform: uppercase; font-size:13px;'>סה"כ</th>

                      </tr>
                    </thead>
                    <tbody>

                      <tr>

                        <td style='padding: 2px 4px;text-align:justify; font-size:13px;'>
                          ${option.currency}${option.subTotal.toFixed(2)}
                        </td>
                        <td style='padding: 2px 4px;text-align:justify; font-size:13px;'>
                          ${option.currency}${option.vat.toFixed(2)}
                        </td>
                        <td style='padding: 2px 4px;text-align:justify; font-size:13px;'>
                        ${option.currency}${option.shipping.toFixed(2)}
                      </td>
                        <td style='padding: 2px 4px;text-align:justify; font-size:13px;'>
                          ${option.currency}${option.discount.toFixed(2)}
                        </td>
                        <td style='padding: 2px 4px;text-align:justify;color:red ; font-size:13px;'>
                          ${option.currency}${option.total.toFixed(2)}
                        </td>

                      </tr>

                    </tbody>
                  </table>
                  <!--end email_template -->
                </div>

              </td>
            </tr>
          </tbody>
        </table>

        <table
          align='center'
          border='0'
          cellpadding='0'
          cellspacing='0'
          role='presentation'
          style='width:100%; margin-bottom:20px;'
        >
          <tbody>
            <tr>
              <td>

                <div style='margin:25px auto;max-width:600px;'>
                  <table
                    align='center'
                    border='0'
                    cellpadding='0'
                    cellspacing='0'
                    role='presentation'
                    style='width:100%;'
                  >
                    <tbody>
                      <tr>
                        <td
                          style='direction:ltr;font-size:0px;margin-top:40px 0;text-align:center; border-top: 1px solid lightgray;'
                        >

                          <div style='margin:0px auto;max-width:600px;'>
                            <table
                              align='center'
                              border='0'
                              cellpadding='0'
                              cellspacing='0'
                              role='presentation'
                              style='width:100%;'
                            >
                              <tbody>
                                <tr>
                                  <td
                                    style='direction:ltr;font-size:0px;padding:20px 0;text-align:center;'
                                  >
                                    <div
                                      class='mj-column-per-100 mj-outlook-group-fix'
                                      style='font-size:0px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%;'
                                    >
                                      <table
                                        border='0'
                                        cellpadding='0'
                                        cellspacing='0'
                                        role='presentation'
                                        width='100%'
                                      >
                                        <tbody>
                                          <tr>
                                            <td
                                              style='vertical-align:top;padding:0;'
                                            >
                                              <table
                                                border='0'
                                                cellpadding='0'
                                                cellspacing='0'
                                                role='presentation'
                                                style
                                                width='100%'
                                              >
                                                <tbody>
                                                  <tr>
                                                    <td
                                                      align='center'
                                                      style='font-size:0px;padding:0px 25px;word-break:break-word;'
                                                    >
                                                      <div
                                                        style="padding-top:10px; font-family:'Helvetica Neue', Helvetica, Arial, sans-serif;font-size:11px;font-weight:400;line-height:16px;text-align:center;color:#8a8a8a; direction:rtl; text-align:right;"
                                                      >
                                                        אתה מקבל דוא"ל זה כי נרשמת לתמרים בתומר והסכמת לקבל מאיתנו עדכונים על תכונות חדשות, אירועים ומבצעים מיוחדים.
                                                        <p
                                                          style="font-family:'Helvetica Neue', Helvetica, Arial, sans-serif;font-size:11px;font-weight:400;line-height:16px;text-align:center;color:#303030;"
                                                        >
                                                          &copy; תמרים בתומר, כל הזכויות שמורות.</p></div>
                                                    </td>
                                                  </tr>

                                                </tbody>
                                              </table>
                                            </td>
                                          </tr>
                                        </tbody>
                                      </table>
                                    </div>
                                    <!--[if mso | IE]></td></tr></table><![endif]-->
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
                <!--[if mso | IE]></td></tr></table><![endif]-->
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </body>

</html>`;
};

module.exports = customerInvoiceEmailBody;

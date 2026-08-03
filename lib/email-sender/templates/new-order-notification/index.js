// lib/email-sender/templates/new-order-notification/index.js
const { logoBlock } = require("../../brand");

const newOrderNotificationBody = (option) => {
    const {
        // פרטי ההזמנה
        invoice,
        orderDate,
        total,
        discount,
        shippingCost,
        paymentMethod,
        shippingOption,

        // פרטי הלקוח
        customerName,
        customerEmail,
        customerPhone,
        customerAddress,

        // פרטים נוספים
        orderItems = [],
        totalItems = 0,
        customerNote,
        isBusinessCustomer = false,
        rewardCouponCode = null
    } = option;

    const formatCurrency = (amount) => {
        return new Intl.NumberFormat('he-IL', {
            style: 'currency',
            currency: 'ILS',
            minimumFractionDigits: 2
        }).format(amount || 0);
    };

    const formatDate = (dateStr) => {
        if (!dateStr) return '';
        return new Date(dateStr).toLocaleDateString('he-IL');
    };

    const getShippingText = (option) => {
        switch (option) {
            case '1': return 'איסוף עצמי';
            case '2': return isBusinessCustomer ? 'משלוח עד העסק' : 'משלוח עד הבית';
            default: return option || 'לא צויין';
        }
    };

    const getPaymentText = (method) => {
        if (isBusinessCustomer) {
            return '-';
        }
        switch (method) {
            case 'creditCard': return 'כרטיס אשראי';
            case 'cash': return 'מזומן';
            default: return method || 'לא צויין';
        }
    };

    // פונקציה לחישוב מחיר נכון של מוצר (לוקחת בחשבון מבצעים ומתנות)
    const getItemPrice = (item) => {
        // מוצר מתנה - משתמש ב-rewardPrice
        if (item.isRewardProduct && item.rewardPrice !== undefined) {
            return item.rewardPrice;
        }
        // מוצר עם הנחת מבצע - מחיר כולל מחולק בכמות
        if (item.discountedPrice !== undefined && item.discountedPrice !== null) {
            return item.discountedPrice / (item.quantity || item.Quantity || 1);
        }
        // מוצר רגיל - מחיר רגיל
        return item.prices?.price || item.Price || 0;
    };

    // פונקציה לחישוב מחיר כולל של מוצר
    const getItemTotalPrice = (item) => {
        // מוצר מתנה - rewardPrice * כמות
        if (item.isRewardProduct && item.rewardPrice !== undefined) {
            return (item.rewardPrice || 0) * (item.quantity || item.Quantity || 1);
        }
        // מוצר עם הנחת מבצע - discountedPrice הוא המחיר הכולל
        if (item.discountedPrice !== undefined && item.discountedPrice !== null) {
            return item.discountedPrice;
        }
        // מוצר רגיל - מחיר * כמות
        const price = item.prices?.price || item.Price || 0;
        const quantity = item.quantity || item.Quantity || 1;
        return price * quantity;
    };

    // פונקציה לבניית תיאור המוצר עם שם המבצע (בדיוק כמו ב-cardcomObj)
    const getItemDescription = (item) => {
        let description = 'מוצר';

        if (item.isRewardProduct) {
            // מוצר מתנה - מוסיפים את rewardOfferName
            const title = item.title || item._doc?.title;
            description = title?.he || title || 'מוצר';
            const offerName = item.rewardOfferName?.he || item.rewardOfferName || 'מוצר מתנה';
            description += " (" + offerName + ")";
        } else {
            // מוצר רגיל או עם מבצע
            const title = item.title || item._doc?.title;
            description = title?.he || title || item.ItemDescription || item.Description || 'מוצר';

            // אם יש מבצע - מוסיפים את שם המבצע
            if (item.offerTitle) {
                const offerName = item.offerTitle?.he || item.offerTitle;
                if (offerName) {
                    description += " (" + offerName + ")";
                }
            }
        }

        return description;
    };

    return `
<html>
<head>
    <title>המתוקים של בני - הזמנה חדשה</title>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style type="text/css">
      body { margin: 0; padding: 0; background-color: #f2f3f8; }
      table { border-collapse: collapse; }
      .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
    </style>
</head>
<body>
    <div style="background-color:#f2f3f8; padding: 20px;">
        <div style="max-width:800px; margin:0 auto; background-color:#ffffff; padding:20px; border-radius:8px;">
            <!-- Header with Logo -->
            <div style="text-align:center; margin-bottom:30px;">
                ${logoBlock()}
            </div>

            <!-- Main Title -->
            <h1 style="text-align:center; color:#002863; margin-bottom:30px; direction:rtl;">
                🛒 התקבלה הזמנה חדשה!
            </h1>
            
            <!-- Order Status -->
            <div style="text-align:center; background-color:#e8f5e8; padding:15px; border-radius:8px; margin-bottom:25px; direction:rtl;">
                <p style="margin:0; color:#2d5016; font-weight:bold;">
                    ✅ הזמנה מספר <strong>${invoice}</strong> נוצרה בהצלחה עבור <strong>${customerName}</strong>
                    ${isBusinessCustomer ? '<br><small>לקוח עסקי</small>' : ''}
                </p>
            </div>

            <!-- Order Details -->
            <div style="background-color:#f0f8ff; padding:20px; border-radius:8px; border-right:4px solid #002863; margin-bottom:25px; direction:rtl;">
                <h3 style="margin-top:0; color:#002863; border-bottom:2px solid #002863; padding-bottom:10px;">📋 פרטי ההזמנה</h3>
                <table style="width:100%; border-collapse:collapse;">
                    <tr>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd; width:40%; font-weight:bold;">מספר הזמנה:</td>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd; font-weight:bold; font-size:18px;">#${invoice}</td>
                    </tr>
                    <tr>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd; font-weight:bold;">תאריך הזמנה:</td>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd;">${formatDate(orderDate)}</td>
                    </tr>
                    <tr>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd; font-weight:bold;">כמות פריטים:</td>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd;">${totalItems} פריטים</td>
                    </tr>
                    <tr>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd; font-weight:bold;">שיטת תשלום:</td>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd;">${getPaymentText(paymentMethod)}</td>
                    </tr>
                    ${discount > 0 ? `
                    <tr>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd; font-weight:bold;">הנחה:</td>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd; color:#e74c3c;">-${formatCurrency(discount)}</td>
                    </tr>
                    ` : ''}
                    ${shippingCost > 0 ? `
                    <tr>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd; font-weight:bold;">עלות משלוח:</td>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd;">${formatCurrency(shippingCost)}</td>
                    </tr>
                    ` : ''}
                    <tr style="background-color:#f7f7f7;">
                        <td style="padding:15px 0; font-weight:bold; color:#002863; font-size:16px;">סה"כ לתשלום:</td>
                        <td style="padding:15px 0; color:#002863; font-weight:bold; font-size:18px;">${formatCurrency(total)}</td>
                    </tr>
                </table>
            </div>

            <!-- Customer Details -->
            <div style="background-color:#f7f7f7; padding:20px; border-radius:8px; margin-bottom:25px; direction:rtl;">
                <h3 style="margin-top:0; color:#002863; border-bottom:2px solid #002863; padding-bottom:10px;">👤 פרטי הלקוח</h3>
                <table style="width:100%; border-collapse:collapse;">
                    <tr>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd; width:40%; font-weight:bold;">שם הלקוח:</td>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd; font-weight:bold;">${customerName}</td>
                    </tr>
                    ${customerEmail ? `
                    <tr>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd; font-weight:bold;">אימייל:</td>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd;"><a href="mailto:${customerEmail}" style="color:#002863;">${customerEmail}</a></td>
                    </tr>
                    ` : ''}
                    ${customerPhone ? `
                    <tr>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd; font-weight:bold;">טלפון:</td>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd;"><a href="tel:${customerPhone}" style="color:#002863;">${customerPhone}</a></td>
                    </tr>
                    ` : ''}
                    ${customerAddress ? `
                    <tr>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd; font-weight:bold;">כתובת:</td>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd;">${customerAddress}</td>
                    </tr>
                    ` : ''}
                </table>
            </div>

            <!-- Shipping Details -->
            <div style="background-color:#fff8e1; padding:20px; border-radius:8px; border-right:4px solid #ff9800; margin-bottom:25px; direction:rtl;">
                <h3 style="margin-top:0; color:#ff9800; border-bottom:2px solid #ff9800; padding-bottom:10px;">🚚 פרטי משלוח</h3>
                <table style="width:100%; border-collapse:collapse;">
                    <tr>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd; width:40%; font-weight:bold;">סוג משלוח:</td>
                        <td style="padding:10px 0; border-bottom:1px solid #ddd; font-weight:bold;">${getShippingText(shippingOption)}</td>
                    </tr>
                </table>
            </div>

            <!-- Order Items -->
            ${orderItems.length > 0 ? `
            <div style="background-color:#f9f9f9; padding:20px; border-radius:8px; margin-bottom:25px; direction:rtl;">
                <h3 style="margin-top:0; color:#002863; border-bottom:2px solid #002863; padding-bottom:10px;">📦 פירוט המוצרים</h3>
                <div style="margin-top:15px; border-radius:5px; box-shadow:0 2px 4px rgba(0,0,0,0.1);">
                    <table style="width:100%; border-collapse:collapse; table-layout:fixed;">
                        <thead>
                            <tr style="background-color:#002863; color:white;">
                                <th style="padding:8px 4px; text-align:right; border:1px solid #ddd; width:15%; word-wrap:break-word;">קוד מוצר</th>
                                <th style="padding:8px 4px; text-align:right; border:1px solid #ddd; width:35%; word-wrap:break-word;">תיאור</th>
                                <th style="padding:8px 4px; text-align:center; border:1px solid #ddd; width:12%; word-wrap:break-word;">כמות</th>
                                <th style="padding:8px 4px; text-align:center; border:1px solid #ddd; width:19%; word-wrap:break-word;">מחיר</th>
                                <th style="padding:8px 4px; text-align:center; border:1px solid #ddd; width:19%; word-wrap:break-word;">סה"כ</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${orderItems.map((item, index) => {
        const unitPrice = getItemPrice(item);
        const totalPrice = getItemTotalPrice(item);
        const description = getItemDescription(item);
        return `
                            <tr style="background-color:${index % 2 === 0 ? '#ffffff' : '#f8f8f8'};">
                                <td style="padding:8px 4px; border:1px solid #ddd; font-weight:bold; word-wrap:break-word; overflow-wrap:break-word; hyphens:auto;">${item.sku || item._id || ''}</td>
                                <td style="padding:8px 4px; border:1px solid #ddd; word-wrap:break-word; overflow-wrap:break-word; hyphens:auto; line-height:1.3;">${description}</td>
                                <td style="padding:8px 4px; border:1px solid #ddd; text-align:center; font-weight:bold; word-wrap:break-word;">${item.quantity || item.Quantity || 1}</td>
                                <td style="padding:8px 4px; border:1px solid #ddd; text-align:center; word-wrap:break-word; font-size:13px;">${formatCurrency(unitPrice)}</td>
                                <td style="padding:8px 4px; border:1px solid #ddd; text-align:center; font-weight:bold; word-wrap:break-word; font-size:13px;">${formatCurrency(totalPrice)}</td>
                            </tr>
                            `;
    }).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
            ` : ''}

            <!-- Customer Note -->
            ${customerNote ? `
            <div style="background-color:#fff3e0; padding:20px; border-radius:8px; border-right:4px solid #ff9800; margin-bottom:25px; direction:rtl;">
                <h3 style="margin-top:0; color:#ff9800;">💬 הערות הלקוח</h3>
                <p style="margin:0; font-style:italic; background-color:white; padding:15px; border-radius:5px; border:1px solid #e0e0e0;">"${customerNote}"</p>
            </div>
            ` : ''}

            <!-- Summary -->
            <div style="text-align:center; background-color:#e3f2fd; padding:20px; border-radius:8px; border:2px solid #2196f3; margin-bottom:25px; direction:rtl;">
                <h3 style="margin:0 0 10px 0; color:#1976d2;">📊 סיכום ההזמנה</h3>
                <p style="margin:5px 0; color:#1976d2; font-size:16px;"><strong>סה"כ ${totalItems} פריטים</strong></p>
                <p style="margin:5px 0; color:#1976d2; font-size:18px; font-weight:bold;">💰 סה"כ לתשלום: ${formatCurrency(total)}</p>
            </div>

            <!-- Next Purchase Reward Coupon -->
            ${rewardCouponCode ? `
            <div style="text-align:center; background-color:#fff8e1; padding:20px; border-radius:8px; border:2px dashed #d4a017; margin-bottom:25px; direction:rtl;">
                <h3 style="margin:0 0 10px 0; color:#8a6d00;">🎁 מתנה לקנייה הבאה!</h3>
                <p style="margin:5px 0; color:#8a6d00; font-size:15px;">קיבלת קופון בשווי <strong>25 ₪</strong> לקנייה הבאה שלך (בקנייה מעל 150 ₪). שמרו את הקוד:</p>
                <p style="margin:12px 0; font-size:22px; font-weight:bold; letter-spacing:2px; color:#002863; background:#ffffff; display:inline-block; padding:10px 20px; border-radius:6px; border:1px solid #d4a017;">${rewardCouponCode}</p>
            </div>
            ` : ''}

            <!-- Footer -->
            <div style="text-align:center; color:#666; font-size:12px; border-top:1px solid #ddd; padding-top:20px; direction:rtl;">
                <p>הודעה אוטומטית ממערכת המתוקים של בני</p>
                <p>&copy; המתוקים של בני, כל הזכויות שמורות.</p>
            </div>
        </div>
    </div>
</body>
</html>
`;
};

module.exports = { newOrderNotificationBody }; 
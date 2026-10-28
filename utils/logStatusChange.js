// utils/logStatusChange.js
/**
 * Logs the status change of an order to the console and updates the order's status history.
 *
 * @param {Object} props - The properties for the status change.
 * @param {string} props.from - The previous status name.
 * @param {string} props.to - The new status name.
 * @param {string} props.functionName - The name of the function performing the change.
 * @param {Object} props.order - The order document to update (Mongoose model instance).
 * @param {boolean} [props.issueDeliveryNote=true] - false = המעבר הזה לא מפיק תעודת משלוח.
 */

// ‏issueDeliveryNote=false הוא בקשה מפורשת של אדם, ורק לפעולה הזו: תיקון של
// הזמנה שנכנסה ב"שגיאה בקריאה" בלי שתצא תעודה (ובלי שתודפס) ברגע התיקון.
// הוא אינו נשמר על ההזמנה בכוונה — מעבר סטטוס מאוחר יותר ל"טופלה"/"נמסרה"
// מפיק תעודה כרגיל, וכך הזמנה שתוקנה ונשכחה לא נשארת לתמיד בלי חיוב.
async function logStatusChange({
    from = "",
    to = "",
    functionName = "",
    order,
    issueDeliveryNote = true,
}) {
    const localTime = new Date().toLocaleString("en-GB", { timeZone: "Asia/Jerusalem" }); // Local time for Israel

    // Log the change to the console
    console.log(`Timestamp: ${localTime} | From: ${from} | To: ${to} | Function: ${functionName}`);

    // Update the order's status history in the database
    if (order) {
        order.statusHistory.push({
            from,
            to,
            changedAt: new Date(),
            // הדחייה נרשמת בהיסטוריה שמוצגת במסך ההזמנה: מי שמחפש למה אין
            // להזמנה תעודה רואה שזו הייתה בחירה ולא תקלה
            changedBy: issueDeliveryNote ? functionName : `${functionName} · ללא תעודת משלוח`,
        });

        try {
            await order.save();
            console.log("Status history updated in the database.");
        } catch (error) {
            console.error("Failed to update status history in the database:", error);
        }
    }

    // תעודת משלוח אוטומטית כשההזמנה נכנסת ל"טופלה".
    //
    // ההתלייה כאן ולא בכל controller בנפרד: זו נקודת המעבר היחידה שכל
    // שינויי הסטטוס עוברים דרכה (orderController, customerOrderController,
    // incomingOrderController), ולכן חיבור אחד מכסה את כולם ואי אפשר לשכוח
    // מסלול. require מקומי כדי לא ליצור תלות מעגלית בטעינה.
    //
    // הקריאה אינה ב-await ואינה זורקת: יצירת תעודה לא צריכה להאט או להפיל
    // עדכון סטטוס. כשלון נרשם ללוג, והתעודה ניתנת להפקה ידנית.
    if (order?._id && to && !issueDeliveryNote) {
        console.log(
            `[delivery-note] הזמנה ${order.invoice || order._id} עברה ל-${to} בלי תעודת משלוח, ` +
                `לבקשת ${functionName} — התעודה מופקת ממסך ההזמנה`
        );
    } else if (order?._id && to) {
        require("../lib/billing/autoDeliveryNote")
            .onOrderStatusChange({
                orderId: order._id,
                toStatusName: to,
                changedBy: functionName,
            })
            .catch((err) =>
                console.error("[delivery-note] הפעלה אוטומטית נכשלה:", err.message)
            );
    }
}

module.exports = logStatusChange;
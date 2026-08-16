// utils/logStatusChange.js
/**
 * Logs the status change of an order to the console and updates the order's status history.
 *
 * @param {Object} props - The properties for the status change.
 * @param {string} props.from - The previous status name.
 * @param {string} props.to - The new status name.
 * @param {string} props.functionName - The name of the function performing the change.
 * @param {Object} props.order - The order document to update (Mongoose model instance).
 */

async function logStatusChange({ from = "", to = "", functionName = "", order }) {
    const localTime = new Date().toLocaleString("en-GB", { timeZone: "Asia/Jerusalem" }); // Local time for Israel

    // Log the change to the console
    console.log(`Timestamp: ${localTime} | From: ${from} | To: ${to} | Function: ${functionName}`);

    // Update the order's status history in the database
    if (order) {
        order.statusHistory.push({
            from,
            to,
            changedAt: new Date(),
            changedBy: functionName,
        });

        try {
            await order.save();
            console.log("Status history updated in the database.");
        } catch (error) {
            console.error("Failed to update status history in the database:", error);
        }
    }

    // תעודת משלוח אוטומטית כשההזמנה נמסרת.
    //
    // ההתלייה כאן ולא בכל controller בנפרד: זו נקודת המעבר היחידה שכל
    // שינויי הסטטוס עוברים דרכה (orderController, customerOrderController,
    // incomingOrderController), ולכן חיבור אחד מכסה את כולם ואי אפשר לשכוח
    // מסלול. require מקומי כדי לא ליצור תלות מעגלית בטעינה.
    //
    // הקריאה אינה ב-await ואינה זורקת: יצירת תעודה לא צריכה להאט או להפיל
    // עדכון סטטוס. כשלון נרשם ללוג, והתעודה ניתנת להפקה ידנית.
    if (order?._id && to) {
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
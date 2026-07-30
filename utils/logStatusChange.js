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
}

module.exports = logStatusChange;
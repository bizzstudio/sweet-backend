// script/test-updateOrderWebHook.js
require("dotenv").config();
const { updateOrderWebHook } = require("../controller/orderController");
const Order = require("../models/Order");

const testUpdateOrderWebHook = async () => {
  try {

    // חיפוש ההזמנה לפי מספר invoice 10389
    const order = await Order.findOne({ invoice: 10389 });
    
    if (!order) {
      console.error("Order with invoice number 10389 not found!");
      return;
    }

    console.log(`Found order with invoice ${order.invoice}, _id: ${order._id}`);

    // יצירת mock של req
    const mockReq = {
      params: {
        id: order._id.toString() // הפונקציה מצפה ל-ObjectId
      },
      query: {
        key: process.env.CARDCOM_KEY,
        secret: process.env.CARDCOM_SECRET
      },
      body: {
        ResponseCode: 0 // 0 = הצלחה
      }
    };

    // יצירת mock של res
    const mockRes = {
      status: (code) => {
        console.log(`Response status: ${code}`);
        return mockRes;
      },
      send: (data) => {
        console.log("Response data:", JSON.stringify(data, null, 2));
        return mockRes;
      }
    };

    // קריאה לפונקציה
    console.log("\n=== Running updateOrderWebHook ===");
    await updateOrderWebHook(mockReq, mockRes);

    console.log("\n=== Test completed ===");

  } catch (error) {
    console.error("Test error:", error);
  }
};

module.exports = {
  testUpdateOrderWebHook
};
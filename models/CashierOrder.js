// models/CashierOrder.js
const mongoose = require("mongoose");
const AutoIncrement = require("mongoose-sequence")(mongoose);

const cashierOrderSchema = new mongoose.Schema(
  {
    cashier: { // הקופאי שיצר את ההזמנה
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    invoice: { // מספר הזמנה
      type: Number,
      required: false,
    },
    cart: [{}],
    user_info: {
      name: {
        type: String,
        required: false,
      },
      phone: {
        type: String,
        required: false,
      },
    },
    subTotal: {
      type: Number,
      required: true,
    },
    discount: {
      type: Number,
      required: true,
      default: 0,
    },
    offerDiscount: {
      type: Number,
      required: false,
      default: 0,
    },
    total: {
      type: Number,
      required: true,
    },
    coupon: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      required: false,
    },
    // רשימת מבצעים שנוצלו בהזמנה (למעקב אחר oncePerCustomer)
    usedOfferIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "Offer",
    }],
  },
  {
    timestamps: true,
  }
);

// AutoIncrement
cashierOrderSchema.plugin(AutoIncrement, {
  inc_field: "invoice",
  id: "cashier_invoice_counter",
  start_seq: 2000000,
});

const CashierOrder = mongoose.model("CashierOrder", cashierOrderSchema);
module.exports = CashierOrder;
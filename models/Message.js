const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
  message: {
    type: String,
    required: true,
  },
  role: {
    type: String,
    required: true,
    enum: ["delivery", "pickup", "survey"],
  },
});

const Message = mongoose.model("Message", messageSchema);

module.exports = Message;

// models/Status.js
const mongoose = require("mongoose");

const statusSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    heName: {
      type: String,
      required: true,
    },
    phone: {
      type: String,
      required: true,
    },
    color: {
      type: String,
      required: true,
      default: "#212121",
    },
    isActive: {
      type: Boolean,
      required: true,
      default: true,
    },
    password: {
      type: String,
      required: false,
      select: false
    },
  },
  {
    timestamps: true,
  }
);

const Status = mongoose.model("Status", statusSchema);

module.exports = Status;
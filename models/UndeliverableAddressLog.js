const mongoose = require('mongoose');

const UndeliverableAddressLogSchema = new mongoose.Schema(
  {
    cityNameHe: {
      type: String,
      required: true,
      trim: true,
    },
    reason: {
      type: String,
      required: true,
      enum: ['no_delivery_zone', 'no_delivery_days'],
    },
    /** תאריך לוח שנה Asia/Jerusalem בפורמט YYYY-MM-DD — לסינון ולמניעת כפילויות */
    logDay: {
      type: String,
      required: true,
      index: true,
    },
    /** מפתח ייחוד ליום: cust:ObjectId | staff:ObjectId | guest:normalizedName */
    identityKey: {
      type: String,
      required: true,
    },
    customerName: {
      type: String,
      default: '',
      trim: true,
      maxlength: 200,
    },
    customerPhone: {
      type: String,
      default: '',
      trim: true,
      maxlength: 30,
    },
  },
  { timestamps: true }
);

UndeliverableAddressLogSchema.index({ createdAt: -1 });
UndeliverableAddressLogSchema.index(
  { logDay: 1, cityNameHe: 1, identityKey: 1 },
  { unique: true }
);

module.exports = mongoose.model('UndeliverableAddressLog', UndeliverableAddressLogSchema);

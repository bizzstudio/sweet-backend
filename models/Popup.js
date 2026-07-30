const mongoose = require("mongoose");

const popupSchema = new mongoose.Schema({
  title: {
    type: String,
    required: false,
  },
  subTitle: {
    type: String,
    required: false,
  },
  description: {
    type: String,
    required: false,
  },
  link: {
    type: String,
    required: false,
  },
  linkName: {
    type: String,
    required: false,
  },
  image: {
    type: String,
    required: false,
  },
  imageHeight: {
    type: Number,
    required: false,
  },
  pageToShow: {
    type: String,
    required: true,
    validate: {
      validator: function (v) {
        return v.startsWith('/');
      },
      message: props => `${props.value} is not a valid path! Path must start with "/".`
    }
  },
  targetBlank: {
    type: Boolean,
    required: false,
    default: false,
  },
  isActive: {
    type: Boolean,
    required: false,
    default: true,
  }
}, { timestamps: true });

const Popup = mongoose.model("Popup", popupSchema);
module.exports = Popup;
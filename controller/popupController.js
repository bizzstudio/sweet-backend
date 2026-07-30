const Popup = require("../models/Popup");

const createPopup = async (req, res) => {
  try {
    const popup = new Popup(req.body);
    await popup.save();
    res.status(201).send({ data: popup, message: "Popup created successfully!" });
  } catch (err) {
    res.status(400).send(err);
  }
};

const getAllPopups = async (req, res) => {
  try {
    const popups = await Popup.find().sort({ createdAt: -1 });
    res.send(popups);
  } catch (err) {
    res.status(500).send(err);
  }
};

const getPopupById = async (req, res) => {
  try {
    const popup = await Popup.findById(req.params.id);
    if (!popup) {
      return res.status(404).send();
    }
    res.send(popup);
  } catch (err) {
    res.status(500).send(err);
  }
};

const updatePopup = async (req, res) => {
  try {
    const popup = await Popup.findById(req.params.id);

    if (!popup) {
      return res.status(404).send();
    }

    popup.title = req.body.title !== undefined ? req.body.title : popup.title;
    popup.subTitle = req.body.subTitle !== undefined ? req.body.subTitle : popup.subTitle;
    popup.description = req.body.description !== undefined ? req.body.description : popup.description;
    popup.link = req.body.link !== undefined ? req.body.link : popup.link;
    popup.linkName = req.body.linkName !== undefined ? req.body.linkName : popup.linkName;
    popup.image = req.body.image !== undefined ? req.body.image : popup.image;
    popup.imageHeight = req.body.imageHeight !== undefined ? req.body.imageHeight : popup.imageHeight;
    popup.pageToShow = req.body.pageToShow !== undefined ? req.body.pageToShow : popup.pageToShow;
    popup.targetBlank = req.body.targetBlank !== undefined ? req.body.targetBlank : popup.targetBlank;
    popup.isActive = req.body.isActive !== undefined ? req.body.isActive : popup.isActive;

    await popup.save();
    res.send({ data: popup, message: "Popup updated successfully!" });
  } catch (err) {
    res.status(400).send(err);
  }
};

const deletePopup = async (req, res) => {
  try {
    const popup = await Popup.findByIdAndDelete(req.params.id);

    if (!popup) {
      return res.status(404).send();
    }

    res.status(200).send({
      message: "Popup deleted successfully!",
    });
  } catch (err) {
    res.status(500).send(err);
  }
};

const deleteManyPopups = async (req, res) => {
  try {
    await Popup.deleteMany({ _id: { $in: req.body.ids } });
    res.status(200).send({
      message: "Popups deleted successfully!",
    });
  } catch (err) {
    console.log('deleteManyPopups error: ', err);
    res.status(500).send(err);
  }
};

module.exports = {
  createPopup,
  getAllPopups,
  getPopupById,
  updatePopup,
  deletePopup,
  deleteManyPopups,
};

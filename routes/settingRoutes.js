// routes/settingRoutes.js
const router = require("express").Router();

const { isAdmin } = require("../config/auth");
const {
  addGlobalSetting,
  getGlobalSetting,
  updateGlobalSetting,
  addStoreSetting,
  getStoreSetting,
  updateStoreSetting,
  getStoreSeoSetting,
  addStoreCustomizationSetting,
  getStoreCustomizationSetting,
  updateStoreCustomizationSetting,
  getStoreScriptsSetting,
  updateStoreScriptsSetting,
} = require("../controller/settingController");

// add a global setting
router.post("/global/add", isAdmin, addGlobalSetting);

// get global setting
router.get("/global/all", getGlobalSetting);

// update global setting
router.put("/global/update", isAdmin, updateGlobalSetting);

// add a store setting
router.post("/store-setting/add", isAdmin, addStoreSetting);

// get store setting
router.get("/store-setting/all", getStoreSetting);

// get store setting
router.get("/store-setting/seo", getStoreSeoSetting);

// update store setting
router.put("/store-setting/update", isAdmin, updateStoreSetting);

// store customization routes

// add a online store customization setting
router.post("/store/customization/add", isAdmin, addStoreCustomizationSetting);

// get online store customization setting
router.get("/store/customization/all", getStoreCustomizationSetting);

// update online store customization setting
router.put("/store/customization/update", isAdmin, updateStoreCustomizationSetting);

// get store scripts setting
router.get("/store-scripts/all", getStoreScriptsSetting);

// update store scripts setting
router.put("/store-scripts/update", isAdmin, updateStoreScriptsSetting);

module.exports = router;
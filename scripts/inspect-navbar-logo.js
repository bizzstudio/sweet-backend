// בדיקה בלבד: מה מוגדר כרגע כלוגו ההידר בהגדרות החנות
require("dotenv").config();
const { connectDB } = require("../config/db");
const Setting = require("../models/Setting");

(async () => {
  await connectDB();
  const doc = await Setting.findOne({ name: "storeCustomizationSetting" });
  if (!doc) {
    console.log("לא נמצא מסמך storeCustomizationSetting");
  } else {
    console.log("navbar.logo  =", JSON.stringify(doc.setting?.navbar?.logo));
    console.log("seo.favicon  =", JSON.stringify(doc.setting?.seo?.favicon));
    console.log("footer.block4_logo =", JSON.stringify(doc.setting?.footer?.block4_logo));
  }
  process.exit(0);
})();

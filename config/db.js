// config/db.js
require("dotenv").config();
const mongoose = require("mongoose");

// MONGO_DB_NAME מאפשר להצביע על מסד נתונים חדש על אותו שרת/קלאסטר,
// בלי לגעת במסד הישן ובלי לשנות את MONGO_URI.
const connectDB = async () => {
  try {
    const dbName = process.env.MONGO_DB_NAME;
    await mongoose.connect(process.env.MONGO_URI, dbName ? { dbName } : {});
    console.log(`mongodb connection success! (db: ${mongoose.connection.name})`);
  } catch (err) {
    console.log("mongodb connection failed!", err.message);
  }
};

module.exports = {
  connectDB,
};

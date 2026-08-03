require("dotenv").config();
const mongoose = require("mongoose");
const Order = require("../models/Order");
const Status = require("../models/Status");

(async () => {
  await mongoose.connect(
    process.env.MONGO_URI,
    process.env.MONGO_DB_NAME ? { dbName: process.env.MONGO_DB_NAME } : {}
  );
  const id = "6a32527049178b09df3e940f";
  const o = await Order.findById(id).lean();
  if (!o) {
    console.log("ORDER NOT FOUND:", id);
  } else {
    const st = o.status ? await Status.findById(o.status).lean() : null;
    console.log("invoice:", o.invoice);
    console.log("createdAt:", o.createdAt);
    console.log("updatedAt:", o.updatedAt);
    console.log("status:", st?.name);
    console.log("paymentMethod:", o.paymentMethod);
    console.log("total:", o.total);
    console.log("has cardInfo (webhook arrived):", !!o.cardInfo, o.cardInfo?.ResponseCode);
    console.log("statusHistory:", JSON.stringify(o.statusHistory, null, 2));
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });

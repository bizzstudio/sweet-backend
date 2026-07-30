// סקריפט אבחון (קריאה בלבד) — בודק מדוע מבצעים/מתנות לא חלים בפרודקשן
// הרצה: node script/diagnoseOffers.js
require("dotenv").config();
const mongoose = require("mongoose");
const Offer = require("../models/Offer");

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const now = new Date();
  console.log("=== זמן המכונה ===");
  console.log("now (ISO/UTC):", now.toISOString());
  console.log("now (local):  ", now.toString());
  console.log("TZ env:       ", process.env.TZ || "(לא מוגדר → UTC)");
  console.log("offset(min):  ", now.getTimezoneOffset());
  console.log("");

  const offers = await Offer.find({}).lean();
  console.log(`=== סה"כ מבצעים ב-DB: ${offers.length} ===\n`);

  for (const o of offers) {
    const name = o.name?.he || o.name?.en || JSON.stringify(o.name);
    const passStarts = !o.startsAt || new Date(o.startsAt) <= now;
    const passEnds = !o.endsAt || new Date(o.endsAt) >= now;
    const active = o.isActive && passStarts && passEnds;
    console.log(`• "${name}" [${o.type}]`);
    console.log(`    isActive:    ${o.isActive}`);
    console.log(`    startsAt:    ${o.startsAt ? new Date(o.startsAt).toISOString() : "(אין)"}  -> ${passStarts ? "OK" : "עוד לא התחיל"}`);
    console.log(`    endsAt:      ${o.endsAt ? new Date(o.endsAt).toISOString() : "(אין)"}  -> ${passEnds ? "OK" : "פג תוקף!"}`);
    if (o.rewardPrice !== undefined) console.log(`    rewardPrice: ${o.rewardPrice}  ${o.rewardPrice === 0 ? "(מתנה חינם)" : "(לא 0 → לא יתווסף אוטומטית כמתנה)"}`);
    console.log(`    thresholdAmount: ${o.thresholdAmount ?? "-"}, rewardQuantity: ${o.rewardQuantity ?? "-"}`);
    console.log(`    forNewCustomersOnly: ${o.forNewCustomersOnly}, oncePerCustomer: ${o.oncePerCustomer}, allowStacking: ${o.allowStackingWithOtherOffers}`);
    console.log(`    ==> ${active ? "✅ פעיל כעת" : "❌ לא פעיל כעת"}\n`);
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error("שגיאה:", e.message);
  process.exit(1);
});

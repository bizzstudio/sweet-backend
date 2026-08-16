// utils/deliveryNoteNumber.js
//
// הקצאת מספר תעודת משלוח. אותו מנגנון בדיוק כמו utils/invoiceNumber — מונה
// אטומי בקולקציית app_counters — ומאותן סיבות: מחיקת תעודה לא משחררת מספר,
// ושתי יצירות מקבילות לא מקבלות אותו מספר.
//
// הסדרה נפרדת ממספרי ההזמנות בכוונה. מספר ההזמנה הוא מספר פנימי; תעודת
// המשלוח היא מסמך שיוצא ללקוח, והוא צריך סדרה רציפה משלו שאפשר להצביע
// עליה מול רואה חשבון.

const Counter = require("../models/Counter");
const DeliveryNote = require("../models/DeliveryNote");

const COUNTER_ID = "delivery_note";
// המספר הראשון שיוקצה. seq מחזיק את האחרון שהוקצה ולכן מאותחל ל-1 פחות.
const FIRST_NUMBER = 1000;
const MAX_SKIPS = 50;

let seeding = null;

/**
 * אתחול המונה. במסד ריק הוא מתחיל מ-FIRST_NUMBER; אם כבר קיימות תעודות
 * (ייבוא ידני, שחזור) הוא מתרומם מעליהן כדי לא להתנגש.
 *
 * $setOnInsert + upsert אטומי — שני תהליכים שעולים יחד לא ידרסו זה את זה.
 */
const ensureSeeded = () => {
  if (seeding) return seeding;

  seeding = (async () => {
    const existing = await Counter.findById(COUNTER_ID).select("_id").lean();
    if (existing) return;

    const highest = await DeliveryNote.findOne({ number: { $ne: null } })
      .sort({ number: -1 })
      .select("number")
      .lean();

    const seq = Math.max(highest?.number || 0, FIRST_NUMBER - 1);

    try {
      await Counter.updateOne(
        { _id: COUNTER_ID },
        { $setOnInsert: { seq } },
        { upsert: true }
      );
      console.log(`[delivery-note] מונה תעודות המשלוח אותחל ל-${seq}`);
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  })();

  seeding.catch(() => {
    seeding = null;
  });

  return seeding;
};

const nextNumber = async () => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await ensureSeeded();

    const counter = await Counter.findByIdAndUpdate(
      COUNTER_ID,
      { $inc: { seq: 1 } },
      { new: true }
    );
    if (counter) return counter.seq;

    seeding = null;
  }

  throw new Error("הקצאת מספר תעודת משלוח נכשלה — מסמך המונה אינו זמין");
};

/**
 * מקצה את מספר התעודה הבא שאינו תפוס.
 *
 * @returns {Promise<number>}
 */
const nextFreeNumber = async () => {
  for (let attempt = 1; attempt <= MAX_SKIPS; attempt++) {
    const candidate = await nextNumber();
    const taken = await DeliveryNote.exists({ number: candidate });
    if (!taken) return candidate;
    console.warn(`[delivery-note] מספר ${candidate} כבר תפוס — מדלג`);
  }

  throw new Error(
    `הקצאת מספר תעודת משלוח נכשלה — ${MAX_SKIPS} מספרים רצופים תפוסים`
  );
};

module.exports = { nextFreeNumber };

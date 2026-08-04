// script/reclassify-conversations.js
//
// מיון מחדש של הודעות שנקלטו לפני תיקון זיהוי השיחה.
//
// הרצה:   npm run ingest:reclassify              (דוח בלבד — לא נוגע בכלום)
//         npm run ingest:reclassify -- --apply   (מבצע בפועל)
//
// ── למה זה קיים ──
//
// המימוש הקודם של certainNotOrder דרש סימן שאלה מפורש כדי להכריע שהודעה היא
// שיחה. בווצאפ רוב השיחה נכתבת בלי סימן שאלה ("בסדר", "אני אשלח אחר כך"),
// ולכן כמעט כל הודעה נחתה בסטטוס failed עם קוד no_items — כלומר בלשונית
// "הזמנות שגויות", שהיא לשונית ברירת המחדל של מסך הקליטה. התוצאה הייתה אלפי
// הודעות שיחה שהטביעו את ההזמנות שבאמת נכשלו.
//
// הקוד תוקן (ראה looksLikeOrderAttempt ב-tableParser), אבל הרשומות שכבר
// נשמרו נושאות את הסטטוס הישן. הסקריפט מריץ עליהן את הפרסר המתוקן ומעביר
// ל-not_an_order רק את מה שהוא מכריע עליו היום כשיחה.
//
// ── מה הסקריפט לא נוגע בו ──
//
//   • רשומה שיש לה הזמנה מקושרת (doc.order). הנתיב שיוצר הזמנת שגיאה שונה
//     מהנתיב שהתיקון נגע בו, ורשומה כזו דורשת החלטה של אדם ולא מיון אוטומטי.
//   • כל errorCode שאינו no_items. כשל בהתאמת פריטים, כתובת או מלאי אינו
//     קשור לזיהוי השיחה, וההכרעה עליו לא השתנתה.
//   • רשומות שהפרסר המתוקן עדיין מכריע עליהן כניסיון הזמנה — הן נשארות
//     בדיוק היכן שהן, וזו כל הנקודה: מה שנשאר בלשונית הוא מה שבאמת דורש טיפול.
//
// הפעולה הפיכה: הסטטוס משתנה ו-error/errorCode מתאפסים, אבל rawText, messages
// ו-attachments נשארים כמו שהם, ולכן כפתור "הרץ שוב" בדשבורד עדיין עובד על
// כל רשומה כזו.

require("dotenv").config();
const mongoose = require("mongoose");
const IncomingOrder = require("../models/IncomingOrder");
const { parseOrderText } = require("../lib/order-ingestion/tableParser");

const APPLY = process.argv.includes("--apply");

// מדגם שמודפס בדוח, כדי שאפשר יהיה לראות בעיניים מה עומד לזוז לפני --apply
const SAMPLE_SIZE = 15;

const preview = (text, length = 70) => {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
};

const run = async () => {
  const dbName = process.env.MONGO_DB_NAME;
  await mongoose.connect(process.env.MONGO_URI, dbName ? { dbName } : {});
  console.log(`מסד: ${mongoose.connection.name}\n`);

  const filter = {
    status: "failed",
    errorCode: "no_items",
    // רשומה שנוצרה ממנה הזמנה אינה במסלול הזה — ראה ההערה בראש הקובץ
    $or: [{ order: null }, { order: { $exists: false } }],
  };

  const toReclassify = [];
  const staying = [];
  let scanned = 0;

  // ── סריקה בזרימה ולא find() אחד ──
  //
  // ‏rawText של רשומה שנצברה מגיע ל-40,000 תווים, ומספר הרשומות כאן הוא בדיוק
  // מה שהתיקון בא לצמצם — כלומר עלול להיות גדול. טעינת כולן לזיכרון בבת אחת
  // היא בדיוק הדבר שאסור לעשות בסקריפט חד-פעמי שרץ מול פרודקשן.
  const cursor = IncomingOrder.find(filter, {
    rawText: 1,
    attachments: 1,
    messages: 1,
    sender: 1,
    channel: 1,
  })
    .lean()
    .cursor();

  for await (const doc of cursor) {
    scanned += 1;

    // ── חייב להיות זהה לקריאה ב-analyzeMessage ──
    // כל שדה שנשמט כאן פירושו שהסקריפט מכריע אחרת מהצינור החי, והרשומה
    // תמוין למקום שהריצה האמיתית לא הייתה שולחת אליו.
    const parsed = parseOrderText({
      text: doc.rawText,
      channel: doc.channel,
      sender: doc.sender,
      attachments: doc.attachments || [],
      segments: (doc.messages || []).map((message) => message.text),
    });

    // הפרסר המתוקן מכריע שזו שיחה — ורק אז מעבירים.
    // isOrder אמור להיות false בכל הרשומות האלה, אבל הבדיקה נשארת: אם התיקון
    // *כן* הפך משהו לקריא, מקומו בהרצה חוזרת מהדשבורד ולא כאן.
    if (!parsed.isOrder && parsed.certainNotOrder) {
      toReclassify.push({
        _id: doc._id,
        channel: doc.channel,
        rawText: doc.rawText,
        reason: parsed.notAnOrderReason,
      });
    } else {
      staying.push({ rawText: doc.rawText });
    }
  }

  if (!scanned) {
    console.log('אין רשומות בסטטוס "שגיאה בקריאה" עם הקוד no_items — אין מה למיין.');
    await mongoose.disconnect();
    return;
  }

  const byChannel = toReclassify.reduce((acc, row) => {
    acc[row.channel] = (acc[row.channel] || 0) + 1;
    return acc;
  }, {});

  console.log(`נבדקו ${scanned} רשומות\n`);
  console.log(`${"─".repeat(70)}`);
  console.log(`למיון מחדש כ"לא הזמנה": ${toReclassify.length}`);
  for (const [channel, count] of Object.entries(byChannel)) {
    console.log(`   ${channel}: ${count}`);
  }
  console.log(`נשארות ב"הזמנות שגויות": ${staying.length}`);
  console.log(`${"─".repeat(70)}\n`);

  if (toReclassify.length) {
    console.log(`מדגם ממה שיזוז (${Math.min(SAMPLE_SIZE, toReclassify.length)} מתוך ${toReclassify.length}):`);
    for (const row of toReclassify.slice(0, SAMPLE_SIZE)) {
      console.log(`   • ${preview(row.rawText)}`);
    }
    console.log("");
  }

  if (staying.length) {
    console.log(`מדגם ממה שיישאר לטיפול (${Math.min(SAMPLE_SIZE, staying.length)} מתוך ${staying.length}):`);
    for (const row of staying.slice(0, SAMPLE_SIZE)) {
      console.log(`   • ${preview(row.rawText)}`);
    }
    console.log("");
  }

  if (!APPLY) {
    console.log("דוח בלבד — לא בוצע שינוי.");
    console.log("להרצה בפועל: npm run ingest:reclassify -- --apply");
    await mongoose.disconnect();
    return;
  }

  const now = new Date();
  let modified = 0;

  // כתיבה במנות. ‏bulkWrite אחד עם עשרות אלפי פעולות הוא בקשה ענקית למסד,
  // ובמנות אפשר גם לדווח התקדמות במקום שקט ארוך.
  const BATCH = 500;

  for (let offset = 0; offset < toReclassify.length; offset += BATCH) {
    const batch = toReclassify.slice(offset, offset + BATCH);

    const result = await IncomingOrder.bulkWrite(
      batch.map((row) => ({
        updateOne: {
          // ‏status בפילטר ולא רק ה-_id: בין הסריקה לכתיבה מישהו יכול היה ללחוץ
          // "הרץ שוב" או "התעלם" באותה רשומה, וכתיבה עיוורת הייתה דורסת את
          // התוצאה שלו. רשומה שהשתנתה בינתיים פשוט לא תעודכן.
          filter: { _id: row._id, status: "failed", errorCode: "no_items" },
          update: {
            $set: {
              status: "not_an_order",
              errorCode: null,
              "parsed.certainNotOrder": true,
              "parsed.notAnOrderReason": row.reason,
            },
            // ‏$unset ולא `$set: { error: undefined }` — מונגוס משמיטה ערכי
            // undefined מה-update, ולכן הודעת הכשל הישנה הייתה נשארת ברשומה
            // בזמן שהסטטוס כבר אומר "לא הזמנה".
            $unset: { error: "" },
            $push: {
              logs: {
                at: now,
                step: "reclassify",
                message: `מוינה מחדש כהודעת שיחה ע"י reclassify-conversations: ${row.reason}`,
              },
            },
          },
        },
      }))
    );

    modified += result.modifiedCount || 0;
    if (toReclassify.length > BATCH) {
      console.log(`   ${Math.min(offset + BATCH, toReclassify.length)}/${toReclassify.length}…`);
    }
  }

  const skipped = toReclassify.length - modified;
  console.log(`בוצע. ${modified} רשומות הועברו ל"לא הזמנה".`);
  if (skipped > 0) {
    console.log(`${skipped} רשומות שונו בינתיים ע"י מישהו אחר ולא נגענו בהן.`);
  }
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

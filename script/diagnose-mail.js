// script/diagnose-mail.js
//
// "למה ההזמנה הזו לא נכנסה?" — הסקריפט הזה עונה על השאלה.
//
// הרצה:   npm run mail:diag
//
// עובר על כל הודעה בחלון הסריקה ומדפיס מה יקרה לה: האם היא כבר במערכת, האם
// השולח מזוהה כלקוח, והאם היא תיקלט. **קריאה בלבד** — לא נוגע בתיבה, לא כותב
// ל-DB, לא יוצר הזמנות.

require("dotenv").config();
const mongoose = require("mongoose");
const { ImapFlow } = require("imapflow");

const IncomingOrder = require("../models/IncomingOrder");
const Customer = require("../models/Customer");
const { canonicalPhone } = require("../utils/phone");

const SINCE_DAYS = Number(process.env.MAIL_SINCE_DAYS) || 2;
const MAILBOX = process.env.IMAP_MAILBOX || "INBOX";

const pad = (text, width) => String(text || "").slice(0, width).padEnd(width);

const run = async () => {
  const user = process.env.IMAP_USER || process.env.EMAIL_USER;
  const pass = process.env.IMAP_PASS || process.env.EMAIL_PASS;

  if (!user || !pass) {
    console.error("\nחסרים EMAIL_USER / EMAIL_PASS ב-.env\n");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  const client = new ImapFlow({
    host: process.env.IMAP_HOST || "imap.gmail.com",
    port: Number(process.env.IMAP_PORT) || 993,
    secure: true,
    auth: { user, pass },
    logger: false,
    greetingTimeout: 15000,
    connectionTimeout: 20000,
  });

  await client.connect();
  const lock = await client.getMailboxLock(MAILBOX);

  try {
    const since = new Date(Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000);
    const uids = (await client.search({ since }, { uid: true })) || [];
    const unseen = (await client.search({ since, seen: false }, { uid: true })) || [];

    console.log(`\nתיבה: ${user}   תיקייה: ${MAILBOX}`);
    console.log(`חלון: ${SINCE_DAYS} ימים אחורה (מאז ${since.toLocaleDateString("he-IL")})`);
    console.log(`הודעות בחלון: ${uids.length}   מתוכן לא נקראו: ${unseen.length}`);

    if (!uids.length) {
      console.log("\nאין הודעות בחלון. אם ההזמנה ישנה יותר — העלה MAIL_SINCE_DAYS.\n");
      return;
    }

    const messages = [];
    for await (const msg of client.fetch(
      uids,
      { uid: true, envelope: true, flags: true },
      { uid: true }
    )) {
      messages.push({
        uid: msg.uid,
        messageId: (msg.envelope?.messageId || "").trim(),
        from: (msg.envelope?.from?.[0]?.address || "").toLowerCase(),
        subject: msg.envelope?.subject || "",
        seen: Boolean(msg.flags?.has("\\Seen")),
      });
    }

    console.log("\n" + "─".repeat(104));
    console.log(pad("מצב", 6) + "│ " + pad("שולח", 32) + "│ " + pad("נושא", 30) + "│ מה יקרה");
    console.log("─".repeat(104));

    const tally = { already: 0, unknown: 0, willIngest: 0, noId: 0 };

    for (const msg of messages) {
      let verdict;

      if (msg.from && msg.from === String(process.env.EMAIL_USER || "").toLowerCase()) {
        verdict = "מייל שאנחנו שלחנו — מדולג";
        tally.self = (tally.self || 0) + 1;
      } else if (!msg.messageId) {
        verdict = "אין Message-ID — יזוהה לפי UID";
        tally.noId += 1;
      } else {
        const existing = await IncomingOrder.findOne({ externalId: `email:${msg.messageId}` })
          .select("status invoice")
          .lean();

        if (existing) {
          verdict = `כבר במערכת (${existing.status}${existing.invoice ? ` #${existing.invoice}` : ""})`;
          tally.already += 1;
        } else {
          const customer = msg.from
            ? await Customer.findOne({ email: msg.from }).select("_id").lean()
            : null;

          if (customer) {
            verdict = "תיקלט ותעובד";
            tally.willIngest += 1;
          } else {
            verdict = "תיקלט כ\"שולח לא מוכר\" — הלקוח אינו במערכת";
            tally.unknown += 1;
          }
        }
      }

      console.log(
        pad(msg.seen ? "נקרא" : "חדש", 6) +
          "│ " + pad(msg.from, 32) +
          "│ " + pad(msg.subject, 30) +
          "│ " + verdict
      );
    }

    console.log("─".repeat(104));
    console.log(
      `סיכום: ${tally.willIngest} ייקלטו ויעובדו | ${tally.unknown} שולח לא מוכר | ` +
        `${tally.already} כבר במערכת`
    );

    if (tally.already) {
      console.log(
        "\nהודעה שכבר במערכת לא נקלטת שוב. אם היא נקלטה בטעות כ\"שולח לא מוכר\"" +
          "\nוהוספת את הלקוח מאז — יש להשתמש ב\"נסה שוב\" בדשבורד, לא לחכות לסריקה."
      );
    }
    console.log("");
  } finally {
    lock.release();
    await client.logout().catch(() => client.close());
    await mongoose.disconnect();
  }
};

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nשגיאה: ${err.message}\n`);
    process.exit(1);
  });

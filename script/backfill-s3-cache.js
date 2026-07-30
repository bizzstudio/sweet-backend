// script/backfill-s3-cache.js
//
// חד-פעמי: מוסיף Cache-Control לכל האובייקטים הקיימים ב-S3 שהועלו לפני שקוד ההעלאה
// (utils/awsUploader.js) התחיל לצרוב CacheControl. פותר את "Use efficient cache lifetimes"
// עבור תמונות ישנות (category/, HomePage/, blogs/ וכו').
//
// כל אובייקט מקבל copy-in-place עם MetadataDirective: REPLACE — CacheControl חדש,
// וה-ContentType המקורי נשמר (נקרא דרך HeadObject) כדי לא לשבור הגשת תמונות.
//
// שימוש:
//   node script/backfill-s3-cache.js               # כל הבאקט (זהירות: באקט משותף)
//   node script/backfill-s3-cache.js category      # רק prefix מסוים (מומלץ)
//   node script/backfill-s3-cache.js category/ HomePage/ blogs/   # כמה prefixes
//   DRY_RUN=1 node script/backfill-s3-cache.js category           # הרצת יבש (רק מדפיס)

require("dotenv").config();
const {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  CopyObjectCommand,
} = require("@aws-sdk/client-s3");

const Bucket = process.env.BUCKET;
const region = process.env.AMAZON_REGION;
const CACHE_CONTROL = "public, max-age=31536000, immutable";
const DRY_RUN = process.env.DRY_RUN === "1";

const s3 = new S3Client({
  region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const prefixes = process.argv.slice(2);
if (prefixes.length === 0) prefixes.push(""); // כל הבאקט

async function* listAll(prefix) {
  let ContinuationToken;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken })
    );
    for (const obj of res.Contents || []) yield obj;
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
}

async function processKey(Key) {
  // דילוג על "תיקיות" (מפתחות שמסתיימים ב-/)
  if (Key.endsWith("/")) return "skip";

  const head = await s3.send(new HeadObjectCommand({ Bucket, Key }));

  // כבר מוגדר cache ארוך — מדלגים כדי לחסוך קריאות
  if (head.CacheControl && /max-age=\d{6,}/.test(head.CacheControl)) return "skip";

  if (DRY_RUN) {
    console.log(`[dry] would set cache on: ${Key} (type=${head.ContentType})`);
    return "dry";
  }

  await s3.send(
    new CopyObjectCommand({
      Bucket,
      Key,
      CopySource: `/${Bucket}/${encodeURIComponent(Key)}`,
      MetadataDirective: "REPLACE",
      CacheControl: CACHE_CONTROL,
      ContentType: head.ContentType || "application/octet-stream",
      Metadata: head.Metadata || {},
    })
  );
  return "updated";
}

(async () => {
  if (!Bucket || !region) {
    console.error("Missing BUCKET / AMAZON_REGION env vars");
    process.exit(1);
  }
  console.log(
    `Bucket=${Bucket} region=${region} prefixes=[${prefixes.join(", ")}] dryRun=${DRY_RUN}`
  );

  let updated = 0,
    skipped = 0,
    failed = 0;

  for (const prefix of prefixes) {
    for await (const obj of listAll(prefix)) {
      try {
        const r = await processKey(obj.Key);
        if (r === "updated" || r === "dry") {
          updated++;
          if (updated % 50 === 0) console.log(`...${updated} processed`);
        } else {
          skipped++;
        }
      } catch (e) {
        failed++;
        console.error(`FAIL ${obj.Key}: ${e.message}`);
      }
    }
  }

  console.log(`\nDone. updated=${updated} skipped=${skipped} failed=${failed}`);
})();

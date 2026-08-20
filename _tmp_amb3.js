require('dotenv').config();
const mongoose = require('mongoose');
const { matchProductByName } = require('./utils/productMatching');
(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  for (const q of ['חלב 3% - בקרטונים של ליטר בלבד!','משקה אגוזי לוז','נס קפה עלית גדול','בייגלה שטוחים עם מלח']) {
    const m = await matchProductByName(q, { requireShown:false, requireStock:false, alternativesCount:2 });
    const ok = m.confidence >= 0.7 ? '✓ נכנס' : '✗ לאדם';
    console.log(`${ok}  ביטחון ${String(m.confidence).padEnd(5)} ${JSON.stringify(q)}`);
    console.log(`            → ${m.product.title.he}`);
  }
  await mongoose.disconnect();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});

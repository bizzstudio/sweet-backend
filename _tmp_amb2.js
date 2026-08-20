require('dotenv').config();
const mongoose = require('mongoose');
const { matchProductByName } = require('./utils/productMatching');
(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  for (const q of ['חלב 3% - בקרטונים של ליטר בלבד!','משקה אגוזי לוז','נס קפה עלית גדול','בייגלה שטוחים עם מלח']) {
    const m = await matchProductByName(q, { requireShown:false, requireStock:false, alternativesCount:3 });
    console.log(`\n▸ ${JSON.stringify(q)}   ביטחון ${m?.confidence}`);
    console.log(`   1. ${String(Math.round(m.score)).padStart(6)}  ${m.product.title.he}`);
    (m.alternatives||[]).forEach((a,i)=>console.log(`   ${i+2}. ${String(Math.round(a.score)).padStart(6)}  ${a.title.he}`));
  }
  await mongoose.disconnect();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});

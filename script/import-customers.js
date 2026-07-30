// scripts/import-customers.js
// יבוא לקוחות מ-Excel אל MongoDB לפי תנאים:
// רק רשומות עם: שם פרטי + טלפון + אימייל
// מתעלמים מכל שאר השדות, בלי סיסמה.

// ===== הגדרות כלליות =====
require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');
const XLSX = require('xlsx');

// נתיב הקובץ כפי שביקשת
const XLSX_PATH = path.resolve(process.cwd(), 'data/tomer.customers.xlsx');

// נסה לייבא את המודל הקיים שלך. אם הנתיב שונה - עדכן כאן.
let Customer;
try {
    Customer = require('../models/Customer'); // עדכן אם המודל במקום אחר
} catch (e) {
    // fallback: נגדיר Schema מינימלי תואם רק למה שאנחנו מכניסים
    console.warn('[import] Could not load ../models/Customer; using minimal schema for import.');
    const customerSchema = new mongoose.Schema(
        {
            name: { type: String, required: true },
            lastName: { type: String, required: false },
            email: { type: String, required: true, unique: true, lowercase: true },
            phone: { type: String, required: false },
        },
        { timestamps: true }
    );
    Customer = mongoose.model('Customer', customerSchema);
}

// ===== עזרי עיבוד =====

// וריאנטים אפשריים לכותרות בעברית/אנגלית:
const HEADER_CANDIDATES = {
    firstName: [
        'name'
    ],
    lastName: [
        'lastName'
    ],
    email: [
        'email'
    ],
    phone: [
        'phone'
    ],
};

// נורמליזציה לשמות כותרות: להוריד רווחים/דיאקריטיקות סימניות נפוצות, לאנגלית קטנה
function normHeader(h) {
    return String(h)
        .trim()
        .toLowerCase()
        .replace(/\u200f|\u200e/g, '')       // RTL/LTR marks
        .replace(/[._\-–—\s]+/g, ' ')        // מפרידי מלים לנורמליזציה
        .replace(/\s+/g, ' ')
        .trim();
}

// נבנה מפה בין כותרות גליון לבין השדות שאנחנו צריכים
function buildHeaderMap(headers) {
    const map = { firstName: null, lastName: null, email: null, phone: null };
    const normalized = headers.map(normHeader);

    function findMatch(candidates) {
        for (const cand of candidates) {
            const normCand = normHeader(cand);
            const idx = normalized.findIndex((h) => h === normCand);
            if (idx !== -1) return headers[idx]; // מחזיר את הכותרת המקורית (case/RTL)
        }
        // חיפוש רפוי: אם cand הוא תת-מחרוזת
        for (const cand of candidates) {
            const normCand = normHeader(cand);
            const idx = normalized.findIndex((h) => h.includes(normCand));
            if (idx !== -1) return headers[idx];
        }
        return null;
    }

    map.firstName = findMatch(HEADER_CANDIDATES.firstName);
    map.lastName = findMatch(HEADER_CANDIDATES.lastName);
    map.email = findMatch(HEADER_CANDIDATES.email);
    map.phone = findMatch(HEADER_CANDIDATES.phone);

    return map;
}

// נורמליזציית טלפון פשוטה לישראל: מסיר לא-ספרות, מנסה להחזיר בפורמט +972...
function normalizePhone(raw) {
    if (!raw) return '';
    let s = String(raw).trim();

    // אם זה מספר שהגיע מאקסל כמספר (ללא אפסים מובילים)
    if (/^\d+(\.\d+)?$/.test(s)) {
        // הסר חלק עשרוני אם נכנס בטעות
        s = s.split('.')[0];
    }

    // הסרת כל מה שלא ספרה או + (כולל מקפים, רווחים, נקודות וכו')
    s = s.replace(/[^\d+]/g, '');

    // כבר בפורמט בינלאומי
    if (s.startsWith('+')) return s;

    // אם מתחיל ב-0 (ישראלי): 0XXXXXXXXX -> +972XXXXXXXXX (בלי ה-0)
    if (s.startsWith('0')) {
        return '+972' + s.slice(1);
    }

    // אם יש בדיוק 9 ספרות (מספר ישראלי ללא 0): XXXXXXXXX -> +972XXXXXXXX
    if (/^\d{9}$/.test(s)) {
        return '+972' + s;
    }

    // השאר כמו שהוא (לא מכריח ישראלי)
    return s;
}

// פיצול שם מלא לשם פרטי/משפחה בסיסי
function splitName(firstNameRaw, lastNameRaw) {
    const first = (firstNameRaw || '').toString().trim();
    const last = (lastNameRaw || '').toString().trim();

    if (first && last) return { name: first, lastName: last };

    // אם "first" מכיל שם מלא, ננסה לפצל
    const parts = first.split(/\s+/);
    if (parts.length > 1) {
        return { name: parts[0], lastName: parts.slice(1).join(' ') };
    }

    return { name: first, lastName: '' };
}

// ===== קריאת האקסל =====
function readXlsxRows(filePath) {
    const wb = XLSX.readFile(filePath, { cellDates: false, raw: false });
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' }); // אובייקטים לפי כותרות
    return rows;
}

// ===== לוגיקת הייבוא =====
async function importCustomers() {
    const uri = process.env.MONGO_URI;
    if (!uri) {
        console.error('MONGO_URI not defined in .env');
        process.exit(1);
    }

    await mongoose.connect(uri);
    console.log('[import] Connected to MongoDB');

    const rows = readXlsxRows(XLSX_PATH);
    if (!rows.length) {
        console.log('[import] No rows found in the sheet.');
        await mongoose.disconnect();
        return;
    }

    const headers = Object.keys(rows[0]);
    const headerMap = buildHeaderMap(headers);

    if (!headerMap.firstName || !headerMap.email || !headerMap.phone) {
        console.error('[import] Required headers not found in sheet. Found:', headerMap);
        console.error('Make sure headers exist for first name, email and phone (Hebrew/English).');
        await mongoose.disconnect();
        process.exit(1);
    }

    console.log('[import] Header mapping:', headerMap);

    const seenEmails = new Set(); // מניעת כפילויות בתוך הקובץ עצמו
    const ops = [];

    let total = 0;
    let kept = 0;
    let skippedMissing = 0;
    let skippedDupInFile = 0;

    for (const r of rows) {
        total += 1;

        const firstRaw = r[headerMap.firstName];
        const lastRaw = headerMap.lastName ? r[headerMap.lastName] : '';
        const emailRaw = r[headerMap.email];
        const phoneRaw = r[headerMap.phone];

        const email = (emailRaw || '').toString().trim().toLowerCase();
        const phone = normalizePhone(phoneRaw);
        const { name, lastName } = splitName(firstRaw, lastRaw);

        // תנאי הסינון: חייבים שם פרטי + טלפון + אימייל
        if (!name || !email || !phone) {
            skippedMissing += 1;
            continue;
        }

        if (seenEmails.has(email)) {
            skippedDupInFile += 1;
            continue;
        }
        seenEmails.add(email);

        // נכניס/נעשה upsert לפי אימייל בלבד
        ops.push({
            updateOne: {
                filter: { email },
                update: {
                    $set: {
                        name,
                        lastName,
                        phone,
                    },
                    $setOnInsert: {
                        email, // חשוב שיהיה גם ב-onInsert
                        createdAt: new Date(),
                    },
                },
                upsert: true,
            },
        });
    }

    console.log(`[import] Rows in file: ${total}`);
    console.log(`[import] Passed threshold (name+phone+email): ${seenEmails.size}`);
    console.log(`[import] Skipped missing fields: ${skippedMissing}, duplicates by email in file: ${skippedDupInFile}`);

    if (!ops.length) {
        console.log('[import] Nothing to upload.');
        await mongoose.disconnect();
        return;
    }

    try {
        const res = await Customer.bulkWrite(ops, { ordered: false });
        kept = res.upsertedCount + (res.modifiedCount || 0);
        console.log('[import] Results:', {
            matched: res.matchedCount,
            modified: res.modifiedCount,
            upserted: res.upsertedCount,
        });
    } catch (err) {
        console.error('[import] Error in bulkWrite:', err?.writeErrors || err?.message || err);
    } finally {
        await mongoose.disconnect();
        console.log('[import] Disconnected from MongoDB. Finished.');
    }
}

// הרצה
importCustomers().catch(async (e) => {
    console.error('[import] General failure:', e);
    try { await mongoose.disconnect(); } catch { }
    process.exit(1);
});

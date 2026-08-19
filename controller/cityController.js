// controller/cityController.js
// פרוקסי לרשימת הערים בישראל מ-data.gov.il.
// הקריאה חייבת לרוץ מהשרת: data.gov.il לא מחזיר Access-Control-Allow-Origin,
// ולכן fetch ישיר מהדפדפן נחסם ב-CORS והרשימה חוזרת ריקה.
// התשובה מוחזרת במבנה זהה לזה של data.gov.il ({ result: { records } })
// כדי שהצד הלקוח לא ידרוש שינוי מבני.
const fs = require("fs");
const path = require("path");

const GOV_URL =
  "https://data.gov.il/api/3/action/datastore_search?resource_id=8f714b6f-c35c-4b40-a0e7-547b675eee0e&limit=100000";

const CACHE_FILE = path.join(__dirname, "..", "data", "cities-cache.json");
const TTL_MS = 24 * 60 * 60 * 1000; // רשימת הערים משתנה נדיר – רענון פעם ביום

let memoryCache = null; // { fetchedAt, records }
let inFlight = null;    // מונע קריאות מקבילות כפולות ל-data.gov.il

const sortRecords = (records) =>
  [...records].sort((a, b) =>
    (a.city_name_he || "").trim().localeCompare((b.city_name_he || "").trim(), "he")
  );

const readDiskCache = () => {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (Array.isArray(raw.records) && raw.records.length) return raw;
  } catch (_) {}
  return null;
};

const writeDiskCache = (payload) => {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload));
  } catch (err) {
    console.error("cities: failed writing disk cache:", err.message);
  }
};

const fetchFromGov = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(GOV_URL, { signal: controller.signal });
    if (!res.ok) throw new Error("data.gov.il responded " + res.status);
    const data = await res.json();
    const records = data && data.result && data.result.records;
    if (!Array.isArray(records) || !records.length) {
      throw new Error("data.gov.il returned no records");
    }
    const payload = { fetchedAt: Date.now(), records: sortRecords(records) };
    memoryCache = payload;
    writeDiskCache(payload);
    return payload;
  } finally {
    clearTimeout(timer);
  }
};

const getCities = async (req, res) => {
  try {
    if (!memoryCache) memoryCache = readDiskCache();

    const fresh = memoryCache && Date.now() - memoryCache.fetchedAt < TTL_MS;
    if (fresh && req.query.refresh !== "1") {
      return res.send({ success: true, result: { records: memoryCache.records } });
    }

    // מרעננים – אבל אם data.gov.il נופל, ממשיכים להגיש את המטמון הישן
    try {
      if (!inFlight) {
        inFlight = fetchFromGov();
        inFlight.catch(() => {}).then(() => { inFlight = null; });
      }
      const payload = await inFlight;
      return res.send({ success: true, result: { records: payload.records } });
    } catch (err) {
      console.error("cities: refresh failed:", err.message);
      if (memoryCache && memoryCache.records && memoryCache.records.length) {
        return res.send({ success: true, result: { records: memoryCache.records } });
      }
      throw err;
    }
  } catch (err) {
    res
      .status(502)
      .send({ success: false, message: "לא ניתן לטעון את רשימת הערים כרגע", result: { records: [] } });
  }
};

module.exports = { getCities };

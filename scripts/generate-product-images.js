// scripts/generate-product-images.js
//
// מייצר תמונת מוצר על רקע לבן לכל מוצר בקטלוג, ומצמיד אותה לשדה image.
//
// רקע: לאף אחד מ-4,320 המוצרים אין תמונה (image: []), ולכן כל כרטיסי החנות
// נשענים על אותו placeholder בודד. הסקריפט מייצר לכל מוצר תמונה ייחודית —
// רקע לבן, אייקון קווי שנבחר לפי מילות המפתח בשם המוצר, שם המוצר בעברית
// וצבע לפי הקטגוריה — כך שגריד המוצרים נקרא ומובחן גם בלי צילומי אמת.
//
// איך התמונה נבנית: SVG שנרנדר ב-sharp ל-WebP. הפונט (Assistant) מוטמע
// בתוך ה-SVG כ-data URI, כי librsvg שבתוך sharp לא נשען על הפונטים של המערכת
// ובלי ההטמעה העברית יוצאת בפונט נפילה שרירותי. גלישת השורות נמדדת מטבלאות
// ה-cmap/hmtx של קובץ ה-TTF עצמו — ולא בהערכה — כדי ששמות ארוכים לא יגלשו.
//
// היעד: sweet-store/public/product-images/<sku>.webp, וב-DB נשמר נתיב יחסי
// ("/product-images/<sku>.webp"). את הקידומת ‎/sweet-store מוסיף
// ‎@component/common/Img בזמן ריצה — ראה src/utils/basePath.js — ולכן אסור
// לצרוב אותה כאן.
//
// הרצה:
//   node scripts/generate-product-images.js                 // כל המוצרים בלי תמונה
//   node scripts/generate-product-images.js --dry           // בלי כתיבה לדיסק/DB
//   node scripts/generate-product-images.js --force         // גם למוצרים שכבר יש להם
//   node scripts/generate-product-images.js --limit 20      // דגימה לבדיקה ויזואלית
//   node scripts/generate-product-images.js --category מזון
//   node scripts/generate-product-images.js --sku 4423,1177
//   node scripts/generate-product-images.js --all           // כולל מוצרים מוסתרים
//   node scripts/generate-product-images.js --no-db         // רק קבצים, בלי עדכון DB
//   node scripts/generate-product-images.js --with-text     // גם שם המוצר ומק"ט בתוך התמונה
//   node scripts/generate-product-images.js --size 1000 --concurrency 4
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const sharp = require("sharp");

// ---------------------------------------------------------------------------
// ארגומנטים
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(`--${name}`);
const getArg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
};

const OPTS = {
  dry: hasFlag("dry"),
  force: hasFlag("force"),
  all: hasFlag("all"),
  noDb: hasFlag("no-db"),
  withText: hasFlag("with-text"),
  limit: Number(getArg("limit", 0)) || 0,
  size: Number(getArg("size", 800)) || 800,
  concurrency: Math.max(1, Number(getArg("concurrency", 6)) || 6),
  category: getArg("category"),
  skus: (getArg("sku") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  outDir: getArg(
    "out",
    path.join(__dirname, "..", "..", "sweet-store", "public", "product-images")
  ),
};

// הנתיב שנשמר ב-DB חייב להישאר יחסי לשורש ה-public של החנות.
const PUBLIC_PREFIX = "/product-images";

const FONTS_DIR = path.join(
  __dirname,
  "..",
  "..",
  "sweet-store",
  "public",
  "fonts",
  "assistant"
);

// ---------------------------------------------------------------------------
// מדידת טקסט מתוך קובץ ה-TTF
//
// למה לא הערכה גסה: רוחב האות בעברית משתנה מאוד (ו' מול ם'), ובשמות של
// הקטלוג הזה יש מ-3 תווים ועד 60. הערכה לפי "חצי גודל גופן" הייתה גורמת
// לשמות ארוכים לגלוש מחוץ למסגרת ולשמות קצרים להתכווץ ללא צורך.
// כאן נקראות שתי טבלאות בלבד: cmap (תו → glyph) ו-hmtx (glyph → רוחב).
// ---------------------------------------------------------------------------
function loadFontMetrics(file) {
  const buf = fs.readFileSync(file);

  const tables = {};
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    tables[buf.toString("ascii", o, o + 4)] = {
      off: buf.readUInt32BE(o + 8),
      len: buf.readUInt32BE(o + 12),
    };
  }

  const unitsPerEm = buf.readUInt16BE(tables.head.off + 18);
  const numHMetrics = buf.readUInt16BE(tables.hhea.off + 34);
  const hmtx = tables.hmtx.off;

  // תת-טבלת cmap בפורמט 4 (Unicode BMP) — מכסה את כל העברית והלטינית.
  const cmapOff = tables.cmap.off;
  const numSub = buf.readUInt16BE(cmapOff + 2);
  let sub = null;
  for (let i = 0; i < numSub; i++) {
    const o = cmapOff + 4 + i * 8;
    const platform = buf.readUInt16BE(o);
    const encoding = buf.readUInt16BE(o + 2);
    const off = cmapOff + buf.readUInt32BE(o + 4);
    if (buf.readUInt16BE(off) !== 4) continue;
    if (platform === 3 && encoding === 1) {
      sub = off;
      break;
    }
    if (platform === 0 && sub === null) sub = off;
  }
  if (sub === null) throw new Error(`cmap format 4 לא נמצא ב-${file}`);

  const segCountX2 = buf.readUInt16BE(sub + 6);
  const endsAt = sub + 14;
  const startsAt = endsAt + segCountX2 + 2;
  const deltasAt = startsAt + segCountX2;
  const rangesAt = deltasAt + segCountX2;

  const glyphOf = (code) => {
    for (let s = 0; s < segCountX2; s += 2) {
      if (buf.readUInt16BE(endsAt + s) < code) continue;
      const start = buf.readUInt16BE(startsAt + s);
      if (start > code) return 0;
      const rangeOffset = buf.readUInt16BE(rangesAt + s);
      if (rangeOffset === 0) {
        return (code + buf.readInt16BE(deltasAt + s)) & 0xffff;
      }
      const gi = rangesAt + s + rangeOffset + (code - start) * 2;
      if (gi + 1 >= buf.length) return 0;
      const g = buf.readUInt16BE(gi);
      return g === 0 ? 0 : (g + buf.readInt16BE(deltasAt + s)) & 0xffff;
    }
    return 0;
  };

  const cache = new Map();
  // רוחב תו ביחידות em (כלומר: כפול גודל הגופן = פיקסלים).
  const charWidth = (ch) => {
    if (cache.has(ch)) return cache.get(ch);
    const gid = glyphOf(ch.codePointAt(0));
    const i = Math.min(gid, numHMetrics - 1);
    const w = buf.readUInt16BE(hmtx + i * 4) / unitsPerEm;
    cache.set(ch, w);
    return w;
  };

  return {
    base64: buf.toString("base64"),
    // ניקוד ותווי כיווניות אינם תופסים רוחב ואינם קיימים בגופן — מדלגים.
    measure: (text, fontSize) => {
      let w = 0;
      for (const ch of text) {
        if (/[֑-ׇ‎‏]/.test(ch)) continue;
        w += charWidth(ch);
      }
      return w * fontSize;
    },
  };
}

const FONT_BOLD = loadFontMetrics(path.join(FONTS_DIR, "Assistant-Bold.ttf"));
const FONT_REG = loadFontMetrics(path.join(FONTS_DIR, "Assistant-Regular.ttf"));

// ---------------------------------------------------------------------------
// צבעים לפי קטגוריה
//
// גוונים נפרדים ולא ירוק המותג לכל הקטלוג: בגריד של עשרות כרטיסים הצבע הוא
// הרמז המהיר לקטגוריה, ואחידות גמורה הייתה מבטלת אותו.
// ---------------------------------------------------------------------------
const CATEGORY_THEMES = {
  "מזון": { ink: "#d97706", tint: "#fef6e7" },
  "פירות": { ink: "#16a34a", tint: "#eefaf1" },
  'ח.ניקוי+ח"פ': { ink: "#2563eb", tint: "#eef3fe" },
  "כללית": { ink: "#7c3aed", tint: "#f4efff" },
  "משרד": { ink: "#475569", tint: "#f1f4f8" },
};
const DEFAULT_THEME = { ink: "#0d9e6d", tint: "#f2fbf7" }; // ירוק המותג

// ---------------------------------------------------------------------------
// אייקונים
//
// כל אייקון מצויר ב-viewBox של 100x100 ומשורטט בצבע הקטגוריה. הבחירה נעשית
// לפי מילות מפתח בשם המוצר, בסדר — הכלל הראשון שמתאים מנצח, ולכן הכללים
// הספציפיים ("שוקולד") מופיעים לפני הכלליים ("קופסה").
// ---------------------------------------------------------------------------
const ICONS = {
  chocolate: `
    <rect x="26" y="22" width="48" height="60" rx="6"/>
    <path d="M26 42h48M26 62h48M50 22v60"/>`,
  candy: `
    <circle cx="50" cy="50" r="18"/>
    <path d="M32 50 16 38v24zM68 50l16-12v24z"/>`,
  cookie: `
    <circle cx="50" cy="50" r="28"/>
    <circle cx="42" cy="42" r="3.5" fill="currentColor" stroke="none"/>
    <circle cx="59" cy="47" r="3.5" fill="currentColor" stroke="none"/>
    <circle cx="46" cy="60" r="3.5" fill="currentColor" stroke="none"/>`,
  bread: `
    <path d="M22 54c0-14 12-22 28-22s28 8 28 22v14a4 4 0 0 1-4 4H26a4 4 0 0 1-4-4z"/>
    <path d="M36 40v32M50 36v36M64 40v32"/>`,
  bottle: `
    <path d="M42 16h16v14l8 12v40a4 4 0 0 1-4 4H38a4 4 0 0 1-4-4V42l8-12z"/>
    <path d="M34 54h32"/>`,
  can: `
    <ellipse cx="50" cy="26" rx="22" ry="8"/>
    <path d="M28 26v48c0 4.4 9.8 8 22 8s22-3.6 22-8V26"/>
    <path d="M40 44h20"/>`,
  carton: `
    <path d="M32 34h36v48a4 4 0 0 1-4 4H36a4 4 0 0 1-4-4z"/>
    <path d="M32 34 42 16h16l10 18M50 16v18"/>`,
  jar: `
    <rect x="30" y="34" width="40" height="48" rx="6"/>
    <rect x="34" y="18" width="32" height="14" rx="4"/>
    <path d="M38 50h24"/>`,
  bag: `
    <path d="M30 34h40l6 46a4 4 0 0 1-4 4.6H28a4 4 0 0 1-4-4.6z"/>
    <path d="M38 34V26a12 12 0 0 1 24 0v8"/>`,
  sack: `
    <path d="M34 26h32l-4 10c8 6 12 16 12 26 0 12-10 20-24 20s-24-8-24-20c0-10 4-20 12-26z"/>
    <path d="M40 62c6 4 14 4 20 0"/>`,
  nuts: `
    <path d="M20 48h60c0 18-13 30-30 30S20 66 20 48z"/>
    <circle cx="38" cy="34" r="7"/>
    <circle cx="54" cy="30" r="7"/>
    <circle cx="66" cy="38" r="6"/>`,
  cup: `
    <path d="M26 32h40v26a20 20 0 0 1-40 0z"/>
    <path d="M66 38h8a9 9 0 0 1 0 18h-8M22 82h48"/>`,
  egg: `
    <path d="M50 18c12 0 20 18 20 32a20 20 0 0 1-40 0c0-14 8-32 20-32z"/>`,
  fruit: `
    <path d="M50 34c-4-6-14-8-20-2s-6 20 0 30 14 20 20 20 14-10 20-20 6-24 0-30-16-4-20 2z"/>
    <path d="M50 34V20M50 22c6-2 10-6 10-12"/>`,
  vegetable: `
    <path d="M28 78c22-4 38-20 44-44-24 4-40 20-44 44z"/>
    <path d="M28 78 20 86M62 26c2-8 8-12 16-12"/>`,
  spray: `
    <path d="M38 38h24v44a4 4 0 0 1-4 4H42a4 4 0 0 1-4-4z"/>
    <path d="M44 38V24h14M58 24h14M76 18v12"/>
    <path d="M44 54h12"/>`,
  paper: `
    <rect x="26" y="24" width="48" height="52" rx="8"/>
    <ellipse cx="50" cy="32" rx="16" ry="8"/>
    <path d="M50 40v36"/>`,
  disposable: `
    <path d="M28 30h28l-4 52a4 4 0 0 1-4 3.6h-12a4 4 0 0 1-4-3.6z"/>
    <path d="M68 30v22M76 30v22M72 52v34"/>`,
  pencil: `
    <path d="M64 18 82 36 40 78l-22 4 4-22z"/>
    <path d="m58 24 18 18M22 60l18 18"/>`,
  frozen: `
    <path d="M50 16v68M20 34l60 32M80 34 20 66"/>
    <path d="m50 26 8 8M50 26l-8 8M50 74l8-8M50 74l-8-8"/>`,
  broom: `
    <path d="M50 14v34"/>
    <path d="M30 48h40l6 12c-6 4-14 6-26 6s-20-2-26-6z"/>
    <path d="M28 66c4 8 8 14 8 20M50 66v20M72 66c-4 8-8 14-8 20"/>`,
  battery: `
    <rect x="18" y="32" width="56" height="36" rx="6"/>
    <path d="M78 44v12"/>
    <path d="m48 38-8 14h12l-8 12"/>`,
  box: `
    <path d="M50 18 82 34v32L50 82 18 66V34z"/>
    <path d="m18 34 32 16 32-16M50 50v32"/>`,
};

// הכלל הראשון שמתאים מנצח — סדר הרשימה הוא הסדר שנבדק.
const ICON_RULES = [
  [/שוקולד|קקאו|ריסיס|פררו|קינדר|נוגט/, "chocolate"],
  [/סוכרי|ממתק|טופי|גומי|מסטיק|לקריץ|מרשמלו|קרמל/, "candy"],
  [/גלידה|קפוא|שלגון|קרח|מקפיא/, "frozen"],
  [/עוגי|ביסקוויט|וופל|ופל|אובלט|קרקר|בייגל|מציות|פתי|תופין/, "cookie"],
  [/לחם|פיתה|חלה|לחמני|בצק|טורטיה|באגט|רוגלך|סופגני|קרואסון|מאפה|בורקס|שטרודל|עוג(?!י)/, "bread"],
  [/סירופ|שמן|חומץ|רוטב|ליטר|משקה|מיץ|קולה|סודה|מים |שתי|יין|וודקה|בירה|בקבוק|ויסקי|ליקר|ערק|טקילה|רום /, "bottle"],
  [/חלב|שמנת|יוגורט|גבינ|לבן |קוטג|חמאה|מעדן/, "carton"],
  [/ריב|דבש|ממרח|טחינה|קטשופ|מיונז|חרדל|ממרח|נוטלה|חלווה/, "jar"],
  [/שימור|פחית|טונה|תירס|זית|אפונ|רסק|מלפפון חמוץ/, "can"],
  [/קמח|סוכר|אורז|פסטה|עדש|שעועית|גריס|חומוס|קטנ|בורגול|קוסקוס|סולת|מלח|תבלין|קורנפלקס|קונפלקס|דגני|גרנול|קוואקר|שיבולת|ממתיק/, "bag"],
  [/אגוז|שקד|בוטן|פיסטוק|גרעינ|פיצוח|צימוק|תמר|קשיו|חטיף/, "nuts"],
  [/קפה|תה |נס |קקאו שתי|שוקו/, "cup"],
  [/ביצ/, "egg"],
  [/מגבונ/, "paper"],
  [/ניקוי|סבון|אקונומיק|מנקה|כביסה|מרכך|כלים|אקונ|חיטוי|אלכוהול|מטהר|ריח|ספריי|תרסיס/, "spray"],
  [/נייר|מגבות|טישו|ממחט|טואלט|מפיות|סופג|מגבונ/, "paper"],
  [/מטאטא|מגב|מטלי|מברשת|כפפות|ספוג|סמרטוט|דלי |יעה |למדיח|אשפתון|אשפענק|ניגוב/, "broom"],
  [/בטרי|סולל/, "battery"],
  [/כוסות|צלחות|מזלג|סכו|כפית|חד פעמי|אלומיניום|ניילון|שקי|מגש|קשית|קערי|קערו|קערה/, "disposable"],
  [/עט |עפרון|מחברת|דבק|סרט הדבק|משרד|תיוק|קלסר|מהדק|טונר|דיו|טוש|מחיק|לוח |חוצצ|סיכות|מעטפ|שדכן|מחק |סרגל|נעצ|קליפס|בריסטול|דפדפת|פנקס|כרטיסי|למינצי/, "pencil"],
  [/תפוח|בננ|עגבני|מלפפון|גזר|בצל|תפוא|לימון|אבטיח|ענב|תות|אפרסק|אגס|מלון|תפוז|קלמנטינ|אבוקדו|שזיפ|משמש|נקטרינ|שסק|רימון|תאנ|קיווי|פומל|חבוש|דובדבן|מנגו/, "fruit"],
  [/חסה|כרוב|פלפל|קישוא|חציל|ברוקולי|תרד|סלרי|פטרוזיל|שמיר|נענע|כוסבר|שום|ירק|גמבה|סלט|במיה|דלעת|דלורית|לפת|סלק|צנון|נבטים|כריש|ארטישוק|בטטה/, "vegetable"],
];

const pickIcon = (name, categoryName) => {
  for (const [re, icon] of ICON_RULES) if (re.test(name)) return icon;
  if (categoryName === "פירות") return "fruit";
  if (categoryName === 'ח.ניקוי+ח"פ') return "spray";
  if (categoryName === "משרד") return "pencil";
  return "box";
};

// ---------------------------------------------------------------------------
// בניית ה-SVG
// ---------------------------------------------------------------------------
const escapeXml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// שמות בקטלוג נושאים לעיתים סיומת תיאורית בסוגריים
// ("סירופ אחווה 1 ליטר [4 ליטר בבקבוק]"). היא יורדת לשורת המשנה כדי שהשם
// עצמו יישאר גדול וקריא.
//
// סוגריים קצרים הם קיצור יחידה מיבוא הנה"ח ("(ח')", "(ק"ג)") ולא תיאור —
// הם נזרקים לגמרי, אחרת כל תמונה שנייה נושאת שורת משנה של תו אחד.
const splitName = (raw) => {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  const m = text.match(/^(.*?)[\s]*[\[(]([^\])]+)[\])]\s*$/);
  if (!m || m[1].trim().length < 3) return { main: text, note: "" };
  const note = m[2].trim();
  return { main: m[1].trim(), note: note.replace(/['"]/g, "").length <= 3 ? "" : note };
};

// גלישה חמדנית לפי מילים, עם שבירת מילה בודדת שארוכה משורה שלמה.
const wrapText = (text, font, fontSize, maxWidth) => {
  const lines = [];
  let line = "";
  const push = () => {
    if (line) lines.push(line);
    line = "";
  };

  for (const word of text.split(" ")) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.measure(candidate, fontSize) <= maxWidth) {
      line = candidate;
      continue;
    }
    push();
    if (font.measure(word, fontSize) <= maxWidth) {
      line = word;
      continue;
    }
    // מילה בודדת ארוכה מדי (מק"טים/קודים) — נשברת תו-תו.
    let chunk = "";
    for (const ch of word) {
      if (font.measure(chunk + ch, fontSize) > maxWidth) {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    line = chunk;
  }
  push();
  return lines;
};

// מוצא את גודל הגופן הגדול ביותר שבו השם נכנס במספר השורות המותר.
const fitText = (text, font, maxWidth, maxLines, sizes) => {
  for (const size of sizes) {
    const lines = wrapText(text, font, size, maxWidth);
    if (lines.length <= maxLines) return { size, lines };
  }
  const size = sizes[sizes.length - 1];
  const lines = wrapText(text, font, size, maxWidth);
  const kept = lines.slice(0, maxLines);
  kept[kept.length - 1] = `${kept[kept.length - 1].replace(/\s+\S*$/, "")}…`;
  return { size, lines: kept };
};

// פריסת ברירת המחדל: אייקון גדול בלבד.
//
// למה בלי טקסט: בכרטיס המוצר אזור התמונה נמוך (h-24/h-32) והתמונה מוצגת
// ב-object-contain, כלומר הריבוע כולו מכווץ לגובה הזה. הגרסה הראשונה דחסה
// לתוכו גם שם וגם שורת מק"ט — התוצאה הייתה אייקון זעיר וטקסט בלתי קריא,
// והשם ממילא מופיע מתחת לכרטיס וגם במודל. בלי הטקסט האייקון גדל פי שניים.
// ‎--with-text מחזיר את הפריסה המלאה למי שרוצה אותה.
function buildIconSvg({ theme, icon, size }) {
  const S = size;
  const iconSize = S * 0.5;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" fill="#ffffff"/>
  <circle cx="${S / 2}" cy="${S / 2}" r="${S * 0.36}" fill="${theme.tint}"/>
  <g transform="translate(${(S - iconSize) / 2} ${(S - iconSize) / 2}) scale(${iconSize / 100})"
     fill="none" stroke="${theme.ink}" color="${theme.ink}"
     stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round">
    ${ICONS[icon] || ICONS.box}
  </g>
</svg>`;
}

function buildSvg({ name, note, meta, theme, icon, size }) {
  const S = size;
  const u = S / 800; // כל המידות תוכננו על קנבס 800 ומתכווצות יחסית

  const margin = 64 * u;
  const maxTextWidth = S - margin * 2;

  const { size: nameSize, lines } = fitText(
    name,
    FONT_BOLD,
    maxTextWidth,
    3,
    [46, 42, 38, 34, 30, 26].map((n) => n * u)
  );
  const lineHeight = nameSize * 1.28;

  const noteSize = 24 * u;
  const metaSize = 22 * u;
  const plateSize = 340 * u;

  // הגובה נמדד מראש והגוש כולו ממורכז אנכית, כי מספר שורות השם משתנה בין
  // מוצר למוצר. עוגן קבוע היה מזיז את האייקון בין כרטיס לכרטיס בגריד.
  const gapAfterPlate = 62 * u;
  const gapBeforeNote = 34 * u;
  const gapBeforeMeta = 58 * u;

  const blockHeight =
    plateSize +
    gapAfterPlate +
    lines.length * lineHeight +
    (note ? gapBeforeNote + noteSize : 0) +
    gapBeforeMeta +
    metaSize * 1.3; // שוליים לזנב האותיות (ק', ן') של השורה האחרונה

  const plateY = Math.max(48 * u, (S - blockHeight) / 2);
  // baseline של השורה הראשונה — ולכן מוסיפים את גובה האות עצמה
  const textTop = plateY + plateSize + gapAfterPlate + nameSize * 0.78;
  const textBottom = textTop + (lines.length - 1) * lineHeight;
  const noteY = textBottom + gapBeforeNote;
  const metaY = (note ? noteY : textBottom) + gapBeforeMeta;

  const iconScale = (plateSize * 0.52) / 100;
  const iconX = S / 2 - (plateSize * 0.52) / 2;
  const iconY = plateY + plateSize / 2 - (plateSize * 0.52) / 2;

  const nameLines = lines
    .map(
      (l, i) =>
        `<text x="${S / 2}" y="${textTop + i * lineHeight}" class="name">${escapeXml(l)}</text>`
    )
    .join("\n    ");

  const noteLine = note
    ? `<text x="${S / 2}" y="${noteY}" class="note">${escapeXml(
        note.length > 46 ? `${note.slice(0, 45)}…` : note
      )}</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <style>
      @font-face { font-family: 'AssistantBold'; src: url(data:font/ttf;base64,${FONT_BOLD.base64}) format('truetype'); }
      @font-face { font-family: 'AssistantReg'; src: url(data:font/ttf;base64,${FONT_REG.base64}) format('truetype'); }
      .name { font-family: 'AssistantBold'; font-size: ${nameSize}px; fill: #1f2937; text-anchor: middle; direction: rtl; }
      .note { font-family: 'AssistantReg'; font-size: ${noteSize}px; fill: #6b7280; text-anchor: middle; direction: rtl; }
      .meta { font-family: 'AssistantReg'; font-size: ${metaSize}px; fill: #9ca3af; text-anchor: middle; direction: rtl; letter-spacing: ${0.5 * u}px; }
    </style>
  </defs>

  <rect width="${S}" height="${S}" fill="#ffffff"/>

  <rect x="${S / 2 - plateSize / 2}" y="${plateY}" width="${plateSize}" height="${plateSize}" rx="${56 * u}" fill="${theme.tint}"/>

  <g transform="translate(${iconX} ${iconY}) scale(${iconScale})"
     fill="none" stroke="${theme.ink}" color="${theme.ink}"
     stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    ${ICONS[icon] || ICONS.box}
  </g>

  <g>
    ${nameLines}
  </g>
  ${noteLine}

  <rect x="${S / 2 - 26 * u}" y="${metaY - 30 * u}" width="${52 * u}" height="${3 * u}" rx="${1.5 * u}" fill="${theme.ink}" opacity="0.35"/>
  <text x="${S / 2}" y="${metaY}" class="meta">${escapeXml(meta)}</text>
</svg>`;
}

// ---------------------------------------------------------------------------
// הרצה
// ---------------------------------------------------------------------------
// שם קובץ בטוח: המק"ט הוא המפתח היציב (unique בסכימה), ו-_id משמש נפילה
// למוצרים נדירים בלי מק"ט.
const fileNameFor = (product) => {
  const raw = String(product.sku || product._id);
  return `${raw.replace(/[^\w.-]+/g, "-")}.webp`;
};

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const Products = db.collection("products");
  const Categories = db.collection("categories");

  const categoryNames = new Map();
  for (const c of await Categories.find({}).project({ name: 1 }).toArray()) {
    categoryNames.set(String(c._id), c?.name?.he || "");
  }

  const query = {};
  if (!OPTS.all) query.status = "show";
  if (!OPTS.force) query.$or = [{ image: { $exists: false } }, { image: { $size: 0 } }];
  if (OPTS.skus.length) query.sku = { $in: OPTS.skus };
  if (OPTS.category) {
    const cat = await Categories.findOne({ "name.he": OPTS.category });
    if (!cat) {
      console.error(`קטגוריה לא נמצאה: ${OPTS.category}`);
      process.exit(1);
    }
    query.category = cat._id;
  }

  let cursor = Products.find(query).project({
    title: 1,
    sku: 1,
    category: 1,
    image: 1,
    "erp.unit": 1,
  });
  if (OPTS.limit) cursor = cursor.limit(OPTS.limit);
  const products = await cursor.toArray();

  console.log(
    `${OPTS.dry ? "[dry] " : ""}נמצאו ${products.length} מוצרים · יעד: ${OPTS.outDir} · ${OPTS.size}px`
  );
  if (!products.length) return;

  if (!OPTS.dry) fs.mkdirSync(OPTS.outDir, { recursive: true });

  const stats = { ok: 0, skipped: 0, failed: 0 };
  const iconTally = new Map();
  let done = 0;

  const renderOne = async (product) => {
    const name = product?.title?.he || product?.title?.en || "";
    if (!name.trim()) {
      stats.skipped++;
      return;
    }

    const categoryName = categoryNames.get(String(product.category)) || "";
    const theme = CATEGORY_THEMES[categoryName] || DEFAULT_THEME;
    const { main, note } = splitName(name);
    const icon = pickIcon(name, categoryName);
    iconTally.set(icon, (iconTally.get(icon) || 0) + 1);

    const metaParts = [categoryName, product?.erp?.unit, product.sku && `מק"ט ${product.sku}`];
    const svg = OPTS.withText
      ? buildSvg({
          name: main,
          note,
          meta: metaParts.filter(Boolean).join(" · "),
          theme,
          icon,
          size: OPTS.size,
        })
      : buildIconSvg({ theme, icon, size: OPTS.size });

    const file = fileNameFor(product);
    const relPath = `${PUBLIC_PREFIX}/${file}`;

    if (!OPTS.dry) {
      // density גבוה מספיק כדי שהטקסט ירונדר חלק לפני הדגימה למידה הסופית.
      await sharp(Buffer.from(svg), { density: 144 })
        .resize(OPTS.size, OPTS.size, { fit: "contain", background: "#ffffff" })
        .webp({ quality: 90 })
        .toFile(path.join(OPTS.outDir, file));

      if (!OPTS.noDb) {
        await Products.updateOne(
          { _id: product._id },
          { $set: { image: [relPath], updatedAt: new Date() } }
        );
      }
    }

    stats.ok++;
    done++;
    if (done % 100 === 0 || done === products.length) {
      console.log(`  ${done}/${products.length}`);
    }
  };

  // בריכת עבודה: sharp משחרר את ה-event loop בזמן הרינדור, ולכן כמה תמונות
  // במקביל מקצרות משמעותית ריצה על כל הקטלוג.
  const queue = products.slice();
  await Promise.all(
    Array.from({ length: Math.min(OPTS.concurrency, queue.length) }, async () => {
      while (queue.length) {
        const product = queue.shift();
        try {
          await renderOne(product);
        } catch (err) {
          stats.failed++;
          console.error(`  ! ${product.sku || product._id}: ${err.message}`);
        }
      }
    })
  );

  console.log(
    `\nסיום: ${stats.ok} נוצרו · ${stats.skipped} דולגו (בלי שם) · ${stats.failed} נכשלו`
  );
  console.log(
    "פילוח אייקונים: " +
      [...iconTally.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
  );
  if (OPTS.dry) console.log("(הרצה יבשה — לא נכתבו קבצים ולא עודכן DB)");
  else if (OPTS.noDb) console.log("(--no-db — נכתבו קבצים בלבד)");
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

// script/set-prices.js
//
// קביעת מחירים לכל הקטלוג לפי שם המוצר.
//
// למה זה קיים: הקטלוג יובא מהאקסל של ההנהח"ש בלי עמודת מחיר, ולכן 4,318 מתוך
// 4,320 המוצרים יושבים על מחיר 0 — כלומר לא ניתנים למכירה בפועל (הזמנה עם
// מוצר במחיר 0 מסתכמת ב-0 ש"ח). גם erp.cost ריק כמעט לגמרי, אז אי אפשר לגזור
// מחיר מהעלות בתוספת רווח.
//
// לכן המחיר נגזר משם המוצר: טבלת חוקים מזהה סוג מוצר לפי מילות מפתח, ומכפילה
// במידה/כמות שמופיעה בשם ("2 ק"ג", "1.5 ליטר", "50 יחידות"). התוצאה מעוגלת
// למחיר קמעונאי נקי (X.90).
//
// ⚠️  אלה מחירי ברירת מחדל סבירים, לא מחירי אמת. הם נועדו לפתוח את החנות
//     לתפעול ובדיקות. המקור האמיתי למחירים הוא יבוא האקסל עם עמודת מחיר
//     (ראה priceSource ב-productController) או עריכה במסך המוצרים.
//
// שימוש:
//   npm run prices:set -- --dry                # תצוגה מקדימה, בלי לכתוב
//   npm run prices:set                         # רק מוצרים בלי מחיר
//   npm run prices:set -- --all                # דורך גם על מוצרים שיש להם מחיר
//   npm run prices:set -- --dry --show 60      # מציג 60 דוגמאות
//   npm run prices:set -- --include-non-merch  # מתמחר גם רשומות הנהח"ש
//
// originalPrice נקבע שווה ל-price ו-discount=0 בכוונה: בחנות
// (component/common/Price.js) כל מצב שבו originalPrice > price מצייר מחיר
// מחוק ואחוזי הנחה, ואנחנו לא רוצים להמציא מבצע.

require("dotenv").config();
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const Product = require("../models/Product");

const argv = process.argv.slice(2);
const getArg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const isDry = hasFlag("dry");
const overwriteAll = hasFlag("all");
const includeNonMerch = hasFlag("include-non-merch");
const showCount = Number(getArg("show")) || 30;

const line = () => console.log("─".repeat(78));

// ── עיגול למחיר קמעונאי ────────────────────────────────────────────────
// עד 20 ש"ח: לשקל הקרוב פחות אגורה (7.90). עד 100: לחמישייה (34.90).
// מעל 100: לעשרת (119.90). כך כל הקטלוג נראה כמו מחירון ולא כמו פלט מחשבון.
const MIN_PRICE = 3.9;

const nice = (p) => {
  let v = Math.max(1, p);
  if (v < 20) v = Math.max(2, Math.round(v));
  else if (v < 100) v = Math.round(v / 5) * 5;
  else v = Math.round(v / 10) * 10;
  return Math.max(MIN_PRICE, Math.min(999.9, Number((v - 0.1).toFixed(2))));
};

// ── חילוץ מידה/כמות מהשם ──────────────────────────────────────────────
// "1/2 ליטר" נפוץ בקטלוג, ולכן שברים מטופלים לפני הכל.
const parseSize = (raw) => {
  const t = " " + String(raw || "").replace(/["'׳״]/g, "").replace(/\s+/g, " ") + " ";
  const num = (m) => {
    if (!m) return null;
    if (m[1] && m[2]) return Number(m[1]) / Number(m[2]); // 1/2
    return Number(m[1]);
  };
  const grab = (unitPattern) =>
    num(
      t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*/\\s*(\\d+)\\s*(?:${unitPattern})`)) ||
        t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:${unitPattern})`))
    );

  const kg = grab("קג|קילו|קג|ק ג");
  const liter = grab("ליטר");
  const gram = grab("גרם|גר(?![א-ת])");
  const ml = grab("מל(?![א-ת])");
  const units = grab("יחידות|יחידה|יח(?![א-ת])|דפים|דף(?![א-ת])|גלילים|גליל|שקיות|מנות|כפיות|סוגים|טעמים");

  // שישייה/שלישייה נספרות כיחידות
  let pack = null;
  if (/שישי[יה]ה|שישיות/.test(t)) pack = 6;
  else if (/רבעייה|רביעייה/.test(t)) pack = 4;
  else if (/שלישי[יה]ה/.test(t)) pack = 3;
  else if (/זוג/.test(t)) pack = 2;

  return {
    kg: kg || (gram ? gram / 1000 : null),
    liter: liter || (ml ? ml / 1000 : null),
    units: units || pack,
    pack,
  };
};

// ── רשומות שאינן מוצרים ────────────────────────────────────────────────
// הקטלוג יובא מקובץ הנהח"ש, ולכן נגררו לתוכו שורות תנועה: שכירות, החזרות,
// ריכוזי תעודות משלוח. תמחור שלהן היה מציג חשבונית שכירות כפריט בחנות.
const NON_MERCH = /שכירות|החזרת מוצר|ריכוז תעודות|תעודות משלוח|כללי ללא מעמ|ללא מעמ$|עמלה|ריבית|הפרשי|זיכוי|חשבונית|הובלה בלבד/;

// ── טבלת החוקים ────────────────────────────────────────────────────────
// כל חוק: base = מחיר בסיס בש"ח, ו-perKg/perLiter/perUnits = המידה שאליה
// המחיר מתייחס. אם השם מכיל מידה אחרת, המחיר מוכפל ביחס — עם מעריך ריכוך
// (KG_EXP/UNIT_EXP) כדי שאריזות סיטונאיות לא יתפוצצו לינארית.
//
// cap = תקרה לחוק. ברירת המחדל היא base*CAP_FACTOR, וזה החסם החשוב: בשמות
// מהקטלוג מופיעים מספרים גדולים ("1183 שישיות", "1760 דפים") ובלי תקרה
// ההכפלה מייצרת מחירי אבסורד. חוקים של אריזות סיטונאיות מקבלים cap מפורש.
//
// הסדר קובע: החוק הראשון שמתאים מנצח, ולכן ספציפי לפני כללי. שימו לב לסדר
// בין ממתקים למחלבה — "סופגניות ריבת חלב" חייב להיתפס כסופגנייה, לא כחלב.
const KG_EXP = 0.92;
const UNIT_EXP = 0.75;
const CAP_FACTOR = 6;

const RULES = [
  // סלט מוכן הוא מוצר מדף, לא ירק לפי משקל — חייב להיבדק לפני חוקי הירקות
  { k: "סלטים", re: /^סלט |סלט /, base: 13.9 },

  // ── פירות וירקות (מחיר לק"ג) ──
  { k: "עשבי תיבול", re: /בזיליקום|פטרוזיליה|כוסברה|נענע|שמיר|ראשד|רוקט|מרווה|תימין|לואיזה/, base: 4.9 },
  { k: "תותים", re: /תות(?:ים)?(?!\s*שדה\s*ריבה)/, base: 16.9, perKg: 1 },
  { k: "דובדבנים", re: /דובדבנ/, base: 29.9, perKg: 1 },
  { k: "ענבים", re: /ענבים/, base: 14.9, perKg: 1 },
  { k: "אבוקדו", re: /אבוקדו/, base: 13.9, perKg: 1 },
  { k: "פטריות", re: /פיטריות|פטריות/, base: 12.9, perKg: 1 },
  { k: "אבטיח/מלון", re: /אבטיח|מלון/, base: 5.9, perKg: 1 },
  { k: "פירות קיץ", re: /נקטרינה|משמש|שזיף|אפרסק|שסק|תאנים|אפרסמון|רימונ/, base: 13.9, perKg: 1 },
  { k: "הדרים", re: /תפוז|קלמנטינ|אשכולית|פומלה|לימונים|מנדרינ/, base: 7.9, perKg: 1 },
  { k: "תפוחים/אגס", re: /תפוחים|תפוח עץ|אגס/, base: 9.9, perKg: 1 },
  { k: "בננות", re: /בננ/, base: 8.9, perKg: 1 },
  // פלפל(?! שחור) — פלפל שחור הוא תבלין ומטופל בחוק התבלינים
  { k: "פלפל/גמבה", re: /פלפל(?! שחור)|גמבה|שושקה/, base: 12.9, perKg: 1 },
  { k: "עגבניות", re: /עגבני/, base: 8.9, perKg: 1 },
  { k: "מלפפונים", re: /מלפפונים|מלפפון(?!\s*מלח)/, base: 6.9, perKg: 1 },
  { k: "ירקות שורש", re: /בצל|גזר|סלק|תפוח אדמה|תפו[״"']א|בטטה|שום|לפת|קולורבי|צנון/, base: 6.9, perKg: 1 },
  { k: "עלים/כרוב", re: /כרוב|חסה|כרובית|ברוקולי|קייל|תרד|סלרי|כוסמת עלים|שעועית ירוקה|לוביה|קישוא|חציל|במיה|ארטישוק/, base: 8.9, perKg: 1 },
  { k: "פירות/ירקות כללי", re: /^פירות|^ירקות|פירות \d|ירקות \d/, base: 9.9, perKg: 1 },

  // ── שתייה ──
  { k: "אלכוהול חריף", re: /ויסקי|וודקה|ערק|ליקר|טקילה|ג'ין|סמירנוף|יגר|ברנדי|קוניאק|אבסולוט|בקרדי/, base: 74.9 },
  { k: "יין", re: /יין|ייין|קברנה|מרלו|שרדונה/, base: 39.9 },
  { k: "בירה", re: /בירה|בירת/, base: 8.9, perUnits: 1, cap: 69.9 },
  { k: "סירופ", re: /סירופ/, base: 13.9, perLiter: 1, cap: 49.9 },
  { k: "משקה קל", re: /קולה|פפסי|ספרייט|פאנטה|סודה|שוופס|משקאות קלים|משקה קל|טמפו|XL|קינלי/, base: 7.9, perLiter: 1.5 },
  { k: "מים", re: /^מיים|^מים|מים מינרל|מיים בטעמים/, base: 5.9, perLiter: 1.5 },
  { k: "מיץ", re: /מיץ|נקטר|בריזר|משקה בטעמים|משקה פירות/, base: 10.9, perLiter: 1, cap: 39.9 },
  { k: "קפה נמס", re: /נס קפה|קפה נמס|נס(?=\s)/, base: 26.9 },
  { k: "קפה", re: /קפה|אספרסו|קפסולות/, base: 21.9 },
  { k: "תה", re: /תה |^תה|ויסוצקי|חליטה|ניחוחות/, base: 15.9 },

  // ── ממתקים וחטיפים ──
  { k: "שוקולד מארז", re: /שוקולד.*(?:מארז|קילו|קג)|פרלינ|בונבונ/, base: 29.9 },
  { k: "שוקולד", re: /שוקולד|חטיף שוקולד|ריסיס|ריזס|קינדר|טורטית/, base: 7.9 },
  { k: "סוכריות", re: /סוכריות|סוכריה|ג'לי|גומי|טופי|מנטוס|מסטיק|לקק/, base: 5.9 },
  { k: "מרשמלו", re: /מרשמלו|פצפצים|נישנושים|פופקורן/, base: 9.9 },
  { k: "ופל/עוגיות", re: /ופל|גליליות|עוגיות|ביסקוויט|פתיבר|קרקר|לחמית|בייגל/, base: 11.9 },
  { k: "עוגה", re: /עוגת|עוגה|רוגלך|שמרים|פאי|טארט|צ'יזקייק/, base: 32.9 },
  { k: "סופגניות", re: /סופגני/, base: 6.9 },
  { k: "חטיף", re: /חטיף|במבה|ביסלי|צ'יפס|תפוצ'יפס|דוריטוס|אפרופו|קמפרי|שוקו בד/, base: 6.9 },
  { k: "פיצוחים/מיובש", re: /שקדים|אגוז|בוטנים|פיסטוק|צימוק|מיובש|גרעינים|שומשום|פיצוחים|תמרים/, base: 24.9, perKg: 1, cap: 89.9 },

  // ── מחלבה (אחרי הממתקים בכוונה: "סופגניות ריבת חלב" הוא סופגנייה) ──
  { k: "גבינה צהובה", re: /גבינה צהובה|גבינת עמק|קשקבל|מוצרלה|פרמזן/, base: 44.9, perKg: 1, cap: 149.9 },
  { k: "גבינה", re: /גבינה|גבינת|ריקוטה|קוטג|לבנה|שמנת|מסקרפונה|פטה|בולגרית/, base: 9.9 },
  { k: "יוגורט/מעדן", re: /יוגורט|מעדן|דנונה|מולר|אשל|פודינג/, base: 6.9 },
  { k: "חמאה/מרגרינה", re: /חמאה(?! בוטנ)|מרגרינה|תנובה חמאה/, base: 9.9 },
  { k: "ביצים", re: /ביצים|ביצה/, base: 14.9 },
  // שוקו(?!לד) — בלי זה "שוקולד" נתפס כחלב
  { k: "חלב", re: /(?:^|\s)חלב(?:\s|$)|חלב \d|שוקו(?!לד)/, base: 7.9, perLiter: 1, cap: 24.9 },

  // ── מזווה ──
  { k: "חמאת בוטנים", re: /חמאת בוטנ|ממרח שוקולד|נוטלה/, base: 34.9, perKg: 1, cap: 99.9 },
  // לפני "סוכר": "קונפיטורה ללא סוכר" היא ריבה, לא שקית סוכר
  { k: "ממרח/דבש/ריבה", re: /ממרח|דבש|ריבה|קונפיטורה|חלבה|טחינה|סילאן/, base: 18.9 },
  { k: "שמן", re: /שמן זית|שמן קנולה|שמן חמניות|^שמן/, base: 16.9, perLiter: 1, cap: 69.9 },
  { k: "רטבים", re: /קטשופ|מיונז|חרדל|רוטב|חומוס|מטבל|ויניגרט|סלסה|סויה|צ'ילי/, base: 12.9 },
  { k: "תבלינים", re: /תבלין|פפריקה|כמון|כורכום|מלח(?! חומץ)|פלפל שחור|אבקת מרק/, base: 9.9 },
  { k: "קורנפלקס", re: /קורנפלקס|דגני בוקר|גרנולה|שיבולת שועל|קוואקר/, base: 18.9 },
  { k: "אורז/קטניות/פסטה", re: /אורז|עדשים|חומוס יבש|שעועית יבשה|בורגול|קוסקוס|פסטה|ספגטי|נודלס|קינואה/, base: 13.9, perKg: 1, cap: 59.9 },
  { k: "סוכר/קמח", re: /סוכר|קמח|קורנפלור|אבקת אפייה|שמרים/, base: 7.9, perKg: 1, cap: 39.9 },
  { k: "שימורים", re: /שימור|תירס|אפונה|טונה|זיתים|חמוצים|כבוש|מלפפון מלח/, base: 9.9 },
  { k: "קפוא/גלידה", re: /גלידה|קפוא|שלגון|ארטיק/, base: 16.9 },
  { k: "לחם/פיתה", re: /לחם|פיתה|לחמניות|חלה|באגט|טורטיה|אובלטים/, base: 8.9 },

  // ── חד פעמי ונייר (אריזות סיטונאיות — cap מפורש וגבוה) ──
  { k: "נייר טואלט", re: /נייר טואלט|טואלט|גמבו|גאמבו/, base: 24.9, perUnits: 6, cap: 129.9 },
  { k: "מגבת נייר", re: /צץ רץ|מגבת נייר|נייר מגבת|אייר פלקס/, base: 24.9, perUnits: 100, cap: 99.9 },
  { k: "טישו/מפיות", re: /טישו|מפיות|מפית|ממחטות|סופרה/, base: 11.9, perUnits: 6, cap: 79.9 },
  { k: "מפות", re: /מפות|מפת שולחן/, base: 11.9 },
  { k: "כוסות", re: /כוסות|כוס |גביע/, base: 11.9, perUnits: 50, cap: 89.9 },
  { k: "צלחות/קעריות", re: /צלחות|צלחת|קעריות|קערית|לפתניות|מגשים|תחתיות/, base: 13.9, perUnits: 25, cap: 89.9 },
  { k: "סכום חד פעמי", re: /מזלגות|כפות|כפיות|סכינים|סכום|שיפודי|קיסמי|מקלות/, base: 9.9, perUnits: 50, cap: 69.9 },
  { k: "אלומיניום/ניילון", re: /אלומיניום|ניילון נצמד|נייר אפייה|שמרדף|תבניות/, base: 13.9 },
  { k: "שקיות/אשפה", re: /שקיות|אשפתון|שקי אשפה|שק |גופיה/, base: 14.9 },
  { k: "קופסאות אחסון", re: /קופסאות|קופסא|מכסה|אריזה|כלי אחסון/, base: 12.9 },

  // ── ניקיון ──
  { k: "אקונומיקה", re: /אקונומיקה|ז'אבל|כלור/, base: 15.9, perLiter: 4, cap: 49.9 },
  { k: "נוזל כלים", re: /נוזל כלים|נוזל לכלים|פרי (?:כלים)?/, base: 13.9, perLiter: 1.35, cap: 49.9 },
  { k: "למדיח", re: /למדיח|טבליות|מדיח/, base: 32.9 },
  { k: "אבקת כיבוס", re: /אבקת כיבוס|כיבוס|מרכך|כובסת|נוזל כיבוס/, base: 32.9 },
  { k: "סבון נוזלי", re: /סבון נוזלי|סבון ידים|סבון ידיים/, base: 12.9, perLiter: 1, cap: 49.9 },
  { k: "מגבונים", re: /מגבונים|מגבוני/, base: 11.9 },
  { k: "מתקן/דיספנסר", re: /מתקן|דיספנסר|מחזיק/, base: 39.9 },
  { k: "ספריי/מטהר", re: /ספריי|מטהר אויר|מטהר אוויר|ריחן/, base: 15.9 },
  { k: "נוזל ניקוי", re: /נוזל לניקוי|נוזל ניקוי|מסיר|מנקה|לניקוי/, base: 15.9, perLiter: 4, cap: 59.9 },
  { k: "מטליות", re: /מטליות|מטלית|ספוגים|ספוג|נצנצים|כרית יפנית|צמר פלדה/, base: 11.9 },
  // מגב(?![וי]) — בלי זה "מגבונים" נתפס ככלי ניקיון
  { k: "כלי ניקיון", re: /מגב(?![וי])|יעה|מטאטא|מברשת(?! שיניים)|דלי|סמרטוט|טרבד|פח /, base: 21.9 },

  // ── טיפוח ──
  { k: "שמפו/סבון גוף", re: /שמפו|מרכך שיער|סבון רחצה|ג'ל רחצה|קונדישנר/, base: 16.9 },
  { k: "דאודרנט", re: /דאודרנט|אנטי פרספירנט/, base: 16.9 },
  { k: "מברשת שיניים", re: /מברשת שיניים|משחת שיניים|חוט דנטלי/, base: 11.9 },
  { k: "מסכות", re: /מסכות|כפפות|כיסוי נעל/, base: 16.9, perUnits: 50 },

  // ── משרד ──
  { k: "נייר צילום", re: /נייר צילום|נייר A4|נייר A3|דפי הדפסה/, base: 21.9 },
  { k: "עט/טוש", re: /^עט|עט |טוש|מרקר|עפרון|עיפרון|חודים|פרמננט|מחק|מחדד/, base: 4.9, perUnits: 1, cap: 34.9 },
  { k: "מחברת/בלוק", re: /מחברת|בלוק|יומן|פנקס|דפי ממו|ממו|קלסר|תיקיה|תיק תלייה|חוצצים|ספירלה|מגילה/, base: 12.9 },
  { k: "שדכן/מהדק", re: /שדכן|מהדק|סיכות|מחורר|מספרים|מספריים|סכין יפני/, base: 14.9 },
  { k: "דבק", re: /דבק|סלוטייפ|נייר דבק/, base: 9.9 },
  { k: "חותמת", re: /חותמת|כרטיסי ביקור/, base: 44.9 },
  { k: "בטריות", re: /בטריות|סוללות|בטריה/, base: 14.9, perUnits: 4, cap: 49.9 },

  // ── כללי לפי מחלקה ──
  { k: "מזון (כללי)", group: "מזון", base: 13.9 },
  { k: "פירות (כללי)", group: "פירות", base: 9.9, perKg: 1 },
  { k: 'ניקיון/חד"פ (כללי)', group: 'ח.ניקוי+ח"פ', base: 15.9 },
  { k: "משרד (כללי)", group: "משרד", base: 12.9 },
  { k: "כללית", group: "כללית", base: 13.9 },
];

const FALLBACK = { k: "ברירת מחדל", base: 13.9 };

// מחשב מחיר למוצר בודד. מחזיר { price, rule, note }
const priceFor = (title, groupName) => {
  const t = String(title || "");
  const size = parseSize(t);

  const rule =
    RULES.find((r) => (r.re ? r.re.test(t) : false)) ||
    RULES.find((r) => r.group && r.group === groupName) ||
    FALLBACK;

  let price = rule.base;
  const notes = [];

  if (rule.perKg && size.kg) {
    const ratio = size.kg / rule.perKg;
    price *= Math.pow(ratio, KG_EXP);
    notes.push(`${size.kg} ק"ג`);
  } else if (rule.perLiter && size.liter) {
    const ratio = size.liter / rule.perLiter;
    price *= Math.pow(ratio, KG_EXP);
    notes.push(`${size.liter} ליטר`);
  } else if (rule.perUnits && size.units) {
    const ratio = size.units / rule.perUnits;
    price *= Math.pow(ratio, UNIT_EXP);
    notes.push(`${size.units} יח'`);
  }

  // תקרה: מגן מפני מספרים גדולים בשם המוצר שמנפחים את ההכפלה
  const cap = rule.cap || rule.base * CAP_FACTOR;
  if (price > cap) {
    price = cap;
    notes.push("תקרה");
  }

  return { price: nice(price), rule: rule.k, note: notes.join(", ") };
};

const run = async () => {
  await connectDB();
  if (mongoose.connection.readyState !== 1) {
    console.error("אין חיבור למסד הנתונים. בדוק MONGO_URI ב-.env.");
    process.exit(1);
  }

  const missingFilter = {
    $or: [
      { "prices.price": 0 },
      { "prices.price": null },
      { "prices.price": { $exists: false } },
    ],
  };
  const filter = overwriteAll ? {} : missingFilter;

  const total = await Product.countDocuments({});
  // erp מוגדר select:false במודל, ולכן צריך לבקש אותו במפורש עבור ה-fallback
  const products = await Product.find(filter).select("title prices erp").lean();

  line();
  console.log(`מסד: ${mongoose.connection.name}`);
  console.log(`סה"כ מוצרים בקטלוג:      ${total}`);
  console.log(
    `מוצרים במיקוד:            ${products.length}  ${
      overwriteAll ? "(--all: כולל מוצרים שכבר יש להם מחיר)" : "(רק ללא מחיר)"
    }`
  );
  line();

  const ops = [];
  const byRule = new Map();
  const samples = [];
  const priced = [];
  const skipped = [];

  for (const p of products) {
    const title = p.title?.he || p.title?.en || "";

    if (!includeNonMerch && NON_MERCH.test(title)) {
      skipped.push(title);
      continue;
    }

    const { price, rule, note } = priceFor(title, p.erp?.groupName);

    const stat = byRule.get(rule) || { n: 0, sum: 0, min: Infinity, max: 0 };
    stat.n += 1;
    stat.sum += price;
    stat.min = Math.min(stat.min, price);
    stat.max = Math.max(stat.max, price);
    byRule.set(rule, stat);

    priced.push({ title, price, rule });
    if (samples.length < showCount) samples.push({ title, price, rule, note });

    ops.push({
      updateOne: {
        filter: { _id: p._id },
        update: {
          $set: {
            "prices.price": price,
            "prices.originalPrice": price, // שווה ל-price כדי שלא יוצג "מבצע" מדומה
            "prices.storePrice": price,
            "prices.discount": 0,
          },
        },
      },
    });
  }

  // ── פירוט לפי חוק ──
  console.log("מחירים לפי סוג מוצר:\n");
  console.log("  " + "כמות".padEnd(7) + "טווח".padEnd(20) + "ממוצע".padEnd(10) + "סוג");
  [...byRule.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .forEach(([rule, s]) => {
      const range = s.min === s.max ? `${s.min}` : `${s.min} – ${s.max}`;
      console.log(
        "  " +
          String(s.n).padEnd(7) +
          range.padEnd(20) +
          (s.sum / s.n).toFixed(2).padEnd(10) +
          rule
      );
    });

  line();
  console.log(`דוגמאות (${samples.length}):\n`);
  samples.forEach((s) => {
    console.log(
      `  ${String(s.price).padStart(7)} ₪   ${s.title.slice(0, 46).padEnd(48)}${s.rule}${
        s.note ? ` [${s.note}]` : ""
      }`
    );
  });

  // ── הקצוות: שם שמכיל מספר גדול או מילת מפתח מטעה מתגלה כאן ──
  const sorted = [...priced].sort((a, b) => b.price - a.price);
  line();
  console.log("10 המחירים הגבוהים והנמוכים (לבדיקת שפיות):\n");
  sorted.slice(0, 10).forEach((s) =>
    console.log(`  ${String(s.price).padStart(7)} ₪   ${s.title.slice(0, 46).padEnd(48)}${s.rule}`)
  );
  console.log("  " + "·".repeat(70));
  sorted.slice(-10).forEach((s) =>
    console.log(`  ${String(s.price).padStart(7)} ₪   ${s.title.slice(0, 46).padEnd(48)}${s.rule}`)
  );

  if (skipped.length) {
    line();
    console.log(`⏭️  ${skipped.length} רשומות דולגו — אינן מוצרים אלא שורות הנהח"ש:\n`);
    skipped.slice(0, 15).forEach((t) => console.log(`   • ${t.slice(0, 70)}`));
    if (skipped.length > 15) console.log(`   ... ועוד ${skipped.length - 15}`);
    console.log("\n   הן נשארות במחיר 0 ולכן לא ניתנות למכירה. להתמחיר גם אותן: --include-non-merch");
  }

  line();

  if (isDry) {
    console.log(`[--dry] לא נכתב שום דבר. ${ops.length} מוצרים היו מתעדכנים.`);
    console.log("להרצה אמיתית: npm run prices:set");
    await mongoose.connection.close();
    process.exit(0);
  }

  let modified = 0;
  const CHUNK = 500;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const res = await Product.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
    modified += res.modifiedCount || 0;
    console.log(`  נכתבו ${Math.min(i + CHUNK, ops.length)} / ${ops.length}`);
  }

  line();
  console.log(`✅ עודכנו ${modified} מוצרים.`);

  const after = await Product.aggregate([
    {
      $group: {
        _id: null,
        min: { $min: "$prices.price" },
        max: { $max: "$prices.price" },
        avg: { $avg: "$prices.price" },
      },
    },
  ]);
  if (after[0]) {
    console.log(
      `מחירים בקטלוג: מינימום ${after[0].min}, מקסימום ${after[0].max}, ממוצע ${Number(
        after[0].avg
      ).toFixed(2)}`
    );
  }
  const stillZero = await Product.countDocuments(missingFilter);
  console.log(`מוצרים שנשארו ללא מחיר: ${stillZero}`);
  line();
  console.log("תזכורת: אלה מחירי ברירת מחדל שנגזרו משם המוצר, לא מחירי אמת.");
  console.log("להחלפה במחירים אמיתיים — יבוא אקסל עם עמודת מחיר, או מסך המוצרים.");
  line();

  await mongoose.connection.close();
  process.exit(0);
};

run().catch(async (err) => {
  console.error("כשל:", err.message);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});

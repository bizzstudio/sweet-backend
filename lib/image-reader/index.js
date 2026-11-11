// lib/image-reader/index.js
//
// קריאת הזמנה שנשלחה כתמונה (צילום של דף בכתב יד, או טופס מודפס שמולא ביד).
//
// ── מה זה עושה, ומה לא ──
//
// התמונה נשלחת ל-OpenAI (מודל עם ראייה) עם בקשה אחת: **להעתיק** את שורות
// ההזמנה כטקסט — כמות ושם כפי שכתובים. המודל לא מתאים מוצרים לקטלוג ולא
// מתקן איות; הטקסט שיוצא נכנס לאותו צינור שקורא הודעת ווצאפ רגילה, וההתאמה
// לקטלוג נעשית שם מול ה-DB. כך תמונה אינה מסלול עוקף לשום כלל קיים.
//
// ── כבוי כברירת מחדל ──
//
// כל תמונה היא קריאה בתשלום. הקריאה פעילה רק עם INGESTION_IMAGE_READING=true,
// ורק לשולח שעבר את הרשימה הלבנה (זה נבדק ב-readAttachment לפני שמגיעים לכאן).
// הערכת עלות (11/2026, gpt-4o): ~1,100 טוקני תמונה + ~600 טוקני פרומפט ותשובה
// ≈ 1–2 סנט לתמונה.
//
// ── למה ווצאפ בלבד ──
//
// במייל כמעט כל הודעה נושאת תמונות חתימה (לוגו, אייקוני פייסבוק), וכל אחת
// הייתה קריאה בתשלום על תמונה שאינה הזמנה. ההפעלה במייל, אם תידרש, צריכה
// סינון משלה — ולכן הקורא מקבל את ההחלטה מבחוץ (allowImages).

const { callOpenAI } = require("../order-ingestion/llm");

const IMAGE_MIME = /^image\/(jpe?g|png)\b/i;
const IMAGE_EXT = /\.(jpe?g|png)$/i;

const isImageReadingEnabled = () =>
  String(process.env.INGESTION_IMAGE_READING || "").toLowerCase() === "true";

// מדבקות ווצאפ הן webp, ולכן webp אינו ברשימה בכוונה
const isOrderImage = (filename, mimeType) =>
  IMAGE_MIME.test(String(mimeType || "")) ||
  (!mimeType && IMAGE_EXT.test(String(filename || "")));

const MODEL = process.env.OPENAI_IMAGE_MODEL || process.env.OPENAI_ORDER_PARSER_MODEL || "gpt-4o";

const IMAGE_SCHEMA = {
  name: "order_image_transcription",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      isOrderList: {
        type: "boolean",
        description: "האם בתמונה יש רשימת הזמנה (מוצרים וכמויות). false לצילום שאינו הזמנה.",
      },
      lines: {
        type: "array",
        description: "שורות ההזמנה לפי הסדר בדף. רק שורות שיש בהן מוצר.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            quantity: {
              type: ["string", "null"],
              description: "המספר ואחריו היחידה אם כתובה (למשל \"3\", \"2 ק\\\"ג\", \"1 ארגז\"). null אם אין.",
            },
            product: {
              type: "string",
              description: "שם המוצר כפי שכתוב בדף, כולל פירוט (טעם, גודל, אחוז שומן), בלי הכמות והיחידה.",
            },
            unclear: {
              type: "boolean",
              description: "true אם חלק מהשורה לא קריא והועתק כניחוש.",
            },
          },
          required: ["quantity", "product", "unclear"],
        },
      },
      notes: {
        type: ["string", "null"],
        description: "הערות שאינן מוצר (תאריך אספקה, בקשות). null אם אין.",
      },
    },
    required: ["isOrderList", "lines", "notes"],
  },
};

const SYSTEM = [
  "אתה מעתיק הזמנות של מוצרי מזון וניקיון לעסק בישראל מתוך תמונה.",
  "התמונה היא צילום טלפון של דף בכתב יד בעברית, או טופס מודפס שהכמויות בו מולאו ביד.",
  "העתק כל שורת מוצר: הכמות והשם בדיוק כפי שכתובים. אל תתרגם, אל תשלים מוצר שלא כתוב, ואל תתקן לשם מותג.",
  "בטופס מודפס: העתק רק שורות שמולאה בהן כמות ביד, ושייך כל כמות לשורה שלידה. כמות שנכתבה בין שתי שורות — סמן unclear.",
  "שורות שנמחקו בקו — דלג עליהן.",
  "אם מילה לא קריאה, כתוב את הניחוש הסביר ביותר וסמן unclear=true.",
  "כותרות, תאריכים, ברכות ושמות — לא שורות מוצר; תאריך אספקה ובקשות מיוחדות כתוב ב-notes.",
].join("\n");

/**
 * שורה בצורה "מספר שם [יחידה]" — הצורה שהמנוע הפנימי קורא.
 *
 * היחידה עוברת לסוף בכוונה: המנוע קורא "2 שקד קלוי ק\"ג" ככמות 2, אבל
 * "2 ק\"ג שקד קלוי" ככמות 1 של מוצר בשם "2 ק\"ג שקד קלוי" (נמדד 11/2026).
 */
const toOrderLine = (line) => {
  const product = String(line?.product || "").trim();
  const quantity = String(line?.quantity || "").trim();
  if (!product) return "";
  const m = quantity.match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (!m) return [quantity, product].filter(Boolean).join(" ");
  const unit = m[2].trim();
  return `${m[1]} ${product}${unit ? ` ${unit}` : ""}`;
};

/**
 * העתקת הזמנה מתמונה לטקסט.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {Object} [deps]
 * @param {Function} [deps.call] - להחלפה בבדיקות (ברירת מחדל: callOpenAI)
 * @returns {Promise<{text: string, readable: boolean, reason?: string, unclearCount: number, lineCount: number}>}
 */
const extractImageText = async (buffer, mimeType, { call = callOpenAI } = {}) => {
  const mime = IMAGE_MIME.test(String(mimeType || "")) ? String(mimeType).split(";")[0] : "image/jpeg";
  const answer = await call({
    model: MODEL,
    system: SYSTEM,
    user: [
      { type: "text", text: "העתק את ההזמנה שבתמונה." },
      {
        type: "image_url",
        image_url: { url: `data:${mime};base64,${buffer.toString("base64")}`, detail: "high" },
      },
    ],
    schema: IMAGE_SCHEMA,
  });

  const lines = Array.isArray(answer?.lines) ? answer.lines : [];
  if (!answer?.isOrderList || !lines.length) {
    return {
      text: "",
      readable: false,
      reason: "בתמונה לא נמצאה רשימת הזמנה",
      unclearCount: 0,
      lineCount: 0,
    };
  }

  const body = lines.map(toOrderLine).filter(Boolean);
  const notes = String(answer.notes || "").trim();

  return {
    text: [...(notes ? [notes] : []), ...body].join("\n"),
    readable: true,
    unclearCount: lines.filter((l) => l.unclear).length,
    lineCount: body.length,
  };
};

module.exports = {
  extractImageText,
  toOrderLine,
  isOrderImage,
  isImageReadingEnabled,
  IMAGE_SCHEMA,
};

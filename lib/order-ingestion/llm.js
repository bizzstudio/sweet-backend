// lib/order-ingestion/llm.js
//
// שכבת ה-LLM של קליטת ההזמנות. שני תפקידים בלבד:
//
//   1. extractOrder()  — להפוך הודעה בטקסט חופשי (עברית/אנגלית, ווצאפ/מייל)
//                        לאובייקט מסודר: לקוח, כתובת, פריטים + כמויות.
//   2. chooseProduct()  — הכרעה בין מועמדים מהקטלוג כשמנוע ההתאמה לא בטוח.
//
// חשוב: ה-LLM *לא* מחליט מחירים ו*לא* בוחר מוצרים מהאוויר. הוא מחזיר את שם
// המוצר כפי שהלקוח כתב אותו, וההתאמה לקטלוג נעשית מול ה-DB
// (utils/productMatching.js). ב-chooseProduct הוא בוחר רק מתוך רשימה סגורה
// של מוצרים אמיתיים שנשלחת אליו. כך הזמנה לא יכולה להכיל מוצר שלא קיים.

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const MODEL = process.env.OPENAI_ORDER_PARSER_MODEL || "gpt-4o";
const TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS) || 45000;
const MAX_TEXT_CHARS = Number(process.env.OPENAI_MAX_TEXT_CHARS) || 12000;

// ─────────────────────────────────────────────────────────────
//  סכמת הפלט של חילוץ ההזמנה (Structured Outputs, strict)
// ─────────────────────────────────────────────────────────────
const ORDER_SCHEMA = {
  name: "parsed_order",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      isOrder: {
        type: "boolean",
        description:
          "האם ההודעה היא הזמנת מוצרים. false עבור שאלה, בירור, תלונה, ספאם, תשובה לסקר, אישור, או הודעת נימוס.",
      },
      notAnOrderReason: {
        type: ["string", "null"],
        description: "אם isOrder=false — במשפט אחד בעברית למה זו לא הזמנה.",
      },
      customer: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: ["string", "null"], description: "שם פרטי של המזמין" },
          lastName: { type: ["string", "null"], description: "שם משפחה" },
          phone: {
            type: ["string", "null"],
            description: "טלפון כפי שמופיע בהודעה, ספרות בלבד אם אפשר",
          },
          email: { type: ["string", "null"], description: "כתובת מייל אם מופיעה בגוף ההודעה" },
          businessName: {
            type: ["string", "null"],
            description: "שם בית עסק/מוסד אם ההזמנה עסקית (בית קפה, מסעדה, ועד עובדים)",
          },
        },
        required: ["name", "lastName", "phone", "email", "businessName"],
      },
      delivery: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: {
            type: ["string", "null"],
            enum: ["delivery", "pickup", null],
            description:
              "delivery אם מבקשים משלוח/כתובת, pickup אם מבקשים לאסוף מהחנות, null אם לא צוין",
          },
          city: { type: ["string", "null"], description: "שם העיר בעברית" },
          street: { type: ["string", "null"], description: "שם הרחוב בלבד, ללא מספר" },
          houseNumber: { type: ["string", "null"] },
          apartmentNumber: { type: ["string", "null"] },
          floor: { type: ["string", "null"] },
          entryCode: { type: ["string", "null"], description: "קוד כניסה לבניין" },
          requestedDate: {
            type: ["string", "null"],
            description: "תאריך/יום שהלקוח ביקש לקבל, כפי שנכתב בהודעה (טקסט חופשי)",
          },
          callOnArrival: {
            type: ["boolean", "null"],
            description:
              "true אם ביקשו שהשליח יתקשר, false אם ביקשו להשאיר ליד הדלת, null אם לא צוין",
          },
        },
        required: [
          "type",
          "city",
          "street",
          "houseNumber",
          "apartmentNumber",
          "floor",
          "entryCode",
          "requestedDate",
          "callOnArrival",
        ],
      },
      items: {
        type: "array",
        description: "כל הפריטים שהלקוח ביקש. שורה אחת לכל פריט.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            rawName: {
              type: "string",
              description:
                "שם המוצר בלבד, בדיוק במילים של הלקוח, ללא הכמות וללא יחידת המדידה. לא לתרגם, לא לתקן ולא להשלים שם מוצר שלא נכתב.",
            },
            quantity: {
              type: "number",
              description:
                "הכמות המבוקשת כמספר. אם לא צוינה כמות — 1. 'שתי שקיות' → 2. 'חצי קילו' → 0.5.",
            },
            unit: {
              type: ["string", "null"],
              description:
                "יחידת המדידה שהלקוח ציין: קילו / גרם / שקית / מארז / מגש / סלסילה / יחידה. null אם לא צוינה.",
            },
            note: {
              type: ["string", "null"],
              description: "הערה שנוגעת לפריט הזה בלבד (לדוגמה 'בלי גרעינים', 'טרי')",
            },
          },
          required: ["rawName", "quantity", "unit", "note"],
        },
      },
      note: {
        type: ["string", "null"],
        description: "הערה כללית של הלקוח להזמנה כולה (לא הערת פריט)",
      },
      confidence: {
        type: "number",
        description:
          "0..1 — עד כמה אתה בטוח שקראת את ההזמנה נכון ובמלואה. הורד ביטחון אם ההודעה מבולבלת, חסרה, או שיש בה סתירות.",
      },
    },
    required: [
      "isOrder",
      "notAnOrderReason",
      "customer",
      "delivery",
      "items",
      "note",
      "confidence",
    ],
  },
};

const EXTRACT_SYSTEM_PROMPT = `אתה קורא הזמנות שמגיעות לחנות "${process.env.COMPANY_NAME || "המתוקים של בני"}" בהודעות ווצאפ ובמיילים, וממיר אותן לנתונים מסודרים.

ההודעות מגיעות בשלושה סוגים ואתה צריך לטפל בכולם:
1. טקסט חופשי מלקוח פרטי — "היי, אפשר 2 מגשי תמרים ושקית פיסטוק לרחוב הרצל 5 תל אביב?"
2. רשימת פריטים חצי-מסודרת — שורה לכל פריט, לפעמים עם פרטי לקוח בראש ההודעה.
3. פורמט קבוע/טבלה מלקוח קבוע או מוסד.

כללי ברזל:
- rawName הוא שם המוצר *במילים של הלקוח*, בלי הכמות ובלי היחידה. אל תתרגם, אל תתקן שגיאות כתיב ואל תנחש שם מוצר שלא נכתב. אם כתוב "מג'הול" — תחזיר "מג'הול".
- אל תמציא פריטים שלא הוזכרו, ואל תפצל פריט אחד לשניים.
- כמויות במילים בעברית הן מספרים: "שתי"=2, "שלושה"=3, "חצי קילו"=0.5 עם unit="קילו".
- אם אותו מוצר מופיע פעמיים בהודעה — החזר אותו כשתי שורות, לא תסכם.
- הבחן בין הערת פריט (note בתוך items) לבין הערה כללית (note ברמת ההזמנה).
- כתובת: street הוא שם הרחוב בלבד; מספר הבית נכנס ל-houseNumber.
- אם ההודעה היא שאלה ("מה המחיר של...", "אתם פתוחים?"), בירור על הזמנה קיימת, תלונה, תשובה לסקר (למשל "1", "כן", "תודה"), או ספאם — החזר isOrder=false עם notAnOrderReason. אל תנסה לחלץ ממנה הזמנה.
- הודעה שמזכירה מוצרים אבל בלי כוונת קנייה ("קניתי אצלכם תמרים ולא היו טובים") היא לא הזמנה.
- confidence: תן ציון נמוך כשההודעה עמומה, קטועה, או שאתה מנחש. עדיף ביטחון נמוך מהזמנה שגויה.

החזר JSON בלבד לפי הסכמה.`;

// ─────────────────────────────────────────────────────────────
//  סכמת הכרעה בין מועמדים
// ─────────────────────────────────────────────────────────────
const CHOICE_SCHEMA = {
  name: "product_choice",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      chosenIndex: {
        type: "integer",
        description:
          "האינדקס (מתוך הרשימה שנשלחה) של המוצר שהלקוח התכוון אליו. -1 אם אף אחד מהם אינו מה שהלקוח ביקש.",
      },
      confidence: { type: "number", description: "0..1 ביטחון בבחירה" },
      reason: { type: "string", description: "משפט קצר בעברית שמסביר את הבחירה" },
    },
    required: ["chosenIndex", "confidence", "reason"],
  },
};

const CHOICE_SYSTEM_PROMPT = `אתה מכריע איזה מוצר מהקטלוג הלקוח התכוון אליו.

תקבל את הטקסט המקורי של הלקוח ורשימה ממוספרת של מוצרים אמיתיים מהקטלוג.
בחר את המוצר שהלקוח ביקש, או -1 אם אף מוצר ברשימה אינו מה שביקש.

כללים:
- מותר לבחור *רק* מתוך הרשימה. אל תציע מוצר אחר.
- אם הלקוח לא פירט (כתב "תמרים" סתם) ויש כמה גרסאות שונות מהותית (זנים/גדלים/אריזות שונות) — החזר -1 עם ביטחון נמוך. עדיף לא לנחש.
- אם ההבדל בין המועמדים חסר משמעות לבקשה של הלקוח, בחר את הפשוט/הבסיסי מביניהם.
- אם הלקוח ציין מאפיין (גודל, זן, אורגני, ללא סוכר) — הוא מחייב.`;

// ─────────────────────────────────────────────────────────────
//  transport
// ─────────────────────────────────────────────────────────────

class LlmError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = "LlmError";
    this.retryable = retryable;
  }
}

const callOpenAI = async ({ system, user, schema, temperature = 0 }) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new LlmError(
      "OPENAI_API_KEY חסר ב-.env — קליטת ההזמנות מהמייל/ווצאפ לא יכולה לעבוד בלעדיו"
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_schema", json_schema: schema },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    // ניתוק/timeout — שווה לנסות שוב
    throw new LlmError(
      err.name === "AbortError"
        ? `הבקשה ל-OpenAI חרגה מ-${TIMEOUT_MS}ms`
        : `שגיאת רשת בקריאה ל-OpenAI: ${err.message}`,
      { retryable: true }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    // 429 / 5xx — עומס או תקלה זמנית בצד OpenAI
    const retryable = response.status === 429 || response.status >= 500;
    throw new LlmError(
      `OpenAI החזיר ${response.status}: ${bodyText.slice(0, 500)}`,
      { retryable }
    );
  }

  const data = await response.json();
  const choice = data?.choices?.[0];

  // Structured Outputs יכול לסרב לענות — refusal מגיע בשדה נפרד
  if (choice?.message?.refusal) {
    throw new LlmError(`OpenAI סירב לענות: ${choice.message.refusal}`);
  }

  // חיתוך באמצע התשובה — ה-JSON לא שלם, אין מה לנתח
  if (choice?.finish_reason === "length") {
    throw new LlmError("תשובת OpenAI נקטעה (הודעה ארוכה מדי)", { retryable: false });
  }

  const content = choice?.message?.content;
  if (!content) {
    throw new LlmError("תשובה ריקה מ-OpenAI", { retryable: true });
  }

  try {
    return JSON.parse(content);
  } catch (err) {
    throw new LlmError(`תשובת OpenAI אינה JSON תקין: ${err.message}`);
  }
};

// ניסיון חוזר אחד על שגיאות זמניות בלבד
const callWithRetry = async (params) => {
  try {
    return await callOpenAI(params);
  } catch (err) {
    if (!(err instanceof LlmError) || !err.retryable) throw err;
    console.log(`[ingestion/llm] ניסיון חוזר אחרי שגיאה זמנית: ${err.message}`);
    await new Promise((r) => setTimeout(r, 1500));
    return callOpenAI(params);
  }
};

// ─────────────────────────────────────────────────────────────
//  API ציבורי
// ─────────────────────────────────────────────────────────────

/**
 * חילוץ הזמנה מהודעה בטקסט חופשי.
 *
 * @param {Object} input
 * @param {string} input.text - גוף ההודעה
 * @param {string} input.channel - "whatsapp" | "email"
 * @param {Object} [input.sender] - { name, phone, email } כפי שידוע מהערוץ עצמו
 * @param {string} [input.subject] - נושא המייל
 * @returns {Promise<Object>} לפי ORDER_SCHEMA
 */
const extractOrder = async ({ text, channel, sender = {}, subject }) => {
  const full = String(text || "");
  const trimmed = full.slice(0, MAX_TEXT_CHARS);

  // חיתוך שקט של הודעה ארוכה היה מסוכן: פריטים בסוף ההודעה היו נעלמים בלי
  // שאף אחד יידע. אם נחתך משהו — זה נרשם בלוג כדי שיהיה ניתן לתחקור.
  if (full.length > trimmed.length) {
    console.log(
      `[ingestion/llm] אזהרה: ההודעה נחתכה מ-${full.length} ל-${MAX_TEXT_CHARS} תווים — ` +
        `ייתכן שפריטים בסופה לא נקראו (OPENAI_MAX_TEXT_CHARS)`
    );
  }

  // מה שידוע מהערוץ עצמו אמין יותר ממה שכתוב בגוף ההודעה — נותנים ל-LLM
  // את ההקשר, אבל הטלפון/מייל של הערוץ נקבעים בקוד ולא כאן.
  const contextLines = [
    `ערוץ: ${channel === "whatsapp" ? "ווצאפ" : "מייל"}`,
    sender.phone ? `טלפון השולח (מהערוץ): ${sender.phone}` : null,
    sender.email ? `מייל השולח (מהערוץ): ${sender.email}` : null,
    sender.name ? `שם השולח (מהערוץ): ${sender.name}` : null,
    subject ? `נושא המייל: ${subject}` : null,
  ].filter(Boolean);

  const user = `${contextLines.join("\n")}

--- תוכן ההודעה ---
${trimmed}
--- סוף ההודעה ---`;

  const result = await callWithRetry({
    system: EXTRACT_SYSTEM_PROMPT,
    user,
    schema: ORDER_SCHEMA,
  });

  // הגנה: גם עם strict schema לא סומכים על המבנה בעיוורון
  if (!result || typeof result !== "object") {
    throw new LlmError("פלט חילוץ לא תקין מ-OpenAI");
  }
  if (!Array.isArray(result.items)) result.items = [];

  return result;
};

/**
 * הכרעה בין מועמדים מהקטלוג.
 *
 * @param {Object} input
 * @param {string} input.rawName - מה הלקוח כתב
 * @param {string} [input.contextText] - ההודעה המלאה, לעזרה בהקשר
 * @param {Array<{_id: any, title: Object, sku: string}>} input.candidates - מוצרים אמיתיים
 * @returns {Promise<{chosenIndex: number, confidence: number, reason: string}>}
 */
const chooseProduct = async ({ rawName, contextText = "", candidates = [] }) => {
  if (!candidates.length) return { chosenIndex: -1, confidence: 0, reason: "אין מועמדים" };

  const list = candidates
    .map((c, i) => {
      const title = c.title?.he || c.title?.en || "(ללא שם)";
      return `${i}. ${title}${c.sku ? ` [מק"ט ${c.sku}]` : ""}`;
    })
    .join("\n");

  const user = `הלקוח ביקש: "${rawName}"

${contextText ? `ההודעה המלאה של הלקוח:\n${String(contextText).slice(0, 2000)}\n` : ""}
מוצרים מהקטלוג:
${list}`;

  const result = await callWithRetry({
    system: CHOICE_SYSTEM_PROMPT,
    user,
    schema: CHOICE_SCHEMA,
  });

  // אכיפת טווח: LLM שמחזיר אינדקס מחוץ לרשימה = אין בחירה
  const idx = Number.isInteger(result?.chosenIndex) ? result.chosenIndex : -1;
  const chosenIndex = idx >= 0 && idx < candidates.length ? idx : -1;

  return {
    chosenIndex,
    confidence: chosenIndex === -1 ? 0 : Number(result.confidence) || 0,
    reason: result?.reason || "",
  };
};

module.exports = {
  extractOrder,
  chooseProduct,
  LlmError,
  MODEL,
};

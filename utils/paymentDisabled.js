// utils/paymentDisabled.js
//
// מתג "חנות ללא תשלום": ההזמנה נשמרת ועוברת לאדמין, ואין שלב סליקה כלל.
// הלקוח לוחץ "שמירת ההזמנה", ההזמנה נסגרת מיד (Processing) והצוות מטפל בה
// ובגבייה מחוץ לאתר — בדיוק כמו הזמנה שנקלטה מוואטסאפ או מתעודה.
//
// ברירת המחדל היא "מכובה" (ללא תשלום), במקביל להסתרת המחירים בחנות
// (sweet-store/src/utils/priceVisibility.js): חנות שלא מציגה מחירים גם לא
// אמורה לגבות. להחזרת הסליקה צריך *שני* דברים, אחרת המסלול נשבר באמצע:
//   1. כאן בשרת:  PAYMENT_DISABLED=false  (משתנה סביבה, ואז restart)
//   2. בחנות:     NEXT_PUBLIC_PAYMENT_DISABLED=false בזמן ה-build (npm run build)
// אם רק צד אחד ישתנה, החנות תמתין לקישור תשלום שלא יגיע (או להפך).
const PAYMENT_DISABLED =
  String(process.env.PAYMENT_DISABLED ?? "").trim().toLowerCase() !== "false";

// אמצעי התשלום שנרשם על הזמנה שנשמרה ללא סליקה. חשוב שלא יהיה "creditCard":
// עמוד ה-/success בחנות מפנה הזמנת אשראי שנשארה Pending ל-/failed, והחשבונית
// והאדמין מציגים את הערך הזה כטקסט מתורגם ("ללא תשלום").
const NO_PAYMENT_METHOD = "noPayment";

module.exports = { PAYMENT_DISABLED, NO_PAYMENT_METHOD };

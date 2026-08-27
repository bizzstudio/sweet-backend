// scripts/set-store-hebrew-content.js
//
// מחליף את תוכן החנות שנגרר מפרויקט הדמו המקורי (kachabazar) בתוכן עברי אמיתי.
//
// רקע: showingTranslateValue בחנות בוחר את השפה לפי קוקי ‎_lang, שברירת המחדל
// שלו היא "he", ונופל ל-‎data.en כשאין ערך עברי. כל הכותרות בהגדרות היו en/de
// בלבד — ולכן דף הבית של חנות עברית הציג "Popular Products for Daily Shopping"
// ו-"Featured Categories". גם השקופיות של הקרוסלה הצביעו לקטגוריות שאינן
// קיימות כאן (‎/search?category=milk-dairy) ולתמונות מרוחקות ב-Cloudinary.
//
// הסקריפט אידמפוטנטי: הוא כותב ערכי he לצד ה-en הקיימים ולא מוחק שדות אחרים.
//
// הרצה:  node scripts/set-store-hebrew-content.js          (הרצה יבשה: --dry)
require("dotenv").config();
const mongoose = require("mongoose");

const DRY = process.argv.includes("--dry");

// כותרת דו-לשונית. ה-en נשמר כי חלק מהמסכים באדמין עדיין מציגים אותו.
const t = (he, en) => ({ he, en, de: en });

const HOME = {
  feature_title: t("הקטגוריות שלנו", "Our Categories"),
  feature_description: t(
    "כל מה שהעסק צריך במקום אחד — מזון, פירות וירקות, חומרי ניקוי, חד-פעמי וציוד משרדי.",
    "Everything your business needs in one place."
  ),

  popular_title: t("המוצרים המבוקשים ביותר", "Most Requested Products"),
  popular_description: t(
    "המוצרים שהלקוחות שלנו מזמינים הכי הרבה. אפשר להוסיף לעגלה ישירות מכאן.",
    "The products our customers order most."
  ),

  latest_discount_title: t("מבצעים והנחות", "Offers and Discounts"),
  latest_discount_description: t(
    "המבצעים המתעדכנים של החודש. המחירים תקפים כל עוד המוצר במלאי.",
    "This month's updated offers."
  ),

  discount_title: t("קוד קופון פעיל", "Active Coupon Code"),

  promotion_title: t("אספקה שוטפת לעסקים", "Ongoing Supply for Businesses"),
  promotion_description: t(
    "הזמנה עד השעה 14:00 יוצאת לאספקה למחרת. מחירון קבוע לכל לקוח.",
    "Order by 2pm for next-day delivery."
  ),
  promotion_button_name: t("לקטלוג המלא", "Browse the catalog"),
  promotion_button_link: "/product-category/מזון",

  quick_delivery_subtitle: t("ספק מזון וחד-פעמי לעסקים", "Food and disposables supplier"),
  quick_delivery_title: t("מזמינים אונליין, מקבלים לעסק", "Order online, delivered to you"),
  quick_delivery_description: t(
    "הקטלוג המלא פתוח באזור האישי, עם המחירון האישי של כל לקוח. הזמנה מתבצעת בכמה קליקים ומגיעה ישירות למערכת הליקוט שלנו.",
    "The full catalog is available in your personal area, with your own price list."
  ),
  quick_delivery_button: t("להזמנה", "Order now"),
  quick_delivery_link: "/product-category/מזון",

  daily_need_title: t("הקטלוג של המתוקים של בני", "The catalog of Beny's"),
  daily_need_description: t(
    "אלפי פריטים בקטגוריות מזון, פירות וירקות, חומרי ניקוי, חד-פעמי וציוד משרדי.",
    "Thousands of items across our categories."
  ),
};

// שלוש שקופיות עם תמונות מקומיות (public/slider) וקישורים לקטגוריות אמיתיות.
// four_img/five_img מתרוקנות בכוונה — MainCarousel מסנן שקופיות בלי תמונה.
const SLIDER = {
  first_img: "/slider/slider-1.jpg",
  first_title: t("כל מה שהעסק צריך", "Everything your business needs"),
  first_description: t("מזון, פירות וירקות, ניקוי וחד-פעמי", "Food, produce, cleaning and disposables"),
  first_button: t("לקטלוג", "Shop now"),
  first_link: "/product-category/מזון",

  second_img: "/slider/slider-2.jpg",
  second_title: t("פירות וירקות טריים", "Fresh produce"),
  second_description: t("נשקלים ונארזים ביום האספקה", "Weighed and packed on delivery day"),
  second_button: t("לקטגוריה", "Shop now"),
  second_link: "/product-category/פירות",

  third_img: "/slider/slider-3.jpg",
  third_title: t("ניקיון וחד-פעמי", "Cleaning and disposables"),
  third_description: t("מלאי קבוע, אספקה שוטפת", "Always in stock"),
  third_button: t("לקטגוריה", "Shop now"),
  third_link: "/product-category/ח.ניקוי+חפ",

  four_img: "",
  five_img: "",
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const Settings = mongoose.connection.db.collection("settings");

  const doc = await Settings.findOne({ name: "storeCustomizationSetting" });
  if (!doc) throw new Error("storeCustomizationSetting לא נמצא ב-DB");

  const $set = {};
  for (const [k, v] of Object.entries(HOME)) $set[`setting.home.${k}`] = v;
  for (const [k, v] of Object.entries(SLIDER)) $set[`setting.slider.${k}`] = v;

  console.log(DRY ? "[dry] " : "[run] ", Object.keys($set).length, "שדות יעודכנו");
  for (const [k, v] of Object.entries($set)) {
    console.log("  ", k, "=", typeof v === "string" ? v : v.he);
  }

  if (!DRY) {
    await Settings.updateOne({ _id: doc._id }, { $set });
    console.log("\nעודכן. שימו לב: החנות שומרת את ההגדרות במטמון בצד הלקוח —");
    console.log("צריך רענון קשיח (או ניקוי sessionStorage) כדי לראות את השינוי.");
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

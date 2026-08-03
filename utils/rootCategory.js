// utils/rootCategory.js
// כל עץ הקטגוריות בחנות תלוי בקטגוריית שורש אחת ("Home"): גם דף הקטגוריות
// באדמין וגם התפריטים בחנות מציגים רק את data[0].children. קטגוריה שנוצרת
// בלי parentId נשמרת במסד אבל לא מופיעה בשום מסך, וגרוע מכך - היא הופכת
// לשורש נוסף, ואם היא החדשה מכולן (getAllCategory ממיין _id יורד) דף
// הקטגוריות יציג את הילדים שלה, כלומר כלום. לכן כל יצירה של קטגוריה
// חייבת לתלות אותה תחת השורש הזה.
const Category = require("../models/Category");

const ROOT_SLUG = "home";
const ROOT_NAME = { he: "ראשי", en: "Home" };

// parentId הוא String בסכימה, ולקוחות שונים שולחים חוסר-ערך אחרת
const toParentId = (value) =>
  value === undefined || value === null || value === "" ? "" : String(value);

const isRootCategory = (category) => toParentId(category?.parentId) === "";

// שם קריא לשדה parentName (מחרוזת ולא אובייקט - כך זה נשמר בשאר המערכת)
const displayName = (name) =>
  (typeof name === "object" && name ? name.he || name.en : name) || ROOT_NAME.en;

/**
 * מאתר את קטגוריית השורש מתוך רשימה נתונה, בלי לכתוב למסד.
 * סדר העדיפויות: slug "home", אחריו שורש שכבר תלויות בו קטגוריות,
 * ולבסוף שורש יחיד. מחזיר null אם אין שורש מובהק.
 * @param {Array} all כל הקטגוריות, כולל השדה parentId
 */
const findRootCategory = (all) => {
  const roots = all.filter(isRootCategory);

  return (
    roots.find((category) => category.slug === ROOT_SLUG) ||
    roots.find((category) =>
      all.some(
        (other) => toParentId(other.parentId) === String(category._id)
      )
    ) ||
    (roots.length === 1 ? roots[0] : null)
  );
};

/**
 * מחזיר את קטגוריית השורש, ויוצר אותה אם היא לא קיימת.
 * @param {Array} [categories] רשימת הקטגוריות (עם parentId) אם כבר נשלפה
 * @param {Set<string>} [usedSlugs] אוסף ה-slug התפוסים, לעדכון בעת יצירה
 * @returns {Promise<{_id: any, name: string}>}
 */
const resolveRootCategory = async (categories, usedSlugs) => {
  const all =
    categories || (await Category.find({}).select("name slug parentId").lean());

  const existing = findRootCategory(all);
  if (existing) {
    return { _id: existing._id, name: displayName(existing.name) };
  }

  if (usedSlugs) usedSlugs.add(ROOT_SLUG);

  try {
    const created = await Category.create({
      name: { ...ROOT_NAME },
      description: { he: "", en: "" },
      slug: ROOT_SLUG,
      status: "show",
    });
    return { _id: created._id, name: displayName(created.name) };
  } catch (err) {
    // שתי בקשות במקביל יכולות לנסות ליצור את השורש באותו רגע. האינדקס
    // הייחודי על slug יפיל את השנייה, ואז פשוט משתמשים במה שנוצר
    const winner = await Category.findOne({ slug: ROOT_SLUG })
      .select("name")
      .lean();
    if (!winner) throw err;
    return { _id: winner._id, name: displayName(winner.name) };
  }
};

module.exports = {
  resolveRootCategory,
  findRootCategory,
  isRootCategory,
  toParentId,
  displayName,
  ROOT_SLUG,
};

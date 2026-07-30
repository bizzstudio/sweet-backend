require("dotenv").config();
const Product = require("../../models/Product");
const Setting = require("../../models/Setting");
const Notification = require("../../models/Notification");

// סף ברירת המחדל ל"מלאי נמוך" אם לא הוגדר בהגדרות החנות
const DEFAULT_LOW_STOCK_THRESHOLD = 2;
// קידומת מזהה להתראות מלאי נמוך (משמשת למניעת כפילויות)
const LOW_STOCK_PREFIX = "מלאי נמוך";

// שליפת סף "מלאי נמוך" מתוך הגדרות החנות (storeSetting.low_stock_threshold)
const getLowStockThreshold = async () => {
  try {
    const storeSetting = await Setting.findOne({ name: "storeSetting" });
    const value = Number(storeSetting?.setting?.low_stock_threshold);
    return Number.isFinite(value) && value >= 0
      ? value
      : DEFAULT_LOW_STOCK_THRESHOLD;
  } catch (err) {
    console.log("err on getLowStockThreshold", err.message);
    return DEFAULT_LOW_STOCK_THRESHOLD;
  }
};

// חילוץ שם המוצר מתוך שדה title (יכול להיות אובייקט רב-לשוני או מחרוזת)
const getProductTitle = (title) => {
  if (!title) return "מוצר";
  if (typeof title === "string") return title;
  return title.he || title.en || Object.values(title)[0] || "מוצר";
};

// יצירת התראת אדמין כשמוצר עם ניהול מלאי יורד אל הסף או מתחתיו
const notifyLowStock = async (product, threshold) => {
  try {
    // מוצרים ללא ניהול מלאי שומרים stock = null (מלאי בלתי מוגבל) — מדלגים
    if (!product || typeof product.stock !== "number") return;
    if (product.stock > threshold) return;

    // מניעת כפילויות — אם כבר קיימת התראת מלאי נמוך שלא נקראה למוצר זה
    const existing = await Notification.findOne({
      productId: product._id,
      status: "unread",
      message: { $regex: `^${LOW_STOCK_PREFIX}` },
    });
    if (existing) return;

    const title = getProductTitle(product.title);
    const message =
      product.stock <= 0
        ? `${LOW_STOCK_PREFIX}: המוצר "${title}" אזל מהמלאי`
        : `${LOW_STOCK_PREFIX}: למוצר "${title}" נותרו ${product.stock} יח' במלאי`;

    await new Notification({
      productId: product._id,
      message,
      image: Array.isArray(product.image) ? product.image[0] : product.image,
    }).save();
  } catch (err) {
    console.log("err on notifyLowStock", err.message);
  }
};

// decrease product quantity after a order created
const handleProductQuantity = async (cart) => {
  try {
    const threshold = await getLowStockThreshold();
    for (const p of cart) {
      let updated;
      if (p?.isCombination) {
        updated = await Product.findOneAndUpdate(
          {
            _id: p._id,
            "variants.productId": p?.variant?.productId || "",
          },
          {
            $inc: {
              stock: -p.quantity,
              "variants.$.quantity": -p.quantity,
              sales: p.quantity,
            },
          },
          {
            new: true,
          }
        );
      } else {
        updated = await Product.findOneAndUpdate(
          {
            _id: p._id,
          },
          {
            $inc: {
              stock: -p.quantity,
              sales: p.quantity,
            },
          },
          {
            new: true,
          }
        );
      }

      // בדיקת מלאי נמוך והתראה לאדמין (לא חוסם את עדכון המלאי)
      await notifyLowStock(updated, threshold);
    }
  } catch (err) {
    console.log("err on handleProductQuantity", err.message);
  }
};

const handleProductAttribute = async (key, value, multi) => {
  try {
    // const products = await Product.find({ 'variants.1': { $exists: true } });
    const products = await Product.find({ isCombination: true });

    // console.log('products', products);

    if (multi) {
      for (const p of products) {
        await Product.updateOne(
          { _id: p._id },
          {
            $pull: {
              variants: { [key]: { $in: value } },
            },
          }
        );
      }
    } else {
      for (const p of products) {
        // console.log('p', p._id);
        await Product.updateOne(
          { _id: p._id },
          {
            $pull: {
              variants: { [key]: value },
            },
          }
        );
      }
    }
  } catch (err) {
    console.log("err, when delete product variants", err.message);
  }
};

module.exports = {
  handleProductQuantity,
  handleProductAttribute,
  notifyLowStock,
  getLowStockThreshold,
};

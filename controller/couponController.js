const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
dayjs.extend(utc);

// const { mongo_connection } = require('../config/db'); // CCDev
const Coupon = require("../models/Coupon");

const addCoupon = async (req, res) => {
  try {
    const newCoupon = new Coupon(req.body);
    await newCoupon.save();
    res.send({ message: "Coupon Added Successfully!" });
  } catch (err) {
    console.log('addCoupon error: ', err);
    res.status(500).send({ message: err.message });
  }
};

const addAllCoupon = async (req, res) => {
  try {
    await Coupon.deleteMany();
    await Coupon.insertMany(req.body);
    res.status(200).send({
      message: "Coupon Added successfully!",
    });
  } catch (err) {
    console.log('addAllCoupon error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const getAllCoupons = async (req, res) => {
  // console.log('coupe')
  try {
    // קופוני הטבת "לקנייה הבאה" הם קודים אישיים אוטומטיים — לא מציגים אותם ברשימת הקופונים בניהול
    const queryObject = { productType: { $ne: "shippingReward" } };
    const { status } = req.query;

    if (status) {
      queryObject.status = { $regex: `${status}`, $options: "i" };
    }
    const coupons = await Coupon.find(queryObject).populate('freeProduct').sort({ _id: -1 });
    // console.log('coups',coupons)
    res.send(coupons);
  } catch (err) {
    console.log('getAllCoupons error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const getShowingCoupons = async (req, res) => {
  try {
    // קופוני הרשמה (מוצר חינם) וקופוני הטבת "לקנייה הבאה" הם קוד-אישי ואינם מוצגים
    // ברשימת הקופונים הציבורית (אחרת קוד אישי היה דולף לכלל הלקוחות)
    const coupons = await Coupon.find({
      status: "show",
      productType: { $ne: "shippingReward" },
      $or: [{ freeProduct: { $exists: false } }, { freeProduct: null }],
    }).sort({ _id: -1 });
    res.send(coupons);
  } catch (err) {
    console.log('getShowingCoupons error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const getCouponById = async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id).populate('freeProduct');
    res.send(coupon);
  } catch (err) {
    console.log('getCouponById error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const updateCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id);

    if (coupon) {
      coupon.title = { ...coupon.title, ...req.body.title };
      coupon.couponCode = req.body.couponCode;
      coupon.endTime = dayjs().utc().format(req.body.endTime);
      // coupon.discountPercentage = req.body.discountPercentage;
      coupon.minimumAmount = req.body.minimumAmount;
      coupon.productType = req.body.productType;
      coupon.discountType = req.body.discountType;
      coupon.logo = req.body.logo;
      if (req.body.oncePerCustomer !== undefined) {
        coupon.oncePerCustomer = req.body.oncePerCustomer;
      }
      // קופון הרשמה (מוצר חינם) — שמירת המוצר החינמי אם נשלח
      if (req.body.freeProduct !== undefined) {
        coupon.freeProduct = req.body.freeProduct || undefined;
      }

      await coupon.save();
      res.send({ message: "Coupon Updated Successfully!" });
    }
  } catch (err) {
    console.log('updateCoupon error: ', err);
    res.status(404).send({ message: "Coupon not found!" });
  }
};

const updateManyCoupons = async (req, res) => {
  try {
    await Coupon.updateMany(
      { _id: { $in: req.body.ids } },
      {
        $set: {
          status: req.body.status,
          startTime: req.body.startTime,
          endTime: req.body.endTime,
        },
      },
      {
        multi: true,
      }
    );

    res.send({
      message: "Coupons update successfully!",
    });
  } catch (err) {
    console.log('updateManyCoupons error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const updateStatus = async (req, res) => {
  try {
    const newStatus = req.body.status;

    await Coupon.updateOne(
      { _id: req.params.id },
      {
        $set: {
          status: newStatus,
        },
      }
    );
    res.status(200).send({
      message: `Coupon ${newStatus === "show" ? "Published" : "Un-Published"
        } Successfully!`,
    });
  } catch (err) {
    console.log('updateStatus error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const deleteCoupon = async (req, res) => {
  try {
    await Coupon.deleteOne({ _id: req.params.id });
    res.status(200).send({
      message: "Coupon Deleted Successfully!",
    });
  } catch (err) {
    console.log('deleteCoupon error: ', err);
    res.status(500).send({ message: err.message });
  }
};

const deleteManyCoupons = async (req, res) => {
  try {
    await Coupon.deleteMany({ _id: req.body.ids });
    res.send({
      message: `Coupons Delete Successfully!`,
    });
  } catch (err) {
    console.log('deleteManyCoupons error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const useCoupon = async (req, res) => {
  try {
    // ניקוי קלט: רווחים מיותרים (העתקה/הדבקה) — ואם לא נמצא, ניסיון נוסף ללא רגישות לאותיות
    const couponCode = String(req.params.couponCode || "").trim();
    const cartTotal = req.body && typeof req.body.cartTotal === 'number' ? req.body.cartTotal : 0;
    const currentTime = dayjs().utc().toDate();

    let coupon = await Coupon.findOne({ couponCode }).populate('freeProduct');
    if (!coupon && couponCode) {
      // fallback: התאמה מדויקת על גרסת ה-uppercase (קודי ההטבה נוצרים באותיות גדולות).
      // בכוונה לא regex עם $options:"i" — חיפוש כזה אינו יכול להשתמש באינדקס וגורם לסריקת
      // כל אוסף הקופונים בכל קוד שגוי, בעוד שאוסף הקופונים גדל עם כל לקוח.
      const upper = couponCode.toUpperCase();
      if (upper !== couponCode) {
        coupon = await Coupon.findOne({ couponCode: upper }).populate('freeProduct');
      }
    }

    if (!coupon) {
      return res.status(404).send({ message: "קופון לא נמצא!" });
    }

    if (coupon.isUsed) {
      return res.status(400).send({ message: "הקופון כבר שומש ואינו ניתן לשימוש חוזר!" });
    }

    if (coupon.startTime && currentTime < coupon.startTime) {
      return res.status(400).send({ message: "קופון עדיין לא בתוקף!" });
    }

    if (coupon.endTime && currentTime > coupon.endTime) {
      return res.status(400).send({ message: "קופון פג תוקף!" });
    }

    if (coupon.status == 'hide') {
      return res.status(400).send({ message: "קופון לא פעיל!" });
    }

    // ===== קופון הרשמה (מוצר חינם) =====
    if (coupon.freeProduct) {
      // מימוש מותנה בלקוח מחובר — אחרת אי אפשר לאכוף "פעם אחת לכל לקוח"
      const customerId = req.user && req.user._id ? String(req.user._id) : null;
      if (!customerId) {
        return res.status(401).send({ message: "יש להתחבר לחשבון כדי לממש קופון זה." });
      }

      // אכיפת "פעם אחת לכל לקוח"
      const alreadyUsed = Array.isArray(coupon.usedBy) &&
        coupon.usedBy.some((id) => String(id) === customerId);
      if (alreadyUsed) {
        return res.status(400).send({ message: "כבר מימשת קופון זה." });
      }

      const product = coupon.freeProduct;
      if (!product || product.status !== "show" || product.stock < 1) {
        return res.status(400).send({ message: "המוצר החינמי של הקופון אינו זמין כעת." });
      }

      return res.status(200).send({
        data: {
          couponCode: coupon.couponCode,
          _id: coupon._id,
          freeProduct: product, // מוצר מלא — הקליינט יוסיף אותו לעגלה ב-₪0
        },
        message: "הקופון הוחל בהצלחה!"
      });
    }

    // ===== קופון רגיל (אחוז / סכום קבוע) =====
    // אכיפת "פעם אחת לכל לקוח" (אם מסומן בקופון)
    if (coupon.oncePerCustomer) {
      const customerId = req.user && req.user._id ? String(req.user._id) : null;
      if (!customerId) {
        return res.status(401).send({ message: "יש להתחבר לחשבון כדי לממש קופון זה." });
      }
      const alreadyUsed = Array.isArray(coupon.usedBy) &&
        coupon.usedBy.some((id) => String(id) === customerId);
      if (alreadyUsed) {
        return res.status(400).send({ message: "כבר מימשת קופון זה." });
      }
    }

    // סכום מינימום למימוש קופון
    const minAmount = Number(coupon.minimumAmount);
    if (minAmount > 0 && cartTotal < minAmount) {
      return res.status(400).send({
        message: `סכום מינימום למימוש הקופון הוא ${minAmount}₪. סכום העגלה כרגע: ${cartTotal}₪`,
      });
    }

    res.status(200).send({
      data: {
        couponCode: coupon.couponCode,
        discountType: coupon.discountType,
        _id: coupon._id,
        minimumAmount: coupon.minimumAmount,
      },
      message: "הקופון הוחל בהצלחה!"
    });
  } catch (err) {
    console.log('useCoupon error: ', err);
    res.status(500).send({ message: "שגיאה פנימית בשרת, נסה שוב מאוחר יותר." });
  }
};

module.exports = {
  addCoupon,
  addAllCoupon,
  getAllCoupons,
  getShowingCoupons,
  getCouponById,
  updateCoupon,
  updateStatus,
  deleteCoupon,
  updateManyCoupons,
  deleteManyCoupons,
  useCoupon,
};

// controller/customerOrderController.js
require("dotenv").config();
const Order = require("../models/Order");
const Status = require("../models/Status");
const Product = require("../models/Product");
const Offer = require("../models/Offer");
const Delivery = require("../models/Delivery");
const Coupon = require("../models/Coupon");
const Setting = require("../models/Setting");
const dayjs = require("dayjs");
const logStatusChange = require("../utils/logStatusChange");
const { nextFreeInvoice } = require("../utils/invoiceNumber");
const Customer = require("../models/Customer");
const { findOptimalOfferCombination } = require("../utils/offerCalculations");
const { findServerItemForClientLine } = require("../utils/cartOfferSync");
const { tokenForOrder } = require("../config/auth");
const { sendEmailSilent } = require("../lib/email-sender/sender");
const {
  isWelcomeGiftCartItem,
  hasUnusedWelcomeGift,
} = require("../utils/welcomeGift");
const { PAYMENT_DISABLED, NO_PAYMENT_METHOD } = require("../utils/paymentDisabled");
const { finalizeOrder } = require("../lib/orders/finalizeOrder");

// גיל מינימלי לטיוטה שמותר למחוק כשהסליקה כבויה (שלב 2 ב-addOrder).
// חמש דקות — הרבה מעבר לזמן הסגירה של הזמנה (מאות אלפיות שנייה), והרבה
// פחות מהזמן שבו טיוטה נחשבת נטושה.
const STALE_DRAFT_AGE_MS = 5 * 60 * 1000;

const ADD_ORDER_ERROR_ALERT_EMAIL =
  process.env.ADD_ORDER_ERROR_ALERT_EMAIL || "office@bizzstudio.co.il";

// שדות פנימיים של קליטת ההזמנות שאינם יוצאים בתגובה ללקוח. הנתיבים כאן מחזירים
// את מסמך ההזמנה כמו שהוא, כולל בגישת אורח עם טוקן, ולכן מה שלא מסונן כאן נשלח
// לדפדפן של הלקוח גם אם החנות לא מציגה אותו.
//   systemNote    — הערת המערכת (מקור הקליטה, אזהרת כתובת חסרה, הנחות המנוע).
//   ingestionError — פירוט הכשל: הודעת השגיאה לעובד, פריטים שלא זוהו וסיבותיהם.
// שניהם מיועדים לצוות בדשבורד. אף מסך בחנות אינו קורא אותם.
const CUSTOMER_HIDDEN_FIELDS = "-systemNote -ingestionError";

const addOrder = async (req, res) => {
  try {
    console.log('addOrder req.body: ', req.body)
    // שליפת הלקוח
    const customer = await Customer.findById(req.user._id);
    console.log('addOrder customer :>>', customer)

    // שלב 1: השמת המזהה של הסטטוס במקום המילה עצמה
    const status = await Status.findOne({ name: "Pending" });

    /*
     * שלב 2: מחיקת הזמנה קודמת אם קיימת.
     *
     * המשמעות המקורית: "התחלת הזמנה ולא שילמת" — הטיוטה הישנה מוחלפת בחדשה.
     *
     * בחנות ללא תשלום (PAYMENT_DISABLED) ההזמנה לא נשארת Pending אלא נסגרת
     * מיד באותה בקשה, ולכן מוסיפים כאן חלון גיל: מוחקים רק טיוטה **ישנה**
     * (שארית מלפני כיבוי הסליקה, או ניסיון שנכשל באמצע).
     *
     * בלי הסייג הזה נפתח מירוץ אמיתי: שתי שליחות במקביל (שתי לשוניות/מכשירים)
     * — השנייה מוצאת את ההזמנה של הראשונה כשהיא עדיין Pending, לפני שהיא
     * הספיקה לעבור ל-Processing, ומוחקת הזמנה שכבר הורידה מלאי והפיקה תעודת
     * משלוח. במסלול התשלום המצב הזה לא היה קיים כי הטיוטה נשארה Pending עד
     * שהלקוח סיים לשלם בדף חיצוני.
     * ראה utils/paymentDisabled.js
     */
    const staleDraftQuery = { user: req.user._id, status: status._id };
    if (PAYMENT_DISABLED) {
      staleDraftQuery.createdAt = { $lt: new Date(Date.now() - STALE_DRAFT_AGE_MS) };
    }
    const isOrderExist = await Order.findOne(staleDraftQuery);
    if (isOrderExist) {
      await Order.findByIdAndDelete(isOrderExist._id);
    }

    // שלב 3: אחזור פרטי העגלה
    const cartItems = req.body.cart;
    let serverCalculatedTotal = 0;
    let serverSubTotal = 0
    let totalDiscount = 0;
    let missingProducts = []; // מערך לשמירת המוצרים החסרים
    let priceConflicts = []; // מערך לשמירת מוצרים שהשתנה להם המחיר

    // שלב 4: בדיקת זמינות המוצרים
    const productIds = cartItems.map(item => item._id);
    const products = await Product.find({ _id: { $in: productIds } })
      .populate({ path: "category", select: "_id name" })
      .populate({ path: "categories", select: "_id name" });
    const productMap = new Map(products.map(product => [product._id.toString(), product]));

    // בדיקה על מוצרים חסרים או ששונה להם המחיר
    for (const item of cartItems) {
      const product = productMap.get(item._id.toString());

      // console.log('client cart item :>> ', item);

      // פריט מתנה/פרס (מבצע, מתנת הצטרפות, מוצר חינם מקופון): המוצר עשוי להיות
      // מוסתר (status hide) ולא נמכר ישירות — הוא ניתן רק דרך המבצע. לכן מדלגים
      // על בדיקות זמינות/מלאי/הגבלת קנייה ומוודאים רק שהמוצר עדיין קיים במאגר.
      const isGiftItem = Boolean(
        item?.isRewardProduct || item?.isWelcomeGift || item?.isCouponFreeProduct
      );

      if (!product) {
        // המוצר לא נמצא במאגר הנתונים
        missingProducts.push({
          ...item,
          reason: 'המוצר לא נמצא'
        });
      } else if (isGiftItem) {
        // מתנה/פרס — לא נחסם ע"י הסתרה/מלאי/הגבלת קנייה
      } else if (typeof product.stock === "number" && product.stock < item.quantity) {
        // מלאי לא מספק (מלאי null = בלתי מוגבל ולכן לא נחסם)
        missingProducts.push({
          ...product.toObject(),
          reason: 'לא במלאי'
        });
      } else if (product.status != "show") {
        // המוצר אינו זמין
        missingProducts.push({
          ...product.toObject(),
          reason: 'המוצר אינו זמין'
        });
      } else if (product.purchaseLimit && item.quantity > product.purchaseLimit) {
        // כמות הכמות שביקש הלוקוח עוברת את ההגבלה
        missingProducts.push({
          ...product.toObject(),
          reason: `הכמות המבוקשת חורגת ממגבלת הקנייה (${product.purchaseLimit})`
        });
      };

      // השוואת מחיר בסיס (ללא מבצע) — מתנות/פרסים (מבצע, ברוכים הבאים, מוצר חינם מקופון)
      // נשארים במחיר המבצע ולא נבדקים מול מחיר הקטלוג
      if (product && !isGiftItem && item.prices.price !== product.prices.price) {
        // console.log('server product :>> ', product);
        priceConflicts.push({
          product: product.toObject(),
          clientPrice: item.prices.price,
          serverPrice: product.prices.price
        });
      }
    };

    // אם יש מוצרים חסרים, החזר אותם לקליינט וסיים את הביצוע
    if (missingProducts.length > 0) {
      return res.status(409).send({
        keyWord: "missingProducts",
        message: "המוצרים הבאים אינם זמינים יותר",
        missingProducts
      });
    };

    // אם יש פריטים בקונפליקט מחירים, נחזיר תשובה ללקוח ונפסיק את הביצוע
    if (priceConflicts.length > 0) {
      return res.status(409).send({
        keyWord: "priceConflicts",
        message: "למוצרים הבאים השתנה המחיר",
        priceConflicts
      });
    };

    const welcomeGiftItems = cartItems.filter(isWelcomeGiftCartItem);
    if (welcomeGiftItems.length > 1) {
      return res.status(400).send({
        message: "ניתן להוסיף מתנת ברוכים הבאים אחת בלבד להזמנה",
      });
    }
    if (welcomeGiftItems.length === 1) {
      const welcomeGiftItem = welcomeGiftItems[0];
      const welcomeGiftProduct = productMap.get(welcomeGiftItem._id.toString());

      if (!hasUnusedWelcomeGift(customer)) {
        return res.status(400).send({
          message: "מתנת ברוכים הבאים אינה זמינה לשימוש",
        });
      }
      if (welcomeGiftItem.quantity !== 1) {
        return res.status(400).send({
          message: "מתנת ברוכים הבאים מוגבלת ליחידה אחת",
        });
      }
      if (
        welcomeGiftProduct?.sku &&
        customer.welcomeGift.sku &&
        welcomeGiftProduct.sku !== customer.welcomeGift.sku
      ) {
        return res.status(400).send({
          message: "מוצר מתנת ברוכים הבאים אינו תואם",
        });
      }
      if (customer.welcomeGift.offerId) {
        const assignedOffer = await Offer.findById(customer.welcomeGift.offerId).populate("rewardProduct");
        const assignedProductId = assignedOffer?.rewardProduct?._id?.toString();
        if (assignedProductId && welcomeGiftItem._id.toString() !== assignedProductId) {
          return res.status(400).send({
            message: "מוצר מתנת ברוכים הבאים אינו תואם למתנה שהוקצתה",
          });
        }
      }
    }

    // שלב 5: שליפת המבצעים
    const getNotActiveOffers = process.env.GET_NOT_ACTIVE_OFFERS === "true";

    let offerFilter = {};

    // אם לא במצב development - סנן מבצעים פעילים
    if (!getNotActiveOffers) {
      const now = new Date();
      const offerFilterConditions = [
        { isActive: true },
        {
          $or: [
            { startsAt: { $exists: false } },
            { startsAt: null },
            { startsAt: { $lte: now } }
          ]
        },
        {
          $or: [
            { endsAt: { $exists: false } },
            { endsAt: null },
            { endsAt: { $gte: now } }
          ]
        }
      ];

      offerFilterConditions.push({
        type: { $ne: "WELCOME_GIFT" },
      });

      // סינון מבצעים שהלקוח כבר ניצל (oncePerCustomer: true)
      if (customer && customer.redeemedOffers && customer.redeemedOffers.length > 0) {
        offerFilterConditions.push({
          $or: [
            { oncePerCustomer: { $ne: true } },
            { oncePerCustomer: false },
            { oncePerCustomer: { $exists: false } },
            { _id: { $nin: customer.redeemedOffers } }
          ]
        });
      }

      offerFilter = { $and: offerFilterConditions };
    }

    // משיכת כל המבצעים הרלוונטים
    let offers = await Offer.find(offerFilter)
      .populate({ path: "products" })
      .populate({ path: "rewardProduct" })
      .populate({ path: "rewardProducts" })
      .populate({ path: "triggerProduct" });

    // סינון מבצעים ללקוחות חדשים בלבד
    // הלקוח כבר מחובר (כי זה addOrder), אז נבדוק את זכאותו
    if (customer) {
      offers = offers.filter(offer => {
        // אם המבצע מיועד ללקוחות חדשים בלבד
        if (offer.forNewCustomersOnly) {
          // תאריך התחלת המבצע (או תאריך יצירת המבצע אם אין startsAt)
          const offerStartDate = offer.startsAt || offer.createdAt;
          // תאריך יצירת החשבון של הלקוח
          const customerCreatedAt = customer.createdAt;
          
          // הלקוח זכאי למבצע רק אם החשבון שלו נפתח לאחר תחילת המבצע
          return customerCreatedAt >= offerStartDate;
        }
        // אם המבצע לא מיועד ללקוחות חדשים בלבד, הלקוח זכאי לו
        return true;
      });
    } else {
      offers = offers.filter(offer => !offer.forNewCustomersOnly);
    }

    const waivedOfferIds = Array.isArray(req.body.waivedOfferIds)
      ? req.body.waivedOfferIds.map((id) => String(id))
      : [];
    const waivedExclusiveOfferIds = Array.isArray(req.body.waivedExclusiveOfferIds)
      ? req.body.waivedExclusiveOfferIds.map((id) => String(id))
      : [];
    const lockedExclusiveOfferId =
      req.body.lockedExclusiveOfferId != null && String(req.body.lockedExclusiveOfferId).length > 0
        ? String(req.body.lockedExclusiveOfferId)
        : null;

    // שלב 6: חישוב מבצעים בשרת בלבד — findOptimal על cartItems מה-body + מבצעים מה-DB (ללא snapshot/FROZEN מהלקוח)
    const {
      updatedCartItems: itemsWithOffers,
      totalDiscount: offerDiscount,
      appliedOffers,
      thresholdDiscount
    } = findOptimalOfferCombination(cartItems, offers, {
      waivedOfferIds,
      waivedExclusiveOfferIds,
      lockedExclusiveOfferId
    });
    totalDiscount += offerDiscount;

    // אם יש מבצעים לא מעודכנים שהגיעו מהקליינט נחזיר קונפליקט ללקוח
    let offerConflicts = []; // מערך לשמירת מוצרים שהשתנה להם המבצע
    for (const clientItem of cartItems) {
      const serverItem = findServerItemForClientLine(clientItem, itemsWithOffers);

      const clientDiscounted = clientItem.discountedPrice ?? null;
      const serverDiscounted = serverItem?.discountedPrice ?? null;
      const offerTitle = serverItem?.offerTitle?.he;

      if (clientDiscounted !== serverDiscounted) {
        offerConflicts.push({
          product: serverItem ?? clientItem,
          clientDiscounted,
          serverDiscounted,
          offerTitle,
        });
      }
    }

    // אם זוהו קונפליקטים, נחזיר ללקוח ונפסיק
    // if (offerConflicts.length > 0) {
    //   const conflicts = {
    //     keyWord: "offerConflicts",
    //     message: "המבצעים של המוצרים הבאים השתנו",
    //     offerConflicts
    //   };
    //   console.log('Offer Conflicts :>> ', conflicts);
    //   return res.status(409).send(conflicts);
    // };

    // חישוב הסכום הכולל לאחר החלת המבצעים
    itemsWithOffers.forEach(item => {
      if (isWelcomeGiftCartItem(item)) {
        // מתנת ברוכים הבאים — ללא עלות
      } else if (item.isCouponFreeProduct) {
        // מוצר חינם מקופון הרשמה — ללא עלות (מאומת מול הקופון בשלב 7)
      } else if (item.isRewardProduct) {
        // מוצר פרס - מחיר לפי rewardPrice
        serverCalculatedTotal += (item.rewardPrice || 0) * item.quantity;
      } else if (item.discountedPrice) {
        // מוצר עם הנחת מבצע
        serverCalculatedTotal += item.discountedPrice;
      } else {
        // מוצר במחיר רגיל
        serverCalculatedTotal += item.prices.price * item.quantity;
      }
    });

    // שמירת המחיר הכולל לפני הנחות
    serverSubTotal = serverCalculatedTotal;

    // הפחתת הנחת קניה מעל סכום (THRESHOLD_DISCOUNT) אם קיימת
    if (thresholdDiscount && thresholdDiscount > 0) {
      serverCalculatedTotal -= thresholdDiscount;
    }

    // שלב 7: חישוב הנחה מקופון (מאפסים קופון אם לא נשלח מפורש – מונע שימוש בקופון ישן מתשלום קודם)
    let couponDiscount = 0;
    const couponIdRaw = req.body.coupon;
    const couponId = (couponIdRaw && String(couponIdRaw).trim() !== "") ? couponIdRaw : null;
    let coupon = null;
    if (couponId) {
      coupon = await Coupon.findById(couponId);
      if (!coupon) {
        return res.status(404).send({ message: "קופון לא נמצא!" });
      }
      if (coupon.isUsed) {
        return res.status(400).send({ message: "הקופון כבר שומש ואינו ניתן לשימוש חוזר!" });
      }
      const currentTime = dayjs().utc().toDate();
      if (coupon.startTime && currentTime < coupon.startTime) {
        return res.status(400).send({ message: "קופון עדיין לא בתוקף!" });
      }
      if (coupon.endTime && currentTime > coupon.endTime) {
        return res.status(400).send({ message: "קופון פג תוקף!" });
      }
      if (coupon.status == 'hide') {
        return res.status(400).send({ message: "קופון לא פעיל!" });
      }
      // קופון הרשמה (מוצר חינם) — אין הנחה כספית; אימות המוצר החינמי נעשה בשלב 7ב
      if (coupon.freeProduct) {
        // ללא שינוי בסכום — הפריט החינמי כבר חושב כ-0 בלולאת הסכום
      } else if (coupon.discountType.type === "fixed" && coupon.discountType.value < serverCalculatedTotal) {
        couponDiscount = coupon.discountType.value;
      } else if (coupon.discountType.type === "percentage") {
        couponDiscount = (coupon.discountType.value / 100) * serverCalculatedTotal;
      }
      console.log('couponDiscount: ', couponDiscount);
      serverCalculatedTotal -= couponDiscount;
    }

    // שלב 7ב: אימות מוצר חינם מקופון הרשמה (מונע ניצול הדגל ללא קופון תקף)
    const freeProductItems = cartItems.filter((item) => item.isCouponFreeProduct);
    if (freeProductItems.length > 0) {
      if (!coupon || !coupon.freeProduct) {
        return res.status(400).send({ message: "מוצר חינם נמצא בעגלה ללא קופון הרשמה תקף." });
      }
      if (freeProductItems.length > 1) {
        return res.status(400).send({ message: "ניתן לממש מוצר חינם אחד בלבד מקופון ההרשמה." });
      }
      const freeItem = freeProductItems[0];
      if (String(freeItem._id) !== String(coupon.freeProduct)) {
        return res.status(400).send({ message: "המוצר החינמי אינו תואם לקופון ההרשמה." });
      }
      if (freeItem.quantity !== 1) {
        return res.status(400).send({ message: "המוצר החינמי מוגבל ליחידה אחת." });
      }
      const customerIdStr = String(req.user._id);
      const alreadyUsed = Array.isArray(coupon.usedBy) &&
        coupon.usedBy.some((id) => String(id) === customerIdStr);
      if (alreadyUsed) {
        return res.status(400).send({ message: "כבר מימשת קופון זה." });
      }
    }

    // שלב 8: חישוב עלות המשלוח
    let shippingCost = 0;
    // זכאות לקופון "לקנייה הבאה": לקוח משלוח שלא הגיע לסף המשלוח החינם (שילם דמי משלוח)
    let shippingRewardEligible = false;
    if (req.body.shippingOption == 2) {  // במידה וזה משלוח
      // קבלת שם העיר - עבור לקוחות אורחים זה ב-req.body.city, עבור לקוחות רשומים זה ב-req.body.user_info.address.city או customer.address.city
      const cityName = req.body.city?.city_name_he || 
                       req.body.user_info?.address?.city?.city_name_he || 
                       customer?.address?.city?.city_name_he;
      
      if (cityName) {
        const deliveryInfo = await Delivery.findOne({
          'city.city_name_he': cityName.trim()
        });
        shippingCost = deliveryInfo ? deliveryInfo.price : 0;
      }

      // משלוח חינם מעל סכום קנייה (אם מופעל בהגדרות החנות)
      // הבסיס הוא סכום המוצרים בלבד אחרי הנחת סף וקופון (serverCalculatedTotal בנקודה זו) — *בלי* דמי משלוח.
      // בהתאמה לצד הלקוח (customCartTotal - thresholdDiscount - discountAmount).
      const storeSetting = await Setting.findOne({ name: "storeSetting" });
      const freeShippingStatus = storeSetting?.setting?.free_shipping_status;
      const freeShippingThreshold = Number(
        storeSetting?.setting?.free_shipping_threshold
      );
      if (
        freeShippingStatus &&
        freeShippingThreshold > 0 &&
        serverCalculatedTotal >= freeShippingThreshold
      ) {
        shippingCost = 0;
      }

      // זכאי לקופון לקנייה הבאה רק כשמנגנון המשלוח החינם פעיל והלקוח לא הגיע לסף (שילם משלוח)
      shippingRewardEligible =
        Boolean(freeShippingStatus) && freeShippingThreshold > 0 && shippingCost > 0;

      serverCalculatedTotal += shippingCost;
    };

    // שלב 9: חילוץ המבצעים למערך "נוצלו מהעגלה" לצורך מעקב אחר מבצעים חד פעמיים
    const usedOfferIds = [];
    itemsWithOffers.forEach(item => {
      // מבצעים על מוצרי פרס
      if (item.isRewardProduct && item.rewardOfferId) {
        const offerIdStr = item.rewardOfferId.toString();
        if (!usedOfferIds.includes(offerIdStr)) {
          usedOfferIds.push(offerIdStr);
        }
      }
      // מבצעים על מוצרים רגילים
      if (item.appliedOffers && Array.isArray(item.appliedOffers)) {
        item.appliedOffers.forEach(offer => {
          if (offer.offerId) {
            const offerIdStr = offer.offerId.toString();
            if (!usedOfferIds.includes(offerIdStr)) {
              usedOfferIds.push(offerIdStr);
            }
          }
        });
      }
    });

    // הוספת מבצעי THRESHOLD_DISCOUNT ל-usedOfferIds
    appliedOffers.forEach(offer => {
      if (offer.type === 'THRESHOLD_DISCOUNT' && offer.offerId) {
        const offerIdStr = offer.offerId.toString();
        if (!usedOfferIds.includes(offerIdStr)) {
          usedOfferIds.push(offerIdStr);
        }
      }
    });

    // שלב 10: אימות הסכום הכולל
    console.log(`FAINL serverCalculatedTotal for user ${req.user.email}: `, serverCalculatedTotal.toFixed(2), 'req.body.total: ', req.body.total.toFixed(2))
    if (Math.abs(serverCalculatedTotal.toFixed(2) - req.body.total.toFixed(2)) > 0.01) {
      console.error("***Server Calculated Total is not match with req.body.total!***");
      return res.status(400).send({ message: "שגיאה! סכום הזמנה לא תואם לסכום הפריטים. מומלץ להתנתק ולהתחבר שוב." });
    }

    // שלב 11: יצירת user_info עבור אורחים (אם לא קיים)
    let userInfo = req.body.user_info;
    // אם user_info לא נשלח מהקליינט, ניצור אותו עבור אורחים
    if (!userInfo) {
      // בדיקה אם זה לקוח אורח (לא רשום)
      const isGuest = (!customer.isRegistered);
      if (isGuest) {
        // יצירת user_info עבור אורח מהמידע ב-req.user, req.body ו-customer
        userInfo = {
          name: req.user.name || req.body.name || "",
          lastName: req.user.lastName || req.body.lastName || "",
          email: req.user.email || req.body.email || "",
          contact: req.user.phone || req.body.phone || "",
          address: {
            city: req.body.city || req.user.address?.city || customer?.address?.city || null,
            street: req.body.street || req.user.address?.street || customer?.address?.street || "",
            houseNumber: req.body.houseNumber || req.user.address?.houseNumber || customer?.address?.houseNumber || "",
            apartmentNumber: req.body.apartmentNumber || req.user.address?.apartmentNumber || customer?.address?.apartmentNumber || "",
            floor: req.body.floor || req.user.address?.floor || customer?.address?.floor || "",
            entryCode: req.body.entryCode || req.user.address?.entryCode || customer?.address?.entryCode || "",
            postalCode: req.body.postalCode || req.user.address?.postalCode || customer?.address?.postalCode || "",
          },
          country: req.body.country || "Israel",
          zipCode: req.body.zipCode || req.body.postalCode || "",
        };
      }
    }

    // שלב 12: יצירת ההזמנה החדשה
    console.log("creating new order...", status._id, req.user._id);

    // מספר ההזמנה מוקצה במונה אטומי (utils/invoiceNumber) ולא כ-"המקסימום + 1":
    // חישוב לפי המקסימום החזיר מספר של הזמנה שנמחקה, ושתי הזמנות מקבילות היו
    // מקבלות את אותו מספר.
    const nextInvoice = await nextFreeInvoice();

    // המרת cart items ל-plain objects כדי להבטיח שכל השדות (כולל מוצרי פרס) יישמרו נכון ב-DB
    const cartForSave = itemsWithOffers.map(item => {
      // אם זה Mongoose document, נמיר אותו ל-plain object
      const plainItem = item.toObject ? item.toObject() : { ...item };
      // וידוא ששדות מוצר פרס נשמרים
      if (item.isRewardProduct) {
        plainItem.isRewardProduct = true;
        plainItem.rewardPrice = item.rewardPrice;
        plainItem.rewardOfferId = item.rewardOfferId;
        plainItem.rewardOfferName = item.rewardOfferName;
        plainItem.rewardOfferType = item.rewardOfferType;
      }
      if (item.isWelcomeGift) {
        plainItem.isWelcomeGift = true;
        if (item.welcomeGiftOfferId) {
          plainItem.welcomeGiftOfferId = item.welcomeGiftOfferId;
        }
      }
      // מוצר חינם מקופון הרשמה — שמירת הדגל לתצוגה נכונה (₪0) בהזמנה/חשבונית
      if (item.isCouponFreeProduct) {
        plainItem.isCouponFreeProduct = true;
        if (item.couponId) plainItem.couponId = item.couponId;
      }
      return plainItem;
    });

    const newOrder = new Order({
      ...req.body,
      cart: cartForSave,
      status: status._id,
      user: req.user._id,
      user_info: userInfo || req.body.user_info,
      subTotal: serverSubTotal.toFixed(2),
      total: serverCalculatedTotal.toFixed(2),
      discount: couponDiscount,
      offerDiscount: thresholdDiscount || 0, // הנחת קניה מעל סכום (THRESHOLD_DISCOUNT)
      shippingCost: shippingCost,
      invoice: nextInvoice,
      usedOfferIds: usedOfferIds, // שמירת המבצעים שנוצלו
      coupon: coupon ? coupon._id : null, // רק קופון שאומת בשלב 7 – לא קופון ישן מ-req.body
      shippingRewardEligible: shippingRewardEligible, // מחושב בשרת — לא סומכים על req.body
      rewardCouponCode: null, // מונפק בסגירת ההזמנה (מונע הזרקה מהקליינט)
      // חנות ללא תשלום: הקליינט שולח "creditCard" תמיד, ואסור לסמוך עליו כאן —
      // הזמנה שלא נסלקה חייבת להיראות ככזו בחשבונית, באדמין ובעמוד ה-/success.
      // ראה utils/paymentDisabled.js
      ...(PAYMENT_DISABLED ? { paymentMethod: NO_PAYMENT_METHOD } : {}),
    });
    const order = await newOrder.save();
    console.log("Order saved successfully:", order._id);

    // סימון מימוש קופון הרשמה (מוצר חינם) — אכיפת "פעם אחת לכל לקוח"
    if (coupon && coupon.freeProduct && freeProductItems.length > 0) {
      coupon.usedBy = Array.isArray(coupon.usedBy) ? coupon.usedBy : [];
      coupon.usedBy.push(req.user._id);
      coupon.timesIsUsed = (coupon.timesIsUsed || 0) + 1;
      await coupon.save();
    }

    // הדפסת שינוי סטטוס ההזמנה
    logStatusChange({
      from: isOrderExist ? 'Pending' : 'No Status',
      to: 'Pending',
      functionName: 'addOrder',
      order: order,
    });

    // שלב 13: שליחת בקשת תשלום ל-Cardcom
    // יצירת טוקן גישה להזמנה (למקרה של אורחים)
    const orderToken = tokenForOrder(order._id.toString());

    // חנות ללא תשלום: אין סליקה כלל. ההזמנה נסגרת כאן ועכשיו — בדיוק באותם
    // צעדים שה-webhook של קארדקום היה מבצע אחרי תשלום מוצלח (מלאי, קופון,
    // מבצעים, מייל) — והלקוח מופנה ישירות לעמוד התודה.
    // ראה utils/paymentDisabled.js ו-lib/orders/finalizeOrder.js
    if (PAYMENT_DISABLED) {
      // populate על status ו-coupon: finalizeOrder קורא את שם הסטטוס הקודם
      // ליומן, ואת הקופון כדי לסמן אותו כמנוצל.
      const orderToFinalize = await Order.findById(order._id)
        .populate("coupon")
        .populate("status");

      try {
        await finalizeOrder(orderToFinalize, {
          cardInfo: null,
          functionName: "addOrder (PAYMENT_DISABLED)",
        });
      } catch (finalizeError) {
        /*
         * הסגירה נכשלה אחרי שההזמנה כבר נשמרה. שתי החלטות כאן, ושתיהן
         * מכוונות למנוע אובדן הזמנה:
         *
         * 1. לא מחזירים שגיאה ללקוח. ההזמנה *נשמרה* — בדיוק מה שהכפתור הבטיח.
         *    שגיאה הייתה שולחת אותו להזמין שוב ויוצרת כפילות.
         * 2. מקדמים את ההזמנה ל-Processing בכתיבה ישירה. הזמנה שנשארת
         *    ב-Pending היא "טיוטה" מבחינת שלב 2, והזמנה עתידית של אותו לקוח
         *    הייתה מוחקת אותה בשקט.
         *
         * מה שנכשל (מלאי / קופון / תעודת משלוח / מייל) נשאר לא-בוצע ודורש
         * בדיקה ידנית — ולכן ההתראה, ולא console.log בלבד.
         */
        console.error("addOrder finalize failed: ", finalizeError);

        try {
          const processingStatus = await Status.findOne({ name: "Processing" });
          if (processingStatus) {
            await Order.updateOne(
              { _id: order._id },
              { $set: { status: processingStatus._id } }
            );
          }
        } catch (statusError) {
          console.error("addOrder finalize fallback status failed: ", statusError);
        }

        sendEmailSilent({
          from: `"${process.env.COMPANY_NAME || "Store"}" <${process.env.EMAIL_USER}>`,
          to: ADD_ORDER_ERROR_ALERT_EMAIL,
          subject: `[addOrder] סגירת הזמנה ${order.invoice} נכשלה — נדרשת בדיקה ידנית`,
          text: [
            `זמן: ${new Date().toISOString()}`,
            `הזמנה: ${order.invoice} (${order._id})`,
            `לקוח: ${req.user?.email || req.body?.email || ""}`,
            "",
            "ההזמנה נשמרה והועברה ל-Processing, אבל שלבי הסגירה נכשלו.",
            "יש לוודא ידנית: הורדת מלאי, סימון קופון/מבצעים, תעודת משלוח, מייל ללקוח.",
            "",
            `הודעה: ${finalizeError.message}`,
            "",
            "Stack:",
            finalizeError.stack || "(אין stack)",
          ].join("\n"),
        }).catch((mailErr) =>
          console.log("addOrder finalize alert email failed: ", mailErr.message)
        );
      }

      return res.status(201).send({
        orderId: order._id,
        orderToken,
        paymentDisabled: true,
      });
    }
    
    const cardcomObj = {
      TerminalNumber: process.env.CARDCOM_TERMINAL_NUMBER,
      ApiName: process.env.CARDCOM_API_NAME,
      ReturnValue: order._id,
      Amount: serverCalculatedTotal,
      SuccessRedirectUrl: process.env.STORE_URL + "/success" + `?orderId=${order._id}&token=${orderToken}`,
      FailedRedirectUrl: process.env.STORE_URL + "/failed" + `?orderId=${order._id}&token=${orderToken}`,
      WebHookUrl: process.env.API_BASE_URL + "/orders/" + order._id + `?key=${process.env.CARDCOM_KEY}&secret=${process.env.CARDCOM_SECRET}`,
      // אפשרות תשלומים: הלקוח יכול לבחור בדף התשלום של Cardcom בין 1 למספר התשלומים המרבי (ברירת מחדל 3), לכל סכום.
      // MinNumOfPayments=1 מאפשר גם תשלום בודד; MaxNumOfPayments קובע את מספר התשלומים המרבי בתפריט הבחירה.
      AdvancedDefinition: {
        MinNumOfPayments: 1,
        MaxNumOfPayments: Number(process.env.CARDCOM_MAX_PAYMENTS) || 3,
      },
      Document: {
        Name: req.user?.name + " " + req.user?.lastName || "",
        Mobile: req.user?.phone || "",
        To: req.user.name,
        Email: req.user.email,

        AddressLine1: (req.body.city?.city_name_he || req.body.user_info?.address?.city?.city_name_he || customer?.address?.city?.city_name_he || '').trim() + ", " + ((req.body.street || req.body.user_info?.address?.street || customer?.address?.street) ? `${req.body.street || req.body.user_info?.address?.street || customer?.address?.street} ${req.body.houseNumber || req.body.user_info?.address?.houseNumber || customer?.address?.houseNumber || ""}`.trim() : ""),

        AddressLine2: ((req.body.apartmentNumber || req.body.user_info?.address?.apartmentNumber || customer?.address?.apartmentNumber) ? ` דירה ${req.body.apartmentNumber || req.body.user_info?.address?.apartmentNumber || customer?.address?.apartmentNumber}` : "") + ((req.body.floor || req.body.user_info?.address?.floor || customer?.address?.floor) ? ` קומה ${req.body.floor || req.body.user_info?.address?.floor || customer?.address?.floor}` : "") + ((req.body.entryCode || req.body.user_info?.address?.entryCode || customer?.address?.entryCode) ? ` (קוד כניסה ${req.body.entryCode || req.body.user_info?.address?.entryCode || customer?.address?.entryCode})` : ""),
        // City: customer?.address?.city?.city_name_he || "",

        Comments: `${order.customer_note ? "הערות לקוח: " + order.customer_note?.trim()?.slice(0, 200) : ""}

מספר הזמנה: ${order.invoice}`,
        Products: [...itemsWithOffers.map(p => {
          // חישוב מחיר ליחידה ומחיר כולל
          let unitCost, totalLineCost;

          if (p.isCouponFreeProduct) {
            // מוצר חינם מקופון הרשמה — ללא עלות
            unitCost = 0;
            totalLineCost = 0;
          } else if (p.isRewardProduct) {
            // מוצר פרס
            unitCost = p.rewardPrice || 0;
            totalLineCost = (p.rewardPrice || 0) * p.quantity;
          } else if (p.discountedPrice) {
            // מוצר עם מבצע
            unitCost = p.discountedPrice / p.quantity;
            totalLineCost = p.discountedPrice;
          } else {
            // מוצר רגיל
            unitCost = p.prices?.price || 0;
            totalLineCost = (p.prices?.price || 0) * p.quantity;
          }

          // חישוב תיאור המוצר - עבור מוצרי פרס נשתמש ב-rewardOfferName אם title לא קיים
          let description = 'מוצר';
          if (p.isCouponFreeProduct) {
            const title = p.title || p._doc?.title;
            description = (title?.he || title || 'מוצר') + " (מתנה)";
          } else if (p.isRewardProduct) {
            // גישה ל-title גם אם זה Mongoose Document
            const title = p.title || p._doc?.title;
            description = title?.he || title;
            description += " (" + (p.rewardOfferName?.he || p.rewardOfferName?.he || p.rewardOfferName || 'מוצר מתנה') + ")";
          } else {
            const title = p.title || p._doc?.title;
            description = title?.he || title || 'מוצר';
          }

          return {
            Description: description,
            Quantity: p.quantity,
            UnitCost: unitCost,
            TotalLineCost: totalLineCost,
            IsVatFree: p.isVatFree !== undefined ? p.isVatFree : true,
          }
        }),
        shippingCost > 0 ? {
          Description: "משלוח ל" + (req.body.city?.city_name_he || req.body.user_info?.address?.city?.city_name_he || customer?.address?.city?.city_name_he || '') + ", " + (req.body.street || req.body.user_info?.address?.street || customer?.address?.street || '') + " " + (req.body.houseNumber || req.body.user_info?.address?.houseNumber || customer?.address?.houseNumber || '') + ((req.body.apartmentNumber || req.body.user_info?.address?.apartmentNumber || customer?.address?.apartmentNumber) ? "/" + (req.body.apartmentNumber || req.body.user_info?.address?.apartmentNumber || customer?.address?.apartmentNumber) : ''),
          UnitCost: shippingCost,
          IsVatFree: false,
        } : null,
        couponDiscount > 0 ? {
          Description: coupon.discountType.type === "percentage" ? `הנחה ${coupon.discountType.value}%` : "הנחה",
          UnitCost: -couponDiscount,
          IsVatFree: true,
        } : null,
        thresholdDiscount > 0 ? {
          Description: (() => {
            const thresholdOffer = appliedOffers.find(o => o.type === 'THRESHOLD_DISCOUNT');
            if (thresholdOffer) {
              const offerName = thresholdOffer.name?.he || thresholdOffer.name?.en || 'הנחת קניה מעל סכום';
              return offerName;
            }
            return 'הנחת קניה מעל סכום';
          })(),
          UnitCost: -thresholdDiscount,
          IsVatFree: true,
        } : null,
        ].filter(Boolean),

        // יצירת/עידכון לקוח בקארדקום
        AdvancedDefinition: {
          IsAutoCreateUpdateAccount: true,            // <-- זה העיקר
          SiteUniqueId: customer?.email || req.user?.email,
        }
      }
    };

    const response = await fetch('https://secure.cardcom.solutions/api/v11/LowProfile/Create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cardcomObj),
    });

    if (!response.ok) {
      throw new Error('Failed to create Cardcom payment.');
    }

    const result = await response.json();
    const paymentUrl = result.Url;
    console.log('paymentUrl: ', paymentUrl);

    // שלב 14: החזרת קישור התשלום לקליינט
    res.status(201).send({ paymentUrl });
  } catch (err) {
    console.log('addOrder error: ', err);
    const userEmail = req.user?.email || req.body?.email || "";
    const userId = req.user?._id?.toString() || "";
    let bodySnippet = "";
    try {
      bodySnippet = JSON.stringify(req.body, null, 2);
      if (bodySnippet.length > 12000) {
        bodySnippet = `${bodySnippet.slice(0, 12000)}\n…[חתוך]`;
      }
    } catch {
      bodySnippet = "[לא ניתן להמיר את גוף הבקשה ל-JSON]";
    }
    const textBody = [
      `זמן: ${new Date().toISOString()}`,
      `פונקציה: addOrder`,
      `משתמש (_id): ${userId}`,
      `אימייל לקוח: ${userEmail}`,
      "",
      `הודעה: ${err.message}`,
      "",
      "Stack:",
      err.stack || "(אין stack)",
      "",
      "req.body:",
      bodySnippet,
    ].join("\n");

    sendEmailSilent({
      from: `"${process.env.COMPANY_NAME || "Store"}" <${process.env.EMAIL_USER}>`,
      to: ADD_ORDER_ERROR_ALERT_EMAIL,
      subject: `[addOrder] שגיאה: ${String(err.message).slice(0, 120)}`,
      text: textBody,
    }).catch((mailErr) =>
      console.log("addOrder alert email failed: ", mailErr.message)
    );

    res.status(500).send({ message: err.message });
  }
};

// get all orders user
const getOrderCustomer = async (req, res) => {
  try {
    const { page, limit } = req.query;

    const pages = Number(page) || 1;
    const limits = Number(limit) || 8;
    const skip = (pages - 1) * limits;

    // מציאת המזהים של הסטטוסים
    const pendingStatus = await Status.findOne({ name: "Pending" });

    const processingStatus = await Status.findOne({ name: "Processing" });
    const likutStatus = await Status.findOne({ name: "Likut" });

    const deliveredStatus = await Status.findOne({ name: "Delivered" });
    // מציאת סטטוסי מלקטים (סטטוסים עם מספר טלפון)
    const melaketStatuses = await Status.find({ phone: { $exists: true } });
    // המזהים של הסטטוסי מלקטים
    const melaketStatusIds = melaketStatuses.map(status => status._id);

    if (!pendingStatus || !processingStatus || !deliveredStatus) {
      return res.status(400).send({ message: "Statuses not found" });
    }

    const totalDoc = await Order.countDocuments({
      user: req.user._id,
    });

    const totalPendingOrder = await Order.aggregate([
      {
        $match: {
          status: pendingStatus._id,
          user: req.user._id,
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$total" },
          count: { $sum: 1 },
        },
      },
    ]);

    const totalProcessingOrder = await Order.aggregate([
      {
        $match: {
          status: { $in: [processingStatus._id, likutStatus._id] },
          user: req.user._id,
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$total" },
          count: { $sum: 1 },
        },
      },
    ]);

    const totalDeliveredOrder = await Order.aggregate([
      {
        $match: {
          status: { $in: [deliveredStatus._id, ...melaketStatusIds] },
          user: req.user._id,
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$total" },
          count: { $sum: 1 },
        },
      },
    ]);

    // ── מיון לפי createdAt ולא לפי _id ──
    //
    // השניים זהים לכל הזמנה שנוצרה בזמן אמת (חותמת הזמן טבועה ב-ObjectId),
    // אבל **לא** להזמנת ארכיון: היא נוצרת היום ונושאת את תאריך המסמך
    // מלפני שנתיים. מיון לפי _id היה מקפיץ ייבוא היסטוריה לראש רשימת
    // ההזמנות של הלקוח, מעל ההזמנות האחרונות שלו.
    const orders = await Order.find({
      user: req.user._id,
    })
      .select(CUSTOMER_HIDDEN_FIELDS)
      .populate({ path: 'status' })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limits);

    res.send({
      orders,
      limits,
      pages,
      pending: totalPendingOrder.length === 0 ? 0 : totalPendingOrder[0].count,
      processing: totalProcessingOrder.length === 0 ? 0 : totalProcessingOrder[0].count,
      delivered: totalDeliveredOrder.length === 0 ? 0 : totalDeliveredOrder[0].count,
      totalDoc,
    });
  } catch (err) {
    console.log('getOrderCustomer error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const getOrderById = async (req, res) => {
  try {
    let order;
    
    // אם יש טוקן גישה - מאפשר גישה גם לאורחים
    if (req.orderToken && req.orderToken.isValid) {
      // בדיקה שהטוקן תואם ל-orderId
      if (req.orderToken.orderId.toString() !== req.params.id.toString()) {
        return res.status(401).send({
          message: "הקישור לא תקין או שפג תוקפו.",
        });
      }
      
      // חיפוש ההזמנה לפי ID בלבד (ללא בדיקת user)
      order = await Order.findById(req.params.id)
        .select(CUSTOMER_HIDDEN_FIELDS)
        .populate({ path: "status" });
    } else if (req.user && req.user._id) {
      // משתמש מחובר - בדיקה רגילה
      order = await Order.findOne({
        _id: req.params.id,
        user: req.user._id
      })
        .select(CUSTOMER_HIDDEN_FIELDS)
        .populate({ path: "status" });
    } else {
      // אין טוקן ואין משתמש מחובר
      return res.status(401).send({
        message: "הקישור לא תקין או שפג תוקפו.",
      });
    }

    if (!order) {
      return res.status(404).send({
        message: "ההזמנה לא נמצאה",
      });
    }

    res.send(order);
  } catch (err) {
    console.log('getOrderById error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

module.exports = {
  addOrder,
  getOrderById,
  getOrderCustomer,
};
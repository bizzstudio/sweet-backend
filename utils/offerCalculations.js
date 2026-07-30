// utils/offerCalculations.js
// פונקציות עזר טהורות לחישוב מבצעים על עגלת קניות

const shouldSkipOfferCalculation = (item) =>
    Boolean(item?.isRewardProduct || item?.isWelcomeGift || item?.isCouponFreeProduct);

/** מוצרי מתנה של מבצע — rewardProducts או rewardProduct בודד */
const getOfferRewardProducts = (offer) => {
    if (Array.isArray(offer?.rewardProducts) && offer.rewardProducts.length > 0) {
        return offer.rewardProducts;
    }
    if (offer?.rewardProduct) {
        return [offer.rewardProduct];
    }
    return [];
};

/** מוצר מתנה שנבחר כבר בעגלה למבצע */
const getSelectedRewardForOffer = (offer, allCartItems = []) => {
    const offerIdStr = offer._id?.toString?.() ?? String(offer._id);
    return allCartItems.find(
        (item) =>
            item.isRewardProduct &&
            (item.rewardOfferId?.toString?.() ?? String(item.rewardOfferId)) === offerIdStr
    ) || null;
};

const offerResultApplied = (result) =>
    (result?.discount || 0) > 0 || Boolean(result?.requiresCustomerChoice);

/**
 * חישוב סכום כולל של עגלה (ללא מבצעים)
 * @param {Array} cartItems - פריטי העגלה
 * @param {Boolean} excludeRewards - האם להתעלם ממוצרי פרס בחישוב
 * @returns {Number} - סכום כולל
 */
const calculateCartTotal = (cartItems, excludeRewards = false) => {
    return cartItems.reduce((total, item) => {
        // אם צריך להתעלם ממוצרי פרס
        if (excludeRewards && shouldSkipOfferCalculation(item)) {
            return total;
        }
        return total + (item.prices?.price * item.quantity);
    }, 0);
};

/**
 * יצירת מפה של מוצרים לפי _id (לא כולל מוצרי פרס)
 * @param {Array} cartItems - פריטי העגלה
 * @returns {Object} - { productId: quantity }
 */
const createProductCountMap = (cartItems) => {
    const productCount = {};
    cartItems.forEach(item => {
        // לא כוללים מוצרי פרס בספירה
        if (shouldSkipOfferCalculation(item)) return;

        // המרת _id ל-string כדי להבטיח השוואה נכונה
        const pid = item._id?.toString?.() ?? String(item._id);
        if (!productCount[pid]) {
            productCount[pid] = 0;
        }
        productCount[pid] += item.quantity;
    });
    return productCount;
};

/**
 * יישום מבצע BUNDLE_PRICE
 * @param {Array} cartItems - פריטי העגלה (ללא מוצרי פרס)
 * @param {Object} offer - המבצע
 * @returns {Object} - { discount, affectedItems: [{itemId, quantityInOffer, unitPriceInOffer}] }
 */
const applyBundlePrice = (cartItems, offer) => {
    if (!offer?.products || offer?.products?.length === 0) {
        return { discount: 0, affectedItems: [] };
    }

    // המרת כל ה-IDs ל-strings כדי להבטיח השוואה נכונה
    const offerProductIds = offer.products.map(p => p._id?.toString?.() ?? String(p._id));
    const productCount = createProductCountMap(cartItems);

    // חישוב כמות כללית בעגלה שנכנסת למבצע
    let totalApplicableQuantity = 0;
    offerProductIds.forEach(id => {
        if (productCount[id]) {
            totalApplicableQuantity += productCount[id];
        }
    });

    // כמות הפעמים שהמבצע יכול לחול (מעגל ללמטה)
    const timesOfferCanApply = Math.floor(totalApplicableQuantity / offer.quantity);

    if (timesOfferCanApply === 0) {
        return { discount: 0, affectedItems: [] };
    }

    const offerUnitPrice = offer.price / offer.quantity;
    let remainingQuantityToApply = timesOfferCanApply * offer.quantity;
    const affectedItems = [];
    let totalDiscount = 0;

    // חישוב ההנחה והפריטים המושפעים
    cartItems.forEach(item => {
        if (shouldSkipOfferCalculation(item)) return;

        // המרת item._id ל-string להשוואה
        const itemIdStr = item._id?.toString?.() ?? String(item._id);
        if (offerProductIds.includes(itemIdStr) && remainingQuantityToApply > 0) {
            const discountQuantity = Math.min(item.quantity, remainingQuantityToApply);
            remainingQuantityToApply -= discountQuantity;

            const originalPrice = item.prices?.price * discountQuantity;
            const discountedPrice = discountQuantity * offerUnitPrice;
            const itemDiscount = originalPrice - discountedPrice;

            totalDiscount += itemDiscount;

            affectedItems.push({
                itemId: item.id,
                productId: item._id,
                quantityInOffer: discountQuantity,
                unitPriceInOffer: offerUnitPrice,
                discount: itemDiscount,
                offerId: offer._id
            });
        }
    });

    return {
        discount: totalDiscount,
        affectedItems,
        timesApplied: timesOfferCanApply
    };
};

/**
 * יישום מבצע BUY_X_GET_Y
 * @param {Array} cartItems - פריטי העגלה
 * @param {Object} offer - המבצע
 * @returns {Object} - { discount, rewardItemsToAdd: [{product, quantity, price, offerId, offerName}] }
 */
const applyBuyXGetY = (cartItems, offer, allCartItems = cartItems) => {
    if (!offer?.triggerProduct) {
        return { discount: 0, rewardItemsToAdd: [] };
    }

    const rewardProducts = getOfferRewardProducts(offer);
    if (rewardProducts.length === 0) {
        return { discount: 0, rewardItemsToAdd: [] };
    }

    const triggerProductId = (offer.triggerProduct._id ?? offer.triggerProduct)?.toString?.() ??
        String(offer.triggerProduct._id ?? offer.triggerProduct);
    const productCount = createProductCountMap(cartItems);

    // כמות המוצר הטריגר בעגלה (לא כולל מוצרי פרס)
    const triggerQuantityInCart = productCount[triggerProductId] || 0;

    // כמות הפעמים שהמבצע יכול לחול
    const timesOfferCanApply = Math.floor(triggerQuantityInCart / offer.triggerQuantity);

    if (timesOfferCanApply === 0) {
        return { discount: 0, rewardItemsToAdd: [] };
    }

    // כמות יחידות פרס שהלקוח זכאי להן
    const totalRewardQuantity = timesOfferCanApply * (offer.rewardQuantity || 1);

    // חישוב הנחה
    const rewardUnitPrice = offer.rewardPrice || 0;
    const existingReward = getSelectedRewardForOffer(offer, allCartItems);

    if (rewardProducts.length > 1 && !existingReward) {
        return {
            discount: 0,
            rewardItemsToAdd: [],
            timesApplied: timesOfferCanApply,
            requiresCustomerChoice: true,
        };
    }

    const rewardProduct = existingReward || rewardProducts[0];
    const originalRewardPrice = rewardProduct.prices?.price || 0;
    const discountPerUnit = originalRewardPrice - rewardUnitPrice;
    const totalDiscount = totalRewardQuantity * discountPerUnit;

    return {
        discount: totalDiscount,
        rewardItemsToAdd: existingReward ? [] : [{
            product: rewardProducts[0],
            quantity: totalRewardQuantity,
            price: rewardUnitPrice,
            offerId: offer._id,
            offerName: offer.name || {},
            offerType: 'BUY_X_GET_Y'
        }],
        timesApplied: timesOfferCanApply
    };
};

/**
 * יישום מבצע THRESHOLD_GET_ITEM
 * @param {Object} offer - המבצע
 * @param {Number} currentTotal - סכום העגלה הנוכחי (אחרי מבצעים אחרים)
 * @returns {Object} - { discount, rewardItemsToAdd: [{product, quantity, price, offerId, offerName}] }
 */
const applyThresholdGetItem = (offer, currentTotal, allCartItems = []) => {
    const rewardProducts = getOfferRewardProducts(offer);
    if (rewardProducts.length === 0 || !offer?.thresholdAmount) {
        return { discount: 0, rewardItemsToAdd: [] };
    }

    // בדיקה אם עברנו את הסף
    if (currentTotal < offer.thresholdAmount) {
        return { discount: 0, rewardItemsToAdd: [] };
    }

    // המבצע חל פעם אחת בלבד
    const rewardQuantity = offer.rewardQuantity || 1;
    const rewardUnitPrice = offer.rewardPrice || 0;
    const existingReward = getSelectedRewardForOffer(offer, allCartItems);

    if (rewardProducts.length > 1 && !existingReward) {
        return {
            discount: 0,
            rewardItemsToAdd: [],
            timesApplied: 1,
            requiresCustomerChoice: true,
        };
    }

    const rewardProduct = existingReward || rewardProducts[0];
    const originalRewardPrice = rewardProduct.prices?.price || 0;
    const discountPerUnit = originalRewardPrice - rewardUnitPrice;
    const totalDiscount = rewardQuantity * discountPerUnit;

    return {
        discount: totalDiscount,
        rewardItemsToAdd: existingReward ? [] : [{
            product: rewardProducts[0],
            quantity: rewardQuantity,
            price: rewardUnitPrice,
            offerId: offer._id,
            offerName: offer.name || {},
            offerType: 'THRESHOLD_GET_ITEM'
        }],
        timesApplied: 1
    };
};

/**
 * יישום מבצע THRESHOLD_DISCOUNT
 * קנה מעל סכום X וקבל הנחה באחוזים או סכום קבוע
 * @param {Object} offer - המבצע
 * @param {Number} currentTotal - סכום העגלה הנוכחי (אחרי מבצעים אחרים)
 * @returns {Object} - { discount, discountType, discountValue }
 */
const applyThresholdDiscount = (offer, currentTotal) => {
    if (!offer?.thresholdAmount || !offer?.discountType || offer?.discountValue === undefined) {
        return { discount: 0 };
    }

    // בדיקה אם עברנו את הסף
    if (currentTotal < offer.thresholdAmount) {
        return { discount: 0 };
    }

    let discount = 0;

    if (offer.discountType === 'percentage') {
        // הנחה באחוזים מהסכום הכולל
        discount = currentTotal * (offer.discountValue / 100);
    } else if (offer.discountType === 'fixed') {
        // הנחה בסכום קבוע
        discount = offer.discountValue;
    }

    // וידוא שההנחה לא גדולה מהסכום הכולל
    discount = Math.min(discount, currentTotal);

    return {
        discount,
        discountType: offer.discountType,
        discountValue: offer.discountValue,
        timesApplied: 1
    };
};

/**
 * מיזוג מוצרי פרס - איחוד של מוצרים זהים מאותו מבצע
 * @param {Array} rewardItems - רשימת מוצרי פרס להוספה
 * @returns {Array} - רשימה ממוזגת
 */
const mergeRewardItems = (rewardItems) => {
    const merged = {};

    rewardItems.forEach(reward => {
        // המרת IDs ל-strings ליצירת מפתח עקבי
        const productIdStr = reward.product._id?.toString?.() ?? String(reward.product._id);
        const offerIdStr = reward.offerId?.toString?.() ?? String(reward.offerId);
        const key = `${productIdStr}_${offerIdStr}`;

        if (!merged[key]) {
            merged[key] = { ...reward };
        } else {
            merged[key].quantity += reward.quantity;
            merged[key].discount = (merged[key].discount || 0) + (reward.discount || 0);
        }
    });

    return Object.values(merged);
};

/**
 * יצירת פריטי עגלה מעודכנים עם מבצעים מיושמים
 * @param {Array} originalCartItems - פריטי עגלה מקוריים
 * @param {Array} bundleResults - תוצאות BUNDLE_PRICE
 * @param {Array} rewardItems - מוצרי פרס להוסיף/לעדכן
 * @returns {Array} - פריטי עגלה מעודכנים שמכילים:
 *  [{discountedPrice, offerTitle, appliedOffers: [{type, name, quantityInOffer, unitPrice}]}]
 */
const createUpdatedCartItems = (originalCartItems, bundleResults, rewardItems) => {
    // מפה של הנחות לפי itemId
    const discountMap = {};
    const offerTitleMap = {};

    // עדכון מפה של הנחות לפי itemId
    bundleResults.forEach(result => {
        result.affectedItems.forEach(affected => {
            if (!discountMap[affected.itemId]) {
                discountMap[affected.itemId] = {
                    quantityInOffer: 0,
                    unitPriceInOffer: affected.unitPriceInOffer,
                    offerName: result.offerName || result.offer?.name,
                    offerId: affected.offerId || result.offer?._id
                };
            }
            discountMap[affected.itemId].quantityInOffer += affected.quantityInOffer;
            offerTitleMap[affected.itemId] = result.offerName || result.offer?.name;
        });
    });

    // עדכון פריטים קיימים
    const updatedItems = originalCartItems.map(item => {
        if (shouldSkipOfferCalculation(item)) {
            return item;
        }

        const discount = discountMap[item.id];
        if (discount) {
            const discountQuantity = discount.quantityInOffer;
            const nonDiscountQuantity = item.quantity - discountQuantity;
            const discountedPrice =
                discountQuantity * discount.unitPriceInOffer +
                nonDiscountQuantity * item.prices?.price;

            const offerName = offerTitleMap[item.id] || {};
            return {
                ...item,
                discountedPrice,
                offerTitle: offerName,
                appliedOffers: [{
                    type: 'BUNDLE_PRICE',
                    name: offerName,
                    offerId: discount.offerId,
                    quantityInOffer: discountQuantity,
                    unitPrice: discount.unitPriceInOffer,
                    regularQuantity: nonDiscountQuantity,
                    regularUnitPrice: item.prices?.price
                }]
            };
        }

        return {
            ...item,
            discountedPrice: null,
            offerTitle: '',
            appliedOffers: []
        };
    });

    // הוספה/עדכון מוצרי פרס
    const rewardItemsMap = {};
    rewardItems.forEach(reward => {
        // המרת IDs ל-strings ליצירת מפתח עקבי
        const productIdStr = reward.product._id?.toString?.() ?? String(reward.product._id);
        const offerIdStr = reward.offerId?.toString?.() ?? String(reward.offerId);
        const key = `${productIdStr}_${offerIdStr}`;
        if (!rewardItemsMap[key]) {
            rewardItemsMap[key] = { ...reward };
        } else {
            rewardItemsMap[key].quantity += reward.quantity;
        }
    });

    // בדיקה אילו מוצרי פרס כבר קיימים בעגלה
    const existingRewardItems = updatedItems.filter(item => item.isRewardProduct);
    const rewardItemsToProcess = Object.values(rewardItemsMap);

    rewardItemsToProcess.forEach(reward => {
        // המרת כל ה-IDs ל-strings להשוואה נכונה
        const rewardProductIdStr = reward.product._id?.toString?.() ?? String(reward.product._id);
        const rewardOfferIdStr = reward.offerId?.toString?.() ?? String(reward.offerId);

        const existingItem = existingRewardItems.find(
            item => {
                const itemIdStr = item._id?.toString?.() ?? String(item._id);
                const itemOfferIdStr = item.rewardOfferId?.toString?.() ?? String(item.rewardOfferId);
                return itemIdStr === rewardProductIdStr && itemOfferIdStr === rewardOfferIdStr;
            }
        );

        if (existingItem) {
            // עדכון כמות של מוצר פרס קיים
            const itemIndex = updatedItems.findIndex(i => i.id === existingItem.id);
            if (itemIndex !== -1) {
                updatedItems[itemIndex] = {
                    ...updatedItems[itemIndex],
                    quantity: reward.quantity,
                    rewardPrice: reward.price,
                    rewardOfferName: reward.offerName,
                    rewardOfferType: reward.offerType
                };
            }
        } else {
            // הוספת מוצר פרס חדש (רק אם rewardPrice = 0, כלומר מתנה)
            if (reward.price === 0) {
                // יצירת id ייחודי לכל מבצע (אפילו אם אותו מוצר)
                // המרת IDs ל-strings ליצירת מפתח עקבי
                const productIdStr = reward.product._id?.toString?.() ?? String(reward.product._id);
                const offerIdStr = reward.offerId?.toString?.() ?? String(reward.offerId);
                const rewardItemId = `reward_${productIdStr}_${offerIdStr}`;
                // המרת reward.product ל-plain object (חשוב! אחרת שדות לא יישמרו ב-DB)
                const plainProduct = reward.product.toObject ? reward.product.toObject() : { ...reward.product };
                const newRewardItem = {
                    ...plainProduct,
                    id: rewardItemId,
                    quantity: reward.quantity,
                    isRewardProduct: true,
                    rewardPrice: reward.price,
                    rewardOfferId: reward.offerId,
                    rewardOfferName: reward.offerName,
                    rewardOfferType: reward.offerType
                };
                updatedItems.push(newRewardItem);
            } else {
                // אם זה לא מתנה (price > 0), נבדוק אם המוצר קיים בעגלה ונעדכן אותו
                // רק אם המשתמש כבר הוסיף את המוצר הזה לעגלה
                const rewardProductIdStr = reward.product._id?.toString?.() ?? String(reward.product._id);
                const regularItem = updatedItems.find(
                    item => {
                        const itemIdStr = item._id?.toString?.() ?? String(item._id);
                        return itemIdStr === rewardProductIdStr && !item.isRewardProduct;
                    }
                );

                if (regularItem) {
                    const itemIndex = updatedItems.findIndex(i => i.id === regularItem.id);
                    if (itemIndex !== -1) {
                        // חישוב מחיר מעורב: חלק במחיר מבצע, חלק במחיר רגיל
                        const rewardQty = Math.min(reward.quantity, regularItem.quantity);
                        const regularQty = regularItem.quantity - rewardQty;

                        // אם יש כבר discountedPrice (ממבצע BUNDLE_PRICE), נשתמש בו
                        const existingDiscountedPrice = updatedItems[itemIndex].discountedPrice;
                        const baseUnitPrice = existingDiscountedPrice ?
                            existingDiscountedPrice / regularItem.quantity :
                            regularItem.prices?.price;

                        const mixedPrice =
                            rewardQty * reward.price +
                            regularQty * baseUnitPrice;

                        // חישוב regularQuantity ו-regularUnitPrice עבור המבצע החדש
                        // אם יש כבר מבצע קודם, נצטרך לחשב מחדש את הפירוט
                        const existingOffers = updatedItems[itemIndex].appliedOffers || [];
                        let totalQuantityInOffers = existingOffers.reduce((sum, offer) =>
                            sum + (offer.quantityInOffer || 0), 0);

                        // הכמות במחיר רגיל = סך הכל - כל הכמויות במבצעים
                        const finalRegularQuantity = regularItem.quantity - totalQuantityInOffers - rewardQty;

                        updatedItems[itemIndex] = {
                            ...updatedItems[itemIndex],
                            discountedPrice: mixedPrice,
                            offerTitle: reward.offerName || updatedItems[itemIndex].offerTitle,
                            appliedOffers: [
                                ...existingOffers,
                                {
                                    type: reward.offerType,
                                    name: reward.offerName,
                                    offerId: reward.offerId,
                                    quantityInOffer: rewardQty,
                                    unitPrice: reward.price,
                                    regularQuantity: finalRegularQuantity,
                                    regularUnitPrice: baseUnitPrice
                                }
                            ]
                        };
                    }
                }
                // אם המוצר לא קיים בעגלה ו-price > 0, לא עושים כלום
                // (רק מוצרי מתנה מתווספים אוטומטית)
            }
        }
    });    
    return updatedItems;
};
    
const emptyCartWithClearedOffers = (cartItems) => ({
    updatedCartItems: cartItems.map(item => ({
        ...item,
        discountedPrice: null,
        offerTitle: '',  
        appliedOffers: []
    })),
    totalDiscount: 0,
    appliedOffers: [],   
    thresholdDiscount: 0,
    bundleResults: [],
    buyXGetYResults: [],
    thresholdResults: [],
    thresholdDiscountResults: []
});

/**
 * אלגוריתם פנימי: THRESHOLD_GET_ITEM על סכום קטלוג לפני חבילות, אחר כך BUNDLE + BUY_X,
 * סכום ביניים ל-THRESHOLD_DISCOUNT בלי פרסי סף בעגלה הביניים.
 */
const findOptimalOfferCombinationInternal = (cartItems, offers = []) => {
    if (!Array.isArray(offers) || offers.length === 0 || cartItems.length === 0) {
        return emptyCartWithClearedOffers(cartItems);
    }

    const bundleOffers = offers.filter(o => o.type === 'BUNDLE_PRICE');
    const buyXGetYOffers = offers.filter(o => o.type === 'BUY_X_GET_Y');
    const thresholdOffers = offers.filter(o => o.type === 'THRESHOLD_GET_ITEM');
    const thresholdDiscountOffers = offers.filter(o => o.type === 'THRESHOLD_DISCOUNT');

    const baseCartItems = cartItems.filter(item => !shouldSkipOfferCalculation(item));
    const catalogTotal = calculateCartTotal(baseCartItems, true);

    const sortedThresholdOffers = [...thresholdOffers].sort((a, b) =>
        (b.thresholdAmount || 0) - (a.thresholdAmount || 0)
    );

    let thresholdResults = [];
    let thresholdRewardEarly = [];
    for (const offer of sortedThresholdOffers) {
        const result = {
            offer,
            offerName: offer.name || {},
            ...applyThresholdGetItem(offer, catalogTotal, cartItems)
        };
        if (result.discount > 0 || result.requiresCustomerChoice) {
            thresholdResults = [result];
            thresholdRewardEarly = result.rewardItemsToAdd || [];
            break;
        }
    }

    const bundleResults = bundleOffers.map(offer => ({
        offer,
        offerName: offer.name || {},
        ...applyBundlePrice(baseCartItems, offer)
    })).filter(result => offerResultApplied(result));

    const buyXGetYResults = buyXGetYOffers.map(offer => ({
        offer,
        offerName: offer.name || {},
        ...applyBuyXGetY(baseCartItems, offer, cartItems)
    })).filter(result => offerResultApplied(result));

    let buyXRewardItems = [];
    buyXGetYResults.forEach(result => {
        if (result.rewardItemsToAdd) {
            buyXRewardItems = buyXRewardItems.concat(result.rewardItemsToAdd);
        }
    });

    const buyXMerged = mergeRewardItems(buyXRewardItems);
    const intermediateCart = createUpdatedCartItems(baseCartItems, bundleResults, buyXMerged);

    let intermediateTotal = 0;
    intermediateCart.forEach(item => {
        if (item.isWelcomeGift) {
            return;
        } else if (item.isRewardProduct) {
            intermediateTotal += (item.rewardPrice || 0) * item.quantity;
        } else if (item.discountedPrice) {
            intermediateTotal += item.discountedPrice;
        } else {
            intermediateTotal += item.prices?.price * item.quantity;
        }
    });

    const sortedThresholdDiscountOffers = [...thresholdDiscountOffers].sort((a, b) =>
        (b.thresholdAmount || 0) - (a.thresholdAmount || 0)
    );

    let thresholdDiscountResults = [];
    for (const offer of sortedThresholdDiscountOffers) {
        const result = {
            offer,
            offerName: offer.name || {},
            ...applyThresholdDiscount(offer, intermediateTotal)
        };
        if (result.discount > 0) {
            thresholdDiscountResults = [result];
            break;
        }
    }

    const mergedRewardItems = mergeRewardItems([...thresholdRewardEarly, ...buyXRewardItems]);
    const finalCart = createUpdatedCartItems(baseCartItems, bundleResults, mergedRewardItems);

    const totalDiscount =
        bundleResults.reduce((sum, r) => sum + r.discount, 0) +
        buyXGetYResults.reduce((sum, r) => sum + r.discount, 0) +
        thresholdResults.reduce((sum, r) => sum + r.discount, 0) +
        thresholdDiscountResults.reduce((sum, r) => sum + r.discount, 0);

    const appliedOffers = [
        ...bundleResults.map(r => ({
            type: 'BUNDLE_PRICE',
            name: r.offerName,
            timesApplied: r.timesApplied,
            offerId: r.offer?._id
        })),
        ...buyXGetYResults.map(r => ({
            type: 'BUY_X_GET_Y',
            name: r.offerName,
            timesApplied: r.timesApplied,
            offerId: r.offer?._id
        })),
        ...thresholdResults.map(r => ({
            type: 'THRESHOLD_GET_ITEM',
            name: r.offerName,
            timesApplied: r.timesApplied,
            offerId: r.offer?._id
        })),
        ...thresholdDiscountResults.map(r => ({
            type: 'THRESHOLD_DISCOUNT',
            name: r.offerName,
            timesApplied: r.timesApplied,
            discountType: r.discountType,
            discountValue: r.discountValue,
            discount: r.discount,
            offerId: r.offer?._id
        }))
    ];

    const welcomeGiftItems = cartItems.filter(item => item.isWelcomeGift);
    // פריט מוצר-חינם של קופון הרשמה — מוחרג מחישוב המבצעים ומוחזר כמו שהוא
    const couponFreeProductItems = cartItems.filter(item => item.isCouponFreeProduct);
    const existingRewardItemsInCart = cartItems.filter(item => item.isRewardProduct);
    const finalCartIds = new Set(finalCart.map((i) => i.id));

    const updatedExistingRewards = existingRewardItemsInCart.map((rewardItem) => {
        const offerIdStr = rewardItem.rewardOfferId?.toString?.() ?? String(rewardItem.rewardOfferId);

        for (const result of buyXGetYResults) {
            const resultOfferId = result.offer?._id?.toString?.() ?? String(result.offer?._id);
            if (resultOfferId === offerIdStr) {
                const expectedQty = (result.timesApplied || 1) * (result.offer?.rewardQuantity || 1);
                return { ...rewardItem, quantity: expectedQty };
            }
        }
        for (const result of thresholdResults) {
            const resultOfferId = result.offer?._id?.toString?.() ?? String(result.offer?._id);
            if (resultOfferId === offerIdStr) {
                return { ...rewardItem, quantity: result.offer?.rewardQuantity || 1 };
            }
        }
        return rewardItem;
    });

    const rewardsNotInFinal = updatedExistingRewards.filter((r) => !finalCartIds.has(r.id));

    return {
        updatedCartItems: [...finalCart, ...rewardsNotInFinal, ...welcomeGiftItems, ...couponFreeProductItems],
        totalDiscount,
        appliedOffers,
        thresholdDiscount: thresholdDiscountResults.length > 0 ? thresholdDiscountResults[0].discount : 0,
        bundleResults,
        buyXGetYResults,
        thresholdResults,
        thresholdDiscountResults
    };
};

const pidStrFoot = (v) => (v && v.toString ? v.toString() : String(v));

/** כמו הפרונט: ברירת מחדל ניתן לערימה; false / "false" / 0 / "no" / "off" = בלעדי */
const offerAllowsStackingWithOthers = (o) => {
    const v = o && o.allowStackingWithOtherOffers;
    if (v === false || v === 0) return false;
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
    }
    return true;
};

const resultHasActivePromotions = (r) =>
    (r?.appliedOffers && r.appliedOffers.length > 0) || (r?.totalDiscount || 0) > 0;

/** מבצע בלעדי יחיד שמנצח לפי סך ההנחה הגבוה ביותר */
const pickBestExclusiveSolo = (cartItems, exclusiveOffers) => {
    let best = null;
    for (const ex of exclusiveOffers) {
        const result = findOptimalOfferCombinationInternal(cartItems, [ex]);
        if (!resultHasActivePromotions(result)) continue;
        const d = result.totalDiscount || 0;
        if (!best || d > (best.result.totalDiscount || 0)) {
            best = { offer: ex, result };
        }
    }
    return best;
};

const collectEligibleExclusiveRuns = (cartItems, exclusiveOffers) => {
    const runs = [];
    for (const ex of exclusiveOffers) {
        const result = findOptimalOfferCombinationInternal(cartItems, [ex]);
        if (!resultHasActivePromotions(result)) continue;
        runs.push({ offer: ex, result });
    }
    return runs;
};

const buildLockedExclusiveReturn = (
    cartItems,
    offersIn,
    lockedOffer,
    lockedResult,
    stackableOffers,
    exclusiveOffers
) => {
    const lockPid = pidStrFoot(lockedOffer._id);
    const blockedEligibleNames = [];
    const blockedEligibleIds = [];
    const seenBlocked = new Set();

    const pushBlocked = (id, name) => {
        const idStr = pidStrFoot(id);
        if (!idStr || idStr === 'undefined' || seenBlocked.has(idStr)) return;
        seenBlocked.add(idStr);
        blockedEligibleIds.push(id);
        blockedEligibleNames.push(name != null ? name : {});
    };

    const counterStack = findOptimalOfferCombinationInternal(cartItems, stackableOffers);
    if (resultHasActivePromotions(counterStack)) {
        (counterStack.appliedOffers || []).forEach(a => {
            if (a.offerId != null) pushBlocked(a.offerId, a.name);
        });
    }

    for (const ex of exclusiveOffers) {
        if (pidStrFoot(ex._id) === lockPid) continue;
        const solo = findOptimalOfferCombinationInternal(cartItems, [ex]);
        if (resultHasActivePromotions(solo)) pushBlocked(ex._id, ex.name || {});
    }

    const notices = [];
    if (blockedEligibleNames.length > 0) {
        notices.push({
            type: 'ELIGIBLE_BLOCKED_BY_LOCKED_EXCLUSIVE',
            exclusiveOfferIds: [lockedOffer._id],
            exclusiveOfferNames: [lockedOffer.name || {}],
            blockedEligibleOfferNames: blockedEligibleNames,
            blockedEligibleOfferIds: blockedEligibleIds
        });
    }

    return {
        ...lockedResult,
        exclusiveStackingNotices: notices,
        activeExclusiveOfferIds: [lockedOffer._id]
    };
};

/**
 * מסונכרן עם tomer-store: בלעדי אחד; נעילה; waivedOfferIds + waivedExclusiveOfferIds.
 * @param {{ waivedExclusiveOfferIds?: string[], waivedOfferIds?: string[], lockedExclusiveOfferId?: string }} [options]
 */
const findOptimalOfferCombination = (cartItems, offers = [], options = {}) => {
    const waivedSet = new Set(
        [...(options.waivedOfferIds || []), ...(options.waivedExclusiveOfferIds || [])].map((id) =>
            pidStrFoot(id)
        )
    );
    const offersIn = offers.filter((o) => !waivedSet.has(pidStrFoot(o._id)));

    if (!Array.isArray(offersIn) || offersIn.length === 0 || cartItems.length === 0) {
        return {
            ...emptyCartWithClearedOffers(cartItems),
            exclusiveStackingNotices: [],
            activeExclusiveOfferIds: []
        };
    }

    const stackableOffers = offersIn.filter(offerAllowsStackingWithOthers);
    const exclusiveOffers = offersIn.filter((o) => !offerAllowsStackingWithOthers(o));

    const lockRaw = options.lockedExclusiveOfferId;
    if (lockRaw != null && !waivedSet.has(pidStrFoot(lockRaw))) {
        const lockedOffer = offersIn.find(
            (o) => pidStrFoot(o._id) === pidStrFoot(lockRaw) && !offerAllowsStackingWithOthers(o)
        );
        if (lockedOffer) {
            const lockedResult = findOptimalOfferCombinationInternal(cartItems, [lockedOffer]);
            if (resultHasActivePromotions(lockedResult)) {
                return buildLockedExclusiveReturn(
                    cartItems,
                    offersIn,
                    lockedOffer,
                    lockedResult,
                    stackableOffers,
                    exclusiveOffers
                );
            }
        }
    }

    if (exclusiveOffers.length === 0) {
        return {
            ...findOptimalOfferCombinationInternal(cartItems, offersIn),
            exclusiveStackingNotices: [],
            activeExclusiveOfferIds: []
        };
    }

    const stackOnly = findOptimalOfferCombinationInternal(cartItems, stackableOffers);
    const stackPromotionsActive = resultHasActivePromotions(stackOnly);

    const eligibleExclusiveRuns = collectEligibleExclusiveRuns(cartItems, exclusiveOffers);
    const exclusiveApplies = eligibleExclusiveRuns.length > 0;

    if (stackPromotionsActive && exclusiveApplies) {
        return {
            ...stackOnly,
            exclusiveStackingNotices: [
                {
                    type: 'EXCLUSIVE_ELIGIBLE_NEED_CANCEL_STACKABLES',
                    eligibleExclusiveOfferNames: eligibleExclusiveRuns.map((r) => r.offer.name || {}),
                    eligibleExclusiveOfferIds: eligibleExclusiveRuns.map((r) => r.offer._id)
                }
            ],
            activeExclusiveOfferIds: []
        };
    }

    if (!stackPromotionsActive && exclusiveApplies) {
        const bestExc = pickBestExclusiveSolo(cartItems, exclusiveOffers);
        if (!bestExc) {
            return { ...stackOnly, exclusiveStackingNotices: [], activeExclusiveOfferIds: [] };
        }
        const excResult = bestExc.result;
        const activeId = bestExc.offer._id;
        const activeName = bestExc.offer.name || {};
        const activePid = pidStrFoot(activeId);

        const blockedAdditionalExclusiveNames = [];
        const blockedAdditionalExclusiveIds = [];
        for (const run of eligibleExclusiveRuns) {
            if (pidStrFoot(run.offer._id) === activePid) continue;
            blockedAdditionalExclusiveNames.push(run.offer.name || {});
            blockedAdditionalExclusiveIds.push(run.offer._id);
        }

        let blockedStackableOfferNames = [];
        if (stackableOffers.length > 0) {
            const counterStack = findOptimalOfferCombinationInternal(cartItems, stackableOffers);
            if (resultHasActivePromotions(counterStack)) {
                blockedStackableOfferNames = (counterStack.appliedOffers || [])
                    .map((a) => a.name)
                    .filter((n) => n != null);
            }
        }

        const notices = [];
        if (blockedAdditionalExclusiveNames.length > 0 || blockedStackableOfferNames.length > 0) {
            notices.push({
                type: 'ACTIVE_EXCLUSIVE_BLOCKS_OTHERS',
                exclusiveOfferIds: [activeId],
                exclusiveOfferNames: [activeName],
                blockedAdditionalExclusiveOfferNames: blockedAdditionalExclusiveNames,
                blockedAdditionalExclusiveOfferIds: blockedAdditionalExclusiveIds,
                blockedStackableOfferNames
            });
        }

        return {
            ...excResult,
            exclusiveStackingNotices: notices,
            activeExclusiveOfferIds: [activeId]
        };
    }

    if (stackPromotionsActive) {
        return { ...stackOnly, exclusiveStackingNotices: [], activeExclusiveOfferIds: [] };
    }

    return { ...stackOnly, exclusiveStackingNotices: [], activeExclusiveOfferIds: [] };
};

// Export all functions for Node.js
module.exports = {
    calculateCartTotal,
    createProductCountMap,
    applyBundlePrice,
    applyBuyXGetY,
    applyThresholdGetItem,
    applyThresholdDiscount,
    mergeRewardItems,
    createUpdatedCartItems,
    findOptimalOfferCombination
};
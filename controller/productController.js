// controller/productController.js
const Product = require("../models/Product");
const mongoose = require("mongoose");
const Category = require("../models/Category");
const { languageCodes } = require("../utils/data");
const { getAllOffers } = require("./offerController");
const Offer = require("../models/Offer");
const { parseText, generateHebrewVariations, createApostropheIgnoringRegex } = require("../utils/voiceParser");
const { notifyLowStock, getLowStockThreshold } = require("../lib/stock-controller/others");

// בריחה מתווים מיוחדים של regex כדי שקלט משתמש לא ישבור את השאילתה
// (למשל slug שמסתיים ב-"\" גרם ל-"Regular expression is invalid" ולשגיאת 500)
const escapeRegex = (str) => String(str ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const addProduct = async (req, res) => {
  try {
    // Check if the SKU already exists in the database
    const existingProduct = await Product.findOne({ sku: req.body.sku });

    if (existingProduct) {
      // If SKU already exists, throw an error
      return res.status(400).send({ message: "מספר סידורי כבר קיים במערכת, יש להכניס מספר אחר" });
    }

    const newProduct = new Product({
      ...req.body,
      // productId: cname + (count + 1),
      productId: req.body.productId
        ? req.body.productId
        : new mongoose.Types.ObjectId(),
    });

    await newProduct.save();
    res.send(newProduct);
  } catch (err) {
    console.log('addProduct error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const addAllProducts = async (req, res) => {
  try {
    // console.log('product data',req.body)
    await Product.deleteMany();
    await Product.insertMany(req.body);
    res.status(200).send({
      message: "Product Added successfully!",
    });
  } catch (err) {
    console.log('addAllProducts error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const getShowingProducts = async (req, res) => {
  try {
    const products = await Product.find({
      status: "show",
      isStoreProduct: { $ne: true }
    }).sort({ _id: -1 });
    res.send(products);
    // console.log("products", products);
  } catch (err) {
    console.log('getShowingProducts error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

// מוצרי עגלה להצגה בעמוד checkout (isCartpprod === "yes", עד 4 מוצרים)
const getCartProducts = async (req, res) => {
  try {
    const products = await Product.find({
      status: "show",
      isStoreProduct: { $ne: true },
      isCartpprod: "yes",
    })
      .sort({ _id: -1 })
      .limit(4)
      .lean();
    res.send(products);
  } catch (err) {
    console.log("getCartProducts error:", err);
    res.status(500).send({ message: err.message });
  }
};

const getFacebookFeedCSV = async (req, res) => {
  try {
    const BASE_URL = process.env.STORE_URL; // הדומיין הציבורי שלך (חייב להיות נגיש לפייסבוק)
    const BRAND_NAME = process.env.COMPANY_NAME;

    const products = await Product.find({
      status: 'show',
      isStoreProduct: { $ne: true }
    }).sort({ _id: -1 }).populate({ path: "category", select: "name _id" });

    const headers = [
      'id',
      'title',
      'description',
      'availability',
      'condition',
      'price',
      'link',
      'image_link',
      'brand',
      'item_group_id'
    ];

    const csvRows = [headers.join(',')];

    for (const p of products) {

      const placeholderImage = "https://res.cloudinary.com/ahossain/image/upload/v1655097002/placeholder_kvepfp.png";
      const imageSrc = Array.isArray(p?.image)
        ? (p.image.length > 0 ? p.image[0] : placeholderImage)
        : (p?.image || placeholderImage);

      const row = [
        p.sku || p._id,
        p.title?.he || p.title?.en || '',
        p.description?.he || p.description?.en || p.title?.he + " מקטגוריית " + p.category?.name?.he || p.category?.name?.en || '',
        'in stock', // p.stock > 0 ? 'in stock' : 'out of stock',
        'new',
        `${Number(p.prices?.price || 0).toFixed(2)} ILS`,
        `${BASE_URL}/product/${p.slug || ''}`,
        imageSrc,
        BRAND_NAME,
        p.productId || p._id
      ].map(f => {
        const s = String(f ?? '');
        return s.includes(',') || s.includes('"') || s.includes('\n')
          ? `"${s.replace(/"/g, '""')}"`
          : s;
      });

      csvRows.push(row.join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="facebook-products-feed.csv"'
    );
    res.send('\uFEFF' + csvRows.join('\n'));
  } catch (err) {
    console.error('getFacebookFeedCSV error:', err);
    res.status(500).send({ message: err.message });
  }
};

// פונקציה לדירוג תוצאות לפי קרבה לשאילתא המקורית
const rankProductsByRelevance = (products, originalQuery, queryWords, variations = []) => {
  // console.log('originalQuery :>> ', originalQuery);
  // console.log('queryWords :>> ', queryWords);
  // console.log('variations :>> ', variations);

  const normalizeForComparison = (text) => {
    return text.toLowerCase()
      .replace(/['"''`ʼʻ]/g, '') // הסרת גרשים
      .replace(/[^\u0590-\u05ffa-z0-9\s]/g, ' ') // הסרת סימנים מיוחדים
      .replace(/\s+/g, ' ')
      .trim();
  };

  // פונקציה משופרת לבדיקה אם מילה מופיעה כמילה שלמה (תומכת בעברית)
  const isWholeWordMatch = (text, word) => {
    // פיצול הטקסט למילים ובדיקה אם המילה מופיעה כמילה נפרדת
    const words = text.split(/\s+/);
    return words.some(textWord => textWord === word);
  };

  return products.map(product => {
    const heTitle = normalizeForComparison(product.title.he || '');
    const enTitle = normalizeForComparison(product.title.en || '');
    const normalizedQuery = normalizeForComparison(originalQuery);

    let score = 0;

    // 1. בדיקה אם יש התאמה מושלמת לאחת מה-variations (הציון הכי גבוה!)
    let foundPerfectVariationMatch = false;
    if (variations && variations.length > 0) {
      for (const variation of variations) {
        const normalizedVariation = normalizeForComparison(variation);
        if (heTitle === normalizedVariation || enTitle === normalizedVariation) {
          score += 15000; // ציון הכי גבוה - התאמה מושלמת לווריאציה
          foundPerfectVariationMatch = true;
          break;
        }
        // בדיקה אם הווריאציה מופיעה כמילה שלמה בתחילת השם
        else if (heTitle.startsWith(normalizedVariation + ' ') || enTitle.startsWith(normalizedVariation + ' ') ||
          heTitle.startsWith(normalizedVariation + '(') || enTitle.startsWith(normalizedVariation + '(')) {
          score += 12000; // ציון גבוה מאוד - ווריאציה בתחילת השם
          foundPerfectVariationMatch = true;
          break;
        }
      }
    }

    // 2. התאמה מדויקת של השאילתה המעובדת (אם לא מצאנו התאמה מושלמת לווריאציה)
    if (!foundPerfectVariationMatch) {
      if (heTitle === normalizedQuery || enTitle === normalizedQuery) {
        score += 10000; // ציון גבוה להתאמה מושלמת לשאילתה המעובדת
      }
      // 3. התאמה של המחרוזת השלמה כ-substring
      else if (heTitle.includes(normalizedQuery) || enTitle.includes(normalizedQuery)) {
        score += 5000; // ציון גבוה אבל פחות מהתאמה מושלמת

        // בונוס אם זה בתחילת השם
        if (heTitle.startsWith(normalizedQuery) || enTitle.startsWith(normalizedQuery)) {
          score += 2000;
        }
      }
    }

    // 4. בדיקת התאמה של מילים בודדות - מילה שלמה vs חלק ממילה
    let wordMatchScore = 0;
    let foundWholeWords = 0;
    let foundPartialWords = 0;

    // בדיקה גם מול הvariations
    const allWordsToCheck = [...queryWords];
    if (variations && variations.length > 0) {
      // נוסיף את כל הvariations כמילים לבדיקה
      variations.forEach(variation => {
        const variationWords = variation.trim().split(/\s+/).filter(word => word.length > 1);
        allWordsToCheck.push(...variationWords);
      });
    }

    // הסרת כפילויות
    const uniqueWordsToCheck = [...new Set(allWordsToCheck.map(w => normalizeForComparison(w)))];

    uniqueWordsToCheck.forEach(word => {
      // בדיקה להתאמה של מילה שלמה
      const heWholeMatch = isWholeWordMatch(heTitle, word);
      const enWholeMatch = isWholeWordMatch(enTitle, word);

      if (heWholeMatch || enWholeMatch) {
        foundWholeWords++;

        // ציון גבוה יותר אם המילה מופיעה בvariations המקוריות
        const isFromOriginalVariation = variations && variations.some(v =>
          normalizeForComparison(v).includes(word)
        );

        const baseScore = isFromOriginalVariation ? 4000 : 3000;
        wordMatchScore += baseScore; // ציון גבוה מאוד למילה שלמה

        // בונוס אם המילה השלמה בתחילת השם
        const titleToCheck = heWholeMatch ? heTitle : enTitle;
        if (titleToCheck.startsWith(word + ' ') || titleToCheck === word) {
          wordMatchScore += isFromOriginalVariation ? 1500 : 1000;
        }
      }
      // אם לא מצאנו התאמה שלמה, בדוק כ-substring
      else if (heTitle.includes(word) || enTitle.includes(word)) {
        foundPartialWords++;
        wordMatchScore += 500; // ציון נמוך יותר לחלק ממילה
      }
    });

    score += wordMatchScore;

    // 5. ציון לפי אחוז המילים שנמצאו (עדיפות למילים שלמות)
    const totalWords = uniqueWordsToCheck.length;
    if (totalWords > 0) {
      const wholeWordPercentage = (foundWholeWords / totalWords) * 100;
      const partialWordPercentage = (foundPartialWords / totalWords) * 100;

      score += wholeWordPercentage * 10; // משקל גבוה למילים שלמות
      score += partialWordPercentage * 2;  // משקל נמוך למילים חלקיות
    }

    // 6. בונוס קל לשמות קצרים יותר (רק אם יש התאמה טובה)
    if (foundWholeWords > 0) {
      const titleLength = heTitle.length || enTitle.length;
      if (titleLength > 0) {
        score += Math.max(0, 30 - titleLength / 5); // בונוס גבוה יותר לשמות קצרים
      }
    }

    // console.log(`Product: "${product.title.he}" - WholeWords: ${foundWholeWords}, PartialWords: ${foundPartialWords}, Score: ${score}`);

    return { product, score };
  }).sort((a, b) => b.score - a.score);
};

// קבלת מוצר על פי חיפוש קולי
const findProductByTranscript = async (req, res) => {
  const { transcript } = req.query;
  // console.log('transcript :>> ', transcript);

  if (!transcript) {
    return res.status(400).json({
      message: {
        he: 'לא התקבל טקסט מתמלול',
        en: 'No transcript received'
      }
    });
  }

  /* ─── 1. ניתוח טקסט ─── */
  const { query, quantity, variations } = parseText(transcript);
  // console.log({ query, quantity, variations })

  if (!query) {
    return res.status(400).json({
      message: {
        he: 'לא נמצא שם מוצר בטקסט',
        en: 'No product name found in text'
      }
    });
  }

  /* ─── 2. חיפוש בדאטה־בייס ─── */
  try {
    // יצירת תנאי חיפוש מרובה - כולל ווריאציות צליליות
    const searchConditions = [];

    // חיפוש עבור השאילתה הבסיסית וכל הווריאציות הצליליות
    const allQueries = variations && variations.length > 0 ? variations : [query];

    allQueries.forEach(currentQuery => {
      // פיצול השאילתה למילים נפרדות
      const queryWords = currentQuery.trim().split(/\s+/).filter(word => word.length > 1);

      // חיפוש רגיל (מחרוזת שלמה) - עם התעלמות מגרשים
      const fullRegex = createApostropheIgnoringRegex(currentQuery);
      searchConditions.push(
        { 'title.he': fullRegex },
        { 'title.en': fullRegex },
        { slug: fullRegex },
        { sku: currentQuery },
        { barcode: currentQuery }
      );

      // חיפוש מתקדם - כל מילה בנפרד (טוב לטיפול בסוגריים ואותיות סופיות)
      if (queryWords.length > 0) {
        // יצירת רגקסים עם ווריאציות של כל מילה (אותיות סופיות + זכר/נקבה)
        const wordVariationsRegexes = queryWords.map(word => {
          const hebrewVariations = generateHebrewVariations(word);
          // console.log(`🔍 Variations for "${word}":`, hebrewVariations);

          // יצירת regex שמחפש כל אחת מהווריאציות תוך התעלמות מגרשים
          const variationsWithoutApostrophes = hebrewVariations.map(v =>
            createApostropheIgnoringRegex(v).source
          );
          const variationsPattern = variationsWithoutApostrophes.join('|');
          // console.log(`📝 Regex pattern for "${word}": ${variationsPattern}`);
          return new RegExp(variationsPattern, 'i');
        });

        // תנאי שכל המילים (או הווריאציות שלהן) צריכות להופיע בכותרת העברית
        const heAllWordsCondition = {
          $and: wordVariationsRegexes.map(regex => ({ 'title.he': regex }))
        };

        // תנאי שכל המילים צריכות להופיע בכותרת האנגלית (עם התעלמות מגרשים)
        const enAllWordsCondition = {
          $and: queryWords.map(word => ({ 'title.en': createApostropheIgnoringRegex(word) }))
        };

        searchConditions.push(heAllWordsCondition, enAllWordsCondition);
      }
    });

    // console.log('searchConditions :>> ');
    // console.dir(searchConditions, { depth: null, colors: true });

    // שינוי מ-findOne ל-find כדי לקבל מספר תוצאות
    const products = await Product.find({
      status: 'show',
      stock: { $gt: 0 },
      ...(req.user?.isCashier ? {} : { isStoreProduct: { $ne: true } }),
      $or: searchConditions
    }).lean().limit(20); // מגביל ל-10 תוצאות למניעת עומס

    if (!products || products.length === 0) {
      return res.status(404).json({
        message: {
          he: `לא נמצא מוצר עבור "${transcript}"`,
          en: `No product found for "${transcript}"`
        }
      });
    }

    // אם יש רק תוצאה אחת - החזר אותה ישירות
    if (products.length === 1) {
      // console.log(`Found single product: "${products[0].title.he}"`);
      return res.json({ product: products[0], quantity });
    }

    // דירוג התוצאות לפי רלוונטיות וסדר מילים
    const queryWords = query.trim().split(/\s+/).filter(word => word.length > 1);
    const rankedProducts = rankProductsByRelevance(products, query, queryWords, variations);

    const bestProduct = rankedProducts[0].product;
    // console.log(`Found best product from ${products.length} results: "${bestProduct.title.he}" (score: ${rankedProducts[0].score})`);

    return res.json({ product: bestProduct, quantity });

  } catch (err) {
    console.error('voice-search error:', err);
    return res.status(500).json({
      message: {
        he: 'התרחשה שגיאה, נסו שוב',
        en: 'An error occurred, please try again'
      }
    });
  }
};

const getAllProducts = async (req, res) => {
  const { title, category, price, page, limit } = req.query;

  let queryObject = {};
  let sortObject = {};
  if (title) {
    const titleQueries = languageCodes.map((lang) => ({
      [`title.${lang}`]: { $regex: escapeRegex(title), $options: "i" },
    }));
    queryObject.$or = titleQueries;
  }

  if (price === "low") {
    sortObject = {
      "prices.originalPrice": 1,
    };
  } else if (price === "high") {
    sortObject = {
      "prices.originalPrice": -1,
    };
  } else if (price === "published") {
    queryObject.status = "show";
  } else if (price === "unPublished") {
    queryObject.status = "hide";
  } else if (price === "status-selling") {
    queryObject.stock = { $gt: 0 };
  } else if (price === "status-out-of-stock") {
    queryObject.stock = { $lt: 1 };
  } else if (price === "date-added-asc") {
    sortObject.createdAt = 1;
  } else if (price === "date-added-desc") {
    sortObject.createdAt = -1;
  } else if (price === "date-updated-asc") {
    sortObject.updatedAt = 1;
  } else if (price === "date-updated-desc") {
    sortObject.updatedAt = -1;
  } else {
    sortObject = { _id: -1 };
  }

  // console.log('sortObject', sortObject);

  if (category) {
    let categoryId;

    // בדיקה האם הקטגוריה היא ObjectId חוקי
    if (mongoose.Types.ObjectId.isValid(category) && category.length === 24) {
      categoryId = new mongoose.Types.ObjectId(category); // חיפוש לפי ObjectId
    } else {
      // חיפוש לפי slug של הקטגוריה
      const foundCategory = await Category.findOne({ slug: category });
      if (foundCategory) {
        categoryId = foundCategory._id;
      } else {
        // אם לא מצאנו קטגוריה, מחזירים תוצאה ריקה
        return res.send({
          products: [],
          totalDoc: 0,
          limits: Number(limit),
          pages: Number(page),
        });
      }
    }

    queryObject.categories = categoryId;
  }

  // page/limit עשויים להגיע ריקים (למשל בורר המוצרים במבצעים שמבקש את כל
  // המוצרים). במקרה כזה Number(undefined) הוא NaN, ו-NaN ב-$skip/$limit
  // באגרגציה זורק שגיאה ומחזיר 500 -> הרשימה חוזרת ריקה. לכן: ערך לא תקין
  // משמעו "ללא דפדוף / החזר הכל".
  const limits = Number(limit) > 0 ? Number(limit) : 0; // 0 = ללא הגבלה
  const pages = Number(page) > 0 ? Number(page) : 1;
  const skip = limits > 0 ? (pages - 1) * limits : 0;

  // ברירת מחדל: מוצרים שהוגדר להם "מספר סדר הופעה" (barcode) מופיעים בראש
  // הקטלוג, ממוספר נמוך לגבוה, ורק אחריהם שאר המוצרים. חל כל עוד לא נבחר
  // מיון מפורש (מחיר / תאריך).
  const explicitSorts = [
    "low",
    "high",
    "date-added-asc",
    "date-added-desc",
    "date-updated-asc",
    "date-updated-desc",
  ];
  const useSerialOrder = !explicitSorts.includes(price);

  try {
    const totalDoc = await Product.countDocuments(queryObject);

    let products;
    if (useSerialOrder) {
      // מיון מספרי לפי barcode עם עדיפות למוצרים שיש להם ערך, תוך שמירה על דפדוף
      const aggregated = await Product.aggregate([
        { $match: queryObject },
        {
          $addFields: {
            // 0 = יש מספר סדר (יופיע ראשון), 1 = אין מספר סדר
            _hasOrder: {
              $cond: [
                { $gt: [{ $strLenCP: { $ifNull: ["$barcode", ""] } }, 0] },
                0,
                1,
              ],
            },
            // הערך המספרי של מספר הסדר לצורך מיון מהקטן לגדול
            _orderNum: {
              $convert: {
                input: "$barcode",
                to: "double",
                onError: Number.MAX_SAFE_INTEGER,
                onNull: Number.MAX_SAFE_INTEGER,
              },
            },
          },
        },
        { $sort: { _hasOrder: 1, _orderNum: 1, _id: -1 } },
        ...(skip > 0 ? [{ $skip: skip }] : []),
        ...(limits > 0 ? [{ $limit: limits }] : []),
        { $unset: ["_hasOrder", "_orderNum"] },
      ]);

      // אכלוס הקטגוריות על תוצאות ה-aggregation (Mongoose תומך בכך על אובייקטים רגילים)
      products = await Product.populate(aggregated, [
        { path: "category", select: "_id name" },
        { path: "categories", select: "_id name" },
      ]);
    } else {
      let findQuery = Product.find(queryObject)
        .populate({ path: "category", select: "_id name" })
        .populate({ path: "categories", select: "_id name" })
        .sort(sortObject);
      if (limits > 0) {
        findQuery = findQuery.skip(skip).limit(limits);
      }
      products = await findQuery;
    }

    res.send({
      products,
      totalDoc,
      limits,
      pages,
    });
  } catch (err) {
    console.log('getAllProducts error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const getProductBySlug = async (req, res) => {
  // console.log("slug", req.params.slug);
  try {
    const product = await Product.findOne({
      slug: req.params.slug,
      isStoreProduct: { $ne: true }
    });
    res.send(product);
  } catch (err) {
    console.log('getProductBySlug error: ', err);
    res.status(500).send({
      message: `Slug problem, ${err.message}`,
    });
  }
};

const getProductById = async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
    })
      .populate({ path: "category", select: "_id, name" })
      .populate({ path: "categories", select: "_id name" });

    res.send(product);
  } catch (err) {
    console.log('getProductById error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const updateProduct = async (req, res) => {
  // console.log('req.body: ', req.body)
  // console.log('update product')
  // console.log('variant',req.body.variants)
  try {
    const product = await Product.findById(req.params.id);
    // console.log("product", product);

    if (product) {
      // Check if the new SKU already exists in the database (excluding the current product)
      const existingProduct = await Product.findOne({ sku: req.body.sku, _id: { $ne: req.params.id } });

      if (existingProduct) {
        // If SKU already exists, throw an error
        return res.status(400).send({ message: "מספר סידורי כבר קיים במערכת, יש להכניס מספר אחר" });
      }

      // Proceed with updating the product
      product.title = { ...product.title, ...req.body.title };
      product.description = {
        ...product.description,
        ...req.body.description,
      };

      product.productId = req.body.productId;
      product.sku = req.body.sku;
      product.barcode = req.body.barcode;
      product.slug = req.body.slug;
      product.categories = req.body.categories;
      product.category = req.body.category;
      product.show = req.body.show;
      product.isCombination = req.body.isCombination;
      product.variants = req.body.variants;
      product.stock = req.body.stock;
      product.prices = req.body.prices;
      product.image = req.body.image;
      product.tag = req.body.tag;
      product.isVatFree = req.body.isVatFree;
      product.isStoreProduct = req.body.isStoreProduct;
      // הסרה מהחנות — סטטוס המוצר (show/hide). מסומן בטופס = "hide" = לא מוצג בחנות
      if (req.body.hasOwnProperty("status")) product.status = req.body.status;
      if (req.body.hasOwnProperty("isCartpprod")) product.isCartpprod = req.body.isCartpprod;
      product.purchaseLimit = req.body.purchaseLimit;
      if (req.body.hasOwnProperty("weight")) product.weight = req.body.weight;

      await product.save();

      // בדיקת מלאי נמוך גם בעדכון ידני של המוצר (לא חוסם את התגובה)
      const threshold = await getLowStockThreshold();
      await notifyLowStock(product, threshold);

      res.send({ data: product, message: "Product updated successfully!" });
    } else {
      res.status(404).send({
        message: "Product Not Found!",
      });
    }
  } catch (err) {
    console.log('updateProduct error: ', err);
    res.status(404).send(err.message);
  }
};

const updateProductPrice = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    // console.log("product", product);

    if (product) {
      product.prices.originalPrice = req.body.price;
      product.prices.price = req.body.price;
      product.prices.storePrice = req.body.storePrice;

      await product.save();
      res.send({ data: product, message: "Product price updated successfully!" });
    } else {
      res.status(404).send({
        message: "Product Not Found!",
      });
    }
  } catch (err) {
    console.log('updateProductPrice error: ', err);
    res.status(404).send(err.message);
  }
};

const updateManyProducts = async (req, res) => {
  try {
    const updatedData = {};
    for (const key of Object.keys(req.body)) {
      if (
        req.body[key] !== "[]" &&
        Object.entries(req.body[key]).length > 0 &&
        req.body[key] !== req.body.ids
      ) {
        // console.log('req.body[key]', typeof req.body[key]);
        updatedData[key] = req.body[key];
      }
    }

    // console.log("updated data", updatedData);

    await Product.updateMany(
      { _id: { $in: req.body.ids } },
      {
        $set: updatedData,
      },
      {
        multi: true,
      }
    );
    res.send({
      message: "Products update successfully!",
    });
  } catch (err) {
    console.log('updateManyProducts error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const updateStatus = async (req, res) => {
  try {
    const newStatus = req.body.status;
    console.log('newStatus', newStatus);

    await Product.updateOne(
      { _id: req.params.id },
      {
        $set: {
          status: newStatus,
        },
      }
    );

    res.status(200).send({
      message: `Product ${newStatus} Successfully!`,
    });
  } catch (err) {
    console.log('updateStatus error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const deleteProduct = async (req, res) => {
  try {
    await Product.deleteOne({ _id: req.params.id });
    res.status(200).send({
      message: "Product Deleted Successfully!",
    });
  } catch (err) {
    console.log('deleteProduct error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const getShowingStoreProducts = async (req, res) => {
  try {
    const queryObject = {};

    // הוספת תנאי לסינון מוצרים שהמלאי שלהם אינו 0
    // queryObject.stock = { $ne: 0 };

    // הוספת תנאי לסינון מוצרים שהם לא מוצרי חנות
    queryObject.isStoreProduct = { $ne: true };

    const { category, title, slug, sku } = req.query;

    queryObject.status = "show";

    // חיפוש לפי קטגוריה
    if (category) {
      let categoryId;

      // בדיקה האם הקטגוריה היא ObjectId חוקי
      if (mongoose.Types.ObjectId.isValid(category) && category.length === 24) {
        categoryId = category; // חיפוש לפי ObjectId
      } else {
        // חיפוש לפי slug של הקטגוריה
        const foundCategory = await Category.findOne({ slug: category });

        if (foundCategory) {
          categoryId = foundCategory._id; // אם מצאנו קטגוריה, נשתמש ב-ObjectId שלה
        } else {
          // אם לא מצאנו קטגוריה לפי הslug, להחזיר מוצרים ריקים
          return res.send({
            products: [],
            popularProducts: [],
            relatedProducts: [],
            discountedProducts: [],
            productsWithOffers: [],
          });
        }
      }

      // שימוש בקטגוריה שנמצאה כדי להוסיף אותה לשאילתת החיפוש
      queryObject.categories = {
        $in: [categoryId],
      };
    }

    if (title) {
      const titleQueries = languageCodes.map((lang) => ({
        [`title.${lang}`]: { $regex: escapeRegex(title), $options: "i" },
      }));

      queryObject.$or = titleQueries;
    }

    if (slug) {
      queryObject.slug = { $regex: escapeRegex(slug), $options: "i" };
    }

    if (sku) {
      queryObject.sku = sku;
    }

    let products = [];
    let popularProducts = [];
    let discountedProducts = [];
    let productsWithOffers = [];
    let relatedProducts = [];

    if (slug) {
      products = await Product.find(queryObject)
        .populate({ path: "category", select: "name _id" })
        .sort({ _id: -1 })
        .limit(100);
      relatedProducts = await Product.find({
        category: products[0]?.category,
        stock: { $ne: 0 },
        isStoreProduct: { $ne: true }
      }).populate({ path: "category", select: "_id name" });
    } else if (sku) {
      products = await Product.find({
        sku,
        isStoreProduct: { $ne: true }
      }).populate({ path: "category" });
    } else if (title || category) {
      products = await Product.find(queryObject)
        .populate({ path: "category", select: "name _id" })
        .sort({ _id: -1 })
        .limit(100);
    } else {
      // קודם כל נביא מוצרים עם barcode
      const barcodeQuery = { ...queryObject, barcode: { $exists: true, $ne: null, $ne: "" } };
      let productsWithBarcode = await Product.find(barcodeQuery)
        .populate({ path: "category", select: "name _id" })
        .lean(); // משתמשים ב-lean() כדי לקבל אובייקטים רגילים למיון

      // מיון מוצרים עם barcode לפי המספר שמופיע בברקוד (מהקטן לגדול)
      productsWithBarcode = productsWithBarcode
        .map(product => {
          // חילוץ המספר מהברקוד
          const barcodeNumber = parseInt(product.barcode) || 0;
          return { ...product, barcodeNumber };
        })
        .sort((a, b) => a.barcodeNumber - b.barcodeNumber)
        .map(({ barcodeNumber, ...product }) => product); // הסרת השדה הזמני

      const barcodeCount = productsWithBarcode.length;
      const targetLimit = 20;

      if (barcodeCount < targetLimit) {
        // אם אין 20 מוצרים עם barcode, נשלים לפי sales
        const remainingCount = targetLimit - barcodeCount;
        
        // שאילתה למוצרים ללא barcode (או עם barcode ריק)
        const noBarcodeQuery = { ...queryObject };
        // הוספת תנאי barcode - אם יש $or קיים, נשתמש ב-$and
        if (noBarcodeQuery.$or) {
          noBarcodeQuery.$and = [
            { $or: noBarcodeQuery.$or },
            {
              $or: [
                { barcode: { $exists: false } },
                { barcode: null },
                { barcode: "" }
              ]
            }
          ];
          delete noBarcodeQuery.$or;
        } else {
          noBarcodeQuery.$or = [
            { barcode: { $exists: false } },
            { barcode: null },
            { barcode: "" }
          ];
        }

        // נביא מוצרים לפי sales שלא כבר יש להם barcode
        const productsBySales = await Product.find(noBarcodeQuery)
          .populate({ path: "category", select: "name _id" })
          .sort({ sales: -1 })
          .limit(remainingCount)
          .lean();

        // שילוב התוצאות: קודם מוצרים עם barcode, אחר כך לפי sales
        popularProducts = [...productsWithBarcode, ...productsBySales];
      } else {
        // אם יש 20 או יותר מוצרים עם barcode, נקח רק את הראשונים
        popularProducts = productsWithBarcode.slice(0, targetLimit);
      }

      // חיפוש קטגוריית מבצעים לפי slug
      const offersCategory = await Category.findOne({ slug: "offers" });

      if (offersCategory) {
        discountedProducts = await Product.find({
          isStoreProduct: { $ne: true },
          status: "show",
          categories: { $in: [offersCategory._id] }
        })
          .populate({ path: "category", select: "name _id" })
          .sort({ _id: -1 })
          .limit(20);
      } else {
        // אם לא נמצאה קטגוריית מבצעים, מחזירים מוצרים עם הנחה
        discountedProducts = await Product.find({
          isStoreProduct: { $ne: true },
          $or: [
            {
              $and: [
                { isCombination: true },
                {
                  variants: {
                    $elemMatch: {
                      discount: { $gt: "0.00" },
                    },
                  },
                },
              ],
            },
            {
              $and: [
                { isCombination: false },
                {
                  $expr: {
                    $gt: [{ $toDouble: "$prices.discount" }, 0],
                  },
                },
              ],
            },
          ],
        })
          .populate({ path: "category", select: "name _id" })
          .sort({ _id: -1 })
          .limit(20);
      }

      const offers = await Offer.find().populate({ path: "products" });

      productsWithOffers = offers.flatMap((offer) => offer.products)
        .filter(p => p.stock > 0 && p.isStoreProduct !== true);

      // סינון כפילויות
      productsWithOffers = productsWithOffers.filter(
        (product, index, self) =>
          index === self.findIndex((p) => p._id.toString() === product._id.toString())
      );
    }

    // 'hide' מיון המוצרים לפי כותרת בעברית והסרת מוצרים שבסטטוס
    products = products.filter(p => p.status == "show")
      .sort((a, b) => a.title.he.localeCompare(b.title.he, 'he'));
    popularProducts = popularProducts.filter(p => p.status == "show")
    // .sort((a, b) => a.title.he.localeCompare(b.title.he, 'he'));
    relatedProducts = relatedProducts.filter(p => p.status == "show")
      .sort((a, b) => a.title.he.localeCompare(b.title.he, 'he'));
    discountedProducts = discountedProducts.filter(p => p.status == "show")
      .sort((a, b) => a.title.he.localeCompare(b.title.he, 'he'));
    productsWithOffers = productsWithOffers.filter(p => p.status == "show")
      .sort((a, b) => a.title.he.localeCompare(b.title.he, 'he'));

    // console.log(popularProducts.map(p => p.title.he.split('').reverse().join('')))

    res.send({
      products,
      popularProducts,
      relatedProducts,
      discountedProducts,
      productsWithOffers,
    });
  } catch (err) {
    console.log('getShowingStoreProducts error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

const deleteManyProducts = async (req, res) => {
  try {
    const cname = req.cname;
    // console.log("deleteMany", cname, req.body.ids);

    await Product.deleteMany({ _id: req.body.ids });

    res.send({
      message: `Products Delete Successfully!`,
    });
  } catch (err) {
    console.log('deleteManyProducts error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

module.exports = {
  addProduct,
  addAllProducts,
  getAllProducts,
  getShowingProducts,
  getCartProducts,
  getFacebookFeedCSV,
  findProductByTranscript,
  getProductById,
  getProductBySlug,
  updateProduct,
  updateProductPrice,
  updateManyProducts,
  updateStatus,
  deleteProduct,
  deleteManyProducts,
  getShowingStoreProducts,
};

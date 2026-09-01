// routes/productRoutes.js
const express = require("express");
const router = express.Router();
const {
  addProduct,
  importProducts,
  checkImportProducts,
  getAllProducts,
  getProductsLite,
  getProductByBarcode,
  bulkChangeCategory,
  getShowingProducts,
  getCartProducts,
  getProductById,
  getProductDetails,
  getProductBySlug,
  updateProduct,
  updateProductPrice,
  updateManyProducts,
  updateStatus,
  deleteProduct,
  deleteManyProducts,
  getShowingStoreProducts,
  findProductByTranscript,
  getFacebookFeedCSV,
} = require("../controller/productController");
const { isAdmin, extractUserDetails } = require("../config/auth");

// add a product
router.post("/add", isAdmin, addProduct);

// בדיקה מקדימה לפני יבוא אקסל (מה קיים, אילו קטגוריות חסרות)
router.post("/import/check", isAdmin, checkImportProducts);

// יבוא/עדכון מוצרים מאקסל לפי מק"ט - חייב להיות לפני "/:id"
router.post("/import", isAdmin, importProducts);

// רשימת קטלוג רזה לבוררי מוצרים - לפני "/:id" כדי ש-"lite" לא ייחשב ל-id
router.get("/lite", isAdmin, getProductsLite);

// חיפוש לפי ברקוד (הקלדה/סריקה בשורת מסמך). לפני "/:id" מאותה סיבה
router.get("/by-barcode/:barcode", isAdmin, getProductByBarcode);

// העברת מוצרים לקטגוריה אחרת באצווה. לפני "/:id", וכשדה יחיד שניתן
// לשינוי - בניגוד ל-"/update/many" שמקבל כל שדה שנשלח אליו
router.patch("/bulk-category", isAdmin, bulkChangeCategory);

// get a product
router.post("/:id", getProductById);

// get showing products only
router.get("/show", getShowingProducts);

// get cart products (isCartpprod, for checkout page)
router.get("/cart-products", getCartProducts);

// get showing products CSV
router.get("/show/facebook-feed-csv", getFacebookFeedCSV);

// get a product by transcript
router.get('/voice-search', extractUserDetails, findProductByTranscript);

// get showing products in store
router.get("/store", getShowingStoreProducts);

// get all products
router.get("/", getAllProducts);

// כרטיס מוצר מלא (כולל נתוני ההנהח"ש מיבוא האקסל) למסך "צפייה במוצר".
// לא מתנגש עם "/product/:slug": שם הסגמנט השני הוא ה-slug, וכאן הוא "details"
router.get("/:id/details", isAdmin, getProductDetails);

// get a product by slug
router.get("/product/:slug", getProductBySlug);

// update a product
router.patch("/:id", isAdmin, updateProduct);

// update only product price
router.patch("/updatePrice/:id", isAdmin, updateProductPrice);

// update many products
router.patch("/update/many", isAdmin, updateManyProducts);

// update a product status
router.put("/status/:id", isAdmin, updateStatus);

// delete a product
router.delete("/:id", isAdmin, deleteProduct);

// delete many product
router.patch("/delete/many", isAdmin, deleteManyProducts);

module.exports = router;

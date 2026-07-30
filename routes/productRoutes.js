// routes/productRoutes.js
const express = require("express");
const router = express.Router();
const {
  addProduct,
  addAllProducts,
  getAllProducts,
  getShowingProducts,
  getCartProducts,
  getProductById,
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

// add multiple products
router.post("/all", isAdmin, addAllProducts);

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

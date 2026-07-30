const express = require('express');
const router = express.Router();
const {
  addCategory,
  addAllCategory,
  getAllCategory,
  getAllCategories,
  getShowingCategory,
  getCategoryById,
  updateCategory,
  updateStatus,
  deleteCategory,
  deleteManyCategory,
  updateManyCategory

} = require('../controller/categoryController');
const { isAdmin } = require('../config/auth');

// add a category
router.post('/add', isAdmin, addCategory);

// add all category
router.post('/add/all', isAdmin, addAllCategory);

// get only showing category
router.get('/show', getShowingCategory);

// get all category
router.get('/', getAllCategory);

// get all category
router.get('/all', getAllCategories);

// get a category
router.get('/:id', getCategoryById);

// update a category
router.put('/:id', isAdmin, updateCategory);

// show/hide a category
router.put('/status/:id', isAdmin, updateStatus);

// delete a category
router.delete('/:id', isAdmin, deleteCategory);

// delete many category
router.patch('/delete/many', isAdmin, deleteManyCategory);

// update many category
router.patch('/update/many', isAdmin, updateManyCategory);

module.exports = router;

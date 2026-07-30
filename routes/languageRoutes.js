const express = require('express');
const router = express.Router();

const {
  addLanguage,
  addAllLanguage,
  getAllLanguages,
  getShowingLanguage,
  getLanguageById,
  updateLanguage,
  updateStatus,
  deleteLanguage,
  updateManyLanguage,
  deleteManyLanguage,
} = require('../controller/languageController');
const { isAdmin } = require('../config/auth');

// add a language
router.post('/add', isAdmin, addLanguage);

// add all language
router.post('/add/all', isAdmin, addAllLanguage);

// get only showing language
router.get('/show', getShowingLanguage);

// get all language
router.get('/all', isAdmin, getAllLanguages);

// get a language
router.get('/:id', getLanguageById);

// update a language
router.put('/:id', isAdmin, updateLanguage);

// update many language
router.patch('/update/many', isAdmin, updateManyLanguage);

// show/hide a language
router.put('/status/:id', isAdmin, updateStatus);

// delete a language
router.patch('/:id', isAdmin, deleteLanguage);

// delete many language
router.patch('/delete/many', isAdmin, deleteManyLanguage);

module.exports = router;

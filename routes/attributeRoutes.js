const express = require('express');
const router = express.Router();

const {
  addAttribute,
  addAllAttributes,
  getAllAttributes,
  getShowingAttributes,
  getAttributeById,
  updateAttributes,
  updateStatus,
  deleteAttribute,
  getShowingAttributesTest,
  updateChildStatus,
  deleteChildAttribute,
  addChildAttributes,
  updateChildAttributes,
  getChildAttributeById,
  updateManyAttribute,
  deleteManyAttribute,
  updateManyChildAttribute,
  deleteManyChildAttribute,
} = require('../controller/attributeController');
const { isAdmin } = require('../config/auth');

// add attribute
router.post('/add', isAdmin, addAttribute);

//add all attributes
router.post('/add/all', isAdmin, addAllAttributes);

// add child attribute
router.put('/add/child/:id', isAdmin, addChildAttributes);

// get all attribute
router.get('/', getAllAttributes);

// router.get('/show', getShowingProducts);
router.get('/show', getShowingAttributes);

router.put('/show/test', getShowingAttributesTest);

// update many attributes
router.patch('/update/many', isAdmin, updateManyAttribute);

// get attribute by id
router.get('/:id', getAttributeById);

// child get attributes by id
router.get('/child/:id/:ids', getChildAttributeById);

// update attribute
router.put('/:id', isAdmin, updateAttributes);

// update child attribute
router.patch('/update/child/many', isAdmin, updateManyChildAttribute);

// update child attribute
router.put('/update/child/:attributeId/:childId', isAdmin, updateChildAttributes);

// show/hide a attribute
router.put('/status/:id', isAdmin, updateStatus);

// show and hide a child status
router.put('/status/child/:id', isAdmin, updateChildStatus);

// delete attribute
router.delete('/:id', isAdmin, deleteAttribute);

// delete child attribute
router.put('/delete/child/:attributeId/:childId', isAdmin, deleteChildAttribute);

// delete many attribute
router.patch('/delete/many', isAdmin, deleteManyAttribute);

// delete many child attribute
router.patch('/delete/child/many', isAdmin, deleteManyChildAttribute);

module.exports = router;

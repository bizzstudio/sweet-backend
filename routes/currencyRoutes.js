const express = require('express');
const router = express.Router();

const {
  addCurrency,
  addAllCurrency,
  getAllCurrency,
  getShowingCurrency,
  getCurrencyById,
  updateCurrency,
  updateManyCurrency,
  updateEnabledStatus,
  updateLiveExchangeRateStatus,
  deleteCurrency,
  deleteManyCurrency,
} = require('../controller/currencyController');
const { isAdmin } = require('../config/auth');

// add a addCurrency
router.post('/add', isAdmin, addCurrency);

// add all Currency
router.post('/add/all', isAdmin, addAllCurrency);

// get only showing Currency
router.get('/show', getShowingCurrency);

// get all Currency
router.get('/', getAllCurrency);

// get a Currency
router.get('/:id', getCurrencyById);

// update a Currency
router.put('/:id', isAdmin, updateCurrency);

// update many Currency
router.patch('/update/many', isAdmin, updateManyCurrency);

// delete many Currency
router.patch('/delete/many', isAdmin, deleteManyCurrency);

// delete a Currency
router.delete('/:id', isAdmin, deleteCurrency);

// show/hide a Currency
router.put('/status/enabled/:id', isAdmin, updateEnabledStatus);

// show/hide a Currency
router.put('/status/live-exchange-rates/:id', isAdmin, updateLiveExchangeRateStatus);

// delete a Currency
router.delete('/:id', isAdmin, deleteCurrency);

module.exports = router;

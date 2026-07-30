// routes/deliveryRoutes.js
const express = require('express');
const router = express.Router();
const deliveryController = require('../controller/deliveryController');
const { isAdmin } = require('../config/auth');

// סטטיים לפני /:id — אחרת "getbycity" נחשב כ־ObjectId
router.post('/', isAdmin, deliveryController.createDelivery);
router.get('/', deliveryController.getAllDeliveries);
router.get('/getbycity/:city', deliveryController.getDeliveryByCity);
router.get('/undeliverable-address-logs', isAdmin, deliveryController.getUndeliverableAddressLogs);
router.patch('/delete/many', isAdmin, deliveryController.deleteManyDelivery);
router.get('/:id', deliveryController.getDelivery);
router.put('/:id', isAdmin, deliveryController.updateDelivery);
router.delete('/:id', isAdmin, deliveryController.deleteDelivery);

module.exports = router;

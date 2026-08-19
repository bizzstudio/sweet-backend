// routes/cityRoutes.js
const express = require('express');
const router = express.Router();
const cityController = require('../controller/cityController');

router.get('/', cityController.getCities);

module.exports = router;

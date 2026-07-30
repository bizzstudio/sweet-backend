// controller/deliveryController.js
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const cron = require('node-cron');
const Delivery = require('../models/Delivery');
const UndeliverableAddressLog = require('../models/UndeliverableAddressLog');
const Customer = require('../models/Customer');
const Admin = require('../models/Admin');
const { sendEmailSilent } = require('../lib/email-sender/sender');
const { undeliverableAddressesDailyBody } = require('../lib/email-sender/templates/undeliverable-addresses-daily');

function getIsraelDateKey(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

function normalizeGuestName(s) {
  return (s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function formatAdminDisplayName(adminUser) {
  if (!adminUser) return 'צוות';
  if (typeof adminUser.name === 'string') return adminUser.name;
  if (adminUser.name && typeof adminUser.name === 'object') {
    return adminUser.name.he || adminUser.name.en || adminUser.email || 'צוות';
  }
  return adminUser.email || 'צוות';
}

function pickPhone(...candidates) {
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    const t = c != null ? String(c).trim() : '';
    if (t) return t.slice(0, 30);
  }
  return '';
}

async function resolveCustomerContext(req) {
  let qName = '';
  if (typeof req.query.customerName === 'string' && req.query.customerName.trim()) {
    try {
      qName = decodeURIComponent(req.query.customerName).trim().slice(0, 200);
    } catch (_) {
      qName = req.query.customerName.trim().slice(0, 200);
    }
  }

  let qPhone = '';
  if (typeof req.query.customerPhone === 'string' && req.query.customerPhone.trim()) {
    try {
      qPhone = decodeURIComponent(req.query.customerPhone).trim().slice(0, 30);
    } catch (_) {
      qPhone = req.query.customerPhone.trim().slice(0, 30);
    }
  }

  let guestSessionKey = '';
  if (typeof req.query.guestSessionKey === 'string' && req.query.guestSessionKey.trim()) {
    guestSessionKey = req.query.guestSessionKey.trim().slice(0, 120);
  }

  const auth = req.headers.authorization;
  if (!auth || typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
    if (guestSessionKey) {
      return {
        identityKey: `sess:${guestSessionKey}`,
        customerName: qName || 'אורח',
        customerPhone: qPhone,
      };
    }
    const gk = normalizeGuestName(qName) || 'anon';
    return {
      identityKey: `guest:${gk}`,
      customerName: qName || 'אורח',
      customerPhone: qPhone,
    };
  }

  try {
    const token = auth.split(' ')[1];
    if (!token) throw new Error('no token');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.email) {
      const adminUser = await Admin.findOne({ email: decoded.email }).lean();
      if (adminUser) {
        return {
          identityKey: `staff:${adminUser._id}`,
          customerName: formatAdminDisplayName(adminUser),
          customerPhone: pickPhone(adminUser.phone, decoded.phone, qPhone),
        };
      }
    }

    if (decoded._id && mongoose.Types.ObjectId.isValid(decoded._id)) {
      const customer = await Customer.findById(decoded._id).select('name lastName email phone').lean();
      const fromJwt = [decoded.name, decoded.lastName].filter(Boolean).join(' ').trim();
      const fromDb = customer
        ? [customer.name, customer.lastName].filter(Boolean).join(' ').trim()
        : '';
      const display = (fromDb || fromJwt || qName || '').trim() || 'לקוח';
      return {
        identityKey: `cust:${decoded._id}`,
        customerName: display,
        customerPhone: pickPhone(customer?.phone, decoded.phone, qPhone),
      };
    }

    const fromJwt = [decoded.name, decoded.lastName].filter(Boolean).join(' ').trim();
    const gk = normalizeGuestName(fromJwt || qName) || 'anon';
    return {
      identityKey: `guest:${gk}`,
      customerName: fromJwt || qName || 'אורח',
      customerPhone: pickPhone(decoded.phone, qPhone),
    };
  } catch (_) {
    if (guestSessionKey) {
      return {
        identityKey: `sess:${guestSessionKey}`,
        customerName: qName || 'אורח',
        customerPhone: qPhone,
      };
    }
    const gk = normalizeGuestName(qName) || 'anon';
    return {
      identityKey: `guest:${gk}`,
      customerName: qName || 'אורח',
      customerPhone: qPhone,
    };
  }
}

const DEFAULT_MINIMUM_ORDER = 150;

function toMinimumOrder(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_MINIMUM_ORDER;
  }
  const n = Number(value);
  if (Number.isNaN(n) || n < 0) {
    return DEFAULT_MINIMUM_ORDER;
  }
  return n;
}

async function persistUndeliverableLog(req, { cityNameHe, reason }) {
  try {
    const logDay = getIsraelDateKey();
    const { identityKey, customerName, customerPhone } = await resolveCustomerContext(req);
    const name = ((customerName && String(customerName).trim()) || 'אורח').slice(0, 200);
    const phone = pickPhone(customerPhone);

    await UndeliverableAddressLog.findOneAndUpdate(
      { logDay, cityNameHe, identityKey },
      {
        $setOnInsert: {
          cityNameHe,
          reason,
          logDay,
          identityKey,
          customerName: name,
          customerPhone: phone,
        },
      },
      { upsert: true, new: false }
    );
  } catch (err) {
    if (err && err.code === 11000) {
      return;
    }
    console.error('persistUndeliverableLog error: ', err);
  }
}

// יצירת יעד משלוח חדש
const createDelivery = async (req, res) => {
  const { city, price, days, minimumOrder, biweekly } = req.body;

  try {
    // בדיקה אם כבר קיים delivery עם אותו city_code
    if (city && city.city_code) {
      const existingDelivery = await Delivery.findOne({ 'city.city_code': city.city_code });
      if (existingDelivery) {
        return res.status(400).json({
          message: {
            en: 'Delivery for this city already exists',
            he: 'כבר קיים יעד משלוח לעיר זו'
          }
        });
      }
    }

    const newDelivery = await Delivery.create({
      city,
      price,
      days,
      minimumOrder: toMinimumOrder(minimumOrder),
      biweekly: Boolean(biweekly),
    });
    res.status(201).json(newDelivery);
  } catch (err) {
    console.log('createDelivery error: ', err);
    res.status(400).json({
      message: {
        en: err.message || 'Failed to create delivery',
        he: 'שגיאה ביצירת יעד משלוח'
      }
    });
  }
};

// קריאת כל יעדי המשלוח
const getAllDeliveries = async (req, res) => {
  try {
    const deliveries = await Delivery.find().sort({ 'city.city_name_he': 1 });
    res.json(deliveries);
  } catch (err) {
    console.log('getAllDeliveries error: ', err);
    res.status(500).json({ message: err.message });
  }
};

// קריאת יעד משלוח מסוים
const getDelivery = async (req, res) => {
  try {
    const delivery = await Delivery.findById(req.params.id);
    if (!delivery) {
      return res.status(404).json({
        message: {
          en: 'Delivery not found',
          he: 'יעד משלוח לא נמצא'
        }
      });
    }
    res.json(delivery);
  } catch (err) {
    console.log('getDelivery error: ', err);
    res.status(500).json({ message: err.message });
  }
};

// בדיקה אם יעד משלוח קיים על פי עיר
const getDeliveryByCity = async (req, res) => {
  try {
    let cityParam = req.params.city;
    try {
      cityParam = decodeURIComponent(cityParam);
    } catch (_) {
      /* keep raw */
    }
    const city = (cityParam || '').trim();

    const delivery = await Delivery.findOne({ 'city.city_name_he': city });
    if (!delivery) {
      await persistUndeliverableLog(req, { cityNameHe: city, reason: 'no_delivery_zone' });
      return res.status(404).json({
        message: {
          en: 'Delivery not found',
          he: 'יעד משלוח לא נמצא'
        }
      });
    }
    if (!delivery.days || delivery.days.length === 0) {
      await persistUndeliverableLog(req, { cityNameHe: city, reason: 'no_delivery_days' });
    }
    res.json(delivery);
  } catch (err) {
    console.log('getDeliveryByCity error: ', err);
    res.status(500).json({ message: err.message });
  }
};

const getUndeliverableAddressLogs = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 2000);
    const logs = await UndeliverableAddressLog.find()
      .select('cityNameHe reason customerName customerPhone createdAt logDay')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json(logs);
  } catch (err) {
    console.log('getUndeliverableAddressLogs error: ', err);
    res.status(500).json({ message: err.message });
  }
};

// עדכון יעד משלוח מסוים
const updateDelivery = async (req, res) => {
  try {
    const { city, price, days, minimumOrder, biweekly } = req.body;
    const delivery = await Delivery.findById(req.params.id);
    if (!delivery) {
      return res.status(404).json({
        message: {
          en: 'Delivery not found',
          he: 'יעד משלוח לא נמצא'
        }
      });
    }

    // בדיקה אם העיר החדשה כבר קיימת ב-delivery אחר
    if (city && city.city_code) {
      const existingDelivery = await Delivery.findOne({
        'city.city_code': city.city_code,
        _id: { $ne: req.params.id } // לא אותו delivery
      });
      if (existingDelivery) {
        return res.status(400).json({
          message: {
            en: 'Delivery for this city already exists',
            he: 'כבר קיים יעד משלוח לעיר זו'
          }
        });
      }
    }

    if (city) {
      delivery.city = city;
    }
    if (price) {
      delivery.price = price;
    }
    if (days) {
      delivery.days = days;
    }
    if (minimumOrder !== undefined && minimumOrder !== null) {
      delivery.minimumOrder = toMinimumOrder(minimumOrder);
    }
    if (biweekly !== undefined) {
      delivery.biweekly = Boolean(biweekly);
    }
    const updatedDelivery = await delivery.save();
    res.json(updatedDelivery);
  } catch (err) {
    console.log('updateDelivery error: ', err);
    res.status(400).json({
      message: {
        en: err.message || 'Failed to update delivery',
        he: 'שגיאה בעדכון יעד משלוח'
      }
    });
  }
};

// מחיקת יעד משלוח מסוים
const deleteDelivery = async (req, res) => {
  try {
    const delivery = await Delivery.findById(req.params.id);
    if (!delivery) {
      return res.status(404).json({
        message: {
          en: 'Delivery not found',
          he: 'יעד משלוח לא נמצא'
        }
      });
    }
    await delivery.deleteOne();
    res.json({
      message: {
        en: 'Delivery deleted',
        he: 'יעד משלוח נמחק בהצלחה'
      }
    });
  } catch (err) {
    console.log('deleteDelivery error: ', err);
    res.status(500).json({ message: err.message });
  }
};

// מחיקת כמה יעדים
const deleteManyDelivery = async (req, res) => {
  try {
    await Delivery.deleteMany({ _id: req.body.ids });
    res.send({
      message: {
        en: 'Deliveries deleted successfully',
        he: 'יעדי משלוח נמחקו בהצלחה'
      }
    });
  } catch (err) {
    console.log('deleteManyDelivery error: ', err);
    res.status(500).send({ message: err.message });
  }
};

// שליחת דוח יומי של כתובות שלא נמצאו בשעה 00:00 כל לילה (שעון ישראל)
cron.schedule('0 0 * * *', async () => {
  try {
    const todayKey = getIsraelDateKey();
    const logs = await UndeliverableAddressLog.find({ logDay: todayKey })
      .select('cityNameHe reason customerName customerPhone createdAt')
      .sort({ createdAt: -1 })
      .lean();

    if (!logs.length) {
      console.log(`[Daily Report] No undeliverable addresses for ${todayKey}`);
      return;
    }

    const adminEmails = process.env.UNDELIVERABLE_REPORT_EMAIL
      ? process.env.UNDELIVERABLE_REPORT_EMAIL.split(',').map((e) => e.trim()).filter(Boolean)
      : process.env.ADMINS_EMAILS
        ? process.env.ADMINS_EMAILS.split(',').map((e) => e.trim()).filter(Boolean)
        : [process.env.EMAIL_USER];

    const dateLabel = new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });

    await sendEmailSilent({
      from: `"${process.env.COMPANY_NAME}" <${process.env.EMAIL_USER}>`,
      to: adminEmails.join(','),
      subject: `📍 כתובות שלא נמצאו – ${dateLabel} (${logs.length} רשומות)`,
      html: undeliverableAddressesDailyBody(logs, dateLabel),
    });

    console.log(`[Daily Report] Sent undeliverable addresses report for ${todayKey} to ${adminEmails.join(', ')}`);
  } catch (err) {
    console.error('[Daily Report] Failed to send undeliverable addresses report:', err.message);
  }
}, { timezone: 'Asia/Jerusalem' });

module.exports = {
  createDelivery,
  getAllDeliveries,
  getDelivery,
  getDeliveryByCity,
  getUndeliverableAddressLogs,
  updateDelivery,
  deleteDelivery,
  deleteManyDelivery,
};

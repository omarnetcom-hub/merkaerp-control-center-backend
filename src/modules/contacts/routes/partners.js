const express = require('express');
const router = express.Router();
const Partner = require('../models/Partner');

const authMiddleware = require('../../../middleware/auth');

let db;

function setDatabase(database) {
  db = database;
}

const partnerModel = new Partner(db);

// POST /api/partners - Create partner
router.post('/', authMiddleware, async (req, res) => {
  try {
    const partner = await partnerModel.create(req.body);
    res.status(201).json(partner);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/partners/:id - Get partner
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const partner = await partnerModel.findById(req.params.id);
    if (!partner) {
      return res.status(404).json({ error: 'Partner not found' });
    }
    res.json(partner);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/partners - List partners by type
router.get('/', authMiddleware, async (req, res) => {
  try {
    const type = req.query.type || 'contact';
    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;
    const partners = await partnerModel.list(type, limit, offset);
    res.json(partners);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/partners/customers - Get customers
router.get('/type/customers', authMiddleware, async (req, res) => {
  try {
    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;
    const customers = await partnerModel.getCustomers(limit, offset);
    res.json(customers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/partners/suppliers - Get suppliers
router.get('/type/suppliers', authMiddleware, async (req, res) => {
  try {
    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;
    const suppliers = await partnerModel.getSuppliers(limit, offset);
    res.json(suppliers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/partners/:id - Update partner
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const partner = await partnerModel.update(req.params.id, req.body);
    res.json(partner);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/partners/:id - Delete partner
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await partnerModel.delete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = { router, setDatabase };

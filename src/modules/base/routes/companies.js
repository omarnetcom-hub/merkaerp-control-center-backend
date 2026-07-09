const express = require('express');
const router = express.Router();
const Company = require('../models/Company');

const authMiddleware = require('../../../middleware/auth');

let db;

function setDatabase(database) {
  db = database;
}

const companyModel = new Company(db);

// POST /api/companies - Create company
router.post('/', authMiddleware, async (req, res) => {
  try {
    const company = await companyModel.create(req.body);
    res.status(201).json(company);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/companies/:id - Get company
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const company = await companyModel.findById(req.params.id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }
    res.json(company);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/companies - List companies
router.get('/', authMiddleware, async (req, res) => {
  try {
    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;
    const companies = await companyModel.list(limit, offset);
    res.json(companies);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/companies/:id - Update company
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const company = await companyModel.update(req.params.id, req.body);
    res.json(company);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/companies/:id - Delete company
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await companyModel.delete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = { router, setDatabase };

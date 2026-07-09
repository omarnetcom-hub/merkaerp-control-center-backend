const express = require('express');
const router = express.Router();
const Journal = require('../models/Journal');
const authMiddleware = require('../../../middleware/auth');

let db;
let journalModel;

function setDatabase(database) {
  db = database;
  journalModel = new Journal(db);
}

router.post('/', authMiddleware, async (req, res) => {
  try {
    const journal = await journalModel.create(req.body);
    res.status(201).json(journal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const journal = await journalModel.findById(req.params.id);
    if (!journal) {
      return res.status(404).json({ error: 'Journal not found' });
    }
    res.json(journal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/', authMiddleware, async (req, res) => {
  try {
    const active = req.query.active !== 'false';
    const company_id = req.query.company_id || null;
    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;
    const journals = await journalModel.list(company_id, active, limit, offset);
    res.json(journals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const journal = await journalModel.update(req.params.id, req.body);
    res.json(journal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = { router, setDatabase };

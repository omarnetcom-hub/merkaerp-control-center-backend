const express = require('express');
const router = express.Router();
const Account = require('../models/Account');
const authMiddleware = require('../../../middleware/auth');

let db;
let accountModel;

function setDatabase(database) {
  db = database;
  accountModel = new Account(db);
}

router.post('/', authMiddleware, async (req, res) => {
  try {
    const account = await accountModel.create(req.body);
    res.status(201).json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const account = await accountModel.findById(req.params.id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    res.json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/', authMiddleware, async (req, res) => {
  try {
    const active = req.query.active !== 'false';
    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;
    const accounts = await accountModel.list(active, limit, offset);
    res.json(accounts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const account = await accountModel.update(req.params.id, req.body);
    res.json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = { router, setDatabase };

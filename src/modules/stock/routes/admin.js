const express = require('express');
const router = express.Router();
const authMiddleware = require('../../../middleware/auth');
const { requireRole } = require('../../../middleware/roles');

module.exports = function({ db }) {
  const Warehouse = require('../models/Warehouse');
  const StockLot = require('../models/StockLot');
  const ReorderRule = require('../models/ReorderRule');
  const warehouseModel = new Warehouse(db);
  const lotModel = new StockLot(db);
  const ruleModel = new ReorderRule(db);

  // Warehouses CRUD
  router.post('/warehouses', authMiddleware, requireRole('stock_manager'), async (req, res) => {
    try {
      const w = await warehouseModel.create(req.body);
      res.status(201).json(w);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/warehouses/:id', authMiddleware, requireRole('stock_manager'), async (req, res) => {
    try { const w = await warehouseModel.findById(req.params.id); res.json(w); } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Stock Lots CRUD
  router.post('/lots', authMiddleware, requireRole('stock_manager'), async (req, res) => {
    try { const created = await lotModel.create(req.body); res.status(201).json(created); } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/lots/:id', authMiddleware, requireRole('stock_manager'), async (req, res) => {
    try { const l = await lotModel.findById(req.params.id); res.json(l); } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Reorder rules
  router.post('/reorder_rules', authMiddleware, requireRole('stock_manager'), async (req, res) => {
    try { const r = await ruleModel.create(req.body); res.status(201).json(r); } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/reorder_rules/product/:productId', authMiddleware, requireRole('stock_manager'), async (req, res) => {
    try { const rules = await ruleModel.listActiveForProduct(req.params.productId, req.query.company_id); res.json(rules); } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};

const express = require('express');
const router = express.Router();

module.exports = function({ db }) {
  const StockPicking = require('../models/StockPicking');
  const StockMove = require('../models/StockMove').StockMove;
  const pickingModel = new StockPicking(db);
  const moveModel = new StockMove(db);

  router.post('/', async (req, res) => {
    try {
      const { company_id, picking_type } = req.body;
      if (!company_id || !picking_type) return res.status(400).json({ error: 'company_id and picking_type are required' });
      const picking = await pickingModel.create(req.body);
      res.json(picking);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const picking = await pickingModel.findById(req.params.id);
      res.json(picking);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/add_move', async (req, res) => {
    try {
      const { move } = req.body; // should contain move data
      if (!move || !move.product_id || !move.quantity) return res.status(400).json({ error: 'move.product_id and move.quantity required' });
      const createdMove = await moveModel.create(move);
      const link = await pickingModel.addMove(req.params.id, createdMove.id, req.body.sequence || 0);
      res.json({ createdMove, link });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/confirm', async (req, res) => {
    try {
      const updated = await pickingModel.confirm(req.params.id);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};

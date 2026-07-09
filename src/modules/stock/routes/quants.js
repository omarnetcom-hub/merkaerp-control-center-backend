const express = require('express');
const router = express.Router();

module.exports = function({ db }) {
  const StockQuant = require('../models/StockQuant');
  const quant = new StockQuant(db);

  router.get('/qty', async (req, res) => {
    try {
      const productId = req.query.product_id;
      const locationId = req.query.location_id;
      const lotId = req.query.lot_id || null;
      if (!productId || !locationId) return res.status(400).json({ error: 'product_id and location_id are required' });
      const total = await quant.getQuantity(productId, locationId, lotId);
      res.json({ product_id: productId, location_id: locationId, lot_id: lotId, total });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/adjust', async (req, res) => {
    try {
      const { product_id, location_id, delta_qty, unit_cost, lot_id } = req.body;
      if (!product_id || !location_id || delta_qty === undefined) return res.status(400).json({ error: 'product_id, location_id and delta_qty are required' });
      const adjusted = await quant.adjustQuant(product_id, location_id, delta_qty, unit_cost, lot_id);
      res.json(adjusted);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};

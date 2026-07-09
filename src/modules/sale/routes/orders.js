const express = require('express');
const router = express.Router();
const { SaleOrder, SaleOrderLine } = require('../models/Sale');

const authMiddleware = require('../../../middleware/auth');

let db;

function setDatabase(database) {
  db = database;
}

const saleOrderModel = new SaleOrder(db);
const saleOrderLineModel = new SaleOrderLine(db);

// POST /api/sale-orders - Create sale order
router.post('/', authMiddleware, async (req, res) => {
  try {
    const order = await saleOrderModel.create(req.body);
    res.status(201).json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/sale-orders/:id - Get sale order
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const order = await saleOrderModel.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Sale order not found' });
    }
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/sale-orders - List sale orders by state
router.get('/', authMiddleware, async (req, res) => {
  try {
    const state = req.query.state || 'draft';
    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;
    const orders = await saleOrderModel.list(state, limit, offset);
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/sale-orders/partner/:partnerId - Get orders by partner
router.get('/partner/:partnerId', authMiddleware, async (req, res) => {
  try {
    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;
    const orders = await saleOrderModel.findByPartner(req.params.partnerId, limit, offset);
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/sale-orders/:id - Update sale order
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const order = await saleOrderModel.update(req.params.id, req.body);
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sale-orders/:id/confirm - Confirm sale order
router.post('/:id/confirm', authMiddleware, async (req, res) => {
  try {
    const order = await saleOrderModel.confirm(req.params.id);
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sale-orders/:id/cancel - Cancel sale order
router.post('/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const order = await saleOrderModel.cancel(req.params.id);
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sale-orders/:id/lines - Add line to order
router.post('/:id/lines', authMiddleware, async (req, res) => {
  try {
    const { product_id, quantity, price_unit } = req.body;
    const subtotal = quantity * price_unit;
    
    const line = await saleOrderLineModel.create({
      order_id: req.params.id,
      product_id,
      quantity,
      price_unit,
      subtotal
    });
    
    res.status(201).json(line);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/sale-orders/:id/lines - Get order lines
router.get('/:id/lines', authMiddleware, async (req, res) => {
  try {
    const lines = await saleOrderLineModel.getOrderLines(req.params.id);
    res.json(lines);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/sale-orders/lines/:lineId - Update order line
router.put('/lines/:lineId', authMiddleware, async (req, res) => {
  try {
    const line = await saleOrderLineModel.update(req.params.lineId, req.body);
    res.json(line);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/sale-orders/lines/:lineId - Delete order line
router.delete('/lines/:lineId', authMiddleware, async (req, res) => {
  try {
    await saleOrderLineModel.delete(req.params.lineId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = { router, setDatabase };

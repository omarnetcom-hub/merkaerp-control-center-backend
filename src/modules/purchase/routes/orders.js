const express = require('express');
const router = express.Router();
const { PurchaseOrder, PurchaseOrderLine } = require('../models/Purchase');

const authMiddleware = require('../../../middleware/auth');

let db;
let purchaseOrderModel;
let purchaseOrderLineModel;

function setDatabase(database) {
  db = database;
  purchaseOrderModel = new PurchaseOrder(db);
  purchaseOrderLineModel = new PurchaseOrderLine(db);
}

// POST /api/purchase-orders - Create purchase order
router.post('/', authMiddleware, async (req, res) => {
  try {
    const order = await purchaseOrderModel.create(req.body);
    res.status(201).json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/purchase-orders/:id - Get purchase order
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const order = await purchaseOrderModel.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Purchase order not found' });
    }
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/purchase-orders - List purchase orders by state
router.get('/', authMiddleware, async (req, res) => {
  try {
    const state = req.query.state || 'draft';
    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;
    const orders = await purchaseOrderModel.list(state, limit, offset);
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/purchase-orders/supplier/:supplierId - Get orders by supplier
router.get('/supplier/:supplierId', authMiddleware, async (req, res) => {
  try {
    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;
    const orders = await purchaseOrderModel.findByPartner(req.params.supplierId, limit, offset);
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/purchase-orders/:id - Update purchase order
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const order = await purchaseOrderModel.update(req.params.id, req.body);
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/purchase-orders/:id/confirm - Confirm purchase order
router.post('/:id/confirm', authMiddleware, async (req, res) => {
  try {
    const confirmFn = purchaseOrderModel.confirmWithPicking ? purchaseOrderModel.confirmWithPicking.bind(purchaseOrderModel) : purchaseOrderModel.confirm.bind(purchaseOrderModel);
    const order = await confirmFn(req.params.id);
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/purchase-orders/:id/cancel - Cancel purchase order
router.post('/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const order = await purchaseOrderModel.cancel(req.params.id);
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/purchase-orders/:id/lines - Add line to order
router.post('/:id/lines', authMiddleware, async (req, res) => {
  try {
    const { product_id, quantity, price_unit } = req.body;
    const subtotal = quantity * price_unit;
    
    const line = await purchaseOrderLineModel.create({
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

// GET /api/purchase-orders/:id/lines - Get order lines
router.get('/:id/lines', authMiddleware, async (req, res) => {
  try {
    const lines = await purchaseOrderLineModel.getOrderLines(req.params.id);
    res.json(lines);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/purchase-orders/lines/:lineId - Update order line
router.put('/lines/:lineId', authMiddleware, async (req, res) => {
  try {
    const line = await purchaseOrderLineModel.update(req.params.lineId, req.body);
    res.json(line);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/purchase-orders/lines/:lineId - Delete order line
router.delete('/lines/:lineId', authMiddleware, async (req, res) => {
  try {
    await purchaseOrderLineModel.delete(req.params.lineId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = { router, setDatabase };

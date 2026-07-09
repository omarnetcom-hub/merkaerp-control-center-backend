const express = require('express');
const router = express.Router();
const Product = require('../models/Product');

const authMiddleware = require('../../../middleware/auth');

let db;

function setDatabase(database) {
  db = database;
}

const productModel = new Product(db);

// POST /api/products - Create product
router.post('/', authMiddleware, async (req, res) => {
  try {
    const product = await productModel.create(req.body);
    res.status(201).json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/products/:id - Get product
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const product = await productModel.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/products/code/:code - Get product by code
router.get('/code/:code', authMiddleware, async (req, res) => {
  try {
    const product = await productModel.findByCode(req.params.code);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/products - List products
router.get('/', authMiddleware, async (req, res) => {
  try {
    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;
    const products = await productModel.list(limit, offset);
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/products/search/:term - Search products
router.get('/search/:term', authMiddleware, async (req, res) => {
  try {
    const products = await productModel.search(req.params.term);
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/products/category/:categoryId - Get products by category
router.get('/category/:categoryId', authMiddleware, async (req, res) => {
  try {
    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;
    const products = await productModel.listByCategory(req.params.categoryId, limit, offset);
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/products/:id - Update product
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const product = await productModel.update(req.params.id, req.body);
    res.json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/products/:id - Delete product
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await productModel.delete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/products/:id/variants - Get product variants
router.get('/:id/variants', authMiddleware, async (req, res) => {
  try {
    const variants = await productModel.getVariants(req.params.id);
    res.json(variants);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = { router, setDatabase };

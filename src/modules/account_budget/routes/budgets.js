const express = require('express');
const router = express.Router();
const { Budget, BudgetLine, BudgetCommitment } = require('../models/Budget');
const authMiddleware = require('../../../middleware/auth');

let db;
let budgetModel;
let budgetLineModel;
let budgetCommitmentModel;

function setDatabase(database) {
  db = database;
  budgetModel = new Budget(db);
  budgetLineModel = new BudgetLine(db);
  budgetCommitmentModel = new BudgetCommitment(db);
}

// Create budget
router.post('/', authMiddleware, async (req, res) => {
  try {
    const budget = await budgetModel.create(req.body);
    res.status(201).json(budget);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get budget
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const budget = await budgetModel.findById(req.params.id);
    if (!budget) return res.status(404).json({ error: 'Budget not found' });
    res.json(budget);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List budgets
router.get('/', authMiddleware, async (req, res) => {
  try {
    const fiscal_year = req.query.fiscal_year || null;
    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;
    const budgets = await budgetModel.list(fiscal_year, limit, offset);
    res.json(budgets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Budget lines
router.post('/:id/lines', authMiddleware, async (req, res) => {
  try {
    const lineData = { ...req.body, budget_id: req.params.id };
    const line = await budgetLineModel.create(lineData);
    res.status(201).json(line);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/lines', authMiddleware, async (req, res) => {
  try {
    const lines = await budgetLineModel.listByBudget(req.params.id);
    res.json(lines);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Commitments
router.post('/lines/:lineId/commitments', authMiddleware, async (req, res) => {
  try {
    const commitment = await budgetCommitmentModel.create({ budget_line_id: req.params.lineId, ...req.body });
    res.status(201).json(commitment);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/commitments/:id/confirm', authMiddleware, async (req, res) => {
  try {
    const c = await budgetCommitmentModel.findById(req.params.id);
    if (!c) return res.status(404).json({ error: 'Commitment not found' });
    // Validate availability
    const line = await budgetLineModel.findById(c.budget_line_id);
    if (!line) return res.status(404).json({ error: 'Budget line not found' });
    const available = parseFloat(line.available_amount || 0);
    if (c.amount > available) return res.status(400).json({ error: 'Insufficient budget available' });

    // Confirm commitment and update amounts
    await budgetCommitmentModel.updateState(req.params.id, 'confirmed');
    await budgetLineModel.updateAmounts(line.id, { committed: c.amount });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = { router, setDatabase };

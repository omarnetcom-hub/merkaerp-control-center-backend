const express = require('express');
const router = express.Router();
const User = require('../models/User');

// Middleware
const authMiddleware = require('../../../middleware/auth');

let db; // Will be injected

function setDatabase(database) {
  db = database;
}

const userModel = new User(db);

// POST /api/users - Create user
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, email, login, password, company_id } = req.body;
    
    if (!name || !email || !login || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const user = await userModel.create({
      name,
      email,
      login,
      password: require('bcrypt').hashSync(password, 10),
      company_id
    });

    res.status(201).json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/users/:id - Get user by ID
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const user = await userModel.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/users - List users
router.get('/', authMiddleware, async (req, res) => {
  try {
    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;
    const users = await userModel.list(limit, offset);
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/users/:id - Update user
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const user = await userModel.update(req.params.id, req.body);
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/users/:id - Delete user
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await userModel.delete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/users/:id/roles/:roleId - Assign role
router.post('/:id/roles/:roleId', authMiddleware, async (req, res) => {
  try {
    await userModel.assignRole(req.params.id, req.params.roleId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/users/:id/roles - Get user roles
router.get('/:id/roles', authMiddleware, async (req, res) => {
  try {
    const roles = await userModel.getUserRoles(req.params.id);
    res.json(roles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = { router, setDatabase };

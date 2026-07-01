const express = require('express');
const router = express.Router();
const { getDatabase } = require('../database/db');
const { authenticateToken } = require('./auth');

// GET /api/v1/admin/users - Listar todos los usuarios
router.get('/users', authenticateToken, async (req, res) => {
  const db = getDatabase();
  
  try {
    const users = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, username, email, full_name, company_id, role, 
                created_at, updated_at, last_login, is_active 
         FROM users 
         ORDER BY created_at DESC`,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    res.json({
      success: true,
      count: users.length,
      users: users
    });
  } catch (error) {
    console.error('Error getting users:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/admin/users/:id - Obtener detalles de un usuario
router.get('/users/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  
  try {
    const user = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id, username, email, full_name, company_id, role, 
                created_at, updated_at, last_login, is_active 
         FROM users 
         WHERE id = ?`,
        [id],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      user
    });
  } catch (error) {
    console.error('Error getting user:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/admin/users - Crear nuevo usuario
router.post('/users', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { username, email, password, fullName, companyId, role } = req.body;
  const { v4: uuidv4 } = require('uuid');
  const bcrypt = require('bcrypt');

  try {
    // Verificar si el usuario ya existe
    const existingUser = await new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM users WHERE username = ? OR email = ?',
        [username, email],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (existingUser) {
      return res.status(409).json({
        error: 'User already exists',
        message: 'Username or email already registered'
      });
    }

    // Hash de la contraseña
    const passwordHash = await bcrypt.hash(password, 10);

    // Crear usuario
    const userId = uuidv4();
    const now = new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO users (
          id, username, email, password_hash, full_name, company_id, 
          role, created_at, updated_at, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          username,
          email,
          passwordHash,
          fullName || username,
          companyId || null,
          role || 'user',
          now,
          now,
          1
        ],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      userId
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// PUT /api/v1/admin/users/:id - Actualizar usuario
router.put('/users/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  const { fullName, companyId, role, isActive } = req.body;

  try {
    const now = new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE users 
         SET full_name = ?, company_id = ?, role = ?, is_active = ?, updated_at = ?
         WHERE id = ?`,
        [
          fullName,
          companyId,
          role,
          isActive !== undefined ? (isActive ? 1 : 0) : 1,
          now,
          id
        ],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({
      success: true,
      message: 'User updated successfully'
    });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// DELETE /api/v1/admin/users/:id - Eliminar usuario
router.delete('/users/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;

  try {
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM users WHERE id = ?', [id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/admin/stats - Obtener estadísticas del sistema
router.get('/stats', authenticateToken, async (req, res) => {
  const db = getDatabase();

  try {
    // Contar usuarios
    const totalUsers = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM users', (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    // Contar usuarios activos
    const activeUsers = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM users WHERE is_active = 1', (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    // Contar instalaciones
    const totalInstallations = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM installations', (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    // Contar eventos de sincronización
    const totalSyncEvents = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM sync_events', (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    // Contar heartbeats en las últimas 24 horas
    const recentHeartbeats = await new Promise((resolve, reject) => {
      db.get(
        `SELECT COUNT(*) as count FROM heartbeats 
         WHERE received_at > datetime('now', '-24 hours')`,
        (err, row) => {
          if (err) reject(err);
          else resolve(row.count);
        }
      );
    });

    res.json({
      success: true,
      stats: {
        totalUsers,
        activeUsers,
        totalInstallations,
        totalSyncEvents,
        recentHeartbeats,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/admin/sync-events - Listar eventos de sincronización
router.get('/sync-events', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { limit = 50, offset = 0, userId } = req.query;

  try {
    let query = `
      SELECT se.*, u.username 
      FROM sync_events se
      LEFT JOIN users u ON se.user_id = u.id
    `;
    const params = [];

    if (userId) {
      query += ' WHERE se.user_id = ?';
      params.push(userId);
    }

    query += ' ORDER BY se.timestamp DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const events = await new Promise((resolve, reject) => {
      db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    res.json({
      success: true,
      count: events.length,
      events
    });
  } catch (error) {
    console.error('Error getting sync events:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/admin/installations - Listar instalaciones
router.get('/installations', authenticateToken, async (req, res) => {
  const db = getDatabase();

  try {
    const installations = await new Promise((resolve, reject) => {
      db.all(
        `SELECT i.*, 
                (SELECT COUNT(*) FROM heartbeats h WHERE h.installation_id = i.id AND h.received_at > datetime('now', '-24 hours')) as recent_heartbeats
         FROM installations i
         ORDER BY i.created_at DESC`,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    res.json({
      success: true,
      count: installations.length,
      installations
    });
  } catch (error) {
    console.error('Error getting installations:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

module.exports = router;

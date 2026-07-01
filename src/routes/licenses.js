const express = require('express');
const router = express.Router();
const { getDatabase } = require('../database/db');
const { authenticateToken } = require('./auth');

// GET /api/v1/licenses - Listar todas las licencias
router.get('/', authenticateToken, async (req, res) => {
  const db = getDatabase();
  
  try {
    const licenses = await new Promise((resolve, reject) => {
      db.all(
        `SELECT l.*, c.name as client_name, c.nit as client_nit 
         FROM cc_licenses l
         LEFT JOIN cc_clients c ON l.client_id = c.id
         ORDER BY l.updated_at DESC`,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    res.json({
      success: true,
      count: licenses.length,
      licenses: licenses
    });
  } catch (error) {
    console.error('Error getting licenses:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/licenses/:id - Obtener detalles de una licencia
router.get('/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  
  try {
    const license = await new Promise((resolve, reject) => {
      db.get(
        `SELECT l.*, c.name as client_name, c.nit as client_nit 
         FROM cc_licenses l
         LEFT JOIN cc_clients c ON l.client_id = c.id
         WHERE l.id = ?`,
        [id],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!license) {
      return res.status(404).json({
        error: 'License not found'
      });
    }

    res.json({
      success: true,
      license
    });
  } catch (error) {
    console.error('Error getting license:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/licenses - Crear nueva licencia
router.post('/', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { 
    clientId, 
    type, 
    status, 
    expiresAt, 
    maxUsers, 
    maxDevices, 
    maxBranches, 
    modules,
    tokenHint 
  } = req.body;

  try {
    const now = new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO cc_licenses (
          client_id, type, status, expires_at, max_users, max_devices, 
          max_branches, modules, token_hint, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          clientId,
          type,
          status,
          expiresAt,
          maxUsers,
          maxDevices,
          maxBranches,
          modules,
          tokenHint || null,
          now
        ],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.status(201).json({
      success: true,
      message: 'License created successfully'
    });
  } catch (error) {
    console.error('Error creating license:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// PUT /api/v1/licenses/:id - Actualizar licencia
router.put('/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  const { 
    type, 
    status, 
    expiresAt, 
    maxUsers, 
    maxDevices, 
    maxBranches, 
    modules,
    tokenHint 
  } = req.body;

  try {
    const now = new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE cc_licenses 
         SET type = ?, status = ?, expires_at = ?, max_users = ?, max_devices = ?, 
             max_branches = ?, modules = ?, token_hint = ?, updated_at = ?
         WHERE id = ?`,
        [
          type,
          status,
          expiresAt,
          maxUsers,
          maxDevices,
          maxBranches,
          modules,
          tokenHint,
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
      message: 'License updated successfully'
    });
  } catch (error) {
    console.error('Error updating license:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// DELETE /api/v1/licenses/:id - Eliminar licencia
router.delete('/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;

  try {
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM cc_licenses WHERE id = ?', [id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({
      success: true,
      message: 'License deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting license:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/licenses/validate - Validar licencia (sin auth para uso de MerkaERP)
router.post('/validate', async (req, res) => {
  const db = getDatabase();
  const { installationId, taxId } = req.body;

  try {
    // Buscar licencia activa para la instalación
    const license = await new Promise((resolve, reject) => {
      db.get(
        `SELECT l.*, c.name as client_name, c.nit as client_nit 
         FROM cc_licenses l
         LEFT JOIN cc_clients c ON l.client_id = c.id
         WHERE l.status = 'active' 
         AND (c.nit = ? OR l.token_hint = ?)
         AND l.expires_at > datetime('now')
         ORDER BY l.expires_at DESC
         LIMIT 1`,
        [taxId, installationId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!license) {
      return res.json({
        valid: false,
        message: 'No active license found for this installation'
      });
    }

    // Verificar si la licencia está expirada
    const expiryDate = new Date(license.expires_at);
    const now = new Date();
    
    if (expiryDate < now) {
      return res.json({
        valid: false,
        message: 'License expired',
        licenseInfo: license
      });
    }

    res.json({
      valid: true,
      message: 'License valid',
      licenseInfo: {
        type: license.type,
        maxUsers: license.max_users,
        maxDevices: license.max_devices,
        maxBranches: license.max_branches,
        modules: license.modules,
        expiresAt: license.expires_at
      }
    });
  } catch (error) {
    console.error('Error validating license:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

module.exports = router;

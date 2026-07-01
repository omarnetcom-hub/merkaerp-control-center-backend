const express = require('express');
const router = express.Router();
const { getDatabase } = require('../database/db');
const { v4: uuidv4 } = require('uuid');

// GET /api/v1/commands/:id/ack - Acknowledge command
router.post('/:id/ack', async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  const { installationId, status = 'done' } = req.body;

  try {
    const now = new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE remote_commands SET 
          status = ?, 
          acknowledged_at = ?, 
          result = ?
         WHERE id = ? AND installation_id = ?`,
        [status, now, JSON.stringify(req.body), id, installationId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({
      success: true,
      message: 'Command acknowledged'
    });
  } catch (error) {
    console.error('Error acknowledging command:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/commands - Crear nuevo comando remoto
router.post('/', async (req, res) => {
  const db = getDatabase();
  const { installationId, action, params } = req.body;

  try {
    const commandId = uuidv4();
    const now = new Date().toISOString();

    // Verificar que la instalación existe
    const installation = await new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM installations WHERE id = ?',
        [installationId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!installation) {
      return res.status(404).json({
        error: 'Installation not found'
      });
    }

    // Crear comando
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO remote_commands (
          id, installation_id, action, params, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [commandId, installationId, action, JSON.stringify(params || {}), 'pending', now],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({
      success: true,
      commandId,
      message: 'Command created'
    });
  } catch (error) {
    console.error('Error creating command:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/commands - Listar comandos
router.get('/', async (req, res) => {
  const db = getDatabase();
  const { installation_id, status, limit = 50 } = req.query;

  try {
    let whereClause = '';
    const params = [];

    if (installation_id) {
      whereClause += 'installation_id = ?';
      params.push(installation_id);
    }

    if (status) {
      if (whereClause) whereClause += ' AND ';
      whereClause += 'status = ?';
      params.push(status);
    }

    const commands = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM remote_commands ${whereClause ? 'WHERE ' + whereClause : ''} ORDER BY created_at DESC LIMIT ?`,
        [...params, parseInt(limit)],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    res.json({
      success: true,
      count: commands.length,
      commands
    });
  } catch (error) {
    console.error('Error fetching commands:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// DELETE /api/v1/commands/:id - Eliminar comando
router.delete('/:id', async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;

  try {
    await new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM remote_commands WHERE id = ?',
        [id],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({
      success: true,
      message: 'Command deleted'
    });
  } catch (error) {
    console.error('Error deleting command:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

module.exports = router;

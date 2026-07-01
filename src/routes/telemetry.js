const express = require('express');
const router = express.Router();
const { getDatabase } = require('../database/db');

// POST /api/v1/telemetry/events
router.post('/events', async (req, res) => {
  const db = getDatabase();
  const {
    companyName,
    taxId,
    event,
    module,
    severity = 'info'
  } = req.body;

  try {
    const now = new Date().toISOString();

    // Intentar obtener installation_id desde el taxId o companyName
    let installationId = null;
    if (taxId) {
      const installation = await new Promise((resolve, reject) => {
        db.get(
          'SELECT id FROM installations WHERE tax_id = ? LIMIT 1',
          [taxId],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });
      if (installation) installationId = installation.id;
    }

    // Registrar evento de telemetría
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO telemetry_events (
          installation_id, company_name, tax_id, event, 
          module, severity, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          installationId,
          companyName,
          taxId,
          event,
          module,
          severity,
          now
        ],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({
      success: true,
      message: 'Event received'
    });
  } catch (error) {
    console.error('Error processing telemetry event:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/telemetry/events - Listar eventos de telemetría
router.get('/events', async (req, res) => {
  const db = getDatabase();
  const { installation_id, limit = 50, offset = 0 } = req.query;

  try {
    let whereClause = '';
    const params = [];

    if (installation_id) {
      whereClause = 'WHERE installation_id = ?';
      params.push(installation_id);
    }

    const events = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM telemetry_events ${whereClause} ORDER BY received_at DESC LIMIT ? OFFSET ?`,
        [...params, parseInt(limit), parseInt(offset)],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    // Obtener total count
    const countResult = await new Promise((resolve, reject) => {
      db.get(
        `SELECT COUNT(*) as total FROM telemetry_events ${whereClause}`,
        params,
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    res.json({
      success: true,
      count: countResult.total,
      events
    });
  } catch (error) {
    console.error('Error fetching telemetry events:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/telemetry/stats - Estadísticas de telemetría
router.get('/stats', async (req, res) => {
  const db = getDatabase();

  try {
    const stats = await new Promise((resolve, reject) => {
      db.all(
        `SELECT 
          module,
          severity,
          COUNT(*) as count
         FROM telemetry_events
         WHERE received_at >= datetime('now', '-7 days')
         GROUP BY module, severity
         ORDER BY count DESC`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Error fetching telemetry stats:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

module.exports = router;

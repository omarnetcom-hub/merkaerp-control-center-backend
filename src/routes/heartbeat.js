const express = require('express');
const router = express.Router();
const { getDatabase } = require('../database/db');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('./auth');

// POST /api/v1/installations/heartbeat
router.post('/heartbeat', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const {
    installationId,
    companyName,
    taxId,
    version,
    os,
    licenseStatus,
    licensePlan,
    licenseExpiry,
    syncStatus,
    databaseStatus,
    criticalErrors,
    updateAvailable,
    updateVersion,
    metrics
  } = req.body;

  const userId = req.user.userId;

  try {
    const now = new Date().toISOString();

    // Verificar si la instalación existe y está bloqueada
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

    // Si está bloqueada, retornar error
    if (installation && installation.blocked === 1) {
      return res.status(403).json({
        error: 'Installation blocked',
        reason: installation.blocked_reason || 'Blocked by Control Center'
      });
    }

    // Insertar o actualizar instalación
    if (installation) {
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE installations SET 
            company_name = ?, 
            tax_id = ?, 
            version = ?, 
            os = ?, 
            license_status = ?, 
            license_plan = ?, 
            license_expiry = ?, 
            updated_at = ?, 
            last_heartbeat = ?
           WHERE id = ?`,
          [
            companyName,
            taxId,
            version,
            os,
            licenseStatus,
            licensePlan,
            licenseExpiry,
            now,
            now,
            installationId
          ],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    } else {
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO installations (
            id, company_name, tax_id, version, os, 
            license_status, license_plan, license_expiry, 
            status, created_at, updated_at, last_heartbeat
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            installationId,
            companyName,
            taxId,
            version,
            os,
            licenseStatus,
            licensePlan,
            licenseExpiry,
            'active',
            now,
            now,
            now
          ],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    }

    // Registrar heartbeat
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO heartbeats (
          installation_id, company_name, tax_id, version, os,
          license_status, license_plan, license_expiry, sync_status,
          database_status, critical_errors, update_available,
          update_version, metrics, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          installationId,
          companyName,
          taxId,
          version,
          os,
          licenseStatus,
          licensePlan,
          licenseExpiry,
          syncStatus,
          databaseStatus,
          criticalErrors || 0,
          updateAvailable ? 1 : 0,
          updateVersion,
          JSON.stringify(metrics || {}),
          now
        ],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Limpiar heartbeats antiguos (más de 30 días)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM heartbeats WHERE received_at < ?',
        [thirtyDaysAgo],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({
      success: true,
      message: 'Heartbeat received',
      timestamp: now
    });
  } catch (error) {
    console.error('Error processing heartbeat:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/sync/push - Recibir datos de sincronización desde el cliente
router.post('/sync/push', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { installationId, events } = req.body;
  const userId = req.user.userId;

  try {
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

    // Procesar cada evento de sincronización
    let processedCount = 0;
    for (const event of events) {
      const { type, table, data, operation, timestamp, eventId } = event;

      // Guardar evento en la tabla de eventos de sincronización con user_id
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO sync_events (
            event_id, user_id, installation_id, table_name, operation, 
            data, timestamp, processed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            eventId || uuidv4(),
            userId,
            installationId,
            table,
            operation,
            JSON.stringify(data),
            timestamp,
            now
          ],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      processedCount++;
    }

    res.json({
      success: true,
      message: 'Sync events received',
      processedCount,
      timestamp: now
    });
  } catch (error) {
    console.error('Error processing sync push:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/sync/pull - Obtener cambios desde el servidor para el cliente
router.get('/sync/pull', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { installationId, lastSyncTimestamp } = req.query;
  const userId = req.user.userId;

  try {
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

    // Obtener eventos de sincronización desde el último sync, filtrados por usuario
    const lastSync = lastSyncTimestamp || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    const events = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM sync_events 
         WHERE user_id = ? AND timestamp > ?
         ORDER BY timestamp ASC`,
        [userId, lastSync],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    res.json({
      success: true,
      events: events.map(e => ({
        eventId: e.event_id,
        table: e.table_name,
        operation: e.operation,
        data: JSON.parse(e.data),
        timestamp: e.timestamp,
        installationId: e.installation_id
      })),
      lastSyncTimestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error processing sync pull:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/sync/conflicts - Obtener conflictos de sincronización
router.get('/sync/conflicts', async (req, res) => {
  const db = getDatabase();
  const { installationId } = req.query;

  try {
    const conflicts = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM sync_conflicts 
         WHERE installation_id = ? AND resolved = 0
         ORDER BY created_at DESC`,
        [installationId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    res.json({
      success: true,
      conflicts: conflicts.map(c => ({
        id: c.id,
        table: c.table_name,
        recordId: c.record_id,
        localData: JSON.parse(c.local_data),
        remoteData: JSON.parse(c.remote_data),
        createdAt: c.created_at
      }))
    });
  } catch (error) {
    console.error('Error fetching sync conflicts:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/sync/conflicts/:id/resolve - Resolver conflicto de sincronización
router.post('/sync/conflicts/:id/resolve', async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  const { resolution, data } = req.body;

  try {
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE sync_conflicts SET 
          resolved = 1, 
          resolution = ?, 
          resolved_data = ?, 
          resolved_at = ?
         WHERE id = ?`,
        [resolution, JSON.stringify(data), new Date().toISOString(), id],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({
      success: true,
      message: 'Conflict resolved'
    });
  } catch (error) {
    console.error('Error resolving sync conflict:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/installations - Listar todas las instalaciones
router.get('/', async (req, res) => {
  const db = getDatabase();

  try {
    const installations = await new Promise((resolve, reject) => {
      db.all(
        `SELECT 
          i.*,
          (SELECT COUNT(*) FROM heartbeats WHERE installation_id = i.id) as heartbeat_count,
          (SELECT received_at FROM heartbeats WHERE installation_id = i.id ORDER BY received_at DESC LIMIT 1) as last_heartbeat_at
         FROM installations i 
         ORDER BY i.created_at DESC`,
        [],
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
    console.error('Error fetching installations:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/installations/:id - Obtener detalles de una instalación
router.get('/:id', async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;

  try {
    const installation = await new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM installations WHERE id = ?',
        [id],
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

    // Obtener heartbeats recientes
    const recentHeartbeats = await new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM heartbeats WHERE installation_id = ? ORDER BY received_at DESC LIMIT 10',
        [id],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    res.json({
      success: true,
      installation,
      recentHeartbeats
    });
  } catch (error) {
    console.error('Error fetching installation:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/installations/:id/block - Bloquear instalación
router.post('/:id/block', async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  const { reason } = req.body;

  try {
    await new Promise((resolve, reject) => {
      db.run(
        'UPDATE installations SET blocked = 1, blocked_reason = ?, updated_at = ? WHERE id = ?',
        [reason || 'Blocked by admin', new Date().toISOString(), id],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({
      success: true,
      message: 'Installation blocked'
    });
  } catch (error) {
    console.error('Error blocking installation:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/installations/:id/unblock - Desbloquear instalación
router.post('/:id/unblock', async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;

  try {
    await new Promise((resolve, reject) => {
      db.run(
        'UPDATE installations SET blocked = 0, blocked_reason = NULL, updated_at = ? WHERE id = ?',
        [new Date().toISOString(), id],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({
      success: true,
      message: 'Installation unblocked'
    });
  } catch (error) {
    console.error('Error unblocking installation:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

module.exports = router;

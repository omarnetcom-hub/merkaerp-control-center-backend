const express = require('express');
const router = express.Router();
const { query, queryAll, queryGet } = require('../database/db');

// GET /api/v1/installations/:id/commands - Obtener comandos pendientes para una instalación
router.get('/:id/commands', async (req, res) => {
  const { id } = req.params;

  try {
    // Verificar si la instalación está bloqueada
    const installation = await queryGet(
      'SELECT * FROM installations WHERE id = ?',
      [id]
    );

    if (!installation) {
      return res.status(404).json({
        error: 'Installation not found'
      });
    }

    if (installation.blocked === 1) {
      return res.status(403).json({
        error: 'Installation blocked',
        reason: installation.blocked_reason || 'Blocked by Control Center',
        commands: []
      });
    }

    // Obtener comandos pendientes
    const commands = await queryAll(
      `SELECT * FROM remote_commands 
       WHERE installation_id = ? AND status = 'pending'
       ORDER BY created_at ASC`,
      [id]
    );

    res.json({
      success: true,
      commands: commands.map(cmd => ({
        id: cmd.id,
        action: cmd.action,
        params: JSON.parse(cmd.params || '{}'),
        created_at: cmd.created_at
      }))
    });
  } catch (error) {
    console.error('Error fetching commands for installation:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/installations/:id/rollback - Solicitar rollback de actualización
router.post('/:id/rollback', async (req, res) => {
  const { id } = req.params;

  try {
    // Verificar que la instalación existe
    const installation = await queryGet(
      'SELECT * FROM installations WHERE id = ?',
      [id]
    );

    if (!installation) {
      return res.status(404).json({
        error: 'Installation not found'
      });
    }

    // Crear comando de rollback
    const { v4: uuidv4 } = require('uuid');
    const commandId = uuidv4();
    const now = new Date().toISOString();

    await query(
      `INSERT INTO remote_commands (
        id, installation_id, action, params, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [commandId, id, 'rollback_actualizacion', '{}', 'pending', now]
    );

    res.json({
      success: true,
      message: 'Rollback command queued',
      commandId
    });
  } catch (error) {
    console.error('Error requesting rollback:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/installations/:id/license - Actualizar licencia de instalación
router.post('/:id/license', async (req, res) => {
  const { id } = req.params;
  const { plan, estado, fecha_expiracion, modulos, limite_db_mb } = req.body;

  try {
    // Verificar que la instalación existe
    const installation = await queryGet(
      'SELECT * FROM installations WHERE id = ?',
      [id]
    );

    if (!installation) {
      return res.status(404).json({
        error: 'Installation not found'
      });
    }

    const now = new Date().toISOString();

    // Actualizar o crear licencia
    const existingLicense = await queryGet(
      'SELECT * FROM licenses WHERE installation_id = ?',
      [id]
    );

    if (existingLicense) {
      await query(
        `UPDATE licenses SET 
          plan = ?, estado = ?, fecha_expiracion = ?, 
          modulos = ?, limite_db_mb = ?, updated_at = ?
         WHERE installation_id = ?`,
        [
          plan,
          estado,
          fecha_expiracion,
          JSON.stringify(modulos || []),
          limite_db_mb,
          now,
          id
        ]
      );
    } else {
      const { v4: uuidv4 } = require('uuid');
      await query(
        `INSERT INTO licenses (
          id, installation_id, plan, estado, fecha_expiracion,
          modulos, limite_db_mb, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          id,
          plan,
          estado,
          fecha_expiracion,
          JSON.stringify(modulos || []),
          limite_db_mb,
          now,
          now
        ]
      );
    }

    // Actualizar estado en installations
    await query(
      `UPDATE installations SET 
        license_status = ?, license_plan = ?, license_expiry = ?, updated_at = ?
       WHERE id = ?`,
      [estado, plan, fecha_expiracion, now, id]
    );

    // Crear comando para notificar al cliente
    const { v4: uuidv4 } = require('uuid');
    const commandId = uuidv4();
    await query(
      `INSERT INTO remote_commands (
        id, installation_id, action, params, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        commandId,
        id,
        'actualizar_licencia',
        JSON.stringify({ plan, estado, fecha_expiracion, modulos }),
        'pending',
        now
      ]
    );

    res.json({
      success: true,
      message: 'License updated',
      commandId
    });
  } catch (error) {
    console.error('Error updating license:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/installations/:id/license - Obtener licencia de instalación
router.get('/:id/license', async (req, res) => {
  const { id } = req.params;

  try {
    const license = await queryGet(
      'SELECT * FROM licenses WHERE installation_id = ?',
      [id]
    );

    if (!license) {
      return res.status(404).json({
        error: 'License not found'
      });
    }

    res.json({
      success: true,
      license: {
        ...license,
        modulos: JSON.parse(license.modulos || '[]')
      }
    });
  } catch (error) {
    console.error('Error fetching license:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { getDatabase } = require('../database/db');

// GET /api/v1/updates/check - Verificar actualizaciones disponibles
router.get('/check', async (req, res) => {
  const db = getDatabase();
  const { version, canal, os } = req.query;

  try {
    // Buscar actualización disponible para la versión actual y canal
    const update = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM updates 
         WHERE canal = ? 
         AND version > ?
         ORDER BY version DESC 
         LIMIT 1`,
        [canal || 'stable', version || '1.0.0'],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!update) {
      return res.json({
        disponible: false,
        version_actual: version,
        mensaje: 'No hay actualizaciones disponibles'
      });
    }

    res.json({
      disponible: true,
      version_actual: version,
      version: {
        version: update.version,
        canal: update.canal,
        fecha_publicacion: update.fecha_publicacion,
        url_descarga: update.url_descarga,
        tamano_bytes: update.tamano_bytes,
        sha256: update.sha256,
        notas: update.notas,
        obligatoria: update.obligatoria === 1
      }
    });
  } catch (error) {
    console.error('Error checking for updates:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/updates - Crear nueva actualización (admin)
router.post('/', async (req, res) => {
  const db = getDatabase();
  const {
    version,
    canal,
    fecha_publicacion,
    url_descarga,
    tamano_bytes,
    sha256,
    notas,
    obligatoria = false
  } = req.body;

  try {
    const now = new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO updates (
          version, canal, fecha_publicacion, url_descarga, 
          tamano_bytes, sha256, notas, obligatoria, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          version,
          canal,
          fecha_publicacion || now,
          url_descarga,
          tamano_bytes,
          sha256,
          notas,
          obligatoria ? 1 : 0,
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
      message: 'Update created'
    });
  } catch (error) {
    console.error('Error creating update:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/updates - Listar actualizaciones
router.get('/', async (req, res) => {
  const db = getDatabase();
  const { canal, limit = 20 } = req.query;

  try {
    let whereClause = '';
    const params = [];

    if (canal) {
      whereClause = 'WHERE canal = ?';
      params.push(canal);
    }

    const updates = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM updates ${whereClause} ORDER BY fecha_publicacion DESC LIMIT ?`,
        [...params, parseInt(limit)],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    res.json({
      success: true,
      count: updates.length,
      updates
    });
  } catch (error) {
    console.error('Error fetching updates:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// DELETE /api/v1/updates/:id - Eliminar actualización
router.delete('/:id', async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;

  try {
    await new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM updates WHERE id = ?',
        [id],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({
      success: true,
      message: 'Update deleted'
    });
  } catch (error) {
    console.error('Error deleting update:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

module.exports = router;

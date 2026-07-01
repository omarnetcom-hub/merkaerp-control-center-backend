const express = require('express');
const router = express.Router();
const { getDatabase } = require('../database/db');
const { authenticateToken } = require('./auth');

// GET /api/v1/leads - Listar todos los leads
router.get('/', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { status } = req.query;
  
  try {
    let query = 'SELECT * FROM cc_leads';
    const params = [];
    
    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY created_at DESC';
    
    const leads = await new Promise((resolve, reject) => {
      db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    res.json({
      success: true,
      count: leads.length,
      leads: leads
    });
  } catch (error) {
    console.error('Error getting leads:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/leads/:id - Obtener detalles de un lead
router.get('/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  
  try {
    const lead = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM cc_leads WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!lead) {
      return res.status(404).json({
        error: 'Lead not found'
      });
    }

    res.json({
      success: true,
      lead
    });
  } catch (error) {
    console.error('Error getting lead:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/leads - Crear nuevo lead
router.post('/', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { 
    name, 
    company, 
    email, 
    phone, 
    source, 
    status,
    notes,
    assignedTo
  } = req.body;

  try {
    const now = new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO cc_leads (
          name, company, email, phone, source, status, notes, 
          assigned_to, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          name,
          company,
          email,
          phone,
          source,
          status,
          notes,
          assignedTo || null,
          now,
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
      message: 'Lead created successfully'
    });
  } catch (error) {
    console.error('Error creating lead:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// PUT /api/v1/leads/:id - Actualizar lead
router.put('/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  const { 
    name, 
    company, 
    email, 
    phone, 
    source, 
    status,
    notes,
    assignedTo
  } = req.body;

  try {
    const now = new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE cc_leads 
         SET name = ?, company = ?, email = ?, phone = ?, source = ?, status = ?, 
             notes = ?, assigned_to = ?, updated_at = ?
         WHERE id = ?`,
        [
          name,
          company,
          email,
          phone,
          source,
          status,
          notes,
          assignedTo,
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
      message: 'Lead updated successfully'
    });
  } catch (error) {
    console.error('Error updating lead:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// DELETE /api/v1/leads/:id - Eliminar lead
router.delete('/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;

  try {
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM cc_leads WHERE id = ?', [id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({
      success: true,
      message: 'Lead deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting lead:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { getDatabase } = require('../database/db');
const { authenticateToken } = require('./auth');

// GET /api/v1/tickets - Listar todos los tickets
router.get('/', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { status, priority } = req.query;
  
  try {
    let query = `
      SELECT t.*, c.name as client_name 
      FROM cc_tickets t
      LEFT JOIN cc_clients c ON t.client_id = c.id
    `;
    const params = [];
    
    if (status) {
      query += ' WHERE t.status = ?';
      params.push(status);
    }
    
    if (priority) {
      query += status ? ' AND t.priority = ?' : ' WHERE t.priority = ?';
      params.push(priority);
    }
    
    query += ' ORDER BY t.created_at DESC';
    
    const tickets = await new Promise((resolve, reject) => {
      db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    res.json({
      success: true,
      count: tickets.length,
      tickets: tickets
    });
  } catch (error) {
    console.error('Error getting tickets:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/tickets/:id - Obtener detalles de un ticket
router.get('/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  
  try {
    const ticket = await new Promise((resolve, reject) => {
      db.get(
        `SELECT t.*, c.name as client_name 
         FROM cc_tickets t
         LEFT JOIN cc_clients c ON t.client_id = c.id
         WHERE t.id = ?`,
        [id],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!ticket) {
      return res.status(404).json({
        error: 'Ticket not found'
      });
    }

    res.json({
      success: true,
      ticket
    });
  } catch (error) {
    console.error('Error getting ticket:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/tickets - Crear nuevo ticket
router.post('/', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { 
    clientId, 
    title, 
    description, 
    category, 
    priority,
    assignedTo,
    slaHours
  } = req.body;

  try {
    const now = new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO cc_tickets (
          client_id, title, description, category, priority, status,
          assigned_to, created_at, updated_at, sla_hours
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          clientId,
          title,
          description,
          category,
          priority,
          'open',
          assignedTo || null,
          now,
          now,
          slaHours || 24
        ],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.status(201).json({
      success: true,
      message: 'Ticket created successfully'
    });
  } catch (error) {
    console.error('Error creating ticket:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// PUT /api/v1/tickets/:id - Actualizar ticket
router.put('/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  const { 
    title, 
    description, 
    category, 
    priority, 
    status,
    assignedTo,
    escalatedLevel
  } = req.body;

  try {
    const now = new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE cc_tickets 
         SET title = ?, description = ?, category = ?, priority = ?, status = ?, 
             assigned_to = ?, escalated_level = ?, updated_at = ?
         WHERE id = ?`,
        [
          title,
          description,
          category,
          priority,
          status,
          assignedTo,
          escalatedLevel,
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
      message: 'Ticket updated successfully'
    });
  } catch (error) {
    console.error('Error updating ticket:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// DELETE /api/v1/tickets/:id - Eliminar ticket
router.delete('/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;

  try {
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM cc_tickets WHERE id = ?', [id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({
      success: true,
      message: 'Ticket deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting ticket:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

module.exports = router;

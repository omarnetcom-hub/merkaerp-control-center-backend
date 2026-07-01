const express = require('express');
const router = express.Router();
const { getDatabase } = require('../database/db');
const { authenticateToken } = require('./auth');

// GET /api/v1/invoices - Listar todas las facturas
router.get('/', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { status } = req.query;
  
  try {
    let query = 'SELECT * FROM cc_invoices';
    const params = [];
    
    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY created_at DESC';
    
    const invoices = await new Promise((resolve, reject) => {
      db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    res.json({
      success: true,
      count: invoices.length,
      invoices: invoices
    });
  } catch (error) {
    console.error('Error getting invoices:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/invoices/:id - Obtener detalles de una factura
router.get('/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  
  try {
    const invoice = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM cc_invoices WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!invoice) {
      return res.status(404).json({
        error: 'Invoice not found'
      });
    }

    res.json({
      success: true,
      invoice
    });
  } catch (error) {
    console.error('Error getting invoice:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/invoices - Crear nueva factura
router.post('/', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { 
    clientId, 
    invoiceNumber, 
    status, 
    total,
    dueDate,
    itemsJson
  } = req.body;

  try {
    const now = new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO cc_invoices (
          client_id, invoice_number, status, total, due_date, 
          created_at, items_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          clientId,
          invoiceNumber,
          status,
          total,
          dueDate,
          now,
          itemsJson ? JSON.stringify(itemsJson) : null
        ],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.status(201).json({
      success: true,
      message: 'Invoice created successfully'
    });
  } catch (error) {
    console.error('Error creating invoice:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// PUT /api/v1/invoices/:id - Actualizar factura
router.put('/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  const { 
    invoiceNumber, 
    status, 
    total,
    dueDate,
    paidAt,
    itemsJson
  } = req.body;

  try {
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE cc_invoices 
         SET invoice_number = ?, status = ?, total = ?, due_date = ?, 
             paid_at = ?, items_json = ?
         WHERE id = ?`,
        [
          invoiceNumber,
          status,
          total,
          dueDate,
          paidAt,
          itemsJson ? JSON.stringify(itemsJson) : null,
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
      message: 'Invoice updated successfully'
    });
  } catch (error) {
    console.error('Error updating invoice:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// DELETE /api/v1/invoices/:id - Eliminar factura
router.delete('/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;

  try {
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM cc_invoices WHERE id = ?', [id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({
      success: true,
      message: 'Invoice deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting invoice:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

module.exports = router;

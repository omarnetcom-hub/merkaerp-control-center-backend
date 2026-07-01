const express = require('express');
const router = express.Router();
const { getDatabase } = require('../database/db');
const { authenticateToken } = require('./auth');

// GET /api/v1/clients - Listar todos los clientes
router.get('/', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { status, plan } = req.query;
  
  try {
    let query = `
      SELECT c.*, 
             (SELECT COUNT(*) FROM cc_licenses l WHERE l.client_id = c.id AND l.status = 'active') as active_licenses,
             (SELECT COUNT(*) FROM cc_installations i WHERE i.client_id = c.id) as installations_count
      FROM cc_clients c
    `;
    const params = [];
    
    if (status) {
      query += ' WHERE c.status = ?';
      params.push(status);
    }
    
    if (plan) {
      query += status ? ' AND c.plan = ?' : ' WHERE c.plan = ?';
      params.push(plan);
    }
    
    query += ' ORDER BY c.created_at DESC';
    
    const clients = await new Promise((resolve, reject) => {
      db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    res.json({
      success: true,
      count: clients.length,
      clients: clients
    });
  } catch (error) {
    console.error('Error getting clients:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/clients/:id - Obtener detalles de un cliente
router.get('/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  
  try {
    const client = await new Promise((resolve, reject) => {
      db.get(
        `SELECT c.*, 
                (SELECT COUNT(*) FROM cc_licenses l WHERE l.client_id = c.id AND l.status = 'active') as active_licenses,
                (SELECT COUNT(*) FROM cc_installations i WHERE i.client_id = c.id) as installations_count
         FROM cc_clients c
         WHERE c.id = ?`,
        [id],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!client) {
      return res.status(404).json({
        error: 'Client not found'
      });
    }

    // Obtener licencias del cliente
    const licenses = await new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM cc_licenses WHERE client_id = ? ORDER BY expires_at DESC',
        [id],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    res.json({
      success: true,
      client: client,
      licenses: licenses
    });
  } catch (error) {
    console.error('Error getting client:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/clients - Crear nuevo cliente
router.post('/', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { 
    name, 
    nit, 
    city, 
    country, 
    status, 
    plan, 
    contractValue, 
    renewalDate, 
    taxRate,
    billingType,
    billingDay,
    contactName,
    contactPhone,
    contactEmail,
    contactRole,
    notes,
    resellerId
  } = req.body;

  try {
    const now = new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO cc_clients (
          name, nit, city, country, status, plan, contract_value, renewal_date,
          tax_rate, billing_type, billing_day, contact_name, contact_phone, 
          contact_email, contact_role, notes, reseller_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          name,
          nit || null,
          city || null,
          country || null,
          status,
          plan,
          contractValue || 0,
          renewalDate,
          taxRate || 19.0,
          billingType || 'mensual',
          billingDay || 5,
          contactName || null,
          contactPhone || null,
          contactEmail || null,
          contactRole || null,
          notes || null,
          resellerId || null,
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
      message: 'Client created successfully'
    });
  } catch (error) {
    console.error('Error creating client:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// PUT /api/v1/clients/:id - Actualizar cliente
router.put('/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  const { 
    name, 
    nit, 
    city, 
    country, 
    status, 
    plan, 
    contractValue, 
    renewalDate, 
    taxRate,
    billingType,
    billingDay,
    contactName,
    contactPhone,
    contactEmail,
    contactRole,
    notes,
    resellerId
  } = req.body;

  try {
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE cc_clients 
         SET name = ?, nit = ?, city = ?, country = ?, status = ?, plan = ?, 
             contract_value = ?, renewal_date = ?, tax_rate = ?, billing_type = ?, 
             billing_day = ?, contact_name = ?, contact_phone = ?, contact_email = ?, 
             contact_role = ?, notes = ?, reseller_id = ?
         WHERE id = ?`,
        [
          name,
          nit,
          city,
          country,
          status,
          plan,
          contractValue,
          renewalDate,
          taxRate,
          billingType,
          billingDay,
          contactName,
          contactPhone,
          contactEmail,
          contactRole,
          notes,
          resellerId,
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
      message: 'Client updated successfully'
    });
  } catch (error) {
    console.error('Error updating client:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// DELETE /api/v1/clients/:id - Eliminar cliente
router.delete('/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;

  try {
    // Primero eliminar licencias asociadas
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM cc_licenses WHERE client_id = ?', [id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Luego eliminar el cliente
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM cc_clients WHERE id = ?', [id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({
      success: true,
      message: 'Client deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting client:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/clients/stats - Estadísticas de clientes
router.get('/stats/overview', authenticateToken, async (req, res) => {
  const db = getDatabase();

  try {
    const totalClients = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM cc_clients', (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    const activeClients = await new Promise((resolve, reject) => {
      db.get("SELECT COUNT(*) as count FROM cc_clients WHERE status = 'active'", (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    const totalRevenue = await new Promise((resolve, reject) => {
      db.get('SELECT SUM(contract_value) as total FROM cc_clients', (err, row) => {
        if (err) reject(err);
        else resolve(row.total || 0);
      });
    });

    const expiringSoon = await new Promise((resolve, reject) => {
      db.get(
        "SELECT COUNT(*) as count FROM cc_clients WHERE renewal_date > datetime('now') AND renewal_date < datetime('now', '+30 days')",
        (err, row) => {
          if (err) reject(err);
          else resolve(row.count);
        }
      );
    });

    res.json({
      success: true,
      stats: {
        totalClients,
        activeClients,
        totalRevenue,
        expiringSoon
      }
    });
  } catch (error) {
    console.error('Error getting client stats:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

module.exports = router;

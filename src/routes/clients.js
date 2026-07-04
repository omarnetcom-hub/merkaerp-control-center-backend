const express = require('express');
const router = express.Router();
const { getDatabase, queryAll, queryGet, query } = require('../database/db');
const { authenticateToken } = require('./auth');

// GET /api/v1/clients - Listar todos los clientes
router.get('/', authenticateToken, async (req, res) => {
  const { status, plan } = req.query;
  
  try {
    let sql = 'SELECT * FROM cc_clients';
    const params = [];
    
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    
    if (plan) {
      sql += status ? ' AND plan = ?' : ' WHERE plan = ?';
      params.push(plan);
    }
    
    sql += ' ORDER BY created_at DESC';
    
    const clients = await queryAll(sql, params);

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
  const { id } = req.params;
  
  try {
    const client = await queryGet('SELECT * FROM cc_clients WHERE id = ?', [id]);

    if (!client) {
      return res.status(404).json({
        error: 'Client not found'
      });
    }

    // Obtener licencias del cliente
    const licenses = await queryAll(
      'SELECT * FROM cc_licenses WHERE client_id = ? ORDER BY expires_at DESC',
      [id]
    );

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

// POST /api/v1/clients/sync - Sincronizar cliente sin autenticación (para Control Center)
router.post('/sync', async (req, res) => {
  const { 
    id,
    name, 
    nit, 
    city, 
    country, 
    status, 
    plan, 
    contractValue, 
    renewalDate, 
    usageScore,
    createdAt,
    taxRate,
    billingType,
    billingDay,
    contactName,
    contactPhone,
    contactEmail,
    contactRole,
    notes,
    resellerId,
    password,
    licenseType,
    subscriptionMonths
  } = req.body;

  console.log('Datos recibidos en sync:', { id, name, contactEmail, password });

  try {
    if (id) {
      // Actualizar cliente existente
      await query(
        `UPDATE cc_clients 
         SET name = ?, nit = ?, city = ?, country = ?, status = ?, plan = ?, 
             contract_value = ?, renewal_date = ?, usage_score = ?, tax_rate = ?, 
             billing_type = ?, billing_day = ?, contact_name = ?, contact_phone = ?, 
             contact_email = ?, contact_role = ?, notes = ?, reseller_id = ?, password = ?, updated_at = ?
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
          usageScore,
          taxRate,
          billingType,
          billingDay,
          contactName,
          contactPhone,
          contactEmail,
          contactRole,
          notes,
          resellerId,
          password,
          new Date().toISOString(),
          id
        ]
      );

      // Actualizar o crear licencia del cliente
      const existingLicense = await queryGet('SELECT * FROM cc_licenses WHERE client_id = ?', [id]);

      const expiresAt = licenseType === 'PERPETUA' 
        ? '2099-12-31' 
        : new Date(Date.now() + (30 * (subscriptionMonths || 12) * 24 * 60 * 60 * 1000)).toISOString();

      if (existingLicense) {
        // Actualizar licencia existente
        await query(
          `UPDATE cc_licenses 
           SET type = ?, expires_at = ?, updated_at = ?
           WHERE id = ?`,
          [plan, expiresAt, new Date().toISOString(), existingLicense.id]
        );
      } else {
        // Crear nueva licencia
        const licenseId = Math.floor(Math.random() * 10000) + 1000;
        await query(
          `INSERT INTO cc_licenses (
            id, client_id, type, status, expires_at, max_users, max_devices, 
            max_branches, modules, token_hint, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            licenseId,
            id,
            plan,
            'ACTIVO',
            expiresAt,
            plan === 'Empresarial' ? 30 : (plan === 'Profesional' ? 8 : 1),
            plan === 'Empresarial' ? 50 : (plan === 'Profesional' ? 12 : 1),
            plan === 'Empresarial' ? 10 : (plan === 'Profesional' ? 2 : 1),
            'sales,purchases,inventory,cash,accounting,reports',
            licenseType,
            new Date().toISOString()
          ]
        );
      }

      res.json({
        success: true,
        message: 'Client synced successfully'
      });
    } else {
      // Crear nuevo cliente
      const now = createdAt || new Date().toISOString();

      const lastId = await query(
        `INSERT INTO cc_clients (
          name, nit, city, country, status, plan, contract_value, renewal_date,
          usage_score, tax_rate, billing_type, billing_day, contact_name, contact_phone, 
          contact_email, contact_role, notes, reseller_id, created_at, password, license_type, subscription_months
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          name,
          nit || null,
          city || null,
          country || null,
          status,
          plan,
          contractValue || 0,
          renewalDate,
          usageScore || 75,
          taxRate || 19.0,
          billingType || 'mensual',
          billingDay || 5,
          contactName || null,
          contactPhone || null,
          contactEmail || null,
          contactRole || null,
          notes || null,
          resellerId || null,
          now,
          password,
          licenseType || 'SUSCRIPCION',
          subscriptionMonths || 12
        ]
      );

      // Crear licencia para el nuevo cliente
      const expiresAt = licenseType === 'PERPETUA' 
        ? '2099-12-31' 
        : new Date(Date.now() + (30 * (subscriptionMonths || 12) * 24 * 60 * 60 * 1000)).toISOString();

      const licenseId = Math.floor(Math.random() * 10000) + 1000;
      await query(
        `INSERT INTO cc_licenses (
          id, client_id, type, status, expires_at, max_users, max_devices, 
          max_branches, modules, token_hint, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          licenseId,
          lastId.insertId,
          plan,
          'ACTIVO',
          expiresAt,
          plan === 'Empresarial' ? 30 : (plan === 'Profesional' ? 8 : 1),
          plan === 'Empresarial' ? 50 : (plan === 'Profesional' ? 12 : 1),
          plan === 'Empresarial' ? 10 : (plan === 'Profesional' ? 2 : 1),
          'sales,purchases,inventory,cash,accounting,reports',
          licenseType,
          new Date().toISOString()
        ]
      );

      res.status(201).json({
        success: true,
        message: 'Client created successfully',
        id: lastId.insertId
      });
    }
  } catch (error) {
    console.error('Error syncing client:', error);
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

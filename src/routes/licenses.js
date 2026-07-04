const express = require('express');
const router = express.Router();
const { getDatabase, queryGet, queryAll, query } = require('../database/db');
const { authenticateToken } = require('./auth');
const jwt = require('jsonwebtoken');

// Secret key for JWT signing
const JWT_SECRET = process.env.JWT_SECRET || 'merka-control-center-secret-key-2024';

// Helper function to generate JWT token
function generateLicenseToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '365d' });
}

// POST /api/v1/licenses/activate - Activar licencia (sin auth para uso de MerkaERP)
router.post('/activate', async (req, res) => {
  const { email, password, hardware_fingerprint, license_type } = req.body;

  if (!email || !password || !hardware_fingerprint) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required fields: email, password and hardware_fingerprint' 
    });
  }

  try {
    // Validar credenciales contra la base de datos del Control Center
    console.log('Buscando cliente con email:', email, 'y password:', password);
    const client = await queryGet(
      `SELECT * FROM cc_clients WHERE contact_email = ? AND password = ?`,
      [email, password]
    );
    console.log('Cliente encontrado:', client);
    console.log('Tipo de client:', typeof client);
    console.log('Keys de client:', client ? Object.keys(client) : 'null');

    if (!client) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid credentials: email or password incorrect' 
      });
    }

    // Verificar si el cliente está activo
    if (client.status !== 'active') {
      return res.status(403).json({ 
        success: false, 
        error: 'Client account is not active. Please contact support.' 
      });
    }

    // Determine license type (default to SUSCRIPCION if not specified)
    const finalLicenseType = license_type || 'SUSCRIPCION';
    
    // Set expiration based on license type
    const expiresAt = finalLicenseType === 'PERPETUA' 
      ? new Date('2099-12-31').toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days for subscription

    const licenseData = {
      type: finalLicenseType === 'SUSCRIPCION' ? 'Suscripción' : 'Perpetua',
      status: 'ACTIVO',
      expires_at: expiresAt,
      max_users: finalLicenseType === 'SUSCRIPCION' ? 8 : 10,
      max_devices: finalLicenseType === 'SUSCRIPCION' ? 12 : 15,
      max_branches: finalLicenseType === 'SUSCRIPCION' ? 2 : 3,
      modules: 'sales,purchases,inventory,cash,accounting,reports',
      license_type: finalLicenseType,
      client_id: client.id,
      client_name: client.name,
    };

    // Generate JWT token for offline activation
    const tokenPayload = {
      email,
      hardware_fingerprint,
      license_type: finalLicenseType,
      status: 'ACTIVO',
      expiry_date: expiresAt,
      modules: licenseData.modules.split(','),
      client_id: client.id,
      iat: Math.floor(Date.now() / 1000),
    };

    const token = generateLicenseToken(tokenPayload);

    // Registrar instalación en la base de datos
    const installationId = `MERKA-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
    await query(
      `INSERT INTO installations (
        id, company_name, tax_id, version, os, license_status, 
        license_plan, license_expiry, status, created_at, updated_at, last_heartbeat
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        installationId,
        client.name,
        client.nit,
        '1.0.0',
        'Windows',
        'online',
        finalLicenseType,
        expiresAt,
        'active',
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString()
      ]
    );

    res.json({
      success: true,
      token: token,
      license: licenseData,
      user: {
        email: email,
        license_type: finalLicenseType,
        client_id: client.id,
        client_name: client.name,
      },
      installation_id: installationId,
    });
  } catch (error) {
    console.error('License activation error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// GET /api/v1/licenses - Listar todas las licencias
router.get('/', authenticateToken, async (req, res) => {
  const db = getDatabase();
  
  try {
    const licenses = await new Promise((resolve, reject) => {
      db.all(
        `SELECT l.*, c.name as client_name, c.nit as client_nit 
         FROM cc_licenses l
         LEFT JOIN cc_clients c ON l.client_id = c.id
         ORDER BY l.updated_at DESC`,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    res.json({
      success: true,
      count: licenses.length,
      licenses: licenses
    });
  } catch (error) {
    console.error('Error getting licenses:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/licenses/:id - Obtener detalles de una licencia
router.get('/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  
  try {
    const license = await new Promise((resolve, reject) => {
      db.get(
        `SELECT l.*, c.name as client_name, c.nit as client_nit 
         FROM cc_licenses l
         LEFT JOIN cc_clients c ON l.client_id = c.id
         WHERE l.id = ?`,
        [id],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!license) {
      return res.status(404).json({
        error: 'License not found'
      });
    }

    res.json({
      success: true,
      license
    });
  } catch (error) {
    console.error('Error getting license:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/licenses - Crear nueva licencia
router.post('/', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { 
    clientId, 
    type, 
    status, 
    expiresAt, 
    maxUsers, 
    maxDevices, 
    maxBranches, 
    modules,
    tokenHint 
  } = req.body;

  try {
    const now = new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO cc_licenses (
          client_id, type, status, expires_at, max_users, max_devices, 
          max_branches, modules, token_hint, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          clientId,
          type,
          status,
          expiresAt,
          maxUsers,
          maxDevices,
          maxBranches,
          modules,
          tokenHint || null,
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
      message: 'License created successfully'
    });
  } catch (error) {
    console.error('Error creating license:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// PUT /api/v1/licenses/:id - Actualizar licencia
router.put('/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  const { 
    type, 
    status, 
    expiresAt, 
    maxUsers, 
    maxDevices, 
    maxBranches, 
    modules,
    tokenHint 
  } = req.body;

  try {
    const now = new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE cc_licenses 
         SET type = ?, status = ?, expires_at = ?, max_users = ?, max_devices = ?, 
             max_branches = ?, modules = ?, token_hint = ?, updated_at = ?
         WHERE id = ?`,
        [
          type,
          status,
          expiresAt,
          maxUsers,
          maxDevices,
          maxBranches,
          modules,
          tokenHint,
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
      message: 'License updated successfully'
    });
  } catch (error) {
    console.error('Error updating license:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// DELETE /api/v1/licenses/:id - Eliminar licencia
router.delete('/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;

  try {
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM cc_licenses WHERE id = ?', [id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({
      success: true,
      message: 'License deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting license:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/clients - Crear o actualizar cliente (para sincronización desde Control Center)
router.post('/clients', async (req, res) => {
  const db = getDatabase();
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
    resellerId,
    taxRate,
    billingType,
    billingDay,
    notes,
    contactName,
    contactPhone,
    contactEmail,
    contactRole,
    password
  } = req.body;

  try {
    const now = new Date().toISOString();

    if (id) {
      // Actualizar cliente existente
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE cc_clients 
           SET name = ?, nit = ?, city = ?, country = ?, status = ?, plan = ?, 
               contract_value = ?, renewal_date = ?, usage_score = ?, reseller_id = ?, 
               tax_rate = ?, billing_type = ?, billing_day = ?, notes = ?, 
               contact_name = ?, contact_phone = ?, contact_email = ?, contact_role = ?, password = ?
           WHERE id = ?`,
          [
            name, nit, city, country, status, plan, contractValue, renewalDate, 
            usageScore, resellerId, taxRate, billingType, billingDay, notes, 
            contactName, contactPhone, contactEmail, contactRole, password, id
          ],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      res.json({
        success: true,
        message: 'Client updated successfully',
        id: id
      });
    } else {
      // Crear nuevo cliente
      const result = await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO cc_clients (
            name, nit, city, country, status, plan, contract_value, renewal_date, 
            usage_score, created_at, reseller_id, tax_rate, billing_type, billing_day, 
            notes, contact_name, contact_phone, contact_email, contact_role, password
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            name, nit, city, country, status, plan, contractValue, renewalDate, 
            usageScore, createdAt || now, resellerId, taxRate, billingType, billingDay, 
            notes, contactName, contactPhone, contactEmail, contactRole, password
          ],
          function(err) {
            if (err) reject(err);
            else resolve(this);
          }
        );
      });

      res.status(201).json({
        success: true,
        message: 'Client created successfully',
        id: result.lastID
      });
    }
  } catch (error) {
    console.error('Error saving client:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/installations - Obtener todas las instalaciones
router.get('/installations', async (req, res) => {
  const db = getDatabase();
  
  try {
    const installations = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM installations ORDER BY created_at DESC', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    res.json({
      success: true,
      installations: installations
    });
  } catch (error) {
    console.error('Error fetching installations:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/v1/installations/:clientId - Obtener instalaciones por cliente
router.get('/installations/client/:clientId', async (req, res) => {
  const db = getDatabase();
  const { clientId } = req.params;
  
  try {
    const installations = await new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM installations WHERE tax_id = ? ORDER BY created_at DESC',
        [clientId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    res.json({
      success: true,
      installations: installations
    });
  } catch (error) {
    console.error('Error fetching client installations:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/v1/licenses/validate - Validar licencia (sin auth para uso de MerkaERP)
router.post('/validate', async (req, res) => {
  const db = getDatabase();
  const { installationId, taxId } = req.body;

  try {
    // Buscar licencia activa para la instalación
    const license = await new Promise((resolve, reject) => {
      db.get(
        `SELECT l.*, c.name as client_name, c.nit as client_nit 
         FROM cc_licenses l
         LEFT JOIN cc_clients c ON l.client_id = c.id
         WHERE l.status = 'active' 
         AND (c.nit = ? OR l.token_hint = ?)
         AND l.expires_at > datetime('now')
         ORDER BY l.expires_at DESC
         LIMIT 1`,
        [taxId, installationId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!license) {
      return res.json({
        valid: false,
        message: 'No active license found for this installation'
      });
    }

    // Verificar si la licencia está expirada
    const expiryDate = new Date(license.expires_at);
    const now = new Date();
    
    if (expiryDate < now) {
      return res.json({
        valid: false,
        message: 'License expired',
        licenseInfo: license
      });
    }

    res.json({
      valid: true,
      message: 'License valid',
      licenseInfo: {
        type: license.type,
        maxUsers: license.max_users,
        maxDevices: license.max_devices,
        maxBranches: license.max_branches,
        modules: license.modules,
        expiresAt: license.expires_at
      }
    });
  } catch (error) {
    console.error('Error validating license:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

module.exports = router;

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Database path (Control Center database)
const DB_PATH = path.join(__dirname, '..', 'Merka_Control_Center', 'Data', 'merka_control_center_v2.db');

// Database connection
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error connecting to database:', err.message);
  } else {
    console.log('Connected to Control Center database');
  }
});

// Secret key for JWT signing
const JWT_SECRET = process.env.JWT_SECRET || 'merka-control-center-secret-key-2024';

// Helper function to generate JWT token
function generateLicenseToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '365d' });
}

// Helper function to verify JWT token
function verifyLicenseToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// Helper function to generate HMAC-SHA256 signature
function generateSignature(data, secret) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(data)).digest('hex');
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// License activation endpoint
app.post('/api/v1/licenses/activate', async (req, res) => {
  try {
    const { email, password, hardware_fingerprint, license_type } = req.body;

    if (!email || !password || !hardware_fingerprint) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: email, password, and hardware_fingerprint' 
      });
    }

    // Buscar cliente por email y password
    db.get(
      'SELECT * FROM cc_clients WHERE contact_email = ? AND password = ?',
      [email, password],
      (err, client) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ 
            success: false, 
            error: 'Database error' 
          });
        }

        if (!client) {
          return res.status(401).json({ 
            success: false, 
            error: 'Invalid email or password' 
          });
        }

        // Buscar licencia del cliente
        db.get(
          'SELECT * FROM cc_licenses WHERE client_id = ?',
          [client.id],
          (err, license) => {
            if (err) {
              console.error('Database error:', err);
              return res.status(500).json({ 
                success: false, 
                error: 'Database error' 
              });
            }

            if (!license) {
              return res.status(404).json({ 
                success: false, 
                error: 'No license found for this client' 
              });
            }

            // Actualizar hardware fingerprint y contador de activaciones
            db.run(
              'UPDATE cc_licenses SET hardware_fingerprint = ?, activation_count = activation_count + 1, updated_at = ? WHERE id = ?',
              [hardware_fingerprint, new Date().toISOString(), license.id],
              (err) => {
                if (err) {
                  console.error('Database error:', err);
                  return res.status(500).json({ 
                    success: false, 
                    error: 'Database error' 
                  });
                }

                // Registrar instalación
                const installationId = `MERKA-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
                db.run(
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
                    license.license_type || 'SUSCRIPCION',
                    license.expires_at,
                    'active',
                    new Date().toISOString(),
                    new Date().toISOString(),
                    new Date().toISOString()
                  ],
                  (err) => {
                    if (err) {
                      console.error('Error registering installation:', err);
                    }
                  }
                );

                // Generar token JWT
                const tokenPayload = {
                  hardware_fingerprint,
                  license_type: license.license_type || 'SUSCRIPCION',
                  status: 'active',
                  expiry_date: license.expires_at,
                  modules: license.modules ? license.modules.split(',') : ['sales', 'purchases', 'inventory', 'cash', 'accounting', 'reports'],
                  client_id: client.id,
                  client_name: client.name,
                  iat: Math.floor(Date.now() / 1000),
                };

                const token = generateLicenseToken(tokenPayload);

                res.json({
                  success: true,
                  token: token,
                  license: {
                    type: license.type,
                    status: license.status,
                    expires_at: license.expires_at,
                    max_users: license.max_users,
                    max_devices: license.max_devices,
                    max_branches: license.max_branches,
                    modules: license.modules,
                  },
                  user: {
                    email: email,
                    license_type: license.license_type,
                    client_id: client.id,
                    client_name: client.name,
                  },
                  installation_id: installationId,
                });
              }
            );
          }
        );
      }
    );
  } catch (error) {
    console.error('License activation error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// License validation endpoint
app.post('/api/v1/licenses/validate', async (req, res) => {
  try {
    const { hardware_fingerprint } = req.body;

    if (!hardware_fingerprint) {
      return res.status(400).json({ 
        valid: false, 
        error: 'Missing hardware_fingerprint' 
      });
    }

    // TODO: Connect to Control Center database and validate license
    // For now, simulate validation
    const licenseData = {
      type: 'Profesional',
      status: 'active',
      expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      max_users: 8,
      max_devices: 12,
      max_branches: 2,
      modules: 'sales,purchases,inventory,cash,accounting,reports',
    };

    res.json({
      valid: true,
      license: licenseData,
    });
  } catch (error) {
    console.error('License validation error:', error);
    res.status(500).json({ 
      valid: false, 
      error: error.message 
    });
  }
});

// Heartbeat endpoint
app.post('/api/v1/installations/heartbeat', async (req, res) => {
  try {
    const { installationId, companyName, taxId, version, os, licenseStatus, syncStatus, databaseStatus, criticalErrors, ipAddress, uptimeHours } = req.body;

    // TODO: Store heartbeat data in Control Center database
    console.log('Heartbeat received from:', installationId, companyName);

    res.json({
      success: true,
      message: 'Heartbeat received',
    });
  } catch (error) {
    console.error('Heartbeat error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Telemetry events endpoint
app.post('/api/v1/telemetry/events', async (req, res) => {
  try {
    const { companyName, taxId, event, module, severity } = req.body;

    // TODO: Store telemetry data in Control Center database
    console.log('Telemetry event:', event, module, severity);

    res.json({
      success: true,
      message: 'Telemetry received',
    });
  } catch (error) {
    console.error('Telemetry error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Auth endpoints (simplified)
app.post('/api/v1/auth/login', (req, res) => {
  const { username, password } = req.body;

  // TODO: Implement proper authentication
  if (username === 'admin' && password === 'admin123') {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({
      success: true,
      token: token,
      user: { username, role: 'admin' },
    });
  } else {
    res.status(401).json({ 
      success: false, 
      error: 'Invalid credentials' 
    });
  }
});

app.post('/api/v1/auth/logout', (req, res) => {
  res.json({ success: true });
});

// Admin stats endpoint
app.get('/api/v1/admin/stats', (req, res) => {
  // TODO: Get real stats from Control Center database
  res.json({
    total_clients: 0,
    active_licenses: 0,
    total_installations: 0,
    monthly_revenue: 0,
  });
});

// GET /api/v1/installations - Obtener todas las instalaciones
app.get('/api/v1/installations', async (req, res) => {
  try {
    db.all('SELECT * FROM installations ORDER BY created_at DESC', (err, rows) => {
      if (err) {
        console.error('Error fetching installations:', err);
        return res.status(500).json({
          success: false,
          error: err.message
        });
      }

      res.json({
        success: true,
        installations: rows
      });
    });
  } catch (error) {
    console.error('Error fetching installations:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/v1/installations/client/:clientId - Obtener instalaciones por cliente
app.get('/api/v1/installations/client/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    
    db.all(
      'SELECT * FROM installations WHERE tax_id = ? ORDER BY created_at DESC',
      [clientId],
      (err, rows) => {
        if (err) {
          console.error('Error fetching client installations:', err);
          return res.status(500).json({
            success: false,
            error: err.message
          });
        }

        res.json({
          success: true,
          installations: rows
        });
      }
    );
  } catch (error) {
    console.error('Error fetching client installations:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/v1/clients - Crear o actualizar cliente
app.post('/api/v1/clients', async (req, res) => {
  try {
    const { id, name, nit, city, country, status, plan, contractValue, renewalDate, usageScore, createdAt, resellerId, taxRate, billingType, billingDay, notes, contactName, contactPhone, contactEmail, contactRole, password } = req.body;

    if (id) {
      // Actualizar cliente existente
      db.run(
        `UPDATE cc_clients SET name = ?, nit = ?, city = ?, country = ?, status = ?, plan = ?, 
         contract_value = ?, renewal_date = ?, usage_score = ?, reseller_id = ?, tax_rate = ?, 
         billing_type = ?, billing_day = ?, notes = ?, contact_name = ?, contact_phone = ?, 
         contact_email = ?, contact_role = ?, password = ?, updated_at = ? WHERE id = ?`,
        [name, nit, city, country, status, plan, contractValue, renewalDate, usageScore, resellerId, taxRate, billingType, billingDay, notes, contactName, contactPhone, contactEmail, contactRole, password, new Date().toISOString(), id],
        (err) => {
          if (err) {
            console.error('Error updating client:', err);
            return res.status(500).json({ success: false, error: err.message });
          }
          res.json({ success: true, message: 'Client updated' });
        }
      );
    } else {
      // Crear nuevo cliente
      db.run(
        `INSERT INTO cc_clients (name, nit, city, country, status, plan, contract_value, renewal_date, 
         usage_score, created_at, reseller_id, tax_rate, billing_type, billing_day, notes, 
         contact_name, contact_phone, contact_email, contact_role, password) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, nit, city, country, status, plan, contractValue, renewalDate, usageScore, createdAt || new Date().toISOString(), resellerId, taxRate, billingType, billingDay, notes, contactName, contactPhone, contactEmail, contactRole, password],
        function(err) {
          if (err) {
            console.error('Error creating client:', err);
            return res.status(500).json({ success: false, error: err.message });
          }
          res.json({ success: true, message: 'Client created', id: this.lastID });
        }
      );
    }
  } catch (error) {
    console.error('Error saving client:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Placeholder endpoints for other API routes
app.get('/api/v1/licenses', (req, res) => {
  res.json({ licenses: [] });
});

app.get('/api/v1/clients', (req, res) => {
  res.json({ clients: [] });
});

app.get('/api/v1/tickets', (req, res) => {
  res.json({ tickets: [] });
});

app.get('/api/v1/invoices', (req, res) => {
  res.json({ invoices: [] });
});

app.get('/api/v1/leads', (req, res) => {
  res.json({ leads: [] });
});

// Start server
app.listen(PORT, () => {
  console.log(`Merka Control Center Backend running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

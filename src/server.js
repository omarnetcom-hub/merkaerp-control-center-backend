const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 8787;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Database configuration - PostgreSQL only for Render
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

console.log('Using PostgreSQL database');
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const db = {
  query: (sql, params, callback) => {
    pool.query(sql, params, (err, result) => {
      if (err) {
        callback(err);
      } else {
        callback(null, result.rows);
      }
    });
  },
  run: (sql, params, callback) => {
    pool.query(sql, params, (err, result) => {
      if (err) {
        callback(err);
      } else {
        callback(null, result);
      }
    });
  },
  get: (sql, params, callback) => {
    pool.query(sql, params, (err, result) => {
      if (err) {
        callback(err);
      } else {
        callback(null, result.rows[0]);
      }
    });
  },
  all: (sql, params, callback) => {
    pool.query(sql, params, (err, result) => {
      if (err) {
        callback(err);
      } else {
        callback(null, result.rows);
      }
    });
  }
};

// Initialize PostgreSQL tables
initializePostgresTables(pool);

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

// Initialize PostgreSQL tables
async function initializePostgresTables(pool) {
  try {
    console.log('Initializing PostgreSQL tables...');
    
    // Create cc_clients table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_clients (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        nit TEXT,
        city TEXT,
        country TEXT,
        status TEXT NOT NULL,
        plan TEXT NOT NULL,
        contract_value REAL NOT NULL DEFAULT 0,
        renewal_date TEXT NOT NULL,
        usage_score INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        reseller_id INTEGER,
        tax_rate REAL NOT NULL DEFAULT 19.0,
        billing_type TEXT NOT NULL DEFAULT 'mensual',
        billing_day INTEGER NOT NULL DEFAULT 5,
        notes TEXT,
        contact_name TEXT,
        contact_phone TEXT,
        contact_email TEXT,
        contact_role TEXT,
        password TEXT,
        license_type TEXT DEFAULT 'SUSCRIPCION',
        subscription_months INTEGER DEFAULT 12,
        postgres_schema TEXT,
        postgres_username TEXT,
        postgres_password TEXT
      )
    `);
    
    // Create cc_licenses table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_licenses (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        max_users INTEGER NOT NULL,
        max_devices INTEGER NOT NULL,
        max_branches INTEGER NOT NULL,
        modules TEXT NOT NULL,
        token_hint TEXT,
        updated_at TEXT NOT NULL,
        license_type TEXT NOT NULL DEFAULT 'SUSCRIPCION',
        hardware_fingerprint TEXT,
        offline_token TEXT,
        activation_count INTEGER NOT NULL DEFAULT 0,
        last_heartbeat TEXT,
        grace_period_end TEXT,
        FOREIGN KEY (client_id) REFERENCES cc_clients(id)
      )
    `);
    
    // Create installations table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS installations (
        id SERIAL PRIMARY KEY,
        installation_id TEXT UNIQUE,
        company_name TEXT,
        hardware_fingerprint TEXT,
        license_status TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create sync_data table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sync_data (
        id SERIAL PRIMARY KEY,
        installation_id TEXT,
        table_name TEXT,
        record_data TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('PostgreSQL tables initialized successfully');
  } catch (error) {
    console.error('Error initializing PostgreSQL tables:', error);
  }
}

// Create tables for client schema
async function createClientTables(pool, schema) {
  try {
    console.log(`Creating tables in schema ${schema}...`);
    
    // Set search path to client schema
    await pool.query(`SET search_path TO ${schema}`);
    
    // Create main tables for MerkaERP data
    const tables = [
      // Products
      `CREATE TABLE IF NOT EXISTS ${schema}.productos (
        id SERIAL PRIMARY KEY,
        codigo TEXT UNIQUE NOT NULL,
        nombre TEXT NOT NULL,
        descripcion TEXT,
        precio_venta REAL NOT NULL DEFAULT 0,
        costo REAL NOT NULL DEFAULT 0,
        categoria TEXT,
        unidad_medida TEXT,
        stock INTEGER NOT NULL DEFAULT 0,
        stock_minimo INTEGER NOT NULL DEFAULT 0,
        iva REAL NOT NULL DEFAULT 19,
        activo BOOLEAN NOT NULL DEFAULT true,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        sync_status TEXT DEFAULT 'synced',
        last_sync TEXT
      )`,
      
      // Customers
      `CREATE TABLE IF NOT EXISTS ${schema}.clientes (
        id SERIAL PRIMARY KEY,
        identificacion TEXT UNIQUE NOT NULL,
        nombre TEXT NOT NULL,
        email TEXT,
        telefono TEXT,
        direccion TEXT,
        ciudad TEXT,
        tipo_cliente TEXT DEFAULT 'general',
        limite_credito REAL NOT NULL DEFAULT 0,
        saldo_actual REAL NOT NULL DEFAULT 0,
        activo BOOLEAN NOT NULL DEFAULT true,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        sync_status TEXT DEFAULT 'synced',
        last_sync TEXT
      )`,
      
      // Sales
      `CREATE TABLE IF NOT EXISTS ${schema}.ventas (
        id SERIAL PRIMARY KEY,
        numero_factura TEXT UNIQUE NOT NULL,
        cliente_id INTEGER,
        fecha TEXT NOT NULL,
        subtotal REAL NOT NULL DEFAULT 0,
        iva REAL NOT NULL DEFAULT 0,
        total REAL NOT NULL DEFAULT 0,
        metodo_pago TEXT,
        estado TEXT DEFAULT 'completada',
        observaciones TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        sync_status TEXT DEFAULT 'synced',
        last_sync TEXT
      )`,
      
      // Sale items
      `CREATE TABLE IF NOT EXISTS ${schema}.venta_items (
        id SERIAL PRIMARY KEY,
        venta_id INTEGER NOT NULL,
        producto_id INTEGER NOT NULL,
        cantidad INTEGER NOT NULL,
        precio_unitario REAL NOT NULL,
        subtotal REAL NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        sync_status TEXT DEFAULT 'synced',
        last_sync TEXT
      )`,
      
      // Sync tracking
      `CREATE TABLE IF NOT EXISTS ${schema}.sync_tracking (
        id SERIAL PRIMARY KEY,
        table_name TEXT NOT NULL,
        record_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        device_id TEXT,
        timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
        synced BOOLEAN NOT NULL DEFAULT false
      )`
    ];
    
    for (const tableSQL of tables) {
      await pool.query(tableSQL);
    }
    
    console.log(`Tables created successfully in schema ${schema}`);
  } catch (error) {
    console.error(`Error creating tables in schema ${schema}:`, error);
    throw error;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// License activation endpoint (unificado con autenticación de usuarios)
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
            error: 'Database error: ' + err.message 
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

            // Verificar que la licencia esté activa
            if (license.status !== 'active') {
              return res.status(403).json({ 
                success: false, 
                error: 'License is not active' 
              });
            }

            // Verificar que la licencia no haya expirado
            if (new Date(license.expires_at) < new Date()) {
              return res.status(403).json({ 
                success: false, 
                error: 'License has expired' 
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

                // Generar credenciales PostgreSQL para el cliente
                const postgresSchema = `client_${client.id}`;
                const postgresUser = `merka_client_${client.id}`;
                const postgresPassword = `merka_${client.id}_${Math.random().toString(36).substr(2, 10)}`;

                // Función para crear esquema PostgreSQL
                const createPostgresSchema = async () => {
                  if (dbType === 'postgres' && DATABASE_URL) {
                    try {
                      const pool = new Pool({
                        connectionString: DATABASE_URL,
                        ssl: { rejectUnauthorized: false }
                      });

                      // Crear esquema si no existe
                      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${postgresSchema}`);
                      
                      // Crear usuario PostgreSQL si no existe
                      await pool.query(`DO $$
                        BEGIN
                          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${postgresUser}') THEN
                            CREATE USER ${postgresUser} WITH PASSWORD '${postgresPassword}';
                          END IF;
                        END
                        $$`);

                      // Dar permisos al usuario sobre el esquema
                      await pool.query(`GRANT USAGE ON SCHEMA ${postgresSchema} TO ${postgresUser}`);
                      await pool.query(`GRANT CREATE ON SCHEMA ${postgresSchema} TO ${postgresUser}`);
                      await pool.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${postgresSchema} TO ${postgresUser}`);
                      await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${postgresSchema} GRANT ALL ON TABLES TO ${postgresUser}`);

                      // Crear tablas en el esquema del cliente
                      await createClientTables(pool, postgresSchema);

                      // Actualizar credenciales en la tabla cc_clients
                      await pool.query(
                        `UPDATE cc_clients SET postgres_schema = $1, postgres_username = $2, postgres_password = $3 WHERE id = $4`,
                        [postgresSchema, postgresUser, postgresPassword, client.id]
                      );

                      console.log(`PostgreSQL schema ${postgresSchema} created for client ${client.id}`);
                    } catch (error) {
                      console.error('Error creating PostgreSQL schema:', error);
                      // Continuar aunque falle la creación del esquema
                    }
                  }
                };

                // Ejecutar creación de esquema de forma asíncrona (no bloquear respuesta)
                createPostgresSchema().catch(err => console.error('Schema creation error:', err));

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
                  postgres_credentials: {
                    host: process.env.DATABASE_URL ? 'merkaerp-control-center-backend.onrender.com' : 'localhost',
                    port: 5432,
                    database: 'merkaerp',
                    schema: postgresSchema,
                    username: postgresUser,
                    password: postgresPassword,
                    connection_string: process.env.DATABASE_URL || null
                  }
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

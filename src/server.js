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

function convertPlaceholders(sql) {
  if (typeof sql !== 'string') return sql;
  let count = 1;
  return sql.replace(/\?/g, () => `$${count++}`);
}

const db = {
  query: (sql, params, callback) => {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    const pgSql = convertPlaceholders(sql);
    pool.query(pgSql, params, (err, result) => {
      if (err) {
        callback(err);
      } else {
        callback(null, result.rows);
      }
    });
  },
  run: (sql, params, callback) => {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    const pgSql = convertPlaceholders(sql);
    pool.query(pgSql, params, (err, result) => {
      if (err) {
        callback(err);
      } else {
        callback(null, result);
      }
    });
  },
  get: (sql, params, callback) => {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    const pgSql = convertPlaceholders(sql);
    pool.query(pgSql, params, (err, result) => {
      if (err) {
        callback(err);
      } else {
        callback(null, result.rows[0]);
      }
    });
  },
  all: (sql, params, callback) => {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    const pgSql = convertPlaceholders(sql);
    pool.query(pgSql, params, (err, result) => {
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
    
    // Create cc_users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        avatar_path TEXT,
        created_at TEXT NOT NULL,
        last_login TEXT,
        is_active INTEGER NOT NULL DEFAULT 1
      )
    `);

    // Create cc_sessions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES cc_users (id) ON DELETE CASCADE
      )
    `);

    // Create cc_settings table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_settings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES cc_users (id) ON DELETE CASCADE,
        UNIQUE(user_id, key)
      )
    `);

    // Create cc_resellers table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_resellers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        nit TEXT,
        contact TEXT,
        phone TEXT,
        email TEXT,
        address TEXT,
        commission_pct REAL,
        logo_path TEXT,
        custom_domain TEXT,
        theme_colors_json TEXT
      )
    `);

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
        client_password TEXT,
        license_type TEXT DEFAULT 'SUSCRIPCION',
        subscription_months INTEGER DEFAULT 12,
        postgres_schema TEXT,
        postgres_username TEXT,
        postgres_password TEXT,
        FOREIGN KEY (reseller_id) REFERENCES cc_resellers (id) ON DELETE SET NULL
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
        FOREIGN KEY (client_id) REFERENCES cc_clients(id) ON DELETE CASCADE
      )
    `);
    
    // Create cc_installations table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_installations (
        id SERIAL PRIMARY KEY,
        uuid TEXT UNIQUE NOT NULL,
        client_id INTEGER NOT NULL DEFAULT 0,
        version TEXT NOT NULL,
        os TEXT NOT NULL,
        connected INTEGER NOT NULL DEFAULT 0,
        license_status TEXT NOT NULL,
        sync_status TEXT NOT NULL,
        database_status TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        critical_errors INTEGER NOT NULL DEFAULT 0,
        ip_address TEXT,
        uptime_hours REAL,
        hardware_fingerprint TEXT,
        company_name TEXT,
        tax_id TEXT,
        license_plan TEXT,
        license_expiry TEXT,
        status TEXT,
        created_at TEXT,
        updated_at TEXT,
        last_heartbeat TEXT
      )
    `);

    // Create cc_tickets table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_tickets (
        id SERIAL PRIMARY KEY,
        client_id INTEGER,
        title TEXT NOT NULL,
        description TEXT,
        category TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL,
        assigned_to TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sla_hours INTEGER,
        escalated_level INTEGER,
        FOREIGN KEY (client_id) REFERENCES cc_clients (id) ON DELETE SET NULL
      )
    `);

    // Create cc_releases table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_releases (
        id SERIAL PRIMARY KEY,
        version TEXT NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        pending_installs INTEGER NOT NULL DEFAULT 0,
        published_at TEXT NOT NULL
      )
    `);

    // Create cc_backups table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_backups (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        size_mb REAL NOT NULL DEFAULT 0,
        last_run TEXT NOT NULL,
        FOREIGN KEY (client_id) REFERENCES cc_clients (id) ON DELETE CASCADE
      )
    `);

    // Create cc_invoices table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_invoices (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        invoice_number TEXT NOT NULL,
        status TEXT NOT NULL,
        total REAL NOT NULL,
        due_date TEXT NOT NULL,
        paid_at TEXT,
        items_json TEXT,
        FOREIGN KEY (client_id) REFERENCES cc_clients (id) ON DELETE CASCADE
      )
    `);

    // Create cc_payments table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_payments (
        id SERIAL PRIMARY KEY,
        invoice_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        method TEXT NOT NULL,
        reference TEXT NOT NULL,
        receipt_path TEXT,
        paid_at TEXT NOT NULL,
        FOREIGN KEY (invoice_id) REFERENCES cc_invoices (id) ON DELETE CASCADE
      )
    `);

    // Create cc_chat_messages table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_chat_messages (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        sender TEXT NOT NULL,
        message TEXT NOT NULL,
        attachment_path TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (client_id) REFERENCES cc_clients (id) ON DELETE CASCADE
      )
    `);

    // Create cc_articles table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_articles (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        tags TEXT,
        content TEXT,
        author TEXT,
        created_at TEXT NOT NULL
      )
    `);

    // Create cc_alerts table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_alerts (
        id SERIAL PRIMARY KEY,
        priority TEXT NOT NULL,
        client_id INTEGER,
        installation_id TEXT,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (client_id) REFERENCES cc_clients (id) ON DELETE SET NULL
      )
    `);

    // Create cc_campaigns table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_campaigns (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        template TEXT,
        subject TEXT,
        target_segment TEXT,
        scheduled_at TEXT,
        status TEXT NOT NULL,
        sent_count INTEGER,
        opened_count INTEGER,
        clicked_count INTEGER
      )
    `);

    // Create cc_telemetry table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_telemetry (
        id SERIAL PRIMARY KEY,
        client_id INTEGER,
        event TEXT NOT NULL,
        module TEXT,
        severity TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (client_id) REFERENCES cc_clients (id) ON DELETE SET NULL
      )
    `);

    // Create cc_audit table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_audit (
        id SERIAL PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      )
    `);

    // Create cc_commands table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_commands (
        id SERIAL PRIMARY KEY,
        installation_uuid TEXT NOT NULL,
        action TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'info',
        title TEXT,
        detail TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        ack_at TEXT,
        result TEXT,
        executed_by TEXT
      )
    `);

    // Create cc_license_revocations table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_license_revocations (
        id SERIAL PRIMARY KEY,
        license_id INTEGER NOT NULL,
        hardware_fingerprint TEXT NOT NULL,
        reason TEXT,
        revoked_at TEXT NOT NULL,
        revoked_by TEXT,
        FOREIGN KEY (license_id) REFERENCES cc_licenses (id) ON DELETE CASCADE
      )
    `);

    // Create cc_sync_hub_log table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_sync_hub_log (
        id SERIAL PRIMARY KEY,
        node_uuid TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        data_json TEXT NOT NULL,
        version_timestamp TEXT NOT NULL,
        is_critical INTEGER NOT NULL DEFAULT 0,
        sync_status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      )
    `);

    // Create cc_consolidated_analytics table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_consolidated_analytics (
        id SERIAL PRIMARY KEY,
        report_date TEXT NOT NULL,
        client_id INTEGER,
        total_sales REAL NOT NULL DEFAULT 0,
        total_transactions INTEGER NOT NULL DEFAULT 0,
        total_tickets INTEGER NOT NULL DEFAULT 0,
        total_critical_alerts INTEGER NOT NULL DEFAULT 0,
        active_installations INTEGER NOT NULL DEFAULT 0,
        avg_uptime_hours REAL NOT NULL DEFAULT 0,
        top_products TEXT,
        FOREIGN KEY (client_id) REFERENCES cc_clients (id) ON DELETE SET NULL
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
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
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
    
    // Auto-migrate existing schemas that might not have updated_at on venta_items
    await pool.query(`ALTER TABLE ${schema}.venta_items ADD COLUMN IF NOT EXISTS updated_at TEXT DEFAULT CURRENT_TIMESTAMP`);
    
    console.log(`Tables created successfully in schema ${schema}`);
  } catch (error) {
    console.error(`Error creating tables in schema ${schema}:`, error);
    throw error;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.0' });
});

// Test endpoint to verify deployment
app.get('/test-deployment', (req, res) => {
  res.json({ 
    message: 'Deployment test successful', 
    timestamp: new Date().toISOString(),
    git_commit: 'fabe4cb'
  });
});

// Endpoint to add password column if missing
app.get('/fix-password-column', async (req, res) => {
  try {
    // Renombrar columna password a client_password para evitar conflicto con palabra reservada
    await pool.query(`
      ALTER TABLE cc_clients 
      RENAME COLUMN "password" TO client_password
    `);
    res.json({ success: true, message: 'Password column renamed to client_password' });
  } catch (error) {
    console.error('Error renaming password column:', error);
    res.status(500).json({ success: false, error: error.message });
  }
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
      'SELECT * FROM cc_clients WHERE contact_email = ? AND client_password = ?',
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
                  `INSERT INTO cc_installations (
                    uuid, client_id, version, os, connected, license_status, 
                    sync_status, database_status, last_seen, critical_errors, hardware_fingerprint,
                    company_name, tax_id, license_plan, license_expiry, status, created_at, updated_at, last_heartbeat
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    installationId,
                    client.id,
                    '1.0.0',
                    'Windows',
                    1, // connected
                    'online', // license_status
                    'synced', // sync_status
                    'healthy', // database_status
                    new Date().toISOString(), // last_seen
                    0, // critical_errors
                    hardware_fingerprint,
                    client.name, // company_name
                    client.nit, // tax_id
                    license.license_type || 'SUSCRIPCION', // license_plan
                    license.expires_at, // license_expiry
                    'active', // status
                    new Date().toISOString(), // created_at
                    new Date().toISOString(), // updated_at
                    new Date().toISOString() // last_heartbeat
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
                  if (DATABASE_URL) {
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
    db.all('SELECT * FROM cc_installations ORDER BY created_at DESC', (err, rows) => {
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
      'SELECT * FROM cc_installations WHERE tax_id = ? ORDER BY created_at DESC',
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
      await pool.query(
        `UPDATE cc_clients SET name = $1, nit = $2, city = $3, country = $4, status = $5, plan = $6, 
         contract_value = $7, renewal_date = $8, usage_score = $9, reseller_id = $10, tax_rate = $11, 
         billing_type = $12, billing_day = $13, notes = $14, contact_name = $15, contact_phone = $16, 
         contact_email = $17, contact_role = $18, client_password = $19, updated_at = $20 WHERE id = $21`,
        [name, nit, city, country, status, plan, contractValue, renewalDate, usageScore, resellerId, taxRate, billingType, billingDay, notes, contactName, contactPhone, contactEmail, contactRole, password, new Date().toISOString(), id]
      );
      res.json({ success: true, message: 'Client updated' });
    } else {
      // Crear nuevo cliente
      const result = await pool.query(
        `INSERT INTO cc_clients (name, nit, city, country, status, plan, contract_value, renewal_date, 
         usage_score, created_at, reseller_id, tax_rate, billing_type, billing_day, notes, 
         contact_name, contact_phone, contact_email, contact_role, client_password) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) 
         RETURNING id`,
        [name, nit, city, country, status, plan, contractValue, renewalDate, usageScore, new Date().toISOString(), resellerId, taxRate, billingType, billingDay, notes, contactName, contactPhone, contactEmail, contactRole, password]
      );
      res.json({ success: true, message: 'Client created', id: result.rows[0].id });
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

// GET /api/v1/clients - Obtener todos los clientes
app.get('/api/v1/clients', async (req, res) => {
  try {
    db.all('SELECT id, name, contact_email, status FROM cc_clients', (err, rows) => {
      if (err) {
        console.error('Error fetching clients:', err);
        return res.status(500).json({
          success: false,
          error: err.message
        });
      }

      res.json({
        success: true,
        clients: rows
      });
    });
  } catch (error) {
    console.error('Error fetching clients:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
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

const validateAdminAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ success: false, error: 'No authorization header' });
  }
  const token = authHeader.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
};

app.post('/api/v1/db/raw-query', validateAdminAuth, async (req, res) => {
  try {
    const { sql, arguments: args } = req.body;
    const pgSql = convertPlaceholders(sql);
    const result = await pool.query(pgSql, args || []);
    res.json({ success: true, rows: result.rows });
  } catch (error) {
    console.error('Error running raw-query:', error, '\nSQL:', req.body.sql, '\nArgs:', req.body.arguments);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/v1/db/execute', validateAdminAuth, async (req, res) => {
  try {
    const { sql, arguments: args } = req.body;
    const pgSql = convertPlaceholders(sql);
    await pool.query(pgSql, args || []);
    res.json({ success: true });
  } catch (error) {
    console.error('Error executing SQL:', error, '\nSQL:', req.body.sql, '\nArgs:', req.body.arguments);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── DATA SYNC ENDPOINTS ─────────────────────────────────────────────────────
// Middleware to authenticate client via license token (JWT)
const validateClientToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ success: false, error: 'No authorization header' });
  }
  const token = authHeader.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.clientId = decoded.client_id;
    req.schema = `client_${decoded.client_id}`;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
};

// POST /api/v1/data/push  — el cliente envía cambios locales al servidor
// Body: { table, records: [{ id, ...fields, _updated_at }], last_push_at }
app.post('/api/v1/data/push', validateClientToken, async (req, res) => {
  const { table, records } = req.body;
  const schema = req.schema;

  const ALLOWED_TABLES = ['productos', 'clientes', 'ventas', 'venta_items'];
  if (!ALLOWED_TABLES.includes(table)) {
    return res.status(400).json({ success: false, error: `Table "${table}" is not syncable` });
  }
  if (!Array.isArray(records) || records.length === 0) {
    return res.json({ success: true, pushed: 0 });
  }

  try {
    // Ensure schema and table exist
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await createClientTables(pool, schema);

    let pushed = 0;
    for (const record of records) {
      const { id, _updated_at, ...fields } = record;
      const cols = Object.keys(fields);
      if (cols.length === 0) continue;

      // Upsert: insert or update based on id
      const setClauses = cols.map((c, i) => `"${c}" = $${i + 2}`).join(', ');
      const values = [id, ...Object.values(fields)];

      await pool.query(
        `INSERT INTO ${schema}.${table} (id, ${cols.map(c => `"${c}"`).join(', ')})
         VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
         ON CONFLICT (id) DO UPDATE SET ${setClauses}, updated_at = NOW()`,
        values
      ).catch(async () => {
        // If id column not there (e.g., venta_items), just insert ignoring conflict
        await pool.query(
          `INSERT INTO ${schema}.${table} (${cols.map(c => `"${c}"`).join(', ')})
           VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
           ON CONFLICT DO NOTHING`,
          Object.values(fields)
        );
      });
      pushed++;
    }

    console.log(`[SYNC PUSH] schema=${schema} table=${table} pushed=${pushed}`);
    res.json({ success: true, pushed });
  } catch (error) {
    console.error('[SYNC PUSH ERROR]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/v1/data/pull  — el cliente descarga cambios del servidor desde una fecha
// Query: ?table=productos&since=2026-01-01T00:00:00Z
app.get('/api/v1/data/pull', validateClientToken, async (req, res) => {
  const { table, since } = req.query;
  const schema = req.schema;

  const ALLOWED_TABLES = ['productos', 'clientes', 'ventas', 'venta_items'];
  if (!ALLOWED_TABLES.includes(table)) {
    return res.status(400).json({ success: false, error: `Table "${table}" is not syncable` });
  }

  try {
    // Ensure schema/tables exist (first pull after fresh install)
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await createClientTables(pool, schema);

    let result;
    if (since) {
      result = await pool.query(
        `SELECT * FROM ${schema}.${table} WHERE updated_at >= $1 ORDER BY updated_at ASC LIMIT 1000`,
        [since]
      );
    } else {
      result = await pool.query(
        `SELECT * FROM ${schema}.${table} ORDER BY updated_at ASC LIMIT 1000`
      );
    }

    console.log(`[SYNC PULL] schema=${schema} table=${table} since=${since} rows=${result.rows.length}`);
    res.json({ success: true, records: result.rows, pulled_at: new Date().toISOString() });
  } catch (error) {
    console.error('[SYNC PULL ERROR]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Merka Control Center Backend running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

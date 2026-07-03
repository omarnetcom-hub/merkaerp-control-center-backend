const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Usar PostgreSQL en producción (Render) o SQLite localmente
const USE_POSTGRES = process.env.DATABASE_URL !== undefined;

let pool;
let db;

function initializeDatabase() {
  if (USE_POSTGRES) {
    // PostgreSQL para producción en Render
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });

    console.log('Conectado a PostgreSQL');
    return createTablesPostgres();
  } else {
    // SQLite para desarrollo local
    const DB_PATH = process.env.DB_PATH || './data/control_center.db';
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) {
          reject(err);
        } else {
          console.log('Conectado a SQLite:', DB_PATH);
          createTablesSQLite()
            .then(() => resolve())
            .catch(reject);
        }
      });
    });
  }
}

function createTablesSQLite() {
  return new Promise((resolve, reject) => {
    const tables = [
      // Tabla de instalaciones
      `CREATE TABLE IF NOT EXISTS installations (
        id TEXT PRIMARY KEY,
        company_name TEXT NOT NULL,
        tax_id TEXT,
        version TEXT NOT NULL,
        os TEXT NOT NULL,
        license_status TEXT DEFAULT 'local',
        license_plan TEXT DEFAULT 'unknown',
        license_expiry TEXT,
        status TEXT DEFAULT 'active',
        blocked INTEGER DEFAULT 0,
        blocked_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        last_heartbeat TEXT
      )`,
      
      // Tabla de heartbeats
      `CREATE TABLE IF NOT EXISTS heartbeats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        installation_id TEXT NOT NULL,
        company_name TEXT,
        tax_id TEXT,
        version TEXT,
        os TEXT,
        license_status TEXT,
        license_plan TEXT,
        license_expiry TEXT,
        sync_status TEXT,
        database_status TEXT,
        critical_errors INTEGER DEFAULT 0,
        update_available INTEGER DEFAULT 0,
        update_version TEXT,
        metrics TEXT,
        received_at TEXT NOT NULL,
        FOREIGN KEY (installation_id) REFERENCES installations(id)
      )`,
      
      // Tabla de eventos de telemetría
      `CREATE TABLE IF NOT EXISTS telemetry_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        installation_id TEXT,
        company_name TEXT,
        tax_id TEXT,
        event TEXT NOT NULL,
        module TEXT,
        severity TEXT DEFAULT 'info',
        received_at TEXT NOT NULL,
        FOREIGN KEY (installation_id) REFERENCES installations(id)
      )`,
      
      // Tabla de comandos remotos
      `CREATE TABLE IF NOT EXISTS remote_commands (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        action TEXT NOT NULL,
        params TEXT,
        status TEXT DEFAULT 'pending',
        created_at TEXT NOT NULL,
        sent_at TEXT,
        acknowledged_at TEXT,
        result TEXT,
        FOREIGN KEY (installation_id) REFERENCES installations(id)
      )`,
      
      // Tabla de actualizaciones
      `CREATE TABLE IF NOT EXISTS updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version TEXT NOT NULL,
        canal TEXT NOT NULL,
        fecha_publicacion TEXT NOT NULL,
        url_descarga TEXT NOT NULL,
        tamano_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        notas TEXT,
        obligatoria INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
      
      // Tabla de licencias
      `CREATE TABLE IF NOT EXISTS licenses (
        id TEXT PRIMARY KEY,
        installation_id TEXT UNIQUE NOT NULL,
        plan TEXT NOT NULL,
        estado TEXT NOT NULL,
        fecha_expiracion TEXT NOT NULL,
        modulos TEXT,
        limite_db_mb INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        FOREIGN KEY (installation_id) REFERENCES installations(id)
      )`,
      
      // Tabla de eventos de sincronización
      `CREATE TABLE IF NOT EXISTS sync_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE NOT NULL,
        user_id TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        table_name TEXT NOT NULL,
        operation TEXT NOT NULL,
        data TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        processed_at TEXT,
        FOREIGN KEY (installation_id) REFERENCES installations(id)
      )`,
      
      // Tabla de conflictos de sincronización
      `CREATE TABLE IF NOT EXISTS sync_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        installation_id TEXT NOT NULL,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        local_data TEXT NOT NULL,
        remote_data TEXT NOT NULL,
        resolved INTEGER DEFAULT 0,
        resolution TEXT,
        resolved_data TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY (installation_id) REFERENCES installations(id)
      )`,
      
      // Tabla de usuarios
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        full_name TEXT,
        company_id TEXT,
        role TEXT DEFAULT 'user',
        created_at TEXT NOT NULL,
        updated_at TEXT,
        last_login TEXT,
        is_active INTEGER DEFAULT 1
      )`,
      
      // Tabla de sesiones de usuario
      `CREATE TABLE IF NOT EXISTS user_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        device_info TEXT,
        ip_address TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,
      
      // Tabla de clientes (del Control Center)
      `CREATE TABLE IF NOT EXISTS cc_clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        password TEXT
      )`,
      
      // Tabla de licencias
      `CREATE TABLE IF NOT EXISTS cc_licenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        FOREIGN KEY (client_id) REFERENCES cc_clients(id)
      )`,
      
      // Tabla de revendedores
      `CREATE TABLE IF NOT EXISTS cc_resellers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      )`,
      
      // Tabla de leads (CRM)
      `CREATE TABLE IF NOT EXISTS cc_leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        company TEXT,
        email TEXT,
        phone TEXT,
        source TEXT,
        status TEXT NOT NULL,
        notes TEXT,
        assigned_to TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      
      // Tabla de tickets de soporte
      `CREATE TABLE IF NOT EXISTS cc_tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        FOREIGN KEY (client_id) REFERENCES cc_clients(id)
      )`,
      
      // Tabla de facturas
      `CREATE TABLE IF NOT EXISTS cc_invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        invoice_number TEXT NOT NULL,
        status TEXT NOT NULL,
        total REAL NOT NULL,
        due_date TEXT NOT NULL,
        paid_at TEXT,
        items_json TEXT,
        FOREIGN KEY (client_id) REFERENCES cc_clients(id)
      )`,
      
      // Tabla de pagos
      `CREATE TABLE IF NOT EXISTS cc_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        payment_date TEXT NOT NULL,
        payment_method TEXT,
        reference TEXT,
        notes TEXT,
        FOREIGN KEY (client_id) REFERENCES cc_clients(id)
      )`
    ];

    let completed = 0;
    const total = tables.length;

    tables.forEach((sql, index) => {
      db.run(sql, (err) => {
        if (err) {
          console.error('Error creando tabla:', err);
          reject(err);
        } else {
          completed++;
          if (completed === total) {
            console.log('Todas las tablas creadas exitosamente');
            // Migración: Agregar campo password a cc_clients si no existe
            db.run('ALTER TABLE cc_clients ADD COLUMN password TEXT', (err) => {
              if (err && !err.message.includes('duplicate column')) {
                console.error('Error en migración password:', err);
              }
              createIndexes()
                .then(() => resolve())
                .catch(reject);
            });
          }
        }
      });
    });
  });
}

function createTablesPostgres() {
  return new Promise((resolve, reject) => {
    const tables = [
      // Tablas sin dependencias (crear primero)
      `CREATE TABLE IF NOT EXISTS installations (
        id TEXT PRIMARY KEY,
        company_name TEXT NOT NULL,
        tax_id TEXT,
        version TEXT NOT NULL,
        os TEXT NOT NULL,
        license_status TEXT DEFAULT 'local',
        license_plan TEXT DEFAULT 'unknown',
        license_expiry TEXT,
        status TEXT DEFAULT 'active',
        blocked INTEGER DEFAULT 0,
        blocked_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        last_heartbeat TEXT
      )`,
      
      `CREATE TABLE IF NOT EXISTS updates (
        id SERIAL PRIMARY KEY,
        version TEXT NOT NULL,
        canal TEXT NOT NULL,
        fecha_publicacion TEXT NOT NULL,
        url_descarga TEXT NOT NULL,
        tamano_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        notas TEXT,
        obligatoria INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
      
      `CREATE TABLE IF NOT EXISTS cc_clients (
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
        subscription_months INTEGER DEFAULT 12
      )`,
      
      `CREATE TABLE IF NOT EXISTS cc_resellers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        nit TEXT,
        contact TEXT,
        phone TEXT,
        email TEXT,
        address TEXT,
        city TEXT,
        country TEXT,
        status TEXT NOT NULL,
        tier TEXT NOT NULL,
        commission_rate REAL NOT NULL DEFAULT 0.1,
        created_at TEXT NOT NULL
      )`,
      
      `CREATE TABLE IF NOT EXISTS cc_leads (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        company TEXT,
        email TEXT,
        phone TEXT,
        stage TEXT NOT NULL,
        value REAL NOT NULL DEFAULT 0,
        next_action_at TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT
      )`,
      
      `CREATE TABLE IF NOT EXISTS users (
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
      )`,
      
      // Tablas que dependen de las anteriores
      `CREATE TABLE IF NOT EXISTS heartbeats (
        id SERIAL PRIMARY KEY,
        installation_id TEXT NOT NULL,
        company_name TEXT,
        tax_id TEXT,
        version TEXT,
        os TEXT,
        license_status TEXT,
        license_plan TEXT,
        license_expiry TEXT,
        sync_status TEXT,
        database_status TEXT,
        critical_errors INTEGER DEFAULT 0,
        update_available INTEGER DEFAULT 0,
        update_version TEXT,
        metrics TEXT,
        received_at TEXT NOT NULL,
        FOREIGN KEY (installation_id) REFERENCES installations(id)
      )`,
      
      `CREATE TABLE IF NOT EXISTS telemetry_events (
        id SERIAL PRIMARY KEY,
        installation_id TEXT,
        company_name TEXT,
        tax_id TEXT,
        event TEXT NOT NULL,
        module TEXT,
        severity TEXT DEFAULT 'info',
        received_at TEXT NOT NULL,
        FOREIGN KEY (installation_id) REFERENCES installations(id)
      )`,
      
      `CREATE TABLE IF NOT EXISTS remote_commands (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        action TEXT NOT NULL,
        params TEXT,
        status TEXT DEFAULT 'pending',
        created_at TEXT NOT NULL,
        sent_at TEXT,
        acknowledged_at TEXT,
        result TEXT,
        FOREIGN KEY (installation_id) REFERENCES installations(id)
      )`,
      
      `CREATE TABLE IF NOT EXISTS licenses (
        id TEXT PRIMARY KEY,
        installation_id TEXT UNIQUE NOT NULL,
        plan TEXT NOT NULL,
        estado TEXT NOT NULL,
        fecha_expiracion TEXT NOT NULL,
        modulos TEXT,
        limite_db_mb INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        FOREIGN KEY (installation_id) REFERENCES installations(id)
      )`,
      
      `CREATE TABLE IF NOT EXISTS cc_licenses (
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
        FOREIGN KEY (client_id) REFERENCES cc_clients(id)
      )`,
      
      `CREATE TABLE IF NOT EXISTS cc_tickets (
        id SERIAL PRIMARY KEY,
        client_id INTEGER,
        subject TEXT NOT NULL,
        description TEXT,
        priority TEXT NOT NULL,
        status TEXT NOT NULL,
        assigned_to INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        resolved_at TEXT,
        FOREIGN KEY (client_id) REFERENCES cc_clients(id)
      )`,
      
      `CREATE TABLE IF NOT EXISTS cc_invoices (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        invoice_number TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'COP',
        status TEXT NOT NULL,
        due_date TEXT NOT NULL,
        paid_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (client_id) REFERENCES cc_clients(id)
      )`,
      
      `CREATE TABLE IF NOT EXISTS user_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )`,
      
      // Tablas que dependen de las anteriores
      `CREATE TABLE IF NOT EXISTS cc_payments (
        id SERIAL PRIMARY KEY,
        invoice_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        payment_method TEXT NOT NULL,
        payment_date TEXT NOT NULL,
        reference TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (invoice_id) REFERENCES cc_invoices(id)
      )`
    ];

    let completed = 0;
    const total = tables.length;

    tables.forEach((sql, index) => {
      pool.query(sql, (err) => {
        if (err) {
          console.error('Error creando tabla PostgreSQL:', err);
          reject(err);
        } else {
          completed++;
          if (completed === total) {
            console.log('Todas las tablas PostgreSQL creadas exitosamente');
            resolve();
          }
        }
      });
    });
  });
}

function createIndexes() {
  return new Promise((resolve, reject) => {
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_heartbeats_installation ON heartbeats(installation_id)',
      'CREATE INDEX IF NOT EXISTS idx_heartbeats_received ON heartbeats(received_at)',
      'CREATE INDEX IF NOT EXISTS idx_telemetry_installation ON telemetry_events(installation_id)',
      'CREATE INDEX IF NOT EXISTS idx_telemetry_received ON telemetry_events(received_at)',
      'CREATE INDEX IF NOT EXISTS idx_commands_installation ON remote_commands(installation_id)',
      'CREATE INDEX IF NOT EXISTS idx_commands_status ON remote_commands(status)',
      'CREATE INDEX IF NOT EXISTS idx_licenses_installation ON licenses(installation_id)',
      'CREATE INDEX IF NOT EXISTS idx_sync_events_installation ON sync_events(installation_id)',
      'CREATE INDEX IF NOT EXISTS idx_sync_events_timestamp ON sync_events(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_sync_conflicts_installation ON sync_conflicts(installation_id)',
      'CREATE INDEX IF NOT EXISTS idx_sync_conflicts_resolved ON sync_conflicts(resolved)',
      'CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)',
      'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)',
      'CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id)',
      'CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token)'
    ];

    let completed = 0;
    const total = indexes.length;

    indexes.forEach((sql, index) => {
      db.run(sql, (err) => {
        if (err) {
          console.error('Error creando índice:', err);
          reject(err);
        } else {
          completed++;
          if (completed === total) {
            console.log('Todos los índices creados exitosamente');
            resolve();
          }
        }
      });
    });
  });
}

function getDatabase() {
  if (USE_POSTGRES) {
    return pool;
  }
  return db;
}

// Helper para ejecutar queries de forma compatible con SQLite y PostgreSQL
function query(sql, params = []) {
  if (USE_POSTGRES) {
    return new Promise((resolve, reject) => {
      pool.query(sql, params, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  } else {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ insertId: this.lastID, rowsAffected: this.changes });
      });
    });
  }
}

function queryAll(sql, params = []) {
  if (USE_POSTGRES) {
    return new Promise((resolve, reject) => {
      pool.query(sql, params, (err, result) => {
        if (err) reject(err);
        else resolve(result.rows);
      });
    });
  } else {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }
}

function queryGet(sql, params = []) {
  if (USE_POSTGRES) {
    return new Promise((resolve, reject) => {
      pool.query(sql, params, (err, result) => {
        if (err) reject(err);
        else resolve(result.rows[0] || null);
      });
    });
  } else {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }
}

module.exports = {
  initializeDatabase,
  getDatabase,
  query,
  queryAll,
  queryGet
};

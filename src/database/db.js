const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './data/control_center.db';

// Asegurar que el directorio de datos existe
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db;

function initializeDatabase() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        reject(err);
      } else {
        console.log('Conectado a SQLite:', DB_PATH);
        createTables()
          .then(() => resolve())
          .catch(reject);
      }
    });
  });
}

function createTables() {
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
  return db;
}

module.exports = {
  initializeDatabase,
  getDatabase
};

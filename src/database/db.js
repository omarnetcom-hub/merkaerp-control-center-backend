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
            createIndexes()
              .then(() => resolve())
              .catch(reject);
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
      'CREATE INDEX IF NOT EXISTS idx_sync_conflicts_resolved ON sync_conflicts(resolved)'
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

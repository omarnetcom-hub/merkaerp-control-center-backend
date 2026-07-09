#!/usr/bin/env node
/**
 * Database Migration Runner
 * Aplicar migraciones Odoo a la base de datos
 * 
 * Uso:
 *   node migrate-odoo.js
 *   
 * Variables de entorno:
 *   DATABASE_URL - Conexión PostgreSQL
 *   DB_PATH - Ruta para SQLite (si no usa PostgreSQL)
 */

require('dotenv').config();

const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const USE_POSTGRES = process.env.DATABASE_URL !== undefined;

async function runMigrations() {
  try {
    console.log('🚀 Iniciando migraciones Odoo 19.0...\n');

    if (USE_POSTGRES) {
      await runPostgresMigrations();
    } else {
      await runSQLiteMigrations();
    }

    console.log('\n✅ Migraciones completadas exitosamente!\n');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error en migraciones:', error.message);
    process.exit(1);
  }
}

async function runPostgresMigrations() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('📊 Conectando a PostgreSQL...');
    const client = await pool.connect();
    console.log('✓ Conectado\n');

    // Leer archivo de migraciones
    const migrationPath = path.join(__dirname, 'src/database/migrations/001_phase1_core.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

    console.log('📝 Aplicando migraciones Odoo PHASE 1...\n');

    // Dividir por puntos y coma y ejecutar cada sentencia
    const statements = migrationSQL.split(';').filter(stmt => stmt.trim());
    let count = 0;

    for (const statement of statements) {
      if (statement.trim()) {
        try {
          await client.query(statement);
          count++;
          const statementPreview = statement.trim().substring(0, 50);
          console.log(`  ✓ [${count}] ${statementPreview}...`);
        } catch (err) {
          if (!err.message.includes('already exists')) {
            throw err;
          }
          console.log(`  ⚠ [${count}] ${statement.trim().substring(0, 50)}... (ya existe)`);
          count++;
        }
      }
    }

    await client.release();
    console.log(`\n✅ ${count} sentencias SQL ejecutadas`);
  } finally {
    await pool.end();
  }
}

async function runSQLiteMigrations() {
  return new Promise((resolve, reject) => {
    const dbPath = process.env.DB_PATH || './data/cajasimple.db';
    const dataDir = path.dirname(dbPath);

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    console.log(`📊 Conectando a SQLite: ${dbPath}...`);

    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        return reject(err);
      }

      console.log('✓ Conectado\n');

      // Leer archivo de migraciones
      const migrationPath = path.join(__dirname, 'src/database/migrations/001_phase1_core.sql');
      const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

      console.log('📝 Aplicando migraciones Odoo PHASE 1...\n');

      // Dividir y ejecutar
      const statements = migrationSQL.split(';').filter(stmt => stmt.trim());
      let count = 0;
      let errors = 0;

      const executeNext = () => {
        if (count >= statements.length) {
          db.close((err) => {
            if (err) return reject(err);
            console.log(`\n✅ ${count - errors} sentencias ejecutadas, ${errors} errores`);
            resolve();
          });
          return;
        }

        const stmt = statements[count];
        if (stmt.trim()) {
          db.run(stmt, (err) => {
            if (err) {
              if (!err.message.includes('already exists')) {
                console.log(`  ❌ Error: ${err.message}`);
                errors++;
              } else {
                console.log(`  ⚠ [${count + 1}] ${stmt.trim().substring(0, 50)}... (ya existe)`);
              }
            } else {
              console.log(`  ✓ [${count + 1}] ${stmt.trim().substring(0, 50)}...`);
            }
            count++;
            executeNext();
          });
        } else {
          count++;
          executeNext();
        }
      };

      executeNext();
    });
  });
}

// Ejecutar
runMigrations();

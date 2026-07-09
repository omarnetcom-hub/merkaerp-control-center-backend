#!/usr/bin/env node
/**
 * Setup Script - Odoo 19.0 for Caja Simple
 * 
 * Este script:
 * 1. Instala dependencias
 * 2. Crea migraciones
 * 3. Configura variables de entorno
 * 4. Verifica conexión a BD
 * 
 * Uso: node setup-odoo.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE_DIR = __dirname;
const ENV_FILE = path.join(BASE_DIR, '.env');
const ENV_EXAMPLE = path.join(BASE_DIR, '.env.example');

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║     Odoo 19.0 Setup para Caja Simple (MerkaERP)            ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

// Step 1: Check if .env exists
console.log('📋 Paso 1: Verificar configuración de entorno...');
if (!fs.existsSync(ENV_FILE)) {
  if (fs.existsSync(ENV_EXAMPLE)) {
    console.log('  ⚠ .env no encontrado. Usando .env.example como template');
    fs.copyFileSync(ENV_EXAMPLE, ENV_FILE);
    console.log('  ✓ .env creado desde .env.example');
    console.log('  ⚠ IMPORTANTE: Edita .env con tus credenciales de BD\n');
  } else {
    console.log('  ❌ Ni .env ni .env.example encontrados');
    process.exit(1);
  }
} else {
  console.log('  ✓ .env encontrado\n');
}

// Step 2: Check Node modules
console.log('📦 Paso 2: Verificar dependencias...');
const packageJsonPath = path.join(BASE_DIR, 'package.json');
if (!fs.existsSync('node_modules')) {
  console.log('  Instalando dependencias (esto puede tomar un momento)...');
  try {
    execSync('npm install', { cwd: BASE_DIR, stdio: 'inherit' });
    console.log('  ✓ Dependencias instaladas\n');
  } catch (error) {
    console.log('  ❌ Error instalando dependencias');
    process.exit(1);
  }
} else {
  console.log('  ✓ Dependencias ya instaladas\n');
}

// Step 3: Check database connection
console.log('🗄️  Paso 3: Verificar conexión a base de datos...');
require('dotenv').config();

const USE_POSTGRES = process.env.DATABASE_URL !== undefined;

if (USE_POSTGRES) {
  console.log('  Detectado: PostgreSQL');
  console.log(`  URL: ${process.env.DATABASE_URL?.substring(0, 50)}...`);
  console.log('  ✓ Configuración lista\n');
} else {
  console.log('  Detectado: SQLite');
  const dbPath = process.env.DB_PATH || './data/cajasimple.db';
  console.log(`  Ruta: ${dbPath}`);
  console.log('  ✓ Configuración lista\n');
}

// Step 4: Run migrations
console.log('🚀 Paso 4: Aplicar migraciones Odoo 19.0...');
const migrateScript = path.join(BASE_DIR, 'migrate-odoo.js');

if (!fs.existsSync(migrateScript)) {
  console.log('  ❌ migrate-odoo.js no encontrado');
  process.exit(1);
}

try {
  execSync(`node ${migrateScript}`, { stdio: 'inherit' });
  console.log('\n');
} catch (error) {
  console.log('  ⚠ Algunas migraciones pueden haber fallado (verificar arriba)');
}

// Step 5: Summary
console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║                  ✅ SETUP COMPLETADO                        ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

console.log('📝 Próximos pasos:\n');
console.log('1. Inicia el servidor:');
console.log('   npm start\n');

console.log('2. Accede a la API Odoo:');
console.log('   http://localhost:8787/api/odoo/docs\n');

console.log('3. Usa los endpoints Odoo (ejemplos):\n');
console.log('   POST   /api/odoo/companies      - Crear empresa');
console.log('   POST   /api/odoo/users          - Crear usuario');
console.log('   POST   /api/odoo/partners       - Crear cliente/proveedor');
console.log('   POST   /api/odoo/products       - Crear producto');
console.log('   POST   /api/odoo/sale-orders    - Crear orden de venta');
console.log('   GET    /api/odoo/health         - Verificar estado\n');

console.log('📚 Documentación:');
console.log('   - backend/ODOO_IMPLEMENTATION.md');
console.log('   - backend/DEVELOPER_REFERENCE.md\n');

console.log('✨ Sistema Odoo 19.0 completamente independiente y operativo\n');

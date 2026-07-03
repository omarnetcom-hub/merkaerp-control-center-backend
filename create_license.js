const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'control_center.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error conectando:', err);
    process.exit(1);
  }
  console.log('Conectado a:', DB_PATH);
});

// Crear licencia para el cliente ID 2
const licenseId = Math.floor(Math.random() * 10000) + 1000;

db.run(
  `INSERT INTO cc_licenses (
    id, client_id, type, status, expires_at, max_users, max_devices, 
    max_branches, modules, token_hint, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    licenseId,
    2,
    'Básica',
    'ACTIVO',
    '2099-12-31',
    1,
    1,
    1,
    'sales,purchases,inventory,cash,accounting,reports',
    'PERPETUA',
    new Date().toISOString()
  ],
  function(err) {
    if (err) {
      console.error('Error creando licencia:', err);
      process.exit(1);
    }
    console.log('Licencia creada con ID:', licenseId);
    
    // Verificar
    db.all('SELECT * FROM cc_licenses WHERE client_id = 2', (err, rows) => {
      if (err) {
        console.error('Error:', err);
      } else {
        console.log('Licencias del cliente 2:');
        rows.forEach(license => {
          console.log(`ID: ${license.id}, Type: ${license.type}, Status: ${license.status}`);
        });
      }
      db.close();
    });
  }
);

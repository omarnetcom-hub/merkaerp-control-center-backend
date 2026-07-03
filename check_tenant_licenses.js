const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join('C:', 'Users', 'PC', 'Documents', 'caja_simple.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error conectando:', err);
    process.exit(1);
  }
  console.log('Conectado a:', DB_PATH);
});

db.all('SELECT * FROM tenant_licenses', (err, rows) => {
  if (err) {
    console.error('Error:', err);
    process.exit(1);
  }

  console.log('Licencias en tenant_licenses:');
  rows.forEach(license => {
    console.log(JSON.stringify(license, null, 2));
  });
  
  db.close();
});

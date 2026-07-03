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

db.all('SELECT * FROM cc_clients', (err, rows) => {
  if (err) {
    console.error('Error:', err);
    process.exit(1);
  }

  console.log('Clientes en el backend:');
  rows.forEach(client => {
    console.log(`ID: ${client.id}, Nombre: ${client.name}, Email: ${client.contact_email}, License Type: ${client.license_type}, Status: ${client.status}`);
  });

  db.all('SELECT * FROM cc_licenses', (err, licenses) => {
    if (err) {
      console.error('Error:', err);
    } else {
      console.log('\nLicencias en el backend:');
      licenses.forEach(license => {
        console.log(`ID: ${license.id}, ClientID: ${license.client_id}, Type: ${license.type}, Status: ${license.status}, Expires: ${license.expires_at}`);
      });
    }
    db.close();
  });
});

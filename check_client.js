const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'control_center.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error conectando a la base de datos:', err);
    process.exit(1);
  }
  console.log('Conectado a la base de datos:', DB_PATH);
});

const email = 'fernandovelez@gmail.com';

db.get(
  'SELECT * FROM cc_clients WHERE contact_email = ?',
  [email],
  (err, row) => {
    if (err) {
      console.error('Error consultando:', err);
    } else if (row) {
      console.log('Cliente encontrado:');
      console.log('ID:', row.id);
      console.log('Nombre:', row.name);
      console.log('Email:', row.contact_email);
      console.log('Password:', row.password);
      console.log('Status:', row.status);
      console.log('Plan:', row.plan);
    } else {
      console.log('Cliente NO encontrado con email:', email);
    }
    
    // Verificar todas las licencias
    db.all('SELECT * FROM cc_licenses', (err, rows) => {
      if (err) {
        console.error('Error consultando licencias:', err);
      } else {
        console.log('\nTodas las licencias:');
        rows.forEach(license => {
          console.log(`ID: ${license.id}, ClientID: ${license.client_id}, Type: ${license.type}, Status: ${license.status}`);
        });
      }
      
      db.close();
    });
  }
);

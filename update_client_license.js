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

// Actualizar cliente Fernando Velez con tipo de licencia PERPETUA
db.run(
  `UPDATE cc_clients 
   SET license_type = 'PERPETUA', subscription_months = 12
   WHERE id = 2`,
  (err) => {
    if (err) {
      console.error('Error actualizando cliente:', err);
      process.exit(1);
    }
    console.log('Cliente actualizado con tipo de licencia PERPETUA');
    
    // Verificar
    db.get('SELECT * FROM cc_clients WHERE id = 2', (err, client) => {
      if (err) {
        console.error('Error:', err);
      } else {
        console.log('Cliente actualizado:');
        console.log('ID:', client.id);
        console.log('Nombre:', client.name);
        console.log('Email:', client.contact_email);
        console.log('License Type:', client.license_type);
        console.log('Subscription Months:', client.subscription_months);
      }
      db.close();
    });
  }
);

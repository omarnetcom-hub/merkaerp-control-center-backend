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

// Agregar columnas license_type y subscription_months a cc_clients
db.run('ALTER TABLE cc_clients ADD COLUMN license_type TEXT DEFAULT "SUSCRIPCION"', (err) => {
  if (err) {
    if (err.message.includes('duplicate column')) {
      console.log('Columna license_type ya existe');
    } else {
      console.error('Error agregando license_type:', err);
    }
  } else {
    console.log('Columna license_type agregada');
  }
  
  db.run('ALTER TABLE cc_clients ADD COLUMN subscription_months INTEGER DEFAULT 12', (err) => {
    if (err) {
      if (err.message.includes('duplicate column')) {
        console.log('Columna subscription_months ya existe');
      } else {
        console.error('Error agregando subscription_months:', err);
      }
    } else {
      console.log('Columna subscription_months agregada');
    }
    
    // Actualizar cliente Fernando Velez
    db.run(
      `UPDATE cc_clients 
       SET license_type = 'PERPETUA', subscription_months = 12
       WHERE id = 2`,
      (err) => {
        if (err) {
          console.error('Error actualizando cliente:', err);
        } else {
          console.log('Cliente Fernando Velez actualizado con licencia PERPETUA');
        }
        
        db.close();
      }
    );
  });
});

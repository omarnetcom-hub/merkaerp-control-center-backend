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

// Limpiar licencia para volver a trial
db.run(
  `UPDATE licenses SET status = 'trial', key = NULL, activated_at = NULL, expires_at = NULL WHERE 1=1`,
  (err) => {
    if (err) {
      console.error('Error limpiando licencia:', err);
      process.exit(1);
    }
    console.log('Licencia limpiada - volverá a trial');
    
    // Verificar
    db.get('SELECT * FROM licenses LIMIT 1', (err, license) => {
      if (err) {
        console.error('Error:', err);
      } else if (license) {
        console.log('Estado de licencia:');
        console.log('Status:', license.status);
        console.log('Key:', license.key);
        console.log('Expires:', license.expires_at);
      } else {
        console.log('No hay licencia en la base de datos');
      }
      db.close();
    });
  }
);

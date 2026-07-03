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

db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
  if (err) {
    console.error('Error:', err);
    process.exit(1);
  }
  
  console.log('Tablas:');
  tables.forEach(t => console.log(' -', t.name));
  
  db.all("PRAGMA table_info(cc_licenses)", (err, columns) => {
    if (err) {
      console.error('Error:', err);
      process.exit(1);
    }
    
    console.log('\nColumnas de cc_licenses:');
    columns.forEach(col => {
      console.log(` - ${col.name}: ${col.type}`);
    });
    
    db.close();
  });
});

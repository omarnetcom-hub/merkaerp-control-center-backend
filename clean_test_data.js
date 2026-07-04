const { Pool } = require('pg');

// Usar la DATABASE_URL del entorno o una por defecto para pruebas locales
const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/control_center';

const pool = new Pool({
  connectionString,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function cleanTestData() {
  try {
    console.log('Conectando a PostgreSQL...');
    
    // Eliminar instalaciones de prueba
    const deleteInstallations = await pool.query(
      "DELETE FROM installations WHERE company_name LIKE '%Test%' OR company_name LIKE '%Verify%' OR company_name LIKE '%New%'"
    );
    console.log(`Eliminadas ${deleteInstallations.rowCount} instalaciones de prueba`);
    
    // Eliminar licencias de prueba
    const deleteLicenses = await pool.query(
      "DELETE FROM cc_licenses WHERE client_id IN (SELECT id FROM cc_clients WHERE name LIKE '%Test%' OR name LIKE '%Verify%' OR name LIKE '%New%')"
    );
    console.log(`Eliminadas ${deleteLicenses.rowCount} licencias de prueba`);
    
    // Eliminar clientes de prueba
    const deleteClients = await pool.query(
      "DELETE FROM cc_clients WHERE name LIKE '%Test%' OR name LIKE '%Verify%' OR name LIKE '%New%' OR contact_email LIKE '%test%' OR contact_email LIKE '%verify%' OR contact_email LIKE '%new%'"
    );
    console.log(`Eliminados ${deleteClients.rowCount} clientes de prueba`);
    
    console.log('Limpieza completada exitosamente');
    await pool.end();
  } catch (error) {
    console.error('Error durante la limpieza:', error);
    await pool.end();
    process.exit(1);
  }
}

cleanTestData();

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Base de datos local
const LOCAL_DB_PATH = path.join(__dirname, 'data', 'control_center.db');

// Base de datos del backend online (en Render, pero usaremos local para pruebas)
const ONLINE_DB_PATH = path.join(__dirname, 'data', 'control_center.db');

const localDb = new sqlite3.Database(LOCAL_DB_PATH, (err) => {
  if (err) {
    console.error('Error conectando a DB local:', err);
    process.exit(1);
  }
  console.log('Conectado a DB local');
});

const onlineDb = new sqlite3.Database(ONLINE_DB_PATH, (err) => {
  if (err) {
    console.error('Error conectando a DB online:', err);
    process.exit(1);
  }
  console.log('Conectado a DB online');
});

const email = 'fernandovelez@gmail.com';

// Obtener cliente de DB local
localDb.get(
  'SELECT * FROM cc_clients WHERE contact_email = ?',
  [email],
  (err, client) => {
    if (err) {
      console.error('Error consultando cliente local:', err);
      process.exit(1);
    }

    if (!client) {
      console.log('Cliente no encontrado en DB local');
      process.exit(1);
    }

    console.log('Cliente encontrado en DB local:', client.name);

    // Insertar cliente en DB online
    onlineDb.run(
      `INSERT OR REPLACE INTO cc_clients (
        id, name, nit, city, country, status, plan, contract_value, 
        renewal_date, usage_score, created_at, reseller_id, tax_rate, 
        billing_type, billing_day, notes, contact_name, contact_phone, 
        contact_email, contact_role, password
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        client.id,
        client.name,
        client.nit,
        client.city,
        client.country,
        client.status,
        client.plan,
        client.contract_value,
        client.renewal_date,
        client.usage_score,
        client.created_at,
        client.reseller_id,
        client.tax_rate,
        client.billing_type,
        client.billing_day,
        client.notes,
        client.contact_name,
        client.contact_phone,
        client.contact_email,
        client.contact_role,
        client.password
      ],
      function(err) {
        if (err) {
          console.error('Error insertando cliente en DB online:', err);
          process.exit(1);
        }
        console.log('Cliente insertado en DB online con ID:', client.id);

        // Crear licencia para el cliente
        const licenseId = Math.floor(Math.random() * 10000) + 100;
        onlineDb.run(
          `INSERT INTO cc_licenses (
            id, client_id, type, status, expires_at, max_users, max_devices, 
            max_branches, modules, token_hint, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            licenseId,
            client.id,
            client.plan,
            'ACTIVO',
            '2099-12-31',
            client.plan === 'Empresarial' ? 30 : (client.plan === 'Profesional' ? 8 : 1),
            client.plan === 'Empresarial' ? 50 : (client.plan === 'Profesional' ? 12 : 1),
            client.plan === 'Empresarial' ? 10 : (client.plan === 'Profesional' ? 2 : 1),
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

            localDb.close();
            onlineDb.close();
            console.log('\nSincronización completada exitosamente');
          }
        );
      }
    );
  }
);

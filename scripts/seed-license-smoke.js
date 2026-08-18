const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  const url = new URL(rawUrl);
  const suffix = process.env.RENDER_POSTGRES_HOST_SUFFIX || 'virginia-postgres.render.com';
  if (url.hostname.startsWith('dpg-') && !url.hostname.includes('.')) {
    url.hostname = `${url.hostname}.${suffix}`;
  }
  return url.toString();
}

async function ensureTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cc_clients (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      nit TEXT,
      city TEXT,
      country TEXT,
      status TEXT NOT NULL,
      plan TEXT NOT NULL,
      contract_value REAL NOT NULL DEFAULT 0,
      renewal_date TEXT NOT NULL,
      usage_score INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      reseller_id INTEGER,
      tax_rate REAL NOT NULL DEFAULT 19.0,
      billing_type TEXT NOT NULL DEFAULT 'mensual',
      billing_day INTEGER NOT NULL DEFAULT 5,
      notes TEXT,
      contact_name TEXT,
      contact_phone TEXT,
      contact_email TEXT,
      contact_role TEXT,
      client_password TEXT,
      license_type TEXT DEFAULT 'SUSCRIPCION',
      subscription_months INTEGER DEFAULT 12,
      postgres_schema TEXT,
      postgres_username TEXT,
      postgres_password TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cc_licenses (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      max_users INTEGER NOT NULL,
      max_devices INTEGER NOT NULL,
      max_branches INTEGER NOT NULL,
      modules TEXT NOT NULL,
      token_hint TEXT,
      updated_at TEXT NOT NULL,
      license_type TEXT NOT NULL DEFAULT 'SUSCRIPCION',
      hardware_fingerprint TEXT,
      offline_token TEXT,
      activation_count INTEGER NOT NULL DEFAULT 0,
      last_heartbeat TEXT,
      grace_period_end TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cc_installations (
      id SERIAL PRIMARY KEY,
      uuid TEXT UNIQUE NOT NULL,
      client_id INTEGER NOT NULL DEFAULT 0,
      version TEXT NOT NULL,
      os TEXT NOT NULL,
      connected INTEGER NOT NULL DEFAULT 0,
      license_status TEXT NOT NULL,
      sync_status TEXT NOT NULL,
      database_status TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      critical_errors INTEGER NOT NULL DEFAULT 0,
      ip_address TEXT,
      uptime_hours REAL,
      hardware_fingerprint TEXT,
      company_name TEXT,
      tax_id TEXT,
      license_plan TEXT,
      license_expiry TEXT,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      last_heartbeat TEXT
    )
  `);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const email = process.env.TEST_LICENSE_EMAIL;
  const password = process.env.TEST_LICENSE_PASSWORD;
  if (!email || !password) throw new Error('TEST_LICENSE_EMAIL and TEST_LICENSE_PASSWORD are required');
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  process.env.DATABASE_URL = normalizeDatabaseUrl(process.env.DATABASE_URL);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false'
      ? false
      : { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' },
    connectionTimeoutMillis: 10000,
  });

  try {
    await ensureTables(pool);
    const passwordHash = await bcrypt.hash(password, 10);

    const existingClient = await pool.query('SELECT id FROM cc_clients WHERE contact_email = $1 ORDER BY id LIMIT 1', [email]);
    let clientId;
    if (existingClient.rowCount > 0) {
      clientId = existingClient.rows[0].id;
      await pool.query(`
        UPDATE cc_clients
        SET name = $1, nit = $2, city = $3, country = $4, status = 'active', plan = $5,
            contract_value = $6, renewal_date = $7, usage_score = 100, contact_name = $8,
            contact_phone = $9, contact_email = $10, contact_role = $11, client_password = $12,
            license_type = 'SUSCRIPCION', subscription_months = 12
        WHERE id = $13
      `, ['MERKA Licencias Smoke Test', '900000000-1', 'Medellin', 'Colombia', 'Profesional', 120000, expiresAt, 'QA MERKA', '3000000000', email, 'QA', passwordHash, clientId]);
    } else {
      const inserted = await pool.query(`
        INSERT INTO cc_clients
          (name, nit, city, country, status, plan, contract_value, renewal_date, usage_score,
           created_at, tax_rate, billing_type, billing_day, contact_name, contact_phone,
           contact_email, contact_role, client_password, license_type, subscription_months)
        VALUES
          ($1, $2, $3, $4, 'active', $5, $6, $7, 100, $8, 19, 'mensual', 5, $9, $10, $11, $12, $13, 'SUSCRIPCION', 12)
        RETURNING id
      `, ['MERKA Licencias Smoke Test', '900000000-1', 'Medellin', 'Colombia', 'Profesional', 120000, expiresAt, now, 'QA MERKA', '3000000000', email, 'QA', passwordHash]);
      clientId = inserted.rows[0].id;
    }

    const existingLicense = await pool.query('SELECT id FROM cc_licenses WHERE client_id = $1 ORDER BY id LIMIT 1', [clientId]);
    let licenseId;
    if (existingLicense.rowCount > 0) {
      licenseId = existingLicense.rows[0].id;
      await pool.query(`
        UPDATE cc_licenses
        SET type = 'Profesional', status = 'active', expires_at = $1, max_users = 8,
            max_devices = 12, max_branches = 2, modules = $2, updated_at = $3,
            license_type = 'SUSCRIPCION'
        WHERE id = $4
      `, [expiresAt, 'sales,purchases,inventory,cash,accounting,reports', now, licenseId]);
    } else {
      const inserted = await pool.query(`
        INSERT INTO cc_licenses
          (client_id, type, status, expires_at, max_users, max_devices, max_branches,
           modules, updated_at, license_type, activation_count)
        VALUES ($1, 'Profesional', 'active', $2, 8, 12, 2, $3, $4, 'SUSCRIPCION', 0)
        RETURNING id
      `, [clientId, expiresAt, 'sales,purchases,inventory,cash,accounting,reports', now]);
      licenseId = inserted.rows[0].id;
    }

    console.log(JSON.stringify({
      success: true,
      client_id: clientId,
      license_id: licenseId,
      test_email: email,
      test_password_source: 'TEST_LICENSE_PASSWORD',
    }, null, 2));
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ success: false, error: error.message, code: error.code || null }, null, 2));
  process.exit(1);
});

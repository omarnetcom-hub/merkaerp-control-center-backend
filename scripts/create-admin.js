const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizeDatabaseUrl(rawUrl) {
  const url = new URL(rawUrl);
  const suffix = process.env.RENDER_POSTGRES_HOST_SUFFIX || 'virginia-postgres.render.com';
  if (url.hostname.startsWith('dpg-') && !url.hostname.includes('.')) url.hostname = `${url.hostname}.${suffix}`;
  return url.toString();
}

async function main() {
  const databaseUrl = normalizeDatabaseUrl(required('DATABASE_URL'));
  const username = required('ADMIN_CREATE_USERNAME');
  const password = required('ADMIN_CREATE_PASSWORD');
  const email = required('ADMIN_CREATE_EMAIL');
  const fullName = process.env.ADMIN_CREATE_NAME || username;
  const role = String(process.env.ADMIN_CREATE_ROLE || 'admin').trim().toLowerCase();
  const allowedRoles = new Set(['super_admin', 'admin', 'manager', 'support', 'sales', 'viewer']);
  if (!allowedRoles.has(role)) throw new Error('ADMIN_CREATE_ROLE is invalid');
  if (password.length < 14) throw new Error('ADMIN_CREATE_PASSWORD must contain at least 14 characters');

  const sslEnabled = process.env.DATABASE_SSL !== 'false';
  const rejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false';
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: sslEnabled ? { rejectUnauthorized } : false,
    connectionTimeoutMillis: 10000,
  });

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const existing = await pool.query(
      'SELECT id FROM cc_users WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($2) LIMIT 1',
      [username, email],
    );
    if (existing.rowCount > 0) throw new Error('An administrator with that username or email already exists');
    const result = await pool.query(
      `INSERT INTO cc_users(username,password_hash,email,full_name,role,created_at,is_active,password_changed_at)
       VALUES($1,$2,$3,$4,$5,$6,1,NOW()) RETURNING id,username,email,full_name,role`,
      [username, passwordHash, email, fullName, role, new Date().toISOString()],
    );
    console.log(JSON.stringify({ success: true, user: result.rows[0] }, null, 2));
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
  process.exit(1);
});

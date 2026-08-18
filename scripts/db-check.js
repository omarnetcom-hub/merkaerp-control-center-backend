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

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const connectionString = normalizeDatabaseUrl(process.env.DATABASE_URL);
  const url = new URL(connectionString);
  const sslEnabled = process.env.DATABASE_SSL !== 'false';
  const rejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false';

  // Fail closed by default. Turning certificate validation off is an explicit
  // deployment override and is never attempted automatically by this diagnostic.
  if (sslEnabled && !rejectUnauthorized) {
    console.warn('WARNING: DATABASE_SSL_REJECT_UNAUTHORIZED=false weakens TLS certificate verification.');
  }

  console.log(JSON.stringify({
    target: {
      protocol: url.protocol,
      host: url.hostname,
      port: url.port || '5432',
      database: url.pathname.replace('/', ''),
      user: url.username,
      ssl: sslEnabled,
      rejectUnauthorized: sslEnabled ? rejectUnauthorized : null,
    },
  }, null, 2));

  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 10000,
    ssl: sslEnabled ? { rejectUnauthorized } : false,
  });

  const started = Date.now();
  try {
    const result = await pool.query(`
      SELECT current_database() AS database_name,
             current_user AS user_name,
             version() AS postgres_version,
             now() AS checked_at
    `);
    console.log(JSON.stringify({ ok: true, ms: Date.now() - started, info: result.rows[0] }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      ms: Date.now() - started,
      code: error.code || null,
      message: error.message,
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

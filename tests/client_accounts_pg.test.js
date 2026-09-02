// Execute the actual routes and SQL against disposable in-memory PostgreSQL.
// This never uses DATABASE_URL or customer data for test queries.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused';
process.env.DATABASE_SSL = 'false';
process.env.ADMIN_JWT_SECRET = 'test-admin-secret-'.padEnd(64, 'X');
process.env.DB_CREDENTIAL_SECRET = 'test-db-secret-'.padEnd(64, 'Y');
process.env.NODE_ENV = 'test';
const server = require('../src/server');

test('PostgreSQL: archived identity recovery, repeat purchases and safe deletion', async () => {
  const db = new PGlite();
  const originalQuery = server.pool.query;
  const originalConnect = server.pool.connect;
  let listener;
  let role = 'admin';
  try {
    await db.exec(`
      CREATE TABLE cc_clients (
        id SERIAL PRIMARY KEY, name TEXT, nit TEXT, status TEXT, contact_email TEXT,
        lifecycle_reason TEXT, archived_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
      );
      CREATE TABLE cc_licenses (
        id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES cc_clients(id) ON DELETE CASCADE,
        type TEXT, status TEXT, expires_at TEXT, max_users INT, max_devices INT,
        max_branches INT, modules TEXT, token_hint TEXT, updated_at TEXT, license_type TEXT,
        hardware_fingerprint TEXT, offline_token TEXT, activation_count INT, last_heartbeat TEXT,
        grace_period_end TEXT, product_family TEXT, plan_key TEXT
      );
      CREATE TABLE cc_installations (
        id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES cc_clients(id) ON DELETE CASCADE,
        license_id INTEGER REFERENCES cc_licenses(id), blocked INT, status TEXT
      );
      CREATE TABLE cc_offline_activations (id SERIAL PRIMARY KEY, license_id INTEGER REFERENCES cc_licenses(id), revoked_at TEXT);
      CREATE TABLE cc_audit (actor TEXT, action TEXT, entity TEXT, detail TEXT, created_at TEXT);
      CREATE TABLE legacy_events (client_id INTEGER, payload TEXT);
      CREATE TABLE other_relation (owner_id INTEGER REFERENCES cc_clients(id) ON DELETE CASCADE);
      CREATE SCHEMA client_12;
      INSERT INTO cc_clients(id,name,nit,status,contact_email,archived_at) VALUES
        (7,'Original','1004109757','cancelled','original@example.com',NOW()),
        (8,'Empty','EMPTY','cancelled','empty@example.com',NOW()),
        (9,'Legacy','LEGACY','cancelled','legacy@example.com',NOW()),
        (10,'Foreign key','FK','cancelled','fk@example.com',NOW()),
        (12,'Tenant','TENANT','cancelled','tenant@example.com',NOW());
      INSERT INTO cc_licenses(id,client_id,status,offline_token) VALUES (11,7,'revoked',NULL);
      INSERT INTO cc_installations(client_id,license_id,blocked,status) VALUES (7,11,1,'blocked');
      INSERT INTO cc_offline_activations(license_id,revoked_at) VALUES (11,'2026-09-01T00:00:00Z');
      INSERT INTO legacy_events VALUES (9,'preserve');
      INSERT INTO other_relation VALUES (10);
    `);
    server.pool.query = async (sql, values) => {
      if (sql.includes('FROM cc_users u')) return { rows: [{ id: 1, role, username: 'test' }] };
      return db.query(sql, values);
    };
    server.pool.connect = async () => ({ query: (sql, values) => db.query(sql, values), release() {} });
    await new Promise((resolve) => { listener = server.app.listen(0, '127.0.0.1', resolve); });
    const token = server.signAdminToken({ id: 1, username: 'test', role: 'admin' });
    const post = async (path, body) => {
      const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/v1${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const duplicate = await post('/clients', {
      name: 'Attempted duplicate', nit: ' 1004109757 ', contact_email: 'new@example.com',
      plan: 'Básica', renewal_date: '2027-01-01',
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, 'CLIENT_ARCHIVED');
    assert.equal(duplicate.body.client.id, 7);

    const snapshot = async () => Promise.all(['cc_licenses', 'cc_installations', 'cc_offline_activations'].map(async (table) => (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows));
    const before = await snapshot();
    const restore = await post('/clients/7/lifecycle', { action: 'restore' });
    assert.equal(restore.status, 200, JSON.stringify(restore.body));
    assert.deepEqual(await snapshot(), before);
    const client = (await db.query('SELECT * FROM cc_clients WHERE id=7')).rows[0];
    assert.equal(client.name, 'Original');
    assert.equal(client.status, 'active');
    assert.equal(client.archived_at, null);
    assert.equal((await post('/clients/7/lifecycle', { action: 'restore' })).body.unchanged, true);

    const purchase = await post('/licenses', {
      client_id: 7, type: 'Otra compra', status: 'active', expires_at: '2027-09-02T00:00:00Z',
    });
    assert.equal(purchase.status, 200, JSON.stringify(purchase.body));
    const licenses = (await db.query('SELECT status FROM cc_licenses WHERE client_id=7')).rows;
    assert.equal(licenses.length, 2);
    assert.ok(licenses.some((l) => l.status === 'revoked'));
    assert.ok(licenses.some((l) => l.status === 'active'));
    assert.equal((await post('/licenses', { client_id: 8, type: 'Blocked', expires_at: '2027-01-01' })).status, 409);

    role = 'sales';
    assert.equal((await post('/clients/8/permanent-delete', { confirmation: 'ELIMINAR 8' })).status, 403);
    role = 'admin';
    assert.equal((await post('/clients/8/permanent-delete', { confirmation: 'ELIMINAR 7' })).status, 400);
    await db.query("UPDATE cc_clients SET status='cancelled' WHERE id=7");
    for (const id of [7, 9, 10, 12]) {
      const removal = await post(`/clients/${id}/permanent-delete`, { confirmation: `ELIMINAR ${id}` });
      assert.equal(removal.status, 409, JSON.stringify(removal.body));
      assert.equal(removal.body.code, 'CLIENT_HAS_HISTORY');
      assert.equal((await db.query('SELECT id FROM cc_clients WHERE id=$1', [id])).rows.length, 1);
    }
    const removal = await post('/clients/8/permanent-delete', { confirmation: 'ELIMINAR 8' });
    assert.equal(removal.status, 200, JSON.stringify(removal.body));
    assert.equal((await db.query('SELECT id FROM cc_clients WHERE id=8')).rows.length, 0);
    assert.equal((await db.query("SELECT * FROM cc_audit WHERE action='ELIMINAR_CLIENTE_DEFINITIVO'")).rows.length, 1);
    assert.equal((await db.query('SELECT * FROM legacy_events')).rows.length, 1);
    assert.equal((await db.query('SELECT * FROM other_relation')).rows.length, 1);
  } finally {
    if (listener) await new Promise((resolve) => listener.close(resolve));
    server.pool.query = originalQuery;
    server.pool.connect = originalConnect;
    await server.pool.end();
    await db.close();
  }
});

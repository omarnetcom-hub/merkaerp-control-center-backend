const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.DATABASE_SSL = 'false';
process.env.ADMIN_JWT_SECRET = 'admin-secret-'.padEnd(64, 'A');
process.env.DB_CREDENTIAL_SECRET = 'db-secret-'.padEnd(64, 'C');
process.env.NODE_ENV = 'test';

const server = require('../src/server');

let listener;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    listener = server.app.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (listener) await new Promise((resolve) => listener.close(resolve));
  await server.pool.end().catch(() => {});
});

async function expectProtectedRoute(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, 401, `${method} ${path} must be registered and protected`);
  assert.equal(payload.error, 'Authentication required');
}

test('critical administrator routes are registered before the API 404 handler', async () => {
  await expectProtectedRoute('POST', '/api/v1/licenses/1/lifecycle', { action: 'suspend' });
  await expectProtectedRoute('POST', '/api/v1/clients/1/lifecycle', { action: 'suspend' });
  await expectProtectedRoute('DELETE', '/api/v1/licenses/1');
  await expectProtectedRoute('DELETE', '/api/v1/clients/1');
  await expectProtectedRoute('POST', '/api/v1/clients/1/permanent-delete', {});
  await expectProtectedRoute('GET', '/api/v1/plans');
  await expectProtectedRoute('GET', '/api/v1/fleet/overview');
  await expectProtectedRoute('POST', '/api/v1/installations/test/diagnostics', {});
});

test('critical MerkaERP Agent v2 routes are registered', async () => {
  await expectProtectedRoute('GET', '/api/v1/agent/bootstrap');
  await expectProtectedRoute('POST', '/api/v1/agent/capabilities', {});
  await expectProtectedRoute('POST', '/api/v1/errors/report', {});
  await expectProtectedRoute('POST', '/api/v1/agent/artifacts', {});
});

test('offline activation revocation keeps legacy TEXT timestamps type-safe', () => {
  const sourceFiles = ['../src/server.js', '../src/fleet_routes.js'];
  for (const relativePath of sourceFiles) {
    const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
    const offlineUpdates = source
      .split('\n')
      .filter((line) => line.includes('cc_offline_activations') && line.includes('revoked_at=COALESCE'));
    assert.ok(offlineUpdates.length > 0, `${relativePath} must revoke offline activations`);
    for (const update of offlineUpdates) {
      assert.match(update, /CURRENT_TIMESTAMP::text/);
      assert.doesNotMatch(update, /COALESCE\([^)]*,\s*NOW\(\)\)/);
    }
  }
});

test('offline token issuance requires an active client account', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.match(source, /c\.status AS client_status/);
  assert.match(source, /Client account is not active/);
});

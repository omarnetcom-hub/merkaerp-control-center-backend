const test = require('node:test');
const assert = require('node:assert/strict');
const { registerFleetRoutes } = require('../src/fleet_routes');
const { findClientConflict, clientConflictResponse, registerClientAccountRoutes } = require('../src/client_accounts');

const normalize = (status) => ({ cancelado: 'cancelled', activo: 'active' }[status] || status);
function harness({ status = 'cancelled', dependencies = [], schema = false, busy = false, failAudit = false } = {}) {
  const calls = [];
  const client = { id: 7, status };
  const tx = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/SELECT id,status FROM cc_clients/.test(sql)) return { rows: client.status ? [{ ...client }] : [] };
      if (/information_schema.columns/.test(sql)) return { rows: [
        { schema_name: 'public', table_name: 'cc_licenses', column_name: 'client_id' },
        { schema_name: 'public', table_name: 'cc_invoices', column_name: 'client_id' },
        { schema_name: 'public', table_name: 'cc_telemetry', column_name: 'client_id' },
      ] };
      if (/^LOCK TABLE/.test(sql) && busy) throw Object.assign(new Error('busy'), { code: '55P03' });
      if (/^SELECT 1 FROM/.test(sql)) return { rows: dependencies.some((table) => sql.includes(`"${table}"`)) || (sql.includes('pg_namespace') && schema) ? [{}] : [] };
      if (/INSERT INTO cc_audit/.test(sql) && failAudit) throw new Error('audit failed');
      return { rows: [], rowCount: 1 };
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  const handlers = new Map();
  const requiredRoles = [];
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (path, ...fns) => handlers.set(`${method} ${path}`, fns.at(-1))]));
  const deps = {
    app, pool: { connect: async () => tx },
    validateAdminAuth() {}, validateClientToken() {},
    requirePermission: () => () => {}, requireRole: (role) => { requiredRoles.push(role); return () => {}; },
    publicError: (res, status, error) => res.status(status).json({ success: false, error }),
    serverError: (res, error) => res.status(500).json({ success: false, error }),
    normalizeLicenseStatus: normalize,
  };
  registerFleetRoutes(deps);
  registerClientAccountRoutes(deps);
  return {
    calls, requiredRoles,
    async invoke(path, body) {
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
      await handlers.get(`post /api/v1/clients/:id/${path}`)({ params: { id: '7' }, body, user: { username: 'test-admin' } }, res);
      return res;
    },
  };
}

test('duplicate NIT returns the original archived client and a recovery code', async () => {
  const db = { query: async (sql, values) => {
    assert.match(sql, /TRIM\(nit\)/);
    assert.deepEqual(values, ['1004109757', null]);
    return { rows: [{ id: 7, name: 'Cliente', nit: '1004109757', status: 'cancelado' }] };
  } };
  const conflict = await findClientConflict(db, { nit: ' 1004109757 ', email: 'different@example.com' });
  const response = clientConflictResponse(conflict, normalize);
  assert.equal(response.code, 'CLIENT_ARCHIVED');
  assert.equal(response.client.id, 7);
  assert.equal(response.client.status, 'cancelled');
  assert.equal(response.field, 'nit');
});

test('email conflict and active clients have a structured, distinct result', async () => {
  const db = { query: async (sql, values) => {
    assert.match(sql, /TRIM\(contact_email\)/);
    assert.deepEqual(values, ['Test@example.com', 8]);
    return { rows: [{ id: 7, status: 'active' }] };
  } };
  const conflict = await findClientConflict(db, { nit: '', email: ' Test@example.com ', id: 8 });
  assert.equal(clientConflictResponse(conflict, normalize).code, 'CLIENT_EXISTS');
  assert.equal(conflict.field, 'email');
});

test('restore changes only the client and writes audit, never licenses or devices', async () => {
  const h = harness();
  const res = await h.invoke('lifecycle', { action: 'restore' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'active');
  assert.equal(res.body.previous_status, 'cancelled');
  const updates = h.calls.filter((c) => /UPDATE|DELETE FROM/.test(c.sql));
  assert.equal(updates.length, 2); // SELECT ... FOR UPDATE plus the profile update
  assert.ok(updates.every((c) => c.sql.includes('cc_clients')));
  assert.ok(h.calls.some((c) => c.sql.includes('archived_at=CASE')));
  assert.ok(h.calls.some((c) => c.values?.includes('CLIENT_RESTORE')));
  assert.ok(h.calls.some((c) => c.sql === 'COMMIT'));
});

test('restore is idempotent, rejects suspended accounts and cannot use reactivate on archived clients', async () => {
  const active = harness({ status: 'active' });
  assert.equal((await active.invoke('lifecycle', { action: 'restore' })).body.unchanged, true);
  assert.equal((await harness({ status: 'suspended' }).invoke('lifecycle', { action: 'restore' })).statusCode, 409);
  assert.equal((await harness().invoke('lifecycle', { action: 'reactivate' })).statusCode, 409);
});

test('normal suspended-client reactivation retains its restricted license behavior', async () => {
  const h = harness({ status: 'suspended' });
  assert.equal((await h.invoke('lifecycle', { action: 'reactivate' })).statusCode, 200);
  const update = h.calls.find((c) => c.sql.includes('UPDATE cc_licenses'));
  assert.match(update.sql, /status='suspended' AND suspension_source='client'/);
  assert.match(update.sql, /expires_at::timestamptz > NOW\(\)/);
});

test('permanent deletion requires admin, explicit confirmation and an archived account', async () => {
  const h = harness();
  assert.ok(h.requiredRoles.includes('admin'));
  assert.equal((await h.invoke('permanent-delete', {})).statusCode, 400);
  assert.equal(h.calls.length, 0);
  const active = harness({ status: 'active' });
  assert.equal((await active.invoke('permanent-delete', { confirmation: 'ELIMINAR 7' })).statusCode, 409);
  assert.ok(!active.calls.some((c) => c.sql.startsWith('DELETE')));
});

for (const table of ['cc_licenses', 'cc_invoices', 'cc_telemetry']) {
  test(`permanent deletion refuses even historical dependencies in ${table}`, async () => {
    const h = harness({ dependencies: [table] });
    const res = await h.invoke('permanent-delete', { confirmation: 'ELIMINAR 7' });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'CLIENT_HAS_HISTORY');
    assert.ok(res.body.dependencies.includes(table));
    assert.ok(!h.calls.some((c) => c.sql.startsWith('DELETE')));
  });
}

test('tenant schemas and concurrent writes prevent deletion', async () => {
  for (const settings of [{ schema: true }, { busy: true }]) {
    const h = harness(settings);
    assert.equal((await h.invoke('permanent-delete', { confirmation: 'ELIMINAR 7' })).statusCode, 409);
    assert.ok(!h.calls.some((c) => c.sql.startsWith('DELETE')));
  }
});

test('only an empty archived account is deleted, with an audit in the same transaction', async () => {
  const h = harness();
  assert.equal((await h.invoke('permanent-delete', { confirmation: 'ELIMINAR 7' })).body.deleted, true);
  assert.deepEqual(h.calls.filter((c) => c.sql.startsWith('DELETE')), [{ sql: 'DELETE FROM cc_clients WHERE id=$1', values: [7] }]);
  assert.ok(h.calls.some((c) => c.sql.includes('INSERT INTO cc_audit')));
  assert.equal(h.calls.at(-2).sql, 'COMMIT');
});

test('audit errors roll back restoration and deletion', async () => {
  for (const [path, body] of [['lifecycle', { action: 'restore' }], ['permanent-delete', { confirmation: 'ELIMINAR 7' }]]) {
    const h = harness({ failAudit: true });
    assert.equal((await h.invoke(path, body)).statusCode, 500);
    assert.ok(h.calls.some((c) => c.sql === 'ROLLBACK'));
    assert.ok(!h.calls.some((c) => c.sql === 'COMMIT'));
  }
});

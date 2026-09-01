'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  ALLOWED_REMOTE_ACTIONS,
  canonicalCommandPayload,
  signCommand,
} = require('../src/security/remote_commands');
const {
  ALLOWED_TABLES,
  ALLOWED_OPERATIONS,
  isAllowedTable,
  isAllowedOperation,
} = require('../src/sync/allowed_tables');
const {
  majorToMinor,
  normalizeMinor,
  minorToMajorString,
} = require('../src/utils/money');

const PINNED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA6MMNqdYuBJuZ1vJXUNGK
TWFR+8da59yk3XWfgPJ4RKkkQZfMi5TdCtkj+RrReS9mjUidwIkhohM2/eLiPw7X
K013NqxIArgfQj1e0qOakv5D8lFm9nf2XmRmCk7UWCrV2HR/2pqbZNvnV2f5puVT
5pXiqSpx43Ijfu1rJUaL2EG5RRlZQCFZvJrOEvzZvEKGIp4zwD1MuMP5w+ogx7K4
igESaKkmeQIqPCo0ujiYvyLL6x53kO/933wPhqkEiKOxirHHnltopb6OeM3shs+Z
+wB7t09EI8sTA07XwjalQECl+76j82dH5HW5zeC/njl3BB9PtrpFKlVvHlhYUt3V
g/1+JFobqyc6/ZLRMRMAG31mKqPFGyvNcJxuc5bdzPSDh8uvPkuQgOgZr/950jKL
5QoULr6ZSqZ4BU13HLsjXz6hftiGq5eaLCXlTxfg/StRwJH4Gh9NOc7n4toBwqMi
hjkWm8BQxAfKF7CIy+3PTrOwuEnrgPSiIoX7WohsP+JbAgMBAAE=
-----END PUBLIC KEY-----`;
const PINNED_FINGERPRINT = 'e3344e9f2e3010c75fcbd64d7bb8f4ddc34eedc5a18f7296b82d914e5df2fb27';

function fingerprint(pem) {
  const der = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function run() {
  assert.strictEqual(fingerprint(PINNED_PUBLIC_KEY), PINNED_FINGERPRINT, 'Pinned RS256 fingerprint changed');

  const expectedActions = [
    'forzar_respaldo', 'restaurar_respaldo', 'reiniciar_sesiones', 'actualizar_modulos', 'enviar_log',
    'mensaje_admin', 'bloquear_instalacion', 'activar_instalacion', 'entrar_mantenimiento', 'salir_mantenimiento',
    'forzar_actualizacion', 'rollback_actualizacion', 'aplicar_hotfix', 'reiniciar',
    'forzar_sincronizacion', 'actualizar_licencia', 'aplicar_configuracion', 'aplicar_feature_flags',
    'run_diagnostics', 'collect_diagnostics', 'verificar_base_datos', 'reconstruir_indices', 'limpiar_cache',
    'ejecutar_reparacion', 'solicitar_acceso_remoto',
  ].sort();
  assert.deepStrictEqual([...ALLOWED_REMOTE_ACTIONS].sort(), expectedActions, 'Remote action contract drift');

  const command = {
    id: '42',
    action: 'mensaje_admin',
    installationId: 'MERKA-TEST-1',
    timestamp: '2026-08-17T12:00:00.000Z',
    expiresAt: '2026-08-17T12:10:00.000Z',
    nonce: 'abc',
    params: { titulo: 'Aviso', detalle: 'Hola', nested: { b: 2, a: 1 } },
  };
  const expectedCanonical = '{"action":"mensaje_admin","expires_at":"2026-08-17T12:10:00.000Z","id":"42","installation_id":"MERKA-TEST-1","nonce":"abc","params":{"detalle":"Hola","nested":{"a":1,"b":2},"titulo":"Aviso"},"timestamp":"2026-08-17T12:00:00.000Z"}';
  assert.strictEqual(canonicalCommandPayload(command), expectedCanonical, 'HMAC canonical JSON drift');
  const expectedHmac = crypto.createHmac('sha256', 'test-secret').update(expectedCanonical, 'utf8').digest('hex');
  assert.strictEqual(signCommand('test-secret', command), expectedHmac, 'HMAC signing drift');

  assert.deepStrictEqual([...ALLOWED_TABLES].sort(), ['clientes', 'productos', 'venta_items', 'ventas'], 'Sync table contract drift');
  assert.deepStrictEqual([...ALLOWED_OPERATIONS].sort(), ['delete', 'insert', 'update'], 'Sync operation contract drift');
  assert.strictEqual(isAllowedTable('ventas'), true);
  assert.strictEqual(isAllowedTable('movimientos_caja'), false);
  assert.strictEqual(isAllowedOperation('UPDATE'), true);
  assert.strictEqual(isAllowedOperation('merge'), false);

  assert.strictEqual(majorToMinor('123.45'), 12345, 'Money conversion failed');
  assert.strictEqual(majorToMinor('-0.01'), -1, 'Negative money conversion failed');
  assert.strictEqual(normalizeMinor('9007199254740991'), Number.MAX_SAFE_INTEGER, 'Minor range failed');
  assert.strictEqual(minorToMajorString(12345), '123.45', 'Money format failed');
  assert.throws(() => majorToMinor('1.001'), /at most 2 fractional digits/);

  const serverPath = path.join(__dirname, '..', 'src', 'server.js');
  const server = fs.readFileSync(serverPath, 'utf8');
  const fleetRoutes = fs.readFileSync(path.join(__dirname, '..', 'src', 'fleet_routes.js'), 'utf8');
  const requiredRoutes = [
    "app.post('/api/v1/licenses/activate'",
    "app.post('/api/v1/licenses/validate'",
    "app.post('/api/v1/installations/heartbeat'",
    "app.post('/api/v1/telemetry/events'",
    "app.get('/api/v1/installations/:uuid/commands'",
    "app.post('/api/v1/commands/:commandId/ack'",
    "app.get('/api/v1/updates/check'",
    "app.post('/api/v1/installations/sync/push'",
  ];
  for (const route of requiredRoutes) assert.ok(server.includes(route), `Missing MerkaERP route: ${route}`);
  assert.ok(!server.includes('CONTROL_CENTER_DISABLED_ACTIONS'), 'Stale disabled-action reference would break remote command queueing');
  assert.ok(server.includes("app.put('/api/v1/updates/:id/artifact'"), 'Managed release artifact upload route missing');
  assert.ok(server.includes("app.get('/api/v1/update-artifacts/:id'"), 'Managed release artifact download route missing');
  assert.ok(fleetRoutes.includes("app.post('/api/v1/deployments/:id/rollback'"), 'Rollback deployment route missing');
  for (const route of ["app.get('/api/v1/agent/bootstrap'", "app.post('/api/v1/agent/capabilities'", "app.post('/api/v1/errors/report'", "app.post('/api/v1/agent/artifacts'"]) assert.ok(fleetRoutes.includes(route), `Missing fleet route: ${route}`);
  assert.ok(server.includes("Legacy direct replication is disabled; use the MerkaERP transport outbox contract"), 'Legacy direct replication must stay disabled');

  console.log('Control Center ↔ MerkaERP 1.2.1+5 contract self-check: PASS');
  console.log(`- RS256 pinned fingerprint: ${PINNED_FINGERPRINT}`);
  console.log(`- Remote actions: ${ALLOWED_REMOTE_ACTIONS.size}`);
  console.log(`- Sync allowlist: ${ALLOWED_TABLES.size} tables / ${ALLOWED_OPERATIONS.size} operations`);
  console.log('- Money minor-unit conversion: PASS');
  console.log('- Required client API routes: PASS');
}

run();

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.DATABASE_SSL = 'false';
process.env.ADMIN_JWT_SECRET = 'admin-secret-'.padEnd(64, 'A');
process.env.DB_CREDENTIAL_SECRET = 'db-secret-'.padEnd(64, 'C');
process.env.ADMIN_TOKEN_TTL = '8h';
process.env.NODE_ENV = 'test';

const server = require('../src/server');
const { canonicalCommandPayload, signCommand, generateCommandSecret } = require('../src/security/remote_commands');
const { ALLOWED_TABLES, isAllowedOperation } = require('../src/sync/allowed_tables');
const { majorToMinor, minorToMajorString } = require('../src/utils/money');

const hasPublisherPrivateKey = Boolean(
  process.env.JWT_PRIVATE_KEY_PEM || process.env.JWT_PRIVATE_KEY_BASE64 || process.env.JWT_PRIVATE_KEY_PATH
);

test.after(async () => {
  await server.pool.end().catch(() => {});
});

test('admin and MerkaERP publisher JWT trust domains are isolated', { skip: !hasPublisherPrivateKey }, () => {
  const admin = server.signAdminToken({ id: 7, username: 'omar', role: 'super_admin' });
  const license = server.generateLicenseToken({
    license_id: 8,
    client_id: 9,
    client_name: 'Empresa Demo',
    installation_id: 'installation-1',
    hardware_fingerprint: 'hardware-fingerprint-123',
    license_type: 'SUSCRIPCION',
    status: 'active',
    modules: ['sales', 'inventory'],
    product_family: 'COMMERCIAL',
  }, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());

  const decodedAdmin = server.verifyAdminJwt(admin);
  const decodedLicense = server.verifyLicenseJwt(license);
  assert.equal(decodedAdmin.token_type, 'admin');
  assert.equal(decodedAdmin.user_id, 7);
  assert.equal(decodedLicense.token_type, 'license');
  assert.equal(decodedLicense.license_id, '8');
  assert.equal(decodedLicense.installation_id, 'installation-1');
  assert.equal(decodedLicense.hfp, 'hardware-fingerprint-123');
  assert.equal(decodedLicense.st, 'ACTIVO');
  assert.equal(decodedLicense.pf, 'COMMERCIAL');
  assert.throws(() => server.verifyAdminJwt(license));
  assert.throws(() => server.verifyLicenseJwt(admin));
});

test('RBAC permissions remain separated by role', () => {
  assert.equal(server.roleHasPermission('viewer', 'read'), true);
  assert.equal(server.roleHasPermission('viewer', 'licenses:write'), false);
  assert.equal(server.roleHasPermission('support', 'tickets:write'), true);
  assert.equal(server.roleHasPermission('support', 'billing:write'), false);
  assert.equal(server.roleHasPermission('manager', 'licenses:write'), true);
  assert.equal(server.roleHasPermission('super_admin', 'anything'), true);
});

test('license statuses, families and roles normalize deterministically', () => {
  assert.equal(server.normalizeLicenseStatus('ACTIVO'), 'active');
  assert.equal(server.normalizeLicenseStatus('Suspendido'), 'suspended');
  assert.equal(server.publisherStatus('active'), 'ACTIVO');
  assert.equal(server.normalizeProductFamily('PUBLICO'), 'PUBLIC');
  assert.equal(server.normalizeProductFamily('', ['presupuesto_publico']), 'PUBLIC');
  assert.equal(server.normalizeProductFamily('', ['sales']), 'COMMERCIAL');
  assert.equal(server.normalizeAdminRole('Super Admin'), 'super_admin');
  assert.equal(server.normalizeAdminRole('Soporte'), 'support');
});

test('database client password derivation is deterministic and isolated', () => {
  const first = server.deriveClientDbPassword(101);
  const same = server.deriveClientDbPassword(101);
  const other = server.deriveClientDbPassword(102);
  assert.equal(first, same);
  assert.notEqual(first, other);
  assert.match(first, /^[A-Za-z0-9_-]+!Aa1$/);
  assert.throws(() => server.deriveClientDbPassword(0));
});

test('TOTP accepts the current code and rejects malformed values', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const code = server.totpCode(secret);
  assert.match(code, /^\d{6}$/);
  assert.equal(server.validateTotp(secret, code), true);
  assert.equal(server.validateTotp(secret, '12345'), false);
});

test('offline license uses RS256 and the same publisher trust domain', { skip: !hasPublisherPrivateKey }, () => {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const token = server.signOfflineLicense({
    token_type: 'license',
    hfp: 'HW-123456789012',
    lt: 'SUSCRIPCION',
    st: 'ACTIVO',
    ed: new Date(expires * 1000).toISOString(),
    md: ['sales'],
    pf: 'COMMERCIAL',
    license_id: '55',
    client_id: '10',
  }, { expiresIn: 3600, subject: 'license:55' });
  const [headerPart] = token.split('.');
  assert.equal(JSON.parse(Buffer.from(headerPart, 'base64url')).alg, 'RS256');
  const decoded = server.verifyLicenseJwt(token);
  assert.equal(decoded.hfp, 'HW-123456789012');
  assert.equal(decoded.iss, 'MerkaERP-ControlCenter');
});

test('remote command canonical HMAC matches the MerkaERP canonical payload shape', () => {
  const secret = generateCommandSecret();
  const command = {
    id: '42',
    action: 'forzar_respaldo',
    installationId: 'MERKA-1-2-ABC',
    timestamp: '2026-08-17T13:00:00.000Z',
    expiresAt: '2026-08-17T13:10:00.000Z',
    nonce: 'nonce-123',
    params: { z: 2, nested: { b: 2, a: 1 }, a: 1 },
  };
  const canonical = canonicalCommandPayload(command);
  assert.equal(canonical, '{"action":"forzar_respaldo","expires_at":"2026-08-17T13:10:00.000Z","id":"42","installation_id":"MERKA-1-2-ABC","nonce":"nonce-123","params":{"a":1,"nested":{"a":1,"b":2},"z":2},"timestamp":"2026-08-17T13:00:00.000Z"}');
  assert.match(signCommand(secret, command), /^[a-f0-9]{64}$/);
});

test('sync transport allowlist matches final MerkaERP 1.2.1+5 client', () => {
  assert.deepEqual([...ALLOWED_TABLES].sort(), ['clientes', 'productos', 'venta_items', 'ventas']);
  assert.equal(isAllowedOperation('INSERT'), true);
  assert.equal(isAllowedOperation('upsert'), false);
});

test('money conversion uses exact integer minor units', () => {
  assert.equal(majorToMinor('123.45'), 12345);
  assert.equal(minorToMajorString(12345), '123.45');
  assert.throws(() => majorToMinor('1.234'));
});

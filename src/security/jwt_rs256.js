const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const PRIVATE_KEY_ENV = 'JWT_PRIVATE_KEY_PEM';
const PRIVATE_KEY_BASE64_ENV = 'JWT_PRIVATE_KEY_BASE64';
const PRIVATE_KEY_PATH_ENV = 'JWT_PRIVATE_KEY_PATH';
const PUBLIC_KEY_ENV = 'JWT_PUBLIC_KEY_PEM';
const PUBLIC_KEY_BASE64_ENV = 'JWT_PUBLIC_KEY_BASE64';
const PUBLIC_KEY_PATH_ENV = 'JWT_PUBLIC_KEY_PATH';

// Public key pinned by MerkaERP 1.2.1+5. Public material is safe to ship;
// the matching private key MUST remain only in the Control Center backend.
const CLIENT_PINNED_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
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
const CLIENT_PINNED_PUBLIC_KEY_SHA256 = 'e3344e9f2e3010c75fcbd64d7bb8f4ddc34eedc5a18f7296b82d914e5df2fb27';

function readConfiguredKey({ pemEnv, base64Env, pathEnv }) {
  const directPem = process.env[pemEnv];
  if (directPem && directPem.trim()) return directPem.replace(/\\n/g, '\n');

  const base64Pem = process.env[base64Env];
  if (base64Pem && base64Pem.trim()) return Buffer.from(base64Pem, 'base64').toString('utf8');

  const keyPath = process.env[pathEnv];
  if (keyPath && keyPath.trim()) return fs.readFileSync(keyPath, 'utf8');
  return null;
}

function configuredPrivateKey() {
  return readConfiguredKey({
    pemEnv: PRIVATE_KEY_ENV,
    base64Env: PRIVATE_KEY_BASE64_ENV,
    pathEnv: PRIVATE_KEY_PATH_ENV,
  });
}

function configuredPublicKey() {
  return readConfiguredKey({
    pemEnv: PUBLIC_KEY_ENV,
    base64Env: PUBLIC_KEY_BASE64_ENV,
    pathEnv: PUBLIC_KEY_PATH_ENV,
  });
}

function publicKeyFingerprint(pemOrKey) {
  const key = crypto.createPublicKey(pemOrKey);
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function privateKey() {
  const key = configuredPrivateKey();
  if (!key) {
    throw new Error(
      'MerkaERP publisher private key is not configured. Set JWT_PRIVATE_KEY_PEM/BASE64/PATH; ephemeral signing is intentionally disabled.',
    );
  }
  return key;
}

function publicKey() {
  const configured = configuredPublicKey();
  if (configured) return configured;
  const privatePem = configuredPrivateKey();
  if (privatePem) {
    return crypto.createPublicKey(privatePem).export({ type: 'spki', format: 'pem' });
  }
  // Verification may use the public key pinned in the frozen MerkaERP client.
  return CLIENT_PINNED_PUBLIC_KEY_PEM;
}

function assertProductionKeyConfiguration() {
  // Despite the historical name, this check is deliberately strict in every
  // environment. A temporary signing key would create tokens that MerkaERP
  // 1.2.1+5 rejects, so Control Center must never start as a signing authority
  // without the exact matching private key.
  const privatePem = privateKey();
  const derivedPublic = crypto.createPublicKey(privatePem).export({ type: 'spki', format: 'pem' });
  const derivedFingerprint = publicKeyFingerprint(derivedPublic);
  const configuredPublic = configuredPublicKey();
  if (configuredPublic) {
    const configuredFingerprint = publicKeyFingerprint(configuredPublic);
    if (configuredFingerprint !== derivedFingerprint) {
      throw new Error('JWT public/private key pair does not match');
    }
  }
  if (derivedFingerprint !== CLIENT_PINNED_PUBLIC_KEY_SHA256) {
    throw new Error(
      'JWT signing key does not match the public key pinned in MerkaERP 1.2.1+5. Do not rotate it without intentionally rebuilding MerkaERP.',
    );
  }
  return true;
}

function signJwt(payload, options = {}) {
  assertProductionKeyConfiguration();
  return jwt.sign(payload, privateKey(), { ...options, algorithm: 'RS256', header: { typ: 'JWT', ...(options.header || {}) } });
}

function verifyJwt(token, options = {}) {
  return jwt.verify(token, publicKey(), { ...options, algorithms: ['RS256'] });
}

module.exports = {
  signJwt,
  verifyJwt,
  publicKey,
  publicKeyFingerprint,
  assertProductionKeyConfiguration,
  CLIENT_PINNED_PUBLIC_KEY_PEM,
  CLIENT_PINNED_PUBLIC_KEY_SHA256,
};

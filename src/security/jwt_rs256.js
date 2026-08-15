const fs = require('fs');
const jwt = require('jsonwebtoken');

const PRIVATE_KEY_ENV = 'JWT_PRIVATE_KEY_PEM';
const PRIVATE_KEY_BASE64_ENV = 'JWT_PRIVATE_KEY_BASE64';
const PRIVATE_KEY_PATH_ENV = 'JWT_PRIVATE_KEY_PATH';
const PUBLIC_KEY_ENV = 'JWT_PUBLIC_KEY_PEM';
const PUBLIC_KEY_BASE64_ENV = 'JWT_PUBLIC_KEY_BASE64';
const PUBLIC_KEY_PATH_ENV = 'JWT_PUBLIC_KEY_PATH';

function readKey({ pemEnv, base64Env, pathEnv, label }) {
  const directPem = process.env[pemEnv];
  if (directPem && directPem.trim()) {
    return directPem.replace(/\\n/g, '\n');
  }

  const base64Pem = process.env[base64Env];
  if (base64Pem && base64Pem.trim()) {
    return Buffer.from(base64Pem, 'base64').toString('utf8');
  }

  const keyPath = process.env[pathEnv];
  if (keyPath && keyPath.trim()) {
    return fs.readFileSync(keyPath, 'utf8');
  }

  throw new Error(
    `${label} is required for RS256 JWT. Configure ${pemEnv}, ${base64Env}, or ${pathEnv}.`,
  );
}

function privateKey() {
  return readKey({
    pemEnv: PRIVATE_KEY_ENV,
    base64Env: PRIVATE_KEY_BASE64_ENV,
    pathEnv: PRIVATE_KEY_PATH_ENV,
    label: 'JWT private key',
  });
}

function publicKey() {
  return readKey({
    pemEnv: PUBLIC_KEY_ENV,
    base64Env: PUBLIC_KEY_BASE64_ENV,
    pathEnv: PUBLIC_KEY_PATH_ENV,
    label: 'JWT public key',
  });
}

function signJwt(payload, options = {}) {
  return jwt.sign(payload, privateKey(), {
    ...options,
    algorithm: 'RS256',
  });
}

function verifyJwt(token, options = {}) {
  return jwt.verify(token, publicKey(), {
    ...options,
    algorithms: ['RS256'],
  });
}

module.exports = {
  signJwt,
  verifyJwt,
};

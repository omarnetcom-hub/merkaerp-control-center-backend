const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

process.env.JWT_PRIVATE_KEY_PEM = privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});
process.env.JWT_PUBLIC_KEY_PEM = publicKey.export({
  type: 'spki',
  format: 'pem',
});

const { signJwt, verifyJwt } = require('./src/security/jwt_rs256');

const token = signJwt({ sub: 'user-1', role: 'admin' }, { expiresIn: '1h' });
const decoded = verifyJwt(token);
assert.strictEqual(decoded.sub, 'user-1');
assert.strictEqual(decoded.role, 'admin');

const [header, payload, signature] = token.split('.');
const alteredPayload = Buffer.from(
  JSON.stringify({ sub: 'user-2', role: 'admin' }),
).toString('base64url');
assert.throws(() => verifyJwt([header, alteredPayload, signature].join('.')));

const hsToken = jwt.sign({ sub: 'user-1' }, 'legacy-secret', {
  algorithm: 'HS256',
});
assert.throws(() => verifyJwt(hsToken));

console.log('RS256 JWT test passed');

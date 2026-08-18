'use strict';
const fs = require('fs');
const crypto = require('crypto');
const EXPECTED = 'e3344e9f2e3010c75fcbd64d7bb8f4ddc34eedc5a18f7296b82d914e5df2fb27';

function configuredPrivateKey() {
  if (process.env.JWT_PRIVATE_KEY_PEM?.trim()) return process.env.JWT_PRIVATE_KEY_PEM.replace(/\\n/g, '\n');
  if (process.env.JWT_PRIVATE_KEY_BASE64?.trim()) return Buffer.from(process.env.JWT_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
  if (process.env.JWT_PRIVATE_KEY_PATH?.trim()) return fs.readFileSync(process.env.JWT_PRIVATE_KEY_PATH, 'utf8');
  return null;
}

const privatePem = configuredPrivateKey();
if (!privatePem) {
  console.error('Publisher private key is not configured.');
  process.exit(2);
}
try {
  const publicKey = crypto.createPublicKey(privatePem);
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const actual = crypto.createHash('sha256').update(der).digest('hex');
  if (actual !== EXPECTED) {
    console.error(`Publisher key mismatch. expected=${EXPECTED} actual=${actual}`);
    process.exit(3);
  }
  console.log(`Publisher key OK: ${actual}`);
} catch (error) {
  console.error(`Invalid publisher private key: ${error.message}`);
  process.exit(4);
}

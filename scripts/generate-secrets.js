'use strict';
const crypto = require('crypto');

console.log('ADMIN_JWT_SECRET=' + crypto.randomBytes(48).toString('base64url'));
console.log('DB_CREDENTIAL_SECRET=' + crypto.randomBytes(48).toString('base64url'));
console.log('');
console.log('Publisher RS256 key NOT generated.');
console.log('Use the existing MerkaERP publisher private key matching fingerprint:');
console.log('e3344e9f2e3010c75fcbd64d7bb8f4ddc34eedc5a18f7296b82d914e5df2fb27');

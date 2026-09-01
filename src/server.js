const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const {
  signJwt: signPublisherJwt,
  verifyJwt: verifyPublisherJwt,
  publicKey: publisherPublicKey,
  publicKeyFingerprint,
  assertProductionKeyConfiguration,
  CLIENT_PINNED_PUBLIC_KEY_SHA256,
} = require('./security/jwt_rs256');
const {
  ALLOWED_REMOTE_ACTIONS,
  signCommand,
  generateCommandSecret,
  generateNonce,
} = require('./security/remote_commands');
const { isAllowedTable: isAllowedSyncTable, isAllowedOperation: isAllowedSyncOperation } = require('./sync/allowed_tables');
const { majorToMinor, normalizeMinor, moneyFromBody, minorToLegacyNumber } = require('./utils/money');
const { computeHealthScore, isInRollout, errorSignature, normalizeFleetProductFamily } = require('./fleet_logic');
const { registerFleetRoutes } = require('./fleet_routes');

const app = express();
const PORT = process.env.PORT || 8787;

// Middleware
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());

const allowedOrigins = (process.env.ADMIN_ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    // Desktop/native clients do not send an Origin header. Web clients must be allow-listed.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS policy'));
  },
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
}));
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many login attempts, please try again later' },
});
const activationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many activation attempts, please try again later' },
});
app.use('/api/v1', apiLimiter);
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));

// Database configuration - PostgreSQL only for Render
function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  try {
    const url = new URL(rawUrl);
    const knownRenderSuffix = process.env.RENDER_POSTGRES_HOST_SUFFIX || 'virginia-postgres.render.com';
    if (url.hostname.startsWith('dpg-') && !url.hostname.includes('.')) {
      url.hostname = `${url.hostname}.${knownRenderSuffix}`;
      console.log('Normalized short Render PostgreSQL hostname for DATABASE_URL');
    }
    return url.toString();
  } catch (error) {
    console.warn('Unable to normalize DATABASE_URL:', error.message);
    return rawUrl;
  }
}

const DATABASE_URL = normalizeDatabaseUrl(process.env.DATABASE_URL);

if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

console.log('Using PostgreSQL database');
const databaseSslEnabled = process.env.DATABASE_SSL !== 'false';
const databaseSslRejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false';
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: databaseSslEnabled ? { rejectUnauthorized: databaseSslRejectUnauthorized } : false,
  max: Number.parseInt(process.env.DB_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error:', error.message);
});

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function safeJson(value) {
  return JSON.stringify(value ?? {});
}

function safeParseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch (_) { return fallback; }
}

function pgIdentifier(value) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid PostgreSQL identifier: ${value}`);
  }
  return `"${value.replace(/"/g, '""')}"`;
}


const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET;
const DB_CREDENTIAL_SECRET = process.env.DB_CREDENTIAL_SECRET;
const JWT_ISSUER = process.env.JWT_ISSUER || 'merka-control-center';
const PUBLISHER_ISSUER = 'MerkaERP-ControlCenter';
const ADMIN_JWT_AUDIENCE = process.env.ADMIN_JWT_AUDIENCE || 'merka-control-center-admin';
const ADMIN_TOKEN_TTL = process.env.ADMIN_TOKEN_TTL || '8h';
const REMOTE_ACCESS_ENABLED = process.env.REMOTE_ACCESS_ENABLED === 'true';

if (!ADMIN_JWT_SECRET || !DB_CREDENTIAL_SECRET) {
  console.error('ADMIN_JWT_SECRET and DB_CREDENTIAL_SECRET environment variables are required');
  process.exit(1);
}
for (const [name, value] of Object.entries({ ADMIN_JWT_SECRET, DB_CREDENTIAL_SECRET })) {
  if (Buffer.byteLength(value, 'utf8') < 32) {
    console.error(`${name} must contain at least 32 bytes of entropy`);
    process.exit(1);
  }
}
if (ADMIN_JWT_SECRET === DB_CREDENTIAL_SECRET) {
  console.error('ADMIN_JWT_SECRET and DB_CREDENTIAL_SECRET must be different');
  process.exit(1);
}

function publisherStatus(value) {
  const status = normalizeLicenseStatus(value);
  if (status === 'active') return 'ACTIVO';
  if (status === 'trial') return 'TRIAL';
  if (status === 'suspended') return 'SUSPENDIDO';
  if (status === 'expired') return 'SUSPENDIDO';
  return 'SUSPENDIDO';
}

function normalizeLicenseType(value) {
  return String(value || '').trim().toUpperCase() === 'PERPETUA' ? 'PERPETUA' : 'SUSCRIPCION';
}

function normalizeProductFamily(value, modules = []) {
  const raw = String(value || '').trim().toUpperCase();
  if (['PUBLIC', 'PUBLICO', 'PÚBLICO', 'PUBLIC_SECTOR'].includes(raw)) return 'PUBLIC';
  if (['COMMERCIAL', 'COMERCIAL', 'PRIVATE', 'PRIVADA'].includes(raw)) return 'COMMERCIAL';
  const publicMarkers = new Set([
    'presupuesto_publico', 'contabilidad_nicsp', 'contratacion_publica', 'nomina_publica',
    'sgdea_publico', 'transparencia', 'regalias', 'sgp', 'siif', 'salud_publica',
  ]);
  return modules.some((module) => publicMarkers.has(String(module).toLowerCase())) ? 'PUBLIC' : 'COMMERCIAL';
}

function signAdminToken(user) {
  return jwt.sign(
    {
      token_type: 'admin',
      user_id: user.id,
      username: user.username,
      role: normalizeAdminRole(user.role),
    },
    ADMIN_JWT_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: ADMIN_TOKEN_TTL,
      issuer: JWT_ISSUER,
      audience: ADMIN_JWT_AUDIENCE,
      subject: String(user.id),
      jwtid: crypto.randomUUID(),
    },
  );
}

function generateLicenseToken(payload, expiresAt) {
  const modules = Array.isArray(payload.modules) ? payload.modules.map(String) : parseModules(payload.modules);
  const status = publisherStatus(payload.status);
  const licenseType = normalizeLicenseType(payload.license_type);
  const productFamily = normalizeProductFamily(payload.product_family, modules);
  const expiry = new Date(expiresAt || payload.expiry_date);
  if (Number.isNaN(expiry.getTime())) throw new Error('Invalid license expiry');

  const claims = {
    token_type: 'license',
    hfp: String(payload.hardware_fingerprint || ''),
    lt: licenseType,
    st: status,
    ed: expiry.toISOString(),
    md: modules,
    pf: productFamily,
    client_id: String(payload.client_id),
    client_name: payload.client_name == null ? null : String(payload.client_name),
    installation_id: String(payload.installation_id || payload.installation_uuid || ''),
    hardware_fingerprint: String(payload.hardware_fingerprint || ''),
    license_type: licenseType,
    license_id: String(payload.license_id),
    status,
    expiry_date: expiry.toISOString(),
    modules,
    product_family: productFamily,
  };
  const options = {
    issuer: PUBLISHER_ISSUER,
    subject: `license:${payload.license_id}`,
    jwtid: crypto.randomUUID(),
  };
  if (licenseType !== 'PERPETUA') {
    const seconds = Math.max(60, Math.floor((expiry.getTime() - Date.now()) / 1000));
    options.expiresIn = seconds;
  }
  return signPublisherJwt(claims, options);
}

function normalizeLicenseStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  const aliases = {
    activo: 'active', active: 'active', trial: 'trial', prueba: 'trial',
    suspendido: 'suspended', suspended: 'suspended', bloqueado: 'suspended',
    vencido: 'expired', expired: 'expired', revocado: 'revoked', revoked: 'revoked',
    cancelado: 'cancelled', cancelled: 'cancelled', canceled: 'cancelled',
  };
  return aliases[status] || status || 'inactive';
}

function normalizeAdminRole(value) {
  const role = String(value || '').trim().toLowerCase().replace(/[ _-]+/g, '_');
  const aliases = {
    'super_admin': 'super_admin', 'superadmin': 'super_admin',
    'admin': 'admin', 'administrador': 'admin',
    'manager': 'manager', 'gerente': 'manager',
    'soporte': 'support', 'support': 'support',
    'ventas': 'sales', 'sales': 'sales',
    'viewer': 'viewer', 'lector': 'viewer',
  };
  return aliases[role] || 'viewer';
}

const ROLE_LEVEL = { viewer: 10, support: 20, sales: 20, manager: 30, admin: 40, super_admin: 50 };
function roleAtLeast(actual, required) {
  return (ROLE_LEVEL[normalizeAdminRole(actual)] || 0) >= (ROLE_LEVEL[normalizeAdminRole(required)] || 999);
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

function verifyAdminJwt(token) {
  return jwt.verify(token, ADMIN_JWT_SECRET, {
    algorithms: ['HS256'],
    issuer: JWT_ISSUER,
    audience: ADMIN_JWT_AUDIENCE,
  });
}

function verifyLicenseJwt(token) {
  const decoded = verifyPublisherJwt(token, { issuer: PUBLISHER_ISSUER });
  if (decoded.token_type !== 'license') throw new Error('Invalid license token type');
  return decoded;
}

function publicError(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

function serverError(res, context, error) {
  console.error(`${context}:`, error);
  return res.status(500).json({ success: false, error: 'Internal server error' });
}

const validateAdminAuth = async (req, res, next) => {
  const token = bearerToken(req);
  if (!token) return publicError(res, 401, 'Authentication required');
  try {
    const decoded = verifyAdminJwt(token);
    if (decoded.token_type !== 'admin' || !decoded.user_id || !decoded.jti) {
      return publicError(res, 401, 'Invalid administrator token');
    }
    const sessionHash = hashToken(token);
    const result = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.email, u.role, u.is_active
       FROM cc_users u
       JOIN cc_sessions s ON s.user_id = u.id
       WHERE u.id = $1 AND u.is_active = 1 AND s.token = $2 AND s.expires_at::timestamptz > NOW()
       LIMIT 1`,
      [decoded.user_id, sessionHash],
    );
    const user = result.rows[0];
    if (!user) return publicError(res, 401, 'Session expired or revoked');
    req.user = { ...decoded, ...user, role: normalizeAdminRole(user.role) };
    req.adminTokenHash = sessionHash;
    return next();
  } catch (_) {
    return publicError(res, 401, 'Invalid or expired administrator token');
  }
};

function requireRole(requiredRole) {
  return (req, res, next) => {
    if (!req.user || !roleAtLeast(req.user.role, requiredRole)) {
      return publicError(res, 403, 'Insufficient permissions');
    }
    return next();
  };
}

const ROLE_PERMISSIONS = {
  viewer: new Set(['read']),
  support: new Set(['read', 'tickets:write', 'commands:write', 'remote:write']),
  sales: new Set(['read', 'crm:write', 'billing:write', 'marketing:write']),
  manager: new Set(['read', 'tickets:write', 'commands:write', 'remote:write', 'crm:write', 'billing:write', 'marketing:write', 'licenses:write']),
  admin: new Set(['*']),
  super_admin: new Set(['*']),
};

function roleHasPermission(role, permission) {
  const permissions = ROLE_PERMISSIONS[normalizeAdminRole(role)] || new Set();
  return permissions.has('*') || permissions.has(permission);
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!roleHasPermission(req.user?.role, permission)) {
      return publicError(res, 403, 'Insufficient permissions');
    }
    return next();
  };
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    out += BASE32_ALPHABET[Number.parseInt(chunk, 2)];
  }
  return out;
}

function base32Decode(value) {
  const normalized = String(value || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base32 secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpCode(secret, timeMs = Date.now(), stepSeconds = 30) {
  const counter = Math.floor(timeMs / 1000 / stepSeconds);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

function validateTotp(secret, code) {
  const normalizedCode = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalizedCode) || !secret) return false;
  for (const offset of [-30_000, 0, 30_000]) {
    const expected = Buffer.from(totpCode(secret, Date.now() + offset));
    const received = Buffer.from(normalizedCode);
    if (expected.length === received.length && crypto.timingSafeEqual(expected, received)) return true;
  }
  return false;
}

const validateClientToken = async (req, res, next) => {
  const token = bearerToken(req);
  if (!token) return publicError(res, 401, 'Authentication required');
  try {
    const decoded = verifyLicenseJwt(token);
    const installationId = decoded.installation_id || decoded.installation_uuid;
    const fingerprint = decoded.hardware_fingerprint || decoded.hfp;
    if (
      decoded.token_type !== 'license' ||
      !decoded.client_id ||
      !decoded.license_id ||
      !installationId ||
      !fingerprint
    ) {
      return publicError(res, 401, 'Invalid license token');
    }

    const result = await pool.query(
      `SELECT l.id, l.client_id, l.status, l.expires_at, l.max_devices, l.license_type,
              i.uuid, i.hardware_fingerprint, COALESCE(i.blocked, 0) AS blocked
       FROM cc_licenses l
       LEFT JOIN cc_installations i ON i.uuid = $2 AND i.client_id = l.client_id AND i.license_id = l.id
       WHERE l.id = $1 AND l.client_id = $3
       LIMIT 1`,
      [decoded.license_id, installationId, decoded.client_id],
    );
    const record = result.rows[0];
    if (!record || !record.uuid) return publicError(res, 401, 'License installation not found');
    const status = normalizeLicenseStatus(record.status);
    if (!['active', 'trial'].includes(status)) return publicError(res, 403, 'License is not active');
    const expiresAt = new Date(record.expires_at);
    if (normalizeLicenseType(record.license_type) !== 'PERPETUA' &&
        (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date())) {
      return publicError(res, 403, 'License has expired');
    }
    if (Number(record.blocked) === 1) return publicError(res, 403, 'Installation is blocked');
    if (String(record.hardware_fingerprint) !== String(fingerprint)) {
      return publicError(res, 401, 'Installation identity mismatch');
    }
    const revoked = await pool.query(
      `SELECT 1 FROM cc_license_revocations
       WHERE license_id = $1 AND hardware_fingerprint = $2 LIMIT 1`,
      [decoded.license_id, fingerprint],
    );
    if (revoked.rowCount > 0) return publicError(res, 403, 'License has been revoked for this device');

    req.clientAuth = decoded;
    req.clientId = Number(decoded.client_id);
    req.installationUuid = String(installationId);
    req.hardwareFingerprint = String(fingerprint);
    req.schema = `client_${Number(decoded.client_id)}`;
    return next();
  } catch (_) {
    return publicError(res, 401, 'Invalid or expired license token');
  }
};

async function ensureDefaultAdminUser() {
  const existing = await pool.query('SELECT id FROM cc_users LIMIT 1');
  if (existing.rows.length > 0) return;

  const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!bootstrapPassword) {
    console.warn('No admin users exist. Set BOOTSTRAP_ADMIN_PASSWORD once or run npm run admin:create.');
    return;
  }
  if (bootstrapPassword.length < 14) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD must contain at least 14 characters');
  }

  const username = process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin';
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@merka.local';
  const fullName = process.env.BOOTSTRAP_ADMIN_NAME || 'Administrador';
  const passwordHash = await bcrypt.hash(bootstrapPassword, 12);
  await pool.query(`
    INSERT INTO cc_users (username, password_hash, email, full_name, role, created_at, is_active)
    VALUES ($1, $2, $3, $4, 'super_admin', NOW(), 1)
  `, [username, passwordHash, email, fullName]);
  console.log(`Bootstrap administrator created: ${username}. Remove BOOTSTRAP_ADMIN_PASSWORD from the environment now.`);
}

const SCHEMA_MIGRATIONS = [
  {
    version: 1,
    name: 'security_and_user_management',
    statements: [
      `ALTER TABLE cc_users ADD COLUMN IF NOT EXISTS two_factor_secret TEXT`,
      `ALTER TABLE cc_users ADD COLUMN IF NOT EXISTS two_factor_enabled INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE cc_users ADD COLUMN IF NOT EXISTS permissions_json TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE cc_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`,
      `ALTER TABLE cc_users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ`,
      `ALTER TABLE cc_clients ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`,
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS blocked INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS block_reason TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_cc_licenses_client_status ON cc_licenses(client_id, status)`,
      `CREATE INDEX IF NOT EXISTS idx_cc_licenses_expires_at ON cc_licenses(expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_cc_installations_client_id ON cc_installations(client_id)`,
      `CREATE INDEX IF NOT EXISTS idx_cc_installations_hardware ON cc_installations(client_id, hardware_fingerprint)`,
      `CREATE INDEX IF NOT EXISTS idx_cc_installations_last_seen ON cc_installations(last_seen)`,
      `CREATE INDEX IF NOT EXISTS idx_cc_tickets_client_status ON cc_tickets(client_id, status)`,
      `CREATE INDEX IF NOT EXISTS idx_cc_invoices_client_status ON cc_invoices(client_id, status)`,
      `CREATE INDEX IF NOT EXISTS idx_cc_telemetry_client_created ON cc_telemetry(client_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_cc_commands_installation_status ON cc_commands(installation_uuid, status)`,
      `CREATE INDEX IF NOT EXISTS idx_cc_sync_log_node_version ON cc_sync_hub_log(node_uuid, version_timestamp)`,
    ],
  },
  {
    version: 2,
    name: 'normalize_status_and_money',
    statements: [
      `UPDATE cc_licenses SET status = CASE LOWER(status)
        WHEN 'activo' THEN 'active' WHEN 'active' THEN 'active' WHEN 'trial' THEN 'trial'
        WHEN 'suspendido' THEN 'suspended' WHEN 'suspended' THEN 'suspended'
        WHEN 'vencido' THEN 'expired' WHEN 'expired' THEN 'expired'
        WHEN 'revocado' THEN 'revoked' WHEN 'revoked' THEN 'revoked'
        WHEN 'cancelado' THEN 'cancelled' WHEN 'cancelled' THEN 'cancelled'
        ELSE LOWER(status) END`,
      `UPDATE cc_clients SET status = CASE LOWER(status)
        WHEN 'activo' THEN 'active' WHEN 'active' THEN 'active' WHEN 'trial' THEN 'trial'
        WHEN 'suspendido' THEN 'suspended' WHEN 'suspended' THEN 'suspended'
        WHEN 'vencido' THEN 'expired' WHEN 'expired' THEN 'expired'
        WHEN 'cancelado' THEN 'cancelled' WHEN 'cancelled' THEN 'cancelled'
        ELSE LOWER(status) END`,
      `ALTER TABLE cc_clients ALTER COLUMN contract_value TYPE NUMERIC(18,2) USING ROUND(contract_value::numeric, 2)`,
      `ALTER TABLE cc_clients ALTER COLUMN tax_rate TYPE NUMERIC(7,4) USING ROUND(tax_rate::numeric, 4)`,
      `ALTER TABLE cc_leads ALTER COLUMN value TYPE NUMERIC(18,2) USING ROUND(value::numeric, 2)`,
      `ALTER TABLE cc_leads ALTER COLUMN probability TYPE NUMERIC(7,4) USING ROUND(probability::numeric, 4)`,
      `ALTER TABLE cc_resellers ALTER COLUMN commission_pct TYPE NUMERIC(7,4) USING ROUND(commission_pct::numeric, 4)`,
      `ALTER TABLE cc_invoices ALTER COLUMN total TYPE NUMERIC(18,2) USING ROUND(total::numeric, 2)`,
      `ALTER TABLE cc_payments ALTER COLUMN amount TYPE NUMERIC(18,2) USING ROUND(amount::numeric, 2)`,
      `ALTER TABLE cc_consolidated_analytics ALTER COLUMN total_sales TYPE NUMERIC(18,2) USING ROUND(total_sales::numeric, 2)`,
    ],
  },
  {
    version: 3,
    name: 'constraints_and_unique_keys',
    statements: [
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_cc_invoices_invoice_number ON cc_invoices(invoice_number)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_cc_consolidated_date_client ON cc_consolidated_analytics(report_date, client_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_cc_license_revocation ON cc_license_revocations(license_id, hardware_fingerprint)`,
    ],
  },
  {
    version: 4,
    name: 'installation_license_binding',
    statements: [
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS license_id INTEGER`,
      `UPDATE cc_installations i
       SET license_id = (
         SELECT l.id FROM cc_licenses l
         WHERE l.client_id = i.client_id
         ORDER BY CASE WHEN LOWER(l.status) IN ('active','trial') THEN 0 ELSE 1 END, l.expires_at DESC, l.id DESC
         LIMIT 1
       )
       WHERE i.license_id IS NULL`,
      `CREATE INDEX IF NOT EXISTS idx_cc_installations_license_id ON cc_installations(license_id)`,
      `CREATE INDEX IF NOT EXISTS idx_cc_installations_license_hardware ON cc_installations(license_id, hardware_fingerprint)`,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cc_installations_license_id_fkey') THEN
           ALTER TABLE cc_installations ADD CONSTRAINT cc_installations_license_id_fkey
             FOREIGN KEY (license_id) REFERENCES cc_licenses(id) ON DELETE SET NULL;
         END IF;
       END $$`,
    ],
  },
  {
    version: 5,
    name: 'runtime_contract_compatibility',
    statements: [
      `ALTER TABLE cc_releases ADD COLUMN IF NOT EXISTS download_url TEXT`,
      `ALTER TABLE cc_releases ADD COLUMN IF NOT EXISTS sha256 TEXT`,
      `ALTER TABLE cc_releases ADD COLUMN IF NOT EXISTS size_bytes BIGINT`,
      `ALTER TABLE cc_releases ADD COLUMN IF NOT EXISTS notes TEXT`,
      `ALTER TABLE cc_releases ADD COLUMN IF NOT EXISTS mandatory INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE cc_commands ADD COLUMN IF NOT EXISTS action TEXT`,
      `ALTER TABLE cc_commands ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'info'`,
      `ALTER TABLE cc_commands ADD COLUMN IF NOT EXISTS title TEXT`,
      `ALTER TABLE cc_commands ADD COLUMN IF NOT EXISTS detail TEXT`,
      `ALTER TABLE cc_commands ADD COLUMN IF NOT EXISTS ack_at TEXT`,
      `ALTER TABLE cc_commands ADD COLUMN IF NOT EXISTS result TEXT`,
      `ALTER TABLE cc_commands ADD COLUMN IF NOT EXISTS executed_by TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_cc_offline_activations_license_active ON cc_offline_activations(license_id, revoked_at, expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_cc_sessions_user_expiry ON cc_sessions(user_id, expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_cc_remote_sessions_installation_status ON cc_remote_access_sessions(installation_uuid, status)`,
    ],
  },
  {
    version: 6,
    name: 'legacy_secret_cleanup',
    statements: [
      `UPDATE cc_clients SET postgres_password = NULL WHERE postgres_password IS NOT NULL`,
      `UPDATE cc_licenses SET offline_token = NULL WHERE offline_token IS NOT NULL`,
    ],
  },
  {
    version: 7,
    name: 'merkaerp_1_2_1_5_contract',
    statements: [
      `ALTER TABLE cc_licenses ADD COLUMN IF NOT EXISTS product_family TEXT NOT NULL DEFAULT 'COMMERCIAL'`,
      `UPDATE cc_licenses SET product_family = CASE
         WHEN UPPER(COALESCE(product_family,'')) IN ('PUBLIC','PUBLICO','PÚBLICO','PUBLIC_SECTOR') THEN 'PUBLIC'
         WHEN LOWER(COALESCE(modules,'')) ~ '(presupuesto_publico|contabilidad_nicsp|contratacion_publica|nomina_publica|sgdea_publico|regalias|sgp|siif|salud_publica)' THEN 'PUBLIC'
         ELSE 'COMMERCIAL' END`,
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS command_secret TEXT`,
      `ALTER TABLE cc_commands ADD COLUMN IF NOT EXISTS params_json TEXT NOT NULL DEFAULT '{}'`,
      `ALTER TABLE cc_commands ADD COLUMN IF NOT EXISTS nonce TEXT`,
      `ALTER TABLE cc_commands ADD COLUMN IF NOT EXISTS expires_at TEXT`,
      `ALTER TABLE cc_commands ADD COLUMN IF NOT EXISTS signature TEXT`,
      `ALTER TABLE cc_clients ADD COLUMN IF NOT EXISTS contract_value_minor BIGINT`,
      `ALTER TABLE cc_invoices ADD COLUMN IF NOT EXISTS total_minor BIGINT`,
      `ALTER TABLE cc_payments ADD COLUMN IF NOT EXISTS amount_minor BIGINT`,
      `UPDATE cc_clients SET contract_value_minor = ROUND(COALESCE(contract_value,0)::numeric * 100)::bigint WHERE contract_value_minor IS NULL`,
      `UPDATE cc_invoices SET total_minor = ROUND(COALESCE(total,0)::numeric * 100)::bigint WHERE total_minor IS NULL`,
      `UPDATE cc_payments SET amount_minor = ROUND(COALESCE(amount,0)::numeric * 100)::bigint WHERE amount_minor IS NULL`,
      `CREATE TABLE IF NOT EXISTS cc_installation_sync_events (
        id BIGSERIAL PRIMARY KEY,
        event_id TEXT NOT NULL,
        installation_uuid TEXT NOT NULL,
        client_id INTEGER NOT NULL,
        license_id INTEGER NOT NULL,
        table_name TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        event_timestamp TEXT NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(installation_uuid, event_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_cc_installation_sync_client_received ON cc_installation_sync_events(client_id, received_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_cc_installation_sync_table_received ON cc_installation_sync_events(table_name, received_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_cc_commands_pending_expiry ON cc_commands(installation_uuid, status, expires_at)`,
    ],
  },
  {
    version: 8,
    name: 'financial_traceability_minor_units',
    statements: [
      `ALTER TABLE cc_payments ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`,
      `ALTER TABLE cc_payments ADD COLUMN IF NOT EXISTS reversed_at TEXT`,
      `ALTER TABLE cc_payments ADD COLUMN IF NOT EXISTS reversal_reason TEXT`,
      `UPDATE cc_payments SET status='active' WHERE status IS NULL OR TRIM(status)=''`,
      `CREATE INDEX IF NOT EXISTS idx_cc_payments_status_paid_at ON cc_payments(status, paid_at)`,
    ],
  },
  {
    version: 9,
    name: 'merkaerp_heartbeat_health_payload',
    statements: [
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS last_metrics_json TEXT`,
      `ALTER TABLE cc_offline_activations ADD COLUMN IF NOT EXISTS revoked_reason TEXT`,
    ],
  },
  {
    version: 10,
    name: 'fleet_lifecycle_and_client_editions',
    statements: [
      `ALTER TABLE cc_clients ADD COLUMN IF NOT EXISTS product_family TEXT NOT NULL DEFAULT 'COMMERCIAL'`,
      `ALTER TABLE cc_clients ADD COLUMN IF NOT EXISTS lifecycle_reason TEXT`,
      `ALTER TABLE cc_clients ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`,
      `ALTER TABLE cc_clients ADD COLUMN IF NOT EXISTS support_policy_json TEXT NOT NULL DEFAULT '{}'`,
      `UPDATE cc_clients c SET product_family = COALESCE((SELECT l.product_family FROM cc_licenses l WHERE l.client_id=c.id ORDER BY l.id DESC LIMIT 1), product_family, 'COMMERCIAL')`,
      `ALTER TABLE cc_licenses ADD COLUMN IF NOT EXISTS status_reason TEXT`,
      `ALTER TABLE cc_licenses ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ`,
      `ALTER TABLE cc_licenses ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ`,
      `ALTER TABLE cc_licenses ADD COLUMN IF NOT EXISTS reactivated_at TIMESTAMPTZ`,
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS health_score INTEGER NOT NULL DEFAULT 100`,
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS maintenance_mode INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS update_channel TEXT NOT NULL DEFAULT 'stable'`,
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS policy_json TEXT NOT NULL DEFAULT '{}'`,
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS capabilities_json TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS agent_version TEXT`,
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS last_backup_at TIMESTAMPTZ`,
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS last_diagnostic_at TIMESTAMPTZ`,
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS architecture TEXT`,
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS free_disk_mb BIGINT`,
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS memory_mb BIGINT`,
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS last_error_signature TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_cc_clients_family_status ON cc_clients(product_family,status)`,
      `CREATE INDEX IF NOT EXISTS idx_cc_installations_health ON cc_installations(health_score,last_seen)`,
    ],
  },
  {
    version: 11,
    name: 'fleet_operations_support_and_policy',
    statements: [
      `CREATE TABLE IF NOT EXISTS cc_health_checks (
        id BIGSERIAL PRIMARY KEY, installation_uuid TEXT NOT NULL, health_score INTEGER NOT NULL,
        health_status TEXT NOT NULL, summary_json TEXT NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_cc_health_checks_installation_created ON cc_health_checks(installation_uuid,created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS cc_diagnostic_runs (
        id BIGSERIAL PRIMARY KEY, installation_uuid TEXT NOT NULL, command_id BIGINT, requested_by TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', checks_json TEXT NOT NULL DEFAULT '[]', result_json TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
      )`,
      `CREATE INDEX IF NOT EXISTS idx_cc_diagnostics_installation_created ON cc_diagnostic_runs(installation_uuid,created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS cc_repair_catalog (
        code TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, product_family TEXT NOT NULL DEFAULT 'ALL',
        min_version TEXT, max_version TEXT, risk_level TEXT NOT NULL DEFAULT 'low', command_action TEXT NOT NULL DEFAULT 'ejecutar_reparacion',
        default_params_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS cc_repair_runs (
        id BIGSERIAL PRIMARY KEY, installation_uuid TEXT NOT NULL, repair_code TEXT NOT NULL, command_id BIGINT,
        status TEXT NOT NULL DEFAULT 'pending', requested_by TEXT NOT NULL, result_json TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
      )`,
      `CREATE TABLE IF NOT EXISTS cc_feature_flags (
        flag_key TEXT PRIMARY KEY, description TEXT NOT NULL, default_enabled INTEGER NOT NULL DEFAULT 0,
        product_family TEXT NOT NULL DEFAULT 'ALL', min_version TEXT, max_version TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS cc_feature_flag_overrides (
        id BIGSERIAL PRIMARY KEY, flag_key TEXT NOT NULL REFERENCES cc_feature_flags(flag_key) ON DELETE CASCADE,
        scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, enabled INTEGER NOT NULL, updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(flag_key,scope_type,scope_id)
      )`,
      `CREATE TABLE IF NOT EXISTS cc_remote_configs (
        id BIGSERIAL PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}',
        version INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(scope_type,scope_id)
      )`,
      `CREATE TABLE IF NOT EXISTS cc_messages (
        id BIGSERIAL PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info', status TEXT NOT NULL DEFAULT 'queued', created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ
      )`,
      `CREATE TABLE IF NOT EXISTS cc_service_status (
        service_name TEXT PRIMARY KEY, status TEXT NOT NULL, message TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `INSERT INTO cc_service_status(service_name,status,message) VALUES
        ('api','operational','API administrativa y de agentes'),
        ('licensing','operational','Validación y emisión de licencias'),
        ('updates','operational','Manifiestos y artefactos de actualización'),
        ('sync','operational','Sincronización de agentes'),
        ('support','operational','Diagnóstico, logs y soporte remoto')
       ON CONFLICT(service_name) DO NOTHING`,
      `INSERT INTO cc_repair_catalog(code,title,description,risk_level,command_action,default_params_json) VALUES
        ('DB-INTEGRITY','Verificar integridad de base de datos','Ejecuta verificaciones seguras de integridad sin modificar datos','low','verificar_base_datos','{}'),
        ('REBUILD-INDEXES','Reconstruir indices','Reconstruye indices administrados por MerkaERP y valida el resultado','medium','reconstruir_indices','{}'),
        ('CLEAR-CACHE','Limpiar cache seguro','Limpia caches regenerables de MerkaERP sin tocar datos del negocio','low','limpiar_cache','{}'),
        ('SYNC-RECOVERY','Recuperar sincronizacion','Reinicia el motor de sincronizacion y procesa la cola pendiente','medium','forzar_sincronizacion','{}')
       ON CONFLICT (code) DO NOTHING`,
    ],
  },
  {
    version: 12,
    name: 'deployment_backup_and_release_management',
    statements: [
      `ALTER TABLE cc_releases ADD COLUMN IF NOT EXISTS product_family TEXT NOT NULL DEFAULT 'ALL'`,
      `ALTER TABLE cc_releases ADD COLUMN IF NOT EXISTS release_type TEXT NOT NULL DEFAULT 'release'`,
      `ALTER TABLE cc_releases ADD COLUMN IF NOT EXISTS rollback_version TEXT`,
      `ALTER TABLE cc_releases ADD COLUMN IF NOT EXISTS min_client_version TEXT`,
      `ALTER TABLE cc_releases ADD COLUMN IF NOT EXISTS min_free_mb BIGINT NOT NULL DEFAULT 500`,
      `ALTER TABLE cc_releases ADD COLUMN IF NOT EXISTS rollout_pct INTEGER NOT NULL DEFAULT 100`,
      `ALTER TABLE cc_releases ADD COLUMN IF NOT EXISTS artifact_path TEXT`,
      `ALTER TABLE cc_releases ADD COLUMN IF NOT EXISTS artifact_name TEXT`,
      `ALTER TABLE cc_releases ADD COLUMN IF NOT EXISTS artifact_uploaded_at TIMESTAMPTZ`,
      `CREATE TABLE IF NOT EXISTS cc_deployments (
        id BIGSERIAL PRIMARY KEY, release_id INTEGER NOT NULL REFERENCES cc_releases(id) ON DELETE CASCADE, name TEXT NOT NULL,
        scope_type TEXT NOT NULL DEFAULT 'all', scope_id TEXT, product_family TEXT NOT NULL DEFAULT 'ALL', strategy TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL DEFAULT 'draft', target_count INTEGER NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, paused_at TIMESTAMPTZ
      )`,
      `CREATE TABLE IF NOT EXISTS cc_deployment_targets (
        id BIGSERIAL PRIMARY KEY, deployment_id BIGINT NOT NULL REFERENCES cc_deployments(id) ON DELETE CASCADE, installation_uuid TEXT NOT NULL,
        command_id BIGINT, status TEXT NOT NULL DEFAULT 'pending', last_error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(deployment_id,installation_uuid)
      )`,
      `ALTER TABLE cc_backups ADD COLUMN IF NOT EXISTS installation_uuid TEXT`,
      `ALTER TABLE cc_backups ADD COLUMN IF NOT EXISTS backup_ref TEXT`,
      `ALTER TABLE cc_backups ADD COLUMN IF NOT EXISTS checksum TEXT`,
      `ALTER TABLE cc_backups ADD COLUMN IF NOT EXISTS requested_by TEXT`,
      `ALTER TABLE cc_backups ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE cc_backups ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`,
      `ALTER TABLE cc_backups ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ`,
      `CREATE TABLE IF NOT EXISTS cc_restore_jobs (
        id BIGSERIAL PRIMARY KEY, installation_uuid TEXT NOT NULL, backup_id INTEGER REFERENCES cc_backups(id) ON DELETE SET NULL,
        command_id BIGINT, status TEXT NOT NULL DEFAULT 'pending', requested_by TEXT NOT NULL, reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ, result_json TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_cc_deployments_status_created ON cc_deployments(status,created_at DESC)`,
    ],
  },
  {
    version: 13,
    name: 'organizations_subscriptions_and_error_intelligence',
    statements: [
      `CREATE TABLE IF NOT EXISTS cc_organizations (
        id BIGSERIAL PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES cc_clients(id) ON DELETE CASCADE, name TEXT NOT NULL,
        code TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS cc_branches (
        id BIGSERIAL PRIMARY KEY, organization_id BIGINT NOT NULL REFERENCES cc_organizations(id) ON DELETE CASCADE, name TEXT NOT NULL,
        code TEXT, city TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS organization_id BIGINT`,
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS branch_id BIGINT`,
      `CREATE TABLE IF NOT EXISTS cc_plans (
        plan_key TEXT PRIMARY KEY, name TEXT NOT NULL, product_family TEXT NOT NULL DEFAULT 'COMMERCIAL', billing_period TEXT NOT NULL DEFAULT 'monthly',
        price_minor BIGINT NOT NULL DEFAULT 0, limits_json TEXT NOT NULL DEFAULT '{}', modules_json TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS cc_client_subscriptions (
        id BIGSERIAL PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES cc_clients(id) ON DELETE CASCADE, plan_key TEXT REFERENCES cc_plans(plan_key) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'active', started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), current_period_end TIMESTAMPTZ,
        cancel_at_period_end INTEGER NOT NULL DEFAULT 0, metadata_json TEXT NOT NULL DEFAULT '{}', UNIQUE(client_id)
      )`,
      `CREATE TABLE IF NOT EXISTS cc_error_groups (
        signature TEXT PRIMARY KEY, title TEXT NOT NULL, module TEXT, first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        occurrences BIGINT NOT NULL DEFAULT 1, affected_installations INTEGER NOT NULL DEFAULT 1, last_version TEXT, severity TEXT NOT NULL DEFAULT 'error', sample_message TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS cc_error_occurrences (
        id BIGSERIAL PRIMARY KEY, signature TEXT NOT NULL REFERENCES cc_error_groups(signature) ON DELETE CASCADE, installation_uuid TEXT NOT NULL,
        client_id INTEGER, version TEXT, message TEXT, context_json TEXT NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_cc_error_occurrences_signature_created ON cc_error_occurrences(signature,created_at DESC)`,
      `INSERT INTO cc_plans(plan_key,name,product_family,billing_period,price_minor,limits_json,modules_json) VALUES
        ('COMMERCIAL_BASIC','Comercial Básica','COMMERCIAL','monthly',0,'{\"users\":1,\"devices\":1,\"branches\":1}','[\"sales\",\"purchases\",\"inventory\",\"cash\",\"accounting\",\"reports\"]'),
        ('COMMERCIAL_PRO','Comercial Profesional','COMMERCIAL','monthly',0,'{\"users\":8,\"devices\":12,\"branches\":2}','[\"sales\",\"purchases\",\"inventory\",\"cash\",\"accounting\",\"reports\",\"crm\",\"hrm\",\"payroll\"]'),
        ('PUBLIC_STANDARD','Público Estándar','PUBLIC','annual',0,'{\"users\":30,\"devices\":50,\"branches\":10}','[\"presupuesto_publico\",\"contabilidad_nicsp\",\"contratacion_publica\",\"nomina_publica\",\"sgdea_publico\",\"transparencia\",\"regalias\",\"sgp\",\"siif\",\"salud_publica\"]')
       ON CONFLICT (plan_key) DO NOTHING`,
    ],

  },
  {
    version: 14,
    name: 'deployment_safety_and_rollback',
    statements: [
      `ALTER TABLE cc_deployments ADD COLUMN IF NOT EXISTS batch_pct INTEGER NOT NULL DEFAULT 10`,
      `ALTER TABLE cc_deployments ADD COLUMN IF NOT EXISTS error_threshold_pct INTEGER NOT NULL DEFAULT 20`,
      `ALTER TABLE cc_deployments ADD COLUMN IF NOT EXISTS rollback_of BIGINT REFERENCES cc_deployments(id) ON DELETE SET NULL`,
      `ALTER TABLE cc_deployment_targets ADD COLUMN IF NOT EXISTS previous_version TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_cc_deployment_targets_command ON cc_deployment_targets(command_id)`,
    ],
  },
  {
    version: 15,
    name: 'operational_alerts_logs_scheduling_and_compatibility',
    statements: [
      `ALTER TABLE cc_alerts ADD COLUMN IF NOT EXISTS alert_key TEXT`,
      `ALTER TABLE cc_alerts ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'general'`,
      `ALTER TABLE cc_alerts ADD COLUMN IF NOT EXISTS details_json TEXT NOT NULL DEFAULT '{}'`,
      `ALTER TABLE cc_alerts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `ALTER TABLE cc_alerts ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`,
      `CREATE INDEX IF NOT EXISTS idx_cc_alerts_key_status ON cc_alerts(alert_key,status)`,
      `CREATE INDEX IF NOT EXISTS idx_cc_alerts_installation_status ON cc_alerts(installation_id,status)`,
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS db_schema_version TEXT`,
      `ALTER TABLE cc_installations ADD COLUMN IF NOT EXISTS app_build_number TEXT`,
      `ALTER TABLE cc_releases ADD COLUMN IF NOT EXISTS supported_os_json TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE cc_releases ADD COLUMN IF NOT EXISTS supported_arch_json TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE cc_deployments ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ`,
      `ALTER TABLE cc_deployments ADD COLUMN IF NOT EXISTS auto_rollback INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE cc_deployments ADD COLUMN IF NOT EXISTS rollback_deployment_id BIGINT REFERENCES cc_deployments(id) ON DELETE SET NULL`,
      `ALTER TABLE cc_deployment_targets ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE cc_deployment_targets ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ`,
      `CREATE TABLE IF NOT EXISTS cc_agent_artifact_requests (
        id BIGSERIAL PRIMARY KEY, installation_uuid TEXT NOT NULL, artifact_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        command_id BIGINT, requested_by TEXT NOT NULL, params_json TEXT NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ, expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour')
      )`,
      `CREATE TABLE IF NOT EXISTS cc_agent_artifacts (
        id BIGSERIAL PRIMARY KEY, request_id BIGINT REFERENCES cc_agent_artifact_requests(id) ON DELETE SET NULL,
        installation_uuid TEXT NOT NULL, artifact_type TEXT NOT NULL, name TEXT, mime_type TEXT NOT NULL DEFAULT 'text/plain',
        content_text TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', sha256 TEXT, size_bytes BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_cc_agent_artifacts_installation_created ON cc_agent_artifacts(installation_uuid,created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_cc_artifact_requests_installation_created ON cc_agent_artifact_requests(installation_uuid,created_at DESC)`,
    ],
  },
  {
    version: 16,
    name: 'client_activity_and_operational_history',
    statements: [
      `CREATE TABLE IF NOT EXISTS cc_client_activity (
        id BIGSERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL REFERENCES cc_clients(id) ON DELETE CASCADE,
        activity_type TEXT NOT NULL DEFAULT 'note',
        title TEXT,
        content TEXT NOT NULL,
        direction TEXT,
        channel TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_cc_client_activity_client_created ON cc_client_activity(client_id,created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_cc_client_activity_type ON cc_client_activity(activity_type,created_at DESC)`,
    ],
  },
  {
    version: 17,
    name: 'license_lifecycle_provenance',
    statements: [
      `ALTER TABLE cc_licenses ADD COLUMN IF NOT EXISTS suspension_source TEXT`,
      `UPDATE cc_licenses SET suspension_source='legacy'
       WHERE status='suspended' AND suspension_source IS NULL`,
      `CREATE INDEX IF NOT EXISTS idx_cc_licenses_client_suspension_source
       ON cc_licenses(client_id,status,suspension_source)`,
    ],
  },
  {
    version: 18,
    name: 'canonical_commercial_and_public_plan_catalog',
    statements: [
      `ALTER TABLE cc_plans ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'COP'`,
      `ALTER TABLE cc_plans ADD COLUMN IF NOT EXISTS tax_included INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE cc_plans ADD COLUMN IF NOT EXISTS description TEXT`,
      `INSERT INTO cc_plans
        (plan_key,name,product_family,billing_period,price_minor,limits_json,modules_json,active,currency,tax_included,description)
       VALUES
        ('COMMERCIAL_TRIAL','Comercial Prueba','COMMERCIAL','trial',0,'{"users":1,"devices":1,"branches":1}','["sales","purchases","inventory","cash"]',1,'COP',0,'Prueba comercial de 30 días'),
        ('COMMERCIAL_ENTERPRISE','Comercial Empresarial','COMMERCIAL','monthly',35900000,'{"users":30,"devices":50,"branches":10}','["sales","purchases","inventory","cash","accounting","reports","crm","hrm","payroll","production"]',1,'COP',0,'Operación comercial multiusuario y multisede'),
        ('PUBLIC_TRIAL','Público Prueba','PUBLIC','trial',0,'{"users":1,"devices":1,"branches":1}','["presupuesto_publico","contabilidad_nicsp"]',1,'COP',0,'Prueba de edición pública por 30 días'),
        ('PUBLIC_PRO','Público Profesional','PUBLIC','annual',0,'{"users":60,"devices":100,"branches":20}','["presupuesto_publico","contabilidad_nicsp","contratacion_publica","nomina_publica","sgdea_publico","transparencia","regalias","sgp","siif","salud_publica"]',0,'COP',0,'Precio pendiente de aprobación comercial'),
        ('PUBLIC_INSTITUTIONAL','Público Institucional','PUBLIC','annual',0,'{"users":150,"devices":250,"branches":50}','["presupuesto_publico","contabilidad_nicsp","contratacion_publica","nomina_publica","sgdea_publico","transparencia","regalias","sgp","siif","salud_publica"]',0,'COP',0,'Precio pendiente de aprobación comercial')
       ON CONFLICT(plan_key) DO NOTHING`,
      `UPDATE cc_plans SET price_minor=5900000,currency='COP',description=COALESCE(description,'Plan comercial básico')
       WHERE plan_key='COMMERCIAL_BASIC' AND price_minor=0`,
      `UPDATE cc_plans SET price_minor=18900000,currency='COP',description=COALESCE(description,'Plan comercial profesional')
       WHERE plan_key='COMMERCIAL_PRO' AND price_minor=0`,
      `UPDATE cc_plans SET active=0,description=COALESCE(description,'Precio pendiente de aprobación comercial')
       WHERE product_family='PUBLIC' AND billing_period<>'trial' AND price_minor=0`,
    ],
  },
  {
    version: 19,
    name: 'bind_licenses_to_canonical_plans',
    statements: [
      `ALTER TABLE cc_licenses ADD COLUMN IF NOT EXISTS plan_key TEXT`,
      `UPDATE cc_licenses SET plan_key=CASE
         WHEN product_family='PUBLIC' AND LOWER(type) LIKE '%trial%' THEN 'PUBLIC_TRIAL'
         WHEN product_family='PUBLIC' AND LOWER(type) LIKE '%prof%' THEN 'PUBLIC_PRO'
         WHEN product_family='PUBLIC' AND (LOWER(type) LIKE '%instit%' OR LOWER(type) LIKE '%empresa%') THEN 'PUBLIC_INSTITUTIONAL'
         WHEN product_family='PUBLIC' THEN 'PUBLIC_STANDARD'
         WHEN LOWER(type) LIKE '%trial%' THEN 'COMMERCIAL_TRIAL'
         WHEN LOWER(type) LIKE '%prof%' THEN 'COMMERCIAL_PRO'
         WHEN LOWER(type) LIKE '%empresa%' THEN 'COMMERCIAL_ENTERPRISE'
         ELSE 'COMMERCIAL_BASIC' END
       WHERE plan_key IS NULL`,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='cc_licenses_plan_key_fkey') THEN
           ALTER TABLE cc_licenses ADD CONSTRAINT cc_licenses_plan_key_fkey
             FOREIGN KEY(plan_key) REFERENCES cc_plans(plan_key) ON DELETE SET NULL;
         END IF;
       END $$`,
      `CREATE INDEX IF NOT EXISTS idx_cc_licenses_plan_key ON cc_licenses(plan_key)`,
    ],
  },
  {
    version: 20,
    name: 'final_public_plan_pricing_and_catalog_copy',
    statements: [
      `UPDATE cc_plans SET name='Prueba Comercial',price_minor=0,billing_period='trial',active=1,
         currency='COP',tax_included=0,description='Prueba comercial de 30 días',updated_at=NOW()
       WHERE plan_key='COMMERCIAL_TRIAL'`,
      `UPDATE cc_plans SET name='Comercial Básica',price_minor=5900000,billing_period='monthly',active=1,
         currency='COP',tax_included=0,description='Operación esencial para una empresa o sede',updated_at=NOW()
       WHERE plan_key='COMMERCIAL_BASIC'`,
      `UPDATE cc_plans SET name='Comercial Profesional',price_minor=18900000,billing_period='monthly',active=1,
         currency='COP',tax_included=0,description='Gestión integral para equipos en crecimiento',updated_at=NOW()
       WHERE plan_key='COMMERCIAL_PRO'`,
      `UPDATE cc_plans SET name='Comercial Empresarial',price_minor=35900000,billing_period='monthly',active=1,
         currency='COP',tax_included=0,description='Operación comercial multiusuario y multisede',updated_at=NOW()
       WHERE plan_key='COMMERCIAL_ENTERPRISE'`,
      `UPDATE cc_plans SET name='Prueba Pública',price_minor=0,billing_period='trial',active=1,
         currency='COP',tax_included=0,description='Prueba de la edición pública por 30 días',updated_at=NOW()
       WHERE plan_key='PUBLIC_TRIAL'`,
      `UPDATE cc_plans SET name='Público Estándar',price_minor=480000000,billing_period='annual',active=1,
         currency='COP',tax_included=0,description='Plan anual para entidades pequeñas: COP 4.800.000 antes de IVA',updated_at=NOW()
       WHERE plan_key='PUBLIC_STANDARD'`,
      `UPDATE cc_plans SET name='Público Profesional',price_minor=960000000,billing_period='annual',active=1,
         currency='COP',tax_included=0,description='Plan anual para entidades medianas: COP 9.600.000 antes de IVA',updated_at=NOW()
       WHERE plan_key='PUBLIC_PRO'`,
      `UPDATE cc_plans SET name='Público Institucional',price_minor=1800000000,billing_period='annual',active=1,
         currency='COP',tax_included=0,description='Plan anual multisede: COP 18.000.000 antes de IVA',updated_at=NOW()
       WHERE plan_key='PUBLIC_INSTITUTIONAL'`,
    ],
  },
];

async function applyMigrations(dbPool) {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS cc_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const appliedResult = await dbPool.query('SELECT version FROM cc_schema_migrations');
  const applied = new Set(appliedResult.rows.map((row) => Number(row.version)));
  for (const migration of SCHEMA_MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of migration.statements) {
        await client.query(statement);
      }
      await client.query(
        'INSERT INTO cc_schema_migrations(version, name) VALUES($1, $2)',
        [migration.version, migration.name],
      );
      await client.query('COMMIT');
      console.log(`Applied schema migration ${migration.version}: ${migration.name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

// Initialize PostgreSQL tables
async function initializePostgresTables(pool) {
  try {
    console.log('Initializing PostgreSQL tables...');

    // Create cc_users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        avatar_path TEXT,
        created_at TEXT NOT NULL,
        last_login TEXT,
        is_active INTEGER NOT NULL DEFAULT 1
      )
    `);

    // Create cc_sessions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES cc_users (id) ON DELETE CASCADE
      )
    `);

    // Create cc_settings table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_settings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES cc_users (id) ON DELETE CASCADE,
        UNIQUE(user_id, key)
      )
    `);

    // Create cc_resellers table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_resellers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        nit TEXT,
        contact TEXT,
        phone TEXT,
        email TEXT,
        address TEXT,
        commission_pct REAL,
        logo_path TEXT,
        custom_domain TEXT,
        theme_colors_json TEXT
      )
    `);

    // Create cc_clients table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_clients (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        nit TEXT,
        city TEXT,
        country TEXT,
        status TEXT NOT NULL,
        plan TEXT NOT NULL,
        contract_value REAL NOT NULL DEFAULT 0,
        contract_value_minor BIGINT,
        renewal_date TEXT NOT NULL,
        usage_score INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        reseller_id INTEGER,
        tax_rate REAL NOT NULL DEFAULT 19.0,
        billing_type TEXT NOT NULL DEFAULT 'mensual',
        billing_day INTEGER NOT NULL DEFAULT 5,
        notes TEXT,
        contact_name TEXT,
        contact_phone TEXT,
        contact_email TEXT,
        contact_role TEXT,
        client_password TEXT,
        license_type TEXT DEFAULT 'SUSCRIPCION',
        subscription_months INTEGER DEFAULT 12,
        postgres_schema TEXT,
        postgres_username TEXT,
        postgres_password TEXT,
        FOREIGN KEY (reseller_id) REFERENCES cc_resellers (id) ON DELETE SET NULL
      )
    `);
    // Create cc_leads table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_leads (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        stage TEXT,
        value REAL,
        next_action_at TEXT,
        created_at TEXT NOT NULL,
        contact_name TEXT,
        contact_phone TEXT,
        contact_email TEXT,
        source TEXT,
        probability REAL
      )
    `);


    // Create cc_licenses table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_licenses (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        max_users INTEGER NOT NULL,
        max_devices INTEGER NOT NULL,
        max_branches INTEGER NOT NULL,
        modules TEXT NOT NULL,
        token_hint TEXT,
        updated_at TEXT NOT NULL,
        license_type TEXT NOT NULL DEFAULT 'SUSCRIPCION',
        hardware_fingerprint TEXT,
        offline_token TEXT,
        activation_count INTEGER NOT NULL DEFAULT 0,
        last_heartbeat TEXT,
        grace_period_end TEXT,
        product_family TEXT NOT NULL DEFAULT 'COMMERCIAL',
        FOREIGN KEY (client_id) REFERENCES cc_clients(id) ON DELETE CASCADE
      )
    `);

    // Create cc_installations table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_installations (
        id SERIAL PRIMARY KEY,
        uuid TEXT UNIQUE NOT NULL,
        client_id INTEGER NOT NULL DEFAULT 0,
        license_id INTEGER,
        version TEXT NOT NULL,
        os TEXT NOT NULL,
        connected INTEGER NOT NULL DEFAULT 0,
        license_status TEXT NOT NULL,
        sync_status TEXT NOT NULL,
        database_status TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        critical_errors INTEGER NOT NULL DEFAULT 0,
        ip_address TEXT,
        uptime_hours REAL,
        hardware_fingerprint TEXT,
        company_name TEXT,
        tax_id TEXT,
        license_plan TEXT,
        license_expiry TEXT,
        status TEXT,
        created_at TEXT,
        updated_at TEXT,
        last_heartbeat TEXT,
        command_secret TEXT,
        last_metrics_json TEXT,
        FOREIGN KEY (client_id) REFERENCES cc_clients(id) ON DELETE CASCADE,
        FOREIGN KEY (license_id) REFERENCES cc_licenses(id) ON DELETE SET NULL
      )
    `);

    // Create cc_tickets table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_tickets (
        id SERIAL PRIMARY KEY,
        client_id INTEGER,
        title TEXT NOT NULL,
        description TEXT,
        category TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL,
        assigned_to TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sla_hours INTEGER,
        escalated_level INTEGER,
        FOREIGN KEY (client_id) REFERENCES cc_clients (id) ON DELETE SET NULL
      )
    `);

    // Create cc_releases table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_releases (
        id SERIAL PRIMARY KEY,
        version TEXT NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        pending_installs INTEGER NOT NULL DEFAULT 0,
        published_at TEXT NOT NULL
      )
    `);

    // Create cc_backups table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_backups (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        size_mb REAL NOT NULL DEFAULT 0,
        last_run TEXT NOT NULL,
        FOREIGN KEY (client_id) REFERENCES cc_clients (id) ON DELETE CASCADE
      )
    `);

    // Create cc_invoices table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_invoices (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        invoice_number TEXT NOT NULL,
        status TEXT NOT NULL,
        total REAL NOT NULL,
        total_minor BIGINT,
        due_date TEXT NOT NULL,
        paid_at TEXT,
        items_json TEXT,
        FOREIGN KEY (client_id) REFERENCES cc_clients (id) ON DELETE CASCADE
      )
    `);

    // Create cc_payments table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_payments (
        id SERIAL PRIMARY KEY,
        invoice_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        amount_minor BIGINT,
        status TEXT NOT NULL DEFAULT 'active',
        reversed_at TEXT,
        reversal_reason TEXT,
        method TEXT NOT NULL,
        reference TEXT NOT NULL,
        receipt_path TEXT,
        paid_at TEXT NOT NULL,
        FOREIGN KEY (invoice_id) REFERENCES cc_invoices (id) ON DELETE CASCADE
      )
    `);

    // Create cc_chat_messages table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_chat_messages (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        sender TEXT NOT NULL,
        message TEXT NOT NULL,
        attachment_path TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (client_id) REFERENCES cc_clients (id) ON DELETE CASCADE
      )
    `);

    // Create cc_articles table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_articles (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        tags TEXT,
        content TEXT,
        author TEXT,
        created_at TEXT NOT NULL
      )
    `);

    // Create cc_alerts table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_alerts (
        id SERIAL PRIMARY KEY,
        priority TEXT NOT NULL,
        client_id INTEGER,
        installation_id TEXT,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (client_id) REFERENCES cc_clients (id) ON DELETE SET NULL
      )
    `);

    // Create cc_campaigns table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_campaigns (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        template TEXT,
        subject TEXT,
        target_segment TEXT,
        scheduled_at TEXT,
        status TEXT NOT NULL,
        sent_count INTEGER,
        opened_count INTEGER,
        clicked_count INTEGER
      )
    `);

    // Create cc_telemetry table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_telemetry (
        id SERIAL PRIMARY KEY,
        client_id INTEGER,
        event TEXT NOT NULL,
        module TEXT,
        severity TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (client_id) REFERENCES cc_clients (id) ON DELETE SET NULL
      )
    `);

    // Create cc_audit table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_audit (
        id SERIAL PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      )
    `);

    // Create cc_commands table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_commands (
        id SERIAL PRIMARY KEY,
        installation_uuid TEXT NOT NULL,
        action TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'info',
        title TEXT,
        detail TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        ack_at TEXT,
        result TEXT,
        executed_by TEXT,
        params_json TEXT NOT NULL DEFAULT '{}',
        nonce TEXT,
        expires_at TEXT,
        signature TEXT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_remote_access_sessions (
        id SERIAL PRIMARY KEY,
        installation_uuid TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        access_mode TEXT NOT NULL DEFAULT 'view',
        status TEXT NOT NULL DEFAULT 'pending',
        approval_token_hash TEXT NOT NULL,
        session_token_hash TEXT,
        connection_info_json TEXT,
        requested_at TEXT NOT NULL,
        consent_expires_at TEXT NOT NULL,
        approved_at TEXT,
        rejected_at TEXT,
        ended_at TEXT,
        expires_at TEXT,
        last_seen_at TEXT
      )
    `);

    // Create cc_license_revocations table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_license_revocations (
        id SERIAL PRIMARY KEY,
        license_id INTEGER NOT NULL,
        hardware_fingerprint TEXT NOT NULL,
        reason TEXT,
        revoked_at TEXT NOT NULL,
        revoked_by TEXT,
        FOREIGN KEY (license_id) REFERENCES cc_licenses (id) ON DELETE CASCADE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_offline_activations (
        id SERIAL PRIMARY KEY,
        license_id INTEGER NOT NULL,
        hardware_fingerprint TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        token_jti TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_reason TEXT,
        FOREIGN KEY (license_id) REFERENCES cc_licenses (id) ON DELETE CASCADE,
        UNIQUE(license_id, hardware_fingerprint)
      )
    `);

    // Create cc_sync_hub_log table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_sync_hub_log (
        id SERIAL PRIMARY KEY,
        node_uuid TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        data_json TEXT NOT NULL,
        version_timestamp TEXT NOT NULL,
        is_critical INTEGER NOT NULL DEFAULT 0,
        sync_status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      )
    `);

    // Create cc_consolidated_analytics table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cc_consolidated_analytics (
        id SERIAL PRIMARY KEY,
        report_date TEXT NOT NULL,
        client_id INTEGER,
        total_sales REAL NOT NULL DEFAULT 0,
        total_transactions INTEGER NOT NULL DEFAULT 0,
        total_tickets INTEGER NOT NULL DEFAULT 0,
        total_critical_alerts INTEGER NOT NULL DEFAULT 0,
        active_installations INTEGER NOT NULL DEFAULT 0,
        avg_uptime_hours REAL NOT NULL DEFAULT 0,
        top_products TEXT,
        payment_methods TEXT,
        generated_at TEXT,
        FOREIGN KEY (client_id) REFERENCES cc_clients (id) ON DELETE SET NULL
      )
    `);

    // Create sync_data table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sync_data (
        id SERIAL PRIMARY KEY,
        installation_id TEXT,
        table_name TEXT,
        record_data TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await applyMigrations(pool);
    await ensureDefaultAdminUser();

    // Fix foreign key constraints to match schema (for existing tables)
    try {
      await pool.query(`ALTER TABLE cc_licenses DROP CONSTRAINT IF EXISTS cc_licenses_clients_id_fkeys`);
      await pool.query(`ALTER TABLE cc_licenses DROP CONSTRAINT IF EXISTS cc_licenses_client_id_fkey`);
      await pool.query(`ALTER TABLE cc_licenses ADD CONSTRAINT cc_licenses_client_id_fkey FOREIGN KEY (client_id) REFERENCES cc_clients(id) ON DELETE CASCADE`);

      await pool.query(`ALTER TABLE cc_invoices DROP CONSTRAINT IF EXISTS cc_invoices_client_id_fkey`);
      await pool.query(`ALTER TABLE cc_invoices ADD CONSTRAINT cc_invoices_client_id_fkey FOREIGN KEY (client_id) REFERENCES cc_clients(id) ON DELETE CASCADE`);

      await pool.query(`ALTER TABLE cc_payments DROP CONSTRAINT IF EXISTS cc_payments_invoice_id_fkey`);
      await pool.query(`ALTER TABLE cc_payments ADD CONSTRAINT cc_payments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES cc_invoices(id) ON DELETE CASCADE`);

      await pool.query(`ALTER TABLE cc_tickets DROP CONSTRAINT IF EXISTS cc_tickets_client_id_fkey`);
      await pool.query(`ALTER TABLE cc_tickets ADD CONSTRAINT cc_tickets_client_id_fkey FOREIGN KEY (client_id) REFERENCES cc_clients(id) ON DELETE SET NULL`);

      console.log("Foreign key constraints fixed successfully");
    } catch (error) {
      console.log("Note: Foreign key constraints may already be fixed or tables do not exist yet:", error.message);
    }
    console.log('PostgreSQL tables initialized successfully');
  } catch (error) {
    console.error('Error initializing PostgreSQL tables:', error);
    throw error;
  }
}

// Create tables for client schema
async function createClientTables(pool, schema) {
  try {
    console.log(`Creating tables in schema ${schema}...`);
    const schemaIdent = pgIdentifier(schema);

    // Create main tables for MerkaERP data
    const tables = [
      // Products
      `CREATE TABLE IF NOT EXISTS ${schemaIdent}.productos (
        id SERIAL PRIMARY KEY,
        codigo TEXT UNIQUE NOT NULL,
        nombre TEXT NOT NULL,
        descripcion TEXT,
        precio_venta NUMERIC(18,2) NOT NULL DEFAULT 0,
        costo NUMERIC(18,2) NOT NULL DEFAULT 0,
        categoria TEXT,
        unidad_medida TEXT,
        stock INTEGER NOT NULL DEFAULT 0,
        stock_minimo INTEGER NOT NULL DEFAULT 0,
        iva NUMERIC(7,4) NOT NULL DEFAULT 19,
        activo BOOLEAN NOT NULL DEFAULT true,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        sync_status TEXT DEFAULT 'synced',
        last_sync TEXT
      )`,

      // Customers
      `CREATE TABLE IF NOT EXISTS ${schemaIdent}.clientes (
        id SERIAL PRIMARY KEY,
        identificacion TEXT UNIQUE NOT NULL,
        nombre TEXT NOT NULL,
        email TEXT,
        telefono TEXT,
        direccion TEXT,
        ciudad TEXT,
        tipo_cliente TEXT DEFAULT 'general',
        limite_credito NUMERIC(18,2) NOT NULL DEFAULT 0,
        saldo_actual NUMERIC(18,2) NOT NULL DEFAULT 0,
        activo BOOLEAN NOT NULL DEFAULT true,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        sync_status TEXT DEFAULT 'synced',
        last_sync TEXT
      )`,

      // Sales
      `CREATE TABLE IF NOT EXISTS ${schemaIdent}.ventas (
        id SERIAL PRIMARY KEY,
        numero_factura TEXT UNIQUE NOT NULL,
        cliente_id INTEGER,
        fecha TEXT NOT NULL,
        subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
        iva NUMERIC(18,2) NOT NULL DEFAULT 0,
        total NUMERIC(18,2) NOT NULL DEFAULT 0,
        metodo_pago TEXT,
        estado TEXT DEFAULT 'completada',
        observaciones TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        sync_status TEXT DEFAULT 'synced',
        last_sync TEXT
      )`,

      // Sale items
      `CREATE TABLE IF NOT EXISTS ${schemaIdent}.venta_items (
        id SERIAL PRIMARY KEY,
        venta_id INTEGER NOT NULL,
        producto_id INTEGER NOT NULL,
        cantidad INTEGER NOT NULL,
        precio_unitario NUMERIC(18,2) NOT NULL,
        subtotal NUMERIC(18,2) NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        sync_status TEXT DEFAULT 'synced',
        last_sync TEXT
      )`,

      // Sync tracking
      `CREATE TABLE IF NOT EXISTS ${schemaIdent}.sync_tracking (
        id SERIAL PRIMARY KEY,
        table_name TEXT NOT NULL,
        record_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        device_id TEXT,
        timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
        synced BOOLEAN NOT NULL DEFAULT false
      )`
    ];

    for (const tableSQL of tables) {
      await pool.query(tableSQL);
    }

    // Auto-migrate existing client schemas.
    await pool.query(`ALTER TABLE ${schemaIdent}.venta_items ADD COLUMN IF NOT EXISTS updated_at TEXT DEFAULT CURRENT_TIMESTAMP`);
    const moneyMigrations = [
      `ALTER TABLE ${schemaIdent}.productos ALTER COLUMN precio_venta TYPE NUMERIC(18,2) USING ROUND(precio_venta::numeric, 2)`,
      `ALTER TABLE ${schemaIdent}.productos ALTER COLUMN costo TYPE NUMERIC(18,2) USING ROUND(costo::numeric, 2)`,
      `ALTER TABLE ${schemaIdent}.productos ALTER COLUMN iva TYPE NUMERIC(7,4) USING ROUND(iva::numeric, 4)`,
      `ALTER TABLE ${schemaIdent}.clientes ALTER COLUMN limite_credito TYPE NUMERIC(18,2) USING ROUND(limite_credito::numeric, 2)`,
      `ALTER TABLE ${schemaIdent}.clientes ALTER COLUMN saldo_actual TYPE NUMERIC(18,2) USING ROUND(saldo_actual::numeric, 2)`,
      `ALTER TABLE ${schemaIdent}.ventas ALTER COLUMN subtotal TYPE NUMERIC(18,2) USING ROUND(subtotal::numeric, 2)`,
      `ALTER TABLE ${schemaIdent}.ventas ALTER COLUMN iva TYPE NUMERIC(18,2) USING ROUND(iva::numeric, 2)`,
      `ALTER TABLE ${schemaIdent}.ventas ALTER COLUMN total TYPE NUMERIC(18,2) USING ROUND(total::numeric, 2)`,
      `ALTER TABLE ${schemaIdent}.venta_items ALTER COLUMN precio_unitario TYPE NUMERIC(18,2) USING ROUND(precio_unitario::numeric, 2)`,
      `ALTER TABLE ${schemaIdent}.venta_items ALTER COLUMN subtotal TYPE NUMERIC(18,2) USING ROUND(subtotal::numeric, 2)`,
    ];
    for (const statement of moneyMigrations) await pool.query(statement);

    console.log(`Tables created successfully in schema ${schema}`);
  } catch (error) {
    console.error(`Error creating tables in schema ${schema}:`, error);
    throw error;
  }
}

function parseModules(raw) {
  if (Array.isArray(raw)) return raw.map(String).map((v) => v.trim()).filter(Boolean);
  const value = String(raw || '').trim();
  if (!value) return ['sales', 'purchases', 'inventory', 'cash', 'accounting', 'reports'];
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).map((v) => v.trim()).filter(Boolean);
    } catch (_) {}
  }
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

function signOfflineLicense(payload, options = {}) {
  return signPublisherJwt(payload, { issuer: PUBLISHER_ISSUER, ...options });
}


function deriveClientDbPassword(clientId) {
  const numericClientId = Number(clientId);
  if (!Number.isInteger(numericClientId) || numericClientId <= 0) {
    throw new Error('Invalid client id for PostgreSQL credential derivation');
  }
  // Deterministic server-side credential: re-activating one authorized device
  // must not invalidate PostgreSQL access for the client's other devices.
  // Rotating DB_CREDENTIAL_SECRET intentionally rotates all derived credentials.
  return `${crypto
    .createHmac('sha256', DB_CREDENTIAL_SECRET)
    .update(`merka-client-db:${numericClientId}`)
    .digest('base64url')}!Aa1`;
}

async function provisionClientDatabase(clientId) {
  if (!Number.isInteger(Number(clientId)) || Number(clientId) <= 0) {
    throw new Error('Invalid client id for PostgreSQL provisioning');
  }
  const numericClientId = Number(clientId);
  const postgresSchema = `client_${numericClientId}`;
  const postgresUser = `merka_client_${numericClientId}`;
  const postgresPassword = deriveClientDbPassword(numericClientId);
  const schemaIdent = pgIdentifier(postgresSchema);
  const userIdent = pgIdentifier(postgresUser);
  const passwordLiteral = postgresPassword.replace(/'/g, "''");
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaIdent}`);
    const role = await client.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [postgresUser]);
    if (role.rowCount === 0) {
      await client.query(`CREATE ROLE ${userIdent} LOGIN PASSWORD '${passwordLiteral}'`);
    } else {
      await client.query(`ALTER ROLE ${userIdent} WITH LOGIN PASSWORD '${passwordLiteral}'`);
    }

    await createClientTables(client, postgresSchema);
    await client.query(`GRANT USAGE ON SCHEMA ${schemaIdent} TO ${userIdent}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schemaIdent} TO ${userIdent}`);
    await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schemaIdent} TO ${userIdent}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schemaIdent} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${userIdent}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schemaIdent} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${userIdent}`);
    await client.query(
      `UPDATE cc_clients SET postgres_schema = $1, postgres_username = $2, postgres_password = NULL, updated_at = NOW() WHERE id = $3`,
      [postgresSchema, postgresUser, numericClientId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const parsedUrl = new URL(DATABASE_URL);
  return {
    host: parsedUrl.hostname,
    port: Number(parsedUrl.port || 5432),
    database: parsedUrl.pathname.replace(/^\//, ''),
    schema: postgresSchema,
    username: postgresUser,
    password: postgresPassword,
    ssl: databaseSslEnabled,
  };
}

// Health check endpoint. Exposing the expected/applied schema and build commit
// prevents a healthy-looking old deployment from serving a newer desktop app.
const EXPECTED_SCHEMA_VERSION = Math.max(...SCHEMA_MIGRATIONS.map((migration) => migration.version));
const healthHandler = async (req, res) => {
  try {
    const schemaResult = await pool.query('SELECT COALESCE(MAX(version),0)::int AS version FROM cc_schema_migrations');
    const appliedSchemaVersion = Number(schemaResult.rows[0]?.version || 0);
    const ready = appliedSchemaVersion >= EXPECTED_SCHEMA_VERSION;
    return res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'schema_outdated',
      timestamp: new Date().toISOString(),
      version: '1.2.1',
      merkaerp_compatibility: '1.2.1+5',
      schema_version: appliedSchemaVersion,
      expected_schema_version: EXPECTED_SCHEMA_VERSION,
      build_commit: String(process.env.RENDER_GIT_COMMIT || process.env.BUILD_COMMIT || 'local').slice(0, 40),
      publisher_key_fingerprint: CLIENT_PINNED_PUBLIC_KEY_SHA256,
    });
  } catch (error) {
    console.error('Health check failed:', error.message);
    return res.status(503).json({
      status: 'database_unavailable',
      timestamp: new Date().toISOString(),
      version: '1.2.1',
      expected_schema_version: EXPECTED_SCHEMA_VERSION,
    });
  }
};

app.get('/health', healthHandler);
app.get('/api/v1/health', healthHandler);

// License activation endpoint
app.post('/api/v1/licenses/activate', activationLimiter, async (req, res) => {
  const { email, password, hardware_fingerprint, license_type, license_id, version, os } = req.body || {};
  if (!email || !password || !hardware_fingerprint) {
    return publicError(res, 400, 'Missing required fields: email, password, and hardware_fingerprint');
  }
  if (String(hardware_fingerprint).length < 12 || String(hardware_fingerprint).length > 512) {
    return publicError(res, 400, 'Invalid hardware_fingerprint');
  }

  try {
    const clientResult = await pool.query(
      'SELECT * FROM cc_clients WHERE LOWER(contact_email) = LOWER($1) ORDER BY id LIMIT 2',
      [String(email).trim()],
    );
    if (clientResult.rowCount > 1) {
      return publicError(res, 409, 'Duplicate client accounts exist for this email; contact an administrator');
    }
    const account = clientResult.rows[0];
    if (!account || !account.client_password) {
      return publicError(res, 401, 'Invalid email or password');
    }
    if (!['active', 'trial'].includes(normalizeLicenseStatus(account.status))) {
      return publicError(res, 403, 'Client account is not active');
    }

    let passwordMatches = false;
    if (String(account.client_password).startsWith('$2')) {
      passwordMatches = await bcrypt.compare(String(password), account.client_password);
    } else {
      // Constant-size comparison for legacy plaintext records, followed by an
      // immediate bcrypt upgrade after the first successful authentication.
      const storedDigest = crypto.createHash('sha256').update(String(account.client_password)).digest();
      const suppliedDigest = crypto.createHash('sha256').update(String(password)).digest();
      passwordMatches = crypto.timingSafeEqual(storedDigest, suppliedDigest);
      if (passwordMatches) {
        const upgradedHash = await bcrypt.hash(String(password), 12);
        await pool.query(
          'UPDATE cc_clients SET client_password = $1, updated_at = NOW() WHERE id = $2',
          [upgradedHash, account.id],
        );
      }
    }
    if (!passwordMatches) return publicError(res, 401, 'Invalid email or password');

    const requestedType = license_type ? String(license_type).trim().toUpperCase() : null;
    const requestedLicenseId = Number.isInteger(Number(license_id)) && Number(license_id) > 0
      ? Number(license_id)
      : null;
    const fingerprint = String(hardware_fingerprint);

    // Prefer the license already bound to this hardware. An explicit
    // license_id always wins when the client intentionally changes license.
    const existingBinding = await pool.query(
      `SELECT license_id FROM cc_installations
       WHERE client_id=$1 AND hardware_fingerprint=$2 AND license_id IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
      [account.id, fingerprint],
    );
    const preferredLicenseId = requestedLicenseId || Number(existingBinding.rows[0]?.license_id || 0) || null;

    const licenseResult = await pool.query(
      `SELECT * FROM cc_licenses
       WHERE client_id = $1
         AND LOWER(status) IN ('active', 'activo', 'trial')
         AND ($2::text IS NULL OR UPPER(license_type) = $2)
         AND ($3::int IS NULL OR id = $3)
       ORDER BY
         CASE WHEN id = $4::int THEN 0 ELSE 1 END,
         CASE WHEN LOWER(status) IN ('active', 'activo') THEN 0 ELSE 1 END,
         expires_at DESC,
         id DESC
       LIMIT 1`,
      [account.id, requestedType, requestedLicenseId, preferredLicenseId],
    );
    const selectedLicense = licenseResult.rows[0];
    if (!selectedLicense) return publicError(res, 404, 'No active license found for this client');

    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const lockedResult = await tx.query(
        `SELECT * FROM cc_licenses WHERE id=$1 AND client_id=$2 FOR UPDATE`,
        [selectedLicense.id, account.id],
      );
      const license = lockedResult.rows[0];
      if (!license) {
        await tx.query('ROLLBACK');
        return publicError(res, 404, 'License not found');
      }

      const status = normalizeLicenseStatus(license.status);
      if (!['active', 'trial'].includes(status)) {
        await tx.query('ROLLBACK');
        return publicError(res, 403, 'License is not active');
      }
      const expiresAt = new Date(license.expires_at);
      if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
        await tx.query(`UPDATE cc_licenses SET status='expired', updated_at=NOW() WHERE id=$1`, [license.id]);
        await tx.query('COMMIT');
        return publicError(res, 403, 'License has expired');
      }

      const revoked = await tx.query(
        `SELECT 1 FROM cc_license_revocations
         WHERE license_id=$1 AND hardware_fingerprint=$2 LIMIT 1`,
        [license.id, fingerprint],
      );
      if (revoked.rowCount > 0) {
        await tx.query('ROLLBACK');
        return publicError(res, 403, 'This device has been revoked for the license');
      }

      const existingInstall = await tx.query(
        `SELECT * FROM cc_installations
         WHERE client_id=$1 AND hardware_fingerprint=$2
         ORDER BY CASE WHEN license_id=$3 THEN 0 ELSE 1 END, id DESC
         LIMIT 1`,
        [account.id, fingerprint, license.id],
      );
      const existing = existingInstall.rows[0];
      if (Number(existing?.blocked || 0) === 1) {
        await tx.query('ROLLBACK');
        return publicError(res, 403, 'This installation is blocked');
      }

      const alreadyBound = existing && Number(existing.license_id || 0) === Number(license.id);
      if (!alreadyBound) {
        // Count all *other* devices across online and offline activation modes.
        // The same hardware fingerprint never consumes two slots.
        const devices = await tx.query(
          `SELECT COUNT(DISTINCT hardware_fingerprint)::int AS count
           FROM (
             SELECT hardware_fingerprint FROM cc_installations
              WHERE license_id=$1 AND COALESCE(blocked,0)=0
                AND hardware_fingerprint IS NOT NULL AND hardware_fingerprint<>$2
             UNION
             SELECT hardware_fingerprint FROM cc_offline_activations
              WHERE license_id=$1 AND revoked_at IS NULL
                AND expires_at::timestamptz > NOW() AND hardware_fingerprint<>$2
           ) devices`,
          [license.id, fingerprint],
        );
        const usedByOtherDevices = Number(devices.rows[0]?.count || 0);
        const maxDevices = Math.max(1, Number(license.max_devices || 1));
        if (usedByOtherDevices >= maxDevices) {
          await tx.query('ROLLBACK');
          return publicError(res, 403, `Device limit reached (${usedByOtherDevices}/${maxDevices})`);
        }
      }

      // Provisioning is awaited before the activation is committed. If DDL or
      // grants fail, the installation is not falsely recorded as usable.
      const postgresCredentials = await provisionClientDatabase(account.id);
      const fingerprintHash = crypto
        .createHash('sha256')
        .update(`${account.id}:${license.id}:${fingerprint}`)
        .digest('hex')
        .slice(0, 16)
        .toUpperCase();
      const installationId = alreadyBound && existing?.uuid
        ? existing.uuid
        : `MERKA-${account.id}-${license.id}-${fingerprintHash}`;
      const now = new Date().toISOString();

      // A legacy installation may have the same client/fingerprint under a
      // different UUID. Rebind it instead of consuming an extra device slot.
      if (existing && existing.uuid !== installationId) {
        await tx.query('DELETE FROM cc_installations WHERE id=$1', [existing.id]);
      }

      const previousSecret = existing?.command_secret ? String(existing.command_secret) : null;
      const commandSecret = previousSecret || generateCommandSecret();
      await tx.query(
        `INSERT INTO cc_installations (
          uuid, client_id, license_id, version, os, connected, license_status, sync_status, database_status,
          last_seen, critical_errors, hardware_fingerprint, company_name, tax_id, license_plan,
          license_expiry, status, created_at, updated_at, last_heartbeat, command_secret
        ) VALUES ($1,$2,$3,$4,$5,1,$6,'synced','healthy',$7,0,$8,$9,$10,$11,$12,'active',$7,$7,$7,$13)
        ON CONFLICT (uuid) DO UPDATE SET
          client_id=EXCLUDED.client_id,
          license_id=EXCLUDED.license_id,
          version=EXCLUDED.version,
          os=EXCLUDED.os,
          connected=1,
          license_status=EXCLUDED.license_status,
          last_seen=EXCLUDED.last_seen,
          hardware_fingerprint=EXCLUDED.hardware_fingerprint,
          company_name=EXCLUDED.company_name,
          tax_id=EXCLUDED.tax_id,
          license_plan=EXCLUDED.license_plan,
          license_expiry=EXCLUDED.license_expiry,
          status='active',
          updated_at=EXCLUDED.updated_at,
          last_heartbeat=EXCLUDED.last_heartbeat,
          command_secret=COALESCE(cc_installations.command_secret, EXCLUDED.command_secret)`,
        [
          installationId, account.id, license.id, String(version || 'unknown'), String(os || 'unknown'),
          status, now, fingerprint, account.name, account.nit, license.type, license.expires_at, commandSecret,
        ],
      );

      await tx.query(
        `UPDATE cc_licenses
         SET status=$1,
             activation_count=activation_count + $2,
             last_heartbeat=$3,
             updated_at=$3
         WHERE id=$4`,
        [status, alreadyBound ? 0 : 1, now, license.id],
      );
      await tx.query('COMMIT');

      const licenseModules = parseModules(license.modules);
      const productFamily = normalizeProductFamily(license.product_family, licenseModules);
      const tokenPayload = {
        license_id: license.id,
        installation_id: installationId,
        hardware_fingerprint: fingerprint,
        license_type: normalizeLicenseType(license.license_type),
        status,
        expiry_date: license.expires_at,
        modules: licenseModules,
        product_family: productFamily,
        client_id: account.id,
        client_name: account.name,
      };
      const token = generateLicenseToken(tokenPayload, license.expires_at);

      return res.json({
        success: true,
        token,
        license_token: token,
        token_type: 'Bearer',
        license: {
          id: license.id,
          type: license.type,
          status,
          expires_at: license.expires_at,
          max_users: license.max_users,
          max_devices: license.max_devices,
          max_branches: license.max_branches,
          modules: licenseModules,
          product_family: productFamily,
          installation_id: installationId,
          postgres_credentials: postgresCredentials,
        },
        user: {
          email: String(email).trim(),
          license_type: license.license_type,
          client_id: account.id,
          client_name: account.name,
        },
        installation_id: installationId,
        command_secret: commandSecret,
        postgres_credentials: postgresCredentials,
      });
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      tx.release();
    }
  } catch (error) {
    return serverError(res, 'License activation error', error);
  }
});

// MerkaERP 1.2.1+5 sends license_token in the validation JSON body.
// Accept that exact contract only on /licenses/validate; all other client
// endpoints continue to require Authorization: Bearer.
function validateLicenseRequestToken(req, res, next) {
  if (!bearerToken(req)) {
    const bodyToken = req.body?.license_token;
    if (typeof bodyToken === 'string' && bodyToken.trim()) {
      req.headers.authorization = `Bearer ${bodyToken.trim()}`;
    }
  }
  return validateClientToken(req, res, next);
}

// License validation endpoint. A valid license JWT is required; status/revocation
// are re-checked by validateClientToken on every call.
app.post('/api/v1/licenses/validate', validateLicenseRequestToken, async (req, res) => {
  const requestedFingerprint = req.body?.hardware_fingerprint;
  const requestedInstallation = req.body?.installation_id ?? req.body?.installationId;
  if (requestedFingerprint && String(requestedFingerprint) !== req.hardwareFingerprint) {
    return publicError(res, 403, 'Hardware fingerprint does not match the authenticated installation');
  }
  if (requestedInstallation && String(requestedInstallation) !== req.installationUuid) {
    return publicError(res, 403, 'Installation id does not match the authenticated token');
  }
  try {
    const result = await pool.query(
      `SELECT id, type, status, expires_at, max_users, max_devices, max_branches, modules, license_type, product_family
       FROM cc_licenses WHERE id = $1 AND client_id = $2 LIMIT 1`,
      [req.clientAuth.license_id, req.clientId],
    );
    const license = result.rows[0];
    if (!license) return publicError(res, 404, 'License not found');
    return res.json({
      valid: true,
      license: {
        ...license,
        status: normalizeLicenseStatus(license.status),
        modules: parseModules(license.modules),
      },
      installation_id: req.installationUuid,
    });
  } catch (error) {
    return serverError(res, 'License validation error', error);
  }
});

// Heartbeat endpoint
async function setOperationalAlert({ key, clientId, installationId, priority = 'media', category = 'health', message, details = {}, active = true }) {
  if (!key) return;
  if (!active) {
    await pool.query(
      `UPDATE cc_alerts SET status='resolved',resolved_at=NOW(),updated_at=NOW()
       WHERE alert_key=$1 AND LOWER(status) IN ('active','activa','open')`,
      [key],
    ).catch(() => {});
    return;
  }
  const existing = await pool.query(
    `SELECT id FROM cc_alerts WHERE alert_key=$1 AND LOWER(status) IN ('active','activa','open') ORDER BY id DESC LIMIT 1`,
    [key],
  );
  if (existing.rows[0]) {
    await pool.query(
      `UPDATE cc_alerts SET priority=$1,client_id=$2,installation_id=$3,message=$4,category=$5,details_json=$6,updated_at=NOW(),resolved_at=NULL,status='active' WHERE id=$7`,
      [priority, clientId || null, installationId || null, message, category, safeJson(details), existing.rows[0].id],
    );
  } else {
    await pool.query(
      `INSERT INTO cc_alerts(priority,client_id,installation_id,message,status,created_at,alert_key,category,details_json,updated_at)
       VALUES($1,$2,$3,$4,'active',$5,$6,$7,$8,NOW())`,
      [priority, clientId || null, installationId || null, message, new Date().toISOString(), key, category, safeJson(details)],
    );
  }
}

app.post('/api/v1/installations/heartbeat', validateClientToken, async (req, res) => {
  try {
    const {
      installationId, companyName, taxId, version, os, licenseStatus, syncStatus,
      databaseStatus, criticalErrors, ipAddress, uptimeHours, hardware_fingerprint,
      hardwareFingerprint, licensePlan, licenseExpiry, metrics, capabilities, agentVersion,
      agent_version, architecture, freeDiskMb, free_disk_mb, memoryMb, memory_mb, lastBackupAt, last_backup_at,
      dbSchemaVersion, db_schema_version, appBuildNumber, app_build_number,
    } = req.body || {};
    if (installationId && String(installationId) !== req.installationUuid) {
      return publicError(res, 403, 'Installation id does not match authenticated token');
    }
    const bodyFingerprint = hardware_fingerprint ?? hardwareFingerprint;
    if (bodyFingerprint && String(bodyFingerprint) !== req.hardwareFingerprint) {
      return publicError(res, 403, 'Hardware fingerprint does not match authenticated token');
    }

    const now = new Date().toISOString();
    await pool.query(
      `UPDATE cc_installations SET
         version = COALESCE($1, version),
         os = COALESCE($2, os),
         connected = 1,
         license_status = COALESCE($3, license_status),
         sync_status = COALESCE($4, sync_status),
         database_status = COALESCE($5, database_status),
         last_seen = $6,
         critical_errors = COALESCE($7, critical_errors),
         ip_address = COALESCE($8, ip_address),
         uptime_hours = COALESCE($9, uptime_hours),
         company_name = COALESCE($10, company_name),
         tax_id = COALESCE($11, tax_id),
         license_plan = COALESCE($12, license_plan),
         license_expiry = COALESCE($13, license_expiry),
         last_metrics_json = COALESCE($14, last_metrics_json),
         capabilities_json = COALESCE($15, capabilities_json),
         agent_version = COALESCE($16, agent_version),
         architecture = COALESCE($17, architecture),
         free_disk_mb = COALESCE($18, free_disk_mb),
         memory_mb = COALESCE($19, memory_mb),
         last_backup_at = COALESCE($20::timestamptz, last_backup_at),
         updated_at = $6,
         last_heartbeat = $6
       WHERE uuid = $21 AND client_id = $22`,
      [
        version ? String(version) : null,
        os ? String(os) : null,
        licenseStatus ? normalizeLicenseStatus(licenseStatus) : null,
        syncStatus ? String(syncStatus) : null,
        databaseStatus ? String(databaseStatus) : null,
        now,
        Number.isFinite(Number(criticalErrors)) ? Number(criticalErrors) : null,
        ipAddress ? String(ipAddress) : null,
        Number.isFinite(Number(uptimeHours)) ? Number(uptimeHours) : null,
        companyName ? String(companyName) : null,
        taxId ? String(taxId) : null,
        licensePlan ? String(licensePlan) : null,
        licenseExpiry && !Number.isNaN(Date.parse(String(licenseExpiry))) ? String(licenseExpiry) : null,
        metrics && typeof metrics === 'object' && !Array.isArray(metrics) ? safeJson(metrics) : null,
        Array.isArray(capabilities) ? safeJson(capabilities.map(String).slice(0, 200)) : null,
        String(agentVersion ?? agent_version ?? '').trim() || null,
        String(architecture ?? '').trim() || null,
        Number.isFinite(Number(freeDiskMb ?? free_disk_mb)) ? Math.round(Number(freeDiskMb ?? free_disk_mb)) : null,
        Number.isFinite(Number(memoryMb ?? memory_mb)) ? Math.round(Number(memoryMb ?? memory_mb)) : null,
        (lastBackupAt ?? last_backup_at) && !Number.isNaN(Date.parse(String(lastBackupAt ?? last_backup_at))) ? String(lastBackupAt ?? last_backup_at) : null,
        req.installationUuid,
        req.clientId,
      ],
    );
    await pool.query(
      `UPDATE cc_installations SET db_schema_version=COALESCE($1,db_schema_version),app_build_number=COALESCE($2,app_build_number) WHERE uuid=$3`,
      [String(dbSchemaVersion ?? db_schema_version ?? '').trim() || null, String(appBuildNumber ?? app_build_number ?? '').trim() || null, req.installationUuid],
    ).catch(() => {});
    const healthInput = {
      connected: 1,
      criticalErrors: Number.isFinite(Number(criticalErrors)) ? Number(criticalErrors) : 0,
      freeDiskMb: Number.isFinite(Number(freeDiskMb ?? free_disk_mb)) ? Number(freeDiskMb ?? free_disk_mb) : null,
      databaseStatus: databaseStatus || 'healthy',
      syncStatus: syncStatus || 'synced',
      lastBackupAt: lastBackupAt ?? last_backup_at ?? null,
    };
    const health = computeHealthScore(healthInput);
    await pool.query('UPDATE cc_installations SET health_score=$1 WHERE uuid=$2', [health.score, req.installationUuid]);
    await pool.query(
      `INSERT INTO cc_health_checks(installation_uuid,health_score,health_status,summary_json) VALUES($1,$2,$3,$4)`,
      [req.installationUuid, health.score, health.status, safeJson({ reasons: health.reasons, metrics: metrics || {} })],
    ).catch(() => {});
    await setOperationalAlert({
      key: `health:${req.installationUuid}`,
      clientId: req.clientId,
      installationId: req.installationUuid,
      priority: health.score < 40 ? 'critica' : 'alta',
      category: 'health',
      message: `Salud de instalación ${health.score}/100: ${health.reasons.join(', ') || 'sin detalle'}`,
      details: health,
      active: health.score < 70,
    });
    const diskValue = Number(freeDiskMb ?? free_disk_mb);
    await setOperationalAlert({
      key: `disk:${req.installationUuid}`,
      clientId: req.clientId,
      installationId: req.installationUuid,
      priority: Number.isFinite(diskValue) && diskValue < 256 ? 'critica' : 'alta',
      category: 'storage',
      message: Number.isFinite(diskValue) ? `Espacio libre bajo: ${Math.round(diskValue)} MB` : 'Espacio libre no reportado',
      details: { free_disk_mb: Number.isFinite(diskValue) ? Math.round(diskValue) : null },
      active: Number.isFinite(diskValue) && diskValue < 1024,
    });
    await pool.query('UPDATE cc_licenses SET last_heartbeat = $1 WHERE id = $2', [now, req.clientAuth.license_id]);
    res.json({ success: true, message: 'Heartbeat recorded', server_time: now, health });
  } catch (error) {
    return serverError(res, 'Heartbeat error', error);
  }
});

// Telemetry events endpoint
app.post('/api/v1/telemetry/events', validateClientToken, async (req, res) => {
  try {
    const { event, module, severity } = req.body || {};
    if (!event || String(event).length > 500) return publicError(res, 400, 'A valid event is required');
    const normalizedSeverity = String(severity || 'info').toLowerCase();
    const allowedSeverities = new Set(['debug', 'info', 'warning', 'error', 'critical']);
    if (!allowedSeverities.has(normalizedSeverity)) return publicError(res, 400, 'Invalid severity');
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO cc_telemetry (client_id, event, module, severity, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.clientId, String(event), module ? String(module) : null, normalizedSeverity, now],
    );
    res.json({ success: true, message: 'Telemetry stored' });
  } catch (error) {
    return serverError(res, 'Telemetry error', error);
  }
});

// Auth endpoints
app.post('/api/v1/auth/login', loginLimiter, async (req, res) => {
  const { username, password, otp } = req.body || {};
  if (!username || !password) return publicError(res, 400, 'Missing username or password');

  try {
    const result = await pool.query(
      `SELECT id, username, password_hash, email, role, full_name, two_factor_secret, two_factor_enabled
       FROM cc_users WHERE username = $1 AND is_active = 1 LIMIT 1`,
      [String(username).trim()],
    );
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(String(password), user.password_hash))) {
      return publicError(res, 401, 'Invalid credentials');
    }
    if (Number(user.two_factor_enabled) === 1) {
      if (!otp) return res.status(200).json({ success: false, requires_2fa: true });
      if (!validateTotp(user.two_factor_secret, otp)) return publicError(res, 401, 'Invalid two-factor code');
    }

    const token = signAdminToken(user);
    const decoded = jwt.decode(token);
    const expiresAt = new Date(Number(decoded.exp) * 1000).toISOString();
    await pool.query('DELETE FROM cc_sessions WHERE expires_at::timestamptz <= NOW()');
    await pool.query(
      `INSERT INTO cc_sessions(user_id, token, expires_at, created_at) VALUES($1,$2,$3,$4)`,
      [user.id, hashToken(token), expiresAt, new Date().toISOString()],
    );
    await pool.query('UPDATE cc_users SET last_login = $1 WHERE id = $2', [new Date().toISOString(), user.id]);

    res.json({
      success: true,
      token,
      expires_at: expiresAt,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        full_name: user.full_name,
        role: normalizeAdminRole(user.role),
        two_factor_enabled: Number(user.two_factor_enabled) === 1,
      },
    });
  } catch (error) {
    return serverError(res, 'Login error', error);
  }
});

app.post('/api/v1/auth/logout', validateAdminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM cc_sessions WHERE token = $1', [req.adminTokenHash]);
    res.json({ success: true });
  } catch (error) {
    return serverError(res, 'Logout error', error);
  }
});

app.get('/api/v1/auth/me', validateAdminAuth, (req, res) => {
  res.json({
    success: true,
    user: {
      id: req.user.id,
      username: req.user.username,
      email: req.user.email,
      full_name: req.user.full_name,
      role: normalizeAdminRole(req.user.role),
    },
  });
});

app.get('/api/v1/admin/users', validateAdminAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, email, full_name, role, created_at, last_login, is_active,
              two_factor_enabled, permissions_json
       FROM cc_users ORDER BY id ASC`,
    );
    res.json({ success: true, users: result.rows.map((u) => ({ ...u, role: normalizeAdminRole(u.role) })) });
  } catch (error) {
    return serverError(res, 'List users error', error);
  }
});

app.get('/api/v1/admin/users/:id', validateAdminAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, email, full_name, role, created_at, last_login, is_active, two_factor_enabled, permissions_json
       FROM cc_users WHERE id=$1 LIMIT 1`,
      [req.params.id],
    );
    if (!result.rows[0]) return publicError(res, 404, 'User not found');
    return res.json({ success: true, user: { ...result.rows[0], role: normalizeAdminRole(result.rows[0].role) } });
  } catch (error) { return serverError(res, 'Get user error', error); }
});

app.post('/api/v1/admin/users', validateAdminAuth, requireRole('admin'), async (req, res) => {
  const { username, email, full_name, name, role, password, is_active } = req.body || {};
  const normalizedRole = normalizeAdminRole(role);
  if (!username || !email || !(full_name || name) || !password) {
    return publicError(res, 400, 'username, email, full_name and password are required');
  }
  if (String(password).length < 14) return publicError(res, 400, 'Password must contain at least 14 characters');
  if (normalizedRole === 'super_admin' && !roleAtLeast(req.user.role, 'super_admin')) {
    return publicError(res, 403, 'Only a super administrator can create another super administrator');
  }
  try {
    const passwordHash = await bcrypt.hash(String(password), 12);
    const result = await pool.query(
      `INSERT INTO cc_users(username, password_hash, email, full_name, role, created_at, is_active, permissions_json, updated_at, password_changed_at)
       VALUES($1,$2,$3,$4,$5,NOW(),$6,'[]',NOW(),NOW()) RETURNING id`,
      [String(username).trim(), passwordHash, String(email).trim(), String(full_name || name).trim(), normalizedRole, is_active === 0 ? 0 : 1],
    );
    res.status(201).json({ success: true, id: result.rows[0].id });
  } catch (error) {
    if (error.code === '23505') return publicError(res, 409, 'Username or email already exists');
    return serverError(res, 'Create user error', error);
  }
});

app.put('/api/v1/admin/users/:id', validateAdminAuth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return publicError(res, 400, 'Invalid user id');
  const { username, email, full_name, name, role, password, is_active } = req.body || {};
  try {
    const currentResult = await pool.query('SELECT id, role FROM cc_users WHERE id = $1', [id]);
    const current = currentResult.rows[0];
    if (!current) return publicError(res, 404, 'User not found');
    const nextRole = role ? normalizeAdminRole(role) : normalizeAdminRole(current.role);
    if ((normalizeAdminRole(current.role) === 'super_admin' || nextRole === 'super_admin') && !roleAtLeast(req.user.role, 'super_admin')) {
      return publicError(res, 403, 'Only a super administrator can modify a super administrator');
    }
    if (id === Number(req.user.id) && Number(is_active) === 0) return publicError(res, 400, 'You cannot disable your own account');
    const isDemotingActiveSuperAdmin = normalizeAdminRole(current.role) === 'super_admin'
      && (nextRole !== 'super_admin' || Number(is_active ?? 1) === 0);
    if (isDemotingActiveSuperAdmin) {
      const superCount = await pool.query(
        "SELECT COUNT(*)::int AS count FROM cc_users WHERE LOWER(REPLACE(role, ' ', '_')) IN ('super_admin','superadmin') AND is_active=1",
      );
      if (Number(superCount.rows[0]?.count || 0) <= 1) {
        return publicError(res, 409, 'Cannot demote or disable the last super administrator');
      }
    }

    const fields = [];
    const values = [];
    const set = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };
    if (username != null) set('username', String(username).trim());
    if (email != null) set('email', String(email).trim());
    if (full_name != null || name != null) set('full_name', String(full_name || name).trim());
    if (role != null) set('role', nextRole);
    if (is_active != null) set('is_active', Number(is_active) === 0 ? 0 : 1);
    if (password != null && String(password).length > 0) {
      if (String(password).length < 12) return publicError(res, 400, 'Password must contain at least 12 characters');
      set('password_hash', await bcrypt.hash(String(password), 12));
      set('password_changed_at', new Date());
    }
    set('updated_at', new Date());
    values.push(id);
    if (fields.length === 1) return res.json({ success: true });
    await pool.query(`UPDATE cc_users SET ${fields.join(', ')} WHERE id = $${values.length}`, values);
    if (password != null || is_active === 0) await pool.query('DELETE FROM cc_sessions WHERE user_id = $1', [id]);
    res.json({ success: true });
  } catch (error) {
    if (error.code === '23505') return publicError(res, 409, 'Username or email already exists');
    return serverError(res, 'Update user error', error);
  }
});

app.delete('/api/v1/admin/users/:id', validateAdminAuth, requireRole('super_admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return publicError(res, 400, 'Invalid user id');
  if (id === Number(req.user.id)) return publicError(res, 400, 'You cannot delete your own account');
  try {
    const target = await pool.query('SELECT role FROM cc_users WHERE id = $1', [id]);
    if (!target.rows[0]) return publicError(res, 404, 'User not found');
    if (normalizeAdminRole(target.rows[0].role) === 'super_admin') {
      const count = await pool.query("SELECT COUNT(*)::int AS count FROM cc_users WHERE LOWER(REPLACE(role, ' ', '_')) IN ('super_admin','superadmin') AND is_active = 1");
      if (Number(count.rows[0].count) <= 1) return publicError(res, 409, 'Cannot delete the last super administrator');
    }
    await pool.query('DELETE FROM cc_users WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error) {
    return serverError(res, 'Delete user error', error);
  }
});

app.post('/api/v1/admin/users/:id/2fa/setup', validateAdminAuth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const userResult = await pool.query('SELECT id, username, email, role FROM cc_users WHERE id = $1', [id]);
    const user = userResult.rows[0];
    if (!user) return publicError(res, 404, 'User not found');
    if (normalizeAdminRole(user.role) === 'super_admin' && !roleAtLeast(req.user.role, 'super_admin') && id !== Number(req.user.id)) {
      return publicError(res, 403, 'Insufficient permissions');
    }
    const secret = base32Encode(crypto.randomBytes(20));
    await pool.query('UPDATE cc_users SET two_factor_secret = $1, two_factor_enabled = 0, updated_at = NOW() WHERE id = $2', [secret, id]);
    const label = encodeURIComponent(`Merka Control Center:${user.username}`);
    const issuer = encodeURIComponent('Merka Control Center');
    const otpauthUri = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&digits=6&period=30`;
    res.json({ success: true, secret, otpauth_uri: otpauthUri });
  } catch (error) {
    return serverError(res, '2FA setup error', error);
  }
});

app.post('/api/v1/admin/users/:id/2fa/confirm', validateAdminAuth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const { otp } = req.body || {};
  try {
    const result = await pool.query('SELECT two_factor_secret FROM cc_users WHERE id = $1', [id]);
    const secret = result.rows[0]?.two_factor_secret;
    if (!secret) return publicError(res, 409, '2FA setup has not been started');
    if (!validateTotp(secret, otp)) return publicError(res, 400, 'Invalid two-factor code');
    await pool.query('UPDATE cc_users SET two_factor_enabled = 1, updated_at = NOW() WHERE id = $1', [id]);
    await pool.query('DELETE FROM cc_sessions WHERE user_id = $1 AND token <> $2', [id, req.adminTokenHash]);
    res.json({ success: true });
  } catch (error) {
    return serverError(res, '2FA confirmation error', error);
  }
});

app.post('/api/v1/admin/users/:id/2fa/disable', validateAdminAuth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const targetResult = await pool.query(
      'SELECT id, role, two_factor_secret, two_factor_enabled FROM cc_users WHERE id=$1 LIMIT 1',
      [id],
    );
    const target = targetResult.rows[0];
    if (!target) return publicError(res, 404, 'User not found');
    if (normalizeAdminRole(target.role) === 'super_admin' && !roleAtLeast(req.user.role, 'super_admin') && id !== Number(req.user.id)) {
      return publicError(res, 403, 'Insufficient permissions');
    }
    // Disabling your own second factor requires a fresh TOTP proof. A
    // super-admin may recover another administrator without knowing their TOTP.
    if (id === Number(req.user.id) && Number(target.two_factor_enabled) === 1) {
      if (!validateTotp(target.two_factor_secret, req.body?.otp)) {
        return publicError(res, 400, 'A valid current two-factor code is required');
      }
    }
    await pool.query('UPDATE cc_users SET two_factor_enabled = 0, two_factor_secret = NULL, updated_at = NOW() WHERE id = $1', [id]);
    await pool.query('DELETE FROM cc_sessions WHERE user_id = $1 AND token <> $2', [id, req.adminTokenHash]);
    res.json({ success: true });
  } catch (error) {
    return serverError(res, '2FA disable error', error);
  }
});

// Admin stats endpoint
app.get('/api/v1/admin/stats', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const [
      usersRes, activeUsersRes,
      clientsRes, activeClientsRes,
      licensesRes, activeLicensesRes,
      installationsRes, recentHeartbeatsRes,
      ticketsOpenRes, invoicesPendingRes,
      syncEventsRes, revenueRes, monthlyRevenueRes,
    ] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM cc_users'),
      pool.query('SELECT COUNT(*)::int AS count FROM cc_users WHERE is_active = 1'),
      pool.query('SELECT COUNT(*)::int AS count FROM cc_clients'),
      pool.query("SELECT COUNT(*)::int AS count FROM cc_clients WHERE LOWER(status) = 'active'"),
      pool.query('SELECT COUNT(*)::int AS count FROM cc_licenses'),
      pool.query("SELECT COUNT(*)::int AS count FROM cc_licenses WHERE LOWER(status) IN ('active','trial') AND expires_at::timestamptz > NOW()"),
      pool.query('SELECT COUNT(*)::int AS count FROM cc_installations'),
      pool.query("SELECT COUNT(*)::int AS count FROM cc_installations WHERE last_heartbeat IS NOT NULL AND last_heartbeat::timestamptz >= NOW() - INTERVAL '24 hours'"),
      pool.query("SELECT COUNT(*)::int AS count FROM cc_tickets WHERE LOWER(status) NOT IN ('closed','resolved','cerrado','resuelto')"),
      pool.query("SELECT COUNT(*)::int AS count FROM cc_invoices WHERE LOWER(status) NOT IN ('paid','pagada','cancelled','canceled','anulada')"),
      pool.query('SELECT COUNT(*)::int AS count FROM cc_sync_hub_log'),
      pool.query("SELECT COALESCE(SUM(total), 0)::float AS amount FROM cc_invoices WHERE LOWER(status) IN ('paid','pagada','pagado')"),
      pool.query(`SELECT COALESCE(SUM(total), 0)::float AS amount
                  FROM cc_invoices
                  WHERE LOWER(status) IN ('paid','pagada','pagado')
                    AND paid_at IS NOT NULL
                    AND paid_at::timestamptz >= date_trunc('month', NOW())
                    AND paid_at::timestamptz < date_trunc('month', NOW()) + INTERVAL '1 month'`),
    ]);

    const stats = {
      users: { total: usersRes.rows[0].count, active: activeUsersRes.rows[0].count },
      clients: { total: clientsRes.rows[0].count, active: activeClientsRes.rows[0].count },
      licenses: { total: licensesRes.rows[0].count, active: activeLicensesRes.rows[0].count },
      installations: { total: installationsRes.rows[0].count, recentHeartbeats: recentHeartbeatsRes.rows[0].count },
      tickets: { open: ticketsOpenRes.rows[0].count },
      invoices: { pending: invoicesPendingRes.rows[0].count },
      sync: { totalEvents: syncEventsRes.rows[0].count },
      revenue: { total: revenueRes.rows[0].amount },
    };

    res.json({
      success: true,
      stats,
      // Compatibility fields used by the Desktop client.
      total_clients: stats.clients.total,
      active_licenses: stats.licenses.active,
      total_installations: stats.installations.total,
      monthly_revenue: monthlyRevenueRes.rows[0].amount,
    });
  } catch (error) {
    return serverError(res, 'Admin stats error', error);
  }
});

// General administrative activity stream. MerkaERP transport events have their
// own /admin/sync-events endpoint below.
app.get('/api/v1/admin/activity-events', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit || '50', 10) || 50, 200));
    const offset = Math.max(0, Number.parseInt(req.query.offset || '0', 10) || 0);
    const userId = req.query.userId && /^\d+$/.test(String(req.query.userId))
      ? Number(req.query.userId)
      : null;

    let actor = null;
    if (userId != null) {
      const user = await pool.query('SELECT username FROM cc_users WHERE id = $1 LIMIT 1', [userId]);
      if (!user.rows[0]) return publicError(res, 404, 'User not found');
      actor = user.rows[0].username;
    }

    const where = actor ? 'WHERE actor = $1' : '';
    const dataParams = actor ? [actor, limit, offset] : [limit, offset];
    const limitPos = actor ? 2 : 1;
    const offsetPos = actor ? 3 : 2;
    const countParams = actor ? [actor] : [];

    const [events, total] = await Promise.all([
      pool.query(
        `SELECT id, actor, action, entity, detail, created_at
         FROM cc_audit ${where}
         ORDER BY created_at::timestamptz DESC, id DESC
         LIMIT $${limitPos} OFFSET $${offsetPos}`,
        dataParams,
      ),
      pool.query(`SELECT COUNT(*)::int AS count FROM cc_audit ${where}`, countParams),
    ]);

    return res.json({ success: true, events: events.rows, total: total.rows[0].count, limit, offset });
  } catch (error) {
    return serverError(res, 'Activity events error', error);
  }
});

// Append-only audit endpoint. The actor is always derived from the authenticated session.
app.post('/api/v1/admin/audit', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const action = String(req.body?.action || '').trim().slice(0, 120);
    const entity = String(req.body?.entity || '').trim().slice(0, 120);
    const detail = String(req.body?.detail || '').trim().slice(0, 5000);
    if (!action || !entity) return publicError(res, 400, 'action and entity are required');
    const result = await pool.query(
      `INSERT INTO cc_audit (actor, action, entity, detail, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [req.user.username, action, entity, detail, new Date().toISOString()],
    );
    return res.status(201).json({ success: true, id: result.rows[0].id });
  } catch (error) {
    return serverError(res, 'Audit append error', error);
  }
});

function sanitizeInstallationRow(row) {
  if (!row || typeof row !== 'object') return row;
  const { command_secret: _commandSecret, ...safe } = row;
  return safe;
}

// GET /api/v1/installations - Obtener todas las instalaciones
app.get('/api/v1/installations', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cc_installations ORDER BY created_at DESC');
    return res.json({ success: true, installations: result.rows.map(sanitizeInstallationRow) });
  } catch (error) {
    return serverError(res, 'List installations error', error);
  }
});

// GET /api/v1/installations/client/:clientId - Obtener instalaciones por cliente
app.get('/api/v1/admin/installations', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cc_installations ORDER BY created_at DESC');
    return res.json({ success: true, installations: result.rows.map(sanitizeInstallationRow) });
  } catch (error) { return serverError(res, 'List installations error', error); }
});

app.get('/api/v1/installations/:id', validateAdminAuth, requirePermission('read'), async (req, res, next) => {
  if (req.params.id === 'heartbeat') return next();
  try {
    const key = req.params.id;
    const result = /^\d+$/.test(key)
      ? await pool.query('SELECT * FROM cc_installations WHERE id=$1 LIMIT 1', [Number(key)])
      : await pool.query('SELECT * FROM cc_installations WHERE uuid=$1 LIMIT 1', [key]);
    if (!result.rows[0]) return publicError(res, 404, 'Installation not found');
    return res.json({ success: true, installation: sanitizeInstallationRow(result.rows[0]) });
  } catch (error) { return serverError(res, 'Get installation error', error); }
});

app.put('/api/v1/installations/:id', validateAdminAuth, requirePermission('licenses:write'), async (req, res) => {
  try {
    const key = req.params.id;
    const allowed = ['status','license_status','sync_status','database_status','blocked','block_reason'];
    const entries = Object.entries(req.body || {}).filter(([field]) => allowed.includes(field));
    if (entries.length === 0) return publicError(res, 400, 'No writable installation fields supplied');
    const values = entries.map(([, value]) => value);
    const sets = entries.map(([field], i) => `${pgIdentifier(field)}=$${i+1}`);
    values.push(new Date().toISOString());
    sets.push(`updated_at=$${values.length}`);
    values.push(/^\d+$/.test(key) ? Number(key) : key);
    const where = /^\d+$/.test(key) ? `id=$${values.length}` : `uuid=$${values.length}`;
    const result = await pool.query(`UPDATE cc_installations SET ${sets.join(', ')} WHERE ${where} RETURNING *`, values);
    if (!result.rows[0]) return publicError(res, 404, 'Installation not found');
    return res.json({ success: true, installation: sanitizeInstallationRow(result.rows[0]) });
  } catch (error) { return serverError(res, 'Update installation error', error); }
});

app.delete('/api/v1/installations/:id', validateAdminAuth, requireRole('admin'), async (req, res) => {
  try {
    const key = req.params.id;
    const isNumeric = /^\d+$/.test(key);
    const result = isNumeric
      ? await pool.query(
          `UPDATE cc_installations SET blocked=1, connected=0, status='disabled', block_reason='Deshabilitada desde Control Center', updated_at=NOW() WHERE id=$1 RETURNING id,uuid`,
          [Number(key)],
        )
      : await pool.query(
          `UPDATE cc_installations SET blocked=1, connected=0, status='disabled', block_reason='Deshabilitada desde Control Center', updated_at=NOW() WHERE uuid=$1 RETURNING id,uuid`,
          [key],
        );
    if (!result.rows[0]) return publicError(res, 404, 'Installation not found');
    return res.json({ success: true, id: result.rows[0].id, uuid: result.rows[0].uuid, status: 'disabled' });
  } catch (error) { return serverError(res, 'Disable installation error', error); }
});

app.get('/api/v1/installations/client/:clientId', validateAdminAuth, requirePermission('read'), async (req, res) => {
  const clientId = Number.parseInt(req.params.clientId, 10);
  if (!Number.isInteger(clientId) || clientId <= 0) return publicError(res, 400, 'Invalid client id');
  try {
    const result = await pool.query(
      'SELECT * FROM cc_installations WHERE client_id=$1 ORDER BY created_at DESC',
      [clientId],
    );
    return res.json({ success: true, installations: result.rows.map(sanitizeInstallationRow) });
  } catch (error) {
    return serverError(res, 'List client installations error', error);
  }
});


async function queueSignedCommand({ installationUuid, action, params = {}, priority = 'info', title = null, detail = null, executedBy = 'admin' }) {
  if (!ALLOWED_REMOTE_ACTIONS.has(String(action || ''))) {
    const error = new Error('Unsupported command action');
    error.statusCode = 400;
    throw error;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const installationResult = await client.query(
      `SELECT i.uuid, i.command_secret, i.license_id, i.client_id, i.version, i.os, i.capabilities_json,
              l.status AS bound_license_status, l.expires_at AS bound_license_expires_at, l.modules AS bound_license_modules,
              l.license_type AS bound_license_type, l.product_family AS bound_product_family,
              c.name AS bound_client_name
       FROM cc_installations i
       LEFT JOIN cc_licenses l ON l.id=i.license_id
       LEFT JOIN cc_clients c ON c.id=i.client_id
       WHERE i.uuid=$1 FOR UPDATE OF i`,
      [installationUuid],
    );
    const installation = installationResult.rows[0];
    if (!installation) {
      const error = new Error('Installation not found');
      error.statusCode = 404;
      throw error;
    }
    if (!installation.command_secret) {
      const error = new Error('Installation must re-activate once to provision its command signing secret');
      error.statusCode = 409;
      throw error;
    }

    let normalizedParams = params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {};
    if (action === 'actualizar_licencia' || action === 'actualizar_modulos') {
      if (!installation.license_id || !installation.bound_license_expires_at) {
        const error = new Error('Installation is not bound to a license');
        error.statusCode = 409;
        throw error;
      }
      const licenseStatus = normalizeLicenseStatus(installation.bound_license_status);
      if (!['active', 'trial'].includes(licenseStatus)) {
        const error = new Error('Bound license is not active');
        error.statusCode = 409;
        throw error;
      }
      const modules = parseModules(installation.bound_license_modules);
      const family = normalizeProductFamily(installation.bound_product_family, modules);
      const licenseToken = generateLicenseToken({
        license_id: installation.license_id,
        installation_id: installation.uuid,
        hardware_fingerprint: (await client.query('SELECT hardware_fingerprint FROM cc_installations WHERE uuid=$1',[installationUuid])).rows[0]?.hardware_fingerprint || '',
        license_type: installation.bound_license_type,
        status: licenseStatus,
        expiry_date: installation.bound_license_expires_at,
        modules,
        product_family: family,
        client_id: installation.client_id,
        client_name: installation.bound_client_name,
      }, installation.bound_license_expires_at);
      normalizedParams = {
        ...normalizedParams,
        license_token: licenseToken,
        license: {
          id: Number(installation.license_id),
          status: licenseStatus,
          expires_at: installation.bound_license_expires_at,
          license_type: normalizeLicenseType(installation.bound_license_type),
          modules,
          product_family: family,
        },
      };
    }
    const paramsBytes = Buffer.byteLength(JSON.stringify(normalizedParams), 'utf8');
    if (paramsBytes > 64 * 1024) {
      const error = new Error('Remote command parameters exceed 64 KiB');
      error.statusCode = 413;
      throw error;
    }
    if (action === 'mensaje_admin' && !String(normalizedParams.titulo || '').trim()) {
      const error = new Error('mensaje_admin requires titulo');
      error.statusCode = 400;
      throw error;
    }
    if (action === 'enviar_log') {
      const from = String(normalizedParams.periodo_inicio || '');
      const to = String(normalizedParams.periodo_fin || '');
      if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || Date.parse(from) > Date.parse(to)) {
        const error = new Error('enviar_log requires a valid periodo_inicio <= periodo_fin');
        error.statusCode = 400;
        throw error;
      }
    }
    if (['forzar_actualizacion', 'aplicar_hotfix', 'rollback_actualizacion'].includes(action)) {
      const version = String(normalizedParams.version || normalizedParams.target_version || '').trim();
      if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
        const error = new Error(`${action} requires a valid version`);
        error.statusCode = 400;
        throw error;
      }
      const requestedReleaseId = Number.parseInt(String(normalizedParams.release_id || ''), 10);
      const releaseParams = [];
      const releaseWhere = [];
      if (Number.isInteger(requestedReleaseId) && requestedReleaseId > 0) {
        releaseParams.push(requestedReleaseId);
        releaseWhere.push(`id=$${releaseParams.length}`);
      } else {
        releaseParams.push(version);
        releaseWhere.push(`version=$${releaseParams.length}`);
      }
      releaseParams.push(normalizeProductFamily(installation.bound_product_family));
      releaseWhere.push(`product_family IN ('ALL',$${releaseParams.length})`);
      const release = await client.query(
        `SELECT id,version,release_type,product_family,sha256,size_bytes,artifact_path,download_url
         FROM cc_releases WHERE ${releaseWhere.join(' AND ')} AND LOWER(status)='published'
         AND (artifact_path IS NOT NULL OR download_url ~* '^https://')
         AND sha256 ~ '^[a-fA-F0-9]{64}$' AND size_bytes > 0
         ORDER BY id DESC LIMIT 1`,
        releaseParams,
      );
      if (!release.rows[0] || String(release.rows[0].version) !== version) {
        const error = new Error('The requested version is not a complete published release compatible with this installation edition');
        error.statusCode = 409;
        throw error;
      }
      if (action === 'aplicar_hotfix' && String(release.rows[0].release_type || '').toLowerCase() !== 'hotfix') {
        const error = new Error('aplicar_hotfix requires a release_type=hotfix artifact');
        error.statusCode = 409;
        throw error;
      }
      normalizedParams = {
        ...normalizedParams,
        release_id: String(release.rows[0].id),
        version,
        target_version: version,
        product_family: String(release.rows[0].product_family || 'ALL'),
        sha256: String(release.rows[0].sha256 || '').toLowerCase(),
        size_bytes: Number(release.rows[0].size_bytes || 0),
      };
    }
    if (action === 'solicitar_acceso_remoto') {
      const sessionId = Number.parseInt(String(normalizedParams.session_id || ''), 10);
      if (!Number.isInteger(sessionId) || sessionId <= 0) {
        const error = new Error('solicitar_acceso_remoto requires a valid session_id');
        error.statusCode = 400;
        throw error;
      }
    }

    const timestamp = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const nonce = generateNonce();
    const paramsJson = safeJson(normalizedParams);
    const inserted = await client.query(
      `INSERT INTO cc_commands
       (installation_uuid, action, priority, title, detail, status, created_at, executed_by,
        params_json, nonce, expires_at, signature)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,NULL)
       RETURNING id`,
      [installationUuid, action, priority || 'info', title || action, detail == null ? '' : String(detail).slice(0, 4000), timestamp, executedBy, paramsJson, nonce, expiresAt],
    );
    const id = String(inserted.rows[0].id);
    const signature = signCommand(installation.command_secret, {
      id,
      action,
      installationId: installationUuid,
      timestamp,
      expiresAt,
      nonce,
      params: normalizedParams,
    });
    await client.query('UPDATE cc_commands SET signature=$1 WHERE id=$2', [signature, inserted.rows[0].id]);
    await client.query('COMMIT');
    return { id, action, installation_id: installationUuid, timestamp, expires_at: expiresAt, nonce, signature, params: normalizedParams };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}


async function triggerAutomaticRollback(deploymentId) {
  const tx = await pool.connect();
  let rollback = null;
  let targets = [];
  try {
    await tx.query('BEGIN');
    const original = (await tx.query(
      `SELECT d.*,r.version,r.rollback_version
       FROM cc_deployments d JOIN cc_releases r ON r.id=d.release_id
       WHERE d.id=$1 FOR UPDATE OF d`,
      [deploymentId],
    )).rows[0];
    if (!original || Number(original.auto_rollback || 0) !== 1 || original.rollback_deployment_id) {
      await tx.query('ROLLBACK');
      return null;
    }
    const targetVersion = String(original.rollback_version || '').trim();
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(targetVersion)) {
      await tx.query('ROLLBACK');
      return null;
    }
    const targetRelease = (await tx.query(
      `SELECT * FROM cc_releases
       WHERE version=$1 AND status='published' AND product_family IN ('ALL',$2)
         AND (artifact_path IS NOT NULL OR download_url ~* '^https://')
         AND sha256 ~ '^[a-fA-F0-9]{64}$' AND size_bytes>0
       ORDER BY CASE WHEN product_family=$2 THEN 0 ELSE 1 END,id DESC LIMIT 1`,
      [targetVersion, original.product_family],
    )).rows[0];
    if (!targetRelease) {
      await tx.query('ROLLBACK');
      return null;
    }
    targets = (await tx.query(
      `SELECT installation_uuid FROM cc_deployment_targets
       WHERE deployment_id=$1 AND status='completed' ORDER BY id LIMIT 1000`,
      [deploymentId],
    )).rows;
    if (targets.length === 0) {
      await tx.query('ROLLBACK');
      return null;
    }
    rollback = (await tx.query(
      `INSERT INTO cc_deployments
       (release_id,name,scope_type,scope_id,product_family,strategy,status,target_count,created_by,batch_pct,error_threshold_pct,rollback_of,auto_rollback,started_at)
       VALUES($1,$2,'rollback',$3,$4,'immediate','running',$5,'auto-rollback',100,100,$6,0,NOW()) RETURNING *`,
      [targetRelease.id, `Auto rollback ${original.version} -> ${targetVersion}`, String(deploymentId), original.product_family, targets.length, deploymentId],
    )).rows[0];
    for (const row of targets) {
      await tx.query(
        `INSERT INTO cc_deployment_targets(deployment_id,installation_uuid,status,previous_version)
         VALUES($1,$2,'pending',$3) ON CONFLICT DO NOTHING`,
        [rollback.id, row.installation_uuid, original.version],
      );
    }
    await tx.query(
      `UPDATE cc_deployments SET rollback_deployment_id=$1,paused_at=COALESCE(paused_at,NOW()) WHERE id=$2`,
      [rollback.id, deploymentId],
    );
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    tx.release();
  }

  let queued = 0;
  let failed = 0;
  for (const row of targets) {
    try {
      const command = await queueSignedCommand({
        installationUuid: row.installation_uuid,
        action: 'rollback_actualizacion',
        params: {
          version: String((await pool.query('SELECT version FROM cc_releases WHERE id=$1', [rollback.release_id])).rows[0]?.version || ''),
          release_id: String(rollback.release_id),
          deployment_id: String(rollback.id),
          rollback_of: String(deploymentId),
        },
        priority: 'critica',
        title: `Rollback automático de despliegue #${deploymentId}`,
        executedBy: 'auto-rollback',
      });
      await pool.query(
        `UPDATE cc_deployment_targets SET command_id=$1,status='queued',attempt_count=attempt_count+1,last_attempt_at=NOW(),updated_at=NOW()
         WHERE deployment_id=$2 AND installation_uuid=$3`,
        [Number(command.id), rollback.id, row.installation_uuid],
      );
      queued += 1;
    } catch (error) {
      await pool.query(
        `UPDATE cc_deployment_targets SET status='failed',last_error=$1,attempt_count=attempt_count+1,last_attempt_at=NOW(),updated_at=NOW()
         WHERE deployment_id=$2 AND installation_uuid=$3`,
        [String(error.message || error).slice(0, 2000), rollback.id, row.installation_uuid],
      ).catch(() => {});
      failed += 1;
    }
  }
  await pool.query(
    `UPDATE cc_deployments SET failed_count=$1,status=CASE WHEN $2=0 THEN 'completed_with_errors' ELSE 'running' END,
     completed_at=CASE WHEN $2=0 THEN NOW() ELSE completed_at END WHERE id=$3`,
    [failed, queued, rollback.id],
  );
  await setOperationalAlert({
    key: `deployment-auto-rollback:${deploymentId}`,
    priority: 'critica',
    category: 'deployment',
    message: `Rollback automático iniciado para despliegue #${deploymentId}`,
    details: { deployment_id: deploymentId, rollback_deployment_id: rollback.id, queued, failed },
    active: true,
  }).catch(() => {});
  return { rollback, queued, failed };
}

async function processDueScheduledDeployments() {
  const due = await pool.query(
    `SELECT d.*,r.version,r.release_type
     FROM cc_deployments d JOIN cc_releases r ON r.id=d.release_id
     WHERE d.strategy='scheduled' AND d.scheduled_at IS NOT NULL AND d.scheduled_at<=NOW()
       AND d.status IN ('draft','queued','running')
     ORDER BY d.scheduled_at ASC LIMIT 20`,
  );
  for (const deployment of due.rows) {
    await pool.query(
      `UPDATE cc_deployments SET status='running',started_at=COALESCE(started_at,NOW()),paused_at=NULL WHERE id=$1`,
      [deployment.id],
    );
    const targets = await pool.query(
      `SELECT * FROM cc_deployment_targets WHERE deployment_id=$1 AND status='pending' ORDER BY id LIMIT 500`,
      [deployment.id],
    );
    for (const target of targets.rows) {
      try {
        const action = deployment.rollback_of
          ? 'rollback_actualizacion'
          : (deployment.release_type === 'hotfix' ? 'aplicar_hotfix' : 'forzar_actualizacion');
        const command = await queueSignedCommand({
          installationUuid: target.installation_uuid,
          action,
          params: {
            version: deployment.version,
            target_version: deployment.version,
            release_id: String(deployment.release_id),
            deployment_id: String(deployment.id),
          },
          priority: 'alta',
          title: `Despliegue programado ${deployment.version}`,
          executedBy: deployment.created_by || 'scheduler',
        });
        await pool.query(
          `UPDATE cc_deployment_targets SET command_id=$1,status='queued',attempt_count=attempt_count+1,last_attempt_at=NOW(),updated_at=NOW() WHERE id=$2`,
          [Number(command.id), target.id],
        );
      } catch (error) {
        await pool.query(
          `UPDATE cc_deployment_targets SET status='failed',last_error=$1,attempt_count=attempt_count+1,last_attempt_at=NOW(),updated_at=NOW() WHERE id=$2`,
          [String(error.message || error).slice(0, 2000), target.id],
        );
      }
    }
  }
}

registerFleetRoutes({
  app, pool, validateAdminAuth, validateClientToken, requirePermission, requireRole,
  publicError, serverError, queueSignedCommand, normalizeProductFamily, normalizeLicenseStatus,
});

// GET /api/v1/installations/:uuid/commands - authenticated, signed command polling.
app.get('/api/v1/installations/:uuid/commands', validateClientToken, async (req, res) => {
  try {
    if (String(req.params.uuid) !== req.installationUuid) {
      return publicError(res, 403, 'Installation does not match authenticated token');
    }
    const result = await pool.query(
      `SELECT id, installation_uuid, action, params_json, status, created_at, expires_at, nonce, signature
       FROM cc_commands
       WHERE installation_uuid = $1 AND status = 'pending'
         AND expires_at IS NOT NULL AND expires_at::timestamptz > NOW()
       ORDER BY created_at ASC, id ASC
       LIMIT 100`,
      [req.installationUuid],
    );
    const commands = result.rows.map((row) => {
      let params = {};
      try { params = JSON.parse(row.params_json || '{}'); } catch (_) {}
      return {
        id: String(row.id),
        action: row.action,
        params,
        timestamp: row.created_at,
        installation_id: row.installation_uuid,
        expires_at: row.expires_at,
        nonce: row.nonce,
        signature: row.signature,
      };
    });
    return res.json({ success: true, commands });
  } catch (error) {
    return serverError(res, 'Error fetching installation commands', error);
  }
});

// POST /api/v1/commands/:commandId/ack - authenticated acknowledgement.
app.post('/api/v1/commands/:commandId/ack', validateClientToken, async (req, res) => {
  try {
    const commandId = Number(req.params.commandId);
    const ackStatus = String(req.body?.status || '').trim().toLowerCase();
    const installationId = String(req.body?.installation_id || req.body?.installationId || req.installationUuid);
    const message = req.body?.message == null ? '' : String(req.body.message).slice(0, 10000);
    const ackResult = req.body?.result && typeof req.body.result === 'object' && !Array.isArray(req.body.result)
      ? req.body.result : {};
    if (!Number.isInteger(commandId) || commandId <= 0) return publicError(res, 400, 'Invalid command id');
    if (installationId !== req.installationUuid) return publicError(res, 403, 'Installation mismatch');
    if (!/^[a-z_]{2,64}$/.test(ackStatus)) return publicError(res, 400, 'Invalid command acknowledgement status');
    const successStatuses = new Set(['done', 'complete', 'completed', 'success', 'installer_started', 'accepted', 'approved', 'ok']);
    const normalizedStatus = successStatuses.has(ackStatus) ? 'completed' : 'failed';
    const resultPayload = safeJson({ ack_status: ackStatus, message, result: ackResult });
    const updated = await pool.query(
      `UPDATE cc_commands SET status=$1, result=$2, ack_at=$3
       WHERE id=$4 AND installation_uuid=$5 AND status='pending'
       RETURNING id, action, params_json`,
      [normalizedStatus, resultPayload, new Date().toISOString(), commandId, req.installationUuid],
    );
    if (updated.rowCount === 0) return publicError(res, 404, 'Pending command not found for this installation');

    // MerkaERP 1.2.1+5 returns remote-access consent through the normal
    // signed-command ACK channel. Reflect that consent in the administrative
    // session record; no streaming/control transport is implied by approval.
    const acknowledged = updated.rows[0];
    const completedAt = new Date().toISOString();
    await setOperationalAlert({
      key: `command-failure:${req.installationUuid}:${acknowledged.action}`,
      clientId: req.clientId,
      installationId: req.installationUuid,
      priority: normalizedStatus === 'failed' ? 'alta' : 'info',
      category: 'remote-command',
      message: normalizedStatus === 'failed' ? `Falló comando remoto: ${acknowledged.action}` : '',
      details: normalizedStatus === 'failed' ? { command_id: commandId, action: acknowledged.action, message, result: ackResult } : {},
      active: normalizedStatus === 'failed',
    }).catch(() => {});
    const deploymentTarget = await pool.query(
      `UPDATE cc_deployment_targets SET status=$1,last_error=CASE WHEN $1='failed' THEN $2 ELSE NULL END,updated_at=NOW() WHERE command_id=$3 RETURNING deployment_id`,
      [normalizedStatus, normalizedStatus === 'failed' ? message : null, commandId],
    ).catch(() => ({ rows: [] }));
    const deploymentId = deploymentTarget.rows?.[0]?.deployment_id;
    if (deploymentId) {
      const deploymentStats = (await pool.query(
        `SELECT d.error_threshold_pct,d.auto_rollback,d.rollback_deployment_id,r.rollback_version,
          COUNT(*) FILTER(WHERE t.status='completed')::int success,
          COUNT(*) FILTER(WHERE t.status='failed')::int failed,
          COUNT(*) FILTER(WHERE t.status='pending')::int pending,
          COUNT(*) FILTER(WHERE t.status='queued')::int queued
         FROM cc_deployments d JOIN cc_releases r ON r.id=d.release_id JOIN cc_deployment_targets t ON t.deployment_id=d.id
         WHERE d.id=$1 GROUP BY d.id,d.error_threshold_pct,d.auto_rollback,d.rollback_deployment_id,r.rollback_version`,
        [deploymentId],
      )).rows[0];
      if (deploymentStats) {
        const observed = Number(deploymentStats.success) + Number(deploymentStats.failed);
        const failurePct = observed > 0 ? Number(deploymentStats.failed) * 100 / observed : 0;
        const noWorkLeft = Number(deploymentStats.pending) === 0 && Number(deploymentStats.queued) === 0;
        const autoPause = observed >= 3 && failurePct >= Number(deploymentStats.error_threshold_pct || 20) && !noWorkLeft;
        const deploymentStatus = noWorkLeft
          ? (Number(deploymentStats.failed) > 0 ? 'completed_with_errors' : 'completed')
          : (autoPause ? 'paused' : 'running');
        await pool.query(
          `UPDATE cc_deployments SET status=$1,success_count=$2,failed_count=$3,
           paused_at=CASE WHEN $1='paused' THEN NOW() ELSE paused_at END,
           completed_at=CASE WHEN $1 IN ('completed','completed_with_errors') THEN NOW() ELSE completed_at END
           WHERE id=$4`,
          [deploymentStatus, deploymentStats.success, deploymentStats.failed, deploymentId],
        );
        if (autoPause && Number(deploymentStats.auto_rollback || 0) === 1 && !deploymentStats.rollback_deployment_id && deploymentStats.rollback_version) {
          triggerAutomaticRollback(Number(deploymentId)).catch((error) => console.error('Automatic rollback failed:', error.message));
        }
      }
    }
    await pool.query(
      `UPDATE cc_diagnostic_runs SET status=$1,result_json=$2,completed_at=$3 WHERE command_id=$4`,
      [normalizedStatus, resultPayload, completedAt, commandId],
    ).catch(() => {});
    await pool.query(
      `UPDATE cc_repair_runs SET status=$1,result_json=$2,completed_at=$3 WHERE command_id=$4`,
      [normalizedStatus, resultPayload, completedAt, commandId],
    ).catch(() => {});
    await pool.query(
      `UPDATE cc_restore_jobs SET status=$1,result_json=$2,completed_at=$3 WHERE command_id=$4`,
      [normalizedStatus, resultPayload, completedAt, commandId],
    ).catch(() => {});
    await pool.query(
      `UPDATE cc_agent_artifact_requests SET status=CASE WHEN $1='failed' THEN 'failed' ELSE 'awaiting_upload' END,
       completed_at=CASE WHEN $1='failed' THEN $2 ELSE completed_at END
       WHERE command_id=$3 AND status<>'completed'`,
      [normalizedStatus, completedAt, commandId],
    ).catch(() => {});
    let acknowledgedParams = {};
    try { acknowledgedParams = JSON.parse(acknowledged.params_json || '{}'); } catch (_) {}
    if (normalizedStatus === 'completed' && ['forzar_actualizacion','aplicar_hotfix','rollback_actualizacion'].includes(acknowledged.action)) {
      const installedVersion = String(ackResult.installed_version || acknowledgedParams.target_version || acknowledgedParams.version || '').trim();
      if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(installedVersion)) {
        await pool.query(`UPDATE cc_installations SET version=$1,updated_at=NOW() WHERE uuid=$2`, [installedVersion, req.installationUuid]).catch(() => {});
      }
    }
    if (acknowledged.action === 'forzar_respaldo' && acknowledgedParams.backup_id) {
      const backupId = Number.parseInt(String(acknowledgedParams.backup_id), 10);
      if (Number.isInteger(backupId) && backupId > 0) {
        await pool.query(
          `UPDATE cc_backups SET status=$1,size_mb=COALESCE($2,size_mb),backup_ref=COALESCE($3,backup_ref),checksum=COALESCE($4,checksum),completed_at=$5,last_run=$5 WHERE id=$6`,
          [normalizedStatus, Number.isFinite(Number(ackResult.size_mb)) ? Number(ackResult.size_mb) : null, ackResult.backup_ref ? String(ackResult.backup_ref) : null, ackResult.checksum ? String(ackResult.checksum) : null, completedAt, backupId],
        ).catch(() => {});
        if (normalizedStatus === 'completed') {
          await pool.query(`UPDATE cc_installations SET last_backup_at=$1 WHERE uuid=$2`, [completedAt, req.installationUuid]).catch(() => {});
        }
      }
    }
    if (acknowledged.action === 'run_diagnostics' || acknowledged.action === 'collect_diagnostics') {
      await pool.query(`UPDATE cc_installations SET last_diagnostic_at=$1 WHERE uuid=$2`, [completedAt, req.installationUuid]).catch(() => {});
    }
    if (acknowledged.action === 'entrar_mantenimiento' && normalizedStatus === 'completed') {
      await pool.query(`UPDATE cc_installations SET maintenance_mode=1 WHERE uuid=$1`, [req.installationUuid]).catch(() => {});
    } else if (acknowledged.action === 'salir_mantenimiento' && normalizedStatus === 'completed') {
      await pool.query(`UPDATE cc_installations SET maintenance_mode=0 WHERE uuid=$1`, [req.installationUuid]).catch(() => {});
    }

    if (acknowledged.action === 'solicitar_acceso_remoto') {
      let params = {};
      try { params = JSON.parse(acknowledged.params_json || '{}'); } catch (_) {}
      const sessionId = Number.parseInt(String(params.session_id || ''), 10);
      if (Number.isInteger(sessionId) && sessionId > 0) {
        if (ackStatus === 'approved') {
          await pool.query(
            `UPDATE cc_remote_access_sessions SET status='approved', approved_at=COALESCE(approved_at,NOW()), last_seen_at=NOW()
             WHERE id=$1 AND installation_uuid=$2 AND status='pending'`,
            [sessionId, req.installationUuid],
          );
        } else if (ackStatus === 'rejected') {
          await pool.query(
            `UPDATE cc_remote_access_sessions SET status='rejected', rejected_at=COALESCE(rejected_at,NOW()), last_seen_at=NOW()
             WHERE id=$1 AND installation_uuid=$2 AND status='pending'`,
            [sessionId, req.installationUuid],
          );
        }
      }
    }
    return res.json({ success: true, message: 'Command acknowledged' });
  } catch (error) {
    return serverError(res, 'Error acknowledging command', error);
  }
});

app.get('/api/v1/installations/:uuid/commands/admin', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, installation_uuid, action, priority, title, detail, status, created_at, ack_at, result, executed_by,
              params_json, nonce, expires_at, signature
       FROM cc_commands WHERE installation_uuid=$1 ORDER BY created_at DESC LIMIT 200`,
      [req.params.uuid],
    );
    return res.json({ success: true, commands: result.rows });
  } catch (error) {
    return serverError(res, 'Error fetching admin command history', error);
  }
});

app.post('/api/v1/installations/:uuid/commands', validateAdminAuth, requirePermission('commands:write'), async (req, res) => {
  try {
    const action = String(req.body?.action || '').trim();
    const params = req.body?.params ?? req.body?.payload ?? (() => {
      if (!req.body?.detail) return {};
      try { return JSON.parse(String(req.body.detail)); } catch (_) { return { message: String(req.body.detail) }; }
    })();
    const command = await queueSignedCommand({
      installationUuid: String(req.params.uuid),
      action,
      params: params && typeof params === 'object' && !Array.isArray(params) ? params : {},
      priority: String(req.body?.priority || 'info'),
      title: req.body?.title == null ? null : String(req.body.title),
      executedBy: req.user?.username || 'admin',
    });
    return res.status(201).json({ success: true, id: command.id, command });
  } catch (error) {
    if (error.statusCode) return publicError(res, error.statusCode, error.message);
    return serverError(res, 'Error queueing command', error);
  }
});

app.post('/api/v1/remote-access/sessions', validateAdminAuth, requirePermission('remote:write'), async (req, res) => {
  if (!REMOTE_ACCESS_ENABLED) return publicError(res, 503, 'Remote access is disabled until a transport provider is configured');
  try {
    const { installation_uuid, reason, access_mode, duration_minutes } = req.body;
    if (!installation_uuid || !reason) {
      return res.status(400).json({ success: false, error: 'installation_uuid and reason are required' });
    }

    const mode = access_mode === 'control' ? 'control' : 'view';
    const duration = Math.max(5, Math.min(Number(duration_minutes) || 30, 60));
    const approvalToken = crypto.randomBytes(24).toString('hex');
    const now = new Date();
    const consentExpiresAt = new Date(now.getTime() + 10 * 60 * 1000);
    const sessionExpiresAt = new Date(now.getTime() + duration * 60 * 1000);
    const requestedBy = req.user?.username || 'admin';

    const sessionResult = await pool.query(`
      INSERT INTO cc_remote_access_sessions
        (installation_uuid, requested_by, reason, access_mode, status, approval_token_hash,
         requested_at, consent_expires_at, expires_at)
      VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8)
      RETURNING id, installation_uuid, requested_by, reason, access_mode, status, requested_at, consent_expires_at, expires_at
    `, [installation_uuid, requestedBy, reason, mode, hashToken(approvalToken), now.toISOString(), consentExpiresAt.toISOString(), sessionExpiresAt.toISOString()]);

    const session = sessionResult.rows[0];
    const payload = {
      session_id: session.id,
      approval_token: approvalToken,
      reason,
      access_mode: mode,
      requested_by: requestedBy,
      consent_expires_at: consentExpiresAt.toISOString(),
      expires_at: sessionExpiresAt.toISOString(),
      response_endpoint: `/api/v1/remote-access/sessions/${session.id}/client-response`
    };

    const command = await queueSignedCommand({
      installationUuid: String(installation_uuid),
      action: 'solicitar_acceso_remoto',
      params: payload,
      priority: 'critica',
      title: 'Solicitud de acceso remoto',
      executedBy: requestedBy,
    });

    await pool.query(`
      INSERT INTO cc_audit (actor, action, entity, detail, created_at)
      VALUES ($1, 'SOLICITAR_ACCESO_REMOTO', 'remote_access_session', $2, $3)
    `, [requestedBy, `session=${session.id}; installation=${installation_uuid}; mode=${mode}; command=${command.id}`, now.toISOString()]);

    res.json({
      success: true,
      session,
      command_id: command.id,
      message: 'Remote access request queued. Waiting for customer approval.'
    });
  } catch (error) {
    console.error('Error creating remote access session:', error);
    return serverError(res, 'Request failed', error);
  }
});

app.get('/api/v1/remote-access/sessions/:id', validateAdminAuth, requirePermission('remote:write'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, installation_uuid, requested_by, reason, access_mode, status, connection_info_json,
             requested_at, consent_expires_at, approved_at, rejected_at, ended_at, expires_at, last_seen_at
      FROM cc_remote_access_sessions
      WHERE id = $1
    `, [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Remote access session not found' });
    }
    res.json({ success: true, session: result.rows[0] });
  } catch (error) {
    console.error('Error fetching remote access session:', error);
    return serverError(res, 'Request failed', error);
  }
});

app.post('/api/v1/remote-access/sessions/:id/end', validateAdminAuth, requirePermission('remote:write'), async (req, res) => {
  try {
    const endedAt = new Date().toISOString();
    const result = await pool.query(`
      UPDATE cc_remote_access_sessions
      SET status = 'ended', ended_at = $1
      WHERE id = $2 AND status IN ('pending', 'approved', 'active')
      RETURNING id
    `, [endedAt, req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Active remote access session not found' });
    }
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    console.error('Error ending remote access session:', error);
    return serverError(res, 'Request failed', error);
  }
});

app.post('/api/v1/remote-access/sessions/:id/client-response', validateClientToken, async (req, res) => {
  if (!REMOTE_ACCESS_ENABLED) return publicError(res, 503, 'Remote access is disabled');
  try {
    const { approval_token, decision, connection_info } = req.body || {};
    const installation_uuid = req.installationUuid;
    if (!approval_token || !decision) {
      return publicError(res, 400, 'approval_token and decision are required');
    }

    const sessionResult = await pool.query(
      `SELECT * FROM cc_remote_access_sessions WHERE id = $1 AND installation_uuid = $2`,
      [req.params.id, installation_uuid]
    );
    if (sessionResult.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Remote access session not found' });
    }

    const session = sessionResult.rows[0];
    if (session.status !== 'pending') {
      return res.status(409).json({ success: false, error: `Session is already ${session.status}` });
    }
    if (new Date(session.consent_expires_at).getTime() < Date.now()) {
      await pool.query(`UPDATE cc_remote_access_sessions SET status = 'expired' WHERE id = $1`, [req.params.id]);
      return res.status(410).json({ success: false, error: 'Remote access approval expired' });
    }
    if (hashToken(approval_token) !== session.approval_token_hash) {
      return res.status(403).json({ success: false, error: 'Invalid approval token' });
    }

    if (decision !== 'approve') {
      const rejectedAt = new Date().toISOString();
      await pool.query(`
        UPDATE cc_remote_access_sessions SET status = 'rejected', rejected_at = $1 WHERE id = $2
      `, [rejectedAt, req.params.id]);
      return res.json({ success: true, status: 'rejected' });
    }

    const sessionToken = crypto.randomBytes(32).toString('hex');
    const approvedAt = new Date().toISOString();
    const result = await pool.query(`
      UPDATE cc_remote_access_sessions
      SET status = 'approved', approved_at = $1, session_token_hash = $2, connection_info_json = $3, last_seen_at = $1
      WHERE id = $4
      RETURNING id, installation_uuid, access_mode, status, expires_at
    `, [approvedAt, hashToken(sessionToken), safeJson(connection_info), req.params.id]);

    res.json({
      success: true,
      status: 'approved',
      session: result.rows[0],
      session_token: sessionToken
    });
  } catch (error) {
    console.error('Error processing remote access response:', error);
    return serverError(res, 'Request failed', error);
  }
});

async function saveClient(req, res, idOverride = null) {
  try {
    const id = idOverride ?? req.body.id;
    const name = req.body.name;
    const nit = req.body.nit;
    const city = req.body.city;
    const country = req.body.country;
    const status = normalizeLicenseStatus(req.body.status || 'active');
    const plan = req.body.plan;
    const contractValueMinor = moneyFromBody(req.body, {
      minorKeys: ['contract_value_minor', 'contractValueMinor'],
      majorKeys: ['contract_value', 'contractValue'],
      field: 'contract_value',
    });
    const contractValue = minorToLegacyNumber(contractValueMinor);
    const renewalDate = req.body.renewalDate ?? req.body.renewal_date;
    const usageScore = req.body.usageScore ?? req.body.usage_score ?? 0;
    const resellerId = req.body.resellerId ?? req.body.reseller_id ?? null;
    const taxRate = req.body.taxRate ?? req.body.tax_rate ?? 19.0;
    const billingType = req.body.billingType ?? req.body.billing_type ?? 'mensual';
    const billingDay = req.body.billingDay ?? req.body.billing_day ?? 5;
    const notes = req.body.notes ?? '';
    const contactName = req.body.contactName ?? req.body.contact_name ?? '';
    const contactPhone = req.body.contactPhone ?? req.body.contact_phone ?? '';
    const contactEmail = req.body.contactEmail ?? req.body.contact_email ?? '';
    const contactRole = req.body.contactRole ?? req.body.contact_role ?? '';
    const password = req.body.password ?? req.body.client_password ?? '';
    const licenseType = req.body.licenseType ?? req.body.license_type ?? 'SUSCRIPCION';
    const subscriptionMonths = req.body.subscriptionMonths ?? req.body.subscription_months ?? 12;
    const productFamily = normalizeProductFamily(req.body.productFamily ?? req.body.product_family ?? 'COMMERCIAL');

    if (!name || !plan || !renewalDate) return publicError(res, 400, 'name, plan and renewal_date are required');
    if (contactEmail) {
      const duplicateEmail = await pool.query(
        `SELECT id FROM cc_clients WHERE LOWER(contact_email)=LOWER($1) AND ($2::int IS NULL OR id<>$2::int) LIMIT 1`,
        [String(contactEmail).trim(), id ? Number(id) : null],
      );
      if (duplicateEmail.rowCount > 0) return publicError(res, 409, 'A client already uses this contact email');
    }
    if (nit) {
      const duplicateNit = await pool.query(
        `SELECT id FROM cc_clients WHERE LOWER(nit)=LOWER($1) AND ($2::int IS NULL OR id<>$2::int) LIMIT 1`,
        [String(nit).trim(), id ? Number(id) : null],
      );
      if (duplicateNit.rowCount > 0) return publicError(res, 409, 'A client already uses this NIT');
    }
    const passwordHash = password ? await bcrypt.hash(String(password), 12) : null;

    if (id) {
      // Actualizar cliente existente
      const existing = await pool.query('SELECT client_password,status FROM cc_clients WHERE id = $1', [id]);
      if (existing.rowCount === 0) {
        return res.status(404).json({ success: false, error: 'Client not found' });
      }
      const existingStatus = normalizeLicenseStatus(existing.rows[0].status);
      if (status !== existingStatus) {
        return publicError(res, 409, 'Use the client lifecycle endpoint to change status');
      }
      const storedPassword = passwordHash || existing.rows[0].client_password || null;
      const result = await pool.query(
        `UPDATE cc_clients SET name = $1, nit = $2, city = $3, country = $4, status = $5, plan = $6,
         contract_value = $7, contract_value_minor = $8, renewal_date = $9, usage_score = $10, reseller_id = $11, tax_rate = $12,
         billing_type = $13, billing_day = $14, notes = $15, contact_name = $16, contact_phone = $17,
         contact_email = $18, contact_role = $19, client_password = $20, license_type = $21, subscription_months = $22, updated_at = NOW() WHERE id = $23
         RETURNING *`,
        [name, nit, city, country, status, plan, contractValue, contractValueMinor, renewalDate, usageScore, resellerId, taxRate, billingType, billingDay, notes, contactName, contactPhone, contactEmail, contactRole, storedPassword, licenseType, subscriptionMonths, id]
      );
      await pool.query('UPDATE cc_clients SET product_family=$1 WHERE id=$2', [productFamily, id]);
      const { client_password, ...client } = result.rows[0];
      client.product_family = productFamily;
      res.json({ success: true, message: 'Client updated', client });
    } else {
      // Crear nuevo cliente
      const result = await pool.query(
        `INSERT INTO cc_clients (name, nit, city, country, status, plan, contract_value, contract_value_minor, renewal_date,
         usage_score, created_at, reseller_id, tax_rate, billing_type, billing_day, notes,
         contact_name, contact_phone, contact_email, contact_role, client_password, license_type, subscription_months)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
         RETURNING *`,
        [name, nit, city, country, status, plan, contractValue, contractValueMinor, renewalDate, usageScore, new Date().toISOString(), resellerId, taxRate, billingType, billingDay, notes, contactName, contactPhone, contactEmail, contactRole, passwordHash, licenseType, subscriptionMonths]
      );
      await pool.query('UPDATE cc_clients SET product_family=$1 WHERE id=$2', [productFamily, result.rows[0].id]);
      const { client_password, ...client } = result.rows[0];
      client.product_family = productFamily;
      res.json({ success: true, message: 'Client created', id: client.id, client });
    }
  } catch (error) {
    console.error('Error saving client:', error);
    return serverError(res, 'Request failed', error);
  }
}

// POST /api/v1/clients - Crear o actualizar cliente
app.post('/api/v1/clients', validateAdminAuth, requirePermission('crm:write'), async (req, res) => {
  await saveClient(req, res);
});

app.put('/api/v1/clients/:id', validateAdminAuth, requirePermission('crm:write'), async (req, res) => {
  await saveClient(req, res, req.params.id);
});

function sanitizeLicenseRow(row) {
  if (!row) return row;
  const { offline_token, ...safe } = row;
  return safe;
}

async function saveLicense(req, res, idOverride = null) {
  try {
    const id = idOverride ?? req.body.id;
    const clientId = req.body.clientId ?? req.body.client_id;
    let type = req.body.type;
    const status = normalizeLicenseStatus(req.body.status ?? 'active');
    const expiresAt = req.body.expiresAt ?? req.body.expires_at;
    let maxUsers = req.body.maxUsers ?? req.body.max_users ?? 1;
    let maxDevices = req.body.maxDevices ?? req.body.max_devices ?? 1;
    let maxBranches = req.body.maxBranches ?? req.body.max_branches ?? 1;
    let requestedFamily = req.body.productFamily ?? req.body.product_family ?? 'COMMERCIAL';
    const defaultModules = normalizeProductFamily(requestedFamily) === 'PUBLIC'
      ? 'presupuesto_publico,contabilidad_nicsp,contratacion_publica,nomina_publica,sgdea_publico,transparencia,regalias,sgp,siif,salud_publica'
      : 'sales,purchases,inventory,cash,accounting,reports';
    let modulesList = parseModules(req.body.modules ?? defaultModules);
    let modules = modulesList.join(',');
    let productFamily = normalizeProductFamily(requestedFamily, modulesList);
    const requestedPlanKey = String(req.body.planKey ?? req.body.plan_key ?? '').trim().toUpperCase();
    let planKey = requestedPlanKey || null;
    if (planKey) {
      const plan = (await pool.query('SELECT * FROM cc_plans WHERE plan_key=$1 AND active=1 LIMIT 1', [planKey])).rows[0];
      if (!plan) return publicError(res, 409, 'The selected plan is not active');
      const limits = safeParseJson(plan.limits_json, {});
      const planModules = safeParseJson(plan.modules_json, []);
      if (!limits || typeof limits !== 'object' || Array.isArray(limits) || !Array.isArray(planModules)) {
        return publicError(res, 500, 'The selected plan has an invalid catalog configuration');
      }
      type = String(plan.name);
      maxUsers = Number(limits.users || 1);
      maxDevices = Number(limits.devices || 1);
      maxBranches = Number(limits.branches || 1);
      modulesList = parseModules(planModules);
      modules = modulesList.join(',');
      requestedFamily = plan.product_family;
      productFamily = normalizeProductFamily(plan.product_family, modulesList);
    }
    const tokenHint = req.body.tokenHint ?? req.body.token_hint ?? null;
    const updatedAt = req.body.updatedAt ?? req.body.updated_at ?? new Date().toISOString();
    const licenseType = normalizeLicenseType(req.body.licenseType ?? req.body.license_type ?? 'SUSCRIPCION');
    const hardwareFingerprint = req.body.hardwareFingerprint ?? req.body.hardware_fingerprint ?? null;
    const activationCount = req.body.activationCount ?? req.body.activation_count ?? 0;
    const lastHeartbeat = req.body.lastHeartbeat ?? req.body.last_heartbeat ?? null;
    const gracePeriodEnd = req.body.gracePeriodEnd ?? req.body.grace_period_end ?? null;

    if (!clientId || !type || !expiresAt) {
      return res.status(400).json({ success: false, error: 'client_id, type and expires_at are required' });
    }
    if (!Number.isInteger(Number(clientId)) || Number(clientId) <= 0) {
      return publicError(res, 400, 'Invalid client_id');
    }
    if (!Number.isInteger(Number(maxDevices)) || Number(maxDevices) < 1 || Number(maxDevices) > 1000) {
      return publicError(res, 400, 'max_devices must be between 1 and 1000');
    }
    if (!Number.isInteger(Number(maxUsers)) || Number(maxUsers) < 1 || Number(maxUsers) > 10000) {
      return publicError(res, 400, 'max_users must be between 1 and 10000');
    }
    if (!Number.isInteger(Number(maxBranches)) || Number(maxBranches) < 1 || Number(maxBranches) > 10000) {
      return publicError(res, 400, 'max_branches must be between 1 and 10000');
    }
    if (Number.isNaN(Date.parse(expiresAt))) return publicError(res, 400, 'Invalid expires_at');

    if (id) {
      const existingLicense = await pool.query('SELECT status,plan_key FROM cc_licenses WHERE id=$1 LIMIT 1', [id]);
      if (!existingLicense.rows[0]) return publicError(res, 404, 'License not found');
      planKey ??= existingLicense.rows[0].plan_key || null;
      const existingStatus = normalizeLicenseStatus(existingLicense.rows[0].status);
      if (existingStatus === 'revoked' && status !== 'revoked') {
        return publicError(res, 409, 'A revoked license is immutable; issue a new license instead');
      }
      if (status !== existingStatus) {
        return publicError(res, 409, 'Use the license lifecycle endpoint to change status');
      }
      const usage = await pool.query(
        `SELECT COUNT(*)::int AS count FROM (
           SELECT hardware_fingerprint FROM cc_installations
           WHERE license_id=$1 AND COALESCE(blocked,0)=0 AND hardware_fingerprint IS NOT NULL
           UNION
           SELECT hardware_fingerprint FROM cc_offline_activations
           WHERE license_id=$1 AND revoked_at IS NULL AND expires_at::timestamptz > NOW()
         ) devices`,
        [id],
      );
      const usedDevices = Number(usage.rows[0]?.count || 0);
      if (Number(maxDevices) < usedDevices) {
        return publicError(res, 409, `max_devices cannot be lower than the ${usedDevices} currently active device(s)`);
      }
      const result = await pool.query(
        `UPDATE cc_licenses SET client_id = $1, type = $2, status = $3, expires_at = $4,
         max_users = $5, max_devices = $6, max_branches = $7, modules = $8, token_hint = $9,
         updated_at = $10, license_type = $11, hardware_fingerprint = $12, offline_token = NULL,
         activation_count = $13, last_heartbeat = $14, grace_period_end = $15, product_family = $16,
         plan_key = $17
         WHERE id = $18 RETURNING *`,
        [clientId, type, status, expiresAt, maxUsers, maxDevices, maxBranches, modules, tokenHint, updatedAt, licenseType, hardwareFingerprint, activationCount, lastHeartbeat, gracePeriodEnd, productFamily, planKey, id]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ success: false, error: 'License not found' });
      }
      // Propagate signed license/module changes to already provisioned clients.
      // Failures are non-fatal because offline installations can refresh on the
      // next validation/bootstrap cycle.
      if (['active','trial'].includes(status)) {
        const installs = await pool.query(`SELECT uuid FROM cc_installations WHERE license_id=$1 AND COALESCE(blocked,0)=0 ORDER BY id LIMIT 200`, [id]);
        for (const row of installs.rows) {
          await queueSignedCommand({
            installationUuid: row.uuid,
            action: 'actualizar_licencia',
            params: { reason: 'license_record_updated' },
            priority: 'alta',
            title: 'Actualizar licencia firmada',
            executedBy: req.user?.username || 'admin',
          }).catch(() => {});
        }
      }
      return res.json({ success: true, license: sanitizeLicenseRow(result.rows[0]) });
    }

    const result = await pool.query(
      `INSERT INTO cc_licenses (client_id, type, status, expires_at, max_users, max_devices,
       max_branches, modules, token_hint, updated_at, license_type, hardware_fingerprint,
       offline_token, activation_count, last_heartbeat, grace_period_end, product_family, plan_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, $13, $14, $15, $16, $17)
       RETURNING *`,
      [clientId, type, status, expiresAt, maxUsers, maxDevices, maxBranches, modules, tokenHint, updatedAt, licenseType, hardwareFingerprint, activationCount, lastHeartbeat, gracePeriodEnd, productFamily, planKey]
    );
    res.json({ success: true, id: result.rows[0].id, license: sanitizeLicenseRow(result.rows[0]) });
  } catch (error) {
    console.error('Error saving license:', error);
    return serverError(res, 'Request failed', error);
  }
}

app.get('/api/v1/licenses', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cc_licenses ORDER BY id DESC');
    res.json({ success: true, licenses: result.rows.map(sanitizeLicenseRow) });
  } catch (error) {
    console.error('Error fetching licenses:', error);
    return serverError(res, 'Request failed', error);
  }
});

app.get('/api/v1/licenses/:id', validateAdminAuth, requirePermission('read'), async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    const result = await pool.query('SELECT * FROM cc_licenses WHERE id=$1 LIMIT 1', [req.params.id]);
    if (!result.rows[0]) return publicError(res, 404, 'License not found');
    return res.json({ success: true, license: sanitizeLicenseRow(result.rows[0]) });
  } catch (error) { return serverError(res, 'Get license error', error); }
});

app.get('/api/v1/licenses/client/:clientId', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cc_licenses WHERE client_id = $1 ORDER BY id DESC', [req.params.clientId]);
    res.json({ success: true, licenses: result.rows.map(sanitizeLicenseRow) });
  } catch (error) {
    console.error('Error fetching client licenses:', error);
    return serverError(res, 'Request failed', error);
  }
});

app.post('/api/v1/licenses', validateAdminAuth, requirePermission('licenses:write'), async (req, res) => {
  await saveLicense(req, res);
});

app.put('/api/v1/licenses/:id', validateAdminAuth, requirePermission('licenses:write'), async (req, res) => {
  await saveLicense(req, res, req.params.id);
});

app.delete('/api/v1/licenses/:id', validateAdminAuth, requirePermission('licenses:write'), async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return publicError(res, 400, 'Invalid license id');
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const result = await tx.query(
      `UPDATE cc_licenses SET status='revoked', status_reason=COALESCE(NULLIF($2,''),'Revocada desde Control Center'), revoked_at=COALESCE(revoked_at,NOW()), offline_token=NULL, updated_at=NOW() WHERE id=$1 RETURNING id`,
      [id, String(req.body?.reason || req.query?.reason || '')],
    );
    if (result.rowCount === 0) {
      await tx.query('ROLLBACK');
      return publicError(res, 404, 'License not found');
    }
    await tx.query(
      `UPDATE cc_installations SET blocked=1, block_reason='Licencia revocada', status='blocked', connected=0, updated_at=NOW() WHERE license_id=$1`,
      [id],
    );
    await tx.query(
      `UPDATE cc_offline_activations SET revoked_at=COALESCE(revoked_at,CURRENT_TIMESTAMP::text), revoked_reason=COALESCE(revoked_reason,'Licencia revocada') WHERE license_id=$1`,
      [id],
    );
    await tx.query('COMMIT');
    return res.json({ success: true, id, status: 'revoked' });
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => {});
    return serverError(res, 'License revocation failed', error);
  } finally {
    tx.release();
  }
});

// GET /api/v1/tickets - Obtener todos los tickets
app.post('/api/v1/licenses/:id/revoke-device', validateAdminAuth, requirePermission('licenses:write'), async (req, res) => {
  const licenseId = Number.parseInt(req.params.id, 10);
  const fingerprint = String(req.body?.hardware_fingerprint || '').trim();
  const reason = String(req.body?.reason || 'Revocada desde Control Center').trim().slice(0, 500);
  if (!Number.isInteger(licenseId) || licenseId <= 0 || !fingerprint) return publicError(res, 400, 'license id and hardware_fingerprint are required');
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const license = await tx.query('SELECT id FROM cc_licenses WHERE id=$1 FOR UPDATE', [licenseId]);
    if (!license.rows[0]) { await tx.query('ROLLBACK'); return publicError(res, 404, 'License not found'); }
    const now = new Date().toISOString();
    await tx.query(
      `INSERT INTO cc_license_revocations(license_id,hardware_fingerprint,reason,revoked_at) VALUES($1,$2,$3,$4)
       ON CONFLICT (license_id,hardware_fingerprint) DO UPDATE SET reason=EXCLUDED.reason, revoked_at=EXCLUDED.revoked_at`,
      [licenseId, fingerprint, reason, now],
    );
    await tx.query(
      `UPDATE cc_installations SET blocked=1, block_reason=$1, license_status='suspended', updated_at=$2
       WHERE license_id=$3 AND hardware_fingerprint=$4`,
      [reason, now, licenseId, fingerprint],
    );
    await tx.query(
      `UPDATE cc_offline_activations SET revoked_at=$1 WHERE license_id=$2 AND hardware_fingerprint=$3 AND revoked_at IS NULL`,
      [now, licenseId, fingerprint],
    );
    await tx.query('COMMIT');
    return res.json({ success: true, revoked: true });
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => {});
    return serverError(res, 'Revoke device error', error);
  } finally { tx.release(); }
});

app.post('/api/v1/licenses/:id/unrevoke-device', validateAdminAuth, requirePermission('licenses:write'), async (req, res) => {
  const licenseId = Number.parseInt(req.params.id, 10);
  const fingerprint = String(req.body?.hardware_fingerprint || '').trim();
  if (!Number.isInteger(licenseId) || licenseId <= 0 || !fingerprint) return publicError(res, 400, 'license id and hardware_fingerprint are required');
  try {
    await pool.query('DELETE FROM cc_license_revocations WHERE license_id=$1 AND hardware_fingerprint=$2', [licenseId, fingerprint]);
    await pool.query(
      `UPDATE cc_installations SET blocked=0, block_reason=NULL, license_status='active', updated_at=$1
       WHERE license_id=$2 AND hardware_fingerprint=$3`,
      [new Date().toISOString(), licenseId, fingerprint],
    );
    return res.json({ success: true, revoked: false });
  } catch (error) { return serverError(res, 'Unrevoke device error', error); }
});

app.get('/api/v1/licenses/offline-public-key', (req, res) => {
  try {
    const key = publisherPublicKey();
    return res.json({
      success: true,
      algorithm: 'RS256',
      public_key_pem: key,
      key_id: CLIENT_PINNED_PUBLIC_KEY_SHA256,
      fingerprint_sha256: publicKeyFingerprint(key),
    });
  } catch (_) {
    return publicError(res, 503, 'Publisher signing is not configured');
  }
});

app.post('/api/v1/licenses/:id/offline-token', validateAdminAuth, requirePermission('licenses:write'), async (req, res) => {
  const tx = await pool.connect();
  try {
    const licenseId = Number.parseInt(req.params.id, 10);
    const hardwareFingerprint = String(req.body?.hardware_fingerprint || '').trim();
    if (!Number.isInteger(licenseId) || licenseId <= 0 || hardwareFingerprint.length < 8 || hardwareFingerprint.length > 512) {
      return publicError(res, 400, 'Invalid license or hardware fingerprint');
    }
    await tx.query('BEGIN');
    const result = await tx.query(
      `SELECT l.*, c.contact_email, c.name AS client_name
       FROM cc_licenses l JOIN cc_clients c ON c.id=l.client_id
       WHERE l.id=$1 FOR UPDATE OF l`,
      [licenseId],
    );
    const license = result.rows[0];
    if (!license) {
      await tx.query('ROLLBACK');
      return publicError(res, 404, 'License not found');
    }
    const status = normalizeLicenseStatus(license.status);
    if (!['active','trial'].includes(status)) {
      await tx.query('ROLLBACK');
      return publicError(res, 409, 'License is not active');
    }
    const expires = new Date(license.expires_at);
    if (Number.isNaN(expires.getTime()) || expires <= new Date()) {
      await tx.query('ROLLBACK');
      return publicError(res, 409, 'License is expired');
    }
    const revoked = await tx.query(
      `SELECT 1 FROM cc_license_revocations WHERE license_id=$1 AND hardware_fingerprint=$2 LIMIT 1`,
      [licenseId, hardwareFingerprint],
    );
    if (revoked.rowCount > 0) {
      await tx.query('ROLLBACK');
      return publicError(res, 409, 'This device is revoked for the license');
    }

    const current = await tx.query(
      `SELECT 1 FROM cc_offline_activations
       WHERE license_id=$1 AND hardware_fingerprint=$2 AND revoked_at IS NULL
       LIMIT 1`,
      [licenseId, hardwareFingerprint],
    );
    const usedResult = await tx.query(
      `SELECT COUNT(DISTINCT hardware_fingerprint)::int AS count
       FROM (
         SELECT hardware_fingerprint FROM cc_installations
          WHERE license_id=$1 AND COALESCE(blocked,0)=0 AND hardware_fingerprint IS NOT NULL
         UNION
         SELECT hardware_fingerprint FROM cc_offline_activations
          WHERE license_id=$1 AND revoked_at IS NULL AND expires_at::timestamptz > NOW()
       ) devices`,
      [licenseId],
    );
    const used = Number(usedResult.rows[0]?.count || 0);
    const maxDevices = Math.max(1, Number(license.max_devices || 1));
    if (current.rowCount === 0 && used >= maxDevices) {
      await tx.query('ROLLBACK');
      return publicError(res, 409, `Device limit reached (${used}/${maxDevices})`);
    }

    const jti = crypto.randomUUID();
    const issuedAt = new Date();
    const modules = parseModules(license.modules);
    const productFamily = normalizeProductFamily(license.product_family, modules);
    const payload = {
      token_type: 'license',
      hfp: hardwareFingerprint,
      lt: normalizeLicenseType(license.license_type),
      st: publisherStatus(status),
      ed: expires.toISOString(),
      md: modules,
      pf: productFamily,
      license_id: String(license.id),
      client_id: String(license.client_id),
      client_name: license.client_name,
      hardware_fingerprint: hardwareFingerprint,
      license_type: normalizeLicenseType(license.license_type),
      status: publisherStatus(status),
      expiry_date: expires.toISOString(),
      modules,
      product_family: productFamily,
    };
    const token = signOfflineLicense(payload, {
      subject: `license:${license.id}`,
      jwtid: jti,
      expiresIn: Math.max(60, Math.floor((expires.getTime() - issuedAt.getTime()) / 1000)),
    });
    await tx.query(
      `INSERT INTO cc_offline_activations
        (license_id,hardware_fingerprint,token_hash,token_jti,issued_at,expires_at,revoked_at)
       VALUES($1,$2,$3,$4,$5,$6,NULL)
       ON CONFLICT (license_id,hardware_fingerprint) DO UPDATE SET
         token_hash=EXCLUDED.token_hash,
         token_jti=EXCLUDED.token_jti,
         issued_at=EXCLUDED.issued_at,
         expires_at=EXCLUDED.expires_at,
         revoked_at=NULL`,
      [licenseId, hardwareFingerprint, hashToken(token), jti, issuedAt.toISOString(), expires.toISOString()],
    );
    await tx.query('UPDATE cc_licenses SET updated_at=$1 WHERE id=$2', [issuedAt.toISOString(), licenseId]);
    await tx.query('COMMIT');
    return res.json({ success: true, token, algorithm: 'RS256', public_key_id: CLIENT_PINNED_PUBLIC_KEY_SHA256, expires_at: payload.ed, product_family: productFamily });
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => {});
    if (error.statusCode) return publicError(res, error.statusCode, error.message);
    return serverError(res, 'Offline token generation failed', error);
  } finally {
    tx.release();
  }
});

app.get('/api/v1/tickets', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cc_tickets ORDER BY updated_at DESC');
    res.json({ success: true, tickets: result.rows });
  } catch (error) {
    console.error('Error fetching tickets:', error);
    return serverError(res, 'Request failed', error);
  }
});

app.get('/api/v1/tickets/:id', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cc_tickets WHERE id=$1 LIMIT 1', [req.params.id]);
    if (!result.rows[0]) return publicError(res, 404, 'Ticket not found');
    return res.json({ success: true, ticket: result.rows[0] });
  } catch (error) { return serverError(res, 'Get ticket error', error); }
});

app.post('/api/v1/tickets', validateAdminAuth, requirePermission('tickets:write'), async (req, res) => {
  try {
    const { client_id, title, description, category, priority, status, assigned_to, created_at, updated_at, sla_hours, escalated_level } = req.body;
    const result = await pool.query(`
      INSERT INTO cc_tickets (client_id, title, description, category, priority, status, assigned_to, created_at, updated_at, sla_hours, escalated_level)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id
    `, [client_id ?? null, title, description || '', category || 'Soporte', priority || 'media', status || 'nuevo', assigned_to || null, created_at || new Date().toISOString(), updated_at || new Date().toISOString(), sla_hours ?? null, escalated_level ?? null]);
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    console.error('Error creating ticket:', error);
    return serverError(res, 'Request failed', error);
  }
});

app.put('/api/v1/tickets/:id', validateAdminAuth, requirePermission('tickets:write'), async (req, res) => {
  try {
    const { id } = req.params;
    const { client_id, title, description, category, priority, status, assigned_to, created_at, updated_at, sla_hours, escalated_level } = req.body;
    await pool.query(`
      UPDATE cc_tickets
      SET client_id = $1, title = $2, description = $3, category = $4, priority = $5, status = $6, assigned_to = $7, created_at = $8, updated_at = $9, sla_hours = $10, escalated_level = $11
      WHERE id = $12
    `, [client_id ?? null, title, description || '', category || 'Soporte', priority || 'media', status || 'nuevo', assigned_to || null, created_at || new Date().toISOString(), updated_at || new Date().toISOString(), sla_hours ?? null, escalated_level ?? null, id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating ticket:', error);
    return serverError(res, 'Request failed', error);
  }
});

app.delete('/api/v1/tickets/:id', validateAdminAuth, requirePermission('tickets:write'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM cc_tickets WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Ticket not found' });
    }
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    console.error('Error deleting ticket:', error);
    return serverError(res, 'Request failed', error);
  }
});

// GET /api/v1/clients - Obtener todos los clientes
app.get('/api/v1/clients', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, nit, city, country, status, plan, contract_value, renewal_date,
             usage_score, created_at, reseller_id, tax_rate, billing_type, billing_day,
             notes, contact_name, contact_phone, contact_email, contact_role,
             license_type, subscription_months, product_family, lifecycle_reason, archived_at, support_policy_json
      FROM cc_clients
      ORDER BY id DESC
    `);
    res.json({ success: true, clients: result.rows });
  } catch (error) {
    console.error('Error fetching clients:', error);
    return serverError(res, 'Request failed', error);
  }
});

app.get('/api/v1/clients/stats/overview', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE LOWER(status) IN ('active','activo','trial'))::int AS active,
             COUNT(*) FILTER (WHERE LOWER(status) IN ('suspended','suspendido'))::int AS suspended,
             COALESCE(SUM(contract_value),0)::numeric AS contract_value
      FROM cc_clients`);
    return res.json({ success: true, stats: result.rows[0] });
  } catch (error) { return serverError(res, 'Client stats error', error); }
});

app.get('/api/v1/clients/:id', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, nit, city, country, status, plan, contract_value, renewal_date,
             usage_score, created_at, reseller_id, tax_rate, billing_type, billing_day,
             notes, contact_name, contact_phone, contact_email, contact_role,
             license_type, subscription_months, product_family, lifecycle_reason, archived_at, support_policy_json
      FROM cc_clients
      WHERE id = $1
      LIMIT 1
    `, [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }
    res.json({ success: true, client: result.rows[0] });
  } catch (error) {
    console.error('Error fetching client:', error);
    return serverError(res, 'Request failed', error);
  }
});

app.delete('/api/v1/clients/:id', validateAdminAuth, requirePermission('crm:write'), async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return publicError(res, 400, 'Invalid client id');
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const result = await tx.query(
      `UPDATE cc_clients SET status='cancelled', lifecycle_reason=COALESCE(NULLIF($2,''),'Desactivado desde Control Center'), archived_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING id`,
      [id, String(req.body?.reason || req.query?.reason || '')],
    );
    if (result.rowCount === 0) {
      await tx.query('ROLLBACK');
      return publicError(res, 404, 'Client not found');
    }
    await tx.query(`UPDATE cc_licenses SET status='revoked', status_reason='Cliente desactivado', revoked_at=COALESCE(revoked_at,NOW()), offline_token=NULL, updated_at=NOW() WHERE client_id=$1`, [id]);
    await tx.query(
      `UPDATE cc_installations SET blocked=1, block_reason='Cliente desactivado', status='blocked', connected=0, updated_at=NOW() WHERE client_id=$1`,
      [id],
    );
    await tx.query(
      `UPDATE cc_offline_activations oa SET revoked_at=COALESCE(oa.revoked_at,CURRENT_TIMESTAMP::text), revoked_reason=COALESCE(oa.revoked_reason,'Cliente desactivado')
       FROM cc_licenses l WHERE oa.license_id=l.id AND l.client_id=$1`,
      [id],
    );
    await tx.query('COMMIT');
    return res.json({ success: true, id, status: 'cancelled' });
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => {});
    return serverError(res, 'Client deactivation failed', error);
  } finally {
    tx.release();
  }
});

app.get('/api/v1/invoices', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cc_invoices ORDER BY due_date DESC');
    res.json({ success: true, invoices: result.rows });
  } catch (error) {
    console.error('Error fetching invoices:', error);
    return serverError(res, 'Request failed', error);
  }
});

app.get('/api/v1/invoices/:id', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cc_invoices WHERE id=$1 LIMIT 1', [req.params.id]);
    if (!result.rows[0]) return publicError(res, 404, 'Invoice not found');
    return res.json({ success: true, invoice: result.rows[0] });
  } catch (error) { return serverError(res, 'Get invoice error', error); }
});

app.post('/api/v1/invoices', validateAdminAuth, requirePermission('billing:write'), async (req, res) => {
  try {
    const { client_id, invoice_number, status, due_date, paid_at, items_json } = req.body;
    const totalMinor = moneyFromBody(req.body, {
      minorKeys: ['total_minor', 'totalMinor'],
      majorKeys: ['total'],
      field: 'total',
    });
    const total = minorToLegacyNumber(totalMinor);
    const result = await pool.query(`
      INSERT INTO cc_invoices (client_id, invoice_number, status, total, total_minor, due_date, paid_at, items_json)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `, [client_id ?? null, invoice_number, status || 'borrador', total, totalMinor, due_date || new Date().toISOString(), paid_at || null, items_json || '[]']);
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    if (error.statusCode) return publicError(res, error.statusCode, error.message);
    return serverError(res, 'Error creating invoice', error);
  }
});

app.put('/api/v1/invoices/:id', validateAdminAuth, requirePermission('billing:write'), async (req, res) => {
  try {
    const { id } = req.params;
    const { client_id, invoice_number, status, due_date, paid_at, items_json } = req.body;
    const totalMinor = moneyFromBody(req.body, {
      minorKeys: ['total_minor', 'totalMinor'],
      majorKeys: ['total'],
      field: 'total',
    });
    const total = minorToLegacyNumber(totalMinor);
    const result = await pool.query(`
      UPDATE cc_invoices
      SET client_id = $1, invoice_number = $2, status = $3, total = $4, total_minor = $5,
          due_date = $6, paid_at = $7, items_json = $8
      WHERE id = $9 RETURNING id
    `, [client_id ?? null, invoice_number, status || 'borrador', total, totalMinor, due_date || new Date().toISOString(), paid_at || null, items_json || '[]', id]);
    if (!result.rows[0]) return publicError(res, 404, 'Invoice not found');
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    if (error.statusCode) return publicError(res, error.statusCode, error.message);
    return serverError(res, 'Error updating invoice', error);
  }
});

app.delete('/api/v1/invoices/:id', validateAdminAuth, requirePermission('billing:write'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE cc_invoices SET status='cancelled' WHERE id=$1 RETURNING id,status`,
      [req.params.id],
    );
    if (!result.rows[0]) return publicError(res, 404, 'Invoice not found');
    res.json({ success: true, id: result.rows[0].id, status: 'cancelled' });
  } catch (error) {
    return serverError(res, 'Error cancelling invoice', error);
  }
});

app.get('/api/v1/payments', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cc_payments ORDER BY paid_at DESC');
    res.json({ success: true, payments: result.rows });
  } catch (error) {
    console.error('Error fetching payments:', error);
    return serverError(res, 'Request failed', error);
  }
});

app.post('/api/v1/payments', validateAdminAuth, requirePermission('billing:write'), async (req, res) => {
  try {
    const { invoice_id, method, reference, receipt_path, paid_at } = req.body;
    const amountMinor = moneyFromBody(req.body, {
      minorKeys: ['amount_minor', 'amountMinor'],
      majorKeys: ['amount'],
      field: 'amount',
    });
    if (amountMinor <= 0) return publicError(res, 400, 'Payment amount must be positive');
    const amount = minorToLegacyNumber(amountMinor);
    const result = await pool.query(`
      INSERT INTO cc_payments (invoice_id, amount, amount_minor, status, method, reference, receipt_path, paid_at)
      VALUES ($1, $2, $3, 'active', $4, $5, $6, $7)
      RETURNING id
    `, [invoice_id, amount, amountMinor, method || 'Tarjeta', reference || '', receipt_path || '', paid_at || new Date().toISOString()]);
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    if (error.statusCode) return publicError(res, error.statusCode, error.message);
    return serverError(res, 'Error creating payment', error);
  }
});

app.delete('/api/v1/payments/:id', validateAdminAuth, requirePermission('billing:write'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE cc_payments
       SET status='reversed', reversed_at=$2, reversal_reason='Administrative reversal'
       WHERE id=$1 AND COALESCE(status,'active') <> 'reversed'
       RETURNING id,status`,
      [req.params.id, new Date().toISOString()],
    );
    if (!result.rows[0]) return publicError(res, 404, 'Payment not found or already reversed');
    res.json({ success: true, id: result.rows[0].id, status: 'reversed' });
  } catch (error) {
    return serverError(res, 'Error reversing payment', error);
  }
});

app.get('/api/v1/campaigns', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cc_campaigns ORDER BY scheduled_at DESC');
    res.json({ success: true, campaigns: result.rows });
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    return serverError(res, 'Request failed', error);
  }
});

app.post('/api/v1/campaigns', validateAdminAuth, requirePermission('marketing:write'), async (req, res) => {
  try {
    const { title, template, subject, target_segment, scheduled_at, status, sent_count, opened_count, clicked_count } = req.body;
    const result = await pool.query(`
      INSERT INTO cc_campaigns (title, template, subject, target_segment, scheduled_at, status, sent_count, opened_count, clicked_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [title, template || '', subject || '', target_segment || 'Todos', scheduled_at || null, status || 'draft', sent_count || 0, opened_count || 0, clicked_count || 0]);
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    console.error('Error creating campaign:', error);
    return serverError(res, 'Request failed', error);
  }
});

app.put('/api/v1/campaigns/:id', validateAdminAuth, requirePermission('marketing:write'), async (req, res) => {
  try {
    const { id } = req.params;
    const { title, template, subject, target_segment, scheduled_at, status, sent_count, opened_count, clicked_count } = req.body;
    await pool.query(`
      UPDATE cc_campaigns
      SET title = $1, template = $2, subject = $3, target_segment = $4, scheduled_at = $5, status = $6, sent_count = $7, opened_count = $8, clicked_count = $9
      WHERE id = $10
    `, [title, template || '', subject || '', target_segment || 'Todos', scheduled_at || null, status || 'draft', sent_count || 0, opened_count || 0, clicked_count || 0, id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating campaign:', error);
    return serverError(res, 'Request failed', error);
  }
});

app.delete('/api/v1/campaigns/:id', validateAdminAuth, requirePermission('marketing:write'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM cc_campaigns WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    console.error('Error deleting campaign:', error);
    return serverError(res, 'Request failed', error);
  }
});

app.get('/api/v1/leads', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cc_leads ORDER BY created_at DESC');
    res.json({ success: true, leads: result.rows });
  } catch (error) {
    console.error('Error fetching leads:', error);
    return serverError(res, 'Request failed', error);
  }
});

app.get('/api/v1/leads/:id', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cc_leads WHERE id=$1 LIMIT 1', [req.params.id]);
    if (!result.rows[0]) return publicError(res, 404, 'Lead not found');
    return res.json({ success: true, lead: result.rows[0] });
  } catch (error) { return serverError(res, 'Get lead error', error); }
});

app.post('/api/v1/leads', validateAdminAuth, requirePermission('crm:write'), async (req, res) => {
  try {
    const { name, stage, value, next_action_at, created_at, contact_name, contact_phone, contact_email, source, probability } = req.body;
    const result = await pool.query(`
      INSERT INTO cc_leads (name, stage, value, next_action_at, created_at, contact_name, contact_phone, contact_email, source, probability)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `, [name, stage || 'Lead', value || 0, next_action_at || null, created_at || new Date().toISOString(), contact_name || '', contact_phone || '', contact_email || '', source || 'Web', probability || 20]);
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    console.error('Error creating lead:', error);
    return serverError(res, 'Request failed', error);
  }
});

app.put('/api/v1/leads/:id', validateAdminAuth, requirePermission('crm:write'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, stage, value, next_action_at, created_at, contact_name, contact_phone, contact_email, source, probability } = req.body;
    const result = await pool.query(`
      UPDATE cc_leads
      SET name = $1, stage = $2, value = $3, next_action_at = $4, created_at = $5,
          contact_name = $6, contact_phone = $7, contact_email = $8, source = $9, probability = $10
      WHERE id = $11
      RETURNING id
    `, [name, stage || 'Lead', value || 0, next_action_at || null, created_at || new Date().toISOString(), contact_name || '', contact_phone || '', contact_email || '', source || 'Web', probability || 20, id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    console.error('Error updating lead:', error);
    return serverError(res, 'Request failed', error);
  }
});

app.delete('/api/v1/leads/:id', validateAdminAuth, requirePermission('crm:write'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM cc_leads WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    console.error('Error deleting lead:', error);
    return serverError(res, 'Request failed', error);
  }
});



app.post('/api/v1/commands', validateAdminAuth, requirePermission('commands:write'), async (req, res) => {
  try {
    const installationUuid = String(req.body?.installationId || req.body?.installation_uuid || '').trim();
    const action = String(req.body?.action || req.body?.command || '').trim();
    const parameters = req.body?.parameters ?? req.body?.params ?? req.body?.payload ?? {};
    if (!installationUuid || !action) return publicError(res, 400, 'installationId and action are required');
    const command = await queueSignedCommand({
      installationUuid,
      action,
      params: parameters && typeof parameters === 'object' && !Array.isArray(parameters) ? parameters : {},
      priority: String(req.body?.priority || 'alta'),
      title: req.body?.title == null ? action : String(req.body.title),
      executedBy: req.user?.username || 'admin',
    });

    if (action === 'bloquear_instalacion') {
      const reason = String(parameters?.reason || parameters?.motivo || 'Bloqueada desde Control Center').slice(0, 500);
      const blocked = await pool.query(
        `UPDATE cc_installations SET blocked=1, block_reason=$1, license_status='suspended', updated_at=$2
         WHERE uuid=$3 RETURNING license_id, hardware_fingerprint`,
        [reason, new Date().toISOString(), installationUuid],
      );
      const binding = blocked.rows[0];
      if (binding?.license_id && binding?.hardware_fingerprint) {
        await pool.query(
          `INSERT INTO cc_license_revocations(license_id,hardware_fingerprint,reason,revoked_at)
           VALUES($1,$2,$3,$4) ON CONFLICT (license_id,hardware_fingerprint)
           DO UPDATE SET reason=EXCLUDED.reason, revoked_at=EXCLUDED.revoked_at`,
          [binding.license_id, binding.hardware_fingerprint, reason, new Date().toISOString()],
        );
        await pool.query(
          `UPDATE cc_offline_activations SET revoked_at=$1 WHERE license_id=$2 AND hardware_fingerprint=$3 AND revoked_at IS NULL`,
          [new Date().toISOString(), binding.license_id, binding.hardware_fingerprint],
        );
      }
    } else if (action === 'activar_instalacion') {
      await pool.query(
        `UPDATE cc_installations SET blocked=0, block_reason=NULL, license_status='active', updated_at=$1 WHERE uuid=$2`,
        [new Date().toISOString(), installationUuid],
      );
    }
    return res.status(201).json({ success: true, command, id: command.id });
  } catch (error) {
    if (error.statusCode) return publicError(res, error.statusCode, error.message);
    return serverError(res, 'Create command error', error);
  }
});

// ─── STRUCTURED ADMIN DATA API ────────────────────────────────────────────────
// The Desktop previously sent arbitrary SQL to the server. That interface is
// intentionally gone. These endpoints expose only allow-listed tables,
// identifiers and simple predicates; values always remain parameterized.
const ADMIN_DATA_TABLE_PERMISSIONS = Object.freeze({
  cc_resellers: 'crm:write',
  cc_clients: 'crm:write',
  cc_leads: 'crm:write',
  cc_licenses: 'licenses:write',
  cc_installations: 'licenses:write',
  cc_tickets: 'tickets:write',
  cc_releases: 'admin',
  cc_backups: 'admin',
  cc_invoices: 'billing:write',
  cc_payments: 'billing:write',
  cc_chat_messages: 'tickets:write',
  cc_articles: 'tickets:write',
  cc_alerts: 'tickets:write',
  cc_campaigns: 'marketing:write',
  cc_telemetry: 'admin',
  cc_audit: 'admin',
  cc_commands: 'commands:write',
  cc_license_revocations: 'licenses:write',
  cc_offline_activations: 'licenses:write',
  cc_sync_hub_log: 'admin',
  cc_consolidated_analytics: 'admin',
  cc_settings: 'admin',
});

const ADMIN_DATA_READ_TABLES = new Set(Object.keys(ADMIN_DATA_TABLE_PERMISSIONS));
// Hard deletion is deliberately exceptional. Core commercial, licensing,
// billing, command and audit records use dedicated lifecycle endpoints or
// append-only semantics instead of generic DELETE.
const ADMIN_DATA_HARD_DELETE_TABLES = new Set(['cc_articles', 'cc_sync_hub_log']);
const ADMIN_DATA_SENSITIVE_COLUMNS = new Set([
  'password', 'password_hash', 'client_password', 'postgres_password',
  'two_factor_secret', 'token', 'token_hash', 'offline_token', 'approval_token', 'session_token',
  'command_secret',
]);

function assertSimpleIdentifier(value, label = 'identifier') {
  if (typeof value !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    const error = new Error(`Invalid ${label}`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

async function tableColumnSet(table) {
  const result = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  if (result.rowCount === 0) {
    const error = new Error('Unknown admin data table');
    error.statusCode = 400;
    throw error;
  }
  return new Set(result.rows.map((row) => row.column_name));
}

function ensureAllowedTable(table) {
  assertSimpleIdentifier(table, 'table');
  if (!ADMIN_DATA_READ_TABLES.has(table)) {
    const error = new Error('Table is not available through the admin data API');
    error.statusCode = 403;
    throw error;
  }
}

function enforceTableWritePermission(req, table) {
  if (table === 'cc_commands') {
    const error = new Error('Commands must be created through the signed command API');
    error.statusCode = 409;
    throw error;
  }
  const permission = ADMIN_DATA_TABLE_PERMISSIONS[table];
  if (permission === 'admin') {
    if (!roleAtLeast(req.user?.role, 'admin')) {
      const error = new Error('Insufficient permissions');
      error.statusCode = 403;
      throw error;
    }
    return;
  }
  if (!roleHasPermission(req.user?.role, permission)) {
    const error = new Error('Insufficient permissions');
    error.statusCode = 403;
    throw error;
  }
}

function buildSimpleWhere(where, whereArgs, columns, startingIndex = 1) {
  if (!where) return { sql: '', values: [], nextIndex: startingIndex };
  if (typeof where !== 'string' || where.length > 500) {
    const error = new Error('Invalid filter');
    error.statusCode = 400;
    throw error;
  }
  const parts = where.split(/\s+AND\s+/i);
  const values = Array.isArray(whereArgs) ? whereArgs : [];
  if (parts.length !== values.length) {
    const error = new Error('Filter argument count mismatch');
    error.statusCode = 400;
    throw error;
  }
  let index = startingIndex;
  const clauses = parts.map((part) => {
    const match = part.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(=|!=|<>|<=|>=|<|>)\s*\?$/);
    if (!match || !columns.has(match[1])) {
      const error = new Error('Unsupported filter expression');
      error.statusCode = 400;
      throw error;
    }
    const op = match[2] === '!=' ? '<>' : match[2];
    return `${pgIdentifier(match[1])} ${op} $${index++}`;
  });
  return { sql: ` WHERE ${clauses.join(' AND ')}`, values, nextIndex: index };
}

function buildSafeOrderBy(orderBy, columns) {
  if (!orderBy) return '';
  if (typeof orderBy !== 'string' || orderBy.length > 200) {
    const error = new Error('Invalid order');
    error.statusCode = 400;
    throw error;
  }
  const terms = orderBy.split(',').map((term) => {
    const match = term.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(ASC|DESC))?$/i);
    if (!match || !columns.has(match[1])) {
      const error = new Error('Unsupported order expression');
      error.statusCode = 400;
      throw error;
    }
    return `${pgIdentifier(match[1])} ${(match[2] || 'ASC').toUpperCase()}`;
  });
  return ` ORDER BY ${terms.join(', ')}`;
}

function visibleColumns(columns, requested) {
  if (Array.isArray(requested) && requested.length > 0) {
    return requested.map((column) => {
      assertSimpleIdentifier(column, 'column');
      if (!columns.has(column) || ADMIN_DATA_SENSITIVE_COLUMNS.has(column)) {
        const error = new Error('Column is not available');
        error.statusCode = 400;
        throw error;
      }
      return column;
    });
  }
  return [...columns].filter((column) => !ADMIN_DATA_SENSITIVE_COLUMNS.has(column));
}

function sanitizeWriteValues(values, columns) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    const error = new Error('values must be an object');
    error.statusCode = 400;
    throw error;
  }
  const entries = Object.entries(values);
  if (entries.length === 0 || entries.length > 100) {
    const error = new Error('Invalid values payload');
    error.statusCode = 400;
    throw error;
  }
  for (const [column] of entries) {
    assertSimpleIdentifier(column, 'column');
    if (!columns.has(column) || ADMIN_DATA_SENSITIVE_COLUMNS.has(column)) {
      const error = new Error(`Column "${column}" is not writable`);
      error.statusCode = 400;
      throw error;
    }
  }
  return entries;
}

function normalizeAdminDataEntries(table, entries) {
  return entries.map(([column, value]) => {
    if (column === 'status' && ['cc_clients', 'cc_licenses'].includes(table)) {
      return [column, normalizeLicenseStatus(value)];
    }
    if (column === 'license_status' && table === 'cc_installations') {
      return [column, normalizeLicenseStatus(value)];
    }
    if (column === 'product_family' && table === 'cc_licenses') {
      return [column, normalizeProductFamily(value)];
    }
    return [column, value];
  });
}

app.post('/api/v1/admin/data/query', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const { table, distinct, columns: requested, where, whereArgs, orderBy, limit, offset } = req.body || {};
    ensureAllowedTable(table);
    const columns = await tableColumnSet(table);
    const selected = visibleColumns(columns, requested);
    const predicate = buildSimpleWhere(where, whereArgs, columns);
    const order = buildSafeOrderBy(orderBy, columns);
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit || '1000', 10) || 1000, 5000));
    const safeOffset = Math.max(0, Number.parseInt(offset || '0', 10) || 0);
    const sql = `SELECT ${distinct === true ? 'DISTINCT ' : ''}${selected.map(pgIdentifier).join(', ')} FROM ${pgIdentifier(table)}${predicate.sql}${order} LIMIT $${predicate.nextIndex} OFFSET $${predicate.nextIndex + 1}`;
    const result = await pool.query(sql, [...predicate.values, safeLimit, safeOffset]);
    return res.json({ success: true, rows: result.rows });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    return serverError(res, 'Admin data query failed', error);
  }
});

app.post('/api/v1/admin/data/insert', validateAdminAuth, async (req, res) => {
  try {
    const { table, values } = req.body || {};
    ensureAllowedTable(table);
    enforceTableWritePermission(req, table);
    const columns = await tableColumnSet(table);
    const entries = normalizeAdminDataEntries(table, sanitizeWriteValues(values, columns));
    const names = entries.map(([name]) => pgIdentifier(name));
    const params = entries.map(([, value]) => value);
    const placeholders = params.map((_, i) => `$${i + 1}`);
    const result = await pool.query(
      `INSERT INTO ${pgIdentifier(table)} (${names.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
      params,
    );
    return res.json({ success: true, id: result.rows[0]?.id ?? 0 });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    return serverError(res, 'Admin data insert failed', error);
  }
});

app.post('/api/v1/admin/data/update', validateAdminAuth, async (req, res) => {
  try {
    const { table, values, where, whereArgs } = req.body || {};
    ensureAllowedTable(table);
    enforceTableWritePermission(req, table);
    if (!where) return res.status(400).json({ success: false, error: 'A filter is required for updates' });
    const columns = await tableColumnSet(table);
    const entries = normalizeAdminDataEntries(table, sanitizeWriteValues(values, columns));
    let index = 1;
    const setSql = entries.map(([name]) => `${pgIdentifier(name)} = $${index++}`).join(', ');
    const setValues = entries.map(([, value]) => value);
    const predicate = buildSimpleWhere(where, whereArgs, columns, index);
    const result = await pool.query(
      `UPDATE ${pgIdentifier(table)} SET ${setSql}${predicate.sql}`,
      [...setValues, ...predicate.values],
    );
    return res.json({ success: true, affected: result.rowCount });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    return serverError(res, 'Admin data update failed', error);
  }
});

app.post('/api/v1/admin/data/delete', validateAdminAuth, async (req, res) => {
  try {
    const { table, where, whereArgs } = req.body || {};
    ensureAllowedTable(table);
    enforceTableWritePermission(req, table);
    if (!ADMIN_DATA_HARD_DELETE_TABLES.has(table)) {
      return publicError(res, 409, 'Hard delete is disabled for this table; use its dedicated lifecycle endpoint');
    }
    if (!where) return res.status(400).json({ success: false, error: 'A filter is required for deletes' });
    const columns = await tableColumnSet(table);
    const predicate = buildSimpleWhere(where, whereArgs, columns);
    const result = await pool.query(`DELETE FROM ${pgIdentifier(table)}${predicate.sql}`, predicate.values);
    return res.json({ success: true, affected: result.rowCount });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    return serverError(res, 'Admin data delete failed', error);
  }
});

// One-time import used by the Desktop SQLite migration. It is intentionally
// super-admin only and does not expose a general SQL execution primitive.
app.post('/api/v1/admin/data/import', validateAdminAuth, requireRole('super_admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { table, rows } = req.body || {};
    ensureAllowedTable(table);
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 1000) {
      return res.status(400).json({ success: false, error: 'rows must contain 1 to 1000 records' });
    }
    const columns = await tableColumnSet(table);
    await client.query('BEGIN');
    let imported = 0;
    for (const row of rows) {
      const clean = Object.fromEntries(Object.entries(row || {}).filter(([key]) => columns.has(key) && !ADMIN_DATA_SENSITIVE_COLUMNS.has(key)));

      // Preserve legacy client activation credentials without ever persisting
      // plaintext. The migration endpoint is super-admin only and hashes the
      // password before the row is written.
      if (table === 'cc_clients' && row?.client_password) {
        const legacyPassword = String(row.client_password);
        clean.client_password = /^\$2[aby]\$/.test(legacyPassword)
          ? legacyPassword
          : await bcrypt.hash(legacyPassword, 12);
      }
      if (clean.status != null && ['cc_clients', 'cc_licenses'].includes(table)) {
        clean.status = normalizeLicenseStatus(clean.status);
      }
      if (clean.license_status != null && table === 'cc_installations') {
        clean.license_status = normalizeLicenseStatus(clean.license_status);
      }

      const entries = Object.entries(clean);
      if (entries.length === 0) continue;
      const names = entries.map(([name]) => pgIdentifier(name));
      const values = entries.map(([, value]) => value);
      const placeholders = values.map((_, i) => `$${i + 1}`);
      const hasId = Object.prototype.hasOwnProperty.call(clean, 'id');
      const conflict = hasId ? ' ON CONFLICT (id) DO NOTHING' : '';
      await client.query(
        `INSERT INTO ${pgIdentifier(table)} (${names.join(', ')}) VALUES (${placeholders.join(', ')})${conflict}`,
        values,
      );
      imported++;
    }
    if (columns.has('id')) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence($1, 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${pgIdentifier(table)}), 1), 1), true)`,
        [table],
      ).catch(() => {});
    }
    await client.query('COMMIT');
    return res.json({ success: true, imported });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    return serverError(res, 'Admin data import failed', error);
  } finally {
    client.release();
  }
});

const REPORT_QUERIES = Object.freeze({
  monthly_revenue: {
    sql: `SELECT SUBSTRING(COALESCE(paid_at,due_date),1,7) AS month, COALESCE(SUM(total),0)::numeric AS revenue FROM cc_invoices WHERE LOWER(status) IN ('paid','pagada','pagado') GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
  },
  client_growth: {
    sql: `SELECT SUBSTRING(created_at,1,7) AS month, COUNT(*)::int AS new_clients FROM cc_clients GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
  },
  churn: {
    sql: `SELECT SUBSTRING(COALESCE(updated_at,created_at::text),1,7) AS month, COUNT(*)::int AS churn FROM cc_clients WHERE LOWER(status) IN ('suspended','suspendido','cancelled','canceled','inactive','inactivo') GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
  },
  license_distribution: {
    sql: `SELECT plan AS type, COUNT(*)::int AS count FROM cc_clients GROUP BY plan ORDER BY count DESC`,
  },
  tickets_priority: {
    sql: `SELECT priority, COUNT(*)::int AS count FROM cc_tickets GROUP BY priority ORDER BY count DESC`,
  },
  module_usage: {
    sql: `SELECT module, COUNT(*)::int AS usage FROM cc_telemetry WHERE module IS NOT NULL AND module <> '' GROUP BY module ORDER BY usage DESC LIMIT 20`,
  },
  ticket_resolution_trend: {
    sql: `SELECT SUBSTRING(created_at,1,7) AS month, AVG(EXTRACT(EPOCH FROM (updated_at::timestamp - created_at::timestamp)))/3600 AS hours FROM cc_tickets WHERE LOWER(status) IN ('resolved','closed','resuelto','cerrado') GROUP BY 1 ORDER BY 1 DESC LIMIT 6`,
  },
  total_clients: { sql: `SELECT COUNT(*)::int AS count FROM cc_clients` },
  active_clients: { sql: `SELECT COUNT(*)::int AS count FROM cc_clients WHERE LOWER(status) IN ('active','activo')` },
  total_installations: { sql: `SELECT COUNT(*)::int AS count FROM cc_installations` },
  connected_installations: { sql: `SELECT COUNT(*)::int AS count FROM cc_installations WHERE connected=1` },
  active_installations: { sql: `SELECT COUNT(*)::int AS count FROM cc_installations WHERE connected=1` },
  open_tickets: { sql: `SELECT COUNT(*)::int AS count FROM cc_tickets WHERE LOWER(status) NOT IN ('resolved','closed','resuelto','cerrado')` },
  critical_alerts: { sql: `SELECT COUNT(*)::int AS count FROM cc_alerts WHERE LOWER(priority) IN ('critical','critica') AND LOWER(status) NOT IN ('resolved','closed','resuelta','cerrada')` },
  sync_total: { sql: `SELECT COUNT(*)::int AS count FROM cc_sync_hub_log` },
  sync_pending: { sql: `SELECT COUNT(*)::int AS count FROM cc_sync_hub_log WHERE LOWER(sync_status)='pending'` },
  sync_critical: { sql: `SELECT COUNT(*)::int AS count FROM cc_sync_hub_log WHERE is_critical=1` },
  sync_processed: { sql: `SELECT COUNT(*)::int AS count FROM cc_sync_hub_log WHERE LOWER(sync_status) IN ('processed','synced','complete','completed')` },
  sync_nodes: { sql: `SELECT node_uuid, COUNT(*)::int AS record_count FROM cc_sync_hub_log WHERE node_uuid IS NOT NULL GROUP BY node_uuid ORDER BY MAX(version_timestamp) DESC` },
});

function validateIsoDate(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    const error = new Error(`Invalid ${label}`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

async function executeAdminReport(name, params = {}) {
  const fixed = REPORT_QUERIES[name];
  if (fixed) return pool.query(fixed.sql);

  switch (name) {
    case 'sales_by_client_period': {
      const start = validateIsoDate(params.start, 'start date');
      const end = validateIsoDate(params.end, 'end date');
      return pool.query(
        `SELECT c.name, COUNT(t.id)::int AS ticket_count,
                COALESCE(AVG(CASE WHEN LOWER(t.priority) IN ('alta','high','critical','critica') THEN 1.0 ELSE 0.0 END),0) AS urgency_score
         FROM cc_clients c
         LEFT JOIN cc_tickets t ON c.id=t.client_id AND t.created_at::timestamp BETWEEN $1::timestamp AND $2::timestamp
         GROUP BY c.id,c.name ORDER BY ticket_count DESC`,
        [start, end],
      );
    }
    case 'tickets_by_status_period': {
      const start = validateIsoDate(params.start, 'start date');
      const end = validateIsoDate(params.end, 'end date');
      return pool.query(
        `SELECT status, COUNT(*)::int AS count FROM cc_tickets WHERE created_at::timestamp BETWEEN $1::timestamp AND $2::timestamp GROUP BY status ORDER BY count DESC`,
        [start, end],
      );
    }
    case 'client_telemetry_count': {
      const clientId = Number.parseInt(params.client_id, 10);
      if (!Number.isInteger(clientId) || clientId <= 0) throw Object.assign(new Error('Invalid client_id'), { statusCode: 400 });
      return pool.query(
        `SELECT COUNT(*)::int AS count FROM cc_telemetry WHERE client_id=$1 AND created_at::timestamp > NOW() - INTERVAL '30 days'`,
        [clientId],
      );
    }
    case 'nightly_sales': {
      const clientId = Number.parseInt(params.client_id, 10);
      const date = String(params.date || '');
      if (!Number.isInteger(clientId) || clientId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error('Invalid report parameters'), { statusCode: 400 });
      return pool.query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(SUM(CASE WHEN (data_json::jsonb ? 'total') AND (data_json::jsonb->>'total') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' THEN (data_json::jsonb->>'total')::numeric ELSE 0 END),0) AS total
         FROM cc_sync_hub_log
         WHERE node_uuid IN (SELECT uuid FROM cc_installations WHERE client_id=$1)
           AND entity_type='venta' AND operation='create' AND SUBSTRING(created_at,1,10)=$2`,
        [clientId, date],
      );
    }
    case 'nightly_tickets':
    case 'nightly_alerts':
    case 'client_installation_summary': {
      const clientId = Number.parseInt(params.client_id, 10);
      if (!Number.isInteger(clientId) || clientId <= 0) throw Object.assign(new Error('Invalid client_id'), { statusCode: 400 });
      if (name === 'client_installation_summary') {
        return pool.query(`SELECT COUNT(*)::int AS count, COALESCE(AVG(uptime_hours),0) AS avg_uptime FROM cc_installations WHERE client_id=$1 AND connected=1`, [clientId]);
      }
      const date = String(params.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error('Invalid date'), { statusCode: 400 });
      if (name === 'nightly_tickets') {
        return pool.query(`SELECT COUNT(*)::int AS count FROM cc_tickets WHERE client_id=$1 AND SUBSTRING(created_at,1,10)=$2`, [clientId, date]);
      }
      return pool.query(`SELECT COUNT(*)::int AS count FROM cc_alerts WHERE client_id=$1 AND LOWER(priority) IN ('critica','critical') AND SUBSTRING(created_at,1,10)=$2`, [clientId, date]);
    }
    case 'consolidated_dashboard': {
      const date = String(params.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error('Invalid date'), { statusCode: 400 });
      return pool.query(
        `SELECT COUNT(*)::int AS active_clients,
                COALESCE(SUM(total_sales),0)::numeric AS total_sales,
                COALESCE(SUM(total_transactions),0)::int AS total_transactions,
                COALESCE(SUM(total_tickets),0)::int AS total_tickets,
                COALESCE(SUM(total_critical_alerts),0)::int AS total_critical_alerts,
                COALESCE(SUM(active_installations),0)::int AS total_active_installations,
                COALESCE(AVG(avg_uptime_hours),0) AS avg_uptime_hours
         FROM cc_consolidated_analytics WHERE report_date=$1`,
        [date],
      );
    }
    default:
      return null;
  }
}

app.post('/api/v1/admin/reports/:name', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const result = await executeAdminReport(req.params.name, req.body?.params || {});
    if (!result) return res.status(404).json({ success: false, error: 'Unknown report' });
    return res.json({ success: true, rows: result.rows });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    return serverError(res, 'Report generation failed', error);
  }
});

// ─── SIGNED UPDATE MANIFESTS (MerkaERP 1.2.1+5) ───────────────────────────────
const UPDATE_CHANNELS = new Set(['development', 'internal', 'beta', 'rc', 'stable', 'lts', 'hotfix']);
const SHA256_RE = /^[a-f0-9]{64}$/i;
const RELEASE_STORAGE_DIR = process.env.RELEASE_STORAGE_DIR || path.join(process.cwd(), 'release_storage');
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

function versionParts(value) {
  const core = String(value || '0.0.0').split(/[+-]/, 1)[0];
  return core.split('.').slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(leftValue, rightValue) {
  const left = versionParts(leftValue);
  const right = versionParts(rightValue);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function releaseToMerkaUpdate(row, req) {
  let downloadUrl = row.download_url == null ? '' : String(row.download_url);
  if (row.artifact_path) {
    if (!PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL is required for managed update artifacts');
    const artifactToken = signPublisherJwt(
      { token_type: 'artifact_download', release_id: String(row.id), installation_id: req.installationUuid },
      { issuer: PUBLISHER_ISSUER, expiresIn: '30m', subject: `artifact:${row.id}` },
    );
    downloadUrl = `${PUBLIC_BASE_URL}/api/v1/update-artifacts/${row.id}?token=${encodeURIComponent(artifactToken)}`;
  }
  return {
    release_id: Number(row.id),
    version: String(row.version),
    canal: String(row.channel),
    fecha_publicacion: String(row.published_at),
    url_descarga: downloadUrl,
    tamano_bytes: Number(row.size_bytes),
    sha256: String(row.sha256 || '').toLowerCase(),
    notas: row.notes == null ? '' : String(row.notes),
    obligatoria: Number(row.mandatory || 0) === 1 || row.mandatory === true,
    product_family: String(row.product_family || 'ALL'),
    release_type: String(row.release_type || 'release'),
    rollback_version: row.rollback_version || null,
  };
}

app.get('/api/v1/updates/check', validateClientToken, async (req, res) => {
  try {
    const version = String(req.query.version || '0.0.0').trim();
    const requestedChannel = String(req.query.canal || 'stable').trim().toLowerCase();
    const channel = UPDATE_CHANNELS.has(requestedChannel) ? requestedChannel : 'stable';
    const installationId = String(req.query.installationId || req.query.installation_id || '').trim();
    if (!installationId || installationId !== req.installationUuid) {
      return publicError(res, 403, 'Installation does not match authenticated token');
    }
    const requestedReleaseIdRaw = String(req.query.release_id || '').trim();
    const requestedReleaseId = requestedReleaseIdRaw
      ? Number.parseInt(requestedReleaseIdRaw, 10)
      : null;

    if (
      requestedReleaseIdRaw &&
      (!Number.isInteger(requestedReleaseId) || requestedReleaseId <= 0)
    ) {
      return publicError(res, 400, 'Invalid release_id');
    }

    if (requestedReleaseId) {
      const pendingCommands = await pool.query(
        `SELECT id,action,params_json
         FROM cc_commands
         WHERE installation_uuid=$1
           AND status='pending'
           AND action IN ('forzar_actualizacion','aplicar_hotfix','rollback_actualizacion')
         ORDER BY id DESC
         LIMIT 100`,
        [req.installationUuid],
      );

      const authorized = pendingCommands.rows.some((row) => {
        try {
          const params = JSON.parse(row.params_json || '{}');
          return String(params.release_id || '') === String(requestedReleaseId);
        } catch (_) {
          return false;
        }
      });

      if (!authorized) {
        return publicError(
          res,
          403,
          'Release is not authorized by a pending command for this installation',
        );
      }
    }

    const releaseSelector = requestedReleaseId
      ? 'id=$1'
      : 'LOWER(channel)=$1';

    const result = await pool.query(
      `SELECT id,version,channel,status,published_at,download_url,size_bytes,sha256,notes,mandatory,
              product_family,release_type,rollback_version,min_client_version,min_free_mb,rollout_pct,artifact_path,artifact_name,supported_os_json,supported_arch_json
       FROM cc_releases
       WHERE ${releaseSelector}
         AND LOWER(status)='published'
         AND sha256 IS NOT NULL
         AND size_bytes IS NOT NULL
       ORDER BY published_at DESC
       LIMIT 200`,
      [requestedReleaseId ?? channel],
    );
    const installState = (await pool.query(`SELECT i.free_disk_mb,i.os,i.architecture,c.product_family FROM cc_installations i JOIN cc_clients c ON c.id=i.client_id WHERE i.uuid=$1`, [req.installationUuid])).rows[0] || {};
    const family = normalizeProductFamily(installState.product_family || req.clientAuth?.product_family || req.clientAuth?.pf || 'COMMERCIAL');
    const candidate = result.rows
      .filter((row) =>
        requestedReleaseId
          ? Number(row.id) === requestedReleaseId
          : compareVersions(row.version, version) > 0
      )
      .filter((row) => normalizeFleetProductFamily(row.product_family) === 'ALL' || normalizeFleetProductFamily(row.product_family) === family)
      .filter((row) => !row.min_client_version || compareVersions(version, row.min_client_version) >= 0)
      .filter((row) => installState.free_disk_mb == null || Number(installState.free_disk_mb) >= Number(row.min_free_mb || 0))
      .filter((row) => {
        const allowed = safeParseJson(row.supported_os_json, []);
        const actual = String(installState.os || '').toLowerCase();
        return !Array.isArray(allowed) || allowed.length === 0 || allowed.some((v) => actual.includes(String(v).toLowerCase()));
      })
      .filter((row) => {
        const allowed = safeParseJson(row.supported_arch_json, []);
        return !Array.isArray(allowed) || allowed.length === 0 || allowed.map((v) => String(v).toLowerCase()).includes(String(installState.architecture || '').toLowerCase());
      })
      .filter((row) => isInRollout(req.installationUuid, row.id, row.rollout_pct ?? 100))
      .filter((row) => Boolean(row.artifact_path) || /^https:\/\//i.test(String(row.download_url || '')))
      .sort((a, b) => compareVersions(b.version, a.version))[0];
    if (!candidate) return res.json({ disponible: false, version_actual: version });
    const update = releaseToMerkaUpdate(candidate, req);
    if (!/^https:\/\//i.test(update.url_descarga) || !SHA256_RE.test(update.sha256) || !Number.isFinite(update.tamano_bytes) || update.tamano_bytes <= 0) {
      return publicError(res, 503, 'Published update metadata is incomplete or unsafe');
    }
    const manifestToken = signPublisherJwt(
      {
        token_type: 'publisher_manifest',
        kind: 'merkaerp-update',
        installation_id: req.installationUuid,
        update,
      },
      { issuer: PUBLISHER_ISSUER, expiresIn: '7d', subject: `update:${candidate.id}` },
    );
    return res.json({ disponible: true, version_actual: version, manifest_token: manifestToken });
  } catch (error) {
    return serverError(res, 'Update check failed', error);
  }
});

app.get('/api/v1/updates', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const channel = req.query.canal ? String(req.query.canal).trim().toLowerCase() : null;
    if (channel && !UPDATE_CHANNELS.has(channel)) return publicError(res, 400, 'Invalid update channel');
    const requestedLimit = Number.parseInt(String(req.query.limit || '50'), 10);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 50, 1), 200);
    const params = [];
    let where = '';
    if (channel) { params.push(channel); where = `WHERE LOWER(channel)=$${params.length}`; }
    params.push(limit);
    const result = await pool.query(
      `SELECT id,version,channel,status,pending_installs,published_at,download_url,sha256,size_bytes,notes,mandatory,product_family,release_type,rollback_version,min_client_version,min_free_mb,rollout_pct,artifact_name,artifact_uploaded_at,supported_os_json,supported_arch_json
       FROM cc_releases ${where} ORDER BY published_at DESC LIMIT $${params.length}`,
      params,
    );
    return res.json({ success: true, count: result.rows.length, updates: result.rows });
  } catch (error) {
    return serverError(res, 'List updates failed', error);
  }
});

app.post('/api/v1/updates', validateAdminAuth, requireRole('admin'), async (req, res) => {
  try {
    const version = String(req.body?.version || '').trim();
    const channel = String(req.body?.canal ?? req.body?.channel ?? '').trim().toLowerCase();
    const downloadUrl = String(req.body?.url_descarga ?? req.body?.download_url ?? '').trim();
    const size = Number.parseInt(String(req.body?.tamano_bytes ?? req.body?.size_bytes ?? '0'), 10);
    const sha256 = String(req.body?.sha256 || '').trim().toLowerCase();
    const notes = req.body?.notas ?? req.body?.notes ?? '';
    const mandatoryRaw = req.body?.obligatoria ?? req.body?.mandatory;
    const mandatory = mandatoryRaw === true || Number(mandatoryRaw) === 1;
    const status = String(req.body?.status || 'published').trim().toLowerCase();
    const publishedAt = String(req.body?.fecha_publicacion ?? req.body?.published_at ?? new Date().toISOString());
    const productFamily = normalizeFleetProductFamily(req.body?.product_family ?? req.body?.productFamily ?? 'ALL');
    const releaseType = String(req.body?.release_type || 'release').trim().toLowerCase();
    const rollbackVersion = req.body?.rollback_version ? String(req.body.rollback_version).trim() : null;
    const minClientVersion = req.body?.min_client_version ? String(req.body.min_client_version).trim() : null;
    const minFreeMb = Math.max(0, Number.parseInt(String(req.body?.min_free_mb ?? '500'), 10) || 500);
    const rolloutPct = Math.max(0, Math.min(100, Number.parseInt(String(req.body?.rollout_pct ?? '100'), 10) || 100));
    const supportedOs = Array.isArray(req.body?.supported_os) ? req.body.supported_os.map((v) => String(v).trim().toLowerCase()).filter(Boolean).slice(0, 30) : [];
    const supportedArch = Array.isArray(req.body?.supported_arch) ? req.body.supported_arch.map((v) => String(v).trim().toLowerCase()).filter(Boolean).slice(0, 30) : [];
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return publicError(res, 400, 'Invalid semantic version');
    if (!UPDATE_CHANNELS.has(channel)) return publicError(res, 400, 'Invalid update channel');
    if (!['draft','published','disabled'].includes(status)) return publicError(res, 400, 'Invalid update status');
    if (downloadUrl && !/^https:\/\//i.test(downloadUrl)) return publicError(res, 400, 'Update URL must use HTTPS');
    if (status === 'published' && !downloadUrl) return publicError(res, 400, 'Published updates require an HTTPS URL or a managed artifact upload');
    if (status === 'published' && (!Number.isFinite(size) || size <= 0)) return publicError(res, 400, 'Invalid update size');
    if (status === 'published' && !SHA256_RE.test(sha256)) return publicError(res, 400, 'Invalid SHA-256');
    if (!['release','hotfix','security'].includes(releaseType)) return publicError(res, 400, 'Invalid release type');
    if (Number.isNaN(Date.parse(publishedAt))) return publicError(res, 400, 'Invalid publication date');
    const result = await pool.query(
      `INSERT INTO cc_releases
       (version,channel,status,pending_installs,published_at,download_url,sha256,size_bytes,notes,mandatory,product_family,release_type,rollback_version,min_client_version,min_free_mb,rollout_pct,supported_os_json,supported_arch_json)
       VALUES($1,$2,$3,0,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [version, channel, status, publishedAt, downloadUrl || null, SHA256_RE.test(sha256) ? sha256 : null, Number.isFinite(size) && size > 0 ? size : null, String(notes).slice(0, 20000), mandatory ? 1 : 0, productFamily, releaseType, rollbackVersion, minClientVersion, minFreeMb, rolloutPct, JSON.stringify(supportedOs), JSON.stringify(supportedArch)],
    );
    return res.status(201).json({ success: true, update: result.rows[0] });
  } catch (error) {
    return serverError(res, 'Create update failed', error);
  }
});


app.put('/api/v1/updates/:id', validateAdminAuth, requireRole('admin'), async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return publicError(res, 400, 'Invalid update id');
    const current = (await pool.query('SELECT * FROM cc_releases WHERE id=$1', [id])).rows[0];
    if (!current) return publicError(res, 404, 'Update not found');
    const status = String(req.body?.status ?? current.status).toLowerCase();
    const channel = String(req.body?.channel ?? req.body?.canal ?? current.channel).toLowerCase();
    const productFamily = normalizeFleetProductFamily(req.body?.product_family ?? current.product_family);
    const releaseType = String(req.body?.release_type ?? current.release_type ?? 'release').toLowerCase();
    const rolloutPct = Math.max(0, Math.min(100, Number.parseInt(String(req.body?.rollout_pct ?? current.rollout_pct ?? 100), 10) || 100));
    const minFreeMb = Math.max(0, Number.parseInt(String(req.body?.min_free_mb ?? current.min_free_mb ?? 500), 10) || 0);
    const downloadUrl = String(req.body?.download_url ?? req.body?.url_descarga ?? current.download_url ?? '').trim();
    const sha256 = String(req.body?.sha256 ?? current.sha256 ?? '').trim().toLowerCase();
    const sizeBytes = Number.parseInt(String(req.body?.size_bytes ?? req.body?.tamano_bytes ?? current.size_bytes ?? 0), 10);
    const currentOs = safeParseJson(current.supported_os_json, []);
    const currentArch = safeParseJson(current.supported_arch_json, []);
    const supportedOs = Array.isArray(req.body?.supported_os) ? req.body.supported_os.map((v) => String(v).trim().toLowerCase()).filter(Boolean).slice(0, 30) : (Array.isArray(currentOs) ? currentOs : []);
    const supportedArch = Array.isArray(req.body?.supported_arch) ? req.body.supported_arch.map((v) => String(v).trim().toLowerCase()).filter(Boolean).slice(0, 30) : (Array.isArray(currentArch) ? currentArch : []);
    if (!UPDATE_CHANNELS.has(channel)) return publicError(res, 400, 'Invalid update channel');
    if (!['draft','published','disabled'].includes(status)) return publicError(res, 400, 'Invalid update status');
    if (!['release','hotfix','security'].includes(releaseType)) return publicError(res, 400, 'Invalid release type');
    if (downloadUrl && !/^https:\/\//i.test(downloadUrl)) return publicError(res, 400, 'Update URL must use HTTPS');
    const hasManagedArtifact = Boolean(current.artifact_path);
    if (status === 'published' && !hasManagedArtifact && !downloadUrl) return publicError(res, 409, 'Publish requires HTTPS URL or managed artifact');
    if (status === 'published' && (!SHA256_RE.test(sha256) || !Number.isFinite(sizeBytes) || sizeBytes <= 0)) return publicError(res, 409, 'Publish requires SHA-256 and artifact size');
    const result = await pool.query(`UPDATE cc_releases SET channel=$1,status=$2,download_url=$3,sha256=$4,size_bytes=$5,notes=$6,mandatory=$7,
      product_family=$8,release_type=$9,rollback_version=$10,min_client_version=$11,min_free_mb=$12,rollout_pct=$13,supported_os_json=$14,supported_arch_json=$15,published_at=CASE WHEN $2='published' THEN NOW() ELSE published_at END
      WHERE id=$16 RETURNING *`, [
      channel,status,downloadUrl || null,sha256 || null,sizeBytes || null,String(req.body?.notes ?? req.body?.notas ?? current.notes ?? '').slice(0,20000),
      (req.body?.mandatory ?? req.body?.obligatoria ?? current.mandatory) === true || Number(req.body?.mandatory ?? req.body?.obligatoria ?? current.mandatory)===1 ? 1:0,
      productFamily,releaseType,req.body?.rollback_version ?? current.rollback_version,req.body?.min_client_version ?? current.min_client_version,minFreeMb,rolloutPct,JSON.stringify(supportedOs),JSON.stringify(supportedArch),id,
    ]);
    return res.json({ success: true, update: result.rows[0] });
  } catch (error) { return serverError(res, 'Update metadata failed', error); }
});

app.put('/api/v1/updates/:id/artifact', validateAdminAuth, requireRole('admin'), express.raw({ type: 'application/octet-stream', limit: process.env.RELEASE_UPLOAD_LIMIT || '1gb' }), async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return publicError(res, 400, 'Invalid update id');
    const release = (await pool.query('SELECT id,version FROM cc_releases WHERE id=$1', [id])).rows[0];
    if (!release) return publicError(res, 404, 'Update not found');
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return publicError(res, 400, 'Binary artifact body is required');
    const originalName = String(req.query.filename || `MerkaERP-${release.version}.bin`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0,180);
    await fs.promises.mkdir(RELEASE_STORAGE_DIR, { recursive: true });
    const finalName = `${id}-${Date.now()}-${originalName}`;
    const finalPath = path.join(RELEASE_STORAGE_DIR, finalName);
    await fs.promises.writeFile(finalPath, req.body, { flag: 'wx' });
    const sha256 = crypto.createHash('sha256').update(req.body).digest('hex');
    const publish = String(req.query.publish || '').toLowerCase() === 'true' || String(req.query.publish || '') === '1';
    const previous = (await pool.query('SELECT artifact_path FROM cc_releases WHERE id=$1', [id])).rows[0]?.artifact_path;
    const result = await pool.query(`UPDATE cc_releases SET artifact_path=$1,artifact_name=$2,artifact_uploaded_at=NOW(),sha256=$3,size_bytes=$4,
      download_url=NULL,status=CASE WHEN $5 THEN 'published' ELSE status END,published_at=CASE WHEN $5 THEN NOW() ELSE published_at END WHERE id=$6 RETURNING *`,
      [finalPath, originalName, sha256, req.body.length, publish, id]);
    if (previous && previous !== finalPath && path.resolve(previous).startsWith(path.resolve(RELEASE_STORAGE_DIR))) {
      await fs.promises.unlink(previous).catch(() => {});
    }
    return res.json({ success: true, update: result.rows[0], sha256, size_bytes: req.body.length, managed_artifact: true });
  } catch (error) { return serverError(res, 'Artifact upload failed', error); }
});

app.get('/api/v1/update-artifacts/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const token = String(req.query.token || '');
    if (!Number.isInteger(id) || id <= 0 || !token) return publicError(res, 401, 'Artifact download token required');
    const decoded = verifyPublisherJwt(token, { issuer: PUBLISHER_ISSUER });
    if (decoded.token_type !== 'artifact_download' || String(decoded.release_id) !== String(id)) return publicError(res, 403, 'Invalid artifact token');
    const release = (await pool.query(`SELECT artifact_path,artifact_name,size_bytes,sha256,status FROM cc_releases WHERE id=$1`, [id])).rows[0];
    if (!release || release.status !== 'published' || !release.artifact_path) return publicError(res, 404, 'Published artifact not found');
    const resolved = path.resolve(release.artifact_path);
    if (!resolved.startsWith(path.resolve(RELEASE_STORAGE_DIR))) return publicError(res, 403, 'Invalid artifact path');
    await fs.promises.access(resolved, fs.constants.R_OK);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(release.size_bytes));
    res.setHeader('X-Artifact-SHA256', String(release.sha256));
    res.setHeader('Content-Disposition', `attachment; filename="${String(release.artifact_name || `MerkaERP-${id}.bin`).replace(/"/g,'')}"`);
    return fs.createReadStream(resolved).pipe(res);
  } catch (error) {
    if (error?.name === 'TokenExpiredError' || error?.name === 'JsonWebTokenError') return publicError(res, 401, 'Invalid or expired artifact token');
    return serverError(res, 'Artifact download failed', error);
  }
});

app.delete('/api/v1/updates/:id', validateAdminAuth, requireRole('admin'), async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return publicError(res, 400, 'Invalid update id');
    const result = await pool.query(
      `UPDATE cc_releases SET status='disabled' WHERE id=$1 RETURNING id,status`,
      [id],
    );
    if (!result.rows[0]) return publicError(res, 404, 'Update not found');
    return res.json({ success: true, id, status: 'disabled' });
  } catch (error) {
    return serverError(res, 'Delete update failed', error);
  }
});

// ─── MERKAERP 1.2.1+5 TRANSPORT OUTBOX ────────────────────────────────────────
// The final MerkaERP client intentionally pushes only an authenticated outbox.
// These events are stored for audit/transport and are NEVER applied directly to
// client operational schemas from Control Center.
app.post('/api/v1/installations/sync/push', validateClientToken, async (req, res) => {
  const installationId = String(req.body?.installationId || req.body?.installation_id || '').trim();
  const events = req.body?.events;
  if (!installationId || installationId !== req.installationUuid) {
    return publicError(res, 403, 'Installation does not match authenticated token');
  }
  if (!Array.isArray(events)) return publicError(res, 400, 'events must be an array');
  if (events.length > 500) return publicError(res, 413, 'A sync push can contain at most 500 events');
  if (events.length === 0) return res.json({ success: true, accepted: 0, duplicates: 0 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let accepted = 0;
    let duplicates = 0;
    for (const raw of events) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        const error = new Error('Each sync event must be an object');
        error.statusCode = 400;
        throw error;
      }
      const eventId = String(raw.eventId || raw.event_id || '').trim();
      const tableName = String(raw.table || raw.table_name || '').trim();
      const operation = String(raw.operation || '').trim().toLowerCase();
      const timestamp = String(raw.timestamp || '').trim();
      const data = raw.data;
      if (!eventId || eventId.length > 200) {
        const error = new Error('Invalid sync event id');
        error.statusCode = 400;
        throw error;
      }
      if (!isAllowedSyncTable(tableName) || !isAllowedSyncOperation(operation)) {
        const error = new Error(`Sync event not allowed: ${tableName}/${operation}`);
        error.statusCode = 400;
        throw error;
      }
      if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
        const error = new Error('Invalid sync event timestamp');
        error.statusCode = 400;
        throw error;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        const error = new Error('Sync event data must be an object');
        error.statusCode = 400;
        throw error;
      }
      const payloadJson = JSON.stringify(data);
      if (Buffer.byteLength(payloadJson, 'utf8') > 512 * 1024) {
        const error = new Error('Sync event payload is too large');
        error.statusCode = 413;
        throw error;
      }
      const inserted = await client.query(
        `INSERT INTO cc_installation_sync_events
         (event_id, installation_uuid, client_id, license_id, table_name, operation, payload_json, event_timestamp)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (installation_uuid,event_id) DO NOTHING
         RETURNING id`,
        [eventId, req.installationUuid, req.clientId, Number(req.clientAuth.license_id), tableName, operation, payloadJson, timestamp],
      );
      if (inserted.rowCount > 0) accepted += 1; else duplicates += 1;
    }
    await client.query(
      `UPDATE cc_installations SET sync_status='synced', last_seen=$1, updated_at=$1 WHERE uuid=$2`,
      [new Date().toISOString(), req.installationUuid],
    );
    await client.query('COMMIT');
    return res.json({ success: true, accepted, duplicates, received_at: new Date().toISOString() });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.statusCode) return publicError(res, error.statusCode, error.message);
    return serverError(res, 'Sync transport push failed', error);
  } finally {
    client.release();
  }
});

app.get('/api/v1/admin/sync-events', validateAdminAuth, requirePermission('read'), async (req, res) => {
  try {
    const requestedLimit = Number.parseInt(String(req.query.limit || '100'), 10);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 100, 1), 500);
    const clientId = Number.parseInt(String(req.query.client_id || '0'), 10) || 0;
    const installation = String(req.query.installation_id || '').trim();
    const params = [];
    const where = [];
    if (clientId > 0) { params.push(clientId); where.push(`client_id=$${params.length}`); }
    if (installation) { params.push(installation); where.push(`installation_uuid=$${params.length}`); }
    params.push(limit);
    const result = await pool.query(
      `SELECT id,event_id,installation_uuid,client_id,license_id,table_name,operation,event_timestamp,received_at
       FROM cc_installation_sync_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY received_at DESC LIMIT $${params.length}`,
      params,
    );
    return res.json({ success: true, events: result.rows, count: result.rows.length });
  } catch (error) {
    return serverError(res, 'List sync events failed', error);
  }
});

// Legacy replication endpoints are deliberately retired. Direct row replication
// bypasses MerkaERP domain invariants and is not part of the 1.2.1+5 contract.
app.all(['/api/v1/data/push', '/api/v1/data/pull'], (req, res) =>
  res.status(410).json({ success: false, error: 'Legacy direct replication is disabled; use the MerkaERP transport outbox contract' })
);

async function runServerMaintenance() {
  const lockKey = 73902164;
  const client = await pool.connect();
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [lockKey]);
    if (!lock.rows[0]?.locked) return;
    const now = new Date().toISOString();
    await processDueScheduledDeployments().catch((error) => console.error('Scheduled deployment processing failed:', error.message));
    const expiredLicenses = await client.query(
      `UPDATE cc_licenses SET status='expired',status_reason=COALESCE(status_reason,'Vencimiento automático'),updated_at=$1
       WHERE LOWER(status) IN ('active','trial','activo') AND expires_at::timestamptz <= NOW()
       RETURNING id,client_id`,
      [now],
    );
    if (expiredLicenses.rowCount > 0) {
      await client.query(
        `UPDATE cc_installations i SET blocked=1,connected=0,status='blocked',license_status='expired',
         block_reason='Licencia: vencida',updated_at=$1
         FROM cc_licenses l WHERE i.license_id=l.id AND l.status='expired' AND i.status<>'disabled'`,
        [now],
      );
    }
    const expiringLicenses = await client.query(
      `SELECT id,client_id,expires_at FROM cc_licenses
       WHERE status IN ('active','trial') AND expires_at::timestamptz > NOW() AND expires_at::timestamptz <= NOW() + INTERVAL '14 days'`,
    );
    const expiringIds = new Set(expiringLicenses.rows.map((row) => String(row.id)));
    for (const row of expiringLicenses.rows) {
      const days = Math.max(0, Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 86400000));
      await setOperationalAlert({
        key: `license-expiry:${row.id}`,
        clientId: row.client_id,
        priority: days <= 3 ? 'alta' : 'media',
        category: 'licensing',
        message: `Licencia #${row.id} vence en ${days} día(s)`,
        details: { license_id: row.id, expires_at: row.expires_at, days_remaining: days },
        active: true,
      });
    }
    const existingExpiryAlerts = await client.query(
      `SELECT alert_key FROM cc_alerts WHERE alert_key LIKE 'license-expiry:%' AND LOWER(status) IN ('active','activa','open')`,
    ).catch(() => ({ rows: [] }));
    for (const row of existingExpiryAlerts.rows) {
      const licenseId = String(row.alert_key || '').split(':')[1] || '';
      if (!expiringIds.has(licenseId)) await setOperationalAlert({ key: row.alert_key, active: false });
    }
    const stale = await client.query(
      `UPDATE cc_installations SET connected=0, updated_at=$1
       WHERE connected<>0 AND COALESCE(last_heartbeat,last_seen)::timestamptz < NOW() - INTERVAL '10 minutes'
       RETURNING uuid,client_id,last_seen,last_heartbeat`,
      [now],
    );
    for (const row of stale.rows) {
      await setOperationalAlert({
        key: `offline:${row.uuid}`,
        clientId: row.client_id,
        installationId: row.uuid,
        priority: 'alta',
        category: 'connectivity',
        message: 'Instalación sin heartbeat por más de 10 minutos',
        details: { last_seen: row.last_seen, last_heartbeat: row.last_heartbeat },
        active: true,
      });
    }
    const backOnline = await client.query(
      `SELECT uuid FROM cc_installations WHERE connected=1 AND COALESCE(last_heartbeat,last_seen)::timestamptz >= NOW() - INTERVAL '10 minutes'`,
    );
    for (const row of backOnline.rows) {
      await setOperationalAlert({ key: `offline:${row.uuid}`, active: false });
    }
    await client.query(
      `UPDATE cc_commands SET status='expired',ack_at=COALESCE(ack_at,$1),result=COALESCE(result,'Command expired before polling')
       WHERE status='pending' AND expires_at IS NOT NULL AND expires_at::timestamptz <= NOW()`,
      [now],
    );
    await client.query(
      `UPDATE cc_deployment_targets t SET status='failed',last_error='Command expired before installation polled it',updated_at=NOW()
       FROM cc_commands c WHERE t.command_id=c.id AND t.status='queued' AND c.status='expired'`,
    ).catch(() => {});
    await client.query(
      `UPDATE cc_deployments d SET success_count=s.success,failed_count=s.failed,
       status=CASE WHEN s.remaining=0 THEN CASE WHEN s.failed>0 THEN 'completed_with_errors' ELSE 'completed' END ELSE d.status END,
       completed_at=CASE WHEN s.remaining=0 THEN COALESCE(d.completed_at,NOW()) ELSE d.completed_at END
       FROM (
         SELECT deployment_id,COUNT(*) FILTER(WHERE status='completed')::int success,
                COUNT(*) FILTER(WHERE status='failed')::int failed,
                COUNT(*) FILTER(WHERE status IN ('pending','queued'))::int remaining
         FROM cc_deployment_targets GROUP BY deployment_id
       ) s WHERE d.id=s.deployment_id AND d.status IN ('running','queued','paused')`,
    ).catch(() => {});
    await client.query('DELETE FROM cc_sessions WHERE expires_at::timestamptz <= NOW()');
    await client.query(
      `UPDATE cc_remote_access_sessions SET status='expired', ended_at=COALESCE(ended_at,$1)
       WHERE status IN ('pending','approved') AND expires_at::timestamptz <= NOW()`,
      [now],
    ).catch(() => {});
    await client.query(
      `DELETE FROM cc_sync_hub_log WHERE created_at::timestamptz < NOW() - INTERVAL '180 days' AND LOWER(sync_status) IN ('processed','synced','completed','complete')`,
    ).catch(() => {});
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch(() => {});
    client.release();
  }
}

async function consolidateYesterdayServerSide() {
  const date = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const clients = await pool.query(`SELECT id FROM cc_clients WHERE LOWER(status) IN ('active','activo','trial')`);
  for (const row of clients.rows) {
    const clientId = Number(row.id);
    const [sales, tickets, alerts, installations] = await Promise.all([
      executeAdminReport('nightly_sales', { client_id: clientId, date }),
      executeAdminReport('nightly_tickets', { client_id: clientId, date }),
      executeAdminReport('nightly_alerts', { client_id: clientId, date }),
      executeAdminReport('client_installation_summary', { client_id: clientId }),
    ]);
    const values = {
      totalSales: Number(sales.rows[0]?.total || 0),
      transactions: Number(sales.rows[0]?.count || 0),
      tickets: Number(tickets.rows[0]?.count || 0),
      alerts: Number(alerts.rows[0]?.count || 0),
      installations: Number(installations.rows[0]?.count || 0),
      uptime: Number(installations.rows[0]?.avg_uptime || 0),
    };
    await pool.query(
      `INSERT INTO cc_consolidated_analytics
       (report_date,client_id,total_sales,total_transactions,total_tickets,total_critical_alerts,active_installations,avg_uptime_hours,top_products,payment_methods,generated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'[]','[]',$9)
       ON CONFLICT (report_date,client_id) DO UPDATE SET
         total_sales=EXCLUDED.total_sales,
         total_transactions=EXCLUDED.total_transactions,
         total_tickets=EXCLUDED.total_tickets,
         total_critical_alerts=EXCLUDED.total_critical_alerts,
         active_installations=EXCLUDED.active_installations,
         avg_uptime_hours=EXCLUDED.avg_uptime_hours,
         generated_at=EXCLUDED.generated_at`,
      [date, clientId, values.totalSales, values.transactions, values.tickets, values.alerts, values.installations, values.uptime, new Date().toISOString()],
    );
  }
}

function startMaintenanceJobs() {
  const maintenanceTimer = setInterval(() => {
    runServerMaintenance().catch((error) => console.error('Maintenance job failed:', error.message));
  }, 15 * 60 * 1000);
  maintenanceTimer.unref();

  const analyticsTimer = setInterval(() => {
    consolidateYesterdayServerSide().catch((error) => console.error('Analytics consolidation failed:', error.message));
  }, 6 * 60 * 60 * 1000);
  analyticsTimer.unref();
}

async function migrateKnownClientSchemas() {
  const result = await pool.query(`SELECT DISTINCT postgres_schema FROM cc_clients WHERE postgres_schema IS NOT NULL AND postgres_schema <> ''`);
  for (const row of result.rows) {
    if (/^client_\d+$/.test(row.postgres_schema)) {
      await createClientTables(pool, row.postgres_schema);
    }
  }
}

app.use('/api', (req, res) => publicError(res, 404, 'Endpoint not found'));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('Unhandled request error:', error?.message || error);
  return res.status(500).json({ success: false, error: 'Internal server error' });
});

async function startServer() {
  // MerkaERP 1.2.1+5 pins the publisher public key. In production, never
  // start a signing authority with a different or missing private key.
  assertProductionKeyConfiguration();
  await pool.query('SELECT 1');
  await initializePostgresTables(pool);
  await migrateKnownClientSchemas();
  await runServerMaintenance();
  await consolidateYesterdayServerSide().catch((error) => console.warn('Initial analytics consolidation skipped:', error.message));
  startMaintenanceJobs();

  return app.listen(PORT, () => {
    console.log(`Merka Control Center Backend running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Backend startup failed:', error);
    process.exit(1);
  });
}

module.exports = {
  app,
  pool,
  startServer,
  normalizeLicenseStatus,
  normalizeAdminRole,
  signAdminToken,
  generateLicenseToken,
  verifyAdminJwt,
  verifyLicenseJwt,
  roleHasPermission,
  totpCode,
  validateTotp,
  signOfflineLicense,
  deriveClientDbPassword,
  publisherPublicKey,
  publisherPublicKeyFingerprint: CLIENT_PINNED_PUBLIC_KEY_SHA256,
  normalizeProductFamily,
  publisherStatus,
};

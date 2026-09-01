const crypto = require('crypto');

const ALLOWED_REMOTE_ACTIONS = new Set([
  // Core lifecycle / operations
  'forzar_respaldo',
  'restaurar_respaldo',
  'reiniciar_sesiones',
  'reiniciar',
  'bloquear_instalacion',
  'activar_instalacion',
  'entrar_mantenimiento',
  'salir_mantenimiento',

  // Deployment / configuration
  'forzar_actualizacion',
  'rollback_actualizacion',
  'aplicar_hotfix',
  'actualizar_modulos',
  'actualizar_licencia',
  'aplicar_configuracion',
  'aplicar_feature_flags',
  'forzar_sincronizacion',

  // Support / diagnostics. These are intentionally enumerated; the server
  // never exposes arbitrary shell, SQL or PowerShell execution.
  'run_diagnostics',
  'verificar_base_datos',
  'reconstruir_indices',
  'limpiar_cache',
  'ejecutar_reparacion',
  'enviar_log',
  'collect_diagnostics',
  'mensaje_admin',
  'solicitar_acceso_remoto',
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = stableValue(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function canonicalCommandPayload({ id, action, installationId, timestamp, expiresAt, nonce, params }) {
  return JSON.stringify(stableValue({
    action,
    expires_at: expiresAt,
    id,
    installation_id: installationId,
    nonce,
    params: params || {},
    timestamp,
  }));
}

function signCommand(secret, command) {
  if (!secret) throw new Error('Missing installation command secret');
  return crypto.createHmac('sha256', secret)
    .update(canonicalCommandPayload(command), 'utf8')
    .digest('hex');
}

function generateCommandSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateNonce() {
  return crypto.randomBytes(24).toString('base64url');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

module.exports = {
  ALLOWED_REMOTE_ACTIONS,
  canonicalCommandPayload,
  signCommand,
  generateCommandSecret,
  generateNonce,
  safeEqualHex,
};

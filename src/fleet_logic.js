const crypto = require('crypto');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseVersion(value) {
  const match = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), suffix: match[4] || '' };
}

function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (va[key] !== vb[key]) return va[key] < vb[key] ? -1 : 1;
  }
  if (va.suffix === vb.suffix) return 0;
  if (!va.suffix) return 1;
  if (!vb.suffix) return -1;
  return va.suffix.localeCompare(vb.suffix);
}

function computeHealthScore(input = {}) {
  let score = 100;
  const reasons = [];
  const criticalErrors = Number(input.criticalErrors || 0);
  const freeDiskMb = input.freeDiskMb == null ? null : Number(input.freeDiskMb);
  const databaseStatus = String(input.databaseStatus || '').toLowerCase();
  const syncStatus = String(input.syncStatus || '').toLowerCase();
  const connected = Number(input.connected ?? 1) === 1;
  const lastBackupAt = input.lastBackupAt ? new Date(input.lastBackupAt) : null;

  if (!connected) { score -= 25; reasons.push('offline'); }
  if (criticalErrors > 0) {
    const penalty = Math.min(35, criticalErrors * 7);
    score -= penalty;
    reasons.push(`${criticalErrors} critical error(s)`);
  }
  if (databaseStatus && !['healthy', 'ok', 'healthy_db', 'saludable'].includes(databaseStatus)) {
    score -= 25;
    reasons.push(`database:${databaseStatus}`);
  }
  if (syncStatus && !['synced', 'ok', 'synchronized', 'sincronizado'].includes(syncStatus)) {
    score -= 15;
    reasons.push(`sync:${syncStatus}`);
  }
  if (Number.isFinite(freeDiskMb) && freeDiskMb < 1024) {
    score -= freeDiskMb < 256 ? 25 : 10;
    reasons.push(`low_disk:${freeDiskMb}MB`);
  }
  if (lastBackupAt && !Number.isNaN(lastBackupAt.getTime())) {
    const ageHours = (Date.now() - lastBackupAt.getTime()) / 3_600_000;
    if (ageHours > 72) { score -= 20; reasons.push('backup>72h'); }
    else if (ageHours > 24) { score -= 8; reasons.push('backup>24h'); }
  }

  score = clamp(Math.round(score), 0, 100);
  const status = score >= 90 ? 'healthy' : score >= 70 ? 'warning' : score >= 40 ? 'degraded' : 'critical';
  return { score, status, reasons };
}

function rolloutBucket(installationUuid, releaseId) {
  const digest = crypto.createHash('sha256').update(`${releaseId}:${installationUuid}`).digest();
  return digest.readUInt32BE(0) % 100;
}

function isInRollout(installationUuid, releaseId, rolloutPct) {
  const pct = clamp(Number(rolloutPct || 0), 0, 100);
  if (pct >= 100) return true;
  if (pct <= 0) return false;
  return rolloutBucket(installationUuid, releaseId) < pct;
}

function errorSignature({ module, message, stack }) {
  const normalizedMessage = String(message || '')
    .replace(/\b\d+\b/g, '#')
    .replace(/0x[0-9a-f]+/gi, '0x#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
  const normalizedStack = String(stack || '').split('\n').slice(0, 4).join('\n').replace(/:\d+:\d+/g, ':#:#');
  return crypto.createHash('sha256').update(`${String(module || 'core').toLowerCase()}|${normalizedMessage}|${normalizedStack}`).digest('hex');
}

function normalizeProductFamily(value) {
  const raw = String(value || 'ALL').trim().toUpperCase();
  if (['PUBLIC', 'PUBLICO', 'PÚBLICO', 'PUBLIC_SECTOR'].includes(raw)) return 'PUBLIC';
  if (['COMMERCIAL', 'COMERCIAL', 'PRIVATE'].includes(raw)) return 'COMMERCIAL';
  return 'ALL';
}

module.exports = {
  parseVersion,
  compareVersions,
  computeHealthScore,
  rolloutBucket,
  isInRollout,
  errorSignature,
  normalizeFleetProductFamily: normalizeProductFamily,
};

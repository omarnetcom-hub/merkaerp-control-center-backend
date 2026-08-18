'use strict';

const SCALE = 2;
const FACTOR = 10n ** BigInt(SCALE);

function majorToMinor(value, { field = 'amount', allowNull = false } = {}) {
  if (value == null || value === '') {
    if (allowNull) return null;
    return 0;
  }
  const raw = String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) {
    const error = new Error(`${field} must be a decimal with at most 2 fractional digits`);
    error.statusCode = 400;
    throw error;
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2]);
  const fraction = BigInt((match[3] || '').padEnd(SCALE, '0'));
  const minor = sign * (whole * FACTOR + fraction);
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (minor > max || minor < -max) {
    const error = new Error(`${field} is outside the supported monetary range`);
    error.statusCode = 400;
    throw error;
  }
  return Number(minor);
}

function normalizeMinor(value, { field = 'amountMinor', allowNull = false } = {}) {
  if (value == null || value === '') {
    if (allowNull) return null;
    return 0;
  }
  const raw = String(value).trim();
  if (!/^[+-]?\d+$/.test(raw)) {
    const error = new Error(`${field} must be an integer number of minor units`);
    error.statusCode = 400;
    throw error;
  }
  const minor = BigInt(raw);
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (minor > max || minor < -max) {
    const error = new Error(`${field} is outside the supported monetary range`);
    error.statusCode = 400;
    throw error;
  }
  return Number(minor);
}

function moneyFromBody(body, { majorKeys = [], minorKeys = [], field = 'amount' } = {}) {
  for (const key of minorKeys) {
    if (body && body[key] != null && body[key] !== '') {
      return normalizeMinor(body[key], { field: key });
    }
  }
  for (const key of majorKeys) {
    if (body && body[key] != null && body[key] !== '') {
      return majorToMinor(body[key], { field: key });
    }
  }
  return 0;
}

function minorToMajorString(value) {
  const minor = BigInt(normalizeMinor(value));
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / FACTOR;
  const fraction = (abs % FACTOR).toString().padStart(SCALE, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

function minorToLegacyNumber(value) {
  return Number(minorToMajorString(value));
}

module.exports = {
  SCALE,
  majorToMinor,
  normalizeMinor,
  moneyFromBody,
  minorToMajorString,
  minorToLegacyNumber,
};

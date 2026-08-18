'use strict';

// Exact transport allowlist used by MerkaERP 1.2.1+5 SyncService.
// Control Center stores these events for transport/audit only; it never
// applies remote rows directly to ERP operational tables.
const ALLOWED_TABLES = new Set([
  'productos',
  'clientes',
  'ventas',
  'venta_items',
]);

const ALLOWED_OPERATIONS = new Set(['insert', 'update', 'delete']);

function normalizeTableName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOperation(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isAllowedTable(value) {
  return ALLOWED_TABLES.has(normalizeTableName(value));
}

function isAllowedOperation(value) {
  return ALLOWED_OPERATIONS.has(normalizeOperation(value));
}

module.exports = {
  ALLOWED_TABLES,
  ALLOWED_OPERATIONS,
  normalizeTableName,
  normalizeOperation,
  isAllowedTable,
  isAllowedOperation,
};

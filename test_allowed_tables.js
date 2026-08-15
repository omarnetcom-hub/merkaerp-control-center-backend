const assert = require('assert');
const {
  ALLOWED_TABLES,
  isAllowedTable,
  normalizeTableName
} = require('./src/sync/allowed_tables');

const requiredTables = [
  'clientes',
  'crm_campaigns',
  'crm_opportunity_items',
  'hrm_leaves',
  'hrm_attendance_records',
  'mrp_workstation_shifts',
  'mrp_work_orders',
  'impact_scenarios',
  'auditoria_registros',
  'entidades_territoriales',
  'apropiaciones',
  'cdp_meta_trazabilidad',
  'rp_meta_trazabilidad',
  'autorizaciones_vigencias_futuras',
  'recepciones_satisfaccion',
  'asientos_contables_sp',
  'conciliaciones_reciprocas',
  'actas_responsabilidad',
  'procesos_contratacion',
  'contratos',
  'rips',
  'catalogo_cups',
  'catalogo_cie10',
  'regalias',
  'sgp_destinaciones_rubro',
  'reportes_siif_nacion'
];

for (const table of requiredTables) {
  assert.ok(isAllowedTable(table), `${table} should be allowed`);
}

assert.strictEqual(normalizeTableName(' crm_leads '), 'crm_leads');
assert.ok(isAllowedTable(' crm_leads '));
assert.ok(!isAllowedTable('sqlite_master'));
assert.ok(!isAllowedTable('users'));
assert.ok(!isAllowedTable('sync_events'));
assert.ok(!isAllowedTable(''));
assert.ok(ALLOWED_TABLES.size > requiredTables.length);

console.log(`Allowed sync tables test passed (${ALLOWED_TABLES.size} tables)`);

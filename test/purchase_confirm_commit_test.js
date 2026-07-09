const assert = require('assert');
const { PurchaseOrder } = require('../src/modules/purchase/models/Purchase');

class StubDb {
  constructor() { this.queries = []; }
  async query(sql, params) {
    const s = sql.trim();
    this.queries.push({ sql: s, params });
    if (s.startsWith('UPDATE purchase_orders SET state =')) {
      return { rows: [{ id: params[0], partner_id: 1, company_id: 1, order_date: '2026-07-08', state: 'confirmed', total_amount: 1000 }] };
    }
    if (s.startsWith("SELECT * FROM account_budget_commitments")) {
      return { rows: [{ id: 9, budget_line_id: 5, origin_type: 'purchase_order', origin_id: params[0], amount: 1000, state: 'pending' }] };
    }
    if (s.startsWith('UPDATE account_budget_commitments SET state')) {
      return { rows: [{ id: params[1], state: params[0] }] };
    }
    if (s.startsWith('UPDATE account_budget_lines')) {
      return { rows: [{ id: params[3], committed_amount: params[1], available_amount: 0 }] };
    }
    return { rows: [] };
  }
}

async function run() {
  const db = new StubDb();
  const po = new PurchaseOrder(db);
  const confirmed = await po.confirm(42);
  assert.strictEqual(confirmed.state, 'confirmed');
  // verify that commit update query was executed
  const commitUpdate = db.queries.find(q => q.sql.startsWith('UPDATE account_budget_commitments SET state'));
  assert.ok(commitUpdate, 'Budget commitment was not updated');
  const lineUpdate = db.queries.find(q => q.sql.startsWith('UPDATE account_budget_lines'));
  assert.ok(lineUpdate, 'Budget line amounts were not updated');
  console.log('✓ purchase_confirm_commit_test passed');
}

run().catch(err => { console.error(err); process.exit(1); });

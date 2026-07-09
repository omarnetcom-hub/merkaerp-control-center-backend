const assert = require('assert');
const { PurchaseOrder } = require('../src/modules/purchase/models/Purchase');
const { BudgetCommitment } = require('../src/modules/account_budget/models/Budget');

class StubDb {
  constructor() { this.queries = []; }
  async query(sql, params) {
    this.queries.push({ sql: sql.trim(), params });
    const s = sql.trim();
    if (s.startsWith('INSERT INTO purchase_orders')) {
      return { rows: [{ id: 42, partner_id: params[0], company_id: params[1], invoice_date: null, order_date: params[2], state: params[3], currency_id: params[4], user_id: params[5], total_amount: params[6] }] };
    }
    if (s.startsWith('INSERT INTO account_budget_commitments')) {
      return { rows: [{ id: 7, budget_line_id: params[0], origin_type: params[1], origin_id: params[2], amount: params[3], state: params[4] }] };
    }
    return { rows: [] };
  }
}

async function run() {
  const db = new StubDb();
  const po = new PurchaseOrder(db);
  const created = await po.create({ partner_id: 1, company_id: 1, order_date: '2026-07-08', total_amount: 1000, budget_line_id: 5 });
  assert.strictEqual(created.id, 42);
  // Ensure commitment creation query executed
  const commitQuery = db.queries.find(q => q.sql.startsWith('INSERT INTO account_budget_commitments'));
  assert.ok(commitQuery, 'Commitment insert query not found');
  assert.strictEqual(commitQuery.params[0], 5);
  assert.strictEqual(commitQuery.params[3], 1000);
  console.log('✓ purchase_budget_integration_test passed');
}

run().catch(err => { console.error(err); process.exit(1); });

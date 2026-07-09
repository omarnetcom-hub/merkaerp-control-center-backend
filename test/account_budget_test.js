const assert = require('assert');
const { Budget, BudgetLine, BudgetCommitment } = require('../src/modules/account_budget/models/Budget');

class StubDb {
  constructor() {}
  async query(sql, params) {
    const s = sql.trim();
    if (s.startsWith('INSERT INTO account_budgets')) {
      return { rows: [{ id: 1, company_id: params[0], fiscal_year: params[1], name: params[2], state: params[3] }] };
    }
    if (s.startsWith('INSERT INTO account_budget_lines')) {
      return { rows: [{ id: 1, budget_id: params[0], code: params[1], name: params[2], account_id: params[3], initial_amount: params[4], available_amount: params[4] }] };
    }
    if (s.startsWith('INSERT INTO account_budget_commitments')) {
      return { rows: [{ id: 1, budget_line_id: params[0], origin_type: params[1], origin_id: params[2], amount: params[3], state: params[4] }] };
    }
    if (s.startsWith('SELECT * FROM account_budget_lines WHERE id')) {
      return { rows: [{ id: params[0], budget_id: 1, code: 'C1', name: 'Linea 1', available_amount: 1000 }] };
    }
    if (s.startsWith('SELECT * FROM account_budget_commitments WHERE id')) {
      return { rows: [{ id: params[0], budget_line_id: 1, origin_type: 'purchase_order', origin_id: 10, amount: 200, state: 'pending' }] };
    }
    if (s.startsWith('UPDATE account_budget_commitments SET state')) {
      return { rows: [{ id: params[1], state: params[0] }] };
    }
    if (s.startsWith('UPDATE account_budget_lines')) {
      return { rows: [{ id: params[3], appropriated_amount: 0, committed_amount: params[1], executed_amount: 0, available_amount: 1000 - params[1] }] };
    }
    return { rows: [] };
  }
}

async function run() {
  const db = new StubDb();
  const budget = new Budget(db);
  const b = await budget.create({ company_id: 1, fiscal_year: 2026, name: 'Presupuesto 2026' });
  assert.strictEqual(b.fiscal_year, 2026);

  const lineModel = new BudgetLine(db);
  const line = await lineModel.create({ budget_id: 1, code: 'C1', name: 'Linea 1', account_id: 1, initial_amount: 1000 });
  assert.strictEqual(line.initial_amount, 1000);

  const commitModel = new BudgetCommitment(db);
  const commit = await commitModel.create({ budget_line_id: 1, origin_type: 'purchase_order', origin_id: 10, amount: 200 });
  assert.strictEqual(commit.amount, 200);

  // Confirm flow: simple simulation
  const found = await commitModel.findById(1);
  assert.ok(found);

  await commitModel.updateState(1, 'confirmed');
  const updatedLine = await lineModel.updateAmounts(1, { committed: 200 });
  assert.strictEqual(updatedLine.committed_amount, 200);

  console.log('✓ account_budget_test passed');
}

run().catch(err => { console.error('Test failed', err); process.exit(1); });

class Budget {
  constructor(db) {
    this.db = db;
    this.table = 'account_budgets';
  }

  async create(data) {
    const { company_id, fiscal_year, name, state = 'draft' } = data;
    const query = `
      INSERT INTO ${this.table} (company_id, fiscal_year, name, state, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING *
    `;
    const result = await this.db.query(query, [company_id, fiscal_year, name, state]);
    return result.rows[0];
  }

  async findById(id) {
    const query = `SELECT * FROM ${this.table} WHERE id = $1`;
    const result = await this.db.query(query, [id]);
    return result.rows[0];
  }

  async list(fiscal_year = null, limit = 100, offset = 0) {
    const conditions = [];
    const values = [];
    let idx = 1;
    if (fiscal_year) {
      conditions.push(`fiscal_year = $${idx}`);
      values.push(fiscal_year);
      idx++;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `SELECT * FROM ${this.table} ${where} ORDER BY fiscal_year DESC LIMIT $${idx} OFFSET $${idx + 1}`;
    values.push(limit, offset);
    const result = await this.db.query(query, values);
    return result.rows;
  }

  async update(id, data) {
    const fields = [];
    const values = [];
    let param = 1;
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) {
        fields.push(`${k} = $${param}`);
        values.push(v);
        param++;
      }
    }
    if (!fields.length) return this.findById(id);
    values.push(id);
    const query = `UPDATE ${this.table} SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${param} RETURNING *`;
    const result = await this.db.query(query, values);
    return result.rows[0];
  }
}

class BudgetLine {
  constructor(db) {
    this.db = db;
    this.table = 'account_budget_lines';
  }

  async create(data) {
    const { budget_id, code, name, account_id, initial_amount = 0 } = data;
    const query = `
      INSERT INTO ${this.table} (budget_id, code, name, account_id, initial_amount, appropriated_amount, committed_amount, executed_amount, available_amount, created_at)
      VALUES ($1, $2, $3, $4, $5, 0, 0, 0, $5, NOW())
      RETURNING *
    `;
    const result = await this.db.query(query, [budget_id, code, name, account_id, initial_amount]);
    return result.rows[0];
  }

  async findById(id) {
    const query = `SELECT * FROM ${this.table} WHERE id = $1`;
    const result = await this.db.query(query, [id]);
    return result.rows[0];
  }

  async listByBudget(budgetId) {
    const query = `SELECT * FROM ${this.table} WHERE budget_id = $1 ORDER BY code`;
    const result = await this.db.query(query, [budgetId]);
    return result.rows;
  }

  async updateAmounts(id, deltas) {
    const { appropriated = 0, committed = 0, executed = 0 } = deltas;
    const query = `
      UPDATE ${this.table}
      SET appropriated_amount = appropriated_amount + $1,
          committed_amount = committed_amount + $2,
          executed_amount = executed_amount + $3,
          available_amount = available_amount - $2 - $3,
          updated_at = NOW()
      WHERE id = $4 RETURNING *
    `;
    const result = await this.db.query(query, [appropriated, committed, executed, id]);
    return result.rows[0];
  }
}

class BudgetCommitment {
  constructor(db) {
    this.db = db;
    this.table = 'account_budget_commitments';
  }

  async create(data) {
    const { budget_line_id, origin_type, origin_id, amount, state = 'pending' } = data;
    const query = `
      INSERT INTO ${this.table} (budget_line_id, origin_type, origin_id, amount, state, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *
    `;
    const result = await this.db.query(query, [budget_line_id, origin_type, origin_id, amount, state]);
    return result.rows[0];
  }

  async findById(id) {
    const query = `SELECT * FROM ${this.table} WHERE id = $1`;
    const result = await this.db.query(query, [id]);
    return result.rows[0];
  }

  async updateState(id, state) {
    const query = `UPDATE ${this.table} SET state = $1, updated_at = NOW() WHERE id = $2 RETURNING *`;
    const result = await this.db.query(query, [state, id]);
    return result.rows[0];
  }
}

module.exports = { Budget, BudgetLine, BudgetCommitment };

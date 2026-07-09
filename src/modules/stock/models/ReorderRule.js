class ReorderRule {
  constructor(db) {
    this.db = db;
    this.table = 'reorder_rules';
  }

  async listActiveForProduct(productId, companyId) {
    const q = `SELECT * FROM ${this.table} WHERE product_id = $1 AND company_id = $2 AND active = true`;
    const res = await this.db.query(q, [productId, companyId]);
    return res.rows;
  }

  async create(rule) {
    const { company_id, product_id, warehouse_id, min_qty, max_qty, multiple } = rule;
    const q = `INSERT INTO ${this.table} (company_id, product_id, warehouse_id, min_qty, max_qty, multiple, active, created_at) VALUES ($1,$2,$3,$4,$5,$6, true, NOW()) RETURNING *`;
    const res = await this.db.query(q, [company_id, product_id, warehouse_id, min_qty, max_qty, multiple]);
    return res.rows[0];
  }
}

module.exports = ReorderRule;

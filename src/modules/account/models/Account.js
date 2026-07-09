class Account {
  constructor(db) {
    this.db = db;
    this.table = 'account_accounts';
  }

  async create(accountData) {
    const { name, code, account_type, active = true } = accountData;
    const query = `
      INSERT INTO ${this.table} (name, code, account_type, active, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING *
    `;
    const result = await this.db.query(query, [name, code, account_type, active]);
    return result.rows[0];
  }

  async findById(id) {
    const query = `SELECT * FROM ${this.table} WHERE id = $1`;
    const result = await this.db.query(query, [id]);
    return result.rows[0];
  }

  async findByCode(code) {
    const query = `SELECT * FROM ${this.table} WHERE code = $1`;
    const result = await this.db.query(query, [code]);
    return result.rows[0];
  }

  async update(id, accountData) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(accountData)) {
      if (value !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(value);
        paramCount++;
      }
    }

    if (!fields.length) {
      return this.findById(id);
    }

    values.push(id);
    const query = `
      UPDATE ${this.table}
      SET ${fields.join(', ')}, updated_at = NOW()
      WHERE id = $${paramCount}
      RETURNING *
    `;
    const result = await this.db.query(query, values);
    return result.rows[0];
  }

  async list(active = true, limit = 100, offset = 0) {
    const query = `
      SELECT * FROM ${this.table}
      WHERE active = $1
      ORDER BY code ASC
      LIMIT $2 OFFSET $3
    `;
    const result = await this.db.query(query, [active, limit, offset]);
    return result.rows;
  }
}

module.exports = Account;

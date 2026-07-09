class Journal {
  constructor(db) {
    this.db = db;
    this.table = 'account_journals';
  }

  async create(journalData) {
    const { name, code, type, company_id, active = true } = journalData;
    const query = `
      INSERT INTO ${this.table} (name, code, type, company_id, active, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *
    `;
    const result = await this.db.query(query, [name, code, type, company_id, active]);
    return result.rows[0];
  }

  async findById(id) {
    const query = `SELECT * FROM ${this.table} WHERE id = $1`;
    const result = await this.db.query(query, [id]);
    return result.rows[0];
  }

  async findByCode(code) {
    const query = `SELECT * FROM ${this.table} WHERE code = $1 AND active = true`;
    const result = await this.db.query(query, [code]);
    return result.rows[0];
  }

  async update(id, journalData) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(journalData)) {
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

  async list(companyId = null, active = true, limit = 100, offset = 0) {
    const query = `
      SELECT * FROM ${this.table}
      WHERE active = $1
      ${companyId ? 'AND company_id = $2' : ''}
      ORDER BY name ASC
      LIMIT $${companyId ? 3 : 2} OFFSET $${companyId ? 4 : 3}
    `;
    const values = companyId ? [active, companyId, limit, offset] : [active, limit, offset];
    const result = await this.db.query(query, values);
    return result.rows;
  }
}

module.exports = Journal;

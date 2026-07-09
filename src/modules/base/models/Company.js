class Company {
  constructor(db) {
    this.db = db;
    this.table = 'res_companies';
  }

  async create(companyData) {
    const { name, email, phone, website, currency_id, country_id, state, city, street, zip_code, active = true } = companyData;
    
    const query = `
      INSERT INTO ${this.table} (name, email, phone, website, currency_id, country_id, state, city, street, zip_code, active, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      RETURNING *
    `;
    
    const result = await this.db.query(query, [name, email, phone, website, currency_id, country_id, state, city, street, zip_code, active]);
    return result.rows[0];
  }

  async findById(id) {
    const query = `SELECT * FROM ${this.table} WHERE id = $1`;
    const result = await this.db.query(query, [id]);
    return result.rows[0];
  }

  async update(id, companyData) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(companyData)) {
      if (value !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(value);
        paramCount++;
      }
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

  async list(limit = 100, offset = 0) {
    const query = `
      SELECT * FROM ${this.table}
      WHERE active = true
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `;
    const result = await this.db.query(query, [limit, offset]);
    return result.rows;
  }

  async delete(id) {
    // Soft delete (marcar como inactivo)
    const query = `UPDATE ${this.table} SET active = false WHERE id = $1`;
    await this.db.query(query, [id]);
    return { success: true };
  }
}

module.exports = Company;

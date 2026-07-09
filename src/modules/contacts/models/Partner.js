class Partner {
  constructor(db) {
    this.db = db;
    this.table = 'res_partners';
  }

  async create(partnerData) {
    const { name, email, phone, mobile, website, street, city, state, zip_code, country_id, partner_type = 'contact', is_company = false, active = true } = partnerData;
    
    const query = `
      INSERT INTO ${this.table} (name, email, phone, mobile, website, street, city, state, zip_code, country_id, partner_type, is_company, active, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
      RETURNING *
    `;
    
    const result = await this.db.query(query, [name, email, phone, mobile, website, street, city, state, zip_code, country_id, partner_type, is_company, active]);
    return result.rows[0];
  }

  async findById(id) {
    const query = `SELECT * FROM ${this.table} WHERE id = $1`;
    const result = await this.db.query(query, [id]);
    return result.rows[0];
  }

  async findByEmail(email) {
    const query = `SELECT * FROM ${this.table} WHERE email = $1`;
    const result = await this.db.query(query, [email]);
    return result.rows;
  }

  async update(id, partnerData) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(partnerData)) {
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

  async list(partnerType, limit = 100, offset = 0) {
    const query = `
      SELECT * FROM ${this.table}
      WHERE active = true AND partner_type = $1
      ORDER BY name ASC
      LIMIT $2 OFFSET $3
    `;
    const result = await this.db.query(query, [partnerType, limit, offset]);
    return result.rows;
  }

  async listByType(partnerType) {
    const query = `SELECT * FROM ${this.table} WHERE partner_type = $1 AND active = true ORDER BY name`;
    const result = await this.db.query(query, [partnerType]);
    return result.rows;
  }

  async delete(id) {
    const query = `UPDATE ${this.table} SET active = false WHERE id = $1`;
    await this.db.query(query, [id]);
    return { success: true };
  }

  async getCustomers(limit = 100, offset = 0) {
    return this.list('customer', limit, offset);
  }

  async getSuppliers(limit = 100, offset = 0) {
    return this.list('supplier', limit, offset);
  }

  async getContacts(limit = 100, offset = 0) {
    return this.list('contact', limit, offset);
  }
}

module.exports = Partner;

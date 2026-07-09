class Product {
  constructor(db) {
    this.db = db;
    this.table = 'product_products';
  }

  async create(productData) {
    const { name, code, category_id, type = 'product', price, cost, description, uom_id = 1, active = true, tracking = 'none' } = productData;
    
    const query = `
      INSERT INTO ${this.table} (name, code, category_id, type, price, cost, description, uom_id, active, tracking, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING *
    `;
    
    const result = await this.db.query(query, [name, code, category_id, type, price, cost, description, uom_id, active, tracking]);
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

  async update(id, productData) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(productData)) {
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
      ORDER BY name ASC
      LIMIT $1 OFFSET $2
    `;
    const result = await this.db.query(query, [limit, offset]);
    return result.rows;
  }

  async listByCategory(categoryId, limit = 100, offset = 0) {
    const query = `
      SELECT * FROM ${this.table}
      WHERE category_id = $1 AND active = true
      ORDER BY name ASC
      LIMIT $2 OFFSET $3
    `;
    const result = await this.db.query(query, [categoryId, limit, offset]);
    return result.rows;
  }

  async search(searchTerm, limit = 50) {
    const query = `
      SELECT * FROM ${this.table}
      WHERE (name ILIKE $1 OR code ILIKE $1) AND active = true
      LIMIT $2
    `;
    const result = await this.db.query(query, [`%${searchTerm}%`, limit]);
    return result.rows;
  }

  async delete(id) {
    const query = `UPDATE ${this.table} SET active = false WHERE id = $1`;
    await this.db.query(query, [id]);
    return { success: true };
  }

  async getVariants(productId) {
    const query = `SELECT * FROM product_products WHERE parent_id = $1`;
    const result = await this.db.query(query, [productId]);
    return result.rows;
  }
}

module.exports = Product;

class SaleOrder {
  constructor(db) {
    this.db = db;
    this.table = 'sale_orders';
  }

  async create(orderData) {
    const { partner_id, company_id, order_date, state = 'draft', currency_id, user_id, total_amount = 0 } = orderData;
    
    const query = `
      INSERT INTO ${this.table} (partner_id, company_id, order_date, state, currency_id, user_id, total_amount, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING *
    `;
    
    const result = await this.db.query(query, [partner_id, company_id, order_date, state, currency_id, user_id, total_amount]);
    return result.rows[0];
  }

  async findById(id) {
    const query = `SELECT * FROM ${this.table} WHERE id = $1`;
    const result = await this.db.query(query, [id]);
    return result.rows[0];
  }

  async findByPartner(partnerId, limit = 100, offset = 0) {
    const query = `
      SELECT * FROM ${this.table}
      WHERE partner_id = $1
      ORDER BY order_date DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await this.db.query(query, [partnerId, limit, offset]);
    return result.rows;
  }

  async update(id, orderData) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(orderData)) {
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

  async confirm(id) {
    const query = `UPDATE ${this.table} SET state = 'confirmed' WHERE id = $1 RETURNING *`;
    const result = await this.db.query(query, [id]);
    return result.rows[0];
  }

  async cancel(id) {
    const query = `UPDATE ${this.table} SET state = 'cancelled' WHERE id = $1 RETURNING *`;
    const result = await this.db.query(query, [id]);
    return result.rows[0];
  }

  async list(state, limit = 100, offset = 0) {
    const query = `
      SELECT * FROM ${this.table}
      WHERE state = $1
      ORDER BY order_date DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await this.db.query(query, [state, limit, offset]);
    return result.rows;
  }
}

class SaleOrderLine {
  constructor(db) {
    this.db = db;
    this.table = 'sale_order_lines';
  }

  async create(lineData) {
    const { order_id, product_id, quantity, price_unit, subtotal = 0 } = lineData;
    
    const query = `
      INSERT INTO ${this.table} (order_id, product_id, quantity, price_unit, subtotal, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *
    `;
    
    const result = await this.db.query(query, [order_id, product_id, quantity, price_unit, subtotal]);
    return result.rows[0];
  }

  async getOrderLines(orderId) {
    const query = `
      SELECT * FROM ${this.table}
      WHERE order_id = $1
      ORDER BY sequence
    `;
    const result = await this.db.query(query, [orderId]);
    return result.rows;
  }

  async update(id, lineData) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(lineData)) {
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

  async delete(id) {
    const query = `DELETE FROM ${this.table} WHERE id = $1`;
    await this.db.query(query, [id]);
    return { success: true };
  }
}

module.exports = { SaleOrder, SaleOrderLine };

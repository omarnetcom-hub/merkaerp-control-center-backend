class StockMove {
  constructor(db) {
    this.db = db;
    this.table = 'stock_moves';
  }

  async create(moveData) {
    const { product_id, quantity, source_location_id, destination_location_id, move_type, origin, state = 'draft' } = moveData;
    
    const query = `
      INSERT INTO ${this.table} (product_id, quantity, source_location_id, destination_location_id, move_type, origin, state, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING *
    `;

    console.log('DEBUG StockMove.create', { product_id, quantity, source_location_id, destination_location_id, move_type, origin, state });
    const result = await this.db.query(query, [product_id, quantity, source_location_id, destination_location_id, move_type, origin, state]);
    console.log('DEBUG StockMove.create result', result);
    return result.rows ? result.rows[0] : null;
  }

  async findById(id) {
    const query = `SELECT * FROM ${this.table} WHERE id = $1`;
    const result = await this.db.query(query, [id]);
    return result.rows[0];
  }

  async update(id, moveData) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(moveData)) {
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

  async listByState(state, limit = 100, offset = 0) {
    const query = `
      SELECT * FROM ${this.table}
      WHERE state = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await this.db.query(query, [state, limit, offset]);
    return result.rows;
  }

  async getProductQuantity(productId, locationId) {
    const query = `
      SELECT COALESCE(SUM(quantity), 0) as total
      FROM ${this.table}
      WHERE product_id = $1 AND destination_location_id = $2 AND state = 'done'
    `;
    const result = await this.db.query(query, [productId, locationId]);
    return result.rows[0].total;
  }

  async validateMove(id) {
    const query = `UPDATE ${this.table} SET state = 'done' WHERE id = $1 RETURNING *`;
    const result = await this.db.query(query, [id]);
    return result.rows[0];
  }
}

class Location {
  constructor(db) {
    this.db = db;
    this.table = 'stock_locations';
  }

  async create(locationData) {
    const { name, location_type = 'internal', active = true, warehouse_id } = locationData;
    
    const query = `
      INSERT INTO ${this.table} (name, location_type, active, warehouse_id, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING *
    `;
    
    const result = await this.db.query(query, [name, location_type, active, warehouse_id]);
    return result.rows[0];
  }

  async list(limit = 100) {
    const query = `SELECT * FROM ${this.table} WHERE active = true LIMIT $1`;
    const result = await this.db.query(query, [limit]);
    return result.rows;
  }

  async findById(id) {
    const query = `SELECT * FROM ${this.table} WHERE id = $1`;
    const result = await this.db.query(query, [id]);
    return result.rows[0];
  }
}

module.exports = { StockMove, Location };

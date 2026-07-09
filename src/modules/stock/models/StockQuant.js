class StockQuant {
  constructor(db) {
    this.db = db;
    this.table = 'stock_quants';
  }

  async getQuantity(productId, locationId, lotId = null) {
    const q = `SELECT COALESCE(SUM(quantity),0) as total FROM ${this.table} WHERE product_id = $1 AND location_id = $2 ${lotId ? 'AND lot_id = $3' : ''}`;
    const params = lotId ? [productId, locationId, lotId] : [productId, locationId];
    const res = await this.db.query(q, params);
    return res.rows[0].total;
  }

  async adjustQuant(productId, locationId, deltaQty, unitCost = 0, lotId = null) {
    // Try update existing quant
    const selectQ = `SELECT id, quantity FROM ${this.table} WHERE product_id = $1 AND location_id = $2 ${lotId ? 'AND lot_id = $3' : ''} LIMIT 1`;
    const params = lotId ? [productId, locationId, lotId] : [productId, locationId];
    const res = await this.db.query(selectQ, params);
    // Upsert quant row and return new quantity
    const existing = await this.db.queryGet(`SELECT * FROM ${this.table} WHERE product_id = $1 AND location_id = $2`, [productId, locationId]);
    if (!existing) {
      const ins = await this.db.query(`INSERT INTO ${this.table} (product_id, location_id, quantity, created_at) VALUES ($1,$2,$3,NOW()) RETURNING id`, [productId, locationId, deltaQty]);
      return { id: ins.insertId || null, quantity: deltaQty };
    } else {
      await this.db.query(`UPDATE ${this.table} SET quantity = $1, updated_at = NOW() WHERE id = $2`, [Number(existing.quantity) + Number(deltaQty), existing.id]);
      return { id: existing.id, quantity: Number(existing.quantity) + Number(deltaQty) };
    }
  }
}

module.exports = StockQuant;

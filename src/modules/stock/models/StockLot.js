class StockLot {
  constructor(db) {
    this.db = db;
    this.table = 'stock_lots';
  }

  async create(lotData) {
    const { company_id, product_id, batch_number, serial_number, received_at, expires_at } = lotData;
    const q = `INSERT INTO ${this.table} (company_id, product_id, batch_number, serial_number, received_at, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW()) RETURNING *`;
    const res = await this.db.query(q, [company_id, product_id, batch_number, serial_number, received_at, expires_at]);
    return res.rows[0];
  }

  async findById(id) {
    const q = `SELECT * FROM ${this.table} WHERE id = $1`;
    const res = await this.db.query(q, [id]);
    return res.rows[0];
  }
}

module.exports = StockLot;

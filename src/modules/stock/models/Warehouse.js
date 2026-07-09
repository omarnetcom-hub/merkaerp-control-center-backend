class Warehouse {
  constructor(db) {
    this.db = db;
    this.table = 'warehouses';
  }

  async create(data) {
    const { company_id, name, address, default_location_id } = data;
    const q = `INSERT INTO ${this.table} (company_id, name, address, default_location_id, created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING *`;
    const res = await this.db.query(q, [company_id, name, address, default_location_id]);
    return res.rows[0];
  }

  async findById(id) {
    const q = `SELECT * FROM ${this.table} WHERE id = $1`;
    const res = await this.db.query(q, [id]);
    return res.rows[0];
  }
}

module.exports = Warehouse;

class User {
  constructor(dbAdapter) {
    this.db = dbAdapter;
    this.table = 'res_users';
  }

  async create(userData) {
    const { name, email, password, login, company_id, active = true } = userData;
    
    const sql = `
      INSERT INTO ${this.table} (name, email, password, login, company_id, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      RETURNING id, name, email, login, company_id, active, created_at
    `;
    
    const result = await this.db.query(sql, [name, email, password, login, company_id, active]);
    return result;
  }

  async findById(id) {
    const sql = `SELECT * FROM ${this.table} WHERE id = ?`;
    return await this.db.queryGet(sql, [id]);
  }

  async findByEmail(email) {
    const sql = `SELECT * FROM ${this.table} WHERE email = ?`;
    return await this.db.queryGet(sql, [email]);
  }

  async findByLogin(login) {
    const sql = `SELECT * FROM ${this.table} WHERE login = ?`;
    return await this.db.queryGet(sql, [login]);
  }

  async update(id, userData) {
    const updates = [];
    const values = [];

    for (const [key, value] of Object.entries(userData)) {
      if (value !== undefined) {
        updates.push(`${key} = ?`);
        values.push(value);
      }
    }

    values.push(id);
    const sql = `
      UPDATE ${this.table}
      SET ${updates.join(', ')}, updated_at = datetime('now')
      WHERE id = ?
    `;
    
    await this.db.query(sql, values);
    return this.findById(id);
  }

  async delete(id) {
    const sql = `DELETE FROM ${this.table} WHERE id = ?`;
    await this.db.query(sql, [id]);
    return { success: true };
  }

  async list(limit = 100, offset = 0) {
    const sql = `
      SELECT * FROM ${this.table}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;
    return await this.db.queryAll(sql, [limit, offset]);
  }

  async assignRole(userId, roleId) {
    const sql = `
      INSERT OR IGNORE INTO res_user_roles (user_id, role_id)
      VALUES (?, ?)
    `;
    await this.db.query(sql, [userId, roleId]);
    return { success: true };
  }

  async getUserRoles(userId) {
    const sql = `
      SELECT r.* FROM res_roles r
      INNER JOIN res_user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ?
    `;
    return await this.db.queryAll(sql, [userId]);
  }
}

module.exports = User;

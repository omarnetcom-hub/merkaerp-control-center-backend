class StockPicking {
  constructor(db) {
    this.db = db;
    this.table = 'stock_pickings';
    this.moveTable = 'stock_picking_moves';
  }

  async create(pickingData) {
    const { company_id, warehouse_id, picking_type, origin, scheduled_date, state = 'draft' } = pickingData;
    const q = `INSERT INTO ${this.table} (company_id, warehouse_id, picking_type, origin, state, scheduled_date, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW()) RETURNING *`;
    const res = await this.db.query(q, [company_id, warehouse_id, picking_type, origin, state, scheduled_date]);
    return res.rows[0];
  }

  async findById(id) {
    const q = `SELECT * FROM ${this.table} WHERE id = $1`;
    const res = await this.db.query(q, [id]);
    return res.rows[0];
  }

  async addMove(pickingId, moveId, sequence = 0) {
    const q = `INSERT INTO ${this.moveTable} (picking_id, move_id, sequence, created_at) VALUES ($1,$2,$3,NOW()) RETURNING *`;
    const res = await this.db.query(q, [pickingId, moveId, sequence]);
    return res.rows[0];
  }

  async listByState(state, limit = 100) {
    const q = `SELECT * FROM ${this.table} WHERE state = $1 ORDER BY created_at DESC LIMIT $2`;
    const res = await this.db.query(q, [state, limit]);
    return res.rows;
  }

  async confirm(pickingId) {
    // Mark picking as done and validate moves
    const client = this.db;
    const picking = await this.findById(pickingId);
    if (!picking) throw new Error('Picking not found');

    // update state
    const uq = `UPDATE ${this.table} SET state = 'done', updated_at = NOW() WHERE id = $1`;
    await client.query(uq, [pickingId]);

    // validate moves linked to this picking
    const mq = `SELECT m.* FROM ${this.moveTable} pm JOIN stock_moves m ON pm.move_id = m.id WHERE pm.picking_id = $1`;
    const moves = await client.queryAll(mq, [pickingId]);
    const StockQuant = require('./StockQuant');
    const quantModel = new StockQuant(client);
    for (const r of moves) {
      await client.query(`UPDATE stock_moves SET state = 'done', updated_at = NOW() WHERE id = $1`, [r.id]);

      // Adjust quants: subtract from source, add to destination
      try {
        if (r.source_location_id) await quantModel.adjustQuant(r.product_id, r.source_location_id, -Math.abs(Number(r.quantity)));
        if (r.destination_location_id) await quantModel.adjustQuant(r.product_id, r.destination_location_id, Math.abs(Number(r.quantity)));
      } catch (err) {
        console.error('Warning: failed to update stock_quants for move', r.id, err.message);
      }

      // Write audit record
      try {
        await client.query(`INSERT INTO stock_audit (company_id, user_id, action, entity_type, entity_id, payload, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())`, [picking.company_id || null, null, 'move_done', 'stock_move', String(r.id), JSON.stringify(r)]);
      } catch (err) {
        console.error('Warning: failed to write stock audit for move', r.id, err.message);
      }
    }

    return await this.findById(pickingId);
  }
}

module.exports = StockPicking;

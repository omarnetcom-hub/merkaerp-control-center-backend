class PurchaseOrder {
  constructor(db) {
    this.db = db;
    this.table = 'purchase_orders';
  }

  setDatabase(db) {
    this.db = db;
  }

  async create(orderData) {
    const { partner_id, company_id, order_date, state = 'draft', currency_id, user_id, total_amount = 0, budget_line_id = null } = orderData;

    const query = `
      INSERT INTO ${this.table} (partner_id, company_id, order_date, state, currency_id, user_id, total_amount, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING *
    `;

    const result = await this.db.query(query, [partner_id, company_id, order_date, state, currency_id, user_id, total_amount]);
    const created = result.rows[0];

    // If a budget_line_id is provided, create a pending BudgetCommitment linked to this purchase order
    if (budget_line_id) {
      try {
        const { BudgetCommitment } = require('../../account_budget/models/Budget');
        const commitmentModel = new BudgetCommitment(this.db);
        await commitmentModel.create({ budget_line_id, origin_type: 'purchase_order', origin_id: created.id, amount: total_amount, state: 'pending' });
      } catch (err) {
        // Log but do not fail the purchase creation to preserve backward compatibility
        console.error('Warning: failed to create budget commitment for purchase order', err.message);
      }
    }

    return created;
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
    const query = `UPDATE ${this.table} SET state = 'confirmed', updated_at = NOW() WHERE id = $1 RETURNING *`;
    const result = await this.db.query(query, [id]);
    const order = result.rows[0];

    // Try to confirm related budget commitment (if any)
    try {
      const { BudgetCommitment, BudgetLine } = require('../../account_budget/models/Budget');
      const commitmentModel = new BudgetCommitment(this.db);
      const lineModel = new BudgetLine(this.db);

      // Find latest pending commitment for this purchase order
      const findQuery = `SELECT * FROM account_budget_commitments WHERE origin_type = 'purchase_order' AND origin_id = $1 ORDER BY created_at DESC LIMIT 1`;
      const findRes = await this.db.query(findQuery, [id]);
      const commitment = findRes.rows[0];
      if (commitment && commitment.state === 'pending') {
        await commitmentModel.updateState(commitment.id, 'confirmed');
        // Update amounts on the budget line (increase committed, reduce available)
        await lineModel.updateAmounts(commitment.budget_line_id, { committed: parseFloat(commitment.amount || 0) });
      }
    } catch (err) {
      // Preserve backward compatibility: log and continue
      console.error('Warning: could not auto-confirm budget commitment for purchase order', id, err.message);
    }

    return order;
  }

  async confirmWithPicking(id) {
    // Confirm the purchase order and create an incoming picking with moves
    const order = await this.confirm(id);

    try {
      // Load purchase lines
      const linesQ = `SELECT * FROM purchase_order_lines WHERE order_id = $1`;
      const linesRes = await this.db.query(linesQ, [id]);
      const lines = linesRes.rows || [];

      // Determine a warehouse/default location for the company (first one)
      const whQ = `SELECT * FROM warehouses WHERE company_id = $1 LIMIT 1`;
      const whRes = await this.db.query(whQ, [order.company_id]);
      const warehouse = whRes.rows ? whRes.rows[0] : null;
      let defaultLocationId = warehouse ? warehouse.default_location_id : null;

      if (!defaultLocationId) {
        const loc = require('../../stock/models/Stock').Location;
        const locationModel = new loc(this.db);
        const createdLocation = await locationModel.create({ name: 'Default Warehouse Location', location_type: 'internal', active: true, warehouse_id: warehouse ? warehouse.id : null });
        defaultLocationId = createdLocation.id;
      }

      const StockPicking = require('../../stock/models/StockPicking');
      const StockMove = require('../../stock/models/StockMove').StockMove;
      const pickingModel = new StockPicking(this.db);
      const moveModel = new StockMove(this.db);

      console.log('DEBUG: warehouse selected', warehouse, 'defaultLocationId', defaultLocationId);
      const picking = await pickingModel.create({ company_id: order.company_id, warehouse_id: warehouse ? warehouse.id : null, picking_type: 'incoming', origin: `purchase:${order.id}`, scheduled_date: order.order_date });
      console.log('DEBUG: picking created', picking);

      for (const ln of lines) {
        console.log('DEBUG: creating move for line', ln);
        const move = await moveModel.create({ product_id: ln.product_id, quantity: ln.quantity, source_location_id: null, destination_location_id: defaultLocationId, move_type: 'incoming', origin: `purchase:${order.id}`, state: 'draft' });
        await pickingModel.addMove(picking.id, move.id, ln.sequence || 0);
      }
    } catch (err) {
      // Keep behavior non-fatal: log and continue
      console.error('Warning: failed to create picking for purchase order', id, err.message);
    }

    return order;
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

class PurchaseOrderLine {
  constructor(db) {
    this.db = db;
    this.table = 'purchase_order_lines';
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

module.exports = { PurchaseOrder, PurchaseOrderLine };

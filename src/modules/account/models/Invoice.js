class Invoice {
  constructor(db) {
    this.db = db;
    this.table = 'account_invoices';
  }

  setDatabase(db) {
    this.db = db;
  }

  async create(invoiceData) {
    const {
      partner_id,
      company_id,
      invoice_date,
      due_date,
      state = 'draft',
      currency_id,
      invoice_type = 'out_invoice',
      reference,
      total_amount = 0,
      edi_status = 'not_requested',
      public_sector_document_type = null,
      contract_reference = null,
      budget_item_code = null,
      sector_entity_type = null,
      dian_resolution = null,
      environment = null
    } = invoiceData;

    const query = `
      INSERT INTO ${this.table} (
        partner_id, company_id, invoice_date, due_date, state,
        currency_id, invoice_type, reference, total_amount,
        edi_status, public_sector_document_type, contract_reference,
        budget_item_code, sector_entity_type, dian_resolution, environment, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
      RETURNING *
    `;

    const values = [
      partner_id,
      company_id,
      invoice_date,
      due_date,
      state,
      currency_id,
      invoice_type,
      reference,
      total_amount,
      edi_status,
      public_sector_document_type,
      contract_reference,
      budget_item_code,
      sector_entity_type,
      dian_resolution,
      environment
    ];

    const result = await this.db.query(query, values);
    return result.rows[0];
  }

  async findById(id) {
    const query = `SELECT * FROM ${this.table} WHERE id = $1`;
    const result = await this.db.query(query, [id]);
    return result.rows[0];
  }

  async findByIdWithLines(id) {
    const invoice = await this.findById(id);
    if (!invoice) {
      return null;
    }
    const linesQuery = `SELECT * FROM account_invoice_lines WHERE invoice_id = $1 ORDER BY sequence`;
    const linesResult = await this.db.query(linesQuery, [id]);
    invoice.lines = linesResult.rows;
    return invoice;
  }

  async findByReference(reference) {
    const query = `SELECT * FROM ${this.table} WHERE reference = $1`;
    const result = await this.db.query(query, [reference]);
    return result.rows[0];
  }

  async findByPartner(partnerId, limit = 100, offset = 0) {
    const query = `
      SELECT * FROM ${this.table}
      WHERE partner_id = $1
      ORDER BY invoice_date DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await this.db.query(query, [partnerId, limit, offset]);
    return result.rows;
  }

  async update(id, invoiceData) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(invoiceData)) {
      if (value !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(value);
        paramCount++;
      }
    }

    if (fields.length === 0) {
      return this.findById(id);
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

  async setEdiStatus(id, status) {
    const query = `UPDATE ${this.table} SET edi_status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`;
    const result = await this.db.query(query, [status, id]);
    return result.rows[0];
  }

  async prepareEdi(id, ediData) {
    const {
      dian_resolution,
      environment = 'production',
      public_sector_document_type,
      contract_reference,
      budget_item_code,
      sector_entity_type
    } = ediData;

    const query = `
      UPDATE ${this.table}
      SET edi_status = 'edi_prepared',
          dian_resolution = $1,
          environment = $2,
          public_sector_document_type = $3,
          contract_reference = $4,
          budget_item_code = $5,
          sector_entity_type = $6,
          updated_at = NOW()
      WHERE id = $7
      RETURNING *
    `;

    const values = [
      dian_resolution,
      environment,
      public_sector_document_type,
      contract_reference,
      budget_item_code,
      sector_entity_type,
      id
    ];

    const result = await this.db.query(query, values);
    return result.rows[0];
  }

  async sendEdi(id, responseMessage = null) {
    const query = `
      UPDATE ${this.table}
      SET edi_status = 'edi_sent',
          updated_at = NOW(),
          environment = COALESCE(environment, 'production'),
          public_sector_document_type = COALESCE(public_sector_document_type, public_sector_document_type),
          contract_reference = COALESCE(contract_reference, contract_reference),
          budget_item_code = COALESCE(budget_item_code, budget_item_code),
          sector_entity_type = COALESCE(sector_entity_type, sector_entity_type)
      WHERE id = $1
      RETURNING *
    `;

    const result = await this.db.query(query, [id]);
    return result.rows[0];
  }

  async validate(id) {
    const query = `UPDATE ${this.table} SET state = 'posted', updated_at = NOW() WHERE id = $1 RETURNING *`;
    const result = await this.db.query(query, [id]);
    return result.rows[0];
  }

  async post(id) {
    const query = `UPDATE ${this.table} SET state = 'posted', updated_at = NOW() WHERE id = $1 RETURNING *`;
    const result = await this.db.query(query, [id]);
    return result.rows[0];
  }

  async cancel(id) {
    const query = `UPDATE ${this.table} SET state = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING *`;
    const result = await this.db.query(query, [id]);
    return result.rows[0];
  }

  async recalculateTotal(invoiceId) {
    const sumQuery = `SELECT COALESCE(SUM(subtotal), 0) AS total FROM account_invoice_lines WHERE invoice_id = $1`;
    const sumResult = await this.db.query(sumQuery, [invoiceId]);
    const total = sumResult.rows[0]?.total || 0;

    const updateQuery = `UPDATE ${this.table} SET total_amount = $1, updated_at = NOW() WHERE id = $2 RETURNING *`;
    const result = await this.db.query(updateQuery, [total, invoiceId]);
    return result.rows[0];
  }

  async list(state, limit = 100, offset = 0) {
    const query = `
      SELECT * FROM ${this.table}
      WHERE state = $1
      ORDER BY invoice_date DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await this.db.query(query, [state, limit, offset]);
    return result.rows;
  }
}

class InvoiceLine {
  constructor(db) {
    this.db = db;
    this.table = 'account_invoice_lines';
  }

  setDatabase(db) {
    this.db = db;
  }

  async create(lineData) {
    const {
      invoice_id,
      product_id,
      account_id,
      quantity,
      price_unit,
      subtotal = 0,
      tax_ids,
      service_rip_code = null,
      glosa_reference = null,
      sequence = 0
    } = lineData;

    const query = `
      INSERT INTO ${this.table} (
        invoice_id, product_id, account_id, quantity,
        price_unit, subtotal, tax_ids, service_rip_code,
        glosa_reference, sequence, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING *
    `;

    const result = await this.db.query(query, [
      invoice_id,
      product_id,
      account_id,
      quantity,
      price_unit,
      subtotal,
      JSON.stringify(tax_ids || []),
      service_rip_code,
      glosa_reference,
      sequence
    ]);
    return result.rows[0];
  }

  async getInvoiceLines(invoiceId) {
    const query = `
      SELECT * FROM ${this.table}
      WHERE invoice_id = $1
      ORDER BY sequence
    `;
    const result = await this.db.query(query, [invoiceId]);
    return result.rows;
  }

  async update(id, lineData) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(lineData)) {
      if (value !== undefined) {
        if (key === 'tax_ids') {
          fields.push(`${key} = $${paramCount}`);
          values.push(JSON.stringify(value));
        } else {
          fields.push(`${key} = $${paramCount}`);
          values.push(value);
        }
        paramCount++;
      }
    }

    if (fields.length === 0) {
      const query = `SELECT * FROM ${this.table} WHERE id = $1`;
      const result = await this.db.query(query, [id]);
      return result.rows[0];
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

class ElectronicInvoiceDocument {
  constructor(db) {
    this.db = db;
    this.table = 'account_edi_documents';
  }

  setDatabase(db) {
    this.db = db;
  }

  async create(documentData) {
    const {
      invoice_id,
      dian_uuid,
      cufe,
      resolution_number,
      environment = 'production',
      document_type = 'invoice',
      status = 'draft',
      xml_payload = null,
      json_payload = null,
      response_message = null
    } = documentData;

    const query = `
      INSERT INTO ${this.table} (
        invoice_id, dian_uuid, cufe, resolution_number,
        environment, document_type, status, xml_payload,
        json_payload, response_message, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING *
    `;

    const values = [
      invoice_id,
      dian_uuid,
      cufe,
      resolution_number,
      environment,
      document_type,
      status,
      xml_payload,
      json_payload,
      response_message
    ];

    const result = await this.db.query(query, values);
    return result.rows[0];
  }

  async findByInvoiceId(invoiceId) {
    const query = `SELECT * FROM ${this.table} WHERE invoice_id = $1 ORDER BY created_at DESC`;
    const result = await this.db.query(query, [invoiceId]);
    return result.rows;
  }

  async update(id, valuesData) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(valuesData)) {
      if (value !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(value);
        paramCount++;
      }
    }

    if (fields.length === 0) {
      const query = `SELECT * FROM ${this.table} WHERE id = $1`;
      const result = await this.db.query(query, [id]);
      return result.rows[0];
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
}

module.exports = { Invoice, InvoiceLine, ElectronicInvoiceDocument };

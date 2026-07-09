const assert = require('assert');
const { Invoice, InvoiceLine, ElectronicInvoiceDocument } = require('../src/modules/account/models/Invoice');
const Account = require('../src/modules/account/models/Account');
const Journal = require('../src/modules/account/models/Journal');

class StubDb {
  constructor() {
    this.queries = [];
  }

  async query(sql, params) {
    this.queries.push({ sql, params });
    if (sql.trim().startsWith('INSERT INTO account_accounts')) {
      return { rows: [{ id: 1, name: params[0], code: params[1], account_type: params[2], active: params[3] }] };
    }
    if (sql.trim().startsWith('INSERT INTO account_journals')) {
      return { rows: [{ id: 1, name: params[0], code: params[1], type: params[2], company_id: params[3], active: params[4] }] };
    }
    if (sql.trim().startsWith('INSERT INTO account_invoices')) {
      return { rows: [{ id: 1, partner_id: params[0], company_id: params[1], invoice_date: params[2], due_date: params[3], state: params[4], currency_id: params[5], invoice_type: params[6], reference: params[7], total_amount: params[8], edi_status: params[9] }] };
    }
    if (sql.trim().startsWith('INSERT INTO account_invoice_lines')) {
      return { rows: [{ id: 1, invoice_id: params[0], product_id: params[1], account_id: params[2], quantity: params[3], price_unit: params[4], subtotal: params[5], tax_ids: params[6], service_rip_code: params[7], glosa_reference: params[8], sequence: params[9] }] };
    }
    if (sql.trim().startsWith('INSERT INTO account_edi_documents')) {
      return { rows: [{ id: 1, invoice_id: params[0], dian_uuid: params[1], cufe: params[2], resolution_number: params[3], environment: params[4], document_type: params[5], status: params[6] }] };
    }
    if (sql.trim().startsWith('SELECT * FROM account_invoices WHERE id')) {
      return { rows: [{ id: params[0], partner_id: 1, company_id: 1, invoice_date: '2026-01-01', due_date: '2026-01-31', state: 'draft', currency_id: 1, invoice_type: 'out_invoice', reference: 'INV-1', total_amount: 0, edi_status: 'not_requested' }] };
    }
    if (sql.trim().startsWith('SELECT * FROM account_invoice_lines WHERE invoice_id')) {
      return { rows: [{ id: 1, invoice_id: params[0], product_id: 1, account_id: 1, quantity: 2, price_unit: 100, subtotal: 200, tax_ids: '[]', service_rip_code: null, glosa_reference: null, sequence: 0 }] };
    }
    if (sql.trim().startsWith('SELECT COALESCE(SUM(subtotal)')) {
      return { rows: [{ total: 200 }] };
    }
    if (sql.trim().startsWith('UPDATE account_invoices SET total_amount')) {
      return { rows: [{ id: params[1], total_amount: params[0] }] };
    }
    return { rows: [] };
  }
}

async function runTests() {
  const db = new StubDb();

  const accountModel = new Account(db);
  const account = await accountModel.create({ name: 'Caja Banco', code: '110101', account_type: 'asset' });
  assert.strictEqual(account.name, 'Caja Banco');
  assert.strictEqual(account.code, '110101');
  assert.strictEqual(account.account_type, 'asset');

  const journalModel = new Journal(db);
  const journal = await journalModel.create({ name: 'Ventas', code: 'VEN', type: 'sale', company_id: 1 });
  assert.strictEqual(journal.name, 'Ventas');
  assert.strictEqual(journal.code, 'VEN');
  assert.strictEqual(journal.type, 'sale');

  const invoiceModel = new Invoice(db);
  const invoice = await invoiceModel.create({ partner_id: 1, company_id: 1, invoice_date: '2026-01-01', due_date: '2026-01-31', currency_id: 1, invoice_type: 'out_invoice', reference: 'INV-1', total_amount: 1000, edi_status: 'not_requested', public_sector_document_type: 'FACTURA_PUBLICA', contract_reference: 'CON-123' });
  assert.strictEqual(invoice.reference, 'INV-1');
  assert.strictEqual(invoice.edi_status, 'not_requested');

  const lineModel = new InvoiceLine(db);
  const line = await lineModel.create({ invoice_id: 1, product_id: 1, account_id: 1, quantity: 2, price_unit: 100, subtotal: 200, tax_ids: [], service_rip_code: 'RIP-001', glosa_reference: 'GL-123' });
  assert.strictEqual(line.invoice_id, 1);
  assert.strictEqual(line.service_rip_code, 'RIP-001');

  const ediModel = new ElectronicInvoiceDocument(db);
  const edi = await ediModel.create({ invoice_id: 1, dian_uuid: 'UUID-1', cufe: 'CUFE-1', resolution_number: 'RES-1', environment: 'production', document_type: 'invoice', status: 'draft' });
  assert.strictEqual(edi.dian_uuid, 'UUID-1');
  assert.strictEqual(edi.status, 'draft');

  const invoiceWithLines = await invoiceModel.findByIdWithLines(1);
  assert.strictEqual(invoiceWithLines.lines.length, 1);

  await invoiceModel.recalculateTotal(1);

  console.log('✓ account_module_test passed');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

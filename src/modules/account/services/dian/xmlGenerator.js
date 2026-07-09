const { create } = require('xmlbuilder2');

exports.generateInvoiceXml = function(invoice) {
  // Generates a basic invoice XML. NOT XSD-compliant for DIAN — replace with mapping
  // from DIAN XSDs when available. Keeps a clear structure: header + lines.
  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('Invoice')
      .ele('Header')
        .ele('Id').txt(invoice.id || invoice.reference || 'N/A').up()
        .ele('IssueDate').txt(invoice.issue_date || invoice.date || new Date().toISOString()).up()
        .ele('Customer')
          .ele('Name').txt((invoice.customer && invoice.customer.name) || invoice.customer_name || '').up()
          .ele('TaxId').txt((invoice.customer && invoice.customer.tax_id) || invoice.customer_tax_id || '').up()
        .up()
        .ele('Totals')
          .ele('Subtotal').txt(String(invoice.subtotal || invoice.amount_untaxed || 0)).up()
          .ele('TaxTotal').txt(String(invoice.tax_total || invoice.amount_tax || 0)).up()
          .ele('Total').txt(String(invoice.total || invoice.amount_total || 0)).up()
        .up()
      .up();

  const lines = invoice.lines || invoice.invoice_lines || [];
  const xmlLines = root.ele('Lines');
  for (const ln of lines) {
    xmlLines.ele('Line')
      .ele('Sequence').txt(String(ln.sequence || ln.id || 0)).up()
      .ele('ProductCode').txt(ln.product_code || ln.product_id || '').up()
      .ele('Description').txt(ln.description || ln.product_name || '').up()
      .ele('Quantity').txt(String(ln.quantity || ln.qty || 0)).up()
      .ele('UnitPrice').txt(String(ln.unit_price || ln.price_unit || 0)).up()
      .ele('LineTotal').txt(String(ln.total || ln.subtotal || 0)).up()
    .up();
  }

  return root.end({ prettyPrint: true });
};

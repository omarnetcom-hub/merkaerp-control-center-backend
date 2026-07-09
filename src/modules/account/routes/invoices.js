const express = require('express');
const router = express.Router();
const { Invoice, InvoiceLine, ElectronicInvoiceDocument } = require('../models/Invoice');

const authMiddleware = require('../../../middleware/auth');

let db;
let invoiceModel;
let invoiceLineModel;
let ediDocumentModel;

function setDatabase(database) {
  db = database;
  invoiceModel = new Invoice(db);
  invoiceLineModel = new InvoiceLine(db);
  ediDocumentModel = new ElectronicInvoiceDocument(db);
}

// POST /api/invoices - Create invoice
router.post('/', authMiddleware, async (req, res) => {
  try {
    const invoice = await invoiceModel.create(req.body);
    res.status(201).json(invoice);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/invoices/reference/:reference - Get invoice by reference
router.get('/reference/:reference', authMiddleware, async (req, res) => {
  try {
    const invoice = await invoiceModel.findByReference(req.params.reference);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/invoices/partner/:partnerId - Get invoices by partner
router.get('/partner/:partnerId', authMiddleware, async (req, res) => {
  try {
    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;
    const invoices = await invoiceModel.findByPartner(req.params.partnerId, limit, offset);
    res.json(invoices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/invoices/:id - Get invoice
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const invoice = await invoiceModel.findByIdWithLines(req.params.id);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/invoices - List invoices by state
router.get('/', authMiddleware, async (req, res) => {
  try {
    const state = req.query.state || 'draft';
    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;
    const invoices = await invoiceModel.list(state, limit, offset);
    res.json(invoices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/invoices/:id - Update invoice
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const invoice = await invoiceModel.update(req.params.id, req.body);
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/invoices/:id/validate - Validate invoice
router.post('/:id/validate', authMiddleware, async (req, res) => {
  try {
    const invoice = await invoiceModel.validate(req.params.id);
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/invoices/:id/post - Post invoice
router.post('/:id/post', authMiddleware, async (req, res) => {
  try {
    const invoice = await invoiceModel.post(req.params.id);
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/invoices/:id/cancel - Cancel invoice
router.post('/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const invoice = await invoiceModel.cancel(req.params.id);
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/invoices/:id/lines - Add line to invoice
router.post('/:id/lines', authMiddleware, async (req, res) => {
  try {
    const {
      product_id,
      account_id,
      quantity,
      price_unit,
      tax_ids,
      service_rip_code,
      glosa_reference,
      sequence = 0
    } = req.body;
    const subtotal = quantity * price_unit;
    
    const line = await invoiceLineModel.create({
      invoice_id: req.params.id,
      product_id,
      account_id,
      quantity,
      price_unit,
      subtotal,
      tax_ids,
      service_rip_code,
      glosa_reference,
      sequence
    });

    await invoiceModel.recalculateTotal(req.params.id);
    res.status(201).json(line);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/invoices/:id/lines - Get invoice lines
router.get('/:id/lines', authMiddleware, async (req, res) => {
  try {
    const lines = await invoiceLineModel.getInvoiceLines(req.params.id);
    res.json(lines);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/invoices/lines/:lineId - Update invoice line
router.put('/lines/:lineId', authMiddleware, async (req, res) => {
  try {
    const line = await invoiceLineModel.update(req.params.lineId, req.body);
    if (line && line.invoice_id) {
      await invoiceModel.recalculateTotal(line.invoice_id);
    }
    res.json(line);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/invoices/:id/edi/prepare - Prepare DIAN electronic invoice metadata
router.post('/:id/edi/prepare', authMiddleware, async (req, res) => {
  try {
    const invoice = await invoiceModel.prepareEdi(req.params.id, req.body);
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/invoices/:id/edi/send - Mark invoice as sent to DIAN
router.post('/:id/edi/send', authMiddleware, async (req, res) => {
  try {
    const { document_id, status, response_message } = req.body;
    const invoice = await invoiceModel.sendEdi(req.params.id, response_message);

    if (document_id) {
      await invoiceModel.update(req.params.id, { edi_document_id: document_id });
    }

    if (status && document_id) {
      await ediDocumentModel.update(document_id, { status, response_message });
    }

    res.json(invoice);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/invoices/:id/edi/documents - Create or attach an electronic invoice document
router.post('/:id/edi/documents', authMiddleware, async (req, res) => {
  try {
    const documentData = {
      invoice_id: req.params.id,
      ...req.body
    };
    const document = await ediDocumentModel.create(documentData);
    await invoiceModel.update(req.params.id, { edi_document_id: document.id });
    res.status(201).json(document);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/invoices/:id/edi/documents - Get EDI documents for invoice
router.get('/:id/edi/documents', authMiddleware, async (req, res) => {
  try {
    const documents = await ediDocumentModel.findByInvoiceId(req.params.id);
    res.json(documents);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = { router, setDatabase };

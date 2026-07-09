const assert = require('assert');
const db = require('../src/database/db');
const StockPicking = require('../src/modules/stock/models/StockPicking');
const StockQuant = require('../src/modules/stock/models/StockQuant');
const Warehouse = require('../src/modules/stock/models/Warehouse');
const PurchaseModule = require('../src/modules/purchase/models/Purchase');
const Purchase = PurchaseModule.PurchaseOrder;

async function run() {
  console.log('Initializing DB...');
  await db.initializeDatabase();

  const client = db;

  // Crear warehouse
  const wh = new Warehouse(client);
  const wres = await wh.create({ name: 'Test WH', address: 'Test address', default_location_id: null });
  const warehouseId = wres && wres.id ? wres.id : (wres && wres.rows && wres.rows[0] && wres.rows[0].id) || wres.insertId || null;
  console.log('Warehouse created', warehouseId);

  // Crear producto y purchase order stub
  // Insert minimal product into product_products
  await db.query("INSERT INTO product_products (name, code, created_at) VALUES ($1,$2,NOW())", ['TestProduct', 'TP-001']);
  const prodRows = await db.queryAll("SELECT id FROM product_products WHERE name = $1 ORDER BY id DESC LIMIT 1", ['TestProduct']);
  const productId = prodRows && prodRows[0] && prodRows[0].id || null;

  // Crear purchase order
  const poRes = await db.query("INSERT INTO purchase_orders (origin, state, created_at) VALUES ($1,$2,NOW())", ['PO-TEST', 'draft']);
  const poId = poRes.insertId || (poRes.rows && poRes.rows[0] && poRes.rows[0].id) || null;
  await db.query("INSERT INTO purchase_order_lines (order_id, product_id, quantity, price_unit, created_at) VALUES ($1,$2,$3,$4,NOW())", [poId, productId, 5, 100]);

  // Verificar líneas creadas
  const linesCheck = await db.queryAll('SELECT * FROM purchase_order_lines WHERE order_id = $1', [poId]);
  console.log('Purchase lines:', linesCheck);

  // Confirm purchase using model method that should create picking
  const purchaseModel = new Purchase(client);
  const confirmRes = await purchaseModel.confirmWithPicking(poId);
  console.log('Purchase confirmed, result:', confirmRes);

  // Check pickings created
  const pickings = await db.queryAll('SELECT * FROM stock_pickings WHERE origin = $1', [`purchase:${poId}`]);
  assert(pickings.length >= 1, 'Expected at least one picking');
  const picking = pickings[0];

  // Confirm picking
  const pickingModel = new StockPicking(client);
  await pickingModel.confirm(picking.id);

  // Verify quants updated
  const quants = await db.queryAll('SELECT * FROM stock_quants WHERE product_id = $1', [productId]);
  assert(quants.length > 0, 'Expected quant record for product');

  console.log('Stock integration test passed');
}

run().catch(err => {
  console.error('Integration test failed:', err);
  process.exit(1);
});

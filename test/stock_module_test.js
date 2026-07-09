const assert = require('assert');

// Basic tests for stock models (DB calls are expected to be stubbed in CI)
(async () => {
  // smoke test: require modules
  const StockPicking = require('../src/modules/stock/models/StockPicking');
  const StockQuant = require('../src/modules/stock/models/StockQuant');
  const StockLot = require('../src/modules/stock/models/StockLot');
  const Warehouse = require('../src/modules/stock/models/Warehouse');

  assert.ok(StockPicking);
  assert.ok(StockQuant);
  assert.ok(StockLot);
  assert.ok(Warehouse);

  console.log('✓ stock_module_test passed (smoke)');
})().catch(err => { console.error('stock_module_test failed', err); process.exit(1); });

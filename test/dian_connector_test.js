const assert = require('assert');
const DIANConnector = require('../src/modules/account/services/dian/Connector');

(async () => {
  const connector = new DIANConnector({ db: null, config: { endpoint: 'http://example.local', certPath: '', keyPath: '' } });
  const xml = await connector.generateInvoiceXml({ id: 1, total: 100.5 });
  assert.strictEqual(typeof xml, 'string');
  console.log('✓ dian_connector_test passed');
})().catch(err => {
  console.error('dian_connector_test failed:', err);
  process.exit(1);
});

const express = require('express');
const pickingsFactory = require('./pickings');
const quantsFactory = require('./quants');

let dbAdapter;
let router = express.Router();

function setDatabase(database) {
  dbAdapter = database;
  // rebuild router with injected db
  router = express.Router();
  router.use('/pickings', pickingsFactory({ db: database }));
  router.use('/quants', quantsFactory({ db: database }));
  // admin endpoints (warehouses, lots, reorder rules)
  const adminFactory = require('./admin');
  router.use('/admin', adminFactory({ db: database }));
}

module.exports = { router, setDatabase };

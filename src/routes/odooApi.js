const express = require('express');

// Import module routes
const baseUsersRoutes = require('../modules/base/routes/users');
const baseCompaniesRoutes = require('../modules/base/routes/companies');
const contactsPartnersRoutes = require('../modules/contacts/routes/partners');
const productRoutes = require('../modules/product/routes/products');
const saleRoutes = require('../modules/sale/routes/orders');
const purchaseRoutes = require('../modules/purchase/routes/orders');
const accountInvoicesRoutes = require('../modules/account/routes/invoices');
const accountAccountsRoutes = require('../modules/account/routes/accounts');
const accountJournalsRoutes = require('../modules/account/routes/journals');
const accountBudgetRoutes = require('../modules/account_budget/routes/budgets');
const stockRoutes = require('../modules/stock/routes');

// Crear adaptador para funcionar con el sistema de BD existente
class DatabaseAdapter {
  constructor(queryFn, queryAllFn, queryGetFn) {
    this.query = queryFn;
    this.queryAll = queryAllFn;
    this.queryGet = queryGetFn;
  }
}

// Initialize routes with database dependency injection
function setupRoutes(app, queryFn, queryAllFn, queryGetFn) {
  const dbAdapter = new DatabaseAdapter(queryFn, queryAllFn, queryGetFn);

  // Base Module Routes
  baseUsersRoutes.setDatabase(dbAdapter);
  baseCompaniesRoutes.setDatabase(dbAdapter);
  app.use('/api/odoo/users', baseUsersRoutes.router);
  app.use('/api/odoo/companies', baseCompaniesRoutes.router);

  // Contacts Module Routes
  contactsPartnersRoutes.setDatabase(dbAdapter);
  app.use('/api/odoo/partners', contactsPartnersRoutes.router);

  // Product Module Routes
  productRoutes.setDatabase(dbAdapter);
  app.use('/api/odoo/products', productRoutes.router);

  // Sale Module Routes
  saleRoutes.setDatabase(dbAdapter);
  app.use('/api/odoo/sale-orders', saleRoutes.router);

  // Purchase Module Routes
  purchaseRoutes.setDatabase(dbAdapter);
  app.use('/api/odoo/purchase-orders', purchaseRoutes.router);

  // Account Module Routes
  accountInvoicesRoutes.setDatabase(dbAdapter);
  app.use('/api/odoo/invoices', accountInvoicesRoutes.router);

  accountAccountsRoutes.setDatabase(dbAdapter);
  app.use('/api/odoo/accounts', accountAccountsRoutes.router);

  accountJournalsRoutes.setDatabase(dbAdapter);
  app.use('/api/odoo/journals', accountJournalsRoutes.router);

  accountBudgetRoutes.setDatabase(dbAdapter);
  app.use('/api/odoo/budgets', accountBudgetRoutes.router);

  // Stock Module Routes
  stockRoutes.setDatabase(dbAdapter);
  app.use('/api/odoo/stock', stockRoutes.router);

  // Health check endpoint
  app.get('/api/odoo/health', (req, res) => {
    res.json({ 
      status: 'ok', 
      timestamp: new Date(),
      message: 'Odoo 19.0 ERP System - Operational'
    });
  });

  // API documentation
  app.get('/api/odoo/docs', (req, res) => {
    res.json({
      message: 'Odoo 19.0 ERP API - Caja Simple',
      version: '1.0.0',
      status: 'operational',
      note: 'Completely independent implementation - no external Odoo connection required',
      modules: {
        base: { 
          endpoints: ['/odoo/users', '/odoo/companies'],
          status: 'active'
        },
        contacts: { 
          endpoints: ['/odoo/partners'],
          status: 'active'
        },
        product: { 
          endpoints: ['/odoo/products'],
          status: 'active'
        },
        sale: { 
          endpoints: ['/odoo/sale-orders'],
          status: 'active'
        },
        purchase: { 
          endpoints: ['/odoo/purchase-orders'],
          status: 'active'
        },
        account: { 
          endpoints: ['/odoo/invoices', '/odoo/accounts', '/odoo/journals'],
          status: 'active'
        }
        ,
        stock: {
          endpoints: ['/odoo/stock/pickings', '/odoo/stock/quants'],
          status: 'in-progress'
        }
      }
    });
  });

  console.log('✓ Odoo 19.0 modules initialized successfully');
}

module.exports = { setupRoutes };

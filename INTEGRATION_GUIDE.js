// ODOO INTEGRATION INSTRUCTIONS FOR server.js
// Copy these additions to your src/server.js

// ============================================================================
// STEP 1: Add this import at the top of server.js (after existing imports)
// ============================================================================

const { setupRoutes } = require('./routes/odooApi');

// ============================================================================
// STEP 2: After initializing database and before app.listen(), add:
// ============================================================================

// Initialize Odoo modules routes
// This should be added in the startServer() function, after database init
function initializeOdooModules(app, db) {
  console.log('Initializing Odoo modules...');
  
  // Setup all Odoo module routes
  setupRoutes(app, db);
  
  console.log('Odoo modules initialized successfully');
}

// ============================================================================
// STEP 3: Modified startServer function (replace existing one)
// ============================================================================

async function startServer() {
  try {
    const db = await initializeDatabase();
    console.log('Base de datos inicializada correctamente');
    
    // Initialize Odoo modules
    initializeOdooModules(app, db);
    
    app.listen(PORT, () => {
      console.log(`Servidor del Centro de Control corriendo en puerto ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`API Documentation: http://localhost:${PORT}/api/docs`);
    });
  } catch (error) {
    console.error('Error al iniciar el servidor:', error);
    process.exit(1);
  }
}

// ============================================================================
// STEP 4: Ensure your database exports the connection (in src/database/db.js)
// ============================================================================

// The initializeDatabase function should return the db connection:
// module.exports = {
//   initializeDatabase: async () => {
//     // ... initialization code ...
//     return db; // Important: return the db connection
//   }
// };

// ============================================================================
// EXAMPLE: Complete updated server.js
// ============================================================================

/*
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

// Existing routes
const heartbeatRoutes = require('./routes/heartbeat');
const telemetryRoutes = require('./routes/telemetry');
// ... other routes ...

// NEW: Odoo integration
const { setupRoutes } = require('./routes/odooApi');

// Database
const { initializeDatabase } = require('./database/db');

const app = express();
const PORT = process.env.PORT || 8787;

// ... middleware setup (helmet, cors, morgan, etc) ...

// Existing routes
app.use('/api/v1/installations', heartbeatRoutes);
// ... other routes ...

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({
    name: 'MerkaERP Control Center API',
    version: '1.0.0',
    status: 'running',
    modules: ['base', 'contacts', 'product', 'sale', 'purchase', 'account']
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path
  });
});

async function startServer() {
  try {
    const db = await initializeDatabase();
    console.log('Base de datos inicializada correctamente');
    
    // NEW: Initialize Odoo modules
    console.log('Initializing Odoo 19.0 modules...');
    setupRoutes(app, db);
    console.log('Odoo modules initialized');
    
    app.listen(PORT, () => {
      console.log(`✓ Servidor corriendo en puerto ${PORT}`);
      console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`✓ API Docs: http://localhost:${PORT}/api/docs`);
    });
  } catch (error) {
    console.error('Error al iniciar el servidor:', error);
    process.exit(1);
  }
}

startServer();
module.exports = app;
*/

// ============================================================================
// TESTING THE INTEGRATION
// ============================================================================

// 1. Start the server: npm start
// 2. Check health: curl http://localhost:8787/health
// 3. Check API docs: curl http://localhost:8787/api/docs
// 4. Create a user:
//    curl -X POST http://localhost:8787/api/users \
//      -H "Content-Type: application/json" \
//      -H "Authorization: Bearer YOUR_TOKEN" \
//      -d '{"name":"John","email":"john@example.com","login":"johndoe","password":"123456","company_id":1}'

// ============================================================================
// DATABASE MODIFICATIONS NEEDED (in src/database/db.js)
// ============================================================================

// Make sure initializeDatabase returns the db connection:
/*
async function initializeDatabase() {
  // ... your existing database initialization code ...
  
  // At the end, return the db connection:
  return db;
}

module.exports = {
  initializeDatabase,
  // ... other exports ...
};
*/

// ============================================================================
// MIGRATION STEPS
// ============================================================================

// 1. Backup current database
// 2. Apply PHASE 1 migration:
//    psql -U postgres -d your_database -f src/database/migrations/001_phase1_core.sql
// 3. Update server.js with Odoo integration
// 4. Restart server: npm start
// 5. Test endpoints

console.log('✓ Odoo integration guide loaded');

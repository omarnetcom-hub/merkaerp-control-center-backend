require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

// Importar rutas
const heartbeatRoutes = require('./routes/heartbeat');
const telemetryRoutes = require('./routes/telemetry');
const commandsRoutes = require('./routes/commands');
const updatesRoutes = require('./routes/updates');
const installationsRoutes = require('./routes/installations');

// Importar base de datos
const { initializeDatabase } = require('./database/db');

const app = express();
const PORT = process.env.PORT || 8787;

// Middleware de seguridad
app.use(helmet());

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Logging
app.use(morgan('combined'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // límite de 100 requests por ventana
  message: 'Too many requests from this IP'
});
app.use('/api/', limiter);

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rutas API
app.use('/api/v1/installations', heartbeatRoutes);
app.use('/api/v1/telemetry', telemetryRoutes);
app.use('/api/v1/commands', commandsRoutes);
app.use('/api/v1/updates', updatesRoutes);
app.use('/api/v1/installations', installationsRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Ruta raíz
app.get('/', (req, res) => {
  res.json({
    name: 'MerkaERP Control Center API',
    version: '1.0.0',
    status: 'running'
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

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path
  });
});

// Inicializar base de datos y iniciar servidor
async function startServer() {
  try {
    await initializeDatabase();
    console.log('Base de datos inicializada correctamente');
    
    app.listen(PORT, () => {
      console.log(`Servidor del Centro de Control corriendo en puerto ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('Error al iniciar el servidor:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;

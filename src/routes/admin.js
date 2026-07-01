const express = require('express');
const router = express.Router();
const { getDatabase } = require('../database/db');
const { authenticateToken } = require('./auth');

// GET /api/v1/admin/users - Listar todos los usuarios
router.get('/users', authenticateToken, async (req, res) => {
  const db = getDatabase();
  
  try {
    const users = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, username, email, full_name, company_id, role, 
                created_at, updated_at, last_login, is_active 
         FROM users 
         ORDER BY created_at DESC`,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    res.json({
      success: true,
      count: users.length,
      users: users
    });
  } catch (error) {
    console.error('Error getting users:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/admin/users/:id - Obtener detalles de un usuario
router.get('/users/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  
  try {
    const user = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id, username, email, full_name, company_id, role, 
                created_at, updated_at, last_login, is_active 
         FROM users 
         WHERE id = ?`,
        [id],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      user
    });
  } catch (error) {
    console.error('Error getting user:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/admin/users - Crear nuevo usuario
router.post('/users', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { username, email, password, fullName, companyId, role } = req.body;
  const { v4: uuidv4 } = require('uuid');
  const bcrypt = require('bcrypt');

  try {
    // Verificar si el usuario ya existe
    const existingUser = await new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM users WHERE username = ? OR email = ?',
        [username, email],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (existingUser) {
      return res.status(409).json({
        error: 'User already exists',
        message: 'Username or email already registered'
      });
    }

    // Hash de la contraseña
    const passwordHash = await bcrypt.hash(password, 10);

    // Crear usuario
    const userId = uuidv4();
    const now = new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO users (
          id, username, email, password_hash, full_name, company_id, 
          role, created_at, updated_at, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          username,
          email,
          passwordHash,
          fullName || username,
          companyId || null,
          role || 'user',
          now,
          now,
          1
        ],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      userId
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// PUT /api/v1/admin/users/:id - Actualizar usuario
router.put('/users/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  const { fullName, companyId, role, isActive } = req.body;

  try {
    const now = new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE users 
         SET full_name = ?, company_id = ?, role = ?, is_active = ?, updated_at = ?
         WHERE id = ?`,
        [
          fullName,
          companyId,
          role,
          isActive !== undefined ? (isActive ? 1 : 0) : 1,
          now,
          id
        ],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({
      success: true,
      message: 'User updated successfully'
    });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// DELETE /api/v1/admin/users/:id - Eliminar usuario
router.delete('/users/:id', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;

  try {
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM users WHERE id = ?', [id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/admin/stats - Obtener estadísticas del sistema
router.get('/stats', authenticateToken, async (req, res) => {
  const db = getDatabase();

  try {
    // Contar usuarios
    const totalUsers = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM users', (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    // Contar usuarios activos
    const activeUsers = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM users WHERE is_active = 1', (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    // Contar instalaciones
    const totalInstallations = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM installations', (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    // Contar eventos de sincronización
    const totalSyncEvents = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM sync_events', (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    // Contar heartbeats en las últimas 24 horas
    const recentHeartbeats = await new Promise((resolve, reject) => {
      db.get(
        `SELECT COUNT(*) as count FROM heartbeats 
         WHERE received_at > datetime('now', '-24 hours')`,
        (err, row) => {
          if (err) reject(err);
          else resolve(row.count);
        }
      );
    });

    // Estadísticas de clientes
    const totalClients = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM cc_clients', (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    const activeClients = await new Promise((resolve, reject) => {
      db.get("SELECT COUNT(*) as count FROM cc_clients WHERE status = 'active'", (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    // Estadísticas de licencias
    const totalLicenses = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM cc_licenses', (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    const activeLicenses = await new Promise((resolve, reject) => {
      db.get("SELECT COUNT(*) as count FROM cc_licenses WHERE status = 'active'", (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    // Estadísticas de tickets
    const totalTickets = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM cc_tickets', (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    const openTickets = await new Promise((resolve, reject) => {
      db.get("SELECT COUNT(*) as count FROM cc_tickets WHERE status = 'open'", (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    // Estadísticas de facturas
    const totalInvoices = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM cc_invoices', (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    const pendingInvoices = await new Promise((resolve, reject) => {
      db.get("SELECT COUNT(*) as count FROM cc_invoices WHERE status = 'pending'", (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    // Ingresos totales
    const totalRevenue = await new Promise((resolve, reject) => {
      db.get('SELECT SUM(contract_value) as total FROM cc_clients', (err, row) => {
        if (err) reject(err);
        else resolve(row.total || 0);
      });
    });

    res.json({
      success: true,
      stats: {
        users: {
          total: totalUsers,
          active: activeUsers
        },
        installations: {
          total: totalInstallations,
          recentHeartbeats
        },
        sync: {
          totalEvents: totalSyncEvents
        },
        clients: {
          total: totalClients,
          active: activeClients
        },
        licenses: {
          total: totalLicenses,
          active: activeLicenses
        },
        tickets: {
          total: totalTickets,
          open: openTickets
        },
        invoices: {
          total: totalInvoices,
          pending: pendingInvoices
        },
        revenue: {
          total: totalRevenue
        },
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/admin/sync-events - Listar eventos de sincronización
router.get('/sync-events', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { limit = 50, offset = 0, userId } = req.query;

  try {
    let query = `
      SELECT se.*, u.username 
      FROM sync_events se
      LEFT JOIN users u ON se.user_id = u.id
    `;
    const params = [];

    if (userId) {
      query += ' WHERE se.user_id = ?';
      params.push(userId);
    }

    query += ' ORDER BY se.timestamp DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const events = await new Promise((resolve, reject) => {
      db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    res.json({
      success: true,
      count: events.length,
      events
    });
  } catch (error) {
    console.error('Error getting sync events:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/admin/installations - Listar instalaciones
router.get('/installations', authenticateToken, async (req, res) => {
  const db = getDatabase();

  try {
    const installations = await new Promise((resolve, reject) => {
      db.all(
        `SELECT i.*, 
                (SELECT COUNT(*) FROM heartbeats h WHERE h.installation_id = i.id AND h.received_at > datetime('now', '-24 hours')) as recent_heartbeats
         FROM installations i
         ORDER BY i.created_at DESC`,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    res.json({
      success: true,
      count: installations.length,
      installations
    });
  } catch (error) {
    console.error('Error getting installations:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/admin/init-cc-tables - Inicializar tablas del Control Center
router.post('/init-cc-tables', authenticateToken, async (req, res) => {
  const db = getDatabase();

  try {
    const tables = [
      // Tabla de clientes (del Control Center)
      `CREATE TABLE IF NOT EXISTS cc_clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        nit TEXT,
        city TEXT,
        country TEXT,
        status TEXT NOT NULL,
        plan TEXT NOT NULL,
        contract_value REAL NOT NULL DEFAULT 0,
        renewal_date TEXT NOT NULL,
        usage_score INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        reseller_id INTEGER,
        tax_rate REAL NOT NULL DEFAULT 19.0,
        billing_type TEXT NOT NULL DEFAULT 'mensual',
        billing_day INTEGER NOT NULL DEFAULT 5,
        notes TEXT,
        contact_name TEXT,
        contact_phone TEXT,
        contact_email TEXT,
        contact_role TEXT
      )`,
      
      // Tabla de licencias
      `CREATE TABLE IF NOT EXISTS cc_licenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        max_users INTEGER NOT NULL,
        max_devices INTEGER NOT NULL,
        max_branches INTEGER NOT NULL,
        modules TEXT NOT NULL,
        token_hint TEXT,
        updated_at TEXT NOT NULL
      )`,
      
      // Tabla de leads (CRM)
      `CREATE TABLE IF NOT EXISTS cc_leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        company TEXT,
        email TEXT,
        phone TEXT,
        source TEXT,
        status TEXT NOT NULL,
        notes TEXT,
        assigned_to TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      
      // Tabla de tickets de soporte
      `CREATE TABLE IF NOT EXISTS cc_tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER,
        title TEXT NOT NULL,
        description TEXT,
        category TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL,
        assigned_to TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sla_hours INTEGER,
        escalated_level INTEGER
      )`,
      
      // Tabla de facturas
      `CREATE TABLE IF NOT EXISTS cc_invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        invoice_number TEXT NOT NULL,
        status TEXT NOT NULL,
        total REAL NOT NULL,
        due_date TEXT NOT NULL,
        paid_at TEXT,
        items_json TEXT
      )`,
      
      // Tabla de instalaciones (para asistencia remota)
      `CREATE TABLE IF NOT EXISTS cc_installations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        installation_id TEXT NOT NULL UNIQUE,
        company_name TEXT NOT NULL,
        tax_id TEXT,
        version TEXT NOT NULL,
        os TEXT NOT NULL,
        license_status TEXT NOT NULL,
        license_plan TEXT NOT NULL,
        license_expiry TEXT,
        sync_status TEXT NOT NULL,
        database_status TEXT NOT NULL,
        critical_errors INTEGER NOT NULL DEFAULT 0,
        update_available INTEGER NOT NULL DEFAULT 0,
        update_version TEXT,
        last_heartbeat TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      
      // Tabla de comandos remotos
      `CREATE TABLE IF NOT EXISTS cc_commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        installation_id TEXT NOT NULL,
        action TEXT NOT NULL,
        parameters TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        executed_at TEXT,
        result TEXT,
        FOREIGN KEY (installation_id) REFERENCES cc_installations(installation_id)
      )`
    ];

    for (const tableSQL of tables) {
      await new Promise((resolve, reject) => {
        db.run(tableSQL, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    res.json({
      success: true,
      message: 'Control Center tables initialized successfully'
    });
  } catch (error) {
    console.error('Error initializing CC tables:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/installations/heartbeat - Recibir heartbeat de instalación
router.post('/installations/heartbeat', async (req, res) => {
  const db = getDatabase();
  const payload = req.body;

  try {
    const installationId = payload.installationId;
    const now = new Date().toISOString();

    // Verificar si la instalación existe
    const existing = await new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM cc_installations WHERE installation_id = ?',
        [installationId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (existing) {
      // Actualizar instalación existente
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE cc_installations 
           SET company_name = ?, tax_id = ?, version = ?, os = ?, 
               license_status = ?, license_plan = ?, license_expiry = ?,
               sync_status = ?, database_status = ?, critical_errors = ?,
               update_available = ?, update_version = ?, last_heartbeat = ?,
               updated_at = ?
           WHERE installation_id = ?`,
          [
            payload.companyName || existing.company_name,
            payload.taxId || existing.tax_id,
            payload.version || existing.version,
            payload.os || existing.os,
            payload.licenseStatus || existing.license_status,
            payload.licensePlan || existing.license_plan,
            payload.licenseExpiry || existing.license_expiry,
            payload.syncStatus || existing.sync_status,
            payload.databaseStatus || existing.database_status,
            payload.criticalErrors ?? existing.critical_errors,
            payload.updateAvailable ? 1 : 0,
            payload.updateVersion || existing.update_version,
            now,
            now,
            installationId
          ],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    } else {
      // Crear nueva instalación
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO cc_installations (
            installation_id, company_name, tax_id, version, os,
            license_status, license_plan, license_expiry, sync_status,
            database_status, critical_errors, update_available, update_version,
            last_heartbeat, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            installationId,
            payload.companyName || 'Unknown',
            payload.taxId || '',
            payload.version || '1.0.0',
            payload.os || 'unknown',
            payload.licenseStatus || 'local',
            payload.licensePlan || 'unknown',
            payload.licenseExpiry || '',
            payload.syncStatus || 'not_configured',
            payload.databaseStatus || 'ok',
            payload.criticalErrors ?? 0,
            payload.updateAvailable ? 1 : 0,
            payload.updateVersion || null,
            now,
            now,
            now
          ],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    }

    res.json({
      success: true,
      message: 'Heartbeat received'
    });
  } catch (error) {
    console.error('Error processing heartbeat:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/installations - Listar todas las instalaciones
router.get('/installations', authenticateToken, async (req, res) => {
  const db = getDatabase();

  try {
    const installations = await new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM cc_installations ORDER BY last_heartbeat DESC',
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    res.json({
      success: true,
      count: installations.length,
      installations: installations
    });
  } catch (error) {
    console.error('Error getting installations:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/installations/:id/commands - Obtener comandos pendientes para una instalación
router.get('/installations/:installationId/commands', async (req, res) => {
  const db = getDatabase();
  const { installationId } = req.params;

  try {
    const commands = await new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM cc_commands WHERE installation_id = ? AND status = "pending" ORDER BY created_at ASC',
        [installationId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    res.json({
      success: true,
      count: commands.length,
      commands: commands
    });
  } catch (error) {
    console.error('Error getting commands:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/commands - Enviar comando remoto a una instalación
router.post('/commands', authenticateToken, async (req, res) => {
  const db = getDatabase();
  const { installationId, action, parameters } = req.body;

  try {
    const now = new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO cc_commands (installation_id, action, parameters, status, created_at) VALUES (?, ?, ?, ?, ?)',
        [installationId, action, JSON.stringify(parameters || {}), 'pending', now],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({
      success: true,
      message: 'Command sent successfully'
    });
  } catch (error) {
    console.error('Error sending command:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/commands/:id/ack - Confirmar ejecución de comando
router.post('/commands/:id/ack', async (req, res) => {
  const db = getDatabase();
  const { id } = req.params;
  const { status, result } = req.body;

  try {
    const now = new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.run(
        'UPDATE cc_commands SET status = ?, executed_at = ?, result = ? WHERE id = ?',
        [status || 'done', now, result || '', id],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({
      success: true,
      message: 'Command acknowledged'
    });
  } catch (error) {
    console.error('Error acknowledging command:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

module.exports = router;

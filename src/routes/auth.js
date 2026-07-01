const express = require('express');
const router = express.Router();
const { getDatabase } = require('../database/db');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'merka-erp-secret-key-2026';

// POST /api/v1/auth/register - Registrar nuevo usuario
router.post('/register', async (req, res) => {
  const db = getDatabase();
  const { username, email, password, fullName, companyId } = req.body;

  try {
    // Validar campos requeridos
    if (!username || !email || !password) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'username, email, and password are required'
      });
    }

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
          'user',
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
      message: 'User registered successfully',
      userId
    });
  } catch (error) {
    console.error('Error registering user:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/auth/login - Iniciar sesión
router.post('/login', async (req, res) => {
  const db = getDatabase();
  const { username, password, deviceInfo } = req.body;

  try {
    // Validar campos requeridos
    if (!username || !password) {
      return res.status(400).json({
        error: 'Missing credentials',
        message: 'username and password are required'
      });
    }

    // Buscar usuario
    const user = await new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM users WHERE username = ? OR email = ? AND is_active = 1',
        [username, username],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!user) {
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'User not found or inactive'
      });
    }

    // Verificar contraseña
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'Incorrect password'
      });
    }

    // Crear token JWT
    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Crear sesión
    const sessionId = uuidv4();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 días

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO user_sessions (
          id, user_id, token, device_info, ip_address, 
          created_at, expires_at, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          user.id,
          token,
          deviceInfo || 'Unknown device',
          req.ip || 'Unknown IP',
          now,
          expiresAt,
          1
        ],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Actualizar último login
    await new Promise((resolve, reject) => {
      db.run(
        'UPDATE users SET last_login = ? WHERE id = ?',
        [now, user.id],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        fullName: user.full_name,
        companyId: user.company_id,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/v1/auth/logout - Cerrar sesión
router.post('/logout', async (req, res) => {
  const db = getDatabase();
  const { token } = req.body;

  try {
    // Invalidar sesión
    await new Promise((resolve, reject) => {
      db.run(
        'UPDATE user_sessions SET is_active = 0 WHERE token = ?',
        [token],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({
      success: true,
      message: 'Logout successful'
    });
  } catch (error) {
    console.error('Error logging out:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/auth/me - Obtener información del usuario actual
router.get('/me', async (req, res) => {
  const db = getDatabase();
  const token = req.headers.authorization?.replace('Bearer ', '');

  try {
    if (!token) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Token required'
      });
    }

    // Verificar token
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Obtener usuario
    const user = await new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM users WHERE id = ? AND is_active = 1',
        [decoded.userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        message: 'User not found or inactive'
      });
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        fullName: user.full_name,
        companyId: user.company_id,
        role: user.role,
        lastLogin: user.last_login
      }
    });
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Invalid token',
        message: 'Token is invalid or expired'
      });
    }
    console.error('Error getting user info:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Middleware de autenticación
function authenticateToken(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Token required'
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      error: 'Invalid token',
      message: 'Token is invalid or expired'
    });
  }
}

module.exports = router;
module.exports.authenticateToken = authenticateToken;

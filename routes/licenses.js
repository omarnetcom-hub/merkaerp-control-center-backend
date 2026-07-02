const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Secret key for JWT signing
const JWT_SECRET = process.env.JWT_SECRET || 'merka-control-center-secret-key-2024';

// Helper function to generate JWT token
function generateLicenseToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '365d' });
}

// License activation endpoint
router.post('/activate', async (req, res) => {
  try {
    const { key, hardware_fingerprint } = req.body;

    if (!key || !hardware_fingerprint) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: key and hardware_fingerprint' 
      });
    }

    // TODO: Connect to Control Center database and validate license key
    // For now, simulate license validation
    const licenseData = {
      type: 'Profesional',
      status: 'active',
      expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      max_users: 8,
      max_devices: 12,
      max_branches: 2,
      modules: 'sales,purchases,inventory,cash,accounting,reports',
    };

    // Generate JWT token for offline activation
    const tokenPayload = {
      hardware_fingerprint,
      license_type: 'SUSCRIPCION',
      status: 'active',
      expiry_date: licenseData.expires_at,
      modules: licenseData.modules.split(','),
      iat: Math.floor(Date.now() / 1000),
    };

    const token = generateLicenseToken(tokenPayload);

    res.json({
      success: true,
      token: token,
      license: licenseData,
    });
  } catch (error) {
    console.error('License activation error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// License validation endpoint
router.post('/validate', async (req, res) => {
  try {
    const { hardware_fingerprint } = req.body;

    if (!hardware_fingerprint) {
      return res.status(400).json({ 
        valid: false, 
        error: 'Missing hardware_fingerprint' 
      });
    }

    // TODO: Connect to Control Center database and validate license
    // For now, simulate validation
    const licenseData = {
      type: 'Profesional',
      status: 'active',
      expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      max_users: 8,
      max_devices: 12,
      max_branches: 2,
      modules: 'sales,purchases,inventory,cash,accounting,reports',
    };

    res.json({
      valid: true,
      license: licenseData,
    });
  } catch (error) {
    console.error('License validation error:', error);
    res.status(500).json({ 
      valid: false, 
      error: error.message 
    });
  }
});

// Get all licenses
router.get('/', async (req, res) => {
  try {
    // TODO: Get real licenses from database
    res.json({ licenses: [] });
  } catch (error) {
    console.error('Get licenses error:', error);
    res.status(500).json({ 
      error: error.message 
    });
  }
});

// Get specific license
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // TODO: Get real license from database
    res.json({ license: null });
  } catch (error) {
    console.error('Get license error:', error);
    res.status(500).json({ 
      error: error.message 
    });
  }
});

// Create license
router.post('/', async (req, res) => {
  try {
    const licenseData = req.body;
    // TODO: Create license in database
    res.json({ license: null });
  } catch (error) {
    console.error('Create license error:', error);
    res.status(500).json({ 
      error: error.message 
    });
  }
});

// Update license
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const licenseData = req.body;
    // TODO: Update license in database
    res.json({ license: null });
  } catch (error) {
    console.error('Update license error:', error);
    res.status(500).json({ 
      error: error.message 
    });
  }
});

// Delete license
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // TODO: Delete license from database
    res.json({ success: true });
  } catch (error) {
    console.error('Delete license error:', error);
    res.status(500).json({ 
      error: error.message 
    });
  }
});

module.exports = router;

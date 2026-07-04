const https = require('https');

// Primero crear un cliente nuevo
const createOptions = {
  hostname: 'merkaerp-control-center-backend.onrender.com',
  port: 443,
  path: '/api/v1/clients/sync',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
};

const createReq = https.request(createOptions, (createRes) => {
  console.log(`Create Status: ${createRes.statusCode}`);
  let createBody = '';
  
  createRes.on('data', (chunk) => {
    createBody += chunk;
  });
  
  createRes.on('end', () => {
    console.log('Create Response:', createBody);
    
    // Intentar activar licencia con el mismo cliente
    const activateOptions = {
      hostname: 'merkaerp-control-center-backend.onrender.com',
      port: 443,
      path: '/api/v1/licenses/activate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    };
    
    const activateReq = https.request(activateOptions, (activateRes) => {
      console.log(`Activate Status: ${activateRes.statusCode}`);
      let activateBody = '';
      
      activateRes.on('data', (chunk) => {
        activateBody += chunk;
      });
      
      activateRes.on('end', () => {
        console.log('Activate Response:', activateBody);
      });
    });
    
    activateReq.on('error', (error) => {
      console.error('Activate Error:', error);
    });
    
    activateReq.write(JSON.stringify({
      email: 'verify@example.com',
      password: 'verifypass123',
      hardware_fingerprint: 'TEST-FINGERPRINT-123',
      license_type: 'SUSCRIPCION'
    }));
    activateReq.end();
  });
});

createReq.on('error', (error) => {
  console.error('Create Error:', error);
});

createReq.write(JSON.stringify({
  name: 'Verify Client',
  contact_email: 'verify@example.com',
  password: 'verifypass123',
  plan: 'Profesional',
  licenseType: 'SUSCRIPCION',
  subscriptionMonths: 12,
  status: 'active',
  contractValue: 1000000,
  renewalDate: '2026-12-31',
  usageScore: 75,
  taxRate: 19.0,
  billingType: 'mensual',
  billingDay: 5
}));
createReq.end();

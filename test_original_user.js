const https = require('https');

// Crear/sincronizar el usuario original
const syncOptions = {
  hostname: 'merkaerp-control-center-backend.onrender.com',
  port: 443,
  path: '/api/v1/clients/sync',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
};

const syncReq = https.request(syncOptions, (syncRes) => {
  console.log(`Sync Status: ${syncRes.statusCode}`);
  let syncBody = '';
  
  syncRes.on('data', (chunk) => {
    syncBody += chunk;
  });
  
  syncRes.on('end', () => {
    console.log('Sync Response:', syncBody);
    
    // Intentar activar licencia con el usuario original
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
      email: 'fernandovelez@gmail.com',
      password: '123456789f',
      hardware_fingerprint: 'TEST-FINGERPRINT-123',
      license_type: 'SUSCRIPCION'
    }));
    activateReq.end();
  });
});

syncReq.on('error', (error) => {
  console.error('Sync Error:', error);
});

syncReq.write(JSON.stringify({
  id: 1,
  name: 'Fernando Velez',
  nit: '123456789',
  contact_email: 'fernandovelez@gmail.com',
  password: '123456789f',
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
syncReq.end();

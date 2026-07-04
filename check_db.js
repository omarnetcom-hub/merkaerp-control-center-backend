const https = require('https');

// Primero crear un cliente
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
    
    // Intentar actualizar el mismo cliente para verificar que se encuentra
    const updateOptions = {
      hostname: 'merkaerp-control-center-backend.onrender.com',
      port: 443,
      path: '/api/v1/clients/sync',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    };
    
    const updateReq = https.request(updateOptions, (updateRes) => {
      console.log(`Update Status: ${updateRes.statusCode}`);
      let updateBody = '';
      
      updateRes.on('data', (chunk) => {
        updateBody += chunk;
      });
      
      updateRes.on('end', () => {
        console.log('Update Response:', updateBody);
      });
    });
    
    updateReq.on('error', (error) => {
      console.error('Update Error:', error);
    });
    
    updateReq.write(JSON.stringify({
      id: 6,
      name: 'Verify Client Updated',
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
    updateReq.end();
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

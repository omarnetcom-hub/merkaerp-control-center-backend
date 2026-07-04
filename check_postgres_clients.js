const https = require('https');

const options = {
  hostname: 'merkaerp-control-center-backend.onrender.com',
  port: 443,
  path: '/api/v1/clients/sync',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
};

const req = https.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
  let body = '';
  
  res.on('data', (chunk) => {
    body += chunk;
  });
  
  res.on('end', () => {
    console.log('Response:', body);
    
    // Intentar crear un nuevo cliente con datos específicos
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
      });
    });
    
    createReq.on('error', (error) => {
      console.error('Create Error:', error);
    });
    
    createReq.write(JSON.stringify({
      name: 'Test User',
      contact_email: 'testuser@example.com',
      password: 'testpass123',
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
  });
});

req.on('error', (error) => {
  console.error('Error:', error);
});

req.write(JSON.stringify({
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
req.end();

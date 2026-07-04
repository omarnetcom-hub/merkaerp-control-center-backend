const https = require('https');

const activationData = {
  email: 'fernandovelez@gmail.com',
  password: '123456789f',
  hardware_fingerprint: 'test-fingerprint-123',
  license_type: 'PERPETUA'
};

const data = JSON.stringify(activationData);

console.log('Testing activation with PostgreSQL backend:', data);

const options = {
  hostname: 'merkaerp-control-center-backend.onrender.com',
  port: 443,
  path: '/api/v1/licenses/activate',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
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
    
    // Si falla, intentar crear el cliente primero
    if (res.statusCode === 401) {
      console.log('\nCliente no encontrado, creándolo...');
      createClient();
    }
  });
});

req.on('error', (error) => {
  console.error('Error:', error);
});

req.write(data);
req.end();

function createClient() {
  const clientData = {
    id: 2,
    name: 'Fernando Velez',
    nit: '',
    city: 'Cali',
    country: 'Colombia',
    status: 'active',
    plan: 'Básica',
    contractValue: 0,
    renewalDate: '2099-12-31',
    usageScore: 75,
    createdAt: new Date().toISOString(),
    taxRate: 19,
    billingType: 'mensual',
    billingDay: 1,
    notes: '',
    contactName: 'Fernando Velez',
    contactPhone: '',
    contactEmail: 'fernandovelez@gmail.com',
    contactRole: 'Cliente',
    password: '123456789f',
    licenseType: 'PERPETUA',
    subscriptionMonths: 12
  };

  const clientJson = JSON.stringify(clientData);

  const options = {
    hostname: 'merkaerp-control-center-backend.onrender.com',
    port: 443,
    path: '/api/v1/clients/sync',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(clientJson)
    }
  };

  const req = https.request(options, (res) => {
    console.log(`\nClient sync Status: ${res.statusCode}`);
    let body = '';
    
    res.on('data', (chunk) => {
      body += chunk;
    });
    
    res.on('end', () => {
      console.log('Client sync Response:', body);
    });
  });

  req.on('error', (error) => {
    console.error('Error creating client:', error);
  });

  req.write(clientJson);
  req.end();
}

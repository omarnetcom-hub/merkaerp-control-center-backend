const https = require('https');

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

const data = JSON.stringify(clientData);

console.log('Sending data:', data);

const options = {
  hostname: 'merkaerp-control-center-backend.onrender.com',
  port: 443,
  path: '/api/v1/clients/sync',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
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
  });
});

req.on('error', (error) => {
  console.error('Error:', error);
});

req.write(data);
req.end();

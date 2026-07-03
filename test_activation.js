const https = require('https');

const activationData = {
  email: 'fernandovelez@gmail.com',
  password: '123456789f',
  hardware_fingerprint: 'test-fingerprint-123',
  license_type: 'PERPETUA'
};

const data = JSON.stringify(activationData);

console.log('Testing activation with:', data);

const options = {
  hostname: 'merkaerp-control-center-backend.onrender.com',
  port: 443,
  path: '/api/v1/licenses/activate',
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

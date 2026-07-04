const https = require('https');

const options = {
  hostname: 'merkaerp-control-center-backend.onrender.com',
  port: 443,
  path: '/api/v1/licenses/activate',
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
  });
});

req.on('error', (error) => {
  console.error('Error:', error);
});

req.write(JSON.stringify({
  email: 'verify@example.com',
  password: 'verifypass123',
  hardware_fingerprint: 'TEST-FINGERPRINT-123',
  license_type: 'SUSCRIPCION'
}));
req.end();

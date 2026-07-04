const https = require('https');

const options = {
  hostname: 'merkaerp-control-center-backend.onrender.com',
  port: 443,
  path: '/health',
  method: 'GET'
};

const req = https.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
  let body = '';
  
  res.on('data', (chunk) => {
    body += chunk;
  });
  
  res.on('end', () => {
    console.log('Response:', body);
    console.log('Headers:', JSON.stringify(res.headers, null, 2));
  });
});

req.on('error', (error) => {
  console.error('Error:', error);
});

req.end();

const https = require('https');

// Primero activar una licencia para obtener el token
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
    
    const activateData = JSON.parse(activateBody);
    if (activateData.success && activateData.token) {
      // Registrar una instalación
      const installOptions = {
        hostname: 'merkaerp-control-center-backend.onrender.com',
        port: 443,
        path: '/api/v1/installations',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${activateData.token}`
        }
      };
      
      const installReq = https.request(installOptions, (installRes) => {
        console.log(`Install Status: ${installRes.statusCode}`);
        let installBody = '';
        
        installRes.on('data', (chunk) => {
          installBody += chunk;
        });
        
        installRes.on('end', () => {
          console.log('Install Response:', installBody);
        });
      });
      
      installReq.on('error', (error) => {
        console.error('Install Error:', error);
      });
      
      installReq.write(JSON.stringify({
        hardware_fingerprint: 'TEST-FINGERPRINT-123',
        os: 'Windows 10',
        version: '1.0.0',
        ip_address: '192.168.1.1'
      }));
      installReq.end();
    }
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

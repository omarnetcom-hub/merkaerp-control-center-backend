const axios = require('axios');

exports.postToDian = async function(xml, endpoint, credentials, options = {}) {
  // Supports plain POST and simple SOAP envelope when options.soap === true
  try {
    let payload = xml;
    const headers = { 'Content-Type': options.soap ? 'text/xml' : 'application/xml' };

    if (options.soap) {
      // Wrap XML into a minimal SOAP Envelope. DIAN may require specific namespaces and actions.
      payload = `<?xml version="1.0" encoding="UTF-8"?>\n<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">\n  <soapenv:Header/>\n  <soapenv:Body>\n    ${xml}\n  </soapenv:Body>\n</soapenv:Envelope>`;
    }

    const res = await axios.post(endpoint, payload, {
      headers,
      auth: credentials && credentials.username ? { username: credentials.username, password: credentials.password } : undefined,
      timeout: options.timeout || 30000
    });
    return { success: true, status: res.status, data: res.data };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

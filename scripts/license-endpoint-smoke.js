async function requestJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, body: json };
}

function redactToken(body) {
  if (!body || typeof body !== 'object') return body;
  const clone = JSON.parse(JSON.stringify(body));
  if (clone.token) {
    clone.token = `${clone.token.slice(0, 24)}...redacted`;
  }
  if (clone.postgres_credentials?.password) {
    clone.postgres_credentials.password = 'redacted';
  }
  return clone;
}

async function main() {
  const baseUrl = process.env.BASE_URL || 'http://localhost:8787';
  const email = process.env.TEST_LICENSE_EMAIL;
  const password = process.env.TEST_LICENSE_PASSWORD;
  if (!email || !password) throw new Error('TEST_LICENSE_EMAIL and TEST_LICENSE_PASSWORD are required');
  const hardware = process.env.TEST_HARDWARE_FINGERPRINT || `SMOKE-${Date.now()}`;

  const activation = await requestJson(`${baseUrl}/api/v1/licenses/activate`, {
    email,
    password,
    hardware_fingerprint: hardware,
  });
  console.log(JSON.stringify({ step: 'activate', status: activation.status, body: redactToken(activation.body) }, null, 2));

  if (!activation.body?.token) throw new Error('Activation did not return a license token');
  const response = await fetch(`${baseUrl}/api/v1/licenses/validate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${activation.body.token}`,
    },
    body: JSON.stringify({ hardware_fingerprint: hardware }),
  });
  const validation = { status: response.status, body: await response.json() };
  console.log(JSON.stringify({ step: 'validate', status: validation.status, body: validation.body }, null, 2));

  if (activation.status >= 400 || validation.status >= 400 || validation.body.valid === false) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
  process.exit(1);
});

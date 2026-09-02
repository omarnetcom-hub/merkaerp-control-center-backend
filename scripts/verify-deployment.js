'use strict';

const rawBaseUrl = process.argv[2] || process.env.CONTROL_CENTER_URL || '';
const baseUrl = rawBaseUrl.trim().replace(/\/+$/, '');
const expectedSchemaVersion = 20;

if (!/^https?:\/\//i.test(baseUrl)) {
  console.error('Usage: node scripts/verify-deployment.js https://backend.example.com');
  process.exit(2);
}

async function request(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    // Free-tier Render services can need close to a minute for a cold start.
    signal: AbortSignal.timeout(60_000),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = { error: 'Response is not JSON' };
  }
  return { status: response.status, payload };
}

async function main() {
  const failures = [];
  const health = await request('GET', '/health');
  const appliedSchema = Number(health.payload?.schema_version || 0);
  if (health.status !== 200 || health.payload?.status !== 'ok') {
    failures.push(`GET /health returned ${health.status} (${health.payload?.status || health.payload?.error || 'unknown'})`);
  }
  if (appliedSchema < expectedSchemaVersion) {
    failures.push(`schema_version is ${appliedSchema}; expected at least ${expectedSchemaVersion}`);
  }

  const protectedRoutes = [
    ['POST', '/api/v1/licenses/1/lifecycle', { action: 'suspend' }],
    ['POST', '/api/v1/clients/1/lifecycle', { action: 'suspend' }],
    ['DELETE', '/api/v1/licenses/1'],
    ['DELETE', '/api/v1/clients/1'],
    ['POST', '/api/v1/clients/1/permanent-delete', {}],
    ['GET', '/api/v1/plans'],
    ['GET', '/api/v1/fleet/overview'],
    ['POST', '/api/v1/installations/test/diagnostics', {}],
    ['GET', '/api/v1/agent/bootstrap'],
    ['POST', '/api/v1/agent/capabilities', {}],
    ['POST', '/api/v1/errors/report', {}],
    ['POST', '/api/v1/agent/artifacts', {}],
  ];

  for (const [method, path, body] of protectedRoutes) {
    const result = await request(method, path, body);
    if (result.status !== 401) {
      failures.push(`${method} ${path} returned ${result.status}; expected 401 (registered and protected)`);
    }
  }

  const activation = await request('POST', '/api/v1/licenses/activate', {});
  if (activation.status !== 400) {
    failures.push(`POST /api/v1/licenses/activate returned ${activation.status}; expected 400 for missing fields`);
  }

  console.log(`Backend: ${baseUrl}`);
  console.log(`Build commit: ${health.payload?.build_commit || 'not reported'}`);
  console.log(`Schema: ${appliedSchema}/${expectedSchemaVersion}`);
  if (failures.length > 0) {
    console.error('Deployment verification: FAILED');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log('Deployment verification: PASS');
}

main().catch((error) => {
  console.error(`Deployment verification failed: ${error.message}`);
  process.exit(1);
});

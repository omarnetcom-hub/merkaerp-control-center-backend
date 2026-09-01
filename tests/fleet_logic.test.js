const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, computeHealthScore, isInRollout, errorSignature } = require('../src/fleet_logic');

test('semantic version comparison is deterministic', () => {
  assert.equal(compareVersions('1.2.3', '1.2.2'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3-beta', '1.2.3'), -1);
  assert.equal(compareVersions('invalid', '1.0.0'), null);
});

test('health score penalizes operational failures', () => {
  const good = computeHealthScore({ connected: 1, criticalErrors: 0, databaseStatus: 'healthy', syncStatus: 'synced', freeDiskMb: 5000 });
  const bad = computeHealthScore({ connected: 0, criticalErrors: 3, databaseStatus: 'corrupt', syncStatus: 'stalled', freeDiskMb: 100 });
  assert.equal(good.score, 100);
  assert.equal(good.status, 'healthy');
  assert.ok(bad.score < 40);
  assert.equal(bad.status, 'critical');
});

test('rollout assignment is stable per installation and release', () => {
  const a = isInRollout('MERKA-1', 7, 25);
  const b = isInRollout('MERKA-1', 7, 25);
  assert.equal(a, b);
  assert.equal(isInRollout('MERKA-1', 7, 100), true);
  assert.equal(isInRollout('MERKA-1', 7, 0), false);
});

test('error signatures group numeric variants of the same failure', () => {
  const a = errorSignature({ module: 'inventory', message: 'row 123 failed at 0xFFAA', stack: 'x.dart:12:30' });
  const b = errorSignature({ module: 'inventory', message: 'row 999 failed at 0xABCD', stack: 'x.dart:99:2' });
  assert.equal(a, b);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createFactoryAdapter } from './factory-adapter.mjs';
import { commandDigest, validateAction } from './protocol.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'mobile-usage-')), workersDir = join(root, 'workers'); mkdirSync(workersDir);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = Date.now(); const calls = [], grants = { owner_fixture: { actor: '用户', role: 'owner' } };
  const totals = { inputTokens: 1200, cachedInputTokens: 900, uncachedInputTokens: 300, outputTokens: 100, totalTokens: 1300, totalWithCachedTokens: 1300 };
  const registry = async () => [{ name: 'worker', displayName: '显示名', status: 'idle', lastInteractionAt: '2026-09-24T02:00:00.000Z', lastTalkReply: { contentPreview: 'recent reply', updatedAt: '2026-09-24T02:00:00Z', privatePath: '/secret' }, tokenToday: { input: 1200, output: 100, cachedInput: 900, total: 1300, source: 'job', credential: 'secret-must-not-forward' }, unreadCount: 2 }];
  const factoryFetch = async (url, options) => {
    assert.equal(url.origin, 'http://127.0.0.1:8787'); assert.equal(options.redirect, 'error'); assert.equal(options.method, undefined);
    calls.push(url.pathname + url.search);
    return { ok: true, json: async () => url.pathname === '/api/tokens' ? { generatedAt: new Date(now).toISOString(), totals, warnings: ['/private/credential.log'], apiCost: { secret: 'must-not-forward' }, workers: [{ worker: 'worker', source: 'job', reported: totals, rawLog: 'must-not-forward' }] } : { generatedAt: new Date(now).toISOString(), days: [{ date: '2026-09-24', ...totals, rawPath: 'must-not-forward' }] } };
  };
  const adapter = createFactoryAdapter({ workersDir, stateDir: join(root, 'state'), grants: () => grants, registry, factoryFetch, now: () => now });
  const command = body => { const action = 'usage.read', clean = validateAction(action, body); return { id: randomUUID(), action, body: clean, digest: commandDigest(action, clean), principalId: 'owner_fixture', role: 'viewer', expiresAt: now + 60000 }; };
  return { adapter, command, calls, grants, advance: () => { now += 16000; } };
}

test('usage protocol accepts only bounded read ranges and real calendar dates', () => {
  assert.deepEqual(validateAction('usage.read', {}), { days: 7 });
  assert.deepEqual(validateAction('usage.read', { date: '2024-02-29', days: 30 }), { days: 30, date: '2024-02-29' });
  for (const body of [{ url: 'https://evil.example' }, { days: 100000 }, { days: '7' }, { date: '2026-02-29' }, { date: '../../secret' }, { date: '2026-09-24&worker=admin' }]) assert.throws(() => validateAction('usage.read', body));
});
test('usage reads existing factory endpoints and forwards aggregates without duplicating cached tokens', async t => {
  const f = setup(t), result = await f.adapter.execute(f.command({ date: '2026-09-24', days: 7 }));
  assert.deepEqual(f.calls.sort(), ['/api/tokens/trend?days=7', '/api/tokens?date=2026-09-24']);
  assert.equal(result.report.totals.totalTokens, 1300); assert.equal(result.report.totals.cachedInputTokens, 900);
  assert.equal(result.report.warningCount, 1); assert.equal(result.trend.days.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private|credential|must-not-forward|apiCost|rawLog|rawPath/);
});
test('usage cache is bounded in time and never skips current local authorization', async t => {
  const f = setup(t);
  await f.adapter.execute(f.command({})); await f.adapter.execute(f.command({})); assert.equal(f.calls.length, 2);
  f.advance(); await f.adapter.execute(f.command({})); assert.equal(f.calls.length, 4);
  f.grants.owner_fixture.revoked = true;
  await assert.rejects(f.adapter.execute(f.command({})), e => e.code === 'LOCAL_GRANT_DENIED'); assert.equal(f.calls.length, 4);
});
test('worker snapshot reuses desktop activity and token metadata but drops private fields', async t => {
  const f = setup(t), snapshot = await f.adapter.snapshot(), w = snapshot.workers[0];
  assert.equal(w.lastInteractionAt, '2026-09-24T02:00:00.000Z'); assert.equal(w.name, '显示名'); assert.equal(w.tokenToday.total, 1300); assert.equal(w.unreadCount, 2);
  assert.ok(snapshot.capabilities.includes('usage.read')); assert.match(snapshot.usageDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.doesNotMatch(JSON.stringify(snapshot), /privatePath|credential|secret-must/);
});

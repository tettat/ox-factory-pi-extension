import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { createPushCoordinator, loadPushDriver, validateSubscription } from './push.mjs';

const key = createECDH('prime256v1'); key.generateKeys();
const subscription = () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/test-fixture', expirationTime: null, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } });
test('push endpoints reject SSRF, credentials, ports, non-HTTPS and malformed keys', () => {
  for (const endpoint of ['http://fcm.googleapis.com/a', 'https://127.0.0.1/a', 'https://evil.example/a', 'https://web.push.apple.com.evil.example/a', 'https://user:password@fcm.googleapis.com/a', 'https://fcm.googleapis.com:8443/a', 'https://fcm.googleapis.com/a#fragment']) assert.throws(() => validateSubscription({ ...subscription(), endpoint }));
  assert.throws(() => validateSubscription({ ...subscription(), keys: { auth: 'abc', p256dh: 'abc' } }));
  for (const endpoint of ['https://web.push.apple.com/fixture', 'https://updates.push.services.mozilla.com/wpush/fixture']) assert.doesNotThrow(() => validateSubscription({ ...subscription(), endpoint }));
});
test('optional push driver is disabled without configuration and accepts a valid VAPID pair without sending', async () => {
  assert.equal(await loadPushDriver(null), null);
  const { default: webpush } = await import('web-push');
  const config = { subject: 'https://example.com/contact', ...webpush.generateVAPIDKeys() };
  const driver = await loadPushDriver(config); assert.equal(driver.publicKey, config.publicKey); assert.equal(typeof driver.send, 'function');
});
function fixture() {
  let now = 100000; const sent = []; let saves = 0;
  const state = { sessions: { a: { id: 'phone-a', expiresAt: 9999999 }, b: { id: 'phone-b', expiresAt: 9999999 }, c: { id: 'phone-c', expiresAt: 9999999, revokedAt: 'revoked' } }, devices: {}, pushSubscriptions: { 'phone-a': subscription(), 'phone-b': subscription(), 'phone-c': subscription() } };
  const device = { id: 'device-a', snapshot: { jobs: [{ id: 'job-a', status: 'done', task: 'SECRET TASK BODY', worker: 'PRIVATE NAME' }] } }; state.devices[device.id] = device;
  const options = { state, driver: { send: async (...args) => sent.push(args) }, persist: () => saves++, now: () => now, canSee: (s, d) => s.id === 'phone-a' && !d?.revokedAt };
  const push = createPushCoordinator(options);
  return { state, device, options, push, sent, advance: ms => now += ms, saved: () => saves };
}
test('push has no historical burst, is scope-filtered, deduplicated and excludes private job contents', async () => {
  const f = fixture(); f.push.enqueue(f.device, null); await f.push.drain(); assert.equal(f.sent.length, 0);
  const before = { jobs: [{ id: 'job-a', status: 'running' }] };
  f.push.enqueue(f.device, before); f.push.enqueue(f.device, before); await f.push.drain();
  assert.equal(f.sent.length, 1); assert.doesNotMatch(JSON.stringify(f.sent[0]), /SECRET TASK BODY|PRIVATE NAME/);
  await f.push.drain(); assert.equal(f.sent.length, 1); assert.ok(f.saved() > 0);
});
test('pending notifications are cancelled when a session or device is revoked', async () => {
  const f = fixture(); f.push.enqueue(f.device, { jobs: [] }); f.device.revokedAt = 'now'; await f.push.drain(); assert.equal(f.sent.length, 0);
  f.push.remove('phone-a'); assert.equal(f.state.pushSubscriptions['phone-a'], undefined); assert.equal(Object.keys(f.state.pushDeliveries).length, 0);
});
test('push retry outbox survives restart; 410 removes an expired subscription', async () => {
  const f = fixture(); f.options.driver.send = async () => { throw { statusCode: 503 }; };
  f.push.enqueue(f.device, { jobs: [] }); await f.push.drain(); assert.equal(Object.values(f.state.pushDeliveries)[0].attempts, 1);
  const recovered = JSON.parse(JSON.stringify(f.state)); f.advance(60000);
  const restarted = createPushCoordinator({ ...f.options, state: recovered, driver: { send: async () => { throw { statusCode: 410 }; } } });
  await restarted.drain(); assert.equal(recovered.pushSubscriptions['phone-a'], undefined); assert.equal(Object.keys(recovered.pushDeliveries).length, 0);
});

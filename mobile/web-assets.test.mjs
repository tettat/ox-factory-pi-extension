import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { initialState, createMobileHub } from './hub.mjs';
import { WEB_ASSETS } from './web-assets.mjs';

test('standalone Hub serves every renderer asset with strict scripts and local fonts', async t => {
  const state = initialState({ principalId: 'owner_assets', deviceId: 'device_assets', deviceName: 'fixture', deviceSecret: 'fixture-only', pairingCode: 'fixture-only' });
  const { server } = createMobileHub({ origin: 'https://assets.example.com', stateStore: { read: () => state, write: () => {} } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  function get(path) {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path, headers: { host: 'assets.example.com' } }, res => {
        const data = []; res.on('data', b => data.push(b)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(data) }));
      }); req.on('error', reject); req.end();
    });
  }
  for (const file of WEB_ASSETS) {
    const r = await get(file === 'index.html' ? '/' : '/' + file);
    assert.equal(r.status, 200, file); assert.ok(r.bytes.length, file);
    const csp = r.headers['content-security-policy'];
    assert.match(csp, /script-src 'self';/); assert.match(csp, /style-src 'self';/);
    assert.match(csp, /style-src-attr 'unsafe-inline';/); assert.match(csp, /font-src 'self';/);
    assert.match(r.headers['content-type'], file.endsWith('.woff2') ? /^font\/woff2/ : file.endsWith('.js') ? /^text\/javascript/ : /^\w+\//);
  }
  for (const path of ['/vendor/not-allowlisted.js', '/vendor/../package.json', '/vendor/fonts/../../../hub.mjs']) assert.notEqual((await get(path)).status, 200, path);
});

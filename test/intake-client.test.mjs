import assert from 'node:assert/strict';
import http from 'node:http';
import { after, describe, it } from 'node:test';

import { buildApiUrl, formatTicketTask, runOnce } from '../intake-client.mjs';

function createFakeIntakeServer() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const body = bodyText ? JSON.parse(bodyText) : null;
    const url = new URL(req.url, 'http://127.0.0.1');
    calls.push({ method: req.method, path: url.pathname, search: url.search, auth: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && url.pathname === '/api/agent/heartbeat') {
      res.end(JSON.stringify({ ok: true, agent: { status: 'online' } }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/agent/poll') {
      res.end(JSON.stringify({
        ok: true,
        tickets: [{
          id: 'tkt_1',
          projectId: 'prj_1',
          serviceId: 'svc_1',
          title: '修按钮',
          body: '页面按钮点不动',
          requester: 'tester',
          status: 'leased',
        }],
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/events') {
      res.end(JSON.stringify({ ok: true, event: { id: 'evt_1' } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, calls, baseUrl: `http://127.0.0.1:${address.port}/api` });
    });
  });
}

describe('intake client', () => {
  it('builds API URLs without duplicating /api when base-url already points at the API root', () => {
    assert.equal(
      buildApiUrl('https://example.com/bes_deploy/factory-intake/api', '/api/agent/poll').toString(),
      'https://example.com/bes_deploy/factory-intake/api/agent/poll',
    );
    assert.equal(
      buildApiUrl('https://example.com/bes_deploy/factory-intake', '/api/agent/poll').toString(),
      'https://example.com/bes_deploy/factory-intake/api/agent/poll',
    );
  });

  it('heartbeats, polls one ticket, delivers it, and writes a progress event', async () => {
    const fake = await createFakeIntakeServer();
    after(() => fake.server.close());
    const deliveries = [];

    const result = await runOnce({
      baseUrl: fake.baseUrl,
      token: 'ofi_test_token',
      serviceId: 'svc_1',
      target: '秘书',
      from: '接单平台',
      deliver: async (delivery) => {
        deliveries.push(delivery);
        return { ok: true, id: 'delivery_1' };
      },
    });

    assert.equal(result.tickets.length, 1);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].to, '秘书');
    assert.match(deliveries[0].content, /tkt_1/);
    assert.match(deliveries[0].content, /修按钮/);
    assert.deepEqual(
      fake.calls.map((call) => `${call.method} ${call.path}`),
      ['POST /api/agent/heartbeat', 'GET /api/agent/poll', 'POST /api/agent/events'],
    );
    assert.equal(fake.calls[0].auth, 'Bearer ofi_test_token');
    assert.equal(fake.calls[2].body.ticketId, 'tkt_1');
    assert.equal(fake.calls[2].body.type, 'progress');
  });

  it('formats ticket content for humans without exposing internal control commands', () => {
    const content = formatTicketTask({ id: 'tkt_2', title: '做调研', body: '请看看方案', requester: '外部用户' }, { baseUrl: 'https://x/api' });
    assert.match(content, /外部接单平台/);
    assert.match(content, /做调研/);
    assert.doesNotMatch(content, /factory_command/);
    assert.doesNotMatch(content, /work:assign/);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureCodexAppServer } from '../codex-backend.mjs';

test('existing app-server is reused when HTTP readiness fails but WebSocket initializes', async () => {
  const previousFetch = globalThis.fetch;
  const previousWebSocket = globalThis.WebSocket;
  let closed = 0;
  class ReadySocket {
    static OPEN = 1;
    constructor() { this.readyState = 1; queueMicrotask(() => this.onopen?.()); }
    send(raw) {
      const message = JSON.parse(raw);
      if (message.id) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result: {} }) }));
    }
    close() { closed++; this.readyState = 3; }
  }
  globalThis.fetch = async () => { throw new Error('HTTP readiness unavailable'); };
  globalThis.WebSocket = ReadySocket;
  try {
    const result = await ensureCodexAppServer('ws://127.0.0.1:48179');
    assert.equal(result.started, false);
    assert.equal(closed, 1);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.WebSocket = previousWebSocket;
  }
});

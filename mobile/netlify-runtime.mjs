// Netlify is a separate trusted hosting target, not a bypass of SSH host checks.
// Reuse the existing Hub authorization protocol. Blob CAS is the single writer
// boundary: never return a cookie, command lease or acknowledgement before commit.
import { Readable } from 'node:stream';
import { createMobileHub } from './hub.mjs';
import { httpsOrigin } from './netlify-proxy.mjs';

export const HUB_STORE_NAME = 'ox-mobile-hub-v1';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const errorResponse = (status, error) => Response.json({ error }, { status, headers: {
  'cache-control': 'no-store', 'netlify-cdn-cache-control': 'no-store', 'x-content-type-options': 'nosniff',
} });

async function capture(hub, request, bytes, clientIp) {
  const req = Readable.from(bytes.length ? [bytes] : []), url = new URL(request.url);
  req.method = request.method; req.url = url.pathname + url.search;
  req.headers = Object.fromEntries(request.headers);
  req.headers.host = url.host; req.headers['content-length'] = String(bytes.length);
  req.socket = { remoteAddress: clientIp };
  return new Promise((resolve, reject) => {
    const res = { headersSent: false, status: 200, headers: {},
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; return this; },
      end(value = '') {
        const body = Buffer.from(value);
        resolve({ status: this.status, headers: this.headers, body });
      },
    };
    try { hub.server.emit('request', req, res); } catch (error) { reject(error); }
  });
}

export function createNetlifyHubHandler({ store, origin, siteId, maxAttempts = 5, now = Date.now }) {
  httpsOrigin(origin);
  if (!/^[a-f0-9-]{36}$/.test(siteId)) throw new Error('A pinned Netlify site ID is required');
  return async (request, context) => {
    try {
      const url = new URL(request.url);
      // Preview/old deploys and the direct function URL must never operate on
      // the production store. Context is supplied by Netlify, not request headers.
      if (context?.site?.id !== siteId || context?.site?.url !== origin || context?.deploy?.context !== 'production'
          || context?.deploy?.published !== true || url.origin !== origin) return errorResponse(403, 'PRODUCTION_SITE_REQUIRED');
      if (url.pathname !== '/health' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/connector/')) return errorResponse(404, 'NOT_FOUND');
      if (!['GET', 'POST'].includes(request.method)) return errorResponse(405, 'METHOD_NOT_ALLOWED');
      if (!context.ip || typeof context.ip !== 'string' || context.ip.length > 128) return errorResponse(503, 'CLIENT_CONTEXT_UNAVAILABLE');
      if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) return errorResponse(413, 'PAYLOAD_TOO_LARGE');
      const chunks = []; let size = 0;
      if (request.body) for await (const chunk of request.body) {
        size += chunk.byteLength;
        if (size > MAX_BODY_BYTES) return errorResponse(413, 'PAYLOAD_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const entry = await store.getWithMetadata('state', { type: 'json', consistency: 'strong' });
        if (!entry) return errorResponse(503, 'HUB_NOT_CONFIGURED');
        if (!entry.etag || entry.data?.version !== 1) return errorResponse(503, 'HUB_STATE_INVALID');
        let dirty = false;
        const state = structuredClone(entry.data);
        const hub = createMobileHub({ origin, now, nextPollMs: 3000, maxLeasedCommands: 1,
          stateStore: { read: () => state, write: () => { dirty = true; } } });
        const response = await capture(hub, request, bytes, context.ip);
        hub.server.removeAllListeners(); // No socket was opened by this adapter.
        if (response.body.length > MAX_RESPONSE_BYTES) return errorResponse(413, 'RESPONSE_TOO_LARGE');
        if (dirty) {
          const committed = await store.setJSON('state', hub.state, { onlyIfMatch: entry.etag });
          if (!committed.modified) {
            await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1) + Math.floor(Math.random() * 30)));
            continue;
          }
        }
        return new Response(response.body, { status: response.status, headers: {
          ...response.headers, 'netlify-cdn-cache-control': 'no-store',
        } });
      }
      return errorResponse(503, 'HUB_BUSY_RETRY_SAME_ID');
    } catch {
      // Provider errors can contain internal URLs. Do not log or return them.
      return errorResponse(503, 'HUB_STORAGE_UNAVAILABLE');
    }
  };
}

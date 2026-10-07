import { createHmac, timingSafeEqual } from 'node:crypto';
import { Fault } from './protocol.mjs';

export function httpsOrigin(value) {
  const url = new URL(value);
  if (url.origin !== value || url.protocol !== 'https:' || url.username || url.password) throw new Error('An exact HTTPS origin is required (no path, credentials or trailing slash)');
  return value;
}

// The shared secret stays in Netlify Runtime environment variables and the
// private Hub config, never in the PWA, netlify.toml, or a client request.
export function browserGateway({ origin, browserOrigin = origin, netlifyProxy = null, now = Date.now }) {
  if (!netlifyProxy) {
    if (browserOrigin !== origin) throw new Error('A separate browser origin requires a signed Netlify gateway');
    return { browserOrigin, check() {} };
  }
  httpsOrigin(origin); httpsOrigin(browserOrigin);
  if (origin === browserOrigin || !/^[A-Za-z0-9_-]{43,128}$/.test(netlifyProxy.secret || '')) throw new Error('Use separate Hub/PWA HTTPS origins and a random proxy secret of at least 256 bits');
  return { browserOrigin, check(req, path) {
    if (!path.startsWith('/api/')) return;
    try {
      const raw = req.headers['x-nf-sign'];
      if (typeof raw !== 'string' || raw.length > 4096) throw Error();
      const parts = raw.split('.');
      if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw Error();
      const [header, payload] = parts.slice(0, 2).map(p => JSON.parse(Buffer.from(p, 'base64url').toString('utf8')));
      if (header.alg !== 'HS256' || header.crit !== undefined || header.b64 !== undefined) throw Error();
      const signature = Buffer.from(parts[2], 'base64url');
      const expected = createHmac('sha256', netlifyProxy.secret).update(parts[0] + '.' + parts[1]).digest();
      if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw Error();
      if (payload.iss !== 'netlify' || payload.deploy_context !== 'production' || payload.site_url !== browserOrigin || !Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(now() / 1000)) throw Error();
      if (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || payload.nbf > Math.floor(now() / 1000))) throw Error();
    } catch { throw new Fault('GATEWAY_AUTH_FAILED', 403); }
    // GETs do not require Origin, but a supplied foreign Origin is never trusted.
    // Writes still need exact Origin + session CSRF in the Hub itself.
    if (req.headers.origin && req.headers.origin !== browserOrigin) throw new Fault('ORIGIN_REJECTED', 403);
  } };
}

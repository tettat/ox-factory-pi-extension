#!/usr/bin/env node
// A deployment bundle contains public UI only; never publish mobile/ or the repo.
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpsOrigin } from './netlify-proxy.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '..');
const assets = ['index.html', 'app.js', 'ui.js', 'style.css', 'sw.js', 'manifest.webmanifest', 'icon.svg'];
export function netlifyConfig(hubOrigin = '') {
  if (hubOrigin) httpsOrigin(hubOrigin);
  return `[build]
  publish = "public"

[[redirects]]
  from = "/api/*"
  to = ${JSON.stringify(hubOrigin ? hubOrigin + '/api/:splat' : '/backend-unavailable.json')}
  status = ${hubOrigin ? 200 : 404}
  force = true
${hubOrigin ? '  signed = "OX_PROXY_SIGNING_KEY"\n' : ''}
[[headers]]
  for = "/*"
  [headers.values]
    Cache-Control = "no-store"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "no-referrer"
    X-Frame-Options = "DENY"
    X-Robots-Tag = "noindex, nofollow"
    Permissions-Policy = "camera=(), microphone=(), geolocation=()"
    Content-Security-Policy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

[[headers]]
  for = "/sw.js"
  [headers.values]
    Service-Worker-Allowed = "/"
    Cache-Control = "no-cache, no-store, must-revalidate"

[[headers]]
  for = "/manifest.webmanifest"
  [headers.values]
    Content-Type = "application/manifest+json; charset=utf-8"
`;
}

export function prepareNetlify({ output, hubOrigin = '' }) {
  const destination = resolve(output), allowed = join(root, 'output');
  if (!destination.startsWith(allowed + '/') && !destination.startsWith(allowed + '\\')) throw new Error('Choose a new deployment directory under workspace/output');
  if (existsSync(destination)) throw new Error('Deployment directory already exists; use a new version');
  const config = netlifyConfig(hubOrigin); // validate before writing
  mkdirSync(dirname(destination), { recursive: true });
  const parent = realpathSync(dirname(destination));
  if (parent !== allowed && !parent.startsWith(allowed + '/') && !parent.startsWith(allowed + '\\')) throw new Error('Deployment parent escapes workspace/output');
  mkdirSync(join(destination, 'public'), { recursive: true });
  for (const asset of assets) copyFileSync(join(here, 'web', asset), join(destination, 'public', asset));
  writeFileSync(join(destination, 'netlify.toml'), config);
  // Netlify Drop processes public files, not netlify.toml: keep static headers
  // in the publish directory too. Neither file contains a secret.
  const headers = `/*
  Cache-Control: no-store
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  X-Robots-Tag: noindex, nofollow
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
/sw.js
  Service-Worker-Allowed: /
  Cache-Control: no-cache, no-store, must-revalidate
/manifest.webmanifest
  Content-Type: application/manifest+json; charset=utf-8
`;
  writeFileSync(join(destination, 'public', '_headers'), headers);
  if (!hubOrigin) {
    const index = join(destination, 'public', 'index.html');
    writeFileSync(index, readFileSync(index, 'utf8').replace('<head>', '<head><meta name="ox-backend" content="pending">'));
    writeFileSync(join(destination, 'public', 'backend-unavailable.json'), JSON.stringify({ error: 'HUB_NOT_CONFIGURED' }));
    writeFileSync(join(destination, 'public', '_redirects'), '/api/* /backend-unavailable.json 404\n');
  }
  const manifest = { createdAt: new Date().toISOString(), mode: hubOrigin ? 'signed-proxy' : 'frontend-only-backend-not-configured', hubOrigin: hubOrigin || null, publicFiles: [...assets, '_headers', ...(hubOrigin ? [] : ['_redirects', 'backend-unavailable.json'])], containsCredentials: false };
  writeFileSync(join(destination, 'deployment.json'), JSON.stringify(manifest, null, 2));
  return { output: destination, ...manifest };
}

export async function verifyNetlify(url) {
  httpsOrigin(url);
  const get = path => fetch(url + path, { redirect: 'error', signal: AbortSignal.timeout(15000), cache: 'no-store' });
  const [page, api, sw] = await Promise.all([get('/'), get('/api/me'), get('/sw.js')]);
  const html = await page.text(); let body = {}; try { body = await api.json(); } catch {}
  return { url, frontendReachable: page.ok && html.includes('随身工作台'), frontendOnly: html.includes('name="ox-backend" content="pending"'), serviceWorkerReachable: sw.ok && (sw.headers.get('content-type') || '').includes('javascript'), csp: !!page.headers.get('content-security-policy'), noStore: /no-store/i.test(api.headers.get('cache-control') || ''), apiStatus: api.status, apiError: body.error || null, hubAuthenticatedEndpointReachable: api.status === 401 && body.error === 'LOGIN_REQUIRED', fullRemoteAcceptance: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, value, ...options] = process.argv.slice(2);
    if (command === 'prepare' && value && (!options.length || (options.length === 2 && options[0] === '--hub'))) console.log(JSON.stringify(prepareNetlify({ output: value, hubOrigin: options[1] || '' }), null, 2));
    else if (command === 'verify' && value && !options.length) { const report = await verifyNetlify(value); console.log(JSON.stringify(report, null, 2)); if (!report.hubAuthenticatedEndpointReachable) process.exitCode = 2; }
    else throw new Error('Usage: node mobile/netlify.mjs prepare output/mobile-netlify-v01 [--hub https://verified-hub.example.com] | verify https://your-site.netlify.app');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

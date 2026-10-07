#!/usr/bin/env node
// Builds code artifacts only. Credentials and the persistent Hub state are
// provisioned separately, over the authenticated provider API, never in public/.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareNetlify, netlifyConfig } from './netlify.mjs';
import { httpsOrigin } from './netlify-proxy.mjs';
const here = dirname(fileURLToPath(import.meta.url));

export function prepareNetlifyHub({ output, origin, siteId }) {
  httpsOrigin(origin);
  if (!/^[a-f0-9-]{36}$/.test(siteId)) throw new Error('Specify the existing, owned Netlify site ID');
  const result = prepareNetlify({ output, hubOrigin: origin }), dir = result.output;
  const config = netlifyConfig(origin), headers = config.slice(config.indexOf('[[headers]]'));
  writeFileSync(join(dir, 'netlify.toml'), `[build]\n  publish = "public"\n\n[functions]\n  directory = "functions"\n  node_bundler = "esbuild"\n\n${headers}`);
  const index = join(dir, 'public', 'index.html');
  writeFileSync(index, readFileSync(index, 'utf8').replace('<head>', '<head><meta name="ox-login" content="password"><meta name="ox-max-image-mib" content="2">'));
  mkdirSync(join(dir, 'runtime')); mkdirSync(join(dir, 'functions'));
  for (const file of ['netlify-runtime.mjs', 'hub.mjs', 'protocol.mjs', 'store.mjs', 'push.mjs', 'netlify-proxy.mjs', 'password.mjs']) copyFileSync(join(here, file), join(dir, 'runtime', file));
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(here, file), join(dir, file));
  writeFileSync(join(dir, 'functions', 'mobile-hub.mjs'), `import { getStore } from '@netlify/blobs';\nimport { createNetlifyHubHandler, HUB_STORE_NAME } from ${JSON.stringify('../runtime/netlify-runtime.mjs')};\nexport default async (request, context) => {\n  const store = getStore({ name: HUB_STORE_NAME, consistency: 'strong' });\n  return createNetlifyHubHandler({ store, origin: ${JSON.stringify(origin)}, siteId: ${JSON.stringify(siteId)} })(request, context);\n};\nexport const config = { path: ['/health', '/api/*', '/connector/*'], rateLimit: { action: 'rate_limit', aggregateBy: ['ip'], windowSize: 60, windowLimit: 300 } };\n`);
  const manifest = { createdAt: new Date().toISOString(), mode: 'persistent-netlify-hub', origin, siteId,
    publicFiles: result.publicFiles, credentialsIncluded: false, stateIncluded: false, storage: 'site-wide-strong-read-conditional-write' };
  writeFileSync(join(dir, 'deployment.json'), JSON.stringify(manifest, null, 2));
  return { output: dir, ...manifest };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [output, origin, siteId, ...extra] = process.argv.slice(2);
    if (!output || !origin || !siteId || extra.length) throw new Error('Usage: node mobile/netlify-hub.mjs output/version https://owned-site.netlify.app <existing-site-id>');
    console.log(JSON.stringify(prepareNetlifyHub({ output, origin, siteId }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

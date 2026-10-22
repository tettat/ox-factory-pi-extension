#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readJson, writeJson } from './store.mjs';
import { localEndpoint, connectChrome } from './browser-cdp.mjs';
import { webPage } from './browser-protocol.mjs';
import { readInstances, runBrowserAgent } from './browser-agent.mjs';
function options(argv) {
  const [command, ...args] = argv, o = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!/^--[a-z-]+$/.test(args[i]) || !args[i+1] || args[i+1].startsWith('--') || Object.hasOwn(o, args[i].slice(2))) throw Error('Use --option value');
    o[args[i].slice(2)] = args[i+1];
  }
  const allowed = { init: ['state', 'connector-config'], launch: ['state', 'id', 'name', 'url', 'chrome', 'headless'], register: ['state', 'name', 'endpoint'], unregister: ['state', 'id'], status: ['state'], agent: ['state'] };
  if (!allowed[command] || Object.keys(o).some(k => !allowed[command].includes(k))) throw Error('Commands: init, launch, register, unregister, status, agent');
  return { command, o };
}
export async function browserCli(argv) {
  const { command, o } = options(argv), dir = resolve(o.state || '.pi/mobile-browser'), configFile = join(dir, 'config.json');
  if (command === 'init') {
    if (existsSync(configFile)) throw Error('Browser agent is already configured; refusing to replace local authorization');
    if (!o['connector-config']) throw Error('init requires --connector-config <existing-private-config>');
    const connectorConfig = resolve(o['connector-config']), c = readJson(connectorConfig, null);
    if (!c?.credential || !c?.hub || !c?.grants) throw Error('Existing Connector config required');
    const grants = Object.fromEntries(Object.entries(c.grants).filter(([,g]) => g.role === 'owner').map(([id]) => [id, 'control']));
    if (!Object.keys(grants).length) throw Error('No local owner grant; configure authorization locally first');
    writeJson(configFile, { version: 1, enabled: true, connectorConfig, grants });
    return { configured: true, note: 'Existing factory owners explicitly enabled. No password or device identity copied.' };
  }
  if (command === 'status') return { configured: !!readJson(configFile, null), health: readJson(join(dir, 'health.json'), null), instances: readInstances(dir).map(({ id, name }) => ({ id, name })) };
  if (command === 'agent') {
    const abort = new AbortController(); process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort());
    await runBrowserAgent({ configFile, stateDir: dir, signal: abort.signal }); return { stopped: true };
  }
  if (command === 'unregister') {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(o.id || '')) throw Error('Invalid instance ID');
    const file = join(dir, 'instances', o.id + '.json'); if (existsSync(file)) unlinkSync(file);
    return { removed: o.id, note: 'Chrome was not closed and its profile was not deleted.' };
  }
  const previous = o.id && readInstances(dir).find(i => i.id === o.id);
  if (o.id && (!previous?.managed || !/^chrome_[a-zA-Z0-9_-]+$/.test(o.id))) throw Error('Only launcher-managed instance IDs can be reopened');
  if (!previous && readInstances(dir).length >= 20) throw Error('At most 20 registered instances; unregister an old one first');
  const id = previous?.id || 'chrome_' + randomUUID(), name = (o.name || previous?.name || '员工 Chrome').trim().slice(0, 80);
  let endpoint, browserId;
  if (command === 'register') {
    endpoint = localEndpoint(o.endpoint);
    if (readInstances(dir).some(i => i.endpoint === endpoint)) throw Error('This endpoint is already registered');
    const cdp = await connectChrome(endpoint); browserId = cdp.browserId; cdp.close();
  } else {
    const url = o.url || 'about:blank'; if (!webPage(url)) throw Error('Only HTTP(S) or about:blank URLs can be opened');
    if (previous) {
      let cdp; try { cdp = await connectChrome(previous.endpoint, previous.browserId); } catch {}
      if (cdp) {
        try { const { targetId } = await cdp.call('Target.createTarget', { url }); return { id, name, registered: true, openedTab: targetId }; } finally { cdp.close(); }
      }
    }
    const candidates = [o.chrome, process.env.OX_CHROME_PATH, process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'), process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'), process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
    const chrome = candidates.find(p => existsSync(p)); if (!chrome) throw Error('Chrome not found. Specify --chrome <executable>');
    // A fresh, persistent dedicated profile. Never read/copy the normal profile.
    const profile = join(dir, 'profiles', id); mkdirSync(profile, { recursive: true });
    // Remove only this managed profile's stale port marker, never a profile.
    const portFile = join(profile, 'DevToolsActivePort'); if (existsSync(portFile)) unlinkSync(portFile);
    const args = ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', ...(o.headless === 'true' ? ['--headless=new'] : []), url];
    const child = spawn(chrome, args, { detached: true, stdio: 'ignore', windowsHide: o.headless === 'true' }); let spawnError = false;
    child.once('error', () => { spawnError = true; }); child.unref();
    for (let attempt = 0; attempt < 80; attempt++) {
      if (spawnError) throw Error('Cannot start Chrome');
      try { const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); endpoint = localEndpoint('http://127.0.0.1:' + port); break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    if (!endpoint) throw Error('Chrome did not expose its loopback debugging port; no existing Chrome was stopped');
    const cdp = await connectChrome(endpoint); browserId = cdp.browserId; cdp.close();
  }
  writeJson(join(dir, 'instances', id + '.json'), { id, name, endpoint, browserId, managed: command === 'launch', registeredAt: new Date().toISOString() });
  return { id, name, registered: true, note: 'Only this explicitly registered Chrome is available to the phone.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await browserCli(process.argv.slice(2)))); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}

// Private, host-local selection shared by the PC directory and peer commands.
// No URL/credential can be supplied by a browser request. Do not fall back to
// an old Hub when an explicitly selected Connector is unavailable.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { writeJson } from './store.mjs';

const fail = code => { throw Object.assign(new Error(code), { code, status: 503 }); };
const hostRoot = workersDir => resolve(workersDir, '..', '..');
const selectorFile = workersDir => join(hostRoot(workersDir), '.pi', 'mobile-pc.json');
const json = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fail('PC_CONNECTOR_CONFIG_INVALID'); } };
const pathFrom = (root, value) => typeof value === 'string' && value ? resolve(root, value) : fail('PC_CONNECTOR_CONFIG_INVALID');

export function hasPcConnector(workersDir) {
  const root = hostRoot(workersDir);
  return [selectorFile(workersDir), join(root, '.pi/mobile-cloudflare/connector-config.json'), join(root, '.pi/mobile-netlify/connector-config.json')].some(existsSync);
}

export function loadPcConnector(workersDir) {
  const root = hostRoot(workersDir), selected = selectorFile(workersDir);
  let configFile, stateDir, pinnedHub, source;
  if (existsSync(selected)) {
    const s = json(selected);
    if (s.version !== 1 || Object.keys(s).some(k => !['version', 'connectorConfig', 'runtimeState', 'hub'].includes(k))) fail('PC_CONNECTOR_SELECTION_INVALID');
    configFile = pathFrom(root, s.connectorConfig); stateDir = pathFrom(root, s.runtimeState); pinnedHub = s.hub; source = 'selected';
  } else {
    const cf = join(root, '.pi/mobile-cloudflare/connector-config.json'), old = join(root, '.pi/mobile-netlify/connector-config.json');
    if (existsSync(cf)) { configFile = cf; source = 'cloudflare'; }
    else if (existsSync(old)) { configFile = old; source = 'netlify'; const previous = join(root, '.pi/service/mobile-netlify-connector'); if (existsSync(previous)) stateDir = previous; }
    else return null;
  }
  const config = json(configFile);
  let url; try { url = new URL(config.hub); } catch { fail('PC_CONNECTOR_HUB_INVALID'); }
  if (url.protocol !== 'https:' || url.origin !== config.hub || url.username || url.password || (pinnedHub && pinnedHub !== config.hub)) fail('PC_CONNECTOR_HUB_INVALID');
  if (!/^[A-Za-z0-9_-]{43}$/.test(config.credential || '')) fail('PC_CONNECTOR_CREDENTIAL_INVALID');
  if (!isAbsolute(config.workersDir || '') || resolve(config.workersDir) !== resolve(workersDir)) fail('PC_CONNECTOR_WORKERS_MISMATCH');
  stateDir ||= pathFrom(root, config.stateDir);
  return { hub: config.hub, credential: config.credential, deviceId: config.deviceId || null, configFile, stateDir, source };
}

export function readPcDirectory(workersDir, { maxAgeMs = 30000, now = Date.now() } = {}) {
  try {
    const c = loadPcConnector(workersDir); if (!c) return null;
    const d = json(join(c.stateDir, 'hub-directory.json'));
    const age = now - Number(d.receivedAt);
    if (d.version !== 1 || d.hub !== c.hub || !d.localDeviceId || !Array.isArray(d.devices) || !d.devices.some(x => x.id === d.localDeviceId) || (c.deviceId && c.deviceId !== d.localDeviceId) || !Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
    return { connection: { url: c.hub, localDeviceId: d.localDeviceId, source: c.source }, state: { devices: d.devices } };
  } catch { return null; }
}

export function selectPcConnector({ workersDir, configFile, stateDir }) {
  workersDir = resolve(workersDir); configFile = resolve(configFile);
  if (!existsSync(workersDir)) fail('PC_CONNECTOR_WORKERS_MISSING');
  const c = json(configFile), root = hostRoot(workersDir);
  let u; try { u = new URL(c.hub); } catch { fail('PC_CONNECTOR_HUB_INVALID'); }
  if (u.protocol !== 'https:' || u.origin !== c.hub || u.username || u.password) fail('PC_CONNECTOR_HUB_INVALID');
  if (!/^[A-Za-z0-9_-]{43}$/.test(c.credential || '')) fail('PC_CONNECTOR_CREDENTIAL_INVALID');
  if (!isAbsolute(c.workersDir || '') || resolve(c.workersDir) !== workersDir) fail('PC_CONNECTOR_WORKERS_MISMATCH');
  const selection = { version: 1, connectorConfig: configFile, runtimeState: stateDir ? resolve(stateDir) : pathFrom(root, c.stateDir), hub: c.hub };
  writeJson(selectorFile(workersDir), selection);
  return { selected: true, hub: c.hub, selectionFile: selectorFile(workersDir), note: 'Only PC selection changed; no services restarted, credentials copied, or device grants changed.' };
}

export function pcConnectorStatus(workersDir) {
  try {
    const c = loadPcConnector(workersDir); if (!c) return { configured: false };
    const d = readPcDirectory(workersDir);
    return { configured: true, hub: c.hub, source: c.source, directoryFresh: !!d, devices: (d?.state.devices || []).map(x => ({ id: x.id, name: x.name, online: !!x.online, local: x.id === d.connection.localDeviceId, workers: x.workers?.length || 0 })) };
  } catch (e) { return { configured: false, error: e.code || 'PC_CONNECTOR_CONFIG_INVALID' }; }
}

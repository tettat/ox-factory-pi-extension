import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPcConnector, readPcDirectory, selectPcConnector, pcConnectorStatus } from './pc-connector.mjs';
const run = promisify(execFile), cli = fileURLToPath(new URL('./pc-cli.mjs', import.meta.url));
const save = (p, value) => writeFileSync(p, JSON.stringify(value));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ox-pc-selector-')), workersDir = join(root, '.pi/workers'); mkdirSync(workersDir, { recursive: true });
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'ox-pc-selector-')); rmSync(root, { recursive: true, force: true }); });
  function add(name, hub, deviceId = 'device_' + name) {
    const dir = join(root, '.pi', name), stateDir = join(dir, 'connector'), configFile = join(dir, 'connector-config.json'); mkdirSync(stateDir, { recursive: true });
    const config = { hub, credential: name.includes('cloudflare') ? 'c'.repeat(43) : 'n'.repeat(43), deviceId, workersDir, stateDir, grants: { owner_fixture: { actor: 'fixture', role: 'owner' } } };
    save(configFile, config); const directory = { version: 1, localDeviceId: deviceId, hub, receivedAt: 10000, devices: [{ id: deviceId, name, online: true, workers: [{ id: 'same' }] }, { id: 'remote_' + name, name: 'another factory', online: true, workers: [{ id: 'same' }] }] };
    const directoryFile = join(stateDir, 'hub-directory.json'); save(directoryFile, directory);
    return { dir, stateDir, configFile, config, directoryFile, directory };
  }
  return { root, workersDir, add, selector: join(root, '.pi/mobile-pc.json') };
}
test('CF auto-discovery wins over old Netlify; explicit selection is shared and secret-free', t => {
  const f = fixture(t), old = f.add('mobile-netlify', 'https://old.example.com'), cf = f.add('mobile-cloudflare', 'https://new.example.com');
  const backup = readFileSync(old.configFile, 'utf8'); assert.equal(loadPcConnector(f.workersDir).hub, cf.config.hub);
  selectPcConnector({ workersDir: f.workersDir, configFile: old.configFile }); assert.equal(loadPcConnector(f.workersDir).hub, old.config.hub);
  selectPcConnector({ workersDir: f.workersDir, configFile: cf.configFile }); assert.equal(readPcDirectory(f.workersDir, { now: 20000 }).connection.url, cf.config.hub);
  assert.equal(readFileSync(old.configFile, 'utf8'), backup);
  for (const c of [cf.config.credential, old.config.credential]) { assert.ok(!readFileSync(f.selector, 'utf8').includes(c)); assert.ok(!JSON.stringify(pcConnectorStatus(f.workersDir)).includes(c)); }
});
test('directory origin, identity, freshness and clock are checked without falling back', t => {
  const f = fixture(t); f.add('mobile-netlify', 'https://old.example.com'); const cf = f.add('mobile-cloudflare', 'https://new.example.com');
  selectPcConnector({ workersDir: f.workersDir, configFile: cf.configFile });
  for (const patch of [{ hub: 'https://old.example.com' }, { localDeviceId: 'wrong_device' }, { receivedAt: 0 }, { receivedAt: 999999 }]) {
    save(cf.directoryFile, { ...cf.directory, ...patch }); assert.equal(readPcDirectory(f.workersDir, { now: 50000 }), null);
  }
  save(cf.directoryFile, cf.directory); assert.equal(readPcDirectory(f.workersDir, { now: 50000 }), null);
  assert.ok(readPcDirectory(f.workersDir, { now: 15000 }));
  writeFileSync(f.selector, '{broken'); assert.throws(() => loadPcConnector(f.workersDir)); assert.equal(readPcDirectory(f.workersDir), null);
});
test('selection supports custom runtime state and rejects wrong host workers / unsafe Hub', t => {
  const f = fixture(t), cf = f.add('custom', 'https://custom.example.com');
  const stateDir = join(f.root, '.pi/custom-runtime'); mkdirSync(stateDir); save(join(stateDir, 'hub-directory.json'), cf.directory);
  selectPcConnector({ workersDir: f.workersDir, configFile: cf.configFile, stateDir }); assert.equal(loadPcConnector(f.workersDir).stateDir, stateDir);
  assert.ok(readPcDirectory(f.workersDir, { now: 15000 }));
  for (const patch of [{ hub: 'http://unsafe.example.com' }, { hub: 'https://secret@unsafe.example.com' }, { workersDir: join(f.root, 'another/.pi/workers') }, { credential: 'weak' }]) {
    save(cf.configFile, { ...cf.config, ...patch }); assert.throws(() => selectPcConnector({ workersDir: f.workersDir, configFile: cf.configFile }));
  }
});
test('PC CLI selects existing Connector, gives sanitized status and never enrolls', async t => {
  const f = fixture(t), cf = f.add('custom', 'https://custom.example.com');
  const used = await run(process.execPath, [cli, 'use', '--workers', f.workersDir, '--config', cf.configFile]); assert.equal(JSON.parse(used.stdout).selected, true);
  const status = await run(process.execPath, [cli, 'status', '--workers', f.workersDir]); assert.equal(JSON.parse(status.stdout).configured, true);
  assert.ok(!used.stdout.includes(cf.config.credential)); assert.ok(!status.stdout.includes(cf.config.credential));
  await assert.rejects(run(process.execPath, [cli, 'use', '--workers', f.workersDir, '--token', cf.config.credential]));
});

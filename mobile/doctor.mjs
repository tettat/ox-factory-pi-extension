import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './store.mjs';
import { validateHubUrl } from './connector.mjs';
import { inspectProcessLock, inspectConnectorHealth } from './runtime-health.mjs';

export async function inspectMobileState(dir, { fetchImpl = fetch, now = Date.now, probe } = {}) {
  const hub = readJson(join(dir, 'hub-config.json'), null), connector = readJson(join(dir, 'connector-config.json'), null);
  const report = { checkedAt: new Date(now()).toISOString(), scope: 'configured-services-only',
    hubConfigured: !!hub, connectorConfigured: !!connector,
    factoryPresent: !!connector && existsSync(connector.workersDir),
    hubReachable: false, factoryReachable: false, pushConfigured: existsSync(join(dir, 'push-private.json')),
    hubRuntime: hub ? inspectProcessLock(join(dir, 'hub.lock'), { probe }) : null,
    connectorRuntime: null, ready: false, issues: [] };
  // Validate every target before issuing any request. No auth headers are sent.
  if (hub) validateHubUrl(hub.origin, hub.allowInsecureLoopback);
  if (connector) {
    validateHubUrl(connector.hub, connector.allowInsecureLoopback);
    const url = new URL(connector.factoryUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Factory must remain a loopback HTTP origin');
  }
  const origin = connector?.hub || hub?.origin;
  if (origin) {
    try {
      const r = await fetchImpl(origin + '/health', { redirect: 'error', signal: AbortSignal.timeout(5000) });
      report.hubReachable = r.ok && (await r.json()).service === 'ox-factory-mobile-hub';
    } catch {}
    if (!report.hubReachable) report.issues.push('HUB_UNREACHABLE');
  } else report.issues.push('NOT_CONFIGURED');
  if (hub && report.hubRuntime.state !== 'pid-present') report.issues.push('HUB_PROCESS_NOT_CONFIRMED');
  if (hub && connector && hub.origin !== connector.hub) report.issues.push('HUB_TARGET_MISMATCH');
  if (connector) {
    try {
      report.factoryReachable = (await fetchImpl(new URL('/api/health', connector.factoryUrl), { redirect: 'error', signal: AbortSignal.timeout(5000) })).ok;
    } catch {}
    const lock = inspectProcessLock(join(connector.stateDir, 'connector.lock'), { probe });
    report.connectorRuntime = { lock, health: inspectConnectorHealth(connector, lock, { now }) };
    if (!report.factoryPresent) report.issues.push('FACTORY_DIRECTORY_MISSING');
    if (!report.factoryReachable) report.issues.push('FACTORY_UNREACHABLE');
    if (!report.connectorRuntime.health.healthy) report.issues.push('CONNECTOR_NOT_CONFIRMED');
  }
  report.ready = report.issues.length === 0;
  return report;
}

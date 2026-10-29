import { validateAction, id, fields, Fault } from './mobile/protocol.mjs';
import { loadPcConnector, pcConnectorStatus } from './mobile/pc-connector.mjs';
export { pcConnectorStatus };
const PEER_ACTIONS = ['worker.detail', 'job.detail', 'talk.send', 'task.assign'];

export function isLocalPeerRequest(req, { mutation = false } = {}) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress) || req.headers['sec-fetch-site'] === 'cross-site') return false;
  try {
    const host = new URL('http://' + req.headers.host);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) return false;
    if (mutation && !req.headers.origin) return false;
    if (req.headers.origin && new URL(req.headers.origin).origin !== host.origin) return false;
    return true;
  } catch { return false; }
}

// Only an explicit host-local Connector chooses the Hub and device identity.
export async function peerRequest(workersDir, operation, body, fetchImpl = fetch) {
  if (!['directory', 'peer-command', 'peer-result'].includes(operation)) throw new Fault('UNKNOWN_ACTION');
  if (operation === 'peer-command') {
    fields(body, ['id', 'deviceId', 'action', 'body', 'createdAt']); id(body.id); id(body.deviceId);
    if (!PEER_ACTIONS.includes(body.action)) throw new Fault('UNKNOWN_ACTION');
    if (!Number.isFinite(body.createdAt)) throw new Fault('INVALID_REQUEST_TIME');
    body = { ...body, body: validateAction(body.action, body.body) };
  } else if (operation === 'peer-result') { fields(body, ['id']); id(body.id); body = { id: body.id }; }
  else { fields(body, []); body = {}; }
  const c = loadPcConnector(workersDir);
  if (!c) throw new Fault('PEER_CONNECTOR_NOT_CONFIGURED', 503);
  let response, result;
  try {
    response = await fetchImpl(c.hub + '/connector/' + operation, { method: 'POST', headers: { authorization: 'Bearer ' + c.credential, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
    result = await response.json();
  } catch { throw new Fault('PEER_HUB_UNAVAILABLE', 503); }
  if (!response.ok) throw new Fault(/^[A-Z_0-9]{1,100}$/.test(result.error || '') ? result.error : 'HUB_UNAVAILABLE', response.status);
  return result;
}

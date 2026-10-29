import { ACTIONS, Fault, roleAllows } from './protocol.mjs';

export const PEER_ACTIONS = ['worker.detail', 'job.detail', 'talk.send', 'task.assign'];
export const trustKey = (source, target) => `${source}:${target}`;
export function peerAccess(state, source, target, action) {
  const a = state.devices[source], b = state.devices[target];
  const trust = state.deviceTrusts?.[trustKey(source, target)];
  if (!a || !b || a.revokedAt || b.revokedAt || source === target ||
      a.ownerPrincipalId !== b.ownerPrincipalId || !trust || trust.revokedAt ||
      !PEER_ACTIONS.includes(action) || !trust.actions.includes(action) ||
      !roleAllows(b.snapshot?.grants?.[a.ownerPrincipalId], ACTIONS[action]?.role)) {
    throw new Fault('DEVICE_TRUST_DENIED', 403);
  }
  return { source: a, target: b, trust };
}

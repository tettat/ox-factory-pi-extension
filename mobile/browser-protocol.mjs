// Shared by the browser, local agent and both relay implementations.
export const BROWSER_PROTOCOL = 'ox-browser-v1';
export const MAX_WIRE = 600000;
const ident = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const number = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
export function webPage(value) {
  try { const u = new URL(value); return !u.username && !u.password && (['http:', 'https:'].includes(u.protocol) || value === 'about:blank'); } catch { return false; }
}
export function requestMessage(m) {
  if (!m || Object.getPrototypeOf(m) !== Object.prototype || m.type !== 'request' || !ident(m.id)) throw Error('INVALID_BROWSER_REQUEST');
  const allowed = ['type', 'id', 'action', 'instance', 'target', 'view', 'frame', 'x', 'y', 'dx', 'dy', 'text', 'key', 'url', 'quality'];
  if (Object.keys(m).some(k => !allowed.includes(k))) throw Error('INVALID_BROWSER_REQUEST');
  if (!['list', 'watch', 'frame', 'click', 'scroll', 'text', 'key', 'navigate', 'back', 'forward', 'reload', 'activate'].includes(m.action)) throw Error('INVALID_BROWSER_ACTION');
  if (m.action !== 'list' && (!ident(m.instance) || !ident(m.target) || !ident(m.view))) throw Error('INVALID_BROWSER_TARGET');
  if (['click', 'scroll', 'text', 'key', 'back', 'forward', 'reload', 'navigate', 'activate'].includes(m.action) && !ident(m.frame)) throw Error('STALE_BROWSER_FRAME');
  if (['click', 'scroll'].includes(m.action) && (!number(m.x, 0, 20000) || !number(m.y, 0, 20000))) throw Error('INVALID_BROWSER_POINT');
  if (m.action === 'scroll' && (!number(m.dx, -2000, 2000) || !number(m.dy, -2000, 2000))) throw Error('INVALID_BROWSER_SCROLL');
  if (m.action === 'text' && (typeof m.text !== 'string' || !m.text || m.text.length > 4000 || /\u0000/.test(m.text))) throw Error('INVALID_BROWSER_TEXT');
  if (m.action === 'key' && !['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'SelectAll'].includes(m.key)) throw Error('INVALID_BROWSER_KEY');
  if (m.action === 'navigate' && (typeof m.url !== 'string' || m.url.length > 4096 || !webPage(m.url))) throw Error('INVALID_BROWSER_URL');
  if (m.quality !== undefined && !['saving', 'normal', 'clear'].includes(m.quality)) throw Error('INVALID_BROWSER_QUALITY');
  return m;
}
export const isInput = m => !['list', 'watch', 'frame'].includes(m.action);
export function ticketFromProtocols(value = '') {
  const parts = value.split(',').map(s => s.trim());
  if (parts.length !== 2 || parts[0] !== BROWSER_PROTOCOL || !/^t\.[A-Za-z0-9_-]{43}$/.test(parts[1])) throw Error('BROWSER_AUTH_FAILED');
  return parts[1].slice(2);
}

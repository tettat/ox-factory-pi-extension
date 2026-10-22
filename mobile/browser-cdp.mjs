import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { requestMessage, isInput, webPage } from './browser-protocol.mjs';
export function localEndpoint(value) {
  const u = new URL(value);
  if (u.origin !== value || u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password || !u.port || Number(u.port) < 1024) throw Error('CDP_LOOPBACK_REQUIRED');
  return u.origin;
}
async function jsonLimited(url) {
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw Error('CHROME_OFFLINE');
  let text = ''; for await (const part of r.body) { text += new TextDecoder().decode(part); if (text.length > 2000000) throw Error('CDP_RESPONSE_LIMIT'); }
  return JSON.parse(text);
}
class CDP {
  constructor(socket) {
    this.socket = socket; this.seq = 0; this.pending = new Map(); this.listeners = new Set();
    socket.on('message', bytes => {
      let m; try { m = JSON.parse(bytes); } catch { return; }
      const p = this.pending.get(m.id);
      if (p) { clearTimeout(p.timer); this.pending.delete(m.id); m.error ? p.reject(Error('CHROME_OPERATION_FAILED')) : p.resolve(m.result || {}); }
      else for (const listener of this.listeners) listener(m);
    });
    socket.on('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('CHROME_DISCONNECTED')); } this.pending.clear(); });
    socket.on('error', () => {});
  }
  call(method, params = {}, sessionId) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(Error('CHROME_DISCONNECTED'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq, timer = setTimeout(() => { this.pending.delete(id); reject(Error('CHROME_TIMEOUT')); }, 6000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { this.socket.close(); }
}
export async function connectChrome(endpoint, expectedBrowserId) {
  localEndpoint(endpoint);
  const v = await jsonLimited(endpoint + '/json/version'), u = new URL(v.webSocketDebuggerUrl);
  if (u.protocol !== 'ws:' || u.hostname !== '127.0.0.1' || u.port !== new URL(endpoint).port || u.username || u.password || u.search || !/^\/devtools\/browser\/[a-zA-Z0-9_-]+$/.test(u.pathname)) throw Error('CDP_ENDPOINT_REJECTED');
  const browserId = u.pathname.split('/').at(-1);
  if (expectedBrowserId && expectedBrowserId !== browserId) throw Error('BROWSER_INSTANCE_CHANGED');
  const socket = new WebSocket(u, { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 4000 });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', () => reject(Error('CHROME_OFFLINE'))); });
  const cdp = new CDP(socket); cdp.browserId = browserId; return cdp;
}
const keys = { Enter: ['Enter', 13], Tab: ['Tab', 9], Backspace: ['Backspace', 8], Escape: ['Escape', 27], ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], SelectAll: ['a', 65] };
export function createBrowserDriver({ instances, grant, now = Date.now }) {
  const connections = new Map(), watches = new Map();
  async function chrome(instance) {
    const item = (await instances()).find(i => i.id === instance); if (!item) throw Error('CHROME_NOT_REGISTERED');
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(item.browserId || '')) throw Error('CHROME_NOT_REGISTERED');
    localEndpoint(item.endpoint);
    let c = connections.get(instance);
    if (c && (c.endpoint !== item.endpoint || c.cdp.browserId !== item.browserId || c.cdp.socket.readyState !== 1)) { c.cdp.close(); connections.delete(instance); c = null; }
    if (!c) { c = { cdp: await connectChrome(item.endpoint, item.browserId), endpoint: item.endpoint }; connections.set(instance, c); }
    return c.cdp;
  }
  function localRole(principal, role) {
    const local = grant(principal);
    if (!['view', 'control'].includes(local)) throw Error('BROWSER_LOCAL_GRANT_DENIED');
    return local === 'control' && role !== 'viewer' ? 'control' : 'view';
  }
  async function release(peer) {
    const w = watches.get(peer); watches.delete(peer);
    if (w) { clearTimeout(w.idle); w.cdp.listeners.delete(w.listener); try { if (w.casting) await w.cdp.call('Page.stopScreencast', {}, w.session); await w.cdp.call('Target.detachFromTarget', { sessionId: w.session }); } catch {} }
  }
  async function execute(peer, principal, role, request) {
    const r = requestMessage(request), access = localRole(principal, role);
    if (isInput(r) && access !== 'control') throw Error('BROWSER_READ_ONLY');
    if (r.action === 'list') {
      const result = [];
      for (const item of (await instances()).slice(0, 20)) {
        try {
          const c = await chrome(item.id), targets = (await c.call('Target.getTargets')).targetInfos.filter(t => t.type === 'page').slice(0, 100), tabs = [];
          for (const target of targets) {
            let windowId = 0; try { windowId = (await c.call('Browser.getWindowForTarget', { targetId: target.targetId })).windowId; } catch {}
            tabs.push({ id: target.targetId, title: String(target.title || '未命名标签页').slice(0, 200), url: String(target.url || '').slice(0, 2000), windowId, controllable: webPage(target.url) });
          }
          result.push({ id: item.id, name: item.name, online: true, tabs });
        } catch { result.push({ id: item.id, name: item.name, online: false, tabs: [] }); }
      }
      return { instances: result, access };
    }
    if (r.action === 'watch') {
      await release(peer);
      const cdp = await chrome(r.instance), targets = (await cdp.call('Target.getTargets')).targetInfos;
      if (!targets.some(t => t.targetId === r.target && t.type === 'page' && webPage(t.url))) throw Error('BROWSER_PAGE_UNSUPPORTED');
      const { sessionId: session } = await cdp.call('Target.attachToTarget', { targetId: r.target, flatten: true });
      const w = { instance: r.instance, target: r.target, view: r.view, cdp, session, frames: [], lastCapture: 0 };
      w.listener = e => {
        if (e.sessionId !== session) return;
        if (['Page.frameStartedLoading', 'Page.frameNavigated', 'Page.navigatedWithinDocument', 'Page.frameResized'].includes(e.method)) w.frames = [];
        // A tiny, local-only screencast keeps background tabs rendering without
        // activating the desktop tab. Its images are discarded, never relayed.
        if (e.method === 'Page.screencastFrame') void cdp.call('Page.screencastFrameAck', { sessionId: e.params.sessionId }, session).catch(() => {});
      };
      cdp.listeners.add(w.listener); watches.set(peer, w); await cdp.call('Page.enable', {}, session);
      return { watching: true, access };
    }
    const w = watches.get(peer);
    if (!w || w.instance !== r.instance || w.target !== r.target || w.view !== r.view) throw Error('BROWSER_VIEW_CHANGED');
    const call = (method, params) => w.cdp.call(method, params, w.session);
    const tree = await call('Page.getFrameTree');
    if (!webPage(tree.frameTree.frame.url)) { w.frames = []; throw Error('BROWSER_PAGE_UNSUPPORTED'); }
    if (r.action === 'frame') {
      if (now() - w.lastCapture < 200) throw Error('BROWSER_SLOW_DOWN');
      w.lastCapture = now();
      clearTimeout(w.idle);
      try {
      if (!w.casting) { await call('Page.startScreencast', { format: 'jpeg', quality: 10, maxWidth: 320, maxHeight: 240, everyNthFrame: 30 }); w.casting = true; }
      const { cssVisualViewport: v } = await call('Page.getLayoutMetrics');
      if (!v || v.clientWidth < 1 || v.clientHeight < 1 || v.clientWidth > 20000 || v.clientHeight > 20000) throw Error('BROWSER_VIEWPORT_UNAVAILABLE');
      const options = { saving: [960, 45], normal: [1440, 60], clear: [1920, 75] }[r.quality || 'normal'];
      const scale = Math.min(1, options[0] / Math.max(v.clientWidth, v.clientHeight));
      const { data } = await call('Page.captureScreenshot', { format: 'jpeg', quality: options[1], fromSurface: true, captureBeyondViewport: false,
        clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale } });
      const after = (await call('Page.getLayoutMetrics')).cssVisualViewport;
      if (after.clientWidth !== v.clientWidth || after.clientHeight !== v.clientHeight || after.pageX !== v.pageX || after.pageY !== v.pageY || after.scale !== v.scale) throw Error('STALE_BROWSER_FRAME');
      if (data.length > 520000) throw Error('BROWSER_FRAME_TOO_LARGE');
      const frame = { id: randomUUID(), at: now(), width: v.clientWidth, height: v.clientHeight, scale: v.scale, pageX: v.pageX, pageY: v.pageY, url: tree.frameTree.frame.url };
      w.frames.push(frame); w.frames = w.frames.slice(-4);
      return { frame: frame.id, view: w.view, at: frame.at, width: frame.width, height: frame.height, jpeg: data, url: frame.url.slice(0, 4096), access };
      } finally {
        w.idle = setTimeout(() => { w.casting = false; void call('Page.stopScreencast').catch(() => {}); }, 5000); w.idle.unref?.();
      }
    }
    const f = w.frames.find(f => f.id === r.frame);
    if (!f || now() - f.at > 6000 || tree.frameTree.frame.url !== f.url) throw Error('STALE_BROWSER_FRAME');
    const metrics = (await call('Page.getLayoutMetrics')).cssVisualViewport;
    if (metrics.clientWidth !== f.width || metrics.clientHeight !== f.height || metrics.scale !== f.scale || metrics.pageX !== f.pageX || metrics.pageY !== f.pageY) throw Error('STALE_BROWSER_FRAME');
    if (['click', 'scroll'].includes(r.action) && (r.x >= f.width || r.y >= f.height)) throw Error('INVALID_BROWSER_POINT');
    const point = { x: r.x, y: r.y };
    if (r.action === 'click') {
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    } else if (r.action === 'scroll') await call('Input.dispatchMouseEvent', { type: 'mouseWheel', deltaX: r.dx, deltaY: r.dy, ...point });
    else if (r.action === 'text') await call('Input.insertText', { text: r.text });
    else if (r.action === 'key') {
      const [key, code] = keys[r.key], modifiers = r.key === 'SelectAll' ? (process.platform === 'darwin' ? 4 : 2) : 0;
      await call('Input.dispatchKeyEvent', { type: r.key === 'Enter' ? 'keyDown' : 'rawKeyDown', key, windowsVirtualKeyCode: code, modifiers, ...(r.key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code, modifiers });
    } else if (r.action === 'navigate') await call('Page.navigate', { url: r.url });
    else if (r.action === 'reload') await call('Page.reload');
    else if (r.action === 'activate') await w.cdp.call('Target.activateTarget', { targetId: w.target });
    else if (['back', 'forward'].includes(r.action)) {
      const h = await call('Page.getNavigationHistory'), target = h.entries[h.currentIndex + (r.action === 'back' ? -1 : 1)];
      if (target && webPage(target.url)) await call('Page.navigateToHistoryEntry', { entryId: target.id });
    }
    // Never replay an accepted input; the next interaction needs a fresh frame.
    w.frames = []; return { accepted: true, frame: r.frame };
  }
  return { execute, release, close: async () => { for (const peer of watches.keys()) await release(peer); for (const c of connections.values()) c.cdp.close(); connections.clear(); } };
}

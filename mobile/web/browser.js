import { esc } from './ui.js';
import { fitView, clampView, zoomView, remotePoint } from './browser-geometry.js';
export function browserUrl(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 4096 || /[\s\\\u0000-\u001f]/.test(text)) return null;
  let address = text;
  if (!/^https?:\/\//i.test(address) && address !== 'about:blank') {
    if (/^[a-z][a-z0-9+.-]*:/i.test(address) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(address)) return null;
    address = 'https://' + address.replace(/^\/\//, '');
  }
  try { const url = new URL(address); return !url.username && !url.password && (['http:', 'https:'].includes(url.protocol) || address === 'about:blank') ? url.href : null; } catch { return null; }
}
const labels = {
  BROWSER_RELAY_UNAVAILABLE: '此站点还未配置浏览器中继', BROWSER_AGENT_OFFLINE: '电脑的浏览器连接程序未在线', BROWSER_LOCAL_GRANT_DENIED: '这台电脑尚未授权当前账号查看 Chrome',
  BROWSER_READ_ONLY: '当前连接只能查看', BROWSER_PAGE_UNSUPPORTED: '此标签页不能共享，请选择普通网页', CHROME_OFFLINE: '这个 Chrome 已关闭或未开启调试', CHROME_DISCONNECTED: 'Chrome 连接已断开',
  STALE_BROWSER_FRAME: '画面位置已变化，已取消这次操作，正在刷新', BROWSER_VIEW_CHANGED: '标签页已切换，请重新选择', BROWSER_FRAME_TOO_LARGE: '画面较大，请改用省流画质', BROWSER_BUSY: '已有操作在处理，请稍候', BROWSER_SLOW_DOWN: '操作较快，稍后再试',
  CHROME_TIMEOUT: 'Chrome 暂未返回画面，正在重试', BROWSER_INSTANCE_CHANGED: 'Chrome 已重新启动，请在电脑重新登记', BROWSER_OPERATION_FAILED: '本次操作未确认，请查看新画面后再决定是否重试',
  BROWSER_NAVIGATION_FAILED: '网页未能打开，请检查网址或电脑网络后重试', BROWSER_TAB_LIMIT: '这个浏览器的标签页太多，请先在电脑关闭一些', INVALID_BROWSER_URL: '请输入有效的网页地址',
  INVALID_BROWSER_ACTION: '这台电脑的浏览器组件需要更新；可先取消“在新标签页打开”，在当前页打开网址',
};
export function mountBrowser({ host, api, device, back, toast }) {
  const root = document.createElement('section'); root.className = 'browser-root'; host.replaceChildren(root);
  root.innerHTML = `<div class="browser-list"><div class="section-head"><div><h2>电脑 Chrome</h2><p class="muted">${esc(device.name)} · 仅共享已登记的调试实例</p></div><button data-b="refresh">刷新</button></div><p class="browser-state" role="status">正在连接…</p><div class="browser-catalog"></div><div class="browser-help"><b>让员工打开可接管的 Chrome</b><p>在工厂目录执行下面的命令。它会使用独立、可保留登录的浏览器资料，不影响普通 Chrome。</p><code>node mobile/browser-cli.mjs launch --name "工作浏览器" --url https://example.com</code><p>首次使用需在电脑启用浏览器连接程序；普通 Chrome、系统窗口和文件选择框不在共享范围内。</p></div></div>
    <section class="browser-stage" hidden aria-label="电脑网页画面"><header class="browser-top"><button data-b="tabs" aria-label="返回标签页列表">‹</button><button class="browser-heading" data-b="address" aria-label="打开网址"><strong></strong><small></small></button><button data-b="mode" aria-pressed="false">开始操作</button><button data-b="more" aria-label="更多浏览器选项">•••</button></header>
    <div class="browser-address" hidden><form data-address novalidate><label for="remote-browser-address">在电脑浏览器打开网址</label><div><input id="remote-browser-address" type="text" inputmode="url" enterkeyhint="go" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="4096" placeholder="example.com 或完整网址"><button class="primary" data-command type="submit">打开</button></div><label class="browser-new-tab"><input type="checkbox" data-new-tab>在新标签页打开</label><p data-address-error role="status" hidden></p></form></div>
    <button class="browser-mode-hint" data-b="mode">当前仅查看 · 点此开始操作网页</button>
    <div class="browser-surface" tabindex="0" aria-label="网页画面，查看模式拖动平移，双指缩放"><canvas></canvas><div class="browser-overlay" role="status">正在读取画面…</div></div>
    <div class="browser-telemetry"><span>尚无画面</span><button data-b="reconnect" hidden>重新连接</button></div>
    <div class="browser-options" hidden><label>画质<select data-quality><option value="saving">省流</option><option value="normal" selected>均衡</option><option value="clear">清晰</option></select></label><button data-b="zoom" aria-label="放大画面">放大画面</button><button data-b="activate" data-input data-command>在电脑上激活</button><p>查看：拖动画面。操作：轻点点击、滑动滚动网页。双指始终只缩放和平移画面。打开网址、前进和后退无需先切操作模式。</p></div>
    <form class="browser-keyboard" hidden><label>输入到电脑当前光标处<textarea rows="2" maxlength="4000" placeholder="先在画面中点选输入框，再输入文字…" aria-label="输入到电脑的文字"></textarea></label><div><button type="button" data-key="SelectAll">全选</button><button type="button" data-key="Backspace">退格</button><button type="button" data-key="Tab">Tab</button><button type="button" data-key="Enter">回车</button><button class="primary" type="submit">输入文字</button></div></form>
    <footer class="browser-controls"><button data-b="back" data-input data-command aria-label="网页后退">←</button><button data-b="forward" data-input data-command aria-label="网页前进">→</button><button data-b="reload" data-input data-command aria-label="刷新电脑网页">↻</button><button data-b="address" data-input>网址</button><button data-b="fit">适配</button><button data-b="keyboard" data-input>键盘</button><button data-b="pause">暂停</button></footer></section>`;
  const $ = s => root.querySelector(s), stage = $('.browser-stage'), surface = $('.browser-surface'), canvas = $('canvas'), overlay = $('.browser-overlay');
  let destroyed = false, socket = null, attempt = 0, connected = false, agentOnline = false, busy = false, frameBusy = false, selected = null, frame = null, image = null;
  let mode = 'view', access = 'view', paused = false, quality = 'normal', view = { scale: 1, x: 0, y: 0 }, lastFrameAt = 0, lastRtt = 0, fail = '', lastFitSize = '', pending = new Map(), seq = 0;
  let timer, reconnectTimer, connecting = false, reconnectDelay = 1000, listBusy = false, instances = [], frameEpoch = 0, lastMessage = Date.now(), watchedView = null, currentAction = '';
  const request = (action, extra = {}) => new Promise((resolve, reject) => {
    if (!connected || !agentOnline || socket?.readyState !== 1) return reject(Error('BROWSER_AGENT_OFFLINE'));
    const id = String(++seq), message = { type: 'request', id, action, ...(action === 'list' ? {} : { instance: selected?.instance, target: selected?.target, view: selected?.view }), ...extra };
    const timeout = setTimeout(() => { pending.delete(id); reject(Error('连接响应较慢，操作状态未确认；不会自动重发')); }, 10000);
    pending.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify(message));
  });
  function rejectPending() { for (const p of pending.values()) { clearTimeout(p.timeout); p.reject(Error('连接已断开，未确认的操作不会重发')); } pending.clear(); }
  function setState(text) { $('.browser-state').textContent = text; }
  function commandReady() { return access === 'control' && connected && agentOnline && selected && watchedView === selected.view && !busy && !document.hidden; }
  function editable() { return mode === 'control' && access === 'control' && connected && agentOnline && !paused && !document.hidden && frame && Date.now() - lastFrameAt < 5000 && !busy && !fail; }
  function status() {
    if (destroyed) return;
    const stale = frame && Date.now() - lastFrameAt > 5000;
    const message = !connected ? '连接中断 · 保留最后画面' : !agentOnline ? '电脑浏览器未连接' : document.hidden ? '后台已暂停' : paused ? '画面已暂停' : fail || (stale ? '画面更新较慢，暂不可操作' : !frame ? '正在读取画面…' : '');
    overlay.hidden = !message; overlay.textContent = message;
    const age = frame ? Math.max(0, Math.floor((Date.now() - lastFrameAt) / 1000)) : 0;
    $('.browser-telemetry span').textContent = frame ? `${age < 1 ? '刚刚更新' : age + ' 秒前的画面'} · 往返 ${lastRtt} ms · ${Math.round(view.scale * 100)}%` : '尚无画面';
    $('[data-b="reconnect"]').hidden = connected;
    $('[data-b="mode"]').textContent = access !== 'control' ? '只读' : mode === 'control' ? '退出操作' : '开始操作';
    $('[data-b="mode"]').disabled = access !== 'control'; $('[data-b="mode"]').setAttribute('aria-pressed', String(mode === 'control'));
    stage.dataset.mode = mode; surface.setAttribute('aria-label', mode === 'control' ? '操作模式：轻点点击，单指滑动滚动网页，双指移动和缩放画面' : '查看模式：拖动平移画面，双指缩放，不操作电脑');
    root.querySelectorAll('[data-input]').forEach(n => { n.hidden = access !== 'control'; });
    root.querySelectorAll('[data-command]').forEach(n => { n.disabled = !commandReady(); });
    $('[data-address] button').textContent = busy && ['navigate', 'newTab'].includes(currentAction) ? '打开中…' : '打开';
    root.querySelectorAll('.browser-keyboard button').forEach(n => { n.disabled = !editable(); });
    $('.browser-mode-hint').hidden = access !== 'control' || mode === 'control';
    $('.browser-heading').disabled = access !== 'control';
    if (access !== 'control') { $('.browser-address').hidden = true; $('.browser-keyboard').hidden = true; }
    $('[data-b="keyboard"]').disabled = access !== 'control' || !connected;
    $('[data-b="pause"]').textContent = paused ? '继续' : '暂停';
  }
  function dimensions() { return { w: surface.clientWidth, h: surface.clientHeight, pw: frame?.width || 1, ph: frame?.height || 1 }; }
  function draw(reset = false) {
    if (!frame || !image || stage.hidden) return;
    const { w, h, pw, ph } = dimensions(); if (!w || !h) return;
    const key = `${w}:${h}:${pw}:${ph}`;
    if (reset || key !== lastFitSize) { view = fitView(w, h, pw, ph); lastFitSize = key; }
    view = clampView(view, w, h, pw, ph);
    const dpr = Math.min(devicePixelRatio || 1, 2); canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr); ctx.drawImage(image, view.x, view.y, pw * view.scale, ph * view.scale); status();
  }
  function schedule(ms = 350) { clearTimeout(timer); if (!destroyed && selected && !paused && !document.hidden && connected && agentOnline) timer = setTimeout(() => void nextFrame(), ms); }
  async function nextFrame() {
    if (destroyed || !selected || paused || document.hidden || busy || frameBusy || points.size || !connected || !agentOnline) { schedule(500); return; }
    frameBusy = true; const target = selected, epoch = frameEpoch, started = performance.now();
    try {
      const data = await request('frame', { quality });
      if (!destroyed && selected === target && epoch === frameEpoch && data.view === selected.view && data.openedTab) {
        choose(target.instance, data.openedTab.id, { tab: { ...data.openedTab, controllable: true }, keepMode: true });
        toast('已跟随链接切换到新标签页'); void refreshList(); return;
      }
      if (destroyed || selected !== target || data.view !== selected.view || !data.jpeg || !Number.isFinite(data.width) || data.width < 1 || data.width > 20000 || data.height < 1 || data.height > 20000 || data.jpeg.length > 520000) return;
      const next = new Image(); next.src = 'data:image/jpeg;base64,' + data.jpeg; await next.decode();
      if (destroyed || selected !== target || epoch !== frameEpoch || points.size || paused || document.hidden) return;
      frame = data; image = next; lastRtt = Math.round(performance.now() - started); lastFrameAt = Date.now() - lastRtt; fail = ''; access = data.access; draw();
      selected.url = data.url || selected.url; if (data.title) selected.title = data.title;
      $('.browser-heading small').textContent = selected.url; $('.browser-heading strong').textContent = selected.title || selected.url;
    } catch (e) { if (selected === target && epoch === frameEpoch) fail = labels[e.message] || e.message; if (e.message === 'BROWSER_FRAME_TOO_LARGE' && quality !== 'saving') { quality = 'saving'; $('[data-quality]').value = quality; } }
    finally { frameBusy = false; status(); schedule(fail ? 1500 : quality === 'saving' ? 1000 : 350); }
  }
  function catalog() {
    const online = instances.filter(i => i.online), tabs = online.reduce((n, i) => n + i.tabs.length, 0), windows = online.reduce((n, i) => n + new Set(i.tabs.map(t => t.windowId)).size, 0);
    setState(!connected ? '正在连接浏览器通道…' : !agentOnline ? '这台电脑尚未开启浏览器连接程序' : `${online.length} 个在线实例 · ${windows} 个窗口 · ${tabs} 个标签页`);
    $('.browser-catalog').innerHTML = instances.length ? instances.map(i => {
      const groups = [...new Set(i.tabs.map(t => t.windowId))];
      return `<article class="browser-instance"><div><h3>${esc(i.name)}</h3><span class="muted">${i.online ? `${groups.length} 个窗口 · ${i.tabs.length} 个标签页` : '已离线'}</span></div>${groups.map((w, index) => `<section><h4>窗口 ${index + 1}</h4>${i.tabs.filter(t => t.windowId === w).map(t => `<button class="browser-tab" data-instance="${esc(i.id)}" data-target="${esc(t.id)}" ${t.controllable ? '' : 'disabled'}><span><b>${esc(t.title || '未命名标签页')}</b><small>${esc(t.url || '空白页')}</small></span><span>${t.controllable ? '›' : '不支持'}</span></button>`).join('')}</section>`).join('')}</article>`;
    }).join('') : '<div class="empty"><h3>还没有可接管的 Chrome</h3><p>让员工使用下方命令打开一个，再点刷新。</p></div>';
  }
  async function refreshList() {
    if (listBusy || !connected || !agentOnline) { catalog(); return; } listBusy = true;
    try { const result = await request('list'); if (!destroyed) { instances = result.instances || []; access = result.access; catalog(); } }
    catch (e) { setState(labels[e.message] || e.message); }
    finally { listBusy = false; }
  }
  async function watch() {
    if (!selected) return;
    const target = selected;
    try { const result = await request('watch'); if (target !== selected) return; access = result.access; watchedView = target.view; fail = ''; status(); schedule(0); }
    catch (e) { fail = labels[e.message] || e.message; status(); }
  }
  function choose(instance, target, { tab, keepMode = false } = {}) {
    const i = instances.find(i => i.id === instance), t = tab || i?.tabs.find(t => t.id === target); if (!t?.controllable) return;
    frameEpoch++; points.clear(); gesture = null; selected = { instance, target, title: t.title, url: t.url, view: crypto.randomUUID() }; frame = image = null; lastFrameAt = 0; lastFitSize = ''; watchedView = null; fail = ''; if (!keepMode) mode = 'view'; paused = false;
    $('.browser-heading strong').textContent = t.title || i.name; $('.browser-heading small').textContent = t.url; stage.hidden = false; document.documentElement.classList.add('browser-open');
    $('.browser-keyboard').hidden = true; $('.browser-options').hidden = true; $('.browser-address').hidden = true; status(); void watch();
  }
  async function input(action, extra = {}) {
    const spatial = ['click', 'scroll', 'text', 'key'].includes(action);
    if (spatial ? !editable() : !commandReady()) { toast(spatial ? '请先点“开始操作”，并等待新画面' : '浏览器尚未就绪，请稍候'); return false; }
    const target = selected, sourceFrame = frame?.frame; frameEpoch++; busy = true; currentAction = action; clearTimeout(timer); if (!spatial) paused = false; status();
    try {
      // Older agents still require a frame even for navigation. Include it when
      // available without making newer agents wait for a screenshot again.
      const result = await request(action, { ...(sourceFrame ? { frame: sourceFrame } : {}), ...extra });
      if (!destroyed && selected === target && result.openedTab) { choose(target.instance, result.openedTab.id, { tab: { ...result.openedTab, controllable: true }, keepMode: true }); void refreshList(); }
      return true;
    }
    catch (e) { toast(labels[e.message] || e.message); return false; }
    finally { if (target === selected) { frame = null; lastFrameAt = 0; } busy = false; currentAction = ''; status(); schedule(0); }
  }
  async function connect() {
    if (destroyed || connecting) return;
    connecting = true; const generation = ++attempt; clearTimeout(reconnectTimer); frameEpoch++; rejectPending();
    const old = socket; socket = null; old?.close();
    connected = agentOnline = false; watchedView = null; mode = 'view'; status(); setState('正在连接浏览器通道…');
    try {
      const ticket = await api('/api/browser-ticket', { deviceId: device.id });
      if (destroyed || generation !== attempt) return;
      const url = new URL(ticket.relay); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.pathname = '/connect';
      socket = new WebSocket(url, ['ox-browser-v1', 't.' + ticket.ticket]);
      lastMessage = Date.now();
      const current = socket;
      current.onmessage = event => {
        if (destroyed || socket !== current) return;
        let m; try { m = JSON.parse(event.data); } catch { return; }
        lastMessage = Date.now();
        if (m.type === 'ready') { connecting = false; connected = true; agentOnline = m.agentOnline; reconnectDelay = 1000; status(); if (agentOnline) { void refreshList(); if (selected) { selected = { ...selected, view: crypto.randomUUID() }; void watch(); } } else catalog(); }
        if (m.type === 'agent') { const before = agentOnline; agentOnline = m.online; if (!agentOnline) { rejectPending(); fail = '电脑连接已断开'; } else if (!before) { fail = ''; void refreshList(); if (selected) { selected = { ...selected, view: crypto.randomUUID() }; void watch(); } } status(); }
        if (m.type === 'reply') { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timeout); m.ok ? p.resolve(m.data) : p.reject(Error(m.error)); }
      };
      current.onclose = event => {
        if (destroyed || socket !== current) return;
        connecting = connected = agentOnline = false; frameEpoch++; mode = 'view'; rejectPending(); status();
        if (event.code === 4409) { setState('另一台手机正在查看这台电脑，请先退出那边的浏览器页面'); return; }
        setState('连接断开，正在重连；不会重发操作'); reconnectTimer = setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(reconnectDelay * 2, 15000);
      };
      current.onerror = () => { setState('浏览器中继连接失败，正在重试'); };
    } catch (e) { connecting = false; setState(labels[e.code || e.message] || e.message); reconnectTimer = setTimeout(connect, 10000); }
  }
  root.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (b.dataset.target) return choose(b.dataset.instance, b.dataset.target);
    if (b.dataset.key) return void input('key', { key: b.dataset.key });
    const action = b.dataset.b;
    if (action === 'tabs') { frameEpoch++; selected = frame = image = null; canvas.width = canvas.height = 0; clearTimeout(timer); stage.hidden = true; document.documentElement.classList.remove('browser-open'); void refreshList(); }
    else if (action === 'mode') { mode = mode === 'view' ? 'control' : 'view'; status(); if (mode === 'control') toast('操作模式：轻点点击，滑动滚动网页；双指只移动画面'); }
    else if (action === 'refresh') connected ? void refreshList() : void connect();
    else if (action === 'reconnect') { if (!connecting) void connect(); }
    else if (action === 'more') $('.browser-options').hidden = !$('.browser-options').hidden;
    else if (action === 'address') {
      $('.browser-address').hidden = !$('.browser-address').hidden;
      if (!$('.browser-address').hidden) { $('.browser-options').hidden = $('.browser-keyboard').hidden = true; const node = $('[data-address] input'); node.value = frame?.url || selected?.url || ''; $('[data-address-error]').hidden = true; node.focus(); node.select(); }
    }
    else if (action === 'keyboard') { $('.browser-keyboard').hidden = !$('.browser-keyboard').hidden; if (!$('.browser-keyboard').hidden) { mode = 'control'; $('.browser-address').hidden = true; status(); $('.browser-keyboard textarea').focus(); } }
    else if (action === 'pause') { paused = !paused; if (paused) clearTimeout(timer); else schedule(0); status(); }
    else if (action === 'fit') { draw(true); }
    else if (action === 'zoom' && frame) { const { w, h, pw, ph } = dimensions(); view = zoomView(view, 1.3, w / 2, h / 2, w, h, pw, ph); draw(); }
    else if (['back', 'forward', 'reload', 'activate'].includes(action)) void input(action);
  });
  $('[data-quality]').onchange = e => { quality = e.target.value; schedule(0); };
  let composing = false;
  $('.browser-keyboard textarea').oncompositionstart = () => { composing = true; };
  $('.browser-keyboard textarea').oncompositionend = () => { composing = false; };
  $('.browser-keyboard').onsubmit = async e => { e.preventDefault(); if (composing || !editable()) return; const node = $('.browser-keyboard textarea'), value = node.value; if (!value) return; const confirmed = await input('text', { text: value }); if (confirmed && node.value === value) node.value = ''; /* Preserve the draft when delivery is uncertain. */ };
  $('[data-address]').onsubmit = async e => {
    e.preventDefault(); const node = $('[data-address] input'), url = browserUrl(node.value), error = $('[data-address-error]');
    error.hidden = !!url; error.textContent = url ? '' : '请输入有效网址，例如 example.com；仅支持网页地址'; if (!url) { node.focus(); return; }
    const original = selected, value = node.value, confirmed = await input($('[data-new-tab]').checked ? 'newTab' : 'navigate', { url });
    if (confirmed && !destroyed && (selected !== original || node.value === value)) { node.blur(); $('.browser-address').hidden = true; }
  };
  const points = new Map(); let gesture;
  const coords = e => { const r = surface.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const pinch = () => { const [a,b] = [...points.values()]; return { x: (a.x + b.x)/2, y: (a.y+b.y)/2, distance: Math.hypot(a.x-b.x,a.y-b.y) || 1 }; };
  surface.onpointerdown = e => {
    if (!frame || !overlay.hidden) return; e.preventDefault(); surface.setPointerCapture(e.pointerId); const p = coords(e); points.set(e.pointerId, p);
    if (points.size === 1) gesture = { start: p, view: { ...view }, multi: false, frame: frame.frame };
    if (points.size === 2) gesture = { ...gesture, multi: true, pinch: pinch(), view: { ...view } };
  };
  surface.onpointermove = e => {
    if (!points.has(e.pointerId) || !gesture || !frame) return; e.preventDefault(); const p = coords(e); points.set(e.pointerId, p);
    const { w,h,pw,ph } = dimensions();
    if (points.size >= 2) { const q = pinch(), g = gesture.pinch; if (!g) return; const z = zoomView(gesture.view, q.distance / g.distance, g.x, g.y, w,h,pw,ph); view = clampView({ ...z, x: z.x+q.x-g.x, y:z.y+q.y-g.y },w,h,pw,ph); draw(); }
    else if (!gesture.multi && mode === 'view') { view = clampView({ ...gesture.view, x: gesture.view.x+p.x-gesture.start.x, y: gesture.view.y+p.y-gesture.start.y },w,h,pw,ph); draw(); }
  };
  function finish(e, cancelled) {
    if (!points.has(e.pointerId)) return; const p=coords(e), g=gesture; points.delete(e.pointerId);
    if (!cancelled && g && !g.multi && mode === 'control' && editable() && frame.frame === g.frame) {
      const point=remotePoint(view,g.start.x,g.start.y,frame.width,frame.height);
      if (point) { const dx=(g.start.x-p.x)/view.scale, dy=(g.start.y-p.y)/view.scale;
        if (Math.hypot(p.x-g.start.x,p.y-g.start.y)<8) void input('click',point);
        else void input('scroll',{...point,dx:Math.max(-2000,Math.min(2000,dx)),dy:Math.max(-2000,Math.min(2000,dy))}); }
    }
    if (!points.size) gesture=null;
    if (!cancelled && g && !g.multi && mode === 'view' && Math.hypot(p.x-g.start.x,p.y-g.start.y)<8 && access === 'control') toast('当前仅查看，点右上角“开始操作”后即可点击网页');
  }
  surface.onpointerup = e => finish(e,false); surface.onpointercancel = e => finish(e,true);
  surface.addEventListener('wheel', e => { if (!frame) return; e.preventDefault(); const p=coords(e), {w,h,pw,ph}=dimensions();
    if (e.ctrlKey) view=zoomView(view,Math.exp(-e.deltaY/500),p.x,p.y,w,h,pw,ph);
    else if(mode==='view') view=clampView({...view,x:view.x-e.deltaX,y:view.y-e.deltaY},w,h,pw,ph);
    else {const point=remotePoint(view,p.x,p.y,pw,ph);if(point&&editable())void input('scroll',{...point,dx:Math.max(-2000,Math.min(2000,e.deltaX)),dy:Math.max(-2000,Math.min(2000,e.deltaY))});} draw();
  },{passive:false});
  const resize = new ResizeObserver(() => draw()); resize.observe(surface);
  const visibility = () => { points.clear(); gesture=null; frameEpoch++; if(document.hidden){clearTimeout(timer);mode='view';}else schedule(0);status();};
  document.addEventListener('visibilitychange',visibility);
  const ticker=setInterval(()=>{
    status();
    if (socket && Date.now()-lastMessage>20000 && !document.hidden) {
      const old=socket; socket=null; old.close(); connecting=connected=agentOnline=false; mode='view'; rejectPending(); void connect(); return;
    }
    if(socket?.readyState===1)socket.send('{"type":"ping"}');
  },1000);
  void connect();
  return { destroy() { destroyed=true; attempt++; clearTimeout(timer);clearTimeout(reconnectTimer);clearInterval(ticker);resize.disconnect();document.removeEventListener('visibilitychange',visibility);socket?.close();rejectPending();image=frame=null;canvas.width=canvas.height=0;root.remove();document.documentElement.classList.remove('browser-open'); } };
}

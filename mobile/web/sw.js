const CACHE = 'ox-mobile-shell-v10';
const SHELL = ['/', '/app.js', '/ui.js', '/style.css', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('ox-mobile-shell-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Never cache authenticated API, image uploads, commands, or responses.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname) || url.search) return;
  event.respondWith(fetch(event.request).then(response => { if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); } return response; }).catch(() => caches.match(event.request)));
});
self.addEventListener('notificationclick', event => { event.notification.close(); event.waitUntil(self.clients.matchAll({ type: 'window' }).then(windows => windows[0] ? windows[0].focus() : self.clients.openWindow('/'))); });
self.addEventListener('push', event => {
  // Payloads contain no task text, names, arbitrary URLs, or credentials.
  let payload = {}; try { payload = event.data?.json() || {}; } catch {}
  event.waitUntil(self.registration.showNotification(payload.title === '工厂任务未成功' ? payload.title : '工厂有新结果', {
    body: '打开随身工作台查看最新状态和结果。', icon: '/icon.svg', badge: '/icon.svg',
    tag: /^ox-[a-f0-9]{29}$/.test(payload.tag) ? payload.tag : 'ox-factory-result',
  }));
});

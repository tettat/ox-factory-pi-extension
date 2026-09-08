/* Optional visual layer. It never fetches factory data or starts a job. */
(() => {
  const KEY = 'ox-factory-skin';
  const choices = ['running', 'grazing', 'cow-truck'];
  const root = document.documentElement;
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  const mounts = new Set();
  let skin = 'classic';
  try { if (localStorage.getItem(KEY) === 'handdrawn') skin = 'handdrawn'; } catch {}
  root.dataset.skin = skin;

  function removeVisual(record) {
    if (record.timer != null) clearTimeout(record.timer);
    record.timer = null;
    record.visual?.remove();
    record.visual = null;
    record.image = null;
    record.host.classList.remove('factory-loading-host');
  }
  function updateImage(record) {
    if (!record.image) return;
    const still = document.hidden || media.matches;
    const src = `skins/handdrawn/${record.variant}${still ? '-still' : ''}.svg`;
    if (record.src !== src) { record.image.src = src; record.src = src; }
  }
  function attach(record) {
    if (skin !== 'handdrawn' || !record.host.isConnected || record.visual) return;
    const visual = document.createElement('span');
    visual.className = 'factory-loading-mascot';
    visual.setAttribute('aria-hidden', 'true');
    const image = document.createElement('img');
    image.alt = '';
    image.width = 120;
    image.height = 76;
    image.decoding = 'async';
    image.addEventListener('error', () => {
      // Restore the ordinary placeholder on asset errors rather than blocking UX.
      removeVisual(record);
    });
    visual.appendChild(image);
    record.host.appendChild(visual);
    record.host.classList.add('factory-loading-host');
    record.visual = visual;
    record.image = image;
    record.src = null;
    updateImage(record);
  }
  function schedule(record) {
    if (skin !== 'handdrawn' || record.visual || record.timer != null) return;
    record.timer = setTimeout(() => { record.timer = null; attach(record); }, 180);
  }
  function prune() {
    for (const record of mounts) {
      if (!record.host.isConnected) { removeVisual(record); mounts.delete(record); }
    }
  }
  function setSkin(value) {
    skin = value === 'handdrawn' ? 'handdrawn' : 'classic';
    root.dataset.skin = skin;
    try { localStorage.setItem(KEY, skin); } catch {}
    const select = document.querySelector('#skinSwitch');
    if (select) select.value = skin;
    prune();
    for (const record of mounts) {
      if (skin === 'classic') removeVisual(record);
      else schedule(record);
    }
  }
  function decorateLoading(host) {
    if (!host) return host;
    if ([...mounts].some(r => r.host === host)) return host;
    const variant = choices[Math.floor(Math.random() * choices.length)];
    const record = { host, variant, timer: null, visual: null, image: null, src: null };
    mounts.add(record);
    schedule(record);
    return host;
  }
  function updateMotion() { prune(); for (const record of mounts) updateImage(record); }
  window.FactorySkin = { setSkin, decorateLoading };
  document.addEventListener('visibilitychange', updateMotion);
  media.addEventListener('change', updateMotion);
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.querySelector('#skinSwitch');
    if (select) { select.value = skin; select.addEventListener('change', () => setSkin(select.value)); }
    new MutationObserver(prune).observe(document.body, { childList: true, subtree: true });
  });
})();

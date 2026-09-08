const skin = document.querySelector('#skin');
const motion = document.querySelector('#motion');
const mascots = document.querySelector('#mascots');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let paused = false;
try { skin.value = localStorage.getItem('ox-design-preview-skin') === 'handdrawn' ? 'handdrawn' : 'classic'; } catch {}
function applySkin() {
  document.documentElement.dataset.skin = skin.value;
  try { localStorage.setItem('ox-design-preview-skin', skin.value); } catch {}
}
function applyMotion() {
  const still = paused || reduced.matches;
  mascots.src = still ? 'resting-mascots.svg' : 'running-mascots.svg';
  motion.textContent = reduced.matches ? '系统已减少动态效果' : paused ? '播放动画' : '暂停动画';
  motion.disabled = reduced.matches;
  motion.setAttribute('aria-pressed', String(still));
}
skin.addEventListener('change', applySkin);
motion.addEventListener('click', () => { paused = !paused; applyMotion(); });
reduced.addEventListener('change', applyMotion);
applySkin(); applyMotion();

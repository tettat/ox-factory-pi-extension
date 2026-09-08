const skin = document.querySelector('#skin');
const motion = document.querySelector('#motion');
const mascots = document.querySelector('#mascots');
const action = document.querySelector('#action');
const actionNote = document.querySelector('#actionNote');
const descriptions = { running: '轻快跑步 · 慢步频', sprinting: '加速快跑 · 前倾、快步频与扬尘', grazing: '悠闲吃草 · 低头咀嚼，偶尔抬头' };
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let paused = false;
try { skin.value = localStorage.getItem('ox-design-preview-skin') === 'handdrawn' ? 'handdrawn' : 'classic'; } catch {}
function applySkin() {
  document.documentElement.dataset.skin = skin.value;
  try { localStorage.setItem('ox-design-preview-skin', skin.value); } catch {}
}
function applyMotion() {
  const still = paused || reduced.matches;
  const selected = Object.hasOwn(descriptions, action.value) ? action.value : 'running';
  mascots.src = `${selected}-mascots${still ? '-still' : ''}.svg`;
  mascots.alt = `小牛与小马：${descriptions[selected]}`;
  actionNote.textContent = descriptions[selected];
  motion.textContent = reduced.matches ? '系统已减少动态效果' : paused ? '播放动画' : '暂停动画';
  motion.disabled = reduced.matches;
  motion.setAttribute('aria-pressed', String(still));
}
action.addEventListener('change', applyMotion);
skin.addEventListener('change', applySkin);
motion.addEventListener('click', () => { paused = !paused; applyMotion(); });
reduced.addEventListener('change', applyMotion);
applySkin(); applyMotion();

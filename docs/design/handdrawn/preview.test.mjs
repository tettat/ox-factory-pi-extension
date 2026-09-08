import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
function setup(reduce = false) {
 const elements = Object.fromEntries(['skin','motion','mascots','action','actionNote'].map(id => [id,{value:id==='action'?'sprinting':'classic',handlers:{},attrs:{},addEventListener(event,fn){this.handlers[event]=fn;},setAttribute(k,v){this.attrs[k]=v;}}]));
 const reduced={matches:reduce,addEventListener(_event,fn){this.change=fn;}};
 const root={dataset:{}};
 runInNewContext(readFileSync(new URL('preview.js',import.meta.url),'utf8'),{document:{querySelector:s=>elements[s.slice(1)],documentElement:root},matchMedia:()=>reduced,localStorage:{getItem(){throw Error('storage disabled');},setItem(){throw Error('storage disabled');}}});
 return {elements,reduced,root};
}
test('all actions have animated and matching static assets',()=>{
 const {elements:e}=setup();
 for(const action of ['running','sprinting','grazing','leopard','leopard-run','leopard-jump','cow-truck']) {
  e.action.value=action;e.action.handlers.change();
  assert.equal(e.mascots.src,`${action}-mascots.svg`);
  assert.ok(existsSync(new URL(e.mascots.src,import.meta.url)));
  e.motion.handlers.click();assert.equal(e.mascots.src,`${action}-mascots-still.svg`);
  assert.ok(existsSync(new URL(e.mascots.src,import.meta.url)));
  e.motion.handlers.click();
 }
});
test('reduced motion is honored on load and settings changes',()=>{
 const {elements:e,reduced}=setup(true);assert.equal(e.mascots.src,'sprinting-mascots-still.svg');assert.equal(e.motion.disabled,true);
 e.action.value='grazing';e.action.handlers.change();assert.equal(e.mascots.src,'grazing-mascots-still.svg');
 reduced.matches=false;reduced.change();assert.equal(e.mascots.src,'grazing-mascots.svg');assert.equal(e.motion.disabled,false);
});
test('pause survives skin and action changes without losing selected pose',()=>{
 const {elements:e,root}=setup();e.motion.handlers.click();e.action.value='grazing';e.action.handlers.change();
 e.skin.value='handdrawn';e.skin.handlers.change();assert.equal(root.dataset.skin,'handdrawn');assert.equal(e.mascots.src,'grazing-mascots-still.svg');assert.equal(e.motion.attrs['aria-pressed'],'true');
});
test('unknown action cannot be used as an asset path',()=>{
 const {elements:e}=setup();e.action.value='../../anything';e.action.handlers.change();assert.equal(e.mascots.src,'running-mascots.svg');
});

test('truck scene has no visible text or rooftop cows; keeps four unloading cows',()=>{
 for(const suffix of ['', '-still']) {
  const svg=readFileSync(new URL(`cow-truck-mascots${suffix}.svg`,import.meta.url),'utf8');
  assert.doesNotMatch(svg,/<text\b/);
  assert.doesNotMatch(svg,/class="passenger"/);
  assert.equal((svg.match(/class="convoy"/g)||[]).length,4);
  assert.match(svg,/<title\b/);
 }
});

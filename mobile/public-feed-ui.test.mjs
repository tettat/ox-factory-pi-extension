import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as UI from './web/ui.js';
import { JSDOM } from 'jsdom';
test('mobile keeps long live speech and steer visible, retains stable bubbles and finishes normally', {}, () => {
  const dom=new JSDOM('<div id="timeline"></div><button id="jump-latest"></button>');
  const source=readFileSync(new URL('./web/app.js',import.meta.url),'utf8');
  const ctx=vm.createContext({document:dom.window.document,window:dom.window,UI,
    $:s=>dom.window.document.querySelector(s),esc:UI.escape||((x)=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')),
    time:x=>x||'',status:x=>x||'',icon:()=>'',empty:x=>x,outgoingForDevice:()=>[],remember:x=>x,
    detail:{worker:{name:'员工'},jobs:[{id:'j',status:'running',publicConversation:[{id:'j:0',type:'text',text:'公开文字'.repeat(300),time:'1'},{id:'j:1',type:'steer',text:'不要重启',time:'2'}]}]},
    openedWorker:'员工',chatFilter:'',chatQuery:'',chatLimit:1,timelineSignature:''});
  vm.runInContext(source.slice(source.indexOf('function renderTimeline('),source.indexOf('function modal(')),ctx);
  vm.runInContext('renderTimeline()',ctx);
  const node=dom.window.document.querySelector('#timeline'),old=node.firstChild;
  assert.equal(node.querySelectorAll('article').length,2);
  assert.ok(node.textContent.includes('不要重启'));assert.equal(node.querySelector('details'),null);
  ctx.detail.jobs[0].publicConversation.push({id:'j:2',type:'text',text:'收到',time:'3'});
  vm.runInContext('renderTimeline()',ctx);
  assert.equal(node.firstChild,old);assert.equal(node.querySelectorAll('article').length,3);
  ctx.detail.jobs[0].status='done';ctx.detail.jobs[0].reply='最终结果';
  vm.runInContext('renderTimeline()',ctx);
  assert.equal(node.querySelectorAll('article').length,1);assert.ok(node.textContent.includes('最终结果'));
  dom.window.close();
});

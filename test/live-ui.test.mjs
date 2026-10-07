import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('live snapshots preserve input, focus, expanded state and stable message nodes', {}, () => {
const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const dom=new JSDOM('<main id="main"></main><div id="talkHistory-Codex"></div>');
const ctx=vm.createContext({document:dom.window.document,Node:dom.window.Node,console,STATE:{},$:s=>dom.window.document.querySelector(s),setTimeout,clearTimeout});
function section(from,to){return source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)))}
vm.runInContext(section('  function el(', '  function loadingText(')+section('  const recentListScroll =', '  async function refreshOverviewSilently('),ctx);
vm.runInContext(`
const old=el('div',{},[el('textarea', {id:'draft'}),el('details',{open:true},[el('summary',{text:'A'})]),el('span',{text:'old'})]);
document.querySelector('#main').appendChild(old);
const input=document.querySelector('#draft'); input.value='用户草稿'; input.focus();
const next=el('div',{},[el('textarea',{id:'draft'}),el('details',{},[el('summary',{text:'B'})]),el('span',{text:'new'})]);
patchSnapshotNode(old,next);
globalThis.results={sameInput:input===document.querySelector('#draft'),draft:input.value,focused:document.activeElement===input,expanded:old.querySelector('details').open,text:old.querySelector('span').textContent};
const target=el('div'), snapshot=el('div',{},[el('span',{text:'first'}),el('span',{text:'second'})]);
patchSnapshotChildren(target,snapshot); globalThis.childCount=target.children.length;
`,ctx);
assert.deepEqual(JSON.parse(JSON.stringify(ctx.results)),{sameInput:true,draft:'用户草稿',focused:true,expanded:true,text:'new'});
assert.equal(ctx.childCount,2);
ctx.talkJobSortTime=x=>x.createdAt;ctx.talkRequestSortTime=x=>x.createdAt;ctx.shouldShowTalkRequest=()=>true;
vm.runInContext(`function renderTalkJobItem(worker,j){return el('li',{text:j.task+' '+j.status})} function renderTalkRequestItem(worker,r){return el('li',{text:r.message})}`,ctx);
vm.runInContext(section('  function renderTalkHistory(', '  async function reloadTalkHistory('),ctx);
vm.runInContext(`
const jobs=[{id:'a',kind:'talk',createdAt:'1',task:'任务A',status:'running'},{id:'b',kind:'talk',createdAt:'2',task:'任务B',status:'done'}];
renderTalkHistory('Codex',jobs,[]);const list=document.querySelector('.talk-list'), before=[...list.children];
renderTalkHistory('Codex',jobs,[]);globalThis.stable=before.every((n,i)=>n===list.children[i]);
jobs[0].status='done';renderTalkHistory('Codex',jobs,[]);globalThis.onlyChanged=before[0]===list.children[0]&&before[1]===list.children[1]&&list.children[1].textContent.includes('done');
`,ctx);
assert.equal(ctx.stable,true);assert.equal(ctx.onlyChanged,true);
console.log('DOM regression passed: focus, draft, expanded details, text patch, initial append, stable history, targeted history update');


dom.window.close();
});

test('public feed retains old speech and steer, stable nodes and reader position', {}, () => {
  const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
  const dom=new JSDOM('<main></main>');
  const ctx=vm.createContext({document:dom.window.document,Node:dom.window.Node,console,setInterval:()=>0});
  const section=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
  vm.runInContext(section('  function el(', '  function loadingText(')+section('  const recentListScroll =', '  async function refreshOverviewSilently('),ctx);
  ctx.fmtTime=x=>x||'';
  vm.runInContext("function mdNode(text){return el('div',{text})}",ctx);
  vm.runInContext(section('  const publicFeedCache =', '  function renderTalkJobItem('),ctx);
  vm.runInContext(`
    const feed=publicFeedNode('a'); document.querySelector('main').appendChild(feed);
    const blocks=[{type:'text',text:'先检查代码',time:'1'},{type:'steer',text:'不要重启',time:'2'}];
    paintPublicFeed(feed,blocks);
    const body=feed.querySelector('.public-feed__body'), old=body.firstChild;
    Object.defineProperty(body,'scrollHeight',{value:1000});Object.defineProperty(body,'clientHeight',{value:100});body.scrollTop=100;
    blocks.push({type:'text',text:'收到，继续',time:'3'});paintPublicFeed(feed,blocks);
    globalThis.result={speech:body.textContent,stable:old===body.firstChild,top:body.scrollTop,notification:!feed.querySelector('button').hidden};
    patchSnapshotNode(feed,publicFeedNode('a'));globalThis.retained=body.textContent.includes('不要重启');
  `,ctx);
  assert.ok(ctx.result.speech.includes('先检查代码')&&ctx.result.speech.includes('不要重启')&&ctx.result.speech.includes('收到，继续'));
  assert.equal(ctx.result.stable,true);assert.equal(ctx.result.top,100);assert.equal(ctx.result.notification,true);assert.equal(ctx.retained,true);
  dom.window.close();
});

test('keyed reorder and new rows cannot steal focus, selection or scrolled position', {}, () => {
  const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
  const dom=new JSDOM('<main id="main"></main>');
  const ctx=vm.createContext({document:dom.window.document,Node:dom.window.Node,console});
  const section=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
  vm.runInContext(section('  function el(', '  function loadingText(')+section('  const recentListScroll =', '  async function refreshOverviewSilently('),ctx);
  vm.runInContext(`
    const target=document.querySelector('main');
    function row(id,text){return el('article',{data:{liveKey:id}},[el('button',{text}),el('textarea',{id:'draft-'+id})]);}
    target.append(row('a','A'),row('b','B'));
    const a=target.firstChild, b=target.lastChild, input=b.querySelector('textarea');input.value='未发送草稿';input.focus();input.setSelectionRange(2,4);target.scrollTop=120;
    const next=el('div',{},[row('b','B updated'),row('new','New'),row('a','A updated')]);patchSnapshotChildren(target,next);
    globalThis.focusResult={same:input===document.querySelector('#draft-b'),focused:document.activeElement===input,draft:input.value,start:input.selectionStart,end:input.selectionEnd,scroll:target.scrollTop,updated:b.querySelector('button').textContent};
    input.blur();
    const range=document.createRange();const text=a.querySelector('button').firstChild;range.selectNodeContents(text);document.defaultView.getSelection().addRange(range);
    patchSnapshotChildren(target,el('div',{},[row('b','B again'),row('a','A new text'),row('new','New')]));
    globalThis.selected=document.defaultView.getSelection().toString();
    document.defaultView.getSelection().removeAllRanges();patchSnapshotChildren(target,next);
    globalThis.finalOrder=[...target.children].map(n=>n.dataset.liveKey);
  `,ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.focusResult)),{same:true,focused:true,draft:'未发送草稿',start:2,end:4,scroll:120,updated:'B updated'});
  assert.equal(ctx.selected,'A updated');assert.deepEqual(Array.from(ctx.finalOrder),['b','new','a']);
  dom.window.close();
});

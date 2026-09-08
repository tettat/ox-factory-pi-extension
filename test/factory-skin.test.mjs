import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
function fixture(saved='classic', reduced=false){
 const handlers={}, pending=[];const media={matches:reduced,addEventListener:(_,f)=>handlers.media=f};
 function node(){return {isConnected:true,dataset:{},children:[],attrs:{},classList:{add(){},remove(){}},appendChild(n){this.children.push(n);return n;},remove(){this.removed=true;},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,f){this[k]=f;}};}
 const root=node();const selector=node();selector.value='';
 const doc={documentElement:root,hidden:false,createElement:node,querySelector:()=>selector,addEventListener:(n,f)=>handlers[n]=f,body:node()};
 const storage={getItem:()=>saved,setItem:(_,v)=>saved=v};
 const context={document:doc,localStorage:storage,matchMedia:()=>media,MutationObserver:class{observe(){}},setTimeout:f=>{pending.push(f);return pending.length;},clearTimeout(){},window:{},Math};
 runInNewContext(readFileSync(new URL('../web/factory-skin.js',import.meta.url),'utf8'),context);
 handlers.DOMContentLoaded();
 return {api:context.window.FactorySkin,node,root,doc,media,handlers,flush:()=>{while(pending.length)pending.shift()();}};
}
test('classic is default, invalid saved skin falls back, no mascot created',()=>{
 const f=fixture('invalid');const host=f.node();f.api.decorateLoading(host);f.flush();
 assert.equal(f.root.dataset.skin,'classic');assert.equal(host.children.length,0);
});
test('handdrawn loads one small random mascot, stable across visibility changes',()=>{
 const f=fixture('handdrawn');const host=f.node();f.api.decorateLoading(host);f.flush();
 const image=host.children[0].children[0];const first=image.src;assert.match(first,/skins\/handdrawn\/.+\.svg$/);assert.doesNotMatch(first,/-still/);
 f.doc.hidden=true;f.handlers.visibilitychange();assert.match(image.src,/-still\.svg$/);
 f.doc.hidden=false;f.handlers.visibilitychange();assert.equal(image.src,first);
 f.api.setSkin('classic');assert.equal(host.children[0].removed,true);
});
test('reduced motion uses static asset; disconnected loaders never load',()=>{
 const f=fixture('handdrawn',true),host=f.node();f.api.decorateLoading(host);f.flush();assert.match(host.children[0].children[0].src,/-still/);
 const discarded=f.node();f.api.decorateLoading(discarded);discarded.isConnected=false;f.flush();assert.equal(discarded.children.length,0);
});
test('loading assets are standalone SVGs and total less than 100KB',()=>{
 const dir=new URL('../web/skins/handdrawn/',import.meta.url);const files=readdirSync(dir).filter(x=>x.endsWith('.svg'));assert.equal(files.length,6);
 assert.ok(files.reduce((n,f)=>n+statSync(new URL(f,dir)).size,0)<100*1024);
 for(const f of files){const text=readFileSync(new URL(f,dir),'utf8');assert.doesNotMatch(text,/<(?:script|image|foreignObject)\b/);assert.match(text,/prefers-reduced-motion/);}
});

test('skin assets can be cached without caching factory HTML',async t=>{
 const {createServer}=await import('node:http');const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {buildRouter}=await import('../web-server.mjs');const dir=mkdtempSync(join(tmpdir(),'skin-api-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const server=createServer(buildRouter({workersDir:dir}));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const asset=await fetch(base+'/skins/handdrawn/running.svg');assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/svg/);assert.match(asset.headers.get('cache-control'),/max-age=300/);
 const page=await fetch(base+'/');assert.equal(page.headers.get('cache-control'),'no-store');
});

test('switching back before delay prevents loading a mascot',()=>{
 const f=fixture('handdrawn'),host=f.node();f.api.decorateLoading(host);f.api.setSkin('classic');f.flush();assert.equal(host.children.length,0);
});
test('asset failure restores ordinary placeholder instead of blocking loading',()=>{
 const f=fixture('handdrawn'),host=f.node();f.api.decorateLoading(host);f.flush();const visual=host.children[0];visual.children[0].error();assert.equal(visual.removed,true);
});

test('worker detail and talk history refresh loading placeholders use the skin decorator',()=>{
 const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
 assert.match(source,/target\.appendChild\(loadingText\("加载中…"\)\)/);
 assert.match(source,/box\.appendChild\(loadingText\("加载中…"\)\)/);
});

test('handdrawn loading mascots are larger and centered inside their host container',()=>{
 const css=readFileSync(new URL('../web/handdrawn.css',import.meta.url),'utf8');
 assert.match(css,/\.factory-loading-host\s*\{[^}]*display:flex[^}]*align-items:center[^}]*justify-content:center/s);
 assert.match(css,/\.factory-loading-mascot img\s*\{[^}]*width:180px;[^}]*height:114px/s);
 assert.match(css,/\.factory-loading-host:not\(\.page-loading\) \.factory-loading-mascot img\s*\{[^}]*width:144px;[^}]*height:96px/s);
});

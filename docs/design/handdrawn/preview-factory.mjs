// Read-only real Web shell over disposable demonstration data. No Pi or scheduler.
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildRouter} from '../../../web-server.mjs';
import {createJob,updateJob} from '../../../jobs.mjs';
import {createFactoryTask} from '../../../task-board.mjs';
const base=mkdtempSync(join(tmpdir(),'ox-factory-skin-preview-'));
const dir=join(base,'.pi','workers');mkdirSync(join(dir,'sessions'),{recursive:true});
const names=['示例阿哲','示例八村','示例包包'];
for(const [i,name] of names.entries()){
 writeFileSync(join(dir,'sessions',`${name}.jsonl`),JSON.stringify({type:'session',id:`preview-${i}`,timestamp:new Date().toISOString()})+'\n');
 const job=createJob(dir,{worker:name,project:'皮肤演示',kind:'talk',task:['检查压缩报告','绘制手绘图标','整理测试记录'][i]});
 updateJob(job,{status:'done',startedAt:new Date(Date.now()-120000).toISOString(),finishedAt:new Date().toISOString(),result:'这是隔离预览中的示例任务，没有启动真实员工。',model:'示例模型',inputTokens:2400+i*800,outputTokens:400+i*200});
}
createFactoryTask(dir,{title:'确认手绘皮肤与加载动画',description:'示例卡片，不会派发给员工。',project:'皮肤演示',status:'待验收',creator:'用户'});
writeFileSync(join(dir,'compaction-shadow.jsonl'),JSON.stringify({id:'preview-compaction',worker:names[0],targetType:'worker',createdAt:new Date().toISOString(),pi:{summary:'示例：保留当前目标、已完成工作、风险和待办。',summaryChars:24,estimatedTokens:32},codex:{summary:'示例：本页只演示视觉效果，不涉及真实压缩。',summaryChars:24,estimatedTokens:30}})+'\n');
const route=buildRouter({workersDir:dir});
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');
 if(req.method!=='GET' && req.method!=='HEAD'){res.writeHead(405,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,detail:'只读皮肤预览，禁止写操作'}));return;}
 if(url.pathname==='/' || url.pathname==='/index.html'){
  let html=readFileSync(new URL('../../../web/index.html',import.meta.url),'utf8');
  html=html.replace('<title>牛马工厂 · 驾驶舱</title>','<title>牛马手绘 · 隔离只读预览</title>');
  html=html.replace('data-i18n="brand.subtitle"','').replace('本地协作驾驶舱','只读预览 · 示例数据');
  if(url.searchParams.get('skin')==='handdrawn')html=html.replace('<head>','<head><script>try{localStorage.setItem("ox-factory-skin","handdrawn")}catch{}</script>');
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(html);return;
 }
 // Only this demo delays reads so the loading skin can be inspected.
 if(url.pathname.startsWith('/api/'))await new Promise(r=>setTimeout(r,800));
 try{await route(req,res);}catch(e){if(!res.headersSent)res.writeHead(500,{'content-type':'text/plain'});res.end(String(e.message));}
});
server.listen(8795,'127.0.0.1',()=>console.log(`Read-only skin preview http://127.0.0.1:8795/?skin=handdrawn ; fixtures ${dir}`));

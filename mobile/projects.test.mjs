import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { upsertProject } from '../projects.mjs';
import { createFactoryAdapter } from './factory-adapter.mjs';
import { validateAction, commandDigest } from './protocol.mjs';
import * as UI from './web/ui.js';

function setup(t) {
 const root=mkdtempSync(join(tmpdir(),'mobile-projects-')),workersDir=join(root,'workers');mkdirSync(workersDir);
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const p=upsertProject(workersDir,{id:'手机端',name:'移动项目',aliases:['phone'],summary:'shared project',truthRef:'docs/private-source.md'}),grants={owner_fixture:{actor:'用户',role:'owner'}},calls=[];
 let wrongId=false;
 const factoryFetch=async(url,options)=>{assert.equal(url.origin,'http://127.0.0.1:8787');assert.equal(options.redirect,'error');assert.equal(options.method,undefined);calls.push(url.pathname);
  return {ok:true,json:async()=>({generatedAt:new Date().toISOString(),project:{...p,id:wrongId?'wrong':p.id,password:'MUST_NOT_FORWARD',worktrees:[{path:'PRIVATE_WORKTREE'}],todos:[{id:'todo',title:'Task',status:'doing',owner:'worker',secret:'MUST_NOT_FORWARD'}],links:[{ref:'https://example.com/docs',type:'doc',token:'MUST_NOT_FORWARD'}]},relatedJobs:{total:2,recent:[{id:'job-fixture',worker:'worker',status:'done',task:'test',env:'MUST_NOT_FORWARD'}]},relatedResponsibilities:[{worker:'worker',scope:'UI',secret:'MUST_NOT_FORWARD'}]})};};
 const adapter=createFactoryAdapter({workersDir,stateDir:join(root,'state'),grants:()=>grants,registry:async()=>[],factoryFetch});
 const command=id=>{const body=validateAction('project.detail',{projectId:id});return {id:randomUUID(),action:'project.detail',body,digest:commandDigest('project.detail',body),principalId:'owner_fixture',role:'viewer',expiresAt:Date.now()+60000};};
 return {p,adapter,command,calls,grants,mismatch:()=>{wrongId=true;}};
}
test('project detail protocol is read-only and rejects paths, query injection and unknown fields',()=>{
 assert.deepEqual(validateAction('project.detail',{projectId:'移动端-v2'}),{projectId:'移动端-v2'});
 for(const id of ['../config','a/b','a\\b','a?x=y','%2e%2e','https://example.com','__proto__','constructor',''])assert.throws(()=>validateAction('project.detail',{projectId:id}));
 assert.throws(()=>validateAction('project.detail',{projectId:'test',url:'https://evil.example'}));
});
test('snapshot uses existing registered projects and forwards only a compact summary',async t=>{
 const f=setup(t),s=await f.adapter.snapshot();assert.equal(s.projects.length,1);assert.equal(s.projects[0].id,f.p.id);assert.equal(s.projectsAvailable,true);assert.ok(s.capabilities.includes('project.detail'));
 assert.doesNotMatch(JSON.stringify(s),/private-source|worktrees|MUST_NOT/);assert.equal(f.calls.length,0);
});
test('project detail pins the existing loopback endpoint and sanitizes rich records',async t=>{
 const f=setup(t),r=await f.adapter.execute(f.command(f.p.id));assert.equal(f.calls[0],'/api/projects/'+encodeURIComponent(f.p.id));assert.equal(r.project.name,'移动项目');assert.equal(r.project.todos[0].title,'Task');assert.equal(r.relatedJobs.total,2);
 assert.doesNotMatch(JSON.stringify(r),/MUST_NOT_FORWARD|PRIVATE_WORKTREE|password/);
});
test('project reads re-check grants and never fetch an unregistered or mismatched project',async t=>{
 const f=setup(t);await assert.rejects(f.adapter.execute(f.command('not-registered')),e=>e.code==='PROJECT_NOT_FOUND');assert.equal(f.calls.length,0);
 f.mismatch();await assert.rejects(f.adapter.execute(f.command(f.p.id)),e=>e.code==='FACTORY_UNAVAILABLE');
 f.grants.owner_fixture.revoked=true;await assert.rejects(f.adapter.execute(f.command(f.p.id)),e=>e.code==='LOCAL_GRANT_DENIED');assert.equal(f.calls.length,1);
});
test('mobile project index keeps empty registered projects, joins aliases and separates legacy labels',()=>{
 const snapshot={projects:[{id:'one',name:'第一个',aliases:['Alias'],status:'active',members:[{worker:'lead',status:'active'}]},{id:'empty',name:'空项目',status:'paused'}],tasks:[{id:'a',project:'ALIAS',assignee:'worker'}],jobs:[{id:'b',project:'one',status:'running',updatedAt:100},{id:'c',project:'one-extra',status:'done'}],requests:[{id:'d',project:'legacy',to:'other'}]};
 const list=UI.projectList(snapshot),p=list.find(p=>p.id==='one');assert.equal(list.length,4);assert.equal(p.tasks.length,1);assert.equal(p.jobs.length,1);assert.equal(p.runningCount,1);assert.ok(p.participants.includes('lead'));assert.equal(list.find(p=>p.id==='empty').source,'entity');assert.equal(list.find(p=>p.id==='legacy').source,'activity');assert.equal(snapshot.projects[0].tasks,undefined);
 assert.equal(UI.projectList(snapshot,{status:'registered'}).length,2);assert.equal(UI.projectList(snapshot,{query:'lead'}).length,1);
});
test('ambiguous aliases are not silently assigned to a project, and canonical IDs take precedence',()=>{
 const catalog=[{id:'one',name:'A',aliases:['shared','two']},{id:'two',name:'B',aliases:['shared']}];
 assert.equal(UI.projectForLabel(catalog,'shared'),null);assert.equal(UI.projectForLabel(catalog,'two').id,'two');
 const list=UI.projectList({projects:catalog,tasks:[{project:'shared'}]});assert.equal(list.find(p=>p.source==='activity').tasks.length,1);
});
test('project-scoped tasks include exact case-insensitive aliases but never substring matches',()=>{
 const tasks=[{id:1,project:'phone'},{id:2,project:'Alias'},{id:3,project:'phone-extra'}];
 assert.deepEqual(UI.filterTasks(tasks,{projects:['phone','alias']}).map(t=>t.id),[1,2]);assert.equal(UI.filterTasks(tasks,{project:'phone'}).length,1);
});
test('project index does not merge data from a different factory snapshot or corrupt prototypes',()=>{
 const a=UI.projectList({projects:[{id:'same',name:'A'}],tasks:[{project:'same'}]});const b=UI.projectList({projects:[{id:'same',name:'B'}],tasks:[{project:'__proto__'}]});
 assert.equal(a[0].tasks.length,1);assert.equal(b.find(p=>p.id==='same').tasks.length,0);assert.equal(b.find(p=>p.id==='__proto__').source,'activity');
});

import {workspace} from '../src/registry.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {OfficialBoundary} from '../src/official-boundary.mjs';
import {NativeReadCache,catalogEntry,nativeReadKey} from '../src/native-read-cache.mjs';
import {CacheService} from '../src/cache-service.mjs';
import {SyncFeed} from '../src/sync-feed.mjs';
const parent='11111111-1111-4111-a111-111111111111',child='22222222-2222-4222-a222-222222222222';
const main={id:parent,cwd:workspace('ai').root,name:'synthetic user',source:'exec',status:{type:'idle'}};
const internal={...main,id:child,name:'synthetic reviewer',source:{subAgent:{thread_spawn:{parent_thread_id:parent,depth:1,agent_path:'/root/reviewer'}}},status:{type:'active'}};
function dir(t){const d=mkdtempSync(tmpdir()+'/dsh-internal-source-');t.after(()=>rmSync(d,{recursive:true,force:true}));return d;}
function boundary(calls=[]){return {approvals:new Map(),unmaterialized:new Set(),journal:{ownsThread:()=>false},observe(){},loadedIds:async()=>new Set([parent,child]),checked:async(ws,id)=>{calls.push({method:'checked',id});return id===child?internal:main;},call:async(scope,r)=>{calls.push({method:r.method,id:r.params?.threadId});return r.method==='thread/list'?{data:[internal,main],nextCursor:null}:r.method==='thread/turns/list'?{data:[],nextCursor:null}:{thread:r.params?.threadId===child?internal:main};}};}
test('top-level directory excludes child source, while explicit nested list and child detail remain readable',async()=>{
 const calls=[],native={start:async()=>{},rpc:async(method,p)=>{calls.push({method,p});return method==='thread/list'?{data:[internal,main],nextCursor:null}:{thread:internal};}};
 const b=new OfficialBoundary({native,journal:{ownsThread:()=>false}});
 assert.deepEqual((await b.call('ai',{method:'thread/list',params:{sourceKinds:['exec','subAgent']}})).data.map(t=>t.id),[parent]);
 assert((await b.call('ai',{method:'thread/list',params:{parentThreadId:parent}})).data.some(t=>t.id===child));
 assert.equal((await b.call('ai',{method:'thread/read',params:{threadId:child,includeTurns:false}})).thread.id,child);
});
test('Native child events do not create directory records or repeated background metadata reads',async t=>{
 const calls=[],cache=new NativeReadCache(dir(t),{boundary:boundary(calls)});t.after(()=>cache.close());
 await cache.observe({method:'thread/started',params:{thread:internal}});
 for(const method of ['turn/started','thread/status/changed','turn/completed'])await cache.observe({method,params:{threadId:child}});
 assert.equal(calls.length,0);assert.equal(cache.changes(0,500,'ai').records.length,0);
 cache.rememberThread('ai',main);assert.equal(cache.get('ai','thread:'+parent).payload.nativeThread.id,parent);
});
test('cached mixed source catalog cold restart keeps originals and generation, retiring only internal directory projection',async t=>{
 const d=dir(t),b=boundary();let cache=new NativeReadCache(d,{boundary:b});
 const p=cache.put('ai','thread:'+parent,'catalog',parent,catalogEntry(main));cache.put('ai','thread:'+child,'catalog',child,catalogEntry(internal));
 const key=nativeReadKey('thread/read',{threadId:child,includeTurns:true});const body=cache.put('ai',key,'history',child,{method:'thread/read',params:{threadId:child,includeTurns:true},result:{thread:{...internal,turns:[{id:child,items:[{id:child,type:'agentMessage',text:'synthetic retained body'}]}]}}});
 cache.db.prepare("DELETE FROM cache_meta WHERE key='user-directory-source-v2'").run();
 const generation=cache.generation;cache.close();cache=new NativeReadCache(d,{boundary:b});t.after(()=>cache.close());
 assert.equal(cache.generation,generation);assert.deepEqual(cache.get('ai',key),body);assert.deepEqual(cache.get('ai','thread:'+parent),p);
 assert(cache.get('ai','thread:'+child).deleted);assert(cache.changes(0,500,'ai').records.filter(r=>r.kind==='catalog'&&!r.deleted).every(r=>r.threadId===parent));
});
test('source catalog excludes previously cached active child before active-head reconciliation',async t=>{
 const calls=[],service=await CacheService.create({dir:dir(t),boundary:boundary(calls)});t.after(()=>service.close());
 await service.rpc('cache.rememberThread',['ai',main]);
 await service.rpc('cache.rememberThread',['ai',internal]);
 const r=await service.snapshotCatalog('ai',{fresh:true});
 assert.deepEqual(r.records.filter(x=>!x.deleted).map(x=>x.threadId),[parent]);assert(!calls.some(c=>c.id===child));
});
test('unwatched active child does not subscribe, read body, or publish top-level activity; explicit view still works',async t=>{
 const calls=[],native=new EventEmitter();native.rpc=async(method,p)=>{calls.push({method,id:p.threadId});return {thread:p.threadId===child?internal:main};};
 const feed=new SyncFeed({native,boundary:boundary(calls)}),published=[];feed.on('publish',x=>published.push(x));t.after(()=>feed.close());
 await feed.observe({method:'thread/started',params:{thread:internal}});
 await feed.observe({method:'thread/status/changed',params:{threadId:child,status:{type:'active'}}});
 await new Promise(r=>setTimeout(r,20));
 assert(!calls.some(c=>['thread/resume','thread/turns/list','thread/items/list'].includes(c.method)));assert.equal(published.length,0);assert(!feed.interests.has(child));
 await feed.watch('ai',child);assert(calls.some(c=>c.method==='thread/turns/list'&&c.id===child));
 await feed.observe({method:'turn/completed',params:{threadId:child,turn:{id:child,status:'completed',items:[]}}});
 assert(published.some(x=>x.threadId===child&&x.event.type==='turn'));
});
test('cold unknown child is classified with one metadata read and is never automatically resumed or body-read',async t=>{
 const calls=[],native=new EventEmitter();native.rpc=async(method,p)=>{calls.push({method,id:p.threadId});return {thread:internal};};
 const feed=new SyncFeed({native,boundary:boundary(calls)}),published=[];feed.on('publish',x=>published.push(x));t.after(()=>feed.close());
 for(let i=0;i<3;i++)await feed.observe({method:'thread/status/changed',params:{threadId:child,status:{type:'active'}}});
 assert.deepEqual(calls,[{method:'thread/read',id:child}]);assert.equal(published.length,0);assert.equal(feed.interests.has(child),false);
});
test('child decision resolution stays visible without adding a background body subscription',async t=>{
 const calls=[],native=new EventEmitter();native.rpc=async(method,p)=>{calls.push({method,id:p.threadId});return {thread:internal};};
 const b=boundary(calls);b.observe=m=>{if(m.method==='serverRequest/resolved')b.approvals.delete(String(m.params.requestId));};
 const feed=new SyncFeed({native,boundary:b}),published=[];feed.on('publish',x=>published.push(x));t.after(()=>feed.close());
 await feed.observe({method:'thread/started',params:{thread:internal}});
 const request={id:81,method:'item/tool/requestUserInput',params:{threadId:child,questions:[{id:'decision',question:'Synthetic choice'}]}};
 b.approvals.set('81',request);await feed.observeRequest(request);await feed.observe({method:'serverRequest/resolved',params:{requestId:81}});
 assert.deepEqual(published.map(x=>x.event.type),['approval','approvalResolved']);assert(published.every(x=>x.threadId===child));
 assert.equal(feed.interests.has(child),false);assert(!calls.some(x=>['thread/resume','thread/turns/list','thread/items/list'].includes(x.method)));assert.equal(b.approvals.size,0);
});
test('global search excludes child results while preserving normal user forks and names',async()=>{
 const fork={...main,id:'33333333-3333-4333-a333-333333333333',forkedFromId:parent,name:'Synthetic user fork'};
 const native={start:async()=>{},rpc:async()=>({data:[{thread:internal},{thread:main},{thread:fork}],nextCursor:null})};
 const b=new OfficialBoundary({native,journal:{ownsThread:()=>false}});
 const result=await b.call('ai',{method:'thread/search',params:{searchTerm:'Synthetic'}});
 assert.deepEqual(result.data.map(x=>x.thread.id),[parent,fork.id]);assert.equal(result.data[1].thread.name,fork.name);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {NativeReadCache} from '../src/native-read-cache.mjs';
const source=await readFile(process.env.DSH_TEST_CACHE_SOURCE||new URL('../public/native-local-cache.js',import.meta.url),'utf8');
if(process.env.DSH_STOP_SCOPE)assert((await readFile(process.env.DSH_STOP_SCOPE,'utf8')).includes(source.trim()));
const a=source.indexOf(' const PREWARM_TURNS='),b=source.indexOf(" document.addEventListener('input'",a);
function fixture(){
 const ids=Array.from({length:3},(_,n)=>'11111111-1111-4111-a111-'+String(n).padStart(12,'0')),calls=[];
 const c={internalDirectoryThreads:new Set(),listableEntry:()=>true,scope:{id:'ai'},Set,Map,Date:{now:()=>100000},diagnostics:{},pinnedWarmed:new Set(),queueCachedPreparation(){},preparePinnedSidebar:async()=>{},prepareCachedConversation:()=>new Promise(()=>{}),saveMeta:async()=>{},get:async()=>null,meta:async()=>null,readKey:(method,p)=>JSON.stringify([method,p]),lastForeground:0,foregroundFreshReads:new Set(),navigator:{onLine:true},MutationObserver:class{observe(){} disconnect(){}},requestAnimationFrame:fn=>fn(),scheduleCachedPreparation(){},document:{visibilityState:'visible',querySelector:()=>({}),documentElement:{},addEventListener(){}},location:{pathname:'/'},window:{DSHAndroid:{},__DSH_NATIVE_ONLINE__:true,__DSH_NATIVE_SIDEBAR__:{isList:true}},androidReader:true,nativeClient:null,validNativeRecord:()=>true,setTimeout:()=>1,fetchRead:async(method,p,fresh,priority)=>{calls.push({method,p,fresh,priority});return {payload:{result:method==='thread/read'?{thread:{historyMode:'paginated'}}:{data:method==='thread/turns/list'?[{id:'turn-one'}]:[]}}};},catalogPage:async()=>({entries:ids.map(threadId=>({threadId,sourceUpdatedAt:10}))})};
 c.internalDirectoryThread=()=>false;
 vm.runInNewContext(source.slice(a,b)+';globalThis.api={scanRunning,runBackground,queue:backgroundQueue,enqueue:enqueueBackground,markReady(){startupFrameReady=true;lastForeground=0;}};',c);c.api.markReady();return {c,ids,calls};
}
const quickly=p=>Promise.race([p.then(()=>true),new Promise(r=>setTimeout(()=>r(false),25))]);
test('Android prewarm completes its finite history queue even when renderer preparation never settles',async()=>{
 const f=fixture();await f.c.api.scanRunning();assert.equal(f.c.api.queue.size,3);
 for(let i=0;i<6;i++)assert(await quickly(f.c.api.runBackground()),'a display preparation must not block the cache queue');
 assert.equal(f.c.api.queue.size,0);assert.equal(f.c.diagnostics.background.completed,3);assert.equal(f.calls.filter(c=>c.method==='thread/items/list').length,3);
 assert(f.calls.every(c=>c.priority==='low'));await f.c.api.scanRunning();assert.equal(f.c.api.queue.size,0,'unchanged recent entries stay complete');
});
test('Native read replicas cannot requeue completed preload work but real invalidation still refreshes it',async t=>{
 const f=fixture();let refreshes=0;Object.assign(f.c,{validated:new Map(),syncCatalog:async()=>{refreshes++;},refreshForeground:async()=>{},Event:class{}});f.c.window.dispatchEvent=()=>{};
 const start=source.indexOf(' function replicaChanged('),end=source.indexOf('\n async function connectEvents',start);vm.runInNewContext(source.slice(start,end)+';globalThis.changed=replicaChanged;',f.c);
 const dir=await mkdtemp(tmpdir()+'/dsh-prewarm-producer-'),cache=new NativeReadCache(dir,{boundary:{call:async(_scope,{method,params})=>method==='thread/turns/list'?{data:[{id:'turn-one',status:'completed'}],nextCursor:null}:{data:[{id:'item-one',type:'agentMessage',text:'isolated fixture'}],nextCursor:null}}});
 t.after(async()=>{cache.close();await rm(dir,{recursive:true,force:true});});
 await cache.read('ai','thread/turns/list',{threadId:f.ids[0],limit:2,itemsView:'summary'});
 cache.rememberCursors('ai',{thread:{id:f.ids[0]},itemsBackwardsCursor:'head'});
 await cache.read('ai','thread/items/list',{threadId:f.ids[0],turnId:'turn-one',cursor:'head',limit:20,sortDirection:'desc'});
 const records=cache.changes(0,100,'ai').records;assert(records.some(r=>r.key.startsWith('turn:')));assert(records.some(r=>r.key.startsWith('item:')));assert(records.some(r=>r.key.startsWith('stable-item-head:')));
 for(const record of records)f.c.changed({type:'nativeChanged',threadId:record.threadId,cacheKey:record.key});
 assert.equal(f.c.api.queue.size,0,'persisting a read is not fresh Native execution');
 f.c.changed({type:'nativeChanged',threadId:f.ids[0],cacheKey:'invalidate:'+f.ids[0]});assert.equal(f.c.api.queue.size,1);
 f.c.changed({type:'nativeChanged',threadId:f.ids[0],cacheKey:'thread:'+f.ids[0]});assert.equal(refreshes,1,'catalog changes remain visible');
});
test('stalled Android display preparation releases its cache budget and cannot adopt after expiry',async()=>{
 let now=10000,pendingResolve,applied=0;const timers=new Map(),snapshot={stamp:'one',confirmedAt:10000,revision:1,generation:'g1'};
 const c={scope:{id:'ai'},Set,Map,Date:{now:()=>now},CACHE_IO_TIMEOUT_MS:1200,window:{__DSH_READ_COMMITTED_HISTORY__:async()=>snapshot,__DSH_CLIENT_LOG__:{event(){}}},androidReader:true,nativeClient:{hydrateBackgroundThreads:async(_ids,o)=>{await new Promise(r=>pendingResolve=r);if(o.refreshGuard()){snapshot.applied=true;applied++;}},getConversation:()=>({turnsPagination:{}})},nativeActivity:new Map(),memoryMeta:new Map(),completesVisibleTurn:()=>false,saveFinalRecovery:async()=>{},observePreparedContent(){},readEpoch:0,historyViewEpoch:0,visibleAdoptionEpoch:0,priorityPinned:new Set(),MutationObserver:class{observe(){} disconnect(){}},requestAnimationFrame:fn=>fn(),scheduleCachedPreparation(){},document:{visibilityState:'visible',querySelector:()=>({}),documentElement:{},addEventListener(){}},foregroundFreshReads:new Set(),lastForeground:0,diagnostics:{},setTimeout(fn,ms){const id=Symbol();timers.set(id,{fn,at:now+ms});return id;},clearTimeout(id){timers.delete(id);}};
 const t0=source.indexOf(' const cacheTimeout='),t1=source.indexOf(' async function cacheDb(',t0),r0=source.indexOf(' const rendererPrepared='),r1=source.indexOf(' function summaryPagination(',r0);
 vm.runInNewContext(source.slice(t0,t1)+'\n'+source.slice(r0,r1)+';globalThis.preparing=rendererPending;',c);
 let settled=false;const work=c.window.__DSH_PREPARE_CACHED_CONVERSATION__('thread-one').then(()=>settled=true,()=>settled=true);
 await new Promise(r=>setImmediate(r));assert.equal(c.preparing.size,1);now+=1200;for(const [id,t]of [...timers])if(t.at<=now){timers.delete(id);t.fn();}
 await new Promise(r=>setImmediate(r));assert(settled,'display work must release the existing local cache budget');assert.equal(c.preparing.size,0);
 pendingResolve();await new Promise(r=>setImmediate(r));await work;assert.equal(applied,0,'an expired display result must never overwrite current history');
});

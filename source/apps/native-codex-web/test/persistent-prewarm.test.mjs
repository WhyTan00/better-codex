import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const source=await readFile(process.env.DSH_TEST_CACHE_SOURCE||new URL('../public/native-local-cache.js',import.meta.url),'utf8');
const slice=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
function fixture({updated=10,active=false,sourceGeneration='source',savedPage=false}={}){
 const id='11111111-1111-4111-a111-111111111111',queued=[],prepared=[],network=[],savedCalls=[],key='read:key',head={scope:'ai',key,kind:'history',threadId:id,sourceGeneration:'source',generation:'body',revision:1,deleted:false,payload:{result:{thread:{id,updatedAt:10}}}};
 const metadata=new Map([['catalog-generation',sourceGeneration],['history-prewarmed:'+id,{complete:true,sourceGeneration:'source',generation:'body',sourceUpdatedAt:10}]]);
 const ctx={internalDirectoryThreads:new Set(),listableEntry:()=>true,priorityPinned:new Set(),pinnedWarmed:new Set(),preparePinnedSidebar:async()=>{},cachedCatalogRecord:async()=>({payload:{threadId:id,sourceUpdatedAt:updated,nativeThread:{status:{type:active?'active':'idle'}}}}),PREWARM_RECENT:20,recentWarmed:new Map(),catalogPage:async()=>({entries:[{threadId:id,sourceUpdatedAt:updated,nativeThread:{status:{type:active?'active':'idle'}}}]}),meta:async key=>metadata.get(key),get:async()=>savedPage?null:head,readKey:()=>key,diagnostics:{background:{reused:0}},enqueueBackground:(...args)=>queued.push(args),queueCachedPreparation:id=>prepared.push(id),scope:{id:'ai'},androidReader:true,window:{__DSH_ANDROID_BRIDGE__:{readSavedRecord:async key=>{savedCalls.push(key);return {scope:'ai',record:head};}}},validNativeRecord:r=>r?.scope==='ai'&&!r.deleted,fetchRead:async(...args)=>{network.push(args);return head;}};
 vm.createContext(ctx);const owner=source.match(/const nativeOwnsHistoryWarm=([^;]+);/);if(owner)vm.runInContext('const nativeOwnsHistoryWarm='+owner[1]+';',ctx);vm.runInContext(slice(' async function reusablePrewarm(',' function scheduleBackground()')+slice(' async function prewarmRead(',' async function runBackground()'),ctx);
 return {ctx,id,queued,prepared,network,savedCalls,metadata};
}
test('unchanged durable prewarm survives a document restart without any network history read',async()=>{for(let i=0;i<3;i++){const f=fixture();await f.ctx.warmRecent();assert.equal(f.ctx.diagnostics.background.reused,1);assert.deepEqual(f.queued,[]);assert.deepEqual(f.prepared,[]);assert.deepEqual(f.network,[]);}});
for(const [name,options]of [['changed',{updated:11}],['active',{active:true}],['replaced source',{sourceGeneration:'new-source'}]])test(name+' thread still enters background refresh',async()=>{const f=fixture(options);await f.ctx.warmRecent();assert.equal(f.queued.length,1);assert.equal(f.ctx.diagnostics.background.reused,0);});
test('a saved native read fills an evicted browser page without downloading it again',async()=>{const f=fixture({savedPage:true});const record=await f.ctx.prewarmRead('thread/read',{threadId:f.id,includeTurns:false},false);assert.equal(record.sourceGeneration,'source');assert.equal(f.savedCalls.length,1);assert.deepEqual(f.network,[]);});
test('retired saved pages are display archives, never current-generation prewarm or execution receipts',async()=>{const f=fixture({savedPage:true,sourceGeneration:'new-source'});await f.ctx.prewarmRead('thread/read',{threadId:f.id,includeTurns:false},false);assert.equal(f.network.length,1);});

test('unchanged pinned and recent histories reopen without downloads or offscreen renderer work',async()=>{for(let restart=0;restart<3;restart++){const f=fixture();await f.ctx.warmPinned({threadIds:[f.id]});await f.ctx.warmRecent();assert.equal(f.ctx.diagnostics.background.reused,2);assert.deepEqual(f.queued,[]);assert.deepEqual(f.prepared,[]);assert.deepEqual(f.network,[]);}});
test('a changed pinned thread still queues the read-only history refresh',async()=>{const f=fixture({updated:11});await f.ctx.warmPinned({threadIds:[f.id]});assert.equal(f.queued.length,1);});


test('Android native history owner suppresses duplicate WebView prefetch on repeated reopen',async()=>{
 for(let reopen=0;reopen<3;reopen++){const f=fixture({updated:12});f.ctx.window.__DSH_ANDROID_BRIDGE__.ownsHistoryWarm=()=>true;await f.ctx.warmPinned({threadIds:[f.id]});await f.ctx.warmRecent();assert.deepEqual(f.queued,[]);assert.deepEqual(f.network,[]);}
});

test('a Native bridge without a running history owner keeps the WebView disk warm fallback',async()=>{
 for(const owner of [undefined,()=>false]){const f=fixture({updated:12});f.ctx.window.__DSH_ANDROID_BRIDGE__.ownsHistoryWarm=owner;await f.ctx.warmRecent();assert.equal(f.queued.length,1);}
});

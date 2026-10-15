import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,writeFile} from 'node:fs/promises';
const source=await readFile(process.env.DSH_PROCESS_CACHE||new URL('../public/native-local-cache.js',import.meta.url),'utf8');
const slice=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const block=slice(' // Local-only replicas of process items',' // Only a server-confirmed ETag');
const id='11111111-1111-4111-a111-111111111111';
const user={id:'user',type:'userMessage',content:[{type:'text',text:'fixture'}]},final={id:'final',type:'agentMessage',phase:'final_answer',text:'done'};
const reasoning={id:'reasoning',type:'reasoning',summary:['public progress'],content:[]},tool={id:'tool',type:'commandExecution',status:'completed',command:'fixture',commandActions:[],aggregatedOutput:'visible output'};
const flush=async()=>{for(let i=0;i<12;i++)await new Promise(setImmediate);};
function fixture(disk=new Map()){
 const turn={turnId:'turn',turnStartedAtMs:1000,status:'completed',params:{model:'fixture'},items:structuredClone([user,reasoning,tool,final])};
 const client={getConversation:()=>({turns:[turn]}),updateTurnState(_id,_turn,update){update(turn);}};
 const ctx={nativeClient:client,scope:{id:'ai'},memoryMeta:new Map([['catalog-generation','source']]),confirmedUserHeads:new Map([[id,{sourceGeneration:'source',generation:'generation'}]]),internalDirectoryThreads:new Set(),nativeEventEpoch:new Map(),diagnostics:{},Date,JSON,structuredClone,setTimeout,clearTimeout,addEventListener(){},document:{addEventListener(){}},location:{pathname:'/local/'+id},window:{__DSH_FINAL_IDENTITY__:item=>item.phase==='final_answer'?item.id:null},meta:async key=>structuredClone(disk.get(key)),saveMeta:async(key,value)=>{disk.set(key,structuredClone(value));}};
 vm.createContext(ctx);if(block)vm.runInContext(block,ctx);
 return {ctx,client,turn,disk,snapshot:{response:{thread:{id}},sourceGeneration:'source',generation:'generation',confirmedAt:Date.now()}};
}
test('a completed Native snapshot fills the same-ID empty final stub without overwriting live text',async()=>{
 const first=fixture();first.ctx.captureVisibleProcesses(first.client,id,true);await flush();const f=fixture(first.disk);f.turn.items=structuredClone([user,{...final,text:''}]);f.snapshot.page={data:[{id:'turn',status:'completed',items:[final]}]};await f.ctx.restoreVisibleProcesses(f.client,id,f.snapshot);assert.equal(f.turn.items.find(item=>item.id==='final').text,'done');f.turn.items.find(item=>item.id==='final').text='newer live final';await f.ctx.restoreVisibleProcesses(f.client,id,f.snapshot);assert.equal(f.turn.items.find(item=>item.id==='final').text,'newer live final');
 const empty=fixture(first.disk);empty.turn.items=structuredClone([user,{...final,text:''}]);empty.snapshot.page={data:[{id:'turn',status:'completed',items:[{...final,text:''}]}]};await empty.ctx.restoreVisibleProcesses(empty.client,id,empty.snapshot);assert.equal(empty.turn.items.find(item=>item.id==='final').text,'','a saved display copy cannot override an authoritative empty Native item');
});
test('a displayed final reply survives immediate document loss before a fresh history read completes',async()=>{
 const native=new Map(),first=fixture();first.turn.items=structuredClone([user,final]);
 first.ctx.window.__DSH_ANDROID_BRIDGE__={saveVisibleProcesses:async value=>{native.set(value.turnId,structuredClone(value));return{saved:true}}};
 first.ctx.saveMeta=async()=>{throw Error('browser store unavailable')};
 first.ctx.captureVisibleProcesses(first.client,id,true);await flush();
 assert.equal(native.size,1,'a final-only turn must be saved without another history request');
 assert.equal(native.get('turn').items[0].text,'done');
 const reopened=fixture();reopened.turn.items=structuredClone([user]);reopened.turn.status='inProgress';const before=JSON.stringify(reopened.turn.params);
 reopened.ctx.window.__DSH_ANDROID_BRIDGE__={readVisibleProcesses:async(threadId,turnId)=>({scope:'ai',threadId,turnId,value:native.get(turnId)})};
 await reopened.ctx.restoreVisibleProcesses(reopened.client,id,reopened.snapshot);
 assert.deepEqual(reopened.turn.items.map(item=>item.id),['user','final']);assert.equal(reopened.turn.items[1].text,'done');
 assert.equal(reopened.turn.status,'inProgress','display recovery cannot grant an execution state');assert.equal(JSON.stringify(reopened.turn.params),before);
 reopened.turn.items[1].text='newer live final';await reopened.ctx.restoreVisibleProcesses(reopened.client,id,reopened.snapshot);assert.equal(reopened.turn.items[1].text,'newer live final');
 const rewritten=fixture();rewritten.turn.items=structuredClone([user]);rewritten.snapshot.generation='rewritten';rewritten.ctx.window.__DSH_ANDROID_BRIDGE__=reopened.ctx.window.__DSH_ANDROID_BRIDGE__;
 await rewritten.ctx.restoreVisibleProcesses(rewritten.client,id,rewritten.snapshot);assert.equal(rewritten.turn.items.length,1);
});
test('actual display-cache producer emits a final-only native projection for the durable consumer',async()=>{
 const f=fixture();f.turn.turnId='22222222-2222-4222-a222-222222222222';f.turn.items=structuredClone([user,final]);
 let value;f.ctx.window.__DSH_ANDROID_BRIDGE__={saveVisibleProcesses:async projection=>{value=structuredClone(projection);return{saved:true}}};
 f.ctx.captureVisibleProcesses(f.client,id,true);await flush();assert(value);assert.equal(value.items[0].id,'final');assert.equal(value.items[0].text,'done');
 assert.equal(Object.hasOwn(value,'status'),false);assert.equal(Object.hasOwn(value,'params'),false);
 if(process.env.DSH_VISIBLE_DISPLAY_FIXTURE)await writeFile(process.env.DSH_VISIBLE_DISPLAY_FIXTURE,JSON.stringify(value));
});
test('a stream update does not clone and rewrite every loaded historical turn',async()=>{
 const f=fixture(),turns=Array.from({length:30},(_,i)=>({...structuredClone(f.turn),turnId:'turn-'+i,turnStartedAtMs:i+1}));
 f.client.getConversation=()=>({turns});let clones=0;const clone=f.ctx.structuredClone;f.ctx.structuredClone=value=>{clones++;return clone(value)};
 f.ctx.captureVisibleProcesses(f.client,id,true,'turn-29');await flush();assert.equal(clones,1);assert.equal(f.disk.size,1);
 clones=0;f.ctx.captureVisibleProcesses(f.client,id,true);await flush();assert.equal(clones,2,'a view flush copies only the two newest local turns');assert.equal(f.disk.size,2);
 f.ctx.captureVisibleProcesses(f.client,id,true,'turn-1');await flush();assert(f.disk.has('visible-process-v1:'+id+':turn-1'),'an explicitly changed older turn remains durable');
});
test('already displayed reasoning and tool output survive a new document and compact final hydration',async()=>{
 const first=fixture();assert.equal(typeof first.ctx.captureVisibleProcesses,'function','published old cache drops process items');
 first.ctx.captureVisibleProcesses(first.client,id,true);await flush();assert.equal(first.disk.size,1);
 const reopened=fixture(first.disk);reopened.turn.items=structuredClone([user,final]);const settings=JSON.stringify(reopened.turn.params);
 await reopened.ctx.restoreVisibleProcesses(reopened.client,id,reopened.snapshot);
 assert.deepEqual(reopened.turn.items.map(i=>i.id),['user','reasoning','tool','final']);assert.equal(reopened.turn.items[2].aggregatedOutput,'visible output');assert.equal(JSON.stringify(reopened.turn.params),settings);assert.equal(reopened.turn.status,'completed');
 await reopened.ctx.restoreVisibleProcesses(reopened.client,id,reopened.snapshot);assert.equal(reopened.turn.items.length,4,'no replay duplicates');
});
test('active progress restores without changing status and a newer live item always wins',async()=>{
 const first=fixture();first.turn.status='inProgress';first.ctx.captureVisibleProcesses(first.client,id,true);await flush();
 const reopened=fixture(first.disk);reopened.turn.status='inProgress';reopened.turn.items=structuredClone([user,{...reasoning,summary:['newer live progress']},final]);
 await reopened.ctx.restoreVisibleProcesses(reopened.client,id,reopened.snapshot);assert.equal(reopened.turn.items[1].summary[0],'newer live progress');assert.equal(reopened.turn.status,'inProgress');assert.equal(reopened.turn.items.length,4);
});
test('a partial hydration in a new document cannot erase previously persisted process items',async()=>{
 const first=fixture();first.ctx.captureVisibleProcesses(first.client,id,true);await flush();
 const reopened=fixture(first.disk);reopened.turn.items=structuredClone([user,{id:'next',type:'reasoning',summary:['new process'],content:[]},final]);reopened.ctx.captureVisibleProcesses(reopened.client,id,true);await flush();
 const again=fixture(first.disk);again.turn.items=structuredClone([user,final]);await again.ctx.restoreVisibleProcesses(again.client,id,again.snapshot);
 assert.deepEqual(again.turn.items.map(i=>i.id),['user','reasoning','tool','next','final']);
});
test('renderer clock drift cannot discard the same Native turn or previously displayed items',async()=>{
 const first=fixture();first.turn.turnStartedAtMs=1791789960507;first.ctx.captureVisibleProcesses(first.client,id,true);await flush();
 const reopened=fixture(first.disk);reopened.turn.turnStartedAtMs=1791789960000;reopened.turn.items=structuredClone([user,final]);reopened.snapshot.page={data:[{id:'turn',startedAt:1791789960}]};
 await reopened.ctx.restoreVisibleProcesses(reopened.client,id,reopened.snapshot);assert.deepEqual(reopened.turn.items.map(i=>i.id),['user','reasoning','tool','final']);
 reopened.turn.items=structuredClone([user,{id:'later',type:'reasoning'},final]);reopened.ctx.captureVisibleProcesses(reopened.client,id,true);await flush();
 const saved=[...first.disk.values()][0];assert.equal(saved.nativeTurnStartedAtMs,1791789960000);assert(saved.items.some(i=>i.id==='reasoning'));assert(saved.items.some(i=>i.id==='later'));
});
test('known conflicting Native start times reject restoration and preserve prior durable items',async()=>{
 const first=fixture();first.ctx.rememberNativeProcessStart(id,{id:'turn',startedAt:100},{sourceGeneration:'source',generation:'generation'});first.ctx.captureVisibleProcesses(first.client,id,true);await flush();
 const reopened=fixture(first.disk);reopened.turn.items=structuredClone([user,final]);reopened.snapshot.page={data:[{id:'turn',startedAt:101}]};await reopened.ctx.restoreVisibleProcesses(reopened.client,id,reopened.snapshot);assert.equal(reopened.turn.items.length,2);
 reopened.ctx.rememberNativeProcessStart(id,{id:'turn',startedAt:101},{sourceGeneration:'source',generation:'generation'});reopened.ctx.captureVisibleProcesses(reopened.client,id,true);await flush();assert.equal([...first.disk.values()][0].nativeTurnStartedAtMs,100000);assert.equal([...first.disk.values()][0].items.length,3);
});
test('workspace, source, rewritten generation, turn identity and late storage fences reject old processes',async()=>{
 const first=fixture();first.ctx.captureVisibleProcesses(first.client,id,true);await flush();
 for(const mutate of [f=>f.snapshot.sourceGeneration='other',f=>f.snapshot.generation='rewrite',f=>f.turn.turnId='different-turn',f=>f.ctx.scope.id='zyy',f=>{f.ctx.meta=async key=>{f.ctx.nativeEventEpoch.set(id,1);return f.disk.get(key);};}]){
  const reopened=fixture(first.disk);reopened.turn.items=structuredClone([user,final]);mutate(reopened);await reopened.ctx.restoreVisibleProcesses(reopened.client,id,reopened.snapshot);assert.equal(reopened.turn.items.length,2);
 }
});
test('revert invalidates even process bodies not loaded in this document',async()=>{
 const first=fixture();first.ctx.captureVisibleProcesses(first.client,id,true);await flush();
 const reopened=fixture(first.disk);reopened.turn.items=structuredClone([user,final]);reopened.ctx.forgetVisibleProcesses(id);await flush();await reopened.ctx.restoreVisibleProcesses(reopened.client,id,reopened.snapshot);assert.equal(reopened.turn.items.length,2);
});
test('unchanged events do not rewrite disk and failed writes remain retryable',async()=>{
 const f=fixture();let writes=0;const save=f.ctx.saveMeta;f.ctx.saveMeta=async(...args)=>{writes++;return save(...args);};f.ctx.captureVisibleProcesses(f.client,id,true);await flush();f.ctx.captureVisibleProcesses(f.client,id,true);await flush();assert.equal(writes,1);
 f.turn.items[1].summary.push('next');f.ctx.saveMeta=async()=>{throw Error('fixture disk failure');};f.ctx.captureVisibleProcesses(f.client,id,true);await flush();assert.equal(f.ctx.diagnostics.processCacheFailures,1);f.ctx.saveMeta=save;f.ctx.captureVisibleProcesses(f.client,id,true);await flush();assert.equal([...f.disk.values()][0].items[0].summary.length,2);
});
test('small execution checks bypass occupied HTTP read slots only on negotiated independent RPC receipts',async()=>{
 const calls=[],ctx={window:{__DSH_EXECUTION_METADATA_CONTROL_READY__:()=>true,__DSH_READ_EXECUTION_RPC__:()=>new Promise(()=>{})},client:{},original:async(method,params,options)=>{calls.push({method,params,options});return {thread:{id}};}};vm.createContext(ctx);
 vm.runInContext(slice('  const executionRead=async(','  // Authentication is a current Native fact.')+';globalThis.read=executionRead;',ctx);
 const response=await Promise.race([ctx.read('thread/read',{threadId:id,includeTurns:false}),new Promise((_,reject)=>setTimeout(()=>reject(Error('blocked behind bulk HTTP reads')),80))]);assert.equal(response.thread.id,id);assert.equal(calls[0].options.priority,'critical');
 ctx.window.__DSH_EXECUTION_METADATA_CONTROL_READY__=()=>false;let isolated=0;ctx.window.__DSH_READ_EXECUTION_RPC__=async()=>{isolated++;return {status:200,result:{thread:{id}}};};await ctx.read('thread/read',{threadId:id});assert.equal(isolated,1);assert.equal(calls.length,1,'no duplicate dispatch or fallback after a dispatched read');
});


test('Android durable process copy survives complete browser cache loss and an IndexedDB failure',async()=>{
 const native=new Map(),first=fixture();first.ctx.window.__DSH_ANDROID_BRIDGE__={saveVisibleProcesses:async value=>{native.set(value.turnId,structuredClone(value));return{saved:true}}};first.ctx.saveMeta=async()=>{throw Error('browser quota');};first.ctx.captureVisibleProcesses(first.client,id,true);await flush();assert.equal(native.size,1);assert.equal(first.ctx.diagnostics.processCacheFailures,undefined);
 const second=fixture();second.turn.items=structuredClone([user,final]);second.ctx.window.__DSH_ANDROID_BRIDGE__={readVisibleProcesses:async(threadId,turnId)=>({scope:'ai',threadId,turnId,value:native.get(turnId)})};await second.ctx.restoreVisibleProcesses(second.client,id,second.snapshot);assert.deepEqual(second.turn.items.map(item=>item.id),['user','reasoning','tool','final']);
});
test('actual cached-hydration wrapper reads durable processes before painting a prompt-only turn',async()=>{
 const first=fixture();first.ctx.captureVisibleProcesses(first.client,id,true);await flush();const stored=structuredClone([...first.disk.values()][0]);
 const reopened=fixture(new Map()),ctx=reopened.ctx,phases=[];let release;const pending=new Promise(resolve=>release=resolve);
 reopened.snapshot.page={data:[{id:'turn'},{id:'older'},{id:'not-first-paint'}]};reopened.turn.items=structuredClone([user,final]);
 ctx.window.__DSH_ANDROID_BRIDGE__={readVisibleProcesses:async(threadId,turnId)=>{phases.push('read:'+turnId);if(turnId==='turn')await pending;return{scope:'ai',threadId,turnId,value:turnId==='turn'?stored:null};}};
 // Load the actual new residency helpers used by the hydration wrapper.
 ctx.crypto=crypto;ctx.TextEncoder=TextEncoder;ctx.ArrayBuffer=ArrayBuffer;ctx.Blob=Blob;ctx.Map=Map;ctx.Set=Set;ctx.WeakMap=WeakMap;ctx.document.visibilityState='visible';
 const residency=source.slice(source.indexOf(' // BEGIN bounded renderer body residency'),source.indexOf(' // END bounded renderer body residency'));if(residency)vm.runInContext(residency,ctx);
 ctx.rendererMethods={};ctx.client=reopened.client;ctx.rememberReadModel=()=>{};ctx.hydrateModel=async()=>{phases.push('hydrate');reopened.snapshot.applied=true;return{applied:true};};
 const a=source.indexOf("  if(hydrateModel)Object.defineProperty(rendererMethods,'hydrateBackgroundThreads'"),b=source.indexOf('\n',a);assert(a>=0&&b>a);vm.runInContext(source.slice(a,b),ctx);
 const work=ctx.rendererMethods.hydrateBackgroundThreads([id],{cachedSnapshot:reopened.snapshot,refreshGuard:()=>true});await flush();assert(!phases.includes('hydrate'),'old wrapper paints before its delayed durable-process read');assert(!phases.includes('read:not-first-paint'),'unrelated older turns do not delay first paint');
 release();await work;assert.deepEqual(reopened.turn.items.map(item=>item.id),['user','reasoning','tool','final']);assert.equal(reopened.turn.items[2].aggregatedOutput,'visible output');assert(phases.indexOf('read:turn')<phases.indexOf('hydrate'));
});
test('a rewrite while first-paint processes are being read cannot restore the previous display',async()=>{
 const first=fixture();first.ctx.captureVisibleProcesses(first.client,id,true);await flush();const reopened=fixture(first.disk);reopened.snapshot.page={data:[{id:'turn'}]};const prepared=await reopened.ctx.prepareVisibleProcesses(id,reopened.snapshot);reopened.ctx.forgetVisibleProcesses(id);reopened.turn.items=structuredClone([user,final]);await reopened.ctx.restoreVisibleProcesses(reopened.client,id,reopened.snapshot,()=>true,prepared);assert.equal(reopened.turn.items.length,2);
});

test('canonical-history reader persists the displayed process before and after a new document',async()=>{
 const sdkPath=process.env.DSH_INITIAL_SDK||process.env.DSH_PROCESS_INITIAL_SDK;const sdk=sdkPath?await readFile(sdkPath,'utf8'):'function $2t(e){return e.islands.flatMap(t=>t.entries.map(t=>e.entitiesByKey[t.value]))}function CS(e){};getLoadedConversationHistoryTurns(e){let t=this.loadedTurnsByHistory.get(e);if(t!=null)return t;let n=$2t(e);return this.loadedTurnsByHistory.set(e,n),n}getConversationTurnHistoryTimeline(';
 const a=sdk.indexOf('function $2t('),b=sdk.indexOf('function CS(',a),c=sdk.indexOf('getLoadedConversationHistoryTurns(e){'),d=sdk.indexOf('getConversationTurnHistoryTimeline(',c);assert(a>=0&&b>a&&c>=0&&d>c);
 const getter=vm.runInNewContext(sdk.slice(a,b)+';({'+sdk.slice(c,d)+'}).getLoadedConversationHistoryTurns');
 const first=fixture(),history={islands:[{entries:[{value:'turn'}]}],entitiesByKey:{turn:first.turn}},conversation={turnHistory:{kind:'canonical',history},turns:[]};
 first.client.loadedTurnsByHistory=new WeakMap();first.client.getLoadedConversationHistoryTurns=getter;first.client.getConversation=()=>conversation;
 first.ctx.captureVisibleProcesses(first.client,id,true);await flush();assert.equal(first.disk.size,1,'actual SDK accepts a history object, not a conversation');
 const reopened=fixture(first.disk);reopened.turn.items=structuredClone([user,final]);const nextHistory={islands:[{entries:[{value:'turn'}]}],entitiesByKey:{turn:reopened.turn}};
 reopened.client.loadedTurnsByHistory=new WeakMap();reopened.client.getLoadedConversationHistoryTurns=getter;reopened.client.getConversation=()=>({turnHistory:{kind:'canonical',history:nextHistory},turns:[]});
 await reopened.ctx.restoreVisibleProcesses(reopened.client,id,reopened.snapshot);assert.deepEqual(reopened.turn.items.map(item=>item.id),['user','reasoning','tool','final']);
});

test('a failed optimistic Prompt cannot suppress the first local Native history paint',async()=>{
 const f=fixture();f.ctx.recoveryEpoch=new Map();f.ctx.nativeActivity=new Map([[id,2000]]);f.turn.turnId=null;f.turn.items=structuredClone([user]);f.ctx.snapshot={confirmedAt:1000,verifiedNative:false,savedArchive:false,applied:false};
 vm.runInContext(slice(' function hasVisibleHistory(', ' async function refreshCommitted('),f.ctx);
 let guard=f.ctx.localHistoryGuard(id,f.ctx.snapshot,()=>true,0);assert.equal(guard(),true);assert.equal(f.ctx.snapshot.initialLocalPaint,true);
 f.turn.turnId='real-native-turn';guard=f.ctx.localHistoryGuard(id,{...f.ctx.snapshot,initialLocalPaint:false},()=>true,0);assert.equal(guard(),false,'existing Native history still fences stale reads');
 f.turn.turnId=null;guard=f.ctx.localHistoryGuard(id,f.ctx.snapshot,()=>true,0);f.ctx.recoveryEpoch.set(id,1);assert.equal(guard(),false,'history rewrites remain fenced');
});
test('execution metadata uses negotiated direct control and never falls back after dispatch failure',async()=>{
 const calls=[],ctx={client:{},window:{__DSH_READ_EXECUTION_CONTROL__:async()=>({status:200,result:{thread:{id}}}),__DSH_EXECUTION_METADATA_CONTROL_READY__:()=>true},original:async()=>{calls.push('sdk');throw Error('RPC window occupied')}};vm.createContext(ctx);vm.runInContext(slice('  const executionRead=async(','  // Authentication is a current Native fact.')+';globalThis.read=executionRead;',ctx);
 assert.equal((await ctx.read('thread/read',{threadId:id,includeTurns:false})).thread.id,id);assert.equal(calls.length,0);
 ctx.window.__DSH_READ_EXECUTION_CONTROL__=async()=>{throw Error('connection replaced')};await assert.rejects(ctx.read('thread/read',{threadId:id,includeTurns:false}),/connection replaced/);assert.equal(calls.length,0);
});
test('real reader installation replays selected local paint without waiting for a network or workspace event',async()=>{
 const calls=[],client={},ctx={queueMicrotask,nativeClient:client,location:{pathname:'/local/'+id},window:{},restoreFinalFirst:async selected=>calls.push(['history',selected]),restoreCachedImages:async selected=>calls.push(['images',selected]),refreshCommitted:async()=>calls.push(['adopt'])};vm.createContext(ctx);vm.runInContext(slice(' function restoreSelectedAfterClientInstall(', ' // The Android renderer is a reader'),ctx);
 ctx.restoreSelectedAfterClientInstall(client);await flush();assert.deepEqual(calls,[['history',id],['images',id],['adopt']]);assert(source.includes('  restoreSelectedAfterClientInstall(client);'),'the real install path must invoke it');
 calls.length=0;ctx.restoreSelectedAfterClientInstall(client);ctx.nativeClient={};await flush();assert.equal(calls.length,0,'a replaced reader cannot restore');
});

test('identical local snapshots share one in-flight hydrate without invalidating its guard',async()=>{
 const f=fixture(),ctx=f.ctx,calls=[],release=[],events=[];ctx.document.visibilityState='visible';ctx.knownRunning=new Set();ctx.recoveryEpoch=new Map();ctx.nativeActivity=new Map();ctx.historyViewEpoch=0;ctx.visibleAdoptionEpoch=0;ctx.committedRefresh=null;ctx.committedRefreshId='';ctx.committedPending=false;ctx.committedApplied=new Map();ctx.completesVisibleTurn=()=>false;ctx.finalFromSnapshot=()=>({identity:'final',turnId:'turn'});ctx.saveFinalRecovery=async()=>{};ctx.observePreparedContent=()=>{};ctx.scheduleCommitted=()=>{};ctx.CustomEvent=CustomEvent;ctx.window.__DSH_CLIENT_LOG__={event:(...e)=>events.push(e),reportError(){}};
 f.turn.items=[];f.client.getConversation=()=>({turns:[f.turn],turnsPagination:{}});f.client.hydrateBackgroundThreads=async(_ids,o)=>{calls.push(o);await new Promise(r=>release.push(r));if(o.refreshGuard())o.cachedSnapshot.applied=true;};
 vm.runInContext(slice(' function hasVisibleHistory(', ' function sameHistoryWitness('),ctx);const snapshot={...f.snapshot,page:{data:[]},stamp:'same',revision:10,confirmedAt:1,eventEpoch:0,applied:false};
 const a=structuredClone(snapshot),b=structuredClone(snapshot),first=ctx.refreshCommitted(a);await flush();const second=ctx.refreshCommitted(b);await flush();assert.equal(calls.length,1);release.shift()();await Promise.all([first,second]);assert.equal(a.applied,true);assert(!events.some(([kind])=>kind==='history_rejected'));
});

test('a running process cache without the terminal reply restores before the newly committed final',async()=>{
 const first=fixture(),early={id:'early-final',type:'agentMessage',phase:'final_answer',text:'earlier tool-produced message'},progress={id:'progress',type:'agentMessage',phase:'commentary',text:'working'};
 first.turn.status='inProgress';first.turn.items=structuredClone([user,reasoning,early,progress,tool]);first.ctx.captureVisibleProcesses(first.client,id,true);await flush();
 const reopened=fixture(first.disk);reopened.turn.items=structuredClone([user,final]);reopened.snapshot.page={data:[{id:'turn',status:'completed',items:[user,final]}]};
 await reopened.ctx.restoreVisibleProcesses(reopened.client,id,reopened.snapshot);
 assert.deepEqual(reopened.turn.items.map(i=>i.id),['user','reasoning','early-final','progress','tool','final']);
 assert.equal(reopened.turn.items.at(-1).text,'done');
 reopened.ctx.captureVisibleProcesses(reopened.client,id,true);await flush();
 const again=fixture(first.disk);again.turn.items=structuredClone([user,final]);again.snapshot.page=reopened.snapshot.page;await again.ctx.restoreVisibleProcesses(again.client,id,again.snapshot);assert.equal(again.turn.items.at(-1).id,'final','second reopen must keep the completion after cached progress');
});
test('a previously poisoned process order is repaired from the guarded Native completed snapshot',async()=>{
 const first=fixture();first.turn.items=structuredClone([user,final,reasoning,tool]);first.ctx.captureVisibleProcesses(first.client,id,true);await flush();
 const reopened=fixture(first.disk);reopened.turn.items=structuredClone([user,final,reasoning,tool]);reopened.snapshot.page={data:[{id:'turn',status:'completed',items:[user,final]}]};await reopened.ctx.restoreVisibleProcesses(reopened.client,id,reopened.snapshot);
 assert.deepEqual(reopened.turn.items.map(i=>i.id),['user','reasoning','tool','final']);
 const active=fixture(first.disk);active.turn.items=structuredClone([user,final,reasoning,tool]);active.turn.status='inProgress';active.snapshot.page={data:[{id:'turn',status:'inProgress',items:[user,final]}]};await active.ctx.restoreVisibleProcesses(active.client,id,active.snapshot);assert.deepEqual(active.turn.items.map(i=>i.id),['user','final','reasoning','tool'],'an active snapshot cannot assert a terminal boundary');
 const post=fixture(first.disk);post.turn.items=structuredClone([user,final,reasoning,tool]);post.snapshot.page={data:[{id:'turn',status:'completed',items:[user,final,reasoning,tool]}]};await post.ctx.restoreVisibleProcesses(post.client,id,post.snapshot);assert.deepEqual(post.turn.items.map(i=>i.id),['user','final','reasoning','tool'],'authoritative post-final Native items retain their order');
});

test('shipped renderer selects the committed answer after restoring a running cache', {skip:!process.env.DSH_RENDER_GROUPS},async()=>{
 const groups=await readFile(process.env.DSH_RENDER_GROUPS,'utf8'),a=groups.indexOf('function d('),b=groups.indexOf('var p,m,h,',a);assert(a>=0&&b>a,'pinned renderer grouping changed');
 // Execute the shipped grouping function; unrelated approvals/diff helpers
 // have empty inputs in this fixture. Assistant and tool order is real.
 const render=vm.runInNewContext(groups.slice(a,b)+';d',{g:()=>false,_:()=>false,l:()=>({}),x:x=>x,b:()=>[],y:()=>false,v:x=>x?.type==='assistant-message',w:()=>false,m:{default:x=>x},h:{default:x=>x},p:{default:()=>false}});
 const first=fixture();first.turn.status='inProgress';first.turn.items=structuredClone([user,reasoning,{id:'early',type:'agentMessage',phase:'final_answer',text:'old tool result'},{id:'progress',type:'agentMessage',phase:'commentary',text:'intermediate'},tool]);first.ctx.captureVisibleProcesses(first.client,id,true);await flush();
 const reopened=fixture(first.disk);reopened.turn.items=structuredClone([user,final]);reopened.snapshot.page={data:[{id:'turn',status:'completed',items:[user,final]}]};await reopened.ctx.restoreVisibleProcesses(reopened.client,id,reopened.snapshot);
 const rows=reopened.turn.items.map(item=>item.type==='agentMessage'?{type:'assistant-message',phase:item.phase,searchItemId:item.id,content:item.text,completed:true}:item.type==='userMessage'?{type:'user-message'}:item.type==='commandExecution'?{type:'exec',callId:item.id,completed:true}:{type:'reasoning',completed:true});
 const result=render(rows,'completed');assert.equal(result.assistantItem?.searchItemId,'final');assert.equal(result.assistantItem.content,'done');assert(result.agentItems.some(x=>x.searchItemId==='progress'),'visible process must remain readable');
});

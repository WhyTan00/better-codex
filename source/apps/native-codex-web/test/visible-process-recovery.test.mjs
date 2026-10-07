import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
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
test('workspace, source, rewritten generation, turn identity and late storage fences reject old processes',async()=>{
 const first=fixture();first.ctx.captureVisibleProcesses(first.client,id,true);await flush();
 for(const mutate of [f=>f.snapshot.sourceGeneration='other',f=>f.snapshot.generation='rewrite',f=>f.turn.turnStartedAtMs=2000,f=>f.ctx.scope.id='zyy',f=>{f.ctx.meta=async key=>{f.ctx.nativeEventEpoch.set(id,1);return f.disk.get(key);};}]){
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
 ctx.rendererMethods={};ctx.client=reopened.client;ctx.rememberReadModel=()=>{};ctx.hydrateModel=async()=>{phases.push('hydrate');reopened.snapshot.applied=true;return{applied:true};};
 const a=source.indexOf("  if(hydrateModel)Object.defineProperty(rendererMethods,'hydrateBackgroundThreads'"),b=source.indexOf('\n',a);assert(a>=0&&b>a);vm.runInContext(source.slice(a,b),ctx);
 const work=ctx.rendererMethods.hydrateBackgroundThreads([id],{cachedSnapshot:reopened.snapshot,refreshGuard:()=>true});await flush();assert(!phases.includes('hydrate'),'old wrapper paints before its delayed durable-process read');assert(!phases.includes('read:not-first-paint'),'unrelated older turns do not delay first paint');
 release();await work;assert.deepEqual(reopened.turn.items.map(item=>item.id),['user','reasoning','tool','final']);assert.equal(reopened.turn.items[2].aggregatedOutput,'visible output');assert(phases.indexOf('read:turn')<phases.indexOf('hydrate'));
});
test('a rewrite while first-paint processes are being read cannot restore the previous display',async()=>{
 const first=fixture();first.ctx.captureVisibleProcesses(first.client,id,true);await flush();const reopened=fixture(first.disk);reopened.snapshot.page={data:[{id:'turn'}]};const prepared=await reopened.ctx.prepareVisibleProcesses(id,reopened.snapshot);reopened.ctx.forgetVisibleProcesses(id);reopened.turn.items=structuredClone([user,final]);await reopened.ctx.restoreVisibleProcesses(reopened.client,id,reopened.snapshot,()=>true,prepared);assert.equal(reopened.turn.items.length,2);
});

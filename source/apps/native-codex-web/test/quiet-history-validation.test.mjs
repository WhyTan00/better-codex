import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {env} from '../../../../scripts/lib/client-diagnostics-fixture.mjs';

const source=await readFile(process.env.DSH_TEST_CACHE_SOURCE||new URL('../public/native-local-cache.js',import.meta.url),'utf8');
const helper=source.indexOf(' function observeHistoryDecision('),start=helper<0?source.indexOf(' function sameHistoryWitness('):helper,end=source.indexOf(' let entryScheduled=',start);
const id='11111111-1111-4111-a111-111111111111';
function fixture({changed=false,event=false,active=false,sourceChanged=false}={}){
 const calls=[],events=[],snapshot={verifiedNative:false,sourceGeneration:'source',generation:'thread',confirmedAt:100,bodyLoadedTurnIds:['turn'],response:{thread:{id,updatedAt:10}},page:{data:[{id:'turn',status:'completed',startedAt:1,completedAt:2,items:[{type:'agentMessage',phase:'final_answer'}]}]}};
 const ctx={CustomEvent,androidReader:true,nativeClient:{},document:{visibilityState:'visible'},navigator:{onLine:true},location:{pathname:'/local/'+id},window:{dispatchEvent:e=>events.push(e),__DSH_READ_COMMITTED_HISTORY__:async()=>snapshot,__DSH_CLIENT_LOG__:{event(){},reportError(_kind,error){throw error;}},__DSH_FINAL_IDENTITY__:()=>true},knownRunning:new Set(active?[id]:[]),foregroundRefresh:null,foregroundId:null,foregroundAgain:false,foregroundChecked:0,historyViewEpoch:1,nativeEventEpoch:new Map([[id,0]]),nativeActivity:new Map(event?[[id,200]]:[]),diagnostics:{},queueMicrotask,finalFromSnapshot:s=>s?.page?.data[0]?.status==='completed'?{}:null,fetchRead:async(method)=>{
  calls.push(method);return {sourceGeneration:sourceChanged?'new-source':'source',generation:'thread',payload:{result:method==='thread/read'?snapshot.response:{data:[{...snapshot.page.data[0],id:changed?'new-turn':'turn',items:undefined}]}}};
 },readFinalSummary:async()=>{calls.push('body');return {...snapshot,verifiedNative:true};},readFreshSnapshot:async()=>{throw Error('unnecessary process read');},refreshCommitted:async()=>calls.push('adopt')};
 assert(start>=0&&end>start);
 vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);return {ctx,calls,snapshot,events};
}
test('quiet re-entry validates two small metadata records without reloading or adopting unchanged body',async()=>{
 const f=fixture();await f.ctx.refreshForeground(true);assert.deepEqual(f.calls,['thread/read','thread/turns/list']);assert.equal(f.events.length,1);assert.equal(f.events[0].type,'dsh:history-synchronized');assert.equal(f.events[0].detail.threadId,id);
});
for(const [name,opts] of [['new turn',{changed:true}],['missed event',{event:true}],['active task',{active:true}],['source rebuild',{sourceChanged:true}]])test(name+' still refreshes the selected body',async()=>{
 const f=fixture(opts);await f.ctx.refreshForeground(true);assert(f.calls.includes('body'));assert(f.calls.includes('adopt'));
});
test('metadata witness compares exact completion and history generation, not just second-resolution updatedAt',()=>{
 const f=fixture(),head={sourceGeneration:'source',generation:'thread',payload:{result:f.snapshot.response}},turn={...head,payload:{result:{data:[{...f.snapshot.page.data[0]}]}}};
 assert.equal(f.ctx.sameHistoryWitness(f.snapshot,head,turn),true);
 turn.payload.result.data[0].completedAt=3;assert.equal(f.ctx.sameHistoryWitness(f.snapshot,head,turn),false);
 turn.payload.result.data[0].completedAt=2;turn.generation='rewritten';assert.equal(f.ctx.sameHistoryWitness(f.snapshot,head,turn),false);
 turn.generation='thread';head.source='cloud-cache';assert.equal(f.ctx.sameHistoryWitness(f.snapshot,head,turn),false,'a cache hit is not a Native freshness receipt');
});

test('cache decision records actual reuse versus re-read through the production whitelist',async()=>{
 for(const changed of [false,true]){
  const f=fixture({changed}),logger=env();f.ctx.window.__DSH_CLIENT_LOG__=logger.log;
  await f.ctx.refreshForeground(true);
  const rows=logger.log.snapshot().events.filter(e=>e.kind==='history_read');
  assert.equal(rows.length,1);const event=rows[0];
  assert.equal(event.threadId,id);assert.equal(event.selected,true);assert.equal(event.cacheReady,true);
  assert.equal(event.stage,changed?'requested':'skipped');assert.equal(event.validated,!changed);assert.equal(event.fresh,changed);
  assert.equal(f.calls.includes('body'),changed);
 }
});
test('cache decision diagnostics cannot force a body read or stop native freshness notification',async()=>{
 const f=fixture();f.ctx.window.__DSH_CLIENT_LOG__.event=()=>{throw Error('diagnostic unavailable');};
 await f.ctx.refreshForeground(true);assert.deepEqual(f.calls,['thread/read','thread/turns/list']);assert.equal(f.events.length,1);
});

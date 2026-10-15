import test from 'node:test';
import assert from 'node:assert/strict';
import {env} from '../../../../scripts/lib/client-diagnostics-fixture.mjs';
const ticks=async()=>{for(let n=0;n<80;n++)await Promise.resolve();};
test('explicit native retention drops do not roll back faults or retry ordinary samples forever',async()=>{
 const f=env({online:false});f.c.__DSH_ANDROID_BRIDGE__={canRecordDiagnostics:()=>true,recordDiagnostics:async events=>({received:true,acknowledgedEventIds:events.filter(e=>e.kind!=='client_health').map(e=>e.eventId),discardedEventIds:events.filter(e=>e.kind==='client_health').map(e=>e.eventId)})};const fault=f.log.event('history_applied',{revision:42}),ordinary=f.log.event('client_health',{stage:'received',component:'page-ws'});await f.log.flush();assert.equal(f.log.snapshot().pendingCount,0);assert.equal(f.log.snapshot().uploadFailures,0);assert(f.log.snapshot().pendingDropped>0);assert(f.log.snapshot().events.some(e=>e.eventId===fault));assert(f.log.snapshot().events.some(e=>e.eventId===ordinary));assert.equal(f.uploads.length,0);
});
test('a retention receipt cannot discard an event that was not in the native batch',async()=>{
 const f=env({online:false});f.c.__DSH_ANDROID_BRIDGE__={canRecordDiagnostics:()=>true,recordDiagnostics:async events=>({received:true,acknowledgedEventIds:events.map(e=>e.eventId),discardedEventIds:['foreign-id']})};f.log.event('history_applied',{revision:42});await f.log.flush();assert(f.log.snapshot().pendingCount>0);assert.equal(f.log.snapshot().uploadFailures,1);
});
test('offline WebView hands metadata to native durable outbox and only removes acknowledged IDs',async()=>{
 const f=env({online:false});let receipt,accepted;
 f.c.__DSH_ANDROID_BRIDGE__={canRecordDiagnostics:()=>true,recordDiagnostics:events=>{accepted=events;return new Promise(resolve=>receipt=resolve);}};
 const id=f.log.event('send_flow',{stage:'accepted'}),work=f.log.flush();await ticks();
 assert(accepted.some(e=>e.eventId===id));assert(f.log.snapshot().pendingCount>0);assert.equal(f.uploads.length,0);
 receipt({received:true,acknowledgedEventIds:[id]});await work;
 assert(f.log.snapshot().pendingCount>0,'unacknowledged boot evidence remains');
 assert(![...f.storage.values()].some(v=>v.includes('"eventId":"'+id+'"')&&v.includes('"pendingIds":["'+id+'"')));
 f.c.__DSH_ANDROID_BRIDGE__.recordDiagnostics=async events=>({received:true,acknowledgedEventIds:events.map(e=>e.eventId)});
 await f.log.flush();assert.equal(f.log.snapshot().pendingCount,0);assert.equal(f.uploads.length,0);
});
for(const stalledStage of ['fetch','receipt'])test(`diagnostic ${stalledStage} timeout releases the uploader and retains unacknowledged evidence`,async()=>{
 let resolveOld,stalled=true;
 const f=env({online:true,fetchImpl:(_url,options)=>{
  const events=JSON.parse(options.body).events;
  if(!stalled)return {ok:true,json:async()=>({received:true,acknowledgedEventIds:events.map(e=>e.eventId)})};
  const pending=new Promise(resolve=>resolveOld=()=>resolve(stalledStage==='fetch'?{ok:true,json:async()=>({received:true,acknowledgedEventIds:events.map(e=>e.eventId)})}:{received:true,acknowledgedEventIds:events.map(e=>e.eventId)}));
  return stalledStage==='fetch'?pending:{ok:true,json:()=>pending};
 }});
 const id=f.log.event('sync_failed',{statusCode:503});let done=false;
 f.log.flush().then(()=>done=true);await ticks();
 const timer=[...f.timers.values()].find(t=>t.ms===5000);assert(timer);timer.fn();await ticks();
 assert(done,'the existing 5-second deadline must settle even if abort is ignored');
 assert(f.log.snapshot().events.some(e=>e.eventId===id));assert(f.log.snapshot().pendingCount>0);assert.equal(f.log.snapshot().uploadFailures,1);
 // A late response to the expired attempt cannot acknowledge this outbox.
 resolveOld();await ticks();assert(f.log.snapshot().pendingCount>0);
 stalled=false;await f.log.flush();assert.equal(f.log.snapshot().pendingCount,0);
});

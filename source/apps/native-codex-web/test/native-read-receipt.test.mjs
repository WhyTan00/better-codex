import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {pathToFileURL} from 'node:url';
import {SyncAdapter} from '../src/sync-adapter.mjs';
import {safeConnectionEvent} from '../src/connection-diagnostics.mjs';

const threadId='11111111-1111-4111-a111-111111111111',traceId='22222222-2222-4222-a222-222222222222';
const request={id:'0123456789abcdef0123456789abcdef',scope:'ai',op:'native-read',traceId,body:{method:'thread/read',params:{threadId,includeTurns:false},fresh:true}};
function fixture(Adapter=SyncAdapter){
 const native=new EventEmitter();native.start=async()=>{};
 const feed=new EventEmitter(),record={scope:'ai',threadId,key:'read:head',revision:42,sourceGeneration:'source',generation:'generation',bytes:2*1024*1024,payload:{privateText:'x'.repeat(2*1024*1024)}};
 feed.sequence=4;feed.nativeCache={read:async()=>record,get:()=>record};
 const adapter=new Adapter({native,feed}),sent=[],logs=[];
 adapter.ready=true;adapter.ack=4;adapter.sentSequence=4;
 // The requested record is acknowledged, but an unrelated stream is queued
 // before execute resolves. It must not become a dependency of this reply.
 feed.publish=()=>{feed.sequence=10;return 4;};
 adapter.socket={readyState:1,bufferedAmount:0};adapter.writing=true;
 adapter.connectionLog={event:e=>logs.push(safeConnectionEvent(e))};
 const raw=adapter.sendRaw.bind(adapter);adapter.sendRaw=(text,data)=>{sent.push({value:JSON.parse(text),data:!!data});return raw(text,data);};
 return {adapter,record,sent,logs};
}
test('an acknowledged native read returns a small control receipt without waiting for unrelated stream data',async()=>{
 const f=fixture();f.adapter.dataQueue.push('unrelated large history');
 f.adapter.flush=()=>{throw Error('native read incorrectly drains global stream');};
 await f.adapter.handle(request);
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].data,false);
 assert.deepEqual(f.sent[0].value.result,{scope:'ai',key:'read:head',revision:42,sourceGeneration:'source',generation:'generation'});
 assert(f.adapter.controlQueue.length===1);assert.equal(f.adapter.dataQueue.length,1);
 assert(f.adapter.controlQueue[0].length<512);assert(!f.adapter.controlQueue[0].includes('privateText'));
 const ack=f.logs.find(e=>e.readPhase==='publish_ack'&&e.stage==='committed');
 assert.equal(ack.traceId,traceId);assert.equal(ack.targetSequence,4);
 assert.equal(ack.readIdHash,'3eb1bd439947eb76');
});
test('fresh unchanged content reuses the gateway attestation, while changed source, generation or revision requires a new ACK',async()=>{
 const knownRecord={sourceGeneration:'source',generation:'generation',revision:42};
 const f=fixture();let reads=0;f.adapter.feed.nativeCache.read=async(scope,method,params,options)=>{reads++;assert.equal(options.fresh,true);return f.record;};
 f.adapter.feed.publish=()=>{throw Error('unchanged record was needlessly republished');};
 await f.adapter.handle({...request,body:{...request.body,knownRecord}});
 assert.equal(reads,1,'fresh validation still calls the native cache read');assert(f.sent[0].value.result);
 assert(f.logs.some(e=>e.readPhase==='cloud_reuse'&&e.stage==='committed'));
 for(const mismatch of [{sourceGeneration:'old'},{generation:'reverted'},{revision:41},{sourceGeneration:''}]){
  const g=fixture();g.adapter.ack=3;g.adapter.ready=false;
  await g.adapter.handle({...request,body:{...request.body,knownRecord:{...knownRecord,...mismatch}}});
  assert.equal(g.sent[0].value.failureStage,'publish_ack');
 }
});
test('a read cannot return success before its own cloud commit ACK, and failure names the missing stage',async()=>{
 const f=fixture();f.adapter.ack=3;f.adapter.ready=false;
 await f.adapter.handle(request);
 assert.equal(f.sent[0].value.result,undefined);assert.equal(f.sent[0].value.status,503);
 assert.equal(f.sent[0].value.failureStage,'publish_ack');
 assert(f.logs.some(e=>e.stage==='failed'&&e.readPhase==='publish_ack'&&e.ack===3&&e.traceId===traceId));
});
test('the previous deployed adapter reproduces a failed read after the record was already acknowledged',{skip:!process.env.DSH_READ_BASELINE_ADAPTER},async t=>{
 const {SyncAdapter:Old}=await import(pathToFileURL(process.env.DSH_READ_BASELINE_ADAPTER));
 const f=fixture(Old);let now=Date.now();t.mock.method(Date,'now',()=>now);
 f.adapter.flush=()=>{now+=20001;};
 await f.adapter.handle(request);
 assert.equal(f.sent[0].value.status,503);assert.equal(f.sent[0].value.result,undefined);
 assert.equal(f.adapter.ack,4,'its own record had been acknowledged');
});

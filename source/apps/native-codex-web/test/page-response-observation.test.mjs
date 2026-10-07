import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {env,source as defaultSource} from '../../../../scripts/lib/client-diagnostics-fixture.mjs';

const source=process.env.DSH_DIAGNOSTIC_SOURCE?await readFile(process.env.DSH_DIAGNOSTIC_SOURCE,'utf8'):defaultSource;
if(process.env.DSH_DIAGNOSTIC_SCOPE)assert((await readFile(process.env.DSH_DIAGNOSTIC_SCOPE,'utf8')).includes(source.trim()),'final scope must contain the exact tested diagnostic module');
const connectionId='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
const wireEvents=f=>f.log.snapshot().events.filter(e=>e.component==='page-ws'&&['body_ready','cache_import'].includes(e.reason));

test('page frame observation records original clocks, UTF-8 bytes and RPC identity without copying contents',async()=>{
 const f=env({script:source}),payload={type:'mcp-request',request:{id:'fixture-rpc',method:'thread/list',params:{limit:50}}};f.log.ipc('channel',payload);
 const message={dshPageSeq:42,payload:{type:'mcp-response',message:{id:'fixture-rpc',result:{data:['PRIVATE_FIXTURE_仅隔离测试'],secret:'not-a-real-credential'}}}},raw=JSON.stringify(message),before=structuredClone(message),at=Date.now();
 const finish=f.log.beginReceivedFrame(raw,message,{connectionId,receivedAt:at,receivedMono:2000,parsedAt:at+7,parsedMono:2007});assert.equal(wireEvents(f).length,0,'journaling is not synchronous in the receive callback');
 f.c.performance.now=()=>2018;f.c.Date=class extends Date{static now(){return at+18;}};finish();finish();await flush();const events=wireEvents(f);
 assert.equal(events.length,3);assert.deepEqual(Array.from(events,e=>e.durationMs),[0,7,18]);assert.deepEqual(Array.from(events,e=>e.monoMs),[2000,2007,2018]);assert.equal(events[0].clientAt,at);assert.equal(events[1].clientAt,at+7);
 assert(events.every(e=>e.count===Buffer.byteLength(raw)&&e.eventCursor===42&&e.rpcIdHash===f.log.hashId('fixture-rpc')&&e.method==='thread/list'));
 assert.deepEqual(message,before);const diagnostic=JSON.stringify(events);assert(!diagnostic.includes('PRIVATE_FIXTURE'));assert(!diagnostic.includes('not-a-real-credential'));assert(!diagnostic.includes('fixture-rpc'));
 f.log.response(message.payload);assert(f.log.snapshot().events.some(e=>e.kind==='rpc'&&e.stage==='received'),'frame observation must not consume the real request lifecycle');
});

test('page frame observation samples large atom frames once, caps each wire and ignores fast small frames',async()=>{
 const f=env({script:source}),at=Date.now(),small={dshPageSeq:1,payload:{type:'mcp-response',message:{id:'untracked',result:{ok:true}}}};
 assert.equal(f.log.beginReceivedFrame(JSON.stringify(small),small,{connectionId,receivedAt:at,receivedMono:100,parsedAt:at,parsedMono:101}),undefined);
 const message={dshPageSeq:2,payload:{type:'persisted-atom-sync',state:{fixture:'x'.repeat(35000)}}},raw=JSON.stringify(message);let encodes=0;f.c.TextEncoder=class extends TextEncoder{encode(value){encodes++;return super.encode(value);}};
 for(let i=0;i<20;i++){const finish=f.log.beginReceivedFrame(raw,message,{connectionId,receivedAt:at+i,receivedMono:100,parsedAt:at+i,parsedMono:101});if(finish){f.c.performance.now=()=>102;finish();}}
 await flush();assert.equal(encodes,12);assert.equal(wireEvents(f).length,36);assert(wireEvents(f).every(e=>e.count===Buffer.byteLength(raw)));
 f.log.beginReceivedFrame(raw,message,{connectionId,receivedAt:at+60001,receivedMono:61000,parsedAt:at+60001,parsedMono:61001})();await flush();assert.equal(encodes,13);assert.equal(wireEvents(f).length,39);
});

test('unavailable frame instrumentation does not throw or mutate an incoming message',()=>{
 const f=env({script:source}),message={dshPageSeq:1,payload:{type:'persisted-atom-sync',state:{fixture:'unchanged'}}},before=structuredClone(message);f.c.TextEncoder=class{encode(){throw Error('isolated encoding failure');}};
 assert.equal(f.log.beginReceivedFrame(JSON.stringify(message),message,{connectionId,receivedAt:Date.now(),receivedMono:1,parsedAt:Date.now(),parsedMono:2}),undefined);assert.deepEqual(message,before);
});

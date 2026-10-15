import test from 'node:test';
import assert from 'node:assert/strict';
import {PageSessions} from '../src/page-sessions.mjs';
import {hashDiagnosticId,safeConnectionEvent} from '../src/connection-diagnostics.mjs';
const identity={scope:'ai',pageId:'renderer',stableId:'tab',origin:'https://example.invalid'};
const firstId='00000000-0000-4000-8000-000000000001',secondId='00000000-0000-4000-8000-000000000002';
const wire=()=>({readyState:1,bufferedAmount:13,_sender:{_queue:[]},sent:[],send(raw,callback){this.sent.push({raw,callback});},close(){this.readyState=3;}});
function fixture(observer){const events=[],sessions=new PageSessions({onWireEvent:observer||((entry)=>events.push(safeConnectionEvent(entry)))}),socket=wire(),{session}=sessions.attach(socket,identity);Object.assign(session,{connectionId:firstId,diagnosticPageId:'abcdef12'});return {events,sessions,socket,session};}
test('queued and socket-write phases distinguish a blocked frame without waiting for ACK or recording its body',()=>{
 const {events,sessions,socket,session}=fixture();
 const message={payload:{type:'mcp-response',message:{id:'PRIVATE-rpc',result:{secret:'PRIVATE-body'}}}};
 assert.equal(sessions.send(session,message),true);assert.equal(events.length,1);assert.equal(events[0].stage,'wire_queued');assert.equal(events[0].payloadBytes,Buffer.byteLength(socket.sent[0].raw));assert.equal(events[0].rpcIdHash,hashDiagnosticId('PRIVATE-rpc'));assert.equal(events[0].sequence,1);assert.equal(session.ackedSeq,0);
 socket.bufferedAmount=0;socket.sent[0].callback();assert.equal(events[1].stage,'wire_sent');assert.equal(events[1].bufferedBytes,0);assert.equal(session.ackedSeq,0);assert(!JSON.stringify(events).includes('PRIVATE'));assert.deepEqual(JSON.parse(socket.sent[0].raw),{...message,dshPageSeq:1});sessions.close();
});
test('an old socket completion retains its identity after replacement; replay is the exact original frame',()=>{
 const {events,sessions,socket,session}=fixture();sessions.send(session,{type:'app-host-port-message',data:'PRIVATE'});
 const second=wire();sessions.attach(second,{...identity,resumeId:session.resumeId});session.connectionId=secondId;sessions.replay(session);
 socket.sent[0].callback();second.sent[0].callback();assert.equal(second.sent[0].raw,socket.sent[0].raw);
 const completed=events.filter(e=>e.stage==='wire_sent');assert.deepEqual(completed.map(e=>e.connectionId),[firstId,secondId]);assert.deepEqual(completed.map(e=>e.replayed),[false,true]);assert.deepEqual(completed.map(e=>e.sequence),[1,1]);assert.deepEqual(completed.map(e=>e.wireSequence),[1,1]);sessions.close();
});
test('send error records fixed metadata and never introduces a replay or rollback',()=>{
 const {events,sessions,socket,session}=fixture();sessions.send(session,{payload:{type:'fetch-response',requestId:'PRIVATE-id',bodyJsonString:'PRIVATE-body'}});
 socket.sent[0].callback(Object.assign(Error('PRIVATE error'),{code:'EPIPE'}));assert.equal(events.at(-1).stage,'wire_failed');assert.equal(events.at(-1).errorCode,'EPIPE');assert.equal(socket.sent.length,1);assert.equal(session.outbox.size,1);assert(!JSON.stringify(events).includes('PRIVATE'));sessions.close();
});
test('diagnostic failures are nonblocking and synchronous transport failure keeps existing throw behavior',()=>{
 const {sessions,socket,session}=fixture(()=>{throw Error('diagnostic disk unavailable');});
 assert.equal(sessions.send(session,{payload:{type:'mcp-response',message:{id:1,result:true}}}),true);assert.doesNotThrow(()=>socket.sent[0].callback());
 socket.send=()=>{throw Error('transport failed');};assert.throws(()=>sessions.send(session,{data:2}),/transport failed/);socket.send=()=>{};sessions.close();
});
test('control frames and uninstrumented use keep the original protocol and detached replies do not claim a wire send',()=>{
 const {events,sessions,socket,session}=fixture();sessions.control(session,{type:'dsh:pong',nonce:'PRIVATE'});assert.deepEqual(JSON.parse(socket.sent[0].raw),{type:'dsh:pong',nonce:'PRIVATE'});socket.sent[0].callback();assert.equal(events.length,2);assert(events.every(e=>e.frameKind==='dsh:pong'&&e.rpcIdHash===hashDiagnosticId('PRIVATE')));events.length=0;
 sessions.detach(session,socket);sessions.send(session,{payload:{type:'mcp-response',message:{id:2,result:true}}});assert.equal(events.length,0);assert.equal(session.outbox.size,1);sessions.close();
 const plain=new PageSessions(),plainWire=wire(),entry=plain.attach(plainWire,identity);plain.send(entry.session,{data:1});assert.equal(typeof plainWire.sent[0].callback,'function');plainWire.sent[0].callback();plain.close();
});
test('wire metadata fields are allowlisted and cannot carry arbitrary frame names, IDs, URLs or bodies',()=>{
 const {events,sessions,socket,session}=fixture();sessions.send(session,{type:'PRIVATE-type',requestId:'PRIVATE',url:'PRIVATE',data:'PRIVATE'.repeat(4096)});socket.sent[0].callback();assert.equal(events[0].frameKind,'other');assert(!JSON.stringify(events).includes('PRIVATE'));
 assert.deepEqual(safeConnectionEvent({stage:'wire_sent',frameKind:'PRIVATE',payloadBytes:22,wireSequence:2,senderQueueFrames:0,replayed:true,raw:'PRIVATE'}),{stage:'wire_sent',wireSequence:2,payloadBytes:22,senderQueueFrames:0,replayed:true});sessions.close();
});

test('sampling is bounded for fast deltas and AppHost bootstrap but retains large and slow frames with ordinal gaps',async()=>{
 const {events,sessions,socket,session}=fixture();
 // This tests sampling on a receiving page. ACK each delivered frame so the
 // production receipt window does not correctly stop this unrelated fixture.
 const deliver=()=>{socket.sent.at(-1).callback();sessions.acknowledge(session,session.writtenSeq);};
 for(let i=0;i<100;i++){sessions.send(session,{payload:{type:'mcp-notification',method:'item/agentMessage/delta',params:{delta:'x'}}});deliver();}
 assert.equal(events.length,0);
 for(let i=0;i<20;i++){sessions.send(session,{type:'app-host-port-message',data:'small'});deliver();}
 assert.equal(events.length,16);assert(events.every(e=>e.sampling==='app_host_start'));
 sessions.send(session,{type:'app-host-port-message',data:'x'.repeat(17000)});socket.sent.at(-1).callback();assert.equal(events.at(-1).sampling,'large');assert.equal(events.at(-1).wireSequence,121);
 sessions.control(session,{type:'dsh:pong',nonce:1});await new Promise(r=>setTimeout(r,110));socket.sent.at(-1).callback();assert.equal(events.at(-1).sampling,'key');assert.equal(events.at(-1).wireSequence,122);assert(events.at(-1).durationMs>=100);assert.equal(events.length,20);sessions.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {PageSessions} from '../src/page-sessions.mjs';
const identity={scope:'ai',pageId:'renderer',stableId:'tab',origin:'http://localhost:3080'};
const wire=()=>({readyState:1,bufferedAmount:0,sent:[],send(raw){this.sent.push(JSON.parse(raw));},close(){this.readyState=3;}});
test('same page keeps its port objects and replays only unacknowledged replies in order',()=>{
 const sessions=new PageSessions(),first=wire(),{session}=sessions.attach(first,identity),port={nativeSession:true};session.ports.set('port',port);
 sessions.send(session,{type:'app-host-port-message',data:1});sessions.send(session,{type:'app-host-port-message',data:2});
 sessions.detach(session,first);sessions.send(session,{type:'app-host-port-message',data:3});
 const second=wire(),resumed=sessions.attach(second,{...identity,resumeId:session.resumeId,ack:1});
 assert.equal(resumed.resumed,true);assert.equal(resumed.session.ports.get('port'),port);
 sessions.replay(session);assert.deepEqual(second.sent.map(m=>m.data),[2,3]);
 sessions.acknowledge(session,3);assert.equal(session.bytes,0);assert.equal(session.outbox.size,0);sessions.close();
});
test('transport retry cannot dispatch an accepted operation twice; gaps fail closed',()=>{
 const sessions=new PageSessions(),{session}=sessions.attach(wire(),identity);let writes=0;
 for(const seq of [1,1,2,2,1])if(sessions.accept(session,seq))writes++;
 assert.equal(writes,2);assert.throws(()=>sessions.accept(session,4),/sequence_gap/);assert.equal(session.receivedSeq,2);sessions.close();
});
test('expired or different-scope sessions cannot accept old transport messages',()=>{
 const sessions=new PageSessions(),{session}=sessions.attach(wire(),identity),resumeId=session.resumeId;
 for(const changed of [{scope:'secondary'},{pageId:'other'},{stableId:'other'},{origin:'http://localhost'}])assert.throws(()=>sessions.attach(wire(),{...identity,...changed,resumeId}),/resume_unavailable/);
 sessions.expire(session,'test');assert.throws(()=>sessions.attach(wire(),{...identity,resumeId}),/resume_unavailable/);
});
test('disconnect drops replaceable deltas but preserves RPC replies and never delays browser actions',()=>{
 const sessions=new PageSessions(),first=wire(),{session}=sessions.attach(first,identity);sessions.detach(session,first);
 sessions.send(session,{payload:{type:'mcp-notification',method:'item/agentMessage/delta'}});
 assert.equal(session.outbox.size,0);assert.equal(session.needsCatchup,true);
 assert.equal(sessions.send(session,{type:'betterCodex:browser-action',action:'download'}),false);
 sessions.send(session,{payload:{type:'mcp-response',message:{id:1,result:{ok:true}}}});assert.equal(session.outbox.size,1);sessions.close();
});
test('old socket close cannot tear down its replacement; buffers remain bounded',()=>{
 let expired=0;const sessions=new PageSessions({maxBytes:100,onExpire:()=>expired++}),first=wire(),{session}=sessions.attach(first,identity);
 const second=wire();sessions.attach(second,{...identity,resumeId:session.resumeId});assert.equal(sessions.detach(session,first),false);assert.equal(session.wire,second);
 assert.equal(sessions.send(session,{data:'x'.repeat(120)}),false);assert.equal(expired,1);assert.equal(session.outbox.size,0);
});
test('running task retains detached page session; inactive sessions expire',async()=>{
 let active=true;const sessions=new PageSessions({ttlMs:10,shouldRetain:()=>active}),first=wire(),{session}=sessions.attach(first,identity);sessions.detach(session,first);
 await new Promise(r=>setTimeout(r,25));assert.equal(session.expired,false);active=false;await new Promise(r=>setTimeout(r,25));assert.equal(session.expired,true);
});

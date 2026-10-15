import test from 'node:test';import assert from 'node:assert/strict';
import {browser,flush} from './fixtures/bulk-read-browser.mjs';
import {readExecutionMetadata,validateExecutionMetadata,EXECUTION_METADATA_PROTOCOL as protocol} from '../src/execution-metadata-control.mjs';
import {PageSessions,REPLY_STREAM_PROTOCOL} from '../src/page-sessions.mjs';
function setup(){const f=browser(()=>{throw Error('HTTP history slots occupied')});const wire=f.create();f.message(wire,{type:'hello-ack',clientId:'fixture-page',dshProtocol:'dsh-page-resume-v1',dshResumeId:'fixture-resume',dshReceivedSeq:0,dshEpoch:'fixture-epoch',dshNativeGeneration:1,dshNativeConnected:true,dshBulkReadProtocol:'dsh-bulk-read-v1',dshReplyProtocol:REPLY_STREAM_PROTOCOL,dshExecutionMetadataProtocol:protocol});return {...f,wire};}
test('real browser producer and PageSessions control consumer bypass occupied retained RPC/history receipts',async()=>{
 const f=setup(),wire=f.wire,frames=[],serverWire={readyState:1,bufferedAmount:0,send(raw,done){frames.push(JSON.parse(raw));done?.()},close(){}};
 const pages=new PageSessions({maxPumpFrames:1}),{session:page}=pages.attach(serverWire,{scope:'ai',pageId:'fixture-page',stableId:'fixture-client',origin:'https://fixture.invalid',replyProtocol:REPLY_STREAM_PROTOCOL});page.resumeId='fixture-resume';page.connectionId=wire.__dshDiagnosticId;page.diagnosticPageId='fixture';
 pages.send(page,{payload:{type:'mcp-response',message:{id:'old',result:{}}}});pages.send(page,{payload:{type:'mcp-response',message:{id:'blocked',result:{}}}});assert.equal(page.replies.rpc.writtenSeq,1);
 const pending=f.window.__DSH_READ_EXECUTION_CONTROL__('thread/read',{threadId:'11111111-1111-4111-a111-111111111111',includeTurns:false});await flush();const message=wire.sent.at(-1);assert.equal(message.type,'dsh:execution-metadata-read');assert(!Object.hasOwn(message,'dshClientSeq'));
 let calls=0;await readExecutionMetadata({message,page,wire:serverWire,epoch:'fixture-epoch',native:{state:'ready',generation:1},boundary:{async call(){calls++;return {thread:{id:message.params.threadId}}}},pages,identityGeneration:()=>0,log(){}});
 f.message(wire,frames.at(-1));const result=await pending;assert.equal(result.result.thread.id,message.params.threadId);assert.equal(calls,1);assert.equal(f.requests.length,0);assert.equal(page.replies.rpc.writtenSeq,1);assert.equal(page.receivedSeq,0);pages.cancelPump(page);
});
test('aborted or replaced control reads reject once and are never replayed onto the SDK or HTTP',async()=>{
 for(const mode of ['abort','close','identity','native-reset']){const f=setup(),controller=new AbortController();const p=f.window.__DSH_READ_EXECUTION_CONTROL__('thread/read',{threadId:'11111111-1111-4111-a111-111111111111',includeTurns:false},{signal:controller.signal});const reject=assert.rejects(p);const m=f.wire.sent.at(-1);
 if(mode==='abort')controller.abort();else if(mode==='close')f.wire.close();else if(mode==='native-reset')f.message(f.wire,{payload:{type:'codex-app-server-connection-changed',state:'disconnected'}});else f.message(f.wire,{...m,type:'dsh:execution-metadata-result',frontEpoch:'wrong',result:{}});await reject;assert.equal(f.wire.sent.filter(x=>x.type==='dsh:execution-metadata-read').length,1);assert.equal(f.requests.filter(r=>r.url.includes('/api/bulk-read')).length,0);}
});
test('control cannot execute writes, read history bodies, change config or adopt another workspace',async()=>{
 for(const [method,params] of [['turn/start',{}],['thread/resume',{}],['thread/read',{threadId:'11111111-1111-4111-a111-111111111111',includeTurns:true}],['config/read',{includeLayers:true}],['configRequirements/read',{hostId:'remote'}]])assert.throws(()=>validateExecutionMetadata(method,params));
 const f=setup(),p=f.window.__DSH_READ_EXECUTION_CONTROL__('thread/read',{threadId:'11111111-1111-4111-a111-111111111111',includeTurns:false});const rejected=assert.rejects(p);f.message(f.wire,{...f.wire.sent.at(-1),type:'dsh:execution-metadata-result',scope:'zyy',result:{}});await rejected;
});
test('server rejects changed wire, scope, epoch, Native generation and forbidden methods before any Native call',async()=>{
 for(const mutate of [m=>m.scope='zyy',m=>m.frontEpoch='other',m=>m.nativeGeneration=2,m=>m.resumeId='other',m=>m.connectionId='other',m=>m.method='turn/start']){
  const wire={readyState:1},page={scope:'ai',resumeId:'fixture-resume',connectionId:'fixture-connection',stableId:'fixture-client',wire},message={type:'dsh:execution-metadata-read',protocol,requestId:'11111111-1111-4111-a111-111111111111',scope:'ai',frontEpoch:'fixture-epoch',nativeGeneration:1,resumeId:page.resumeId,connectionId:page.connectionId,method:'thread/read',params:{threadId:'22222222-2222-4222-a222-222222222222',includeTurns:false}};mutate(message);let calls=0,result;
  await readExecutionMetadata({message,page,wire,epoch:'fixture-epoch',native:{state:'ready',generation:1},boundary:{call(){calls++;throw Error('forbidden')}},pages:{control(_page,value){result=value}},identityGeneration:()=>0,log(){}});assert.equal(calls,0);assert(result.error);assert(!Object.hasOwn(result,'result'));
 }
});

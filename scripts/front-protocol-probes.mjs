// Non-mutating protocol probes. Only synthetic invalid write targets are submitted.
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {readDeploymentConfig} from '../source/apps/native-codex-web/src/deployment-config.mjs';
const deployment=readDeploymentConfig(process.env.WORKBENCH_CONFIG);
const require=createRequire(deployment.dependencyPackage),hostRequire=createRequire(deployment.native.hostPackage);
const {RpcSession,RpcTarget}=await import(require.resolve('capnweb'));
const WS=require('ws'),codec=hostRequire(deployment.native.codecPath);
export const PROBE_CONTRACT='front-protocol-v1';
export async function verifyFrontProtocols({base,threadId,request=fetch,socketHeaders={},report={checks:[]}}){
 const sockets=new Set();let clientSeq=0,serverSeq=0;
 const transmit=(socket,message)=>socket.send(JSON.stringify({...message,dshClientSeq:++clientSeq}));
 const check=(name,ok,details={})=>{report.checks.push({name,ok:!!ok,...details});if(!ok)throw Error('Check failed: '+name);};
 const phase=value=>{report.phase=value;};
 const http=async(path,options={})=>request(base+path,{...options,signal:AbortSignal.timeout(15000)});
 const failure=(stage,error,status)=>{const text=String(error?.message||''),match=text.match(/Unexpected server response: (\d{3})/);report.protocolFailure??={phase:report.phase,stage,httpStatus:status??(match?Number(match[1]):null),code:typeof error?.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)?error.code:null,kind:/deadline/.test(text)?'timeout':match||status?'http_rejected':/closed/.test(text)?'socket_closed':'connection_error'};return error;};
 const wait=(socket,predicate)=>new Promise((resolve,reject)=>{
  const clean=()=>{clearTimeout(timer);socket.off('message',onMessage);socket.off('close',onClose);};
  const onClose=()=>{clean();reject(failure('response',Error('protocol socket closed')));};
  const onMessage=raw=>{let m;try{m=JSON.parse(raw);}catch{return;}if(predicate(m)){clean();resolve(m);}};
  const timer=setTimeout(()=>{clean();reject(failure('response',Error('protocol response deadline')));},15000);
  socket.on('message',onMessage);socket.once('close',onClose);
 });
 try{
  phase('scope-binding');const bound=await http('/dsh-scope-session?workspace=ai');check('scope binding HTTP',bound.status===200,{status:bound.status});const binding=await bound.json();check('AI scope binding',typeof binding.token==='string');
  const headers={origin:base,'content-type':'application/json','x-dsh-scope':binding.token};
  if(threadId){phase('thread-read');const response=await http('/w/ai/api/request',{method:'POST',headers,body:JSON.stringify({request:{method:'thread/read',params:{threadId,includeTurns:false}}})});check('thread read HTTP',response.ok,{status:response.status});check('thread remains readable',(await response.json()).thread?.id===threadId);}
  threadId??=randomUUID();
  const optional=await http('/w/ai/api/request',{method:'POST',headers,body:JSON.stringify({request:{method:'plugin/list'}})});check('optional capability unavailable instead of authentication error',optional.status===501,{status:optional.status});await optional.body?.cancel();
  const clientId='acceptance-'+randomUUID();
  async function open(resumeId){
   const socket=new WS(base.replace(/^http/,'ws')+'/w/ai/ws?scopeToken='+binding.token,{headers:{origin:base,...socketHeaders}});sockets.add(socket);socket.on('error',()=>{});socket.on('message',raw=>{const m=JSON.parse(raw);if(Number.isSafeInteger(m.dshPageSeq)&&m.dshPageSeq>serverSeq){serverSeq=m.dshPageSeq;socket.send(JSON.stringify({type:'dsh:ack',seq:serverSeq}));}});
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.terminate();reject(failure('connect',Error('protocol connection deadline')));},15000);socket.once('open',()=>{clearTimeout(timer);resolve();});socket.once('error',error=>{clearTimeout(timer);failure('connect',error);reject(Error('protocol connection failed'));});});
   const pending=wait(socket,m=>m.type==='hello-ack'||m.type==='dsh:resume-unavailable');socket.send(JSON.stringify({type:'hello',clientId,dshClientId:clientId,dshProtocol:'dsh-page-resume-v1',dshAck:serverSeq,...(resumeId?{dshResumeId:resumeId}:{})}));
   const hello=await pending;check('page handshake',hello.type==='hello-ack');return {socket,hello};
  }
  const close=socket=>new Promise(resolve=>{socket.once('close',resolve);socket.close();});
  phase('page-reconnect');const first=await open();await close(first.socket);const second=await open(first.hello.dshResumeId);const socket=second.socket;
  check('same page reconnect retains its identity',second.hello.dshResumed===true&&second.hello.dshResumeId===first.hello.dshResumeId);
  const ipc=async(payload,predicate)=>{const requestId=randomUUID(),pending=wait(socket,m=>predicate?predicate(m):m.type==='opencodex:ipc-result'&&m.requestId===requestId);transmit(socket,{type:'opencodex:ipc-invoke',requestId,request:{channel:'codex_desktop:message-from-view',args:[payload]}});return pending;};
  phase('host-metadata');
  for(const method of ['codex-home','home-directory','locale-info','worktree-shell-environment-config']){
   const id=randomUUID(),start=performance.now();const r=(await ipc({type:'fetch',url:'vscode://codex/'+method,requestId:id,body:JSON.stringify({hostId:'local'})},m=>m.payload?.type==='fetch-response'&&m.payload.requestId===id)).payload;
   check('host metadata '+method,r.responseType==='success'&&r.status===200,{status:r.status,durationMs:Math.round(performance.now()-start)});
  }
  for(const type of ['window-focused','view-focused','shared-object-unsubscribe'])check('notification '+type,(await ipc({type})).ok===true);
  phase('invalid-edit-validation');
  // Invalid ID intentionally uses the shared opaque-ID 404 contract. Invalid
  // extra parameters use 400. Both must be rejected before a Native write.
  for(const [name,params,status,message]of [
   ['invalid edit target',{threadId,beforeTurnId:'invalid-release-validation'},404,'Thread is not available'],
   ['invalid edit parameters',{threadId,beforeTurnId:randomUUID(),history:[]},400,'编辑历史消息的参数无效']
  ]){
   const id=randomUUID();const error=(await ipc({type:'mcp-request',hostId:'local',request:{id,method:'thread/revert',params}},m=>m.payload?.type==='mcp-response'&&m.payload.message?.id===id)).payload.message.error;
   check(name,error?.data?.status===status&&error?.code===-32000&&error?.message===message,{status:error?.data?.status,rpcCode:error?.code});
  }
  phase('app-host-contract');const portId=randomUUID(),messages=[],receivers=[];let closed=false;
  const receive=raw=>{const m=JSON.parse(raw);if(m.type!=='app-host-port-message'||m.portId!==portId)return;const data=JSON.stringify(codec.decodeMessageData(m));if(receivers.length)receivers.shift().resolve(data);else messages.push(data);};socket.on('message',receive);
  class View extends RpcTarget{get services(){return {};}}
  const rpc=new RpcSession({send:async raw=>transmit(socket,{type:'app-host-port-message',portId,...codec.encodeMessageData(JSON.parse(raw))}),receive:()=>closed?Promise.reject(Error('probe closed')):messages.length?Promise.resolve(messages.shift()):new Promise((resolve,reject)=>receivers.push({resolve,reject})),abort(){closed=true;for(const r of receivers.splice(0))r.reject(Error('probe closed'));}},new View());
  const remote=rpc.getRemoteMain();let deadline;
  try{
   await Promise.race([(async()=>{transmit(socket,{type:'app-host-connect',portId});const services=await remote.services;
    check('actual AppHost read capability',(await services.appInfo.get()).version==='26.901.51231');
    let error;try{await remote.value;}catch(e){error=e;}
    check('actual AppHost contract error classification',error?.message?.startsWith('DSH_APP_HOST_RPC_CONTRACT:'));
    // A peer may disconnect before hello while another browser exposes only
    // a partial service set. Cleanup must not terminate the shared front.
    phase('partial-view-peer-connect');
    const peer=new WS(base.replace(/^http/,'ws')+'/w/ai/ws?scopeToken='+binding.token,{headers:{origin:base,...socketHeaders}});sockets.add(peer);peer.on('error',()=>{});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{peer.terminate();reject(failure('peer-connect',Error('peer connection deadline')));},15000);peer.once('open',()=>{clearTimeout(timer);resolve();});peer.once('error',error=>{clearTimeout(timer);failure('peer-connect',error);reject(Error('peer connection failed'));});});
    phase('partial-view-peer-close');
    await close(peer);
    phase('partial-view-existing-page-read');
    const cleanupId=randomUUID();const live=(await ipc({type:'fetch',url:'vscode://codex/codex-home',requestId:cleanupId,body:'{}'},m=>m.payload?.type==='fetch-response'&&m.payload.requestId===cleanupId)).payload;
    check('partial-view peer disconnect preserves the existing AppHost',live.responseType==='success'&&live.status===200);
    phase('partial-view-existing-app-host');
    check('AppHost remains callable after peer cleanup',(await services.appInfo.get()).version==='26.901.51231');

   })(),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(failure('app-host',Error('AppHost verification deadline'))),15000);})]);
  }finally{clearTimeout(deadline);remote[Symbol.dispose]();socket.off('message',receive);closed=true;for(const r of receivers.splice(0))r.reject(Error('probe closed'));}
  // Retire only this probe's retained page; closing a socket alone leaves
  // its partial View.services alive for the page-resume retention window.
  phase('probe-session-cleanup');
  const expired=wait(socket,m=>m.type==='dsh:resume-unavailable'&&m.reason==='page_protocol_error');
  const pageClosed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(failure('cleanup',Error('probe cleanup deadline'))),15000);socket.once('close',()=>{clearTimeout(timer);resolve();});});
  socket.send(JSON.stringify({type:'opencodex:ipc-invoke',dshClientSeq:clientSeq+2,requestId:'probe-expire-gap',request:{}}));
  await expired;await pageClosed;check('probe retained page is explicitly retired',true);
  const after=await http('/dsh-scope-session?workspace=ai');check('front still serves after probe teardown',after.status===200);await after.body?.cancel();
  report.protocolContract=PROBE_CONTRACT;report.phase='passed';return report;
 }catch(error){throw failure('contract',error);}finally{for(const socket of sockets)socket.terminate();}
}

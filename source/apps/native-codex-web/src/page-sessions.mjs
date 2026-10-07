import {randomBytes} from 'node:crypto';
import {rpcDiagnosticContext,errorDiagnosticFields} from './connection-diagnostics.mjs';

export const PAGE_RESUME_PROTOCOL='dsh-page-resume-v1';
export const REPLY_STREAM_PROTOCOL='dsh-reply-stream-v1';
const replyStreams=['rpc','app-host'];
const replyState=()=>({outbox:new Map(),sentSeq:0,ackedSeq:0,writtenSeq:0,inflightBytes:0});
// Retain the existing AppHost RPC session across a phone's socket replacement.
// A transport sequence is acknowledged BEFORE dispatch, so reconnecting the
// same in-memory session cannot dispatch a prompt or approval a second time.
// After process loss/expiry we refuse transport replay; the native task lives
// independently and the user can still recover its authoritative history.
export class PageSessions {
 constructor({onExpire=()=>{},shouldRetain=()=>false,onWireEvent=null,ttlMs=30*60*1000,maxSessions=32,maxBytes=32*1024*1024,maxFrames=4096,maxWireBytes=256*1024,maxPumpFrames=32}={}){
  Object.assign(this,{onExpire,shouldRetain,onWireEvent,ttlMs,maxSessions,maxBytes,maxFrames});this.maxWireBytes=Math.max(1,Math.min(maxBytes,maxWireBytes));this.maxPumpFrames=Math.max(1,Math.min(maxFrames,maxPumpFrames));this.sessions=new Map();
 }
 attach(socket,{scope,pageId,stableId,origin,resumeId,ack=0,replyProtocol,replyAck={}}){
  let session=resumeId?this.sessions.get(resumeId):null;
  if(resumeId&&(!session||session.scope!==scope||session.pageId!==pageId||session.stableId!==stableId||session.origin!==origin))throw Error('page_resume_unavailable');
  const resumed=!!session;
  // Validate before allocating a slot or touching the retained transport. A
  // failed first hello has no detach timer and must not leave an orphan here.
  if(!Number.isSafeInteger(ack)||ack<0||ack>(session?.sentSeq??0))throw Error('page_ack_invalid');
  if(session?.replyProtocol&&replyProtocol!==session.replyProtocol)throw Error('page_resume_unavailable');
  for(const stream of replyStreams){const seq=replyAck[stream]??0;if(!Number.isSafeInteger(seq)||seq<0||seq>(session?.replies?.[stream]?.sentSeq??0))throw Error('page_ack_invalid');}
  if(!session){
   if(this.sessions.size>=this.maxSessions)throw Error('page_session_limit');
   session={scope,pageId,stableId,origin,resumeId:randomBytes(24).toString('base64url'),ports:new Map(),wire:null,outbox:new Map(),bytes:0,sentSeq:0,ackedSeq:0,receivedSeq:0,writtenSeq:0,inflightBytes:0,pumpHandle:null,pumping:false,timer:null,expired:false};
   session.replyProtocol=replyProtocol===REPLY_STREAM_PROTOCOL?REPLY_STREAM_PROTOCOL:null;session.replies=Object.fromEntries(replyStreams.map(stream=>[stream,replyState()]));
   Object.defineProperty(session,'readyState',{get(){return this.wire?.readyState??3;}});
   Object.defineProperty(session,'bufferedAmount',{get(){return this.wire?.bufferedAmount??0;}});
   session.close=(code,reason)=>session.wire?.close(code,reason);
   this.sessions.set(session.resumeId,session);
  }
  this.acknowledge(session,ack,{flush:false});this.cancelPump(session);
  for(const stream of replyStreams)this.acknowledgeReply(session,stream,replyAck[stream]??0,{flush:false});
  clearTimeout(session.timer);session.timer=null;
  const previous=session.wire;session.wire=socket;session.writtenSeq=session.ackedSeq;session.inflightBytes=0;
  for(const lane of Object.values(session.replies)){lane.writtenSeq=lane.ackedSeq;lane.inflightBytes=0;}
  if(previous&&previous!==socket)previous.close(4001,'connection replaced');
  return {session,resumed};
 }
 acknowledgeReply(session,stream,seq,{flush=true}={}){
  const lane=replyStreams.includes(stream)?session.replies?.[stream]:null;if(!lane||!Number.isSafeInteger(seq)||seq<0||seq>lane.sentSeq)throw Error('page_ack_invalid');
  if(seq<=lane.ackedSeq)return;lane.ackedSeq=seq;
  for(const [id,frame]of lane.outbox){if(id>seq)break;session.bytes-=frame.bytes;if(id<=lane.writtenSeq)lane.inflightBytes=Math.max(0,lane.inflightBytes-frame.bytes);lane.outbox.delete(id);}
  lane.writtenSeq=Math.max(lane.writtenSeq,seq);if(flush)this.pump(session);
 }
 pendingFrames(session){return session.outbox.size+Object.values(session.replies||{}).reduce((sum,lane)=>sum+lane.outbox.size,0);}
 replyStream(message){const type=message.payload?.type||message.type;return ['app-host-port-connected','app-host-port-message'].includes(type)?'app-host':['mcp-response','fetch-response','opencodex:ipc-result','codex-app-server-initialized','codex-app-server-connection-changed'].includes(type)?'rpc':null;}
 acknowledge(session,seq,{flush=true}={}){
  if(!Number.isSafeInteger(seq)||seq<0||seq>session.sentSeq)throw Error('page_ack_invalid');
  if(seq<=session.ackedSeq)return;
  session.ackedSeq=seq;
  for(const [id,frame] of session.outbox){if(id>seq)break;session.bytes-=frame.bytes;if(id<=session.writtenSeq)session.inflightBytes=Math.max(0,(session.inflightBytes||0)-frame.bytes);session.outbox.delete(id);}
  session.writtenSeq=Math.max(session.writtenSeq,seq);if(flush)this.pump(session);
 }
 accept(session,seq){
  if(!Number.isSafeInteger(seq)||seq<1)throw Error('page_sequence_invalid');
  if(seq<=session.receivedSeq)return false;
  if(seq!==session.receivedSeq+1)throw Error('page_sequence_gap');
  session.receivedSeq=seq;return true;
 }
 // A send callback means Node handed the frame to its socket, not phone receipt.
 // Capture the current wire identity before the async callback: a retained page
 // may already have a different connection when an old write completes.
 write(session,raw,metadata={}){
  const wire=session.wire;
  const completed=error=>{if(session.wire!==wire||session.expired)return;if(error){wire.close(1013,'connection write failed');return;}this.schedulePump(session,wire);};
  if(!this.onWireEvent){wire.send(raw,completed);return;}
  const started=performance.now(),context={component:'page-ws',...rpcDiagnosticContext({scope:session.scope,connectionId:session.connectionId,pageId:session.diagnosticPageId}),...metadata,wireSequence:wire.dshWireSequence=(wire.dshWireSequence||0)+1,payloadBytes:Buffer.byteLength(raw)};
  // Preserve the ordinal for all frames, but do not rotate away an incident by
  // logging every fast streaming delta/pong. Small AppHost bootstrap replies are
  // bounded per wire; every large frame or slow/failed callback remains visible.
  const appHostStart=metadata.frameKind==='app-host-port-message'&&(wire.dshAppHostFrames=(wire.dshAppHostFrames||0)+1)<=8;
  const sampling=['mcp-response','fetch-response','persisted-atom-sync'].includes(metadata.frameKind)?'key':context.payloadBytes>=16*1024?'large':appHostStart?'app_host_start':null;
  const record=(stage,error,mode=sampling)=>{try{this.onWireEvent({...context,stage,sampling:mode,durationMs:Math.max(0,Math.round(performance.now()-started)),bufferedBytes:wire.bufferedAmount??0,senderQueueFrames:wire._sender?._queue?.length,outboxBytes:session.bytes,pendingFrames:this.pendingFrames(session),...(error?errorDiagnosticFields(error):{})});}catch{}};
  if(sampling)record('wire_queued');
  try{wire.send(raw,error=>{if(error||sampling||performance.now()-started>=100)record(error?'wire_failed':'wire_sent',error,sampling||(error?'failure':'slow'));completed(error);});}catch(error){record('wire_failed',error,sampling||'failure');throw error;}
 }
 wireMetadata(message){
  const type=message.payload?.type||message.type;
  const frameKind=['mcp-response','mcp-notification','mcp-request','fetch-response','persisted-atom-sync','app-host-port-message','opencodex:ipc-result','dsh:sync-state','hello-ack','dsh:pong'].includes(type)?type:'other';
  const id=type==='mcp-response'?message.payload?.message?.id:type==='fetch-response'?message.payload?.requestId:type==='opencodex:ipc-result'?message.requestId:undefined;
  return {frameKind,...rpcDiagnosticContext({id})};
 }
 control(session,message){if(session.readyState!==1)return false;this.write(session,JSON.stringify(message),this.wireMetadata(message));return true;}
 cancelPump(session){if(session.pumpHandle)clearImmediate(session.pumpHandle);session.pumpHandle=null;}
 schedulePump(session,wire=session.wire){if(session.expired||session.wire!==wire||session.readyState!==1||session.pumpHandle||session.writtenSeq>=session.sentSeq&&Object.values(session.replies||{}).every(lane=>lane.writtenSeq>=lane.sentSeq))return;session.pumpHandle=setImmediate(()=>{session.pumpHandle=null;if(session.wire===wire)this.pump(session);});session.pumpHandle.unref?.();}
 pumpReplies(session,wire){
  if(!session.replyProtocol)return;
  for(const stream of replyStreams){const lane=session.replies[stream];let count=0;
   while(session.wire===wire&&session.readyState===1&&count<this.maxPumpFrames){const seq=lane.writtenSeq+1,frame=lane.outbox.get(seq);if(!frame)break;
    if(session.bufferedAmount>this.maxBytes){session.close(1013,'connection backpressure');break;}
    if(session.bufferedAmount>0&&session.bufferedAmount+frame.bytes>this.maxWireBytes)break;
    const inflight=lane.writtenSeq-lane.ackedSeq;if(inflight>=this.maxPumpFrames||inflight>0&&lane.inflightBytes+frame.bytes>this.maxWireBytes)break;
    lane.writtenSeq=seq;lane.inflightBytes+=frame.bytes;count++;this.write(session,frame.raw,{...frame.metadata,sequence:seq,replayed:seq<=lane.replayThrough});
   }
  }
 }
 pump(session){
  if(session.expired||session.readyState!==1||session.pumping)return;
  const wire=session.wire;session.pumping=true;let frames=0;
  try{this.pumpReplies(session,wire);while(session.wire===wire&&session.readyState===1&&frames<this.maxPumpFrames){
   const sequence=session.writtenSeq+1,frame=session.outbox.get(sequence);if(!frame)break;
   if(session.bufferedAmount>this.maxBytes){session.close(1013,'connection backpressure');break;}
   // One large reply can progress on an empty wire. Smaller replies share a
   // bounded window; a new reply never bypasses older unsubmitted sequences.
   if(session.bufferedAmount>0&&session.bufferedAmount+frame.bytes>this.maxWireBytes)break;
   // Socket callbacks are not page receipt. Bound all unacknowledged
   // frames, including replay, so a slow phone cannot queue megabytes ahead
   // of control pongs and the new Native readiness snapshot.
   const inflight=session.writtenSeq-session.ackedSeq;
   if(inflight>=this.maxPumpFrames||inflight>0&&(session.inflightBytes||0)+frame.bytes>this.maxWireBytes)break;
   session.writtenSeq=sequence;session.inflightBytes=(session.inflightBytes||0)+frame.bytes;frames++;this.write(session,frame.raw,{...frame.metadata,sequence,replayed:sequence<=session.replayThrough});
  }}finally{session.pumping=false;}
  if(frames===this.maxPumpFrames)this.schedulePump(session,wire);
 }
 replay(session){session.replayThrough=session.sentSeq;for(const lane of Object.values(session.replies||{}))lane.replayThrough=lane.sentSeq;this.pump(session);}
 send(session,message){
  if(session.expired)return false;
  // Streaming deltas are replaced by a native read on return, not an unbounded
  // overnight buffer. RPC replies/port frames must keep their original order.
  const reservedFrames=Math.max(1,Math.min(128,Math.floor(this.maxFrames/4)));
  if((session.readyState!==1||session.bytes>Math.min(this.maxBytes/4,2*1024*1024)||this.pendingFrames(session)>=this.maxFrames-reservedFrames)&&message.payload?.type==='mcp-notification'){session.needsCatchup=true;return true;}
  // Clipboard/download requests are user gestures, never delayed background work.
  if(session.readyState!==1&&message.type==='dsh:browser-action')return false;
  // Inbound commands retain one original sequence and writer. Only outbound
  // replies are independent of display replay, with their own receipt window.
  const stream=session.replyProtocol?this.replyStream(message):null,lane=stream?session.replies[stream]:session;
  const raw=JSON.stringify({...message,...(stream?{dshReplyStream:stream,dshReplySeq:lane.sentSeq+1}:{dshPageSeq:session.sentSeq+1})}),bytes=Buffer.byteLength(raw);
  if(session.bytes+bytes>this.maxBytes||this.pendingFrames(session)>=this.maxFrames){this.expire(session,'page_buffer_full');return false;}
  const metadata=this.wireMetadata(message);lane.sentSeq++;lane.outbox.set(lane.sentSeq,{raw,bytes,metadata});session.bytes+=bytes;
  if(session.readyState===1)this.pump(session);
  return true;
 }
 detach(session,socket){
  if(session.wire!==socket||session.expired)return false;
  this.cancelPump(session);session.wire=null;session.needsCatchup=true;
  const expireIdle=()=>{if(this.shouldRetain(session)){session.timer=setTimeout(expireIdle,this.ttlMs);session.timer.unref?.();}else this.expire(session,'page_session_expired');};
  session.timer=setTimeout(expireIdle,this.ttlMs);session.timer.unref?.();return true;
 }
 expire(session,reason){
  if(session.expired)return;session.expired=true;clearTimeout(session.timer);this.cancelPump(session);
  this.control(session,{type:'dsh:resume-unavailable',reason});session.close(4009,reason);
  this.sessions.delete(session.resumeId);session.outbox.clear();for(const lane of Object.values(session.replies||{}))lane.outbox.clear();session.bytes=0;this.onExpire(session);
 }
 close(){for(const session of [...this.sessions.values()])this.expire(session,'front_stopped');}
}

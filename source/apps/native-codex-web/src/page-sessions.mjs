import {randomBytes} from 'node:crypto';

export const PAGE_RESUME_PROTOCOL='betterCodex-page-resume-v1';
// Retain the existing AppHost RPC session across a phone's socket replacement.
// A transport sequence is acknowledged BEFORE dispatch, so reconnecting the
// same in-memory session cannot dispatch a prompt or approval a second time.
// After process loss/expiry we refuse transport replay; the native task lives
// independently and the user can still recover its authoritative history.
export class PageSessions {
 constructor({onExpire=()=>{},shouldRetain=()=>false,ttlMs=30*60*1000,maxSessions=32,maxBytes=32*1024*1024,maxFrames=4096}={}){
  Object.assign(this,{onExpire,shouldRetain,ttlMs,maxSessions,maxBytes,maxFrames});this.sessions=new Map();
 }
 attach(socket,{scope,pageId,stableId,origin,resumeId,ack=0}){
  let session=resumeId?this.sessions.get(resumeId):null;
  if(resumeId&&(!session||session.scope!==scope||session.pageId!==pageId||session.stableId!==stableId||session.origin!==origin))throw Error('page_resume_unavailable');
  const resumed=!!session;
  if(!session){
   if(this.sessions.size>=this.maxSessions)throw Error('page_session_limit');
   session={scope,pageId,stableId,origin,resumeId:randomBytes(24).toString('base64url'),ports:new Map(),wire:null,outbox:new Map(),bytes:0,sentSeq:0,ackedSeq:0,receivedSeq:0,timer:null,expired:false};
   Object.defineProperty(session,'readyState',{get(){return this.wire?.readyState??3;}});
   Object.defineProperty(session,'bufferedAmount',{get(){return this.wire?.bufferedAmount??0;}});
   session.close=(code,reason)=>session.wire?.close(code,reason);
   this.sessions.set(session.resumeId,session);
  }
  this.acknowledge(session,ack);
  clearTimeout(session.timer);session.timer=null;
  const previous=session.wire;session.wire=socket;
  if(previous&&previous!==socket)previous.close(4001,'connection replaced');
  return {session,resumed};
 }
 acknowledge(session,seq){
  if(!Number.isSafeInteger(seq)||seq<0||seq>session.sentSeq)throw Error('page_ack_invalid');
  if(seq<=session.ackedSeq)return;
  session.ackedSeq=seq;
  for(const [id,frame] of session.outbox){if(id>seq)break;session.bytes-=frame.bytes;session.outbox.delete(id);}
 }
 accept(session,seq){
  if(!Number.isSafeInteger(seq)||seq<1)throw Error('page_sequence_invalid');
  if(seq<=session.receivedSeq)return false;
  if(seq!==session.receivedSeq+1)throw Error('page_sequence_gap');
  session.receivedSeq=seq;return true;
 }
 control(session,message){if(session.readyState!==1)return false;session.wire.send(JSON.stringify(message));return true;}
 replay(session){for(const frame of session.outbox.values()){if(session.readyState!==1)break;session.wire.send(frame.raw);}}
 send(session,message){
  if(session.expired)return false;
  // Streaming deltas are replaced by a native read on return, not an unbounded
  // overnight buffer. RPC replies/port frames must keep their original order.
  if((session.readyState!==1||session.bytes>Math.min(this.maxBytes/4,2*1024*1024))&&message.payload?.type==='mcp-notification'){session.needsCatchup=true;return true;}
  // Clipboard/download requests are user gestures, never delayed background work.
  if(session.readyState!==1&&message.type==='betterCodex:browser-action')return false;
  const raw=JSON.stringify({...message,betterCodexPageSeq:session.sentSeq+1}),bytes=Buffer.byteLength(raw);
  if(session.bytes+bytes>this.maxBytes||session.outbox.size>=this.maxFrames){this.expire(session,'page_buffer_full');return false;}
  session.sentSeq++;session.outbox.set(session.sentSeq,{raw,bytes});session.bytes+=bytes;
  if(session.readyState===1){
   if(session.bufferedAmount>this.maxBytes)session.close(1013,'connection backpressure');
   else session.wire.send(raw);
  }
  return true;
 }
 detach(session,socket){
  if(session.wire!==socket||session.expired)return false;
  session.wire=null;session.needsCatchup=true;
  const expireIdle=()=>{if(this.shouldRetain(session)){session.timer=setTimeout(expireIdle,this.ttlMs);session.timer.unref?.();}else this.expire(session,'page_session_expired');};
  session.timer=setTimeout(expireIdle,this.ttlMs);session.timer.unref?.();return true;
 }
 expire(session,reason){
  if(session.expired)return;session.expired=true;clearTimeout(session.timer);
  this.control(session,{type:'betterCodex:resume-unavailable',reason});session.close(4009,reason);
  this.sessions.delete(session.resumeId);session.outbox.clear();session.bytes=0;this.onExpire(session);
 }
 close(){for(const session of [...this.sessions.values()])this.expire(session,'front_stopped');}
}

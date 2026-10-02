import {randomUUID} from 'node:crypto';
import {SCOPES} from './registry.mjs';
import {OUTBOX_BUDGET} from './sync-outbox.mjs';

// The existing derived publication outbox is fronted by bounded RAM. Cloud
// ACKs retire RAM; its optional disk mirror runs in the cache worker. Native's
// command Journal retains its original durable semantics.
export class MemoryOutbox {
 constructor(service,state={}){
  this.service=service;this.limits={...OUTBOX_BUDGET,...state.limits};this.epoch=state.epoch||randomUUID();this.sequence=state.sequence||0;this.ack=state.ack||0;this.rows=new Map((state.rows||[]).map(r=>[r.seq,r]));this.bytes=[...this.rows.values()].reduce((n,r)=>n+r.bytes,0);this.oldestAt=this.rows.size?Date.now():0;this.freeBytes=state.stats?.freeBytes??0;this.deferred=new Map();this.deferrals=new Map();
  for(const scope of SCOPES)if(service.metadata.get('outbox-rebuild:'+scope))this.deferred.set(scope,service.metadata.get('outbox-rebuild:'+scope));
 }
 stats(){return {bytes:this.bytes,frames:this.rows.size,oldestAgeMs:this.oldestAt?Date.now()-this.oldestAt:0,oldestAgeKnown:true,freeBytes:this.freeBytes,persistence:this.service.healthy?'disk-mirror':'memory',mirrorPendingBytes:this.service.pendingBytes};}
 pressure(s=this.stats()){return s.bytes>=this.limits.maxBytes||s.frames>=this.limits.maxFrames||s.oldestAgeMs>=this.limits.maxAgeMs;}
 defer(scopes){for(const scope of new Set(scopes)){if(!SCOPES.includes(scope))continue;this.deferrals.set(scope,(this.deferrals.get(scope)||0)+1);if(!this.deferred.has(scope)){const marker=randomUUID();this.deferred.set(scope,marker);this.service.setMeta('outbox-rebuild:'+scope,marker);}}}
 rebuildToken(scope){const marker=this.deferred.get(scope);return marker?marker+':'+(this.deferrals.get(scope)||0):null;}
 finishRebuild(scope,token){if(this.rebuildToken(scope)!==token)return false;this.deferred.delete(scope);this.service.setMeta('outbox-rebuild:'+scope,'');return true;}
 appendBatch(values,persist){
  if(!values.length)return [];
  const frames=values.map((value,index)=>({...value,type:'publish',epoch:this.epoch,seq:this.sequence+index+1}));
  const rows=frames.map(frame=>{const raw=JSON.stringify(frame);return {seq:frame.seq,raw,bytes:Buffer.byteLength(raw)};});
  if(this.pressure()||rows.some(r=>r.bytes>64*1024*1024)||this.bytes+rows.reduce((n,r)=>n+r.bytes,0)>this.limits.maxBytes||this.rows.size+rows.length>this.limits.maxFrames)throw Object.assign(Error('projection outbox capacity reached'),{code:'OUTBOX_CAPACITY'});
  for(const row of rows){this.rows.set(row.seq,row);this.bytes+=row.bytes;}if(!this.oldestAt)this.oldestAt=Date.now();this.sequence=frames.at(-1).seq;
  this.service.background('outbox.persist',[frames]);persist?.();return frames;
 }
 append(value){return this.appendBatch([value])[0];}
 entries({after=this.ack,limit=128,maxBytes=8*1024*1024}={}){
  if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>128||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>8*1024*1024)throw Error('invalid outbox window');
  const out=[];let bytes=0;for(const row of this.rows.values()){if(row.seq<=after)continue;if(out.length&&(out.length>=limit||bytes+row.bytes>maxBytes))break;out.push(row);bytes+=row.bytes;}return out;
 }
 acknowledge(seq){if(!Number.isSafeInteger(seq)||seq<this.ack||seq>this.sequence)throw Error('invalid projection ACK');if(seq===this.ack)return;for(const[key,row]of this.rows){if(key>seq)break;this.rows.delete(key);this.bytes-=row.bytes;}this.ack=seq;if(!this.rows.size)this.oldestAt=0;this.service.background('outbox.ack',[seq]);}
 close(){return this.service.finishOutbox(!this.deferred.size);}
}

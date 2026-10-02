import {createHash,randomUUID} from 'node:crypto';
import {SCOPES} from './registry.mjs';

// The public read view has one version namespace for catalog, cached pages and
// direct Native pages. It is a disposable projection, never execution state.
// This prevents a provisional SQL-free stamp from failing existing clients'
// catalog fences or colliding with the shared front's SQLite revision counter.
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const heavy=new Set(['history','turn','item','readAlias']);
export class CacheView {
 constructor({epoch,nativeGeneration,state,versions=[]}){
  this.generation='view:'+epoch;this.nativeGeneration=nativeGeneration;this.sequence=0;this.rows=new Map();this.bytes=0;this.threads=new Map();
  if(state?.generation===this.generation&&state.nativeGeneration===nativeGeneration){
   this.sequence=state.sequence;for(const [key,value]of state.rows||[])this.rows.set(key,{...value,record:null});for(const [key,value]of state.threads||[])this.threads.set(key,value);
  }
  for(const v of versions){const key=v.scope+':'+v.thread_id;if(!this.threads.has(key))this.threads.set(key,{original:v.generation,version:v.generation===nativeGeneration?this.generation:randomUUID()});}
 }
 thread(scope,id){const key=scope+':'+id;if(!this.threads.has(key))this.threads.set(key,{original:this.nativeGeneration,version:this.generation});return this.threads.get(key);}
 rewritten(id){for(const scope of SCOPES){const t=this.thread(scope,id);t.version=randomUUID();t.pending=true;}this.invalidate(id);}
 originalVersion(scope,id,original){const t=this.thread(scope,id);if(t.original!==original){if(!t.pending)t.version=randomUUID();t.original=original;t.pending=false;}return t.version;}
 invalidate(id){for(const value of this.rows.values())if(value.threadId===id)value.sourceOnly=false;}
 project(input,{sourceOnly=false,force=false}={}){
  if(!input)return null;
  const key=JSON.stringify([input.scope,input.key]),fingerprint=hash([input.payload,!!input.deleted]);
  const old=this.rows.get(key),isHeavy=heavy.has(input.kind),thread=this.thread(input.scope,input.threadId);
  let generation=thread.version;
  if(!sourceOnly&&isHeavy)generation=this.originalVersion(input.scope,input.threadId,input.generation);
  const origin=sourceOnly?null:JSON.stringify([input.sourceGeneration,input.generation,input.revision]);
  // A slow mirror of an earlier read cannot overwrite the newer verified page
  // while no Native event has invalidated that newer observation.
  if(!sourceOnly&&isHeavy&&old?.sourceOnly&&old.fingerprint!==fingerprint)return null;
  if(!force&&old&&old.fingerprint===fingerprint&&old.generation===generation&&(sourceOnly||old.sourceOnly||old.origin===origin)){
   const record={...input,sourceGeneration:this.generation,generation,revision:old.revision,confirmedAt:old.confirmedAt};delete record.source;delete record.sourceOnly;
   if(old.record)this.bytes-=old.bytes||0;Object.assign(old,{record,bytes:input.bytes||0,sourceOnly:old.sourceOnly||sourceOnly,origin});this.bytes+=old.bytes;this.bound();return record;
  }
  const record={...input,sourceGeneration:this.generation,generation,revision:++this.sequence};delete record.source;delete record.sourceOnly;
  if(old?.record)this.bytes-=old.bytes||0;
  this.rows.delete(key);this.rows.set(key,{record,bytes:input.bytes||0,fingerprint,origin,sourceOnly,generation,revision:record.revision,confirmedAt:record.confirmedAt,threadId:input.threadId});this.bytes+=input.bytes||0;this.bound();return record;
 }
 current(scope,key){const v=this.rows.get(JSON.stringify([scope,key]));return v?.sourceOnly?v.record:null;}
 bound(){
  for(const [key,v]of this.rows){if(this.rows.size<=4096&&this.bytes<=64*1024*1024)break;if(!heavy.has(v.record?.kind))continue;this.bytes-=v.record?v.bytes||0:0;this.rows.delete(key);}
  while(this.rows.size>8192||this.bytes>64*1024*1024){const key=this.rows.keys().next().value,v=this.rows.get(key);this.bytes-=v.record?v.bytes||0:0;this.rows.delete(key);}
  while(this.threads.size>4096)this.threads.delete(this.threads.keys().next().value);
 }
 checkpoint(){return {generation:this.generation,nativeGeneration:this.nativeGeneration,sequence:this.sequence,threads:[...this.threads],rows:[...this.rows].map(([key,v])=>[key,{fingerprint:v.fingerprint,origin:v.origin,sourceOnly:false,generation:v.generation,revision:v.revision,confirmedAt:v.confirmedAt,threadId:v.threadId}])};}
}

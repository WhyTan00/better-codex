import {createHash,randomUUID} from 'node:crypto';

const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])):value;
const changed=()=>Object.assign(Error('应用目录版本已更换，请重新读取'),{code:503});
const catalogFingerprint=params=>{
 if(!Array.isArray(params?.data)||!params.data.every(app=>app&&typeof app==='object'&&!Array.isArray(app)&&typeof app.id==='string'&&typeof app.name==='string'))return null;
 try{return createHash('sha256').update(JSON.stringify(canonical(params.data))).digest('hex');}catch{return null;}
};

// This is a display catalogue, never an execution, permission or account cache.
// A conditional response proves a complete page for the exact scope/parameters.
export class AppCatalogCache {
 constructor({read,now=Date.now,ttlMs=300000,maxPages=64,maxBytes=32*1024*1024}){
  Object.assign(this,{read,now,ttlMs,maxPages,maxBytes});this.identity=randomUUID();this.generation=0;this.catalogVersion=0;this.catalogFingerprint=null;this.pages=new Map();this.pending=new Map();this.states=new Map();this.bytes=0;
 }
 invalidate(){this.generation++;this.catalogVersion++;this.catalogFingerprint=null;this.pages.clear();this.pending.clear();this.states.clear();this.bytes=0;}
 // A catalogue event changes display data, not the account or Native identity.
 // Existing reads may finish, but cannot validate/cache the old snapshot. New
 // callers must not join those reads. Identity changes still use invalidate().
 // Native also broadcasts a complete, unchanged snapshot on a first-page read.
 // Only a known equal snapshot can be a no-op. Unknown data resets the baseline;
 // the first valid snapshot still invalidates reads already in flight.
 invalidateCatalog(params){const fingerprint=catalogFingerprint(params);if(fingerprint!==null&&fingerprint===this.catalogFingerprint)return;this.catalogFingerprint=fingerprint;this.catalogVersion++;this.pages.clear();this.pending.clear();this.bytes=0;for(const [key,state]of this.states)if(!state.readers)this.states.delete(key);}
 drop(key){const old=this.pages.get(key);if(old){this.pages.delete(key);this.bytes-=old.bytes;}const state=this.states.get(key);if(state&&!state.readers)this.states.delete(key);}
 async response(scope,params,{ifNoneMatch=null,fresh=false,diagnostic}={}){
  const keyParams={...params};delete keyParams.forceRefetch;
  const key=JSON.stringify([scope,canonical(keyParams)]),force=fresh||params.forceRefetch===true;
  const freshKey='fresh:'+key,normalKey='read:'+key;
  let pending=this.pending.get(freshKey)??(!force?this.pending.get(normalKey):null);
  let state=this.states.get(key);if(!state){state={revision:0,readers:0};this.states.set(key,state);}
  // Explicit refresh replaces only this exact page. It must not reject a
  // different workspace/page or erase the pages just fetched by the renderer.
  if(force&&!pending){state.revision++;const old=this.pages.get(key);if(old){this.pages.delete(key);this.bytes-=old.bytes;}this.pending.delete(normalKey);}
  let entry=!force?this.pages.get(key):null;
  if(entry&&this.now()-entry.at>=this.ttlMs){this.pages.delete(key);this.bytes-=entry.bytes;entry=null;}
  if(!entry){
   if(!pending){
    const generation=this.generation,catalogVersion=this.catalogVersion,revision=state.revision,pendingKey=force?freshKey:normalKey;state.readers++;
    pending=Promise.resolve().then(()=>this.read(force?{...params,forceRefetch:true}:params,diagnostic)).then(result=>{
     if(generation!==this.generation||revision!==state.revision)throw changed();
     if(!result||!Array.isArray(result.data)||(result.nextCursor!=null&&typeof result.nextCursor!=='string'))throw Object.assign(Error('应用目录响应格式无效'),{code:502});
     const serialized=JSON.stringify(result),bytes=Buffer.byteLength(serialized),value=JSON.parse(serialized);
     const etag='"'+createHash('sha256').update(JSON.stringify([this.identity,generation,catalogVersion,key])).update(serialized).digest('hex')+'"';
     const current={value,etag,bytes,at:this.now(),generation,catalogVersion,state,revision};
     if(catalogVersion===this.catalogVersion&&bytes<=this.maxBytes){
      const old=this.pages.get(key);if(old){this.pages.delete(key);this.bytes-=old.bytes;}
      this.pages.set(key,current);this.bytes+=bytes;
      while(this.pages.size>this.maxPages||this.bytes>this.maxBytes)this.drop(this.pages.keys().next().value);
     }
     return current;
    }).finally(()=>{if(this.pending.get(pendingKey)===pending)this.pending.delete(pendingKey);state.readers--;if(!state.readers&&!this.pages.has(key)&&this.states.get(key)===state)this.states.delete(key);});
    this.pending.set(pendingKey,pending);
   }
   entry=await pending;
  }else{this.pages.delete(key);this.pages.set(key,entry);}
  if(entry.generation!==this.generation||entry.revision!==entry.state.revision)throw changed();
  if(!force&&entry.catalogVersion===this.catalogVersion&&ifNoneMatch===entry.etag)return {status:304,etag:entry.etag};
  return {status:200,etag:entry.etag,result:structuredClone(entry.value)};
 }
}

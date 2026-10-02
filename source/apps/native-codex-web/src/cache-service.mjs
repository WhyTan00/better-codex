import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {nativeReadKey,normalizeReadParams,nativeCacheReads,catalogEntry} from './native-read-cache.mjs';
import {workspace,validateId,fail} from './registry.mjs';
import {checkReadInterest,withReadInterest,MAX_SOURCE_PAYLOAD_BYTES} from './native-read-delivery.mjs';
import {MemoryOutbox} from './memory-outbox.mjs';
import {CacheView} from './cache-view.mjs';

export const CACHE_SERVICE_BUDGET={lookupMs:50,maxPendingBytes:64*1024*1024,maxPendingCalls:256};
const observedMethods=new Set(['thread/started','thread/name/updated','thread/status/changed','thread/archived','thread/unarchived','thread/reverted','turn/started','turn/completed']);
const invalidatingMethods=new Set(['thread/reverted','thread/archived','thread/unarchived','turn/started','turn/completed']);
const workerReads=new Set(['thread/read','thread/turns/list','thread/items/list','thread/list']);

export class CacheService {
 constructor({dir,boundary,budget,WorkerClass=Worker}){
  Object.assign(this,{dir,boundary});this.pending=new Map();this.pendingBytes=0;this.metadata=new Map();this.memo=new Map();this.versions=new Map();this.invalidations=new Map();this.catalogSessions=new Map();this.directLoads=new Map();this.usedHeads=new Map();this.warmHeads=new Set();this.noted=new WeakSet();this.sourceGeneration='source:'+randomUUID();this.sourceRevision=0;this.nextId=0;this.healthy=true;
  this.worker=new WorkerClass(new URL('./cache-thread.mjs',import.meta.url),{workerData:{dir,budget}});
  this.initialized=new Promise(resolve=>this.initialize=resolve);
  this.worker.on('message',m=>this.message(m));this.worker.on('error',()=>this.fail());this.worker.on('exit',()=>{if(!this.closed)this.fail();});
 }
 static async create(options){const service=new CacheService(options);await service.initialized;service.outbox=new MemoryOutbox(service,service.outboxState);service.view??=new CacheView({epoch:service.outbox.epoch,nativeGeneration:service.nativeGeneration||service.generation});service.generation=service.sourceGeneration=service.view.generation;return service;}
 message(m){
  if(m.type==='ready'){this.nativeGeneration=m.generation;this.view=new CacheView({epoch:m.outbox.epoch,nativeGeneration:m.generation,state:m.viewState,versions:m.versions});this.generation=this.sourceGeneration=this.view.generation;this.metadata=new Map(Object.entries(m.meta));for(const r of m.bootstrap)this.memo.set(JSON.stringify([r.scope,r.key]),this.project(r));this.outboxState=m.outbox;this.setMeta('cloud-record-cursor',0);this.initialize();return;}
  if(m.type==='startup-failed'){this.fail();return;}
  if(m.type==='slow'){this.onSlowTransaction?.(m.fields);return;}
  if(m.type==='boundary'){Promise.resolve().then(()=>{if(!['call','checked'].includes(m.method)||m.method==='call'&&!workerReads.has(m.args?.[1]?.method))throw fail(403,'工作线程只能读取原生来源');return this.boundary[m.method](...m.args);}).then(result=>{if(!this.closed)this.worker.postMessage({type:'boundary-reply',id:m.id,result});},e=>{if(!this.closed)this.worker.postMessage({type:'boundary-reply',id:m.id,error:{code:e.code,message:e.code?e.message:'原生读取未完成'}});});return;}
  if(m.type!=='reply')return;const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);this.pendingBytes-=p.bytes;if(m.error)p.reject(Object.assign(Error(m.error.message),m.error));else p.resolve(m.result);
 }
 fail(){this.healthy=false;this.generation??=this.sourceGeneration;this.initialize();for(const p of this.pending.values())p.reject(fail(503,'派生缓存暂不可用'));this.pending.clear();this.pendingBytes=0;}
 rpc(method,args){
  if(this.closed||!this.healthy)return Promise.reject(fail(503,'派生缓存暂不可用'));
  const bytes=Buffer.byteLength(JSON.stringify(args));if(this.pending.size>=CACHE_SERVICE_BUDGET.maxPendingCalls||this.pendingBytes+bytes>CACHE_SERVICE_BUDGET.maxPendingBytes)return Promise.reject(fail(503,'后台缓存正在忙碌'));
  const id=++this.nextId;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject,bytes});this.pendingBytes+=bytes;try{this.worker.postMessage({type:'request',id,method,args});}catch{this.fail();}});
 }
 background(method,args){if(!this.healthy)return;this.rpc(method,args).catch(()=>{if(method.startsWith('outbox.'))this.fail();});}
 async bounded(work,fallback=null){let timer;try{return await Promise.race([work,new Promise(resolve=>timer=setTimeout(()=>resolve(fallback),CACHE_SERVICE_BUDGET.lookupMs))]);}catch{return fallback;}finally{clearTimeout(timer);}}
 meta(key){return this.metadata.get(key);}
 setMeta(key,value){this.metadata.set(key,String(value));this.background('cache.setMeta',[key,value]);}
 project(r,options){return r?.sourceGeneration===this.generation?r:this.view.project(r,options);}
 async changes(...args){const page=await this.rpc('cache.changes',args);return {...page,generation:this.generation,records:page.records.map(r=>this.project(r)).filter(Boolean)};}
 async syncChanges(after,limit,options={}){const page=await this.rpc('cache.liveChanges',[after,limit,{...options,heads:[...this.warmHeads,...this.usedHeads.keys()]}]);return {...page,generation:this.generation,records:page.records.filter(r=>!['history','turn','item','readAlias'].includes(r.kind)||!this.invalidations.has(r.threadId)).map(r=>this.project(r)).filter(Boolean)};}
 catalog(...args){return this.rpc('cache.catalog',args);}
 async get(scope,key){const identity=JSON.stringify([scope,key]),raw=await this.bounded(this.rpc('cache.get',[scope,key]),this.memo.get(identity)||null),r=raw?this.project(raw):null;if(r){this.memo.delete(identity);this.memo.set(identity,r);while(this.memo.size>128)this.memo.delete(this.memo.keys().next().value);}return r;}
 rememberThread(scope,t){this.background('cache.rememberThread',[scope,t]);}
 noteEvent(m){if(this.noted.has(m))return;this.noted.add(m);const id=m.params?.threadId||m.params?.thread?.id;if(id&&observedMethods.has(m.method))this.view?.invalidate(id);if(id&&m.method==='thread/reverted')this.view?.rewritten(id);if(id&&invalidatingMethods.has(m.method)){this.versions.delete(id);this.versions.set(id,randomUUID());while(this.versions.size>4096)this.versions.delete(this.versions.keys().next().value);}}
 observe(m){
  if(!observedMethods.has(m.method)&&!m.method.startsWith('thread/section/'))return;
  const id=m.params?.threadId||m.params?.thread?.id;if(!id)return;
  this.noteEvent(m);
  const token=randomUUID();this.invalidations.set(id,token);
  this.rpc('cache.observe',[{method:m.method,params:{threadId:id}}]).catch(()=>{}).finally(()=>{if(this.invalidations.get(id)===token)this.invalidations.delete(id);});
 }
 async read(scope,method,params,options={}){
  if(options.sourceReadVersion===3)return this.readSource(scope,method,params,options);
  return this.project(await this.rpc('cache.read',[scope,method,params,{fresh:!!options.fresh}]));
 }
 async readSource(scope,method,params,{fresh=false,onReadStage,signal}={}){
  workspace(scope);if(!nativeCacheReads.has(method))throw fail(403,'缓存只提供原生历史读取');params=normalizeReadParams(method,params);validateId(params.threadId);checkReadInterest(signal);
  const head=scope+':'+params.threadId;this.usedHeads.delete(head);this.usedHeads.set(head,Date.now());while(this.usedHeads.size>100)this.usedHeads.delete(this.usedHeads.keys().next().value);
  const witness=this.versions.get(params.threadId),key=nativeReadKey(method,params);
  if(!fresh&&!this.invalidations.has(params.threadId)){const current=this.view.current(scope,key);if(current)return {...current,source:'mac-cache',sourceOnly:true};}
  if(!fresh&&!this.invalidations.has(params.threadId)){
   const cached=await withReadInterest(this.bounded(this.rpc('cache.lookup',[scope,method,params])),signal);
   if(cached&&witness===this.versions.get(params.threadId)&&!this.invalidations.has(params.threadId)){const projected=this.project(cached);if(projected){onReadStage?.('cache_lookup','received',{cacheHit:true,recordRevision:projected.revision});return {...projected,source:'mac-cache'};}}
  }
  const loadKey=scope+':'+key+':'+(witness||'initial');let work=this.directLoads.get(loadKey);
  if(!work&&this.directLoads.size>=128)throw fail(503,'原生读取请求较多');
  if(!work){work=(async()=>{
   onReadStage?.('native_read','dispatch');const result=await this.boundary.call(scope,{method,params});
   if(witness!==this.versions.get(params.threadId))throw fail(409,'历史已更新，请重新读取');
   const payload={method,params,result},bytes=Buffer.byteLength(JSON.stringify(payload));if(bytes>MAX_SOURCE_PAYLOAD_BYTES)throw fail(413,'这段历史过大，请使用原生分页读取');
   const record={...this.view.project({scope,key,kind:'history',threadId:params.threadId,payload,bytes,confirmedAt:new Date().toISOString(),deleted:false},{sourceOnly:true}),source:'native',sourceOnly:true};
   onReadStage?.('native_read','received',{recordRevision:record.revision,responseBytes:bytes});
   this.background('cache.rememberRead',[scope,method,params,result]);return record;
  })().finally(()=>this.directLoads.delete(loadKey));this.directLoads.set(loadKey,work);}
  return withReadInterest(work,signal);
 }
 async snapshotCatalog(scope,{after=0,generation,fresh=false}={}){
  workspace(scope);
  let session=this.catalogSessions.get(scope);
  if(!fresh&&this.healthy&&!this.invalidations.size&&(!generation||generation===this.generation)&&(!session||!after)){
   const cached=await this.bounded(this.rpc('cache.catalogSnapshot',[scope]));if(cached?.status?.payload?.complete){const records=cached.records.map(r=>this.project(r)).filter(Boolean).sort((a,b)=>a.revision-b.revision);session={generation:this.generation,records,cached:true,done:true,status:this.project(cached.status)};this.catalogSessions.set(scope,session);}
  }
  if(session?.cached&&!fresh&&(!generation||generation===session.generation)){const records=session.records.filter(r=>r.revision>after).slice(0,200);return {generation:session.generation,records,cursor:records.at(-1)?.revision??after,hasMore:session.records.some(r=>r.revision>(records.at(-1)?.revision??after)),status:session.status};}
  if(fresh||!session||generation&&generation!==session.generation){session={generation:this.generation,offset:0,nextCursor:null,records:[],done:false};this.catalogSessions.set(scope,session);after=0;}
  if(after<session.offset&&session.records.some(r=>r.revision>after))return this.catalogResult(scope,session,after);
  if(after!==session.offset&&!(!after&&!session.offset))throw fail(409,'目录版本已更新，请重新读取');
  const records=[];let bytes=0;do{
   const page=await this.boundary.call(scope,{method:'thread/list',params:{limit:50,sortKey:'updated_at',...(session.nextCursor?{cursor:session.nextCursor}:{})}});
   for(const thread of page.data){const payload=catalogEntry(thread),size=Buffer.byteLength(JSON.stringify(payload));bytes+=size;if(bytes>8*1024*1024)throw fail(413,'目录分页超过容量');const record=this.view.project({scope,key:'thread:'+thread.id,kind:'catalog',threadId:thread.id,payload,bytes:size,confirmedAt:new Date().toISOString(),deleted:false},{sourceOnly:true,force:true});records.push(record);session.offset=record.revision;this.rememberThread(scope,thread);}
   if(page.nextCursor&&page.nextCursor===session.nextCursor)throw fail(503,'原生目录游标重复');session.nextCursor=page.nextCursor;session.done=!page.nextCursor;
  }while(!session.done&&records.length<=150);
  session.records=records;return this.catalogResult(scope,session,after);
 }
 catalogResult(scope,session,after){const records=session.records.filter(r=>r.revision>after);return {generation:session.generation,records,cursor:records.at(-1)?.revision??after,hasMore:!session.done,status:{scope,key:'catalog-status',kind:'catalog-status',threadId:'',sourceGeneration:session.generation,generation:session.generation,revision:this.view.sequence+1,payload:{complete:session.done,confirmedAt:new Date().toISOString()}}};}
 async finishOutbox(clean){try{await this.rpc('outbox.finish',[!!clean]);}catch{}}
 async close(){if(this.closed)return;let timer;try{await Promise.race([this.rpc('close',[!this.outbox?.deferred.size,this.view?.checkpoint()]).catch(()=>{}),new Promise(resolve=>timer=setTimeout(resolve,3000))]);}finally{clearTimeout(timer);this.closed=true;this.fail();await this.worker.terminate();}}
}

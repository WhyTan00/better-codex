import {parentPort,workerData} from 'node:worker_threads';
import {SCOPES} from './registry.mjs';
import {NativeReadCache,nativeReadKey} from './native-read-cache.mjs';
import {SyncOutbox} from './sync-outbox.mjs';
import {randomUUID} from 'node:crypto';

// SQLite and its fsync/lock waits belong to this worker, never the bridge's
// Native RPC or socket event loop. This store contains derived data only.
let cache,outbox,outboxChain=Promise.resolve(),nextBoundary=0,outboxFailed=false,requestedClean=true;
const startedAt=new Date().toISOString();
const boundaryRequests=new Map();
const errorValue=e=>({message:e.code?e.message:'派生缓存暂不可用',code:e.code,errcode:e.errcode,failureClass:e.failureClass});
function boundaryCall(method,args){return new Promise((resolve,reject)=>{const id=++nextBoundary;boundaryRequests.set(id,{resolve,reject});parentPort.postMessage({type:'boundary',id,method,args});});}
const boundary={call:(...args)=>boundaryCall('call',args),checked:(...args)=>boundaryCall('checked',args)};
try{
 cache=new NativeReadCache(workerData.dir,{boundary,budget:workerData.budget});
 const oldAsync=cache.meta('async-outbox-v1')==='1',wasClean=cache.meta('outbox-clean')==='1';
 let viewState;try{viewState=JSON.parse(cache.meta('read-view-state')||'null');}catch{}
 const oldView=cache.meta('read-view-v1')==='1',viewValid=viewState?.generation==='view:'+cache.meta('outbox-epoch')&&viewState?.nativeGeneration===cache.generation&&Number.isSafeInteger(viewState?.sequence)&&viewState.sequence>=0&&Array.isArray(viewState.rows)&&viewState.rows.length<=8192&&Array.isArray(viewState.threads)&&viewState.threads.length<=4096;
 outbox=new SyncOutbox(cache);
 const legacyScopes=cache.db.prepare("SELECT DISTINCT json_extract(raw,'$.scope') AS scope FROM sync_outbox WHERE json_extract(raw,'$.event.type')='nativeRecord' AND json_extract(raw,'$.data.sourceGeneration')<>?").all('view:'+outbox.epoch).map(row=>row.scope).filter(scope=>SCOPES.includes(scope));
 // A RAM ACK can lead the optional disk mirror. After an unclean async stop,
 // replace ONLY that derived sender epoch, and reconcile from Native. Commands
 // and the separate Journal are never inspected or replayed here.
 // Pre-view frames can carry a read-only provenance annotation on an older
 // immutable cache identity. Reconcile this mixed namespace during migration
 // instead of reusing or rewriting already-assigned publication identities.
 const unsafeCheckpoint=oldAsync&&!wasClean||oldView&&!viewValid;
 if(unsafeCheckpoint||legacyScopes.length)cache.transaction(()=>{
  cache.db.exec('DELETE FROM sync_outbox');cache.setMeta('outbox-epoch',randomUUID());cache.setMeta('outbox-sequence',0);cache.setMeta('outbox-ack',0);cache.setMeta('cloud-record-cursor',0);
  for(const scope of unsafeCheckpoint?SCOPES:legacyScopes)cache.setMeta('outbox-rebuild:'+scope,randomUUID());
  outbox.epoch=cache.meta('outbox-epoch');outbox.sequence=outbox.ack=0;
 });
 cache.setMeta('async-outbox-v1',1);
 cache.setMeta('read-view-v1',1);
 cache.onChange=()=>parentPort.postMessage({type:'changed'});
 cache.onSlowTransaction=fields=>parentPort.postMessage({type:'slow',fields});
 const rows=cache.db.prepare('SELECT seq,raw,bytes FROM sync_outbox ORDER BY seq').all();
 const meta=Object.fromEntries(cache.db.prepare('SELECT key,value FROM cache_meta').all().map(r=>[r.key,r.value]));
 const bootstrap=SCOPES.map(scope=>cache.get(scope,'bootstrap')).filter(Boolean);
 const versions=cache.db.prepare('SELECT scope,thread_id,generation FROM cache_thread_versions LIMIT 4096').all();
 const catalogRetirements=cache.db.prepare("SELECT * FROM cache_records WHERE kind='catalog' AND deleted=1").all().map(row=>cache.decode(row));
 parentPort.postMessage({type:'ready',generation:cache.generation,meta,bootstrap,viewState,versions,catalogRetirements,outbox:{epoch:outbox.epoch,sequence:outbox.sequence,ack:outbox.ack,rows,limits:outbox.limits,stats:outbox.stats()}});
}catch(e){parentPort.postMessage({type:'startup-failed',error:errorValue(e)});}

async function perform(method,args){
 if(!cache||!outbox)throw Error('cache unavailable');
 if(method==='cache.lookup'){
  const [scope,readMethod,params]=args,key=nativeReadKey(readMethod,params),old=cache.get(scope,key),invalid=cache.get(scope,'invalidate:'+params.threadId);
  return old&&!old.deleted&&old.generation===cache.version(scope,params.threadId)&&old.revision>=(invalid?.revision||0)?{...old,source:'mac-cache'}:null;
 }
 if(method==='cache.catalogPage'){
  const [scope,after]=args;return {...cache.changes(after,200,scope,'catalog'),status:cache.get(scope,'catalog-status')};
 }
 if(method==='cache.catalogSnapshot'){
  const [scope]=args,status=cache.get(scope,'catalog-status');if(!status?.payload?.complete)return null;
  const rows=cache.db.prepare("SELECT key,bytes FROM cache_records WHERE scope=? AND kind='catalog' ORDER BY revision").all(scope);
  if(rows.reduce((n,r)=>n+r.bytes,0)>8*1024*1024)return null;
  return {status,records:rows.map(r=>cache.get(scope,r.key))};
 }
 if(method==='cache.liveChanges'){
  const [after,limit,{heads=[],metadataOnly=false}={}]=args,hot=new Set(heads),maximum=Math.min(500,Math.max(1,limit));
  const rows=cache.db.prepare('SELECT scope,key,kind,thread_id,revision,confirmed_at,bytes FROM cache_records WHERE revision>? ORDER BY revision LIMIT ?').all(after,maximum);
  const records=[];let bytes=0,cursor=after,more=false;
  for(const row of rows){
   const heavy=['history','turn','item','readAlias'].includes(row.kind);let head=false;
   if(heavy&&cache.db.prepare('SELECT generation FROM cache_records WHERE scope=? AND key=?').get(row.scope,row.key)?.generation!==cache.version(row.scope,row.thread_id)){cursor=row.revision;continue;}
   if(row.kind==='history'&&hot.has(row.scope+':'+row.thread_id)){try{const [m,p]=JSON.parse(row.key.slice(5));head=m==='thread/read'&&!p.includeTurns||m==='thread/turns/list'&&!p.cursor&&p.itemsView==='summary';}catch{}}
   if(heavy&&(metadataOnly||row.confirmed_at<startedAt&&!head)){cursor=row.revision;continue;}
   if(records.length&&bytes+row.bytes>2*1024*1024){more=true;break;}
   records.push(cache.get(row.scope,row.key));bytes+=row.bytes;cursor=row.revision;
  }
  return {generation:cache.generation,records,cursor,hasMore:more||rows.length===maximum};
 }
 if(method==='cache.rememberRead'){
  const [scope,readMethod,params,result]=args;
  return cache.transaction(()=>{cache.normalize(scope,readMethod,params,result);cache.rememberCursors(scope,result);return cache.put(scope,nativeReadKey(readMethod,params),'history',params.threadId,{method:readMethod,params,result});});
 }
 if(method==='outbox.persist'){
  const [frames]=args;if(!frames.length)return null;
  if(frames[0].epoch!==outbox.epoch||frames[0].seq!==outbox.sequence+1)throw Error('derived sender mirror gap');
  const actual=outbox.appendBatch(frames);
  for(let i=0;i<frames.length;i++)if(JSON.stringify(actual[i])!==JSON.stringify(frames[i]))throw Error('derived sender mirror identity mismatch');
  return null;
 }
 if(method==='outbox.ack'){outbox.acknowledge(args[0]);return null;}
 if(method==='outbox.finish'){requestedClean=!!args[0];return null;}
 if(method==='close'){
  const clean=args[0]&&requestedClean&&!outboxFailed&&!SCOPES.some(scope=>cache.meta('outbox-rebuild:'+scope));
  cache.transaction(()=>{if(args[1])cache.setMeta('read-view-state',JSON.stringify(args[1]));cache.setMeta('outbox-clean',clean?1:0);});
  cache.close();
  return null;
 }
 const allowed=new Set(['meta','setMeta','get','changes','read','catalog','observe','rememberThread','rememberCursors','invalidate']);
 if(!method.startsWith('cache.')||!allowed.has(method.slice(6)))throw Error('unsupported cache worker operation');
 return cache[method.slice(6)](...args);
}
parentPort.on('message',m=>{
 if(m.type==='boundary-reply'){const entry=boundaryRequests.get(m.id);if(!entry)return;boundaryRequests.delete(m.id);if(m.error)entry.reject(Object.assign(Error(m.error.message),m.error));else entry.resolve(m.result);return;}
 if(m.type!=='request')return;
 const run=async()=>{try{parentPort.postMessage({type:'reply',id:m.id,result:await perform(m.method,m.args)});}catch(e){if(m.method.startsWith('outbox.'))outboxFailed=true;parentPort.postMessage({type:'reply',id:m.id,error:errorValue(e)});}};
 if(m.method.startsWith('outbox.')||m.method==='close'){outboxChain=outboxChain.then(run);}
 else run();
});

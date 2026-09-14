import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {workspace,validateId,fail} from './registry.mjs';

export const nativeCacheReads=new Set(['thread/read','thread/turns/list','thread/items/list']);
export function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])]));return value;}
export function normalizeReadParams(method,params){const p={...(params||{})};if(p.cursor==null)delete p.cursor;
 if(method==='thread/read'){if(p.includeTurns===undefined)p.includeTurns=false;}
 if(method==='thread/turns/list'){p.limit=Math.min(20,Math.max(1,Number(p.limit)||12));p.itemsView??='summary';p.sortDirection??='desc';}
 if(method==='thread/items/list'){p.limit=Math.min(100,Math.max(1,Number(p.limit)||40));p.sortDirection??='asc';if(p.turnId==null)delete p.turnId;}
 return p;
}
export const stableItemHead=p=>'stable-item-head:'+JSON.stringify([p.threadId,p.turnId,p.limit,p.sortDirection]);
export const nativeReadKey=(method,params)=>'read:'+JSON.stringify([method,canonical(normalizeReadParams(method,params))]);
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function catalogEntry(thread){return {
 hostId:'local',threadId:thread.id,sourceKind:typeof thread.source==='string'?thread.source:'custom',sourceDetail:thread.source?.custom??null,
 displayTitle:thread.name||thread.preview||'未发送的新会话',sourceCreatedAt:thread.createdAt||0,sourceUpdatedAt:thread.updatedAt||0,
 sourceRecencyAt:thread.recencyAt??thread.updatedAt??thread.createdAt??0,cwd:thread.cwd,modelProvider:thread.modelProvider||'',threadSource:thread.threadSource||null,
 nativeThread:thread,
};}

// A scoped read replica, never a substitute for Native writer/approval checks.
// Record and change identity commit together; readers never acknowledge RAM.
export class NativeReadCache {
 constructor(dir,{boundary,budget=512*1024*1024}={}){
  mkdirSync(dir,{recursive:true,mode:0o700});this.db=new DatabaseSync(path.join(dir,'native-read.sqlite'));chmodSync(path.join(dir,'native-read.sqlite'),0o600);
  Object.assign(this,{boundary,budget});this.loading=new Map();this.catalogLoading=new Map();
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS cache_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS cache_changes(revision INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,key TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS cache_records(scope TEXT NOT NULL,key TEXT NOT NULL,kind TEXT NOT NULL,thread_id TEXT,
    generation TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT,hash TEXT NOT NULL,confirmed_at TEXT NOT NULL,
    bytes INTEGER NOT NULL,accessed_at INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,key));
   CREATE INDEX IF NOT EXISTS cache_records_revision ON cache_records(scope,revision);
   CREATE INDEX IF NOT EXISTS cache_records_thread ON cache_records(scope,thread_id,kind);
   CREATE INDEX IF NOT EXISTS cache_records_lru ON cache_records(kind,accessed_at);
   CREATE TABLE IF NOT EXISTS cache_thread_versions(scope TEXT,thread_id TEXT,generation TEXT NOT NULL,PRIMARY KEY(scope,thread_id));`);
  this.db.prepare("INSERT OR IGNORE INTO cache_meta VALUES('generation',?)").run(randomUUID());this.generation=this.meta('generation');
  if(!this.meta('read-key-v2'))this.transaction(()=>{for(const row of this.db.prepare("SELECT scope,key FROM cache_records WHERE kind='history'").all()){try{const [method,params]=JSON.parse(row.key.slice(5)),key=nativeReadKey(method,params);if(key!==row.key&&!this.db.prepare('SELECT 1 FROM cache_records WHERE scope=? AND key=?').get(row.scope,key))this.db.prepare('UPDATE cache_records SET key=? WHERE scope=? AND key=?').run(key,row.scope,row.key);}catch{}}this.setMeta('read-key-v2','1');});
 }
 meta(key){return this.db.prepare('SELECT value FROM cache_meta WHERE key=?').get(key)?.value;}
 setMeta(key,value){this.db.prepare('INSERT INTO cache_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value));}
 version(scope,id){return this.db.prepare('SELECT generation FROM cache_thread_versions WHERE scope=? AND thread_id=?').get(scope,id)?.generation||this.generation;}
 transaction(fn){if(this.inTransaction)return fn();this.db.exec('BEGIN IMMEDIATE');this.inTransaction=true;try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}finally{this.inTransaction=false;}}
 decode(row){if(!row)return null;return {sourceGeneration:this.generation,scope:row.scope,key:row.key,kind:row.kind,threadId:row.thread_id,generation:row.generation,revision:row.revision,payload:row.payload?JSON.parse(row.payload):null,confirmedAt:row.confirmed_at,bytes:row.bytes,deleted:!!row.deleted};}
 get(scope,key){const row=this.db.prepare('SELECT * FROM cache_records WHERE scope=? AND key=?').get(scope,key);if(row)this.db.prepare('UPDATE cache_records SET accessed_at=? WHERE scope=? AND key=?').run(Date.now(),scope,key);return this.decode(row);}
 put(scope,key,kind,threadId,payload,{deleted=false,generation=this.version(scope,threadId)}={}){
  workspace(scope);if(payload!=null&&Buffer.byteLength(JSON.stringify(payload))>48*1024*1024)throw fail(413,'这段历史过大，请使用原生分页读取');const fingerprint=digest([payload,deleted,generation]),old=this.db.prepare('SELECT hash FROM cache_records WHERE scope=? AND key=?').get(scope,key);
  if(old?.hash===fingerprint)return this.get(scope,key);
  return this.transaction(()=>{const revision=Number(this.db.prepare('INSERT INTO cache_changes(scope,key) VALUES(?,?)').run(scope,key).lastInsertRowid),raw=payload==null?null:JSON.stringify(payload),at=new Date().toISOString();
   if(revision%128===0)this.db.prepare('DELETE FROM cache_changes WHERE revision<?').run(revision-4096);
   this.db.prepare(`INSERT INTO cache_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,key) DO UPDATE SET kind=excluded.kind,thread_id=excluded.thread_id,generation=excluded.generation,revision=excluded.revision,payload=excluded.payload,hash=excluded.hash,confirmed_at=excluded.confirmed_at,bytes=excluded.bytes,accessed_at=excluded.accessed_at,deleted=excluded.deleted`).run(scope,key,kind,threadId,generation,revision,raw,fingerprint,at,raw?Buffer.byteLength(raw):0,Date.now(),deleted?1:0);
   return this.get(scope,key);
  });
 }
 changes(after=0,limit=100,scope=null,kind=null){
  const where=['revision>?'],params=[after];if(scope){where.push('scope=?');params.push(scope);}if(kind){where.push('kind=?');params.push(kind);}params.push(Math.min(500,Math.max(1,limit)));
  const records=[];let bytes=0,more=false;
  for(const row of this.db.prepare('SELECT * FROM cache_records WHERE '+where.join(' AND ')+' ORDER BY revision LIMIT ?').iterate(...params)){if(records.length&&bytes+row.bytes>2*1024*1024){more=true;break;}records.push(this.decode(row));bytes+=row.bytes;}
  return {generation:this.generation,records,cursor:records.at(-1)?.revision??after,hasMore:more||records.length===params.at(-1)};
 }
 async read(scope,method,params,{fresh=false}={}){
  workspace(scope);if(!nativeCacheReads.has(method))throw fail(403,'缓存只提供原生历史读取');params=normalizeReadParams(method,params);validateId(params?.threadId);
  const key=nativeReadKey(method,params);let old=this.get(scope,key);
  if(method==='thread/items/list'&&params.turnId){const seed=this.get(scope,'history-cursors:'+params.threadId),turn=this.get(scope,'turn:'+params.threadId+':'+params.turnId);
   if(params.cursor&&seed&&!seed.deleted&&seed.payload.itemsBackwardsCursor===params.cursor&&turn?.payload?.turn?.status==='completed'&&turn.generation===this.version(scope,params.threadId)){
    if(old&&!old.deleted&&old.generation===turn.generation)this.put(scope,stableItemHead(params),'readAlias',params.threadId,{targetKey:key});
    else {const alias=this.get(scope,stableItemHead(params)),target=alias&&!alias.deleted?this.get(scope,alias.payload.targetKey):null;if(target&&!target.deleted&&target.generation===turn.generation)old=this.put(scope,key,'history',params.threadId,{method,params,result:target.payload.result});}
   }
  }
  const invalidation=this.get(scope,'invalidate:'+params.threadId);
  if(!fresh&&old&&!old.deleted&&old.generation===this.version(scope,params.threadId)&&old.revision>=(invalidation?.revision||0))return {...old,source:'mac-cache'};
  const loadingKey=scope+':'+key;if(this.loading.has(loadingKey))return this.loading.get(loadingKey);
  const generation=this.version(scope,params.threadId),work=(async()=>{
   const result=await this.boundary.call(scope,{method,params});
   // A revert received while this read was in flight invalidates its result.
   if(generation!==this.version(scope,params.threadId))throw fail(409,'历史已更新，请重新读取');
   const record=this.transaction(()=>{this.normalize(scope,method,params,result);return this.put(scope,key,'history',params.threadId,{method,params,result});});this.evict();return {...record,source:'native'};
  })().finally(()=>this.loading.delete(loadingKey));this.loading.set(loadingKey,work);return work;
 }
 normalize(scope,method,params,result){
  const id=params.threadId;if(result.thread)this.rememberThread(scope,result.thread);
  const turns=method==='thread/turns/list'?result.data:result.thread?.turns;
  for(const turn of turns||[]){const {items,...metadata}=turn;this.put(scope,'turn:'+id+':'+turn.id,'turn',id,{turn:metadata,itemsView:turn.itemsView||params.itemsView||(method==='thread/read'?'full':'summary')});if((turn.itemsView||params.itemsView||(method==='thread/read'?'full':'summary'))==='full')for(const item of items||[])this.put(scope,'item:'+id+':'+turn.id+':'+item.id,'item',id,{turnId:turn.id,item});}
  if(method==='thread/items/list'&&params.turnId){const seed=this.get(scope,'history-cursors:'+id),turn=this.get(scope,'turn:'+id+':'+params.turnId);if(params.cursor&&seed&&!seed.deleted&&seed.payload.itemsBackwardsCursor===params.cursor&&turn?.payload?.turn?.status==='completed'&&turn.generation===this.version(scope,id))this.put(scope,stableItemHead(params),'readAlias',id,{targetKey:nativeReadKey(method,params)});}
  if(method==='thread/items/list')for(const value of result.data||[]){const item=value.item||value,turnId=value.turnId||params.turnId;if(turnId&&typeof item.id==='string')this.put(scope,'item:'+id+':'+turnId+':'+item.id,'item',id,{turnId,item});}
 }
 rememberCursors(scope,result){const id=result?.thread?.id;if(!id||typeof result.itemsBackwardsCursor!=='string')return;return this.put(scope,'history-cursors:'+id,'historyCursor',id,{itemsBackwardsCursor:result.itemsBackwardsCursor,turnsBackwardsCursor:result.turnsBackwardsCursor??null});}
 rememberThread(scope,thread){if(!thread?.id)return;const {turns,...metadata}=thread;return this.put(scope,'thread:'+thread.id,'catalog',thread.id,catalogEntry(metadata));}
 async catalog(scope,{fresh=false}={}){
  workspace(scope);if(this.catalogLoading.has(scope))return this.catalogLoading.get(scope);
  if(!fresh&&this.get(scope,'catalog-status'))return this.changes(0,100,scope,'catalog');
  const work=(async()=>{const started=this.db.prepare('SELECT COALESCE(MAX(revision),0) revision FROM cache_records').get().revision,ids=new Set(),seen=new Set();let cursor;
   do{const page=await this.boundary.call(scope,{method:'thread/list',params:{limit:50,sortKey:'updated_at',...(cursor?{cursor}:{})}});
    for(const thread of page.data){ids.add(thread.id);if((this.get(scope,'thread:'+thread.id)?.revision||0)<=started)this.rememberThread(scope,thread);}cursor=page.nextCursor;
    if(cursor&&seen.has(cursor))throw fail(503,'原生目录游标重复');seen.add(cursor);
    if(cursor)await new Promise(resolve=>setTimeout(resolve,10));
   }while(cursor);
   for(const row of this.db.prepare("SELECT key,thread_id,revision FROM cache_records WHERE scope=? AND kind='catalog' AND deleted=0").all(scope))if(!ids.has(row.thread_id)&&row.revision<=started)this.put(scope,row.key,'catalog',row.thread_id,null,{deleted:true});
   this.put(scope,'catalog-status','catalog-status','',{complete:true,count:ids.size,confirmedAt:new Date().toISOString()});
   return this.changes(0,100,scope,'catalog');
  })().finally(()=>this.catalogLoading.delete(scope));this.catalogLoading.set(scope,work);return work;
 }
 invalidate(scope,threadId,{rewrite=false}={}){
  if(rewrite){this.db.prepare('INSERT INTO cache_thread_versions VALUES(?,?,?) ON CONFLICT(scope,thread_id) DO UPDATE SET generation=excluded.generation').run(scope,threadId,randomUUID());this.put(scope,'history-cursors:'+threadId,'historyCursor',threadId,null,{deleted:true});}
  // Keep old payloads for offline reading until replacement. A generation
  // marker tells each replica that they are stale, rather than erasing the UI.
  return this.put(scope,'invalidate:'+threadId,'invalidation',threadId,{threadId,rewrite,at:Date.now()}, {generation:this.version(scope,threadId)});
 }
 async observe(m){const id=m.params?.threadId||m.params?.thread?.id;if(!id)return;const methods=['thread/started','thread/name/updated','thread/status/changed','thread/archived','thread/unarchived','thread/reverted','turn/started','turn/completed'];if(!methods.includes(m.method)&&!m.method.startsWith('thread/section/'))return;
  for(const scope of ['ai','secondary']){try{const t=await this.boundary.checked(workspace(scope),id,{fresh:true});
    if(m.method==='thread/archived')this.put(scope,'thread:'+id,'catalog',id,null,{deleted:true});else this.rememberThread(scope,t);
    if(['thread/reverted','turn/started','turn/completed'].includes(m.method))this.invalidate(scope,id,{rewrite:m.method==='thread/reverted'});
    if(m.method.startsWith('thread/section/'))this.put(scope,'catalog-invalidation','catalog-status','',{complete:false,at:Date.now()});
    break;
   }catch(e){if(e.code!==404)throw e;}}
 }
 evict(){let total=this.db.prepare('SELECT COALESCE(SUM(bytes),0) bytes FROM cache_records').get().bytes;if(total<=this.budget)return;
  for(const row of this.db.prepare("SELECT scope,key,kind,thread_id,bytes FROM cache_records WHERE kind IN ('history','turn','item') AND deleted=0 ORDER BY accessed_at LIMIT 128").all()){
   if(total<=this.budget*0.8)break;this.put(row.scope,row.key,row.kind,row.thread_id,null,{deleted:true});total-=row.bytes;
  }
 }
 close(){this.db.close();}
}

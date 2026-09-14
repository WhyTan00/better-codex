// Complete native DTOs and catalog metadata, committed with their cursor.
// This module never queues an execution or treats cached data as a write ACK.
(()=>{
 const scope=window.__BETTER_CODEX_SCOPE__;if(!scope)return;
 let composerModel={model:'provider-default',model_reasoning_effort:'medium'};
 const composerConfig=value=>value?.config?{...value,config:{...value.config,...composerModel}}:value;
 const refreshComposer=()=>{for(const key of ['user-saved-config','config'])window.dispatchEvent(new MessageEvent('message',{data:{type:'ipc-broadcast',method:'query-cache-invalidate',params:{queryKey:[key]}}}));};
 window.__BETTER_CODEX_RESET_NEW_CHAT_MODEL__=()=>{composerModel={model:'provider-default',model_reasoning_effort:'medium'};refreshComposer();};
 const READS=new Set(['thread/read','thread/turns/list','thread/items/list']);
 const AUX=new Set(['getAuthStatus','config/read','model/list','modelProvider/capabilities/read','account/read','account/rateLimits/read','configRequirements/read','experimentalFeature/list','remoteControl/status/read','collaborationMode/list','permissionProfile/list','thread/list','thread/loaded/list','skills/list','app/list','mcpServerStatus/list']);
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,canonical(v[k])])):v;
 const normalize=(method,params)=>{const p={...(params||{})};if(p.cursor==null)delete p.cursor;if(method==='thread/read'&&p.includeTurns===undefined)p.includeTurns=false;if(method==='thread/turns/list'){p.limit=Math.min(20,Math.max(1,Number(p.limit)||12));p.itemsView??='summary';p.sortDirection??='desc';}if(method==='thread/items/list'){p.limit=Math.min(100,Math.max(1,Number(p.limit)||40));p.sortDirection??='asc';if(p.turnId==null)delete p.turnId;}return p;};
 const stableItemHead=p=>'stable-item-head:'+JSON.stringify([p.threadId,p.turnId,p.limit,p.sortDirection]);
 const readKey=(method,params)=>'read:'+JSON.stringify([method,canonical(normalize(method,params))]);
 const requestValue=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const done=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('本机缓存未能提交'));tx.onerror=()=>{};});
 const opening=new Promise((resolve,reject)=>{const r=indexedDB.open('betterCodex-native-v1-'+scope.id,5);r.onupgradeneeded=()=>{const db=r.result;
  if(!db.objectStoreNames.contains('records')){const records=db.createObjectStore('records',{keyPath:'key'});records.createIndex('kind','kind');records.createIndex('recency',['kind','recency','key']);records.createIndex('accessed',['kind','accessedAt']);}
  const catalogStore=r.transaction.objectStore('records');if(!catalogStore.indexNames.contains('created'))catalogStore.createIndex('created',['kind','createdAt','key']);if(!catalogStore.indexNames.contains('updated'))catalogStore.createIndex('updated',['kind','updatedAt','key']);const catalogUpgrade=catalogStore.index('kind').openCursor(IDBKeyRange.only('catalog'));catalogUpgrade.onsuccess=()=>{const c=catalogUpgrade.result;if(!c)return;const v=c.value;c.update({...v,createdAt:v.payload?.sourceCreatedAt||0,updatedAt:v.payload?.sourceUpdatedAt||0});c.continue();};
  for(const name of ['meta','catalog-stage','drafts','commands'])if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:'key'});
  const commandStore=r.transaction.objectStore('commands');if(!commandStore.indexNames.contains('state'))commandStore.createIndex('state','state');
  if(!db.objectStoreNames.contains('aliases')){const aliases=db.createObjectStore('aliases',{keyPath:'key'}),rKeys=r.transaction.objectStore('records').openKeyCursor();rKeys.onsuccess=()=>{const c=rKeys.result;if(!c)return;const key=c.primaryKey;if(typeof key==='string'&&key.startsWith('read:'))try{const [method,params]=JSON.parse(key.slice(5)),normalized=readKey(method,params);if(normalized!==key)aliases.put({key:normalized,target:key});}catch{}c.continue();};}
  if(!db.objectStoreNames.contains('usage')){const usage=db.createObjectStore('usage',{keyPath:'key'});usage.createIndex('accessedAt','accessedAt');const cursor=r.transaction.objectStore('records').openCursor();cursor.onsuccess=()=>{const c=cursor.result;if(!c)return;const v=c.value;if(['history','turn','item'].includes(v.kind)&&!v.deleted)usage.put({key:v.key,bytes:v.bytes||0,threadId:v.threadId,accessedAt:v.accessedAt||0});c.continue();};}
 };r.onsuccess=()=>{r.result.onversionchange=()=>r.result.close();resolve(r.result);};r.onerror=()=>reject(r.error);});
 let memoryMeta=new Map(),volatileCatalog=null,catalogRevision=0,syncing=null,remoteServices=null,nativeClient=null;
 let remoteReady=false;const ipcReads=new Map(),rpcReads=new Map(),resumeReads=new Map();
 const hiddenThreads=new Set(),startedThreads=new Set();
 function listableThread(thread){
  if(!thread?.id)return true;
  const started=!!(thread.preview?.trim()||thread.name?.trim()||thread.turns?.length||thread.status?.type==='active');
  if(started)startedThreads.add(thread.id);
  const visible=startedThreads.has(thread.id);const changed=hiddenThreads.has(thread.id)===visible;
  if(visible)hiddenThreads.delete(thread.id);else hiddenThreads.add(thread.id);
  if(changed)queueMicrotask(()=>window.dispatchEvent(new Event('betterCodex:thread-list-visibility')));
  return visible;
 }
 const listableEntry=entry=>!entry?.nativeThread||listableThread(entry.nativeThread);
 const listResult=(method,value)=>method==='thread/list'&&value?{...value,data:(value.data||[]).filter(listableThread)}:value;
 window.__BETTER_CODEX_THREAD_LIST_VISIBILITY__={isHidden:id=>hiddenThreads.has(id),listableEntry};
 const diagnostics={ipc:{},rpc:{},hits:0,misses:0,hostCreated:false,readMisses:[],coalesced:0,refreshSkipped:0,settingsRefreshes:0,auxRefreshes:0,ipcStableHits:0,catalogPollSkipped:0,localSharedNotifications:0};
 const refreshes=new Map(),checkedReads=new Map();let readEpoch=0;
 function invalidateReadChecks(){readEpoch++;checkedReads.clear();}
 function refreshOnce(key,ttl,read,save){
  const active=refreshes.get(key);if(active?.epoch===readEpoch){diagnostics.coalesced++;return active.promise;}
  if(Date.now()-(checkedReads.get(key)||0)<ttl){diagnostics.refreshSkipped++;return Promise.resolve();}
  const epoch=readEpoch,entry={epoch,promise:null};entry.promise=Promise.resolve().then(read).then(async value=>{if(epoch===readEpoch){await save(value);if(epoch===readEpoch)checkedReads.set(key,Date.now());}return value;}).finally(()=>{if(refreshes.get(key)===entry)refreshes.delete(key);});refreshes.set(key,entry);return entry.promise;
 }
 const STABLE_IPC=new Set(['os-info','locale-info','codex-home','home-directory']);
 const stableIpcPending=new Map(),stableIpcChecked=new Map();
 function resetStableIpc(){for(const [id,entry]of stableIpcPending){ipcReads.delete(id);for(const waiter of entry.waiters)waiter.emit('fetch-response',{requestId:waiter.id,responseType:'error',status:503,error:'连接正在恢复，请重试'});}stableIpcPending.clear();stableIpcChecked.clear();}

 const IPC_READS=new Set(['get-global-state','get-configuration','get-settings','get-setting','account-info','os-info','locale-info','workspace-root-options','codex-home','home-directory','list-pinned-threads','list-automations','inbox-items','ide-context','app-server-connection-state','is-copilot-api-available','mcp-codex-config','worktree-shell-environment-config','paths-exist','developer-instructions','git-origins','get-copilot-api-proxy-info']);
 const pinnedRequests=new Map(),pinnedWarmed=new Set();let pinnedEpoch=0,pinnedDirty=false,pinnedCheckedAt=0,pinnedEmit=null;
 function resetPinnedReads(){for(const id of pinnedRequests.keys())ipcReads.delete(id);pinnedRequests.clear();pinnedEpoch++;pinnedCheckedAt=0;}
 const statusSubscribers=new Set(),observationSubscribers=new Set(),installed=new WeakSet(),pendingReads=new Map();
 const offlineHydrated=new Set(),offlineHydrations=new Map();
 const broadcast=typeof BroadcastChannel==='function'?new BroadcastChannel('betterCodex-native-cache:'+scope.id):null;
 async function meta(key){if(memoryMeta.has(key))return memoryMeta.get(key);const db=await opening,r=await requestValue(db.transaction('meta').objectStore('meta').get(key));if(r)memoryMeta.set(key,r.value);return r?.value;}
 async function saveMeta(key,value){const db=await opening,tx=db.transaction('meta','readwrite'),completion=done(tx);tx.objectStore('meta').put({key,value});await completion;memoryMeta.set(key,value);}
 async function get(key,{touch=true}={}){const db=await opening;let record=await requestValue(db.transaction('records').objectStore('records').get(key));if(!record&&(key.startsWith('read:')||key.startsWith('stable-item-head:'))){const alias=await requestValue(db.transaction('aliases').objectStore('aliases').get(key));if(alias)record=await requestValue(db.transaction('records').objectStore('records').get(alias.target));}if(touch&&record?.kind==='history'&&!record.deleted){const tx=db.transaction('usage','readwrite');tx.objectStore('usage').put({key:record.key,bytes:record.bytes||0,threadId:record.threadId,accessedAt:Date.now()});}return record;}
 const IMPORT_KINDS=new Set(['catalog','history','turn','item','readAlias']),HISTORY_KINDS=new Set(['history','turn','item']);
 function stored(record){return {...record,recency:record.payload?.sourceRecencyAt||0,createdAt:record.payload?.sourceCreatedAt||0,updatedAt:record.payload?.sourceUpdatedAt||0,accessedAt:Date.now()};}
 function entities(record){const result=record.payload?.result,params=record.payload?.params,method=record.payload?.method;if(!result||!params)return [];const values=[],id=params.threadId;
  const add=(key,kind,payload)=>values.push({...record,key,kind,payload,bytes:new TextEncoder().encode(JSON.stringify(payload)).length});
  for(const turn of (method==='thread/turns/list'?result.data:result.thread?.turns)||[]){const {items,...metadata}=turn;add('turn:'+id+':'+turn.id,'turn',{turn:metadata,itemsView:turn.itemsView||params.itemsView||(method==='thread/read'?'full':'summary')});if((turn.itemsView||params.itemsView||(method==='thread/read'?'full':'summary'))==='full')for(const item of items||[])add('item:'+id+':'+turn.id+':'+item.id,'item',{turnId:turn.id,item});}
  if(method==='thread/items/list')for(const value of result.data||[]){const item=value.item||value,turnId=value.turnId||params.turnId;if(turnId&&typeof item.id==='string')add('item:'+id+':'+turnId+':'+item.id,'item',{turnId,item});}return values;
 }
 async function putValues(tx,record,storeName='records'){
  const store=tx.objectStore(storeName),usage=tx.objectStore('usage');
  for(const value of [record,...entities(record)]){
   if(!value?.key||!IMPORT_KINDS.has(value.kind))continue;
   const old=await requestValue(store.get(value.key));
   if(!old||old.sourceGeneration!==value.sourceGeneration||old.revision<=value.revision){store.put(stored(value));if(HISTORY_KINDS.has(value.kind)){if(value.deleted)usage.delete(value.key);else usage.put({key:value.key,bytes:value.bytes||0,threadId:value.threadId,accessedAt:Date.now()});}}
  }
 }
 async function terminalItems(params,record){if(!record||!params.turnId)return false;const generation=await meta('catalog-generation');if(generation&&record.sourceGeneration!==generation)return false;const turn=await get('turn:'+params.threadId+':'+params.turnId);return turn?.payload?.turn?.status==='completed'&&turn.sourceGeneration===record.sourceGeneration&&turn.generation===record.generation;}
 async function put(record){if(!record?.key)return;let stable=null;const method=record.payload?.method,params=method==='thread/items/list'?normalize(method,record.payload.params):null;
  if(params?.turnId&&params.cursor&&(await meta('history-cursors:'+params.threadId))?.itemsBackwardsCursor===params.cursor&&await terminalItems(params,record))stable=stableItemHead(params);
  const db=await opening,tx=db.transaction(['records','usage','aliases'],'readwrite'),completion=done(tx);await putValues(tx,record);if(stable)tx.objectStore('aliases').put({key:stable,target:record.key});await completion;
 }

 async function recordCommand(value){const db=await opening,tx=db.transaction('commands','readwrite'),completion=done(tx);tx.objectStore('commands').put({...value,key:value.id,at:Date.now()});await completion;}
 async function pendingCommands(threadId){const db=await opening,index=db.transaction('commands').objectStore('commands').index('state'),rows=(await Promise.all(['pending','unknown'].map(state=>requestValue(index.getAll(state))))).flat();return rows.filter(r=>['pending','unknown'].includes(r.state)&&(!threadId||r.threadId===threadId));}
 const warningDismissKey='full-access-warning-dismissed-at-v2';let localWarningDismissedAt=null;
 async function persistAtom(update){
  if(typeof update.key!=='string'||update.key!==warningDismissKey&&!/^(?:composer-|prompt-history$|sidebar-|flat-project-sidebar-|unread-thread-)/.test(update.key))return false;
  if(update.key===warningDismissKey){if(update.recordUpdate||!update.deleted&&update.value!==null&&(!Number.isFinite(update.value)||update.value<0))return false;localWarningDismissedAt=update.deleted?null:update.value;}
  const db=await opening,tx=db.transaction('drafts','readwrite'),completion=done(tx),store=tx.objectStore('drafts'),key='atom:'+update.key;let value=update.value;
  if(update.recordUpdate){const prior=await requestValue(store.get(key));value={...(prior?.value||{})};for(const[k,v]of Object.entries(update.recordUpdate.entries||{})){delete value[k];if(v!=null)value[k]=v.value;}}
  if(update.deleted)store.delete(key);else store.put({key,value,at:Date.now()});await completion;return true;
 }
 async function restoreAtoms(){const db=await opening,rows=await requestValue(db.transaction('drafts').objectStore('drafts').getAll());const atoms=Object.fromEntries(rows.filter(r=>r.key.startsWith('atom:')).map(r=>[r.key.slice(5),r.value]));if(Number.isFinite(atoms[warningDismissKey]))localWarningDismissedAt=Math.max(localWarningDismissedAt||0,atoms[warningDismissKey]);return atoms;}
 const composerViews=new Map(),viewFields=['imageAttachments','imageCommentDrafts','fileAttachments','pastedTextAttachments','addedFiles','appshotContexts','mcpAppModelContextAttachments','selectedTextAttachments','responseTextAnnotations'];
 window.__BETTER_CODEX_CACHE_COMPOSER_VIEW__=(key,value,restore)=>{
  const fields=Object.fromEntries(viewFields.filter(k=>value[k]!==undefined).map(k=>[k,value[k]])),fingerprint=JSON.stringify(fields);let view=composerViews.get(key);
  if(!view){view={fingerprint,loaded:false,restoring:false};composerViews.set(key,view);
   opening.then(async db=>{const saved=await requestValue(db.transaction('drafts').objectStore('drafts').get('view:'+key));view.loaded=true;if(saved&&view.fingerprint===fingerprint){view.restoring=true;try{restore(saved.value);}finally{view.restoring=false;}}}).catch(()=>{view.loaded=true;});return;
  }
  const changed=view.fingerprint!==fingerprint;view.fingerprint=fingerprint;if(!view.loaded||view.restoring||!changed)return;
  opening.then(async db=>{const tx=db.transaction('drafts','readwrite'),completion=done(tx);tx.objectStore('drafts').put({key:'view:'+key,value:fields,at:Date.now()});await completion;}).catch(()=>{});
 };
 async function evict(){const estimate=await navigator.storage?.estimate?.().catch(()=>null),budget=Math.min(androidReader?4*1024*1024*1024:128*1024*1024,Math.max(16*1024*1024,(estimate?.quota||512*1024*1024)*(androidReader?0.5:0.15)));const db=await opening,tx=db.transaction(['records','usage'],'readwrite'),completion=done(tx),store=tx.objectStore('records'),usage=tx.objectStore('usage');let total=0;const candidates=[];
  await new Promise((resolve,reject)=>{const r=usage.index('accessedAt').openCursor();r.onerror=()=>reject(r.error);r.onsuccess=()=>{const cursor=r.result;if(!cursor)return resolve();const v=cursor.value;total+=v.bytes||0;candidates.push(v);cursor.continue();};});
  if(total>budget){const active=location.pathname.split('/')[2];for(const candidate of candidates.sort((a,b)=>Number(priorityPinned.has(a.threadId))-Number(priorityPinned.has(b.threadId)))){if(total<=budget*0.75)break;if(candidate.threadId===active)continue;if(priorityPinned.has(candidate.threadId)&&candidate.key.startsWith('read:')){try{const [method,params]=JSON.parse(candidate.key.slice(5));if(method==='thread/read'||method==='thread/turns/list'&&!params.cursor)continue;}catch{}}store.delete(candidate.key);usage.delete(candidate.key);total-=candidate.bytes;}}
  await completion;
 }

 async function durableCommitCatalog(page){
  // An empty, uninitialized source page carries no catalog snapshot. It can
  // report a fresh status/cursor boundary, but must never replace a valid
  // catalog already shown by the browser cache.
  if(page.generation==='uninitialized'&&!page.records.length&&!page.hasMore)return;
  if(!page.generation)return;
  const current=await meta('catalog-generation'),staging=current!==page.generation,db=await opening;
  const tx=db.transaction(['records','meta','catalog-stage'],'readwrite'),completion=done(tx),records=tx.objectStore('records'),metadata=tx.objectStore('meta'),stage=tx.objectStore('catalog-stage');
  if(staging){const prior=await requestValue(metadata.get('stage-generation'));if(prior?.value!==page.generation){stage.clear();metadata.put({key:'stage-generation',value:page.generation});}}
  for(const record of page.records){if(record.scope!==scope.id||record.kind!=='catalog')throw Error('目录工作区或格式不匹配');const target=staging?stage:records,old=await requestValue(target.get(record.key));if(!old||old.sourceGeneration!==record.sourceGeneration||old.revision<=record.revision)target.put(stored(record));}
  if(staging&&!page.hasMore){
   await new Promise((resolve,reject)=>{const r=records.index('kind').openCursor(IDBKeyRange.only('catalog'));r.onerror=()=>reject(r.error);r.onsuccess=()=>{const cursor=r.result;if(!cursor)return resolve();cursor.delete();cursor.continue();};});
   await new Promise((resolve,reject)=>{const r=stage.openCursor();r.onerror=()=>reject(r.error);r.onsuccess=()=>{const cursor=r.result;if(!cursor)return resolve();records.put(cursor.value);cursor.continue();};});stage.clear();metadata.put({key:'catalog-generation',value:page.generation});
  }
  metadata.put({key:staging&&page.hasMore?'stage-cursor':'catalog-cursor',value:page.cursor});
  if(!staging||!page.hasMore)metadata.put({key:'catalog-status',value:page.status});
  await completion;
  if(!staging||!page.hasMore){memoryMeta.set('catalog-generation',page.generation);memoryMeta.set('catalog-cursor',page.cursor);memoryMeta.set('catalog-status',page.status);catalogRevision=Math.max(catalogRevision,page.cursor,page.status?.revision||0);broadcast?.postMessage({type:'catalog',revision:catalogRevision});notifyStatus();const threads=page.records.filter(r=>!r.deleted).map(r=>r.payload?.nativeThread).filter(t=>t&&listableThread(t));if(threads.length)for(const callback of observationSubscribers)callback({hostId:'local',threads});}
 }
 async function commitCatalog(page){
  if(page.generation==='uninitialized'&&!page.records.length&&!page.hasMore)return;
  if(page.records.some(r=>r.scope!==scope.id||r.kind!=='catalog'))throw Error('目录工作区或格式不匹配');
  try{await durableCommitCatalog(page);volatileCatalog=null;}catch(error){
   // An unavailable first-install quota must not leave an online user with an
   // empty sidebar. This volatile view never advances a durable cursor or ACK.
   if(await meta('catalog-generation').catch(()=>null))throw error;
   volatileCatalog??=new Map();for(const r of page.records)volatileCatalog.set(r.key,stored(r));
   if(!page.hasMore){memoryMeta.set('catalog-status',page.status);catalogRevision++;notifyStatus();}
  }
 }
 const importCursor=value=>Number.isSafeInteger(value)&&value>=0?value:null;
 const jsonSnapshot=value=>{try{const text=JSON.stringify(value);if(text===undefined)return null;const bytes=new TextEncoder().encode(text).length;if(bytes>64*1024*1024)return null;return {value:JSON.parse(text),bytes};}catch{return null;}};
 const importString=(value,max=160)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f]/.test(value);
 const nativeReadCursorKey=scopeId=>'android-replica-read-cursor-v1:'+scopeId,nativeGenerationKey=scopeId=>'android-replica-source-generation-v1:'+scopeId;
 function importAliasTarget(value){
  if(typeof value!=='string'||value.length<6||value.length>512||!value.startsWith('read:'))return false;
  try{const parsed=JSON.parse(value.slice(5));return Array.isArray(parsed)&&parsed.length===2&&READS.has(parsed[0])&&parsed[1]&&typeof parsed[1]==='object'&&!Array.isArray(parsed[1]);}catch{return false;}
 }
 function importRecord(record,generation){
  const snapshot=jsonSnapshot(record?.payload);
  if(!record||record.scope!==scope.id||!IMPORT_KINDS.has(record.kind)||!importString(record.key,512)||!importString(record.sourceGeneration,160)||record.sourceGeneration!==generation||!importString(record.generation,160)||!Number.isSafeInteger(record.revision)||record.revision<1||typeof record.deleted!=='boolean'||!snapshot)return null;
  if(record.threadId!=null&&(!importString(record.threadId,200)&&record.threadId!==''))return null;
  if(record.bytes!=null&&(!Number.isFinite(record.bytes)||record.bytes<0||record.bytes>64*1024*1024))return null;
  if(record.confirmedAt!=null&&record.confirmedAt!==''&&(!importString(record.confirmedAt,200)||record.confirmedAt.length>200))return null;
  if(record.kind==='readAlias'&&(!record.key.startsWith('stable-item-head:')||record.deleted===false&&!importAliasTarget(snapshot.value?.targetKey)))return null;
  return {...record,payload:snapshot.value};
 }
 function importBootstrap(value){
  if(value==null)return null;
  const snapshot=jsonSnapshot(value);if(!snapshot||!snapshot.value||typeof snapshot.value!=='object'||Array.isArray(snapshot.value))throw Error('Android bootstrap 格式不匹配');
  const raw=snapshot.value,config=raw.config&&typeof raw.config==='object'&&!Array.isArray(raw.config)?raw.config:raw,copy=structuredClone(config);
  for(const key of ['scopeToken','sessionToken','authorization','cookie','apiKey'])delete copy[key];
  for(const key of ['gatewayBaseUrl','gatewayWsUrl'])if(typeof copy[key]==='string')try{const url=new URL(copy[key],location.href);url.search='';url.hash='';copy[key]=url.href;}catch{delete copy[key];}
  const result=jsonSnapshot(copy);if(!result)throw Error('Android bootstrap 不可保存');return result.value;
 }
 function historyCursorEntries(page){
  const raw=page.historyCursors??page.historyCursor;if(raw==null)return [];
  const values=Array.isArray(raw)?raw:raw&&typeof raw==='object'?(raw.threadId||raw.id?[raw]:Object.entries(raw).map(([threadId,cursors])=>({threadId,cursors}))):null;
  if(!values)throw Error('Android 历史游标格式不匹配');
  return values.map(entry=>{
   const threadId=entry?.threadId||entry?.id;if(!/^[0-9a-f-]{36}$/i.test(threadId||''))throw Error('Android 历史游标工作区不匹配');
   if(entry.deleted===true)return {threadId,value:null};
   let value=entry.cursors??entry.cursor??entry.value;
   if(value===undefined){value={...entry};delete value.threadId;delete value.id;delete value.deleted;}
   if(typeof value==='string'||value===null)value={itemsBackwardsCursor:value};
   const snapshot=jsonSnapshot(value);if(!snapshot||!snapshot.value||typeof snapshot.value!=='object'||Array.isArray(snapshot.value))throw Error('Android 历史游标不可保存');
   for(const key of ['itemsBackwardsCursor','turnsBackwardsCursor'])if(snapshot.value[key]!=null&&(!importString(snapshot.value[key],4096)))throw Error('Android 历史游标内容不匹配');
   return {threadId,value:snapshot.value};
  });
 }
 function validateImportPage(page){
  if(!page||page.version!==1||page.source!=='android'||page.scope!==scope.id||!importString(page.generation,160)||!Array.isArray(page.records)||page.records.length>200||typeof page.hasMore!=='boolean')throw Error('Android 缓存页格式不匹配');
  const cursor=importCursor(page.cursor),readCursor=importCursor(page.readCursor);if(cursor==null||readCursor==null||cursor!==readCursor)throw Error('Android 缓存游标格式不匹配');
  if(page.hasMore&&!page.records.length)throw Error('Android 缓存空分页无效');
  const records=page.records.map(record=>{const value=importRecord(record,page.generation);if(!value)throw Error('Android 缓存记录身份或格式不匹配');return value;});
  const catalogCursor=page.catalogCursor==null?null:importCursor(page.catalogCursor);if(page.catalogCursor!=null&&catalogCursor==null)throw Error('Android 目录游标格式不匹配');
  let status=page.status==null?null:jsonSnapshot(page.status)?.value;if(page.status!=null&&(!status||typeof status!=='object'||Array.isArray(status)))throw Error('Android 目录状态格式不匹配');
  if(status?.scope!=null&&status.scope!==scope.id)throw Error('Android 目录状态工作区不匹配');
  if(status?.generation!=null&&status.generation!=='uninitialized'&&status.generation!==page.generation)throw Error('Android 目录状态代际不匹配');
  return {version:1,scope:scope.id,generation:page.generation,records,cursor,readCursor,catalogCursor,hasMore:page.hasMore,status,bootstrap:importBootstrap(page.bootstrap),historyCursors:historyCursorEntries(page),readCursorKey:page.readCursorKey,sourceGenerationKey:page.sourceGenerationKey};
 }
 async function deleteCatalog(store){await new Promise((resolve,reject)=>{const request=store.index('kind').openCursor(IDBKeyRange.only('catalog'));request.onerror=()=>reject(request.error);request.onsuccess=()=>{const cursor=request.result;if(!cursor)return resolve();cursor.delete();cursor.continue();};});}
 async function copyStagedCatalog(stage,records){await new Promise((resolve,reject)=>{const request=stage.openCursor();request.onerror=()=>reject(request.error);request.onsuccess=()=>{const cursor=request.result;if(!cursor)return resolve();records.put(cursor.value);cursor.continue();};});}
 async function importSnapshot(page){
  const checked=validateImportPage(page),expectedRead=nativeReadCursorKey(scope.id),expectedGeneration=nativeGenerationKey(scope.id);
  if(checked.readCursorKey!==expectedRead||checked.sourceGenerationKey!==expectedGeneration)throw Error('Android 缓存游标归属不匹配');
  return withWriter('catalog',async()=>{
   const db=await opening,tx=db.transaction(['records','meta','catalog-stage','usage','aliases'],'readwrite'),completion=done(tx),records=tx.objectStore('records'),metadata=tx.objectStore('meta'),stage=tx.objectStore('catalog-stage'),aliases=tx.objectStore('aliases');
   const preserveCatalog=checked.generation==='uninitialized'&&!checked.records.length&&!checked.hasMore;
   let promoted=false,staging=false,oldCatalogCursor=0;
   try{
    const current=(await requestValue(metadata.get('catalog-generation')))?.value||'',lastAndroid=(await requestValue(metadata.get('android-source-generation')))?.value||'',stageGeneration=(await requestValue(metadata.get('stage-generation')))?.value||'',priorRead=(await requestValue(metadata.get(expectedRead)))?.value;
    if(priorRead!=null&&(!Number.isSafeInteger(priorRead)||priorRead<0))throw Error('Android 本地游标元数据损坏');
    if(priorRead!=null&&checked.readCursor<priorRead)throw Error('Android 本地游标倒退');
    if(priorRead==null&&checked.records.length&&checked.readCursor===0)throw Error('Android 非空页游标未前进');
    if(checked.hasMore&&checked.readCursor===0)throw Error('Android 本地游标未前进');
    if(checked.hasMore&&priorRead!=null&&checked.readCursor===priorRead)throw Error('Android 本地游标未前进');
    if(!preserveCatalog){
     const knownAndroidGeneration=lastAndroid&&lastAndroid!=='uninitialized';
     if(current&&current!==checked.generation&&knownAndroidGeneration&&lastAndroid!==current&&stageGeneration!==checked.generation)throw Error('Android 来源代际需先刷新');
     staging=current!==checked.generation;
     if(staging&&stageGeneration!==checked.generation){stage.clear();metadata.put({key:'stage-generation',value:checked.generation});}
    }
    for(const record of checked.records){
     if(record.kind==='readAlias'){
      const old=await requestValue(aliases.get(record.key));
      if(record.deleted){if(!old||old.sourceGeneration!==record.sourceGeneration||old.revision<=record.revision)aliases.delete(record.key);}
      else if(!old||old.sourceGeneration!==record.sourceGeneration||old.revision<=record.revision)aliases.put({key:record.key,target:record.payload.targetKey,sourceGeneration:record.sourceGeneration,generation:record.generation,revision:record.revision});
     }else if(record.kind==='catalog'){
      if(preserveCatalog)continue;
      const target=staging?stage:records,old=await requestValue(target.get(record.key));if(!old||old.sourceGeneration!==record.sourceGeneration||old.revision<=record.revision)target.put(stored(record));
     }else await putValues(tx,record);
    }
    if(!preserveCatalog&&staging&&!checked.hasMore){await deleteCatalog(records);await copyStagedCatalog(stage,records);stage.clear();metadata.put({key:'catalog-generation',value:checked.generation});promoted=true;}
    if(!preserveCatalog&&staging&&checked.hasMore&&checked.catalogCursor!=null)metadata.put({key:'stage-cursor',value:checked.catalogCursor});
    if(!preserveCatalog&&!checked.hasMore){
     const oldCursor=(await requestValue(metadata.get('catalog-cursor')))?.value;oldCatalogCursor=Number.isSafeInteger(oldCursor)&&oldCursor>=0?oldCursor:0;
     if(promoted)metadata.put({key:'catalog-cursor',value:checked.catalogCursor??0});else if(checked.catalogCursor!=null&&checked.catalogCursor>=oldCatalogCursor)metadata.put({key:'catalog-cursor',value:checked.catalogCursor});
     if(checked.status!=null)metadata.put({key:'catalog-status',value:checked.status});else if(promoted)metadata.delete('catalog-status');
     if(promoted)metadata.delete('stage-cursor');
    }
    if(checked.bootstrap!=null)metadata.put({key:'bootstrap',value:checked.bootstrap});
    for(const entry of checked.historyCursors)metadata.put({key:'history-cursors:'+entry.threadId,value:entry.value});
    metadata.put({key:'android-source-generation',value:checked.generation});metadata.put({key:expectedRead,value:checked.readCursor});metadata.put({key:expectedGeneration,value:checked.generation});
    await completion;
   }catch(error){try{tx.abort();}catch{}await completion.catch(()=>{});throw error;}
   if(!preserveCatalog)volatileCatalog=null;
   memoryMeta.set(expectedRead,checked.readCursor);memoryMeta.set(expectedGeneration,checked.generation);memoryMeta.set('android-source-generation',checked.generation);
   for(const entry of checked.historyCursors)memoryMeta.set('history-cursors:'+entry.threadId,entry.value);
   if(checked.bootstrap!=null)memoryMeta.set('bootstrap',checked.bootstrap);
   if(promoted){memoryMeta.set('catalog-generation',checked.generation);memoryMeta.set('catalog-cursor',checked.catalogCursor??0);if(checked.status!=null)memoryMeta.set('catalog-status',checked.status);else memoryMeta.delete('catalog-status');memoryMeta.delete('stage-cursor');}
   else if(!preserveCatalog&&!checked.hasMore&&checked.catalogCursor!=null){const currentCursor=await meta('catalog-cursor');if(currentCursor==null||checked.catalogCursor>=currentCursor)memoryMeta.set('catalog-cursor',checked.catalogCursor);}
   if(!preserveCatalog&&!checked.hasMore&&checked.status!=null)memoryMeta.set('catalog-status',checked.status);
   if(!preserveCatalog&&!checked.hasMore){const revision=Math.max(catalogRevision,checked.catalogCursor||0,Number.isSafeInteger(checked.status?.revision)?checked.status.revision:0);catalogRevision=revision;broadcast?.postMessage({type:'catalog',revision});notifyStatus();const threads=checked.records.filter(record=>record.kind==='catalog'&&!record.deleted).map(record=>record.payload?.nativeThread).filter(thread=>thread&&listableThread(thread));if(threads.length)for(const callback of observationSubscribers)callback({hostId:'local',threads});}
   return {scope:checked.scope,cursor:checked.readCursor,generation:checked.generation,hasMore:checked.hasMore};
  });
 }
 const withWriter=(name,work)=>navigator.locks?.request?navigator.locks.request('betterCodex-native:'+scope.id+':'+name,work):work();
 const cloud=!['127.0.0.1','localhost'].includes(location.hostname),base=cloud?'/sync/v1/w/'+scope.id:'/w/'+scope.id+'/api';
 async function api(path,body,priority='auto'){if(!cloud&&!scope.token){const session=await window.__BETTER_CODEX_SESSION_READY__;if(!session)throw Error('Mac 暂未连接');}const r=await fetch(base+path,{priority,...(body?{method:'POST',body:JSON.stringify(body)}:{}),headers:{'x-betterCodex-scope':scope.token||'',...(body?{'content-type':'application/json'}:{})},cache:'no-store',redirect:'manual'});if(r.status===401||r.type==='opaqueredirect'){window.dispatchEvent(new Event('betterCodex:authentication-required'));throw Error('请重新登录');}if(!r.ok)throw Error('当前暂不能同步');const value=await r.json();if(typeof value.nativeOnline==='boolean')window.__BETTER_CODEX_NATIVE_ONLINE__=value.nativeOnline;return value;}
 async function syncCatalog(refresh=false){if(syncing)return syncing;syncing=withWriter('catalog',async()=>{
  memoryMeta.delete('catalog-cursor');memoryMeta.delete('catalog-generation');
  let cursor=await meta('catalog-cursor')||0,generation=await meta('catalog-generation')||'',first=true;
  do{const page=await api('/native-catalog?after='+cursor+'&generation='+encodeURIComponent(generation)+(refresh&&first?'&refresh=1':''));first=false;const next=importCursor(page.cursor);if(next==null||page.hasMore&&next<=cursor)throw Error('目录游标未前进');await commitCatalog(page);cursor=next;if(typeof page.generation==='string'&&page.generation)generation=page.generation;if(!page.hasMore)break;}while(true);
  return status();
 }).finally(()=>{syncing=null;});return syncing;}
 async function status(){const value=await meta('catalog-status'),generation=await meta('catalog-generation'),revision=Math.max(catalogRevision,await meta('catalog-cursor')||0,value?.revision||0),complete=!!(value?.payload?.complete??value?.complete??value?.bootstrapComplete);return {hosts:[{hostId:'local',isComplete:complete,revision:generation+':'+revision}],revision,isComplete:complete};}
 function notifyStatus(){status().then(value=>{for(const callback of statusSubscribers)callback(value);}).catch(()=>{});}
 function matches(entry,filter){if(!filter)return true;if(filter.excludeThreadIds?.includes(entry.threadId))return false;if(filter.projectId!=null&&filter.projectId!==entry.projectId)return false;if(filter.conversationOrigin!=null&&filter.conversationOrigin!==entry.conversationOrigin)return false;
  return filter.includeAll||filter.includeThreadIds?.includes(entry.threadId)||filter.cwdValues?.includes(entry.cwd)||filter.cwdPrefixes?.some(prefix=>entry.cwd?.startsWith(prefix));}
 async function catalogPage(p={}){
  if(p.hostId&&p.hostId!=='local')return {entries:[],nextCursor:null};const db=await opening,limit=Math.min(100,Math.max(1,p.limit||50)),entries=[];
  if(p.manualOrder){const ids=p.manualOrder.threadIds.slice(p.manualOrder.startIndex||0);let used=0;for(const id of ids){used++;const record=volatileCatalog?.get('thread:'+id)||await get('thread:'+id);if(record&&!record.deleted&&listableEntry(record.payload)&&matches(record.payload,p.filter))entries.push(record.payload);if(entries.length===limit)break;}return {entries,nextManualIndex:(p.manualOrder.startIndex||0)+used,nextCursor:null};}
  const sortKey=p.sortKey||'updated_at',indexName=sortKey==='created_at'?'created':sortKey==='updated_at'?'updated':'recency',field=indexName==='created'?'createdAt':indexName==='updated'?'updatedAt':'recency';
  const generation=await meta('catalog-generation')||'volatile',signature=JSON.stringify(canonical(p.filter||{}));let position=null;
  if(p.cursor)try{const c=JSON.parse(decodeURIComponent(atob(p.cursor)));if(c.v!==2||c.generation!==generation||c.sortKey!==sortKey||c.signature!==signature||!Array.isArray(c.position))throw Error();position=c.position;}catch{throw Error('目录已更新，请重新打开列表');}
  let more=false,last=null;
  const accept=record=>{if(record.deleted||!listableEntry(record.payload)||!matches(record.payload,p.filter))return true;if(entries.length===limit){more=true;return false;}entries.push(record.payload);last=['catalog',record[field]||0,record.key];return true;};
  if(volatileCatalog){const rows=[...volatileCatalog.values()].sort((a,b)=>(b[field]||0)-(a[field]||0)||b.key.localeCompare(a.key));for(const r of rows){if(position&&((r[field]||0)>position[1]||(r[field]||0)===position[1]&&r.key>=position[2]))continue;if(!accept(r))break;}}
  else {const tx=db.transaction('records'),index=tx.objectStore('records').index(indexName),range=IDBKeyRange.bound(['catalog',0,''],position||['catalog',Number.MAX_VALUE,'\uffff'],false,!!position);
   await new Promise((resolve,reject)=>{const r=index.openCursor(range,'prev');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const cursor=r.result;if(!cursor||!accept(cursor.value))return resolve();cursor.continue();};});}
  window.__BETTER_CODEX_PERF__?.event('native_catalog_read',{count:entries.length,source:volatileCatalog?'memory':'indexeddb'});
  return {entries,nextCursor:more?btoa(encodeURIComponent(JSON.stringify({v:2,generation,sortKey,signature,position:last}))):null};
 }
 async function readEntries(keys){const entries=[];for(const {hostId,threadId}of keys){if(hostId!=='local')continue;let r=await get('thread:'+threadId);if(!r&&!navigator.onLine)continue;if(!r)try{const record=await read('thread/read',{threadId,includeTurns:false}),thread=record.result.thread;r={payload:toEntry(thread)};}catch{}if(r&&!r.deleted&&listableEntry(r.payload))entries.push(r.payload);}return entries;}
 const toEntry=t=>({hostId:'local',threadId:t.id,sourceKind:typeof t.source==='string'?t.source:'custom',displayTitle:t.name||t.preview||'新聊天',sourceCreatedAt:t.createdAt||0,sourceUpdatedAt:t.updatedAt||0,sourceRecencyAt:t.recencyAt??t.updatedAt??0,cwd:t.cwd,modelProvider:t.modelProvider||'',threadSource:t.threadSource||null,nativeThread:t});
 const validated=new Map(),foregroundFreshReads=new Set(),nativeActivity=new Map(),nativeEventEpoch=new Map();let lastForeground=Date.now();
 async function fetchRead(method,params,fresh,priority='auto'){params=normalize(method,params);const key=readKey(method,params),pendingKey=key+(fresh?':fresh':':cached');if(pendingReads.has(key+':fresh'))return pendingReads.get(key+':fresh');if(pendingReads.has(pendingKey))return pendingReads.get(pendingKey);
  const statusStamp=window.__BETTER_CODEX_NATIVE_STATUS_RECOVERY__?.beginRead(params.threadId,{fresh});
  const work=(async()=>{let record=await api('/native-read',{method,params,fresh},priority);if(record.scope!==scope.id||record.key!==key||record.deleted)throw Error('历史缓存身份不匹配');let generation=await meta('catalog-generation');if(generation&&generation!==record.sourceGeneration){await syncCatalog();generation=await meta('catalog-generation');if(generation&&generation!==record.sourceGeneration)throw Error('历史来源已更新，请重新读取');}await put(record).catch(()=>{});const committed=await get(key,{touch:false}).catch(()=>null);if(committed&&!committed.deleted&&committed.sourceGeneration===record.sourceGeneration&&committed.generation===record.generation&&committed.revision>record.revision)record={...committed,source:'indexeddb'};window.__BETTER_CODEX_NATIVE_STATUS_RECOVERY__?.acceptRead(method,params,record,statusStamp);if(fresh&&(record.source==null||record.source==='native'))validated.set(key,Date.now());window.__BETTER_CODEX_CLIENT_LOG__?.event('history_read',{method,threadId:params.threadId,revision:record.revision,source:record.source||'native',fresh:!!fresh});if(validated.size>512)validated.delete(validated.keys().next().value);return record;})().finally(()=>pendingReads.delete(pendingKey));pendingReads.set(pendingKey,work);return work;}
 async function read(method,params){const key=readKey(method,params),normalized=normalize(method,params);let cached=await get(key).catch(()=>null);
  // A background freshness check must not force the visible reader past its cache.
  if(!cached&&method==='thread/items/list'&&normalized.turnId&&normalized.cursor&&(await meta('history-cursors:'+normalized.threadId))?.itemsBackwardsCursor===normalized.cursor){const stable=await get(stableItemHead(normalized));if(stable&&!stable.deleted&&await terminalItems(normalized,stable))cached=stable;}
  const immutable=method==='thread/items/list'&&cached&&await terminalItems(normalized,cached);
  if(immutable&&normalized.cursor&&(await meta('history-cursors:'+normalized.threadId))?.itemsBackwardsCursor===normalized.cursor){const db=await opening,key=stableItemHead(normalized),prior=await requestValue(db.transaction('aliases').objectStore('aliases').get(key));if(prior?.target!==cached.key){const tx=db.transaction('aliases','readwrite'),completion=done(tx);tx.objectStore('aliases').put({key,target:cached.key});await completion;}}


  if(cached&&!cached.deleted){window.__BETTER_CODEX_PERF__?.event('native_history_read',{source:'indexeddb'});if(navigator.onLine&&!immutable&&Date.now()-(validated.get(key)||0)>2000)fetchRead(method,params,true).then(record=>{if(record.revision>cached.revision){broadcast?.postMessage({type:'history',threadId:params.threadId});window.dispatchEvent(new CustomEvent('betterCodex:history-updated',{detail:{threadId:params.threadId}}));}}).catch(()=>{});return {result:structuredClone(cached.payload.result),cached:true,confirmedAt:cached.confirmedAt};}
  diagnostics.readMisses.push({method,limit:params?.limit,itemsView:params?.itemsView,sortDirection:params?.sortDirection,hasCursor:!!params?.cursor});if(diagnostics.readMisses.length>20)diagnostics.readMisses.shift();foregroundFreshReads.add(key);let record;try{record=await fetchRead(method,params,false);}finally{foregroundFreshReads.delete(key);}window.__BETTER_CODEX_PERF__?.event('native_history_read',{source:record.source||'cloud'});return {result:record.payload.result,cached:false};
 }
 // Background cache refresh never resumes, subscribes or executes a thread.
 const PREWARM_TURNS=(!!window.BETTER_CODEXAndroid||/BETTER_CODEXAndroid/i.test(navigator.userAgent))?12:6,PREWARM_RECENT=(!!window.BETTER_CODEXAndroid||/BETTER_CODEXAndroid/i.test(navigator.userAgent))?60:20;
 let priorityPinned=new Set();
 const backgroundErrors=new Map(),backgroundHeads=new Set(),backgroundQueue=new Set(),backgroundFresh=new Map(),backgroundLast=new Map(),knownRunning=new Set(),recentWarmed=new Map();let backgroundBusy=false,backgroundTimer=null,scanning=false;
 diagnostics.background={completed:0,failed:0,lastThread:null,turnsPerThread:PREWARM_TURNS,recentThreads:PREWARM_RECENT};
 function enqueueBackground(id,{fresh=true}={}){if(!/^[0-9a-f-]{36}$/i.test(id||''))return;queueCachedPreparation(id);backgroundQueue.add(id);backgroundFresh.set(id,fresh||backgroundFresh.get(id)||false);scheduleBackground();}
 async function warmPinned(value){priorityPinned=new Set(value?.threadIds||[]);for(const id of value?.threadIds||[]){if(pinnedWarmed.has(id))continue;pinnedWarmed.add(id);enqueueBackground(id,{fresh:false});}}
 async function warmRecent(){const page=await catalogPage({limit:PREWARM_RECENT,sortKey:'updated_at'});for(const entry of page.entries){const version=entry.sourceUpdatedAt||entry.sourceRecencyAt||0;if(recentWarmed.get(entry.threadId)===version)continue;recentWarmed.set(entry.threadId,version);enqueueBackground(entry.threadId,{fresh:false});}if(recentWarmed.size>100)for(const id of [...recentWarmed.keys()].slice(0,recentWarmed.size-100))recentWarmed.delete(id);}
 function scheduleBackground(){if(backgroundTimer)return;backgroundTimer=setTimeout(()=>{backgroundTimer=null;runBackground().catch(()=>{});},1200);}
 async function prewarmRead(method,params,fresh){
  if(!fresh){const cached=await get(readKey(method,params)).catch(()=>null),generation=await meta('catalog-generation'),invalid=await meta('invalid:invalidate:'+params.threadId);if(cached&&!cached.deleted&&(!generation||cached.sourceGeneration===generation)&&(!invalid||invalid.revision<=cached.revision))return cached;}
  return fetchRead(method,params,fresh,'low');
 }
 async function runBackground(){
  if(backgroundBusy||!backgroundQueue.size)return;
  if(document.visibilityState!=='visible'||!navigator.onLine||window.__BETTER_CODEX_NATIVE_ONLINE__===false||navigator.connection?.saveData||Date.now()-lastForeground<1800||foregroundFreshReads.size){scheduleBackground();return;}
  const visible=window.__BETTER_CODEX_NATIVE_SIDEBAR__?.isList?null:location.pathname.split('/')[2];
  const rank=id=>priorityPinned.has(id)?0:knownRunning.has(id)?1:recentWarmed.has(id)?2:3;
  const id=[...backgroundQueue].filter(id=>id!==visible&&Date.now()-(backgroundLast.get(id)||0)>10000).sort((a,b)=>Number(backgroundHeads.has(a))-Number(backgroundHeads.has(b))||rank(a)-rank(b))[0];
  if(!id){scheduleBackground();return;}backgroundQueue.delete(id);const fresh=backgroundFresh.get(id)!==false;backgroundFresh.delete(id);backgroundBusy=true;backgroundLast.set(id,Date.now());diagnostics.background.currentThread=id;diagnostics.background.stage=backgroundHeads.has(id)?'history':'head';
  try{
   if(!backgroundHeads.has(id)){
   const head=await prewarmRead('thread/read',{threadId:id,includeTurns:false},fresh);
   if(head.payload?.result?.thread?.historyMode==='legacy'){
    // Legacy threads expose full turns, not the durable item-page API.
    await prewarmRead('thread/turns/list',{threadId:id,limit:2,sortDirection:'desc',itemsView:'full'},fresh);
    await prepareCachedConversation(id);backgroundErrors.delete(id);diagnostics.background.completed++;diagnostics.background.lastThread=id;return;
   }
   // Share the exact first-paint shape used by Android's durable history reader.
   await prewarmRead('thread/turns/list',{threadId:id,limit:20,sortDirection:'desc',itemsView:'summary'},fresh);
   saveMeta('history-prewarmed:'+id,{at:Date.now(),headReady:true,pinned:priorityPinned.has(id)}).catch(()=>{});
   await prepareCachedConversation(id);backgroundHeads.add(id);backgroundLast.delete(id);enqueueBackground(id,{fresh});return;
   }
   if(Date.now()-lastForeground<1800){enqueueBackground(id,{fresh});return;}
   // Keep the native first-page shape hot, then prepare a deeper recent window.
   await prewarmRead('thread/turns/list',{threadId:id,limit:1,sortDirection:'desc',itemsView:'notLoaded'},fresh);
   if(Date.now()-lastForeground<1800||foregroundFreshReads.size){enqueueBackground(id,{fresh});return;}
   const page=await prewarmRead('thread/turns/list',{threadId:id,limit:PREWARM_TURNS,sortDirection:'desc',itemsView:'notLoaded'},fresh);
   for(const turn of page.payload.result.data||[]){
    if(document.visibilityState!=='visible'||!navigator.onLine||navigator.connection?.saveData||Date.now()-lastForeground<1800||foregroundFreshReads.size){enqueueBackground(id,{fresh});return;}
    await prewarmRead('thread/items/list',{threadId:id,turnId:turn.id,limit:window.__BETTER_CODEX_HISTORY_POLICY__?.initialTurnItems||20,sortDirection:'desc'},fresh);
   }
   if(androidReader)await prepareCachedConversation(id);else if(fresh&&Date.now()-lastForeground>=1800)await nativeClient?.hydrateBackgroundThreads?.([id],{includeTurns:true,maxTurns:PREWARM_TURNS});backgroundHeads.delete(id);
   backgroundErrors.delete(id);diagnostics.background.completed++;diagnostics.background.lastThread=id;
   window.__BETTER_CODEX_PERF__?.event('prewarm',{bodyCount:diagnostics.background.completed,background:true});
  }catch{backgroundErrors.set(id,{at:Date.now()});if(backgroundErrors.size>100)backgroundErrors.delete(backgroundErrors.keys().next().value);backgroundHeads.delete(id);diagnostics.background.failed++;pinnedWarmed.delete(id);recentWarmed.delete(id);if(priorityPinned.has(id))enqueueBackground(id,{fresh:false});}finally{backgroundBusy=false;diagnostics.background.currentThread=null;diagnostics.background.stage=null;if(backgroundQueue.size)scheduleBackground();}
 }
 async function scanRunning(){if(scanning||document.visibilityState!=='visible')return;scanning=true;try{for(const id of window.__BETTER_CODEX_NATIVE_STATUS_RECOVERY__?.activeThreadIds()||[])enqueueBackground(id);await warmRecent();let cursor;const running=new Set();do{const page=await catalogPage({limit:100,cursor});for(const entry of page.entries)if(entry.nativeThread?.status?.type==='active'){running.add(entry.threadId);enqueueBackground(entry.threadId);}cursor=page.nextCursor;}while(cursor);for(const id of knownRunning)if(!running.has(id))enqueueBackground(id);knownRunning.clear();for(const id of running)knownRunning.add(id);}finally{scanning=false;}}
 document.addEventListener('input',()=>{lastForeground=Date.now();},true);
 addEventListener('betterCodex:native-route',()=>{lastForeground=Date.now();});
 addEventListener('betterCodex:session-ready',()=>scanRunning().catch(()=>{}));
 const backgroundScanTimer=setInterval(()=>scanRunning().catch(()=>{}),15000);setTimeout(()=>scanRunning().catch(()=>{}),5000);
 function hydrateCachedThread(id){if(androidReader)return refreshCommitted();if(!id||!nativeClient||window.__BETTER_CODEX_EXECUTION_CONNECTED__===true||offlineHydrated.has(id))return Promise.resolve();if(offlineHydrations.has(id))return offlineHydrations.get(id);const work=nativeClient.hydrateBackgroundThreads([id],{includeTurns:true,maxTurns:androidReader?6:1,...(androidReader?{refreshTurns:true,refreshGuard:()=>location.pathname==='/local/'+id}:{})}).then(async()=>{
   if(androidReader){offlineHydrated.add(id);window.__BETTER_CODEX_PERF__?.ready(id);return;}
   // Background hydration deliberately omits normal-page pagination in the
   // pinned renderer. Restore that READ cursor explicitly; never set resumed
   // or claim a Native writer just to make cached history scrollable.
   const page=(await read('thread/turns/list',{threadId:id,cursor:null,limit:1,sortDirection:'desc'})).result;let seed=await meta('history-cursors:'+id);if(!seed)try{seed=(await api('/native-cursors?threadId='+encodeURIComponent(id))).cursors;if(seed)await saveMeta('history-cursors:'+id,seed);}catch{};
   if(window.__BETTER_CODEX_EXECUTION_CONNECTED__!==true)nativeClient.updateConversationState?.(id,c=>{
    if(seed?.itemsBackwardsCursor){c.paginatedHistory={itemsBackwardsCursor:seed.itemsBackwardsCursor};c.turnsPagination={olderCursor:seed.turnsBackwardsCursor,oldestLoadedTurnId:null,isLoadingOlder:false,hasLoadedOldest:seed.turnsBackwardsCursor==null};}
    else c.turnsPagination={olderCursor:page.nextCursor??null,oldestLoadedTurnId:page.data?.at(-1)?.id??null,isLoadingOlder:false,hasLoadedOldest:page.nextCursor==null};
   });
   offlineHydrated.add(id);window.__BETTER_CODEX_PERF__?.ready(id);
  }).finally(()=>offlineHydrations.delete(id));offlineHydrations.set(id,work);return work;}
 let eventsSocket=null,eventsRetry=null,eventChain=Promise.resolve(),eventsStarting=false;
 function replicaChanged(event){if(event?.type==='host'){window.__BETTER_CODEX_NATIVE_ONLINE__=!!event.online;window.dispatchEvent(new Event('betterCodex:connection-state'));}if(event?.type==='nativeChanged'){if(/^(thread:|catalog-)/.test(event.cacheKey||''))syncCatalog().catch(()=>{});const id=event.threadId;if(id&&!event.cacheKey?.startsWith('read:')){for(const key of validated.keys())if(key.includes(id))validated.delete(key);if(location.pathname!=='/local/'+id||window.__BETTER_CODEX_NATIVE_SIDEBAR__?.isList)enqueueBackground(id);}if(id&&location.pathname==='/local/'+id&&!event.cacheKey?.startsWith('read:')){if(androidReader){refreshForeground().catch(()=>{});return;}fetchRead('thread/read',{threadId:id,includeTurns:false},true).then(()=>nativeClient?.hydrateBackgroundThreads?.([id],{includeTurns:true,maxTurns:1})).catch(()=>{});}}}
 async function connectEvents(){if(eventsSocket||eventsStarting||!cloud||!navigator.onLine)return;eventsStarting=true;try{if(navigator.locks?.request)await navigator.locks.request('betterCodex-native:'+scope.id+':events',{ifAvailable:true},lock=>lock?openEvents():undefined);else await openEvents();}finally{eventsStarting=false;}}
 async function openEvents(){if(!cloud||eventsSocket||!navigator.onLine)return;const cursor=await meta('event-cursor')||{},u=new URL('/sync/v1/w/'+scope.id+'/events',location.href);u.protocol=location.protocol==='https:'?'wss:':'ws:';u.searchParams.set('epoch',cursor.epoch||'');u.searchParams.set('after',cursor.seq||0);const socket=new WebSocket(u.href);eventsSocket=socket;
  socket.addEventListener('message',event=>{eventChain=eventChain.then(async()=>{const value=JSON.parse(event.data);
   if(value.type==='hello'){replicaChanged({type:'host',online:value.online});broadcast?.postMessage({type:'sync-event',event:{type:'host',online:value.online}});return;}
   if(value.type==='resync'){await syncCatalog(true);await saveMeta('event-cursor',{epoch:value.epoch,seq:value.seq||0});socket.close();return;}
   if(!Number.isSafeInteger(value.seq)||value.scope!==scope.id)return;const previous=await meta('event-cursor')||{};
   if(value.epoch===previous.epoch&&value.seq<=previous.seq){socket.send(JSON.stringify({type:'ack',seq:previous.seq}));return;}
   if(value.epoch!==previous.epoch||value.seq!==(previous.seq||0)+1){await syncCatalog(true);await saveMeta('event-cursor',{epoch:value.epoch,seq:value.seq-1});}
   const db=await opening,tx=db.transaction('meta','readwrite'),completion=done(tx),store=tx.objectStore('meta');
   if(value.event?.type==='nativeChanged'&&value.event.cacheKey)store.put({key:'invalid:'+value.event.cacheKey,value:{revision:value.event.revision,generation:value.event.generation}});
   store.put({key:'event-cursor',value:{epoch:value.epoch,seq:value.seq}});await completion;memoryMeta.set('event-cursor',{epoch:value.epoch,seq:value.seq});
   socket.send(JSON.stringify({type:'ack',seq:value.seq}));
   replicaChanged(value.event);broadcast?.postMessage({type:'sync-event',event:value.event});
  }).catch(()=>socket.close());});
  const heartbeat=setInterval(()=>{if(socket.readyState===1)socket.send(JSON.stringify({type:'ping'}));},20000);
  socket.addEventListener('close',()=>{clearInterval(heartbeat);if(eventsSocket===socket)eventsSocket=null;clearTimeout(eventsRetry);eventsRetry=setTimeout(()=>connectEvents().catch(()=>{}),2000);});
  await new Promise(resolve=>socket.addEventListener('close',resolve,{once:true}));
 }
 const catalog={readPage:catalogPage,readEntries,readStatus:status,setSourceEnabled:async()=>{},
  async requestSync(){const cached=await status();syncCatalog(true).catch(()=>{});return cached;},async requestStartupSync(){const generation=await meta('catalog-generation').catch(()=>null);if(generation){const cached=await status();syncCatalog(true).catch(()=>{});return cached;}return syncCatalog(true).catch(()=>status());},
  subscribeStatus(callback){statusSubscribers.add(callback);status().then(callback);},unsubscribeStatus(){statusSubscribers.clear();},
  subscribeThreadObservations(callback){observationSubscribers.add(callback);catalogPage({limit:50}).then(p=>callback({hostId:'local',threads:p.entries.map(e=>e.nativeThread).filter(Boolean)}));},unsubscribeThreadObservations(){observationSubscribers.clear();},
  notifyThread:()=>syncCatalog(true).catch(()=>{}),invalidateSource:()=>syncCatalog(true).catch(()=>{}),removeMissingEntry:async()=>false};
 function rememberHistoryCursors(id,result){if(!id||result?.thread?.id!==id||typeof result.itemsBackwardsCursor!=='string')return;saveMeta('history-cursors:'+id,{itemsBackwardsCursor:result.itemsBackwardsCursor,turnsBackwardsCursor:result.turnsBackwardsCursor??null,confirmedAt:Date.now()}).catch(()=>{});}
 window.__BETTER_CODEX_IPC_CACHE_RESPONSE__=payload=>{
  // Persist only the user's dismissal timestamp; execution permissions do not change.
  if(payload?.type==='persisted-atom-sync'||payload?.type==='persisted-atom-updated'&&payload.key===warningDismissKey){
   const remote=payload.type==='persisted-atom-sync'?(payload.atoms||payload.state)?.[warningDismissKey]:payload.value;
   if(Number.isFinite(remote)&&remote>0&&remote>(localWarningDismissedAt||0))persistAtom({key:warningDismissKey,value:remote}).catch(()=>{});
   if(Number.isFinite(localWarningDismissedAt)&&localWarningDismissedAt>0){
    if(payload.type==='persisted-atom-sync'){payload.state={...payload.state,[warningDismissKey]:localWarningDismissedAt};payload.atoms={...payload.atoms,[warningDismissKey]:localWarningDismissedAt};}
    else{payload.value=localWarningDismissedAt;payload.deleted=false;}
    return true;
   }
  }
  if(payload?.type==='pinned-threads-updated'){pinnedEpoch++;pinnedDirty=true;pinnedCheckedAt=0;}
  if(payload?.type==='mcp-notification'&&['thread/reverted','thread/compacted'].includes(payload.method))saveMeta('history-cursors:'+payload.params?.threadId,null).catch(()=>{});
  if(payload?.type==='mcp-response'){const message=payload.message,id=resumeReads.get(message?.id);resumeReads.delete(message?.id);if(id&&!message.error)rememberHistoryCursors(id,message.result);}

  if(payload?.type==='codex-app-server-initialized')saveMeta('native-initialization',payload).catch(()=>{});
  if(payload?.type==='codex-app-server-connection-changed'){window.__BETTER_CODEX_NATIVE_ONLINE__=payload.state==='connected';invalidateReadChecks();if(payload.state!=='connected'){resetPinnedReads();resetStableIpc();}}
  if(payload?.type==='mcp-response'){const message=payload.message,key=rpcReads.get(message?.id);rpcReads.delete(message?.id);if(key&&!message.error)saveMeta(key,message.result).catch(()=>{});}
  if(payload?.type==='fetch-response'){const shared=stableIpcPending.get(payload.requestId);if(shared){stableIpcPending.delete(payload.requestId);if(payload.responseType==='success')try{stableIpcChecked.set(shared.key,{value:JSON.parse(payload.bodyJsonString),at:Date.now()});}catch{}for(const waiter of shared.waiters)waiter.emit('fetch-response',{...payload,requestId:waiter.id});}}
  if(payload?.type==='fetch-response'){const key=ipcReads.get(payload.requestId),pin=pinnedRequests.get(payload.requestId);ipcReads.delete(payload.requestId);pinnedRequests.delete(payload.requestId);if(key&&payload.responseType==='success')try{const value=JSON.parse(payload.bodyJsonString);if(pin){if(pin.epoch===pinnedEpoch){saveMeta(key,value).then(()=>{if(pin.epoch!==pinnedEpoch)return;pinnedDirty=false;pinnedCheckedAt=Date.now();warmPinned(value).catch(()=>{});broadcast?.postMessage({type:'pinned-cache',key});if(pin.previous!=null&&pin.previous!==JSON.stringify(value))pin.emit('pinned-threads-updated',{});}).catch(()=>{});}}else saveMeta(key,value).catch(()=>{});}catch{}}
 };
 window.__BETTER_CODEX_IPC_CACHE__=async(channel,payload,emit)=>{
  const config=window.__CODEX_WEB_CONFIG__||{};
  // official-front's shared objects are a fixed scoped bootstrap snapshot; it
  // does not register these subscriptions or mutate them. Keep the same reply locally.
  if(channel==='codex_desktop:message-from-view'&&config.sharedObjectSnapshot&&['shared-object-subscribe','shared-object-unsubscribe'].includes(payload?.type)){
   diagnostics.localSharedNotifications++;if(payload.type==='shared-object-subscribe'){const key=payload.key||payload.objectId;emit('shared-object-updated',{key,value:config.sharedObjectSnapshot[key]});}return {handled:true,value:null};
  }
  const label=payload?.type==='fetch'?String(payload.url||'').replace(/^vscode:\/\/codex\//,''):payload?.type||channel;diagnostics.ipc[label]=(diagnostics.ipc[label]||0)+1;
  if(channel==='codex_desktop:worker:git:from-view'&&window.__BETTER_CODEX_EXECUTION_CONNECTED__===false){if(payload?.type==='worker-request')emit('codex_desktop:worker:git:for-view',{type:'worker-response',workerId:'git',response:{id:payload.request.id,method:payload.request.method,result:{type:'error',error:'Git 实时状态需要连接 Mac'}}});return {handled:true,value:null};}
  if((payload?.type==='mcp-request'&&['thread/start','thread/resume'].includes(payload.request?.method)||payload?.type==='thread-prewarm-start')&&window.__BETTER_CODEX_EXECUTION_CONNECTED__!==true){try{await waitForExecution();}catch(error){emit('mcp-response',{hostId:'local',message:{id:payload.request?.id,error:{code:-32000,message:error.message,data:{status:503,notSubmitted:true}}}});return {handled:true,value:null};}}
  if(payload?.type==='mcp-request'&&payload.request?.method==='thread/resume'){resumeReads.set(payload.request.id,payload.request.params?.threadId);while(resumeReads.size>100)resumeReads.delete(resumeReads.keys().next().value);}
  if(payload?.type==='mcp-request'&&AUX.has(payload.request?.method)){rpcReads.set(payload.request.id,'aux:'+JSON.stringify([payload.request.method,canonical(payload.request.params||{})]));while(rpcReads.size>500)rpcReads.delete(rpcReads.keys().next().value);}
  if(payload?.type==='mcp-request'&&window.__BETTER_CODEX_EXECUTION_CONNECTED__===false){const request=payload.request,method=request?.method,params=request?.params||{};
   if(READS.has(method)||AUX.has(method)){try{let result;if(READS.has(method)){const record=await get(readKey(method,params));if(record&&!record.deleted)result=record.payload.result;}
     else result=await meta('aux:'+JSON.stringify([method,canonical(params)]))??config.betterCodexReadDefaults?.[method];
     if(result===undefined){diagnostics.misses++;throw Error('这项内容尚未保存在本机缓存');}diagnostics.hits++;
     emit('mcp-response',{hostId:'local',message:{id:request.id,result}});
    }catch(error){emit('mcp-response',{hostId:'local',message:{id:request.id,error:{code:-32000,message:error.message,data:{status:503}}}});}
    return {handled:true,value:null};
   }
   emit('mcp-response',{hostId:'local',message:{id:request.id,error:{code:-32000,message:'当前为缓存阅读；连接 Mac 后可继续任务',data:{status:503}}}});return {handled:true,value:null};
  }
  if(payload?.type==='thread-prewarm-start'&&window.__BETTER_CODEX_EXECUTION_CONNECTED__===false){emit('mcp-response',{hostId:'local',message:{id:payload.request?.id,error:{code:-32000,message:'当前为缓存阅读',data:{status:503}}}});return {handled:true,value:null};}
  if(window.__BETTER_CODEX_EXECUTION_CONNECTED__===false){
   const direct={'codex_desktop:get-initial-sidebar-bootstrap':config.initialSidebarBootstrap,'codex_desktop:get-shared-object-snapshot':config.sharedObjectSnapshot,'codex_desktop:get-build-flavor':'prod','codex_desktop:get-system-theme-variant':matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light','codex_desktop:get-sentry-init-options':null};
   if(Object.hasOwn(direct,channel))return {handled:true,value:direct[channel]};
   if(payload?.type==='persisted-atom-sync-request'){const atoms={...config.persistedAtomSnapshot,...await restoreAtoms().catch(()=>({}))};emit('persisted-atom-sync',{state:atoms,atoms});return {handled:true,value:null};}
   if(['ready','view-ready'].includes(payload?.type)){const initialized=await meta('native-initialization').catch(()=>null);if(initialized)emit('codex-app-server-initialized',{...initialized,isSnapshot:true});emit('codex-app-server-connection-changed',{hostId:'local',state:'connected',transport:'websocket',isSnapshot:true});return {handled:true,value:null};}
  }
  // Non-request view notifications have no remote work while this transport
  // is disconnected. Avoid a retry/log storm against an absent front.
  if(payload?.type!=='fetch'){if(window.__BETTER_CODEX_EXECUTION_CONNECTED__===false&&payload?.type!=='persisted-atom-update')return {handled:true,value:null};return null;}const method=String(payload.url||'').replace(/^vscode:\/\/codex\//,'');if(!IPC_READS.has(method)){if(window.__BETTER_CODEX_EXECUTION_CONNECTED__===false){emit('fetch-response',{requestId:payload.requestId,responseType:'error',status:503,error:'这项操作需要连接 Mac'});return {handled:true,value:null};}return null;}
  let input={};try{input=typeof payload.body==='string'?JSON.parse(payload.body):payload.body||{};}catch{}const params=input.params||input,key='ipc:'+JSON.stringify([method,canonical(params)]);ipcReads.set(payload.requestId,key);while(ipcReads.size>500)ipcReads.delete(ipcReads.keys().next().value);
  if(method==='list-pinned-threads'&&window.__BETTER_CODEX_EXECUTION_CONNECTED__!==false){
   pinnedEmit=emit;const saved=await meta(key).catch(()=>undefined),locked=await meta('auth-locked').catch(()=>false);
   if(saved!==undefined&&!pinnedDirty&&!locked){diagnostics.hits++;emit('fetch-response',{requestId:payload.requestId,responseType:'success',status:200,headers:{'content-type':'application/json'},bodyJsonString:JSON.stringify(saved)});warmPinned(saved).catch(()=>{});
    if(pinnedRequests.size||Date.now()-pinnedCheckedAt<60000){ipcReads.delete(payload.requestId);return {handled:true,value:null};}
    // The renderer has its cached answer; this original READ continues only to validate it.
    pinnedRequests.set(payload.requestId,{key,epoch:pinnedEpoch,previous:JSON.stringify(saved),emit});return null;
   }
   pinnedRequests.set(payload.requestId,{key,epoch:pinnedEpoch,previous:null,emit});while(pinnedRequests.size>100)pinnedRequests.delete(pinnedRequests.keys().next().value);
  }
  if(window.__BETTER_CODEX_EXECUTION_CONNECTED__!==false&&STABLE_IPC.has(method)){
   const saved=stableIpcChecked.get(key);if(saved&&Date.now()-saved.at<60000){diagnostics.ipcStableHits++;ipcReads.delete(payload.requestId);emit('fetch-response',{requestId:payload.requestId,responseType:'success',status:200,headers:{'content-type':'application/json'},bodyJsonString:JSON.stringify(saved.value)});return {handled:true,value:null};}
   for(const entry of stableIpcPending.values())if(entry.key===key){entry.waiters.push({id:payload.requestId,emit});ipcReads.delete(payload.requestId);diagnostics.coalesced++;return {handled:true,value:null};}
   stableIpcPending.set(payload.requestId,{key,waiters:[]});
  }
  if(window.__BETTER_CODEX_EXECUTION_CONNECTED__!==false)return null;
  let cached=await meta(key).catch(()=>undefined);
  // The renderer connects to this local READ facade; nativeOnline stays false.
  // All execution methods are rejected until the real Mac connection returns.
  if(method==='app-server-connection-state')cached={state:'connected',progress:null,error:null};
  if(cached===undefined&&method==='get-global-state')cached={value:config.initialSidebarBootstrap?.globalStateEntries?.find(e=>e.key===params.key)?.value??null};
  if(cached===undefined&&method==='paths-exist')cached={existingPaths:(params.paths||[]).filter(path=>(config.workspaceRoots||[]).includes(path))};
  if(cached===undefined&&method==='developer-instructions')cached={instructions:typeof params.baseInstructions==='string'?params.baseInstructions:''};
  if(cached===undefined&&method==='git-origins')cached={origins:{}};
  if(cached===undefined&&method==='get-copilot-api-proxy-info')cached=null;
  if(cached!==undefined){emit('fetch-response',{requestId:payload.requestId,responseType:'success',status:200,headers:{'content-type':'application/json'},bodyJsonString:JSON.stringify(cached)});return {handled:true,value:null};}
  emit('fetch-response',{requestId:payload.requestId,responseType:'error',status:503,error:'这项内容尚未缓存，需要连接 Mac'});return {handled:true,value:null};
 };
 // Wait only BEFORE a new operation is submitted. Never retry an accepted or unknown write.
 function waitForExecution(signal){
  if(signal?.aborted)return Promise.reject(Error('操作已取消，尚未发送'));
  if(navigator.onLine&&window.__BETTER_CODEX_EXECUTION_CONNECTED__===true)return Promise.resolve();
  if(!navigator.onLine)return Promise.reject(Error('设备离线，操作尚未发送；可继续阅读缓存'));
  return new Promise((resolve,reject)=>{
   let timer,finished=false;
   const finish=error=>{if(finished)return;finished=true;clearTimeout(timer);for(const type of ['betterCodex:execution-state','betterCodex:session-ready','offline','betterCodex:authentication-required'])removeEventListener(type,changed);signal?.removeEventListener?.('abort',cancel);error?reject(error):resolve();};
   const cancel=()=>finish(Error('操作已取消，尚未发送'));
   const changed=event=>{if(event?.type==='betterCodex:authentication-required')return finish(Error('登录已过期，操作尚未发送'));if(!navigator.onLine)return finish(Error('设备离线，操作尚未发送；可继续阅读缓存'));if(window.__BETTER_CODEX_EXECUTION_CONNECTED__===true)finish();};
   for(const type of ['betterCodex:execution-state','betterCodex:session-ready','offline','betterCodex:authentication-required'])addEventListener(type,changed);
   signal?.addEventListener?.('abort',cancel,{once:true});
   timer=setTimeout(()=>finish(Error('Mac 连接尚未恢复，操作未发送；草稿已保留')),30000);
   try{window.__BETTER_CODEX_RECONNECT_TRANSPORT__?.();}catch{}changed();
  });
 }
 const disposable=value=>Object.assign(value,{[Symbol.dispose]:()=>{}});
 const rpcValue=value=>{if(value&&typeof value==='object'&&typeof value[Symbol.dispose]!=='function')Object.defineProperty(value,Symbol.dispose,{value:()=>{},configurable:true});return value;};
 const rpcLocal=service=>{for(const key of Object.keys(service)){const method=service[key];if(typeof method!=='function')continue;service[key]=(...args)=>{const result=method(...args);return result?.then?disposable(Promise.resolve(result).then(rpcValue)):rpcValue(result);};}return rpcValue(service);};
 function remote(name,method,args){let call;const promise=Promise.resolve().then(()=>{if(!navigator.onLine||window.__BETTER_CODEX_EXECUTION_CONNECTED__===false)throw Error('Mac 暂未连接，仅可阅读缓存和保存草稿');return remoteServices;}).then(services=>{const service=services[name];if(!service?.[method])throw Error('这项操作需要 Mac 连接');call=service[method](...args);return call;});promise[Symbol.dispose]=()=>call?.[Symbol.dispose]?.();return promise;}
 const proxy=name=>new Proxy({},{get:(_,method)=>method==='then'?undefined:method===Symbol.dispose?()=>{}:(...args)=>remote(name,method,args)});
 window.__BETTER_CODEX_LOCAL_APP_HOST__=async remotePromise=>{
  diagnostics.hostCreated=true;remoteReady=false;remoteServices=Promise.resolve(remotePromise).then(value=>{remoteReady=true;return value;});remoteServices.catch(()=>{});try{await opening;}catch{return remoteServices;}
  const services=Object.fromEntries(['httpFetch','threadProjectAssignments','clipboard','workspaceFiles','fileAttachments','dynamicToolCalls','clientCoordination'].map(name=>[name,proxy(name)]));
  services.httpFetch={cancel:async()=>{},fetch(id,request){let u;try{u=new URL(request.url);}catch{return disposable(Promise.resolve(disposable({error:'无效地址',status:403})));}let data=null;
   if(u.hostname==='ab.chatgpt.com'&&u.pathname.replace(/\/+$/,'')==='/v1/initialize'){const feature_gates=Object.fromEntries(['580984490','3125406982'].map(name=>[name,{name,value:true,rule_id:'local_native_question_ui',secondary_exposures:[]}]));data={has_updates:true,time:Date.now(),hash_used:'djb2',feature_gates,dynamic_configs:{},layer_configs:{'72216192':{name:'72216192',value:{enable_i18n:true,locale_source:'IDE'},rule_id:'local_language',secondary_exposures:[]}},param_stores:{},exposures:{},sdk_flags:{}};}
   else if((u.hostname==='ab.chatgpt.com'&&u.pathname==='/v1/rgstr')||(u.hostname==='chatgpt.com'&&['/ces/v1/rgstr','/ces/v1/log_event'].includes(u.pathname)))data={};
   return disposable(Promise.resolve(disposable(data?{response:new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}})}:{error:'此工作台未开放云端 ChatGPT HTTP 通道',status:403})));
  }};
  services.localThreadCatalog=catalog;services.startup={whenReady:async()=>{},reach:()=>{}};services.appInfo={get:async()=>({version:'26.901.51231',buildFlavor:'prod',buildNumber:null})};
  services.clientCoordination=new Proxy({},{get:(_,method)=>method==='then'?undefined:method===Symbol.dispose?()=>{}:(...args)=>{
   if(remoteReady)return remote('clientCoordination',method,args);
   const value=method==='findThreadOwner'?null:method==='getIdeContext'?{ideContext:null}:method==='requestThreadFollower'?{type:'response',resultType:'error',requestId:'',error:'native-offline'}:undefined;
   return disposable(Promise.resolve(rpcValue(value)));
  }});
  const settingListeners=new Map();
  let settingsEpoch=0,settingsCacheWrites=Promise.resolve();
  const cacheSettings=fn=>{const task=settingsCacheWrites.catch(()=>{}).then(fn);settingsCacheWrites=task;return task;};
  const cacheSetting=(key,value)=>cacheSettings(async()=>{const all=structuredClone(await meta('settings')||{values:{},configuredValues:{}});all.values={...all.values,[key]:value.effective};all.configuredValues={...all.configuredValues,[key]:value.configured};await saveMeta('settings',all);});
  const notifySetting=(key,value)=>{for(const callback of settingListeners.get(key)||[])Promise.resolve().then(()=>callback(value)).catch(()=>{});};
  services.settings={
   async readAll(){const cached=await meta('settings')||{values:{followUpQueueMode:'steer',...window.__CODEX_WEB_CONFIG__?.betterCodexSettings},configuredValues:{...window.__CODEX_WEB_CONFIG__?.betterCodexSettings}};refreshOnce('settings',30000,async()=>{diagnostics.settingsRefreshes++;const epoch=settingsEpoch;return {epoch,value:await remote('settings','readAll',[])};},result=>cacheSettings(async()=>{if(result.epoch===settingsEpoch)await saveMeta('settings',result.value);})).catch(()=>{});const key='enabled-reasoning-efforts',levels=cached.values?.[key]||['low','medium','high','xhigh','ultra','persistent'];return {...cached,values:{...cached.values,[key]:[...new Set([...levels.filter(x=>!['ultra','persistent'].includes(x)),'max',...levels.filter(x=>['ultra','persistent'].includes(x))])]}};},
   async read(key){const value=(await services.settings.readAll());return {effective:value.values[key],configured:value.configuredValues[key]};},
   async write(key,value){settingsEpoch++;await remote('settings','write',[key,value]);settingsEpoch++;invalidateReadChecks();await cacheSetting(key,{effective:value,configured:value});notifySetting(key,{effective:value,configured:value});},
   async subscribe(key,callback){let subscription=null,closed=false;let listeners=settingListeners.get(key);if(!listeners){listeners=new Set();settingListeners.set(key,listeners);}const localCallback=value=>{if(!closed)return callback(value);};listeners.add(localCallback);await callback(await services.settings.read(key));remote('settings','subscribe',[key,async value=>{settingsEpoch++;invalidateReadChecks();await cacheSetting(key,value);if(!closed){if(key==='enabled-reasoning-efforts')callback(await services.settings.read(key));else callback(value);}}]).then(s=>{subscription=s;if(closed)s.dispose();}).catch(()=>{});return {dispose(){closed=true;listeners.delete(localCallback);if(!listeners.size)settingListeners.delete(key);subscription?.dispose();},unsubscribe(){this.dispose();},[Symbol.dispose](){this.dispose();}};}
  };
  services.requestUserInputAutoResolution={async setConversationPresented(p){if(p.hostId!=='local')throw Error('工作区宿主不匹配');if(p.presented&&/^[0-9a-f-]{36}$/i.test(p.conversationId)){const url=new URL('/local/'+p.conversationId,location.origin);url.searchParams.set('workspace',scope.id);if(window.__BETTER_CODEX_NATIVE_SIDEBAR__?.isList)url.searchParams.set('nativeList','1');const routeChanged=location.href!==url.href;history.replaceState(history.state,'',url.href);if(routeChanged)window.dispatchEvent(new CustomEvent('betterCodex:native-route',{detail:{path:url.pathname}}));hydrateCachedThread(p.conversationId).catch(()=>{});}if(window.__BETTER_CODEX_EXECUTION_CONNECTED__===true)remote('requestUserInputAutoResolution','setConversationPresented',[p]).catch(()=>{});},async recordConversationActivity(p){if(window.__BETTER_CODEX_EXECUTION_CONNECTED__===true)remote('requestUserInputAutoResolution','recordConversationActivity',[p]).catch(()=>{});}};
  for(const name of ['localThreadCatalog','startup','appInfo','settings','httpFetch','requestUserInputAutoResolution'])rpcLocal(services[name]);
  return rpcValue(services);
 };
 window.__BETTER_CODEX_INSTALL_NATIVE_READ_CACHE__=client=>{
  const target=client.requestClient;if(client.hostId!=='local'||!target||installed.has(target))return;installed.add(target);nativeClient=client;window.__BETTER_CODEX_NATIVE_STATUS_RECOVERY__?.register(client);const original=target.sendRequest.bind(target);
  // Rendering may use a cached head. Sending must consult the current Native
  // turn before the official coordinator chooses queue, steer, or start.
  client.betterCodexReadExecutionHead=async id=>{
   await waitForExecution();
   const stamp=nativeEventEpoch.get(id)||0;
   const [head,page]=await Promise.all([original('thread/read',{threadId:id,includeTurns:false}),original('thread/turns/list',{threadId:id,limit:1,sortDirection:'desc',itemsView:'summary'})]);
   if(head?.thread?.id!==id||!Array.isArray(page?.data))throw Error('当前轮次尚未核实，草稿已保留');
   const latest=page.data[0],activeTurnId=latest?.status==='inProgress'?latest.id:null;
   if(head.thread.status?.type==='active'&&!activeTurnId)throw Error('当前轮次正在变化，请稍后重试；草稿已保留');
   if(stamp!==(nativeEventEpoch.get(id)||0))return {isCurrent:()=>false};
   const conversation=client.getConversation?.(id),turns=conversation?.turnHistory?.kind==='canonical'?Object.values(conversation.turnHistory.history.entitiesByKey||{}):conversation?.turns||[];
   client.onNotification?.('thread/status/changed',{threadId:id,status:head.thread.status});
   if(activeTurnId){
    if(!turns.some(turn=>turn.turnId===activeTurnId))client.onNotification?.('turn/started',{threadId:id,turn:latest});
    client.updateTurnState?.(id,activeTurnId,turn=>{turn.status='inProgress';if(Number.isFinite(latest.startedAt))turn.turnStartedAtMs=latest.startedAt*1000;});
   }else if(latest&&['completed','failed','interrupted'].includes(latest.status)){
    // Update display state directly; never synthesize completion notifications.
    client.updateTurnState?.(id,latest.id,turn=>{turn.status=latest.status;});
   }
   const settled=nativeEventEpoch.get(id)||0;
   return {activeTurnId,isCurrent:()=>settled===(nativeEventEpoch.get(id)||0)};
  };

  // Read-only quota facade; persist only display fields, never account or reset-credit IDs.
  let quotaPending=null;
  const quotaDisplay=result=>({buckets:Object.values({...((result.rateLimits)?{[result.rateLimits.limitId||'codex']:result.rateLimits}:{}),...result.rateLimitsByLimitId}).map(b=>({id:b.limitId,name:b.limitName||'Codex',plan:b.planType,primary:b.primary,secondary:b.secondary,credits:b.credits?{unlimited:b.credits.unlimited,balance:b.credits.balance}:null})),resetsAvailable:result.rateLimitResetCredits?.availableCount});
  const rememberQuota=async result=>{const snapshot={data:quotaDisplay(result),checkedAt:Date.now()};await saveMeta('account-quota-v1',snapshot);window.dispatchEvent(new CustomEvent('betterCodex:quota-updated',{detail:snapshot}));return snapshot;};
  window.__BETTER_CODEX_READ_ACCOUNT_LIMITS__=async()=>{
   if(!navigator.onLine||window.__BETTER_CODEX_EXECUTION_CONNECTED__!==true)throw Error('连接恢复后可刷新额度');
   if(!quotaPending)quotaPending=original('account/rateLimits/read',{}).then(rememberQuota).finally(()=>{quotaPending=null;});
   return quotaPending;
  };
  client.addNotificationCallback?.('account/rateLimits/updated',()=>window.dispatchEvent(new Event('betterCodex:quota-invalidated')));
  client.addNotificationCallback?.('thread/started',({params})=>listableThread(params.thread));
  client.addNotificationCallback?.('turn/started',({params})=>{if(params.threadId)listableThread({id:params.threadId,status:{type:'active'}});});
  for(const method of ['item/started','item/completed','item/agentMessage/delta','item/reasoning/textDelta','item/commandExecution/outputDelta','turn/started','turn/completed','thread/reverted'])client.addNotificationCallback?.(method,({params})=>{if(params.threadId){nativeActivity.set(params.threadId,Date.now());nativeEventEpoch.set(params.threadId,(nativeEventEpoch.get(params.threadId)||0)+1);}});
  // RpcTarget exposes prototype methods only; instance functions are rejected before dispatch.
  const rendererMethods=Object.create(Object.getPrototypeOf(client));Object.setPrototypeOf(client,rendererMethods);
  const userStopIntents=new Map();
  const older=client.loadOlderConversationHistoryPage?.bind(client);
  if(older)Object.defineProperty(rendererMethods,'loadOlderConversationHistoryPage',{value:async function(id,related=[],options={}){
   if(!androidReader&&window.__BETTER_CODEX_EXECUTION_CONNECTED__===true)return older(id,related,options);
   if(!client.getConversation?.(id)?.turnsPagination)await client.hydrateBackgroundThreads([id],{includeTurns:true,maxTurns:6,refreshTurns:true});return Promise.all([id,...related].map(threadId=>client.loadOlderConversationTurnsPage(threadId,options)));
  }});
  // Native normally broadcasts protocol capabilities after its socket hello.
  // Offline reads still need the last verified pagination format, not a guessed
  // unbounded thread/read fallback. This does not mark the Mac online.
  const protocolReady=meta('native-initialization').then(initialized=>{if(initialized&&!target.getAppServerVersion?.()){target.setAppServerVersion?.(initialized.appServerVersion);diagnostics.cachedProtocol=true;window.__codexWebBridgeHelpers?.deliverLocalRendererMessage?.('codex-app-server-initialized',{...initialized,isSnapshot:true});}}).catch(()=>{});
  protocolReady.then(()=>{const id=location.pathname.match(/^\/local\/([0-9a-f-]{36})$/i)?.[1];if(id&&window.__BETTER_CODEX_NATIVE_ONLINE__===false)queueMicrotask(()=>hydrateCachedThread(id).catch(()=>{}));});
  const interrupt=client.interruptConversation?.bind(client);if(interrupt)Object.defineProperty(rendererMethods,'interruptConversation',{value:async function(id,reason='system',expected){
   if(reason!=='user-stop'){window.__BETTER_CODEX_CLIENT_LOG__?.event('execution_control',{method:'turn/interrupt',threadId:id,turnId:expected,reason});return interrupt(id,reason,expected);}
   const turnId=expected??client.turnCoordinator?.options.submissionHost.getActiveTurnId(id);
   if(!turnId){window.__BETTER_CODEX_CLIENT_LOG__?.event('execution_control',{method:'turn/interrupt',threadId:id,reason:'no_active_turn'});throw Error('当前执行回合尚未确认，请刷新后再停止');}
   const pending=userStopIntents.get(id);if(pending){window.__BETTER_CODEX_CLIENT_LOG__?.event('execution_control',{method:'turn/interrupt',threadId:id,turnId,reason:'stop_coalesced'});if(pending.turnId!==turnId)throw Error('上一回合的停止仍在确认，不会停止新回合');return pending.promise;}
   const intent={turnId,promise:null};userStopIntents.set(id,intent);window.__BETTER_CODEX_CLIENT_LOG__?.event('execution_control',{method:'turn/interrupt',threadId:id,turnId,reason});
   const boundedExpected=expected??(client.getConversation(id)?.threadGoal?.status==='active'?undefined:turnId);
   intent.promise=Promise.resolve().then(()=>interrupt(id,reason,boundedExpected)).catch(error=>{window.__BETTER_CODEX_CLIENT_LOG__?.event('execution_control',{method:'turn/interrupt',threadId:id,turnId,reason:'failed'});throw error;}).finally(()=>{if(userStopIntents.get(id)===intent)userStopIntents.delete(id);});return intent.promise;
  }});
  target.sendRequest=async(method,params={},options)=>{
   if(method==='turn/interrupt'){const intent=userStopIntents.get(params.threadId);if(intent&&params.turnId!==intent.turnId){window.__BETTER_CODEX_CLIENT_LOG__?.event('execution_control',{method,threadId:params.threadId,turnId:params.turnId,reason:'stop_target_changed'});throw Error('停止目标已改变，旧停止操作不会作用于新回合');}}
   if(['turn/interrupt','thread/stop'].includes(method))window.__BETTER_CODEX_CLIENT_LOG__?.event('execution_control',{method,threadId:params.threadId,turnId:params.turnId,reason:'dispatch'});
   await protocolReady;
   diagnostics.rpc[method]=(diagnostics.rpc[method]||0)+1;
   if(method==='config/batchWrite'){
    const edits=params.edits;if(params.filePath!=null||params.expectedVersion!=null||!Array.isArray(edits)||!edits.length||edits.length>2||edits.some(e=>!['model','model_reasoning_effort'].includes(e.keyPath)||!['upsert','replace'].includes(e.mergeStrategy)||typeof e.value!=='string'||!e.value.trim()||e.value.length>256))throw Error('这里只允许调整本次新会话的模型与推理强度');
    const next={...composerModel};for(const edit of edits)next[edit.keyPath]=edit.value;composerModel=next;invalidateReadChecks();return {status:'ok',version:'betterCodex-composer-local-v1',filePath:null};
   }
   if(READS.has(method))return (await read(method,params)).result;
   if(AUX.has(method)){const key='aux:'+JSON.stringify([method,canonical(params)]),cached=await meta(key).catch(()=>undefined)??(window.__BETTER_CODEX_NATIVE_ONLINE__===false?window.__CODEX_WEB_CONFIG__?.betterCodexReadDefaults?.[method]:undefined),ttl=['model/list','modelProvider/capabilities/read','collaborationMode/list','permissionProfile/list','configRequirements/read'].includes(method)?30000:2000;
    const refresh=()=>refreshOnce(key,cached===undefined?0:ttl,()=>{diagnostics.auxRefreshes++;return original(method,params,options);},value=>saveMeta(key,value));
    if(cached!==undefined){if(navigator.onLine&&window.__BETTER_CODEX_EXECUTION_CONNECTED__===true)refresh().catch(()=>{});return method==='config/read'?composerConfig(structuredClone(cached)):listResult(method,structuredClone(cached));}const value=await refresh();return method==='config/read'?composerConfig(value):listResult(method,value);}
   if(['thread/start','thread/resume'].includes(method))await waitForExecution(options?.signal);
   if(method==='thread/start'){
    // The fixed host owns execution policy. Cached renderer preferences are display-only.
    const live=await original('config/read',{includeLayers:false},options),c=live?.config;
    if(!['danger-full-access','workspace-write','read-only'].includes(c?.sandbox_mode)||c.approval_policy==null)throw Error('无法核实当前宿主执行策略，草稿已保留');
    params={...params,sandbox:c.sandbox_mode,approvalPolicy:c.approval_policy};delete params.sandboxPolicy;delete params.permissions;
    if(c.approvals_reviewer!=null)params.approvalsReviewer=c.approvals_reviewer;else delete params.approvalsReviewer;
    window.__BETTER_CODEX_CLIENT_LOG__?.event('policy_aligned',{method,policy:c.sandbox_mode});
   }
   if(!navigator.onLine||window.__BETTER_CODEX_EXECUTION_CONNECTED__!==true)throw Error('Mac 暂未连接，操作尚未发送；草稿已保留');let result;try{result=await original(method,params,options);if(['turn/interrupt','thread/stop'].includes(method))window.__BETTER_CODEX_CLIENT_LOG__?.event('execution_control',{method,threadId:params.threadId,turnId:params.turnId,reason:'accepted'});}catch(error){if(['turn/interrupt','thread/stop'].includes(method))window.__BETTER_CODEX_CLIENT_LOG__?.event('execution_control',{method,threadId:params.threadId,turnId:params.turnId,reason:'failed'});if(['thread/resume','thread/start'].includes(method)){const text=String(error?.message||''),failureClass=/沙箱策略|执行策略|权限配置/.test(text)?'policy_mismatch':/too many open files|os error 24/i.test(text)?'host_resources':/writer|owner|already.*use|占用/i.test(text)?'writer_busy':/timeout|timed out|超时/i.test(text)?'timeout':/connect|socket|连接/i.test(text)?'connection':'native_rejected';diagnostics.executionFailure={at:Date.now(),method,failureClass,uiVersion:window.__BETTER_CODEX_UI_RELEASE__?.version};saveMeta('last-execution-failure',diagnostics.executionFailure).catch(()=>{});window.__BETTER_CODEX_CLIENT_LOG__?.event('execution_failed',{method,failureClass,threadId:params.threadId});}throw error;}invalidateReadChecks();if(method==='thread/resume')rememberHistoryCursors(params.threadId,result);return result;
  };
  let refreshTimer;for(const method of ['turn/completed','thread/reverted'])client.addNotificationCallback?.(method,({params})=>{if(location.pathname!=='/local/'+params.threadId)return;clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{if(androidReader){refreshForeground(true).catch(()=>{});return;}for(const key of pendingReads.keys())if(key.includes(params.threadId))return;fetchRead('thread/read',{threadId:params.threadId,includeTurns:false},true).then(()=>client.hydrateBackgroundThreads?.([params.threadId],{includeTurns:true,maxTurns:1})).catch(()=>{});},300);});
 };
 // The Android renderer is a reader of other owners too. Reconcile the visible
 // history even when its event stream missed an update or its body was resumed.
 const androidReader=!!window.BETTER_CODEXAndroid||/BETTER_CODEXAndroid/i.test(navigator.userAgent)||document.documentElement.dataset.betterCodexAndroid==='1';
 let foregroundRefresh=null,foregroundChecked=0,foregroundId='';
 const rendererPrepared=new Map(),rendererPending=new Map(),rendererQueue=new Set();let rendererTimer=null,rendererBusy=false;
 function queueCachedPreparation(id){if(!androidReader)return;rendererQueue.add(id);scheduleCachedPreparation();}
 function scheduleCachedPreparation(){if(rendererTimer||rendererBusy||!rendererQueue.size)return;rendererTimer=setTimeout(async()=>{rendererTimer=null;if(!nativeClient||document.visibilityState!=='visible'||Date.now()-lastForeground<1800||foregroundFreshReads.size){scheduleCachedPreparation();return;}const id=[...rendererQueue].sort((a,b)=>Number(priorityPinned.has(b))-Number(priorityPinned.has(a)))[0];rendererQueue.delete(id);rendererBusy=true;try{await prepareCachedConversation(id);}catch{diagnostics.rendererPrepareFailedAt=Date.now();}finally{rendererBusy=false;}scheduleCachedPreparation();},200);}
 async function prepareCachedConversation(id){
  if(!androidReader||!nativeClient)return;if(rendererPending.has(id))return rendererPending.get(id);
  const work=(async()=>{const snapshot=await window.__BETTER_CODEX_READ_COMMITTED_HISTORY__(id);if(!snapshot||rendererPrepared.get(id)===snapshot.stamp||(nativeActivity.get(id)||0)>snapshot.confirmedAt)return;const guard=()=>document.visibilityState==='visible'&&(nativeActivity.get(id)||0)<=snapshot.confirmedAt;
   await nativeClient.hydrateBackgroundThreads([id],{includeTurns:true,maxTurns:20,refreshTurns:'betterCodex_local_cache',refreshGuard:guard,cachedSnapshot:snapshot});if(snapshot.applied&&guard()&&nativeClient.getConversation?.(id)?.turnsPagination){rendererPrepared.set(id,snapshot.stamp);if(rendererPrepared.size>100)rendererPrepared.delete(rendererPrepared.keys().next().value);diagnostics.rendererPrepared=(diagnostics.rendererPrepared||0)+1;}
  })().finally(()=>rendererPending.delete(id));rendererPending.set(id,work);return work;
 }
 window.__BETTER_CODEX_PREPARE_CACHED_CONVERSATION__=prepareCachedConversation;
 const committedApplied=new Map();let committedTimer=null,committedPending=false,committedRefresh=null,committedRefreshId='';
 window.__BETTER_CODEX_READ_COMMITTED_HISTORY__=async(id,{touch=true,headRecord,turnRecord,itemRecords,eventEpoch}={})=>{
  const readRecord=key=>get(key,{touch});
  const generation=await meta('catalog-generation'),head=headRecord??await readRecord(readKey('thread/read',{threadId:id,includeTurns:false})),catalog=await readRecord('thread:'+id);
  const candidates=turnRecord?[turnRecord]:await Promise.all([[2,'full'],[20,'summary'],[12,'notLoaded'],[6,'notLoaded'],[1,'notLoaded']].map(async([limit,itemsView])=>readRecord(readKey('thread/turns/list',{threadId:id,limit,sortDirection:'desc',itemsView}))));
  for(const record of candidates.filter(r=>r&&!r.deleted&&(!generation||r.sourceGeneration===generation)).sort((a,b)=>b.revision-a.revision)){
   const headBase=head&&!head.deleted&&head.sourceGeneration===record.sourceGeneration&&head.generation===record.generation?head.payload.result:null,catalogThread=catalog&&!catalog.deleted&&catalog.sourceGeneration===record.sourceGeneration&&catalog.generation===record.generation?catalog.payload?.nativeThread:null;
   const base=!headRecord&&catalogThread&&(!headBase?.thread||catalogThread.updatedAt>headBase.thread.updatedAt)?{...headBase,thread:catalogThread}:headBase;
   if(base?.thread?.id!==id||!Array.isArray(record.payload?.result?.data))continue;
   const page=structuredClone(record.payload.result),pagination={};let complete=true,stamp=record.sourceGeneration+':'+record.revision+':'+base.thread.updatedAt;
   for(const turn of page.data){
    if(turn.itemsView==='full'&&Array.isArray(turn.items))continue;
    let items=itemRecords?.get(turn.id)||null;
    for(const limit of items?[]:[...new Set([window.__BETTER_CODEX_HISTORY_POLICY__?.initialTurnItems||48,48,20,40,100])]){
     const value=await readRecord(readKey('thread/items/list',{threadId:id,turnId:turn.id,limit,sortDirection:'desc'}));
     if(value&&!value.deleted&&value.sourceGeneration===record.sourceGeneration&&value.generation===record.generation&&Array.isArray(value.payload?.result?.data)&&(!items||value.revision>items.revision)){items=value;}
    }
    if(items&&!itemRecords?.has(turn.id)&&turn.itemsView!=='notLoaded'&&items.revision<record.revision)items=null;
    if(!items){if(turn.itemsView==='notLoaded'){complete=false;break;}continue;}
    // The tail page can omit the opening prompt. Preserve the official
    // pagination metadata from Native's summary instead of losing that input.
    const summaryOpening=(turn.items||[]).find(value=>value.type==='userMessage')||candidates.filter(value=>value&&!value.deleted&&value.sourceGeneration===record.sourceGeneration&&value.generation===record.generation).flatMap(value=>value.payload?.result?.data||[]).find(value=>value.id===turn.id&&(value.items||[]).some(item=>item.type==='userMessage'))?.items.find(value=>value.type==='userMessage');
    const firstPage=summaryOpening?null:await readRecord(readKey('thread/items/list',{threadId:id,turnId:turn.id,limit:2,sortDirection:'asc'}));
    const opening=summaryOpening||(firstPage&&!firstPage.deleted&&firstPage.sourceGeneration===record.sourceGeneration&&firstPage.generation===record.generation?firstPage.payload?.result?.data?.map(value=>value.item||value).find(value=>value.type==='userMessage'):null);
    turn.items=items.payload.result.data.slice().reverse().map(v=>v.item||v);turn.itemsView=items.payload.result.nextCursor?'summary':'full';
    pagination[turn.id]={olderCursor:items.payload.result.nextCursor||null,isLoadingOlder:false,hasLoadedOldest:!items.payload.result.nextCursor,newestSnapshotItemId:turn.items.at(-1)?.id,...(opening?{oldestUserInput:opening.content,openingUserMessageId:opening.id}:{})};stamp+=':'+items.revision+':'+(opening?.id||'');
   }
   if(complete)return {verifiedNative:!!headRecord&&!!turnRecord&&[headRecord,turnRecord,...(itemRecords?.values()||[])].every(r=>(r.source==null||r.source==='native')&&r.sourceGeneration===record.sourceGeneration&&r.generation===record.generation),eventEpoch,applied:false,response:base,page,itemsPaginationByTurnId:pagination,stamp,revision:record.revision,generation:record.generation,confirmedAt:typeof record.confirmedAt==='number'?record.confirmedAt:Date.parse(record.confirmedAt)||0};
  }
  return null;
 };
 function scheduleCommitted(){committedPending=true;if(committedTimer)return;committedTimer=setTimeout(()=>{committedTimer=null;refreshCommitted().catch(()=>{});},300);}
 async function refreshCommitted(freshSnapshot){
  if(!androidReader||!nativeClient||document.visibilityState!=='visible'||window.__BETTER_CODEX_NATIVE_SIDEBAR__?.isList)return;
  const id=location.pathname.split('/')[2];if(!/^[0-9a-f-]{36}$/i.test(id||''))return;
  if(committedRefresh&&committedRefreshId===id){await committedRefresh;if(!freshSnapshot)return;}
  committedPending=false;committedRefreshId=id;
  const work=(async()=>{
   const snapshot=freshSnapshot??await window.__BETTER_CODEX_READ_COMMITTED_HISTORY__(id);
   if(!snapshot)return;
   const fresh=!!snapshot.verifiedNative,epoch=snapshot.eventEpoch??(nativeEventEpoch.get(id)||0);
   const guard=()=>location.pathname==='/local/'+id&&document.visibilityState==='visible'&&(nativeEventEpoch.get(id)||0)===epoch&&(fresh||(nativeActivity.get(id)||0)<=snapshot.confirmedAt);
   if(!guard()){window.__BETTER_CODEX_CLIENT_LOG__?.event('history_rejected',{threadId:id,revision:snapshot.revision,reason:'live_event_superseded'});return;}
   if(!fresh&&committedApplied.get(id)===snapshot.stamp&&!!document.querySelector('[data-app-action-timeline-scroll] [data-local-conversation-item-target-ids]'))return;
   const started=Date.now();snapshot.applied=false;
   await nativeClient.hydrateBackgroundThreads([id],{includeTurns:true,maxTurns:20,refreshTurns:'betterCodex_local_cache',refreshGuard:guard,cachedSnapshot:snapshot});
   if(snapshot.applied&&guard()){committedApplied.set(id,snapshot.stamp);window.__BETTER_CODEX_CLIENT_LOG__?.event('history_applied',{threadId:id,revision:snapshot.revision,turnCount:snapshot.page.data.length,generation:snapshot.generation});diagnostics.committedRefreshedAt=Date.now();window.__BETTER_CODEX_PERF__?.event('cached_view',{source:'indexeddb',durationMs:Date.now()-started});}else window.__BETTER_CODEX_CLIENT_LOG__?.event('history_rejected',{threadId:id,revision:snapshot.revision,reason:guard()?'hydrate_not_applied':'live_event_superseded'});
  })().catch(()=>{diagnostics.committedRefreshFailedAt=Date.now();}).finally(()=>{if(committedRefresh===work)committedRefresh=null;if(committedPending)scheduleCommitted();});
  committedRefresh=work;return work;
 }
 async function refreshForeground(force=false){
  if(!androidReader||!nativeClient||document.visibilityState!=='visible'||!navigator.onLine||(window.__BETTER_CODEX_NATIVE_ONLINE__===false&&window.__BETTER_CODEX_EXECUTION_CONNECTED__!==true)||window.__BETTER_CODEX_NATIVE_SIDEBAR__?.isList)return;
  const id=location.pathname.match(/^\/local\/([0-9a-f-]{36})$/i)?.[1];if(!id)return;
  if(foregroundRefresh&&foregroundId===id)return foregroundRefresh;
  if(!force&&id===foregroundId&&Date.now()-foregroundChecked<10000)return;
  foregroundId=id;foregroundChecked=Date.now();
  const work=(async()=>{
   // Fetch a new committed snapshot independently; keep the already painted one.
   const eventEpoch=nativeEventEpoch.get(id)||0;
   const [headRecord,summaryRecord]=await Promise.all([fetchRead('thread/read',{threadId:id,includeTurns:false},true),fetchRead('thread/turns/list',{threadId:id,limit:20,sortDirection:'desc',itemsView:'summary'},true)]);
   // Keep official legacy/full and durable/item pagination separate. Only the
   // latest two full turns are read; Native's older-turn cursor stays intact.
   const turnRecord=headRecord.payload?.result?.thread?.historyMode==='legacy'
    ?await fetchRead('thread/turns/list',{threadId:id,limit:2,sortDirection:'desc',itemsView:'full'},true):summaryRecord;
   const itemRecords=new Map(await Promise.all((turnRecord.payload?.result?.data||[]).slice(0,2).filter(turn=>turn.itemsView!=='full').map(async turn=>[turn.id,await fetchRead('thread/items/list',{threadId:id,turnId:turn.id,limit:48,sortDirection:'desc'},true)])));
   const snapshot=await window.__BETTER_CODEX_READ_COMMITTED_HISTORY__(id,{headRecord,turnRecord,itemRecords,eventEpoch});
   if(!snapshot?.verifiedNative){window.__BETTER_CODEX_CLIENT_LOG__?.event('history_rejected',{threadId:id,reason:'freshness_unverified'});return;}
   if(location.pathname==='/local/'+id){await refreshCommitted(snapshot);diagnostics.foregroundRefreshedAt=Date.now();diagnostics.foregroundThread=id;}
  })().catch(()=>{diagnostics.foregroundRefreshFailedAt=Date.now();window.__BETTER_CODEX_CLIENT_LOG__?.event('sync_failed',{threadId:id});}).finally(()=>{if(foregroundRefresh===work)foregroundRefresh=null;});
  foregroundRefresh=work;return work;
 }
 function refreshEntry(force=false){queueMicrotask(async()=>{await refreshCommitted();refreshForeground(force);});}
 for(const type of ['betterCodex:native-route','betterCodex:session-ready','betterCodex:conversation-ready','betterCodex:connection-state','focus','pageshow','online'])addEventListener(type,()=>refreshEntry(type!=='betterCodex:conversation-ready'));
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshEntry(true)});
 addEventListener('betterCodex:history-updated',event=>{const id=event.detail?.threadId;if(id&&location.pathname==='/local/'+id){if(androidReader){if(event.detail?.source==='android')scheduleCommitted();else refreshEntry();}else nativeClient?.hydrateBackgroundThreads?.([id],{includeTurns:true,maxTurns:1}).catch(()=>{});}});
 // Cache only scoped, credential-free bootstrap data. Tokens remain in RAM.
 let bootstrapValue=window.__CODEX_WEB_CONFIG__;
 Object.defineProperty(window,'__CODEX_WEB_CONFIG__',{configurable:true,get:()=>bootstrapValue,set:value=>{if(value?.initialSidebarBootstrap)value={...value,initialSidebarBootstrap:{...value.initialSidebarBootstrap,catalogEntries:(value.initialSidebarBootstrap.catalogEntries||[]).filter(listableEntry)}};bootstrapValue=value;if(value){const copy=structuredClone(value);if(copy.gatewayWsUrl){const u=new URL(copy.gatewayWsUrl);u.search='';copy.gatewayWsUrl=u.href;}saveMeta('bootstrap',copy).catch(()=>{});}}});
 if(bootstrapValue)window.__CODEX_WEB_CONFIG__=bootstrapValue;
 broadcast?.addEventListener('message',event=>{if(event.data?.type==='pinned-cache'){memoryMeta.delete(event.data.key);pinnedEpoch++;pinnedDirty=false;pinnedCheckedAt=Date.now();pinnedEmit?.('pinned-threads-updated',{});}if(event.data?.type==='sync-event'){memoryMeta.delete('event-cursor');replicaChanged(event.data.event);}if(event.data?.type==='history'&&event.data.threadId===location.pathname.split('/')[2]){scheduleCommitted();refreshForeground();}if(event.data?.type==='catalog'){memoryMeta.delete('catalog-generation');memoryMeta.delete('catalog-cursor');memoryMeta.delete('catalog-status');catalogRevision=Math.max(catalogRevision,event.data.revision||0);notifyStatus();}});
 addEventListener('betterCodex:authentication-required',()=>saveMeta('auth-locked',true).catch(()=>{}));
 addEventListener('offline',()=>{resetPinnedReads();resetStableIpc();invalidateReadChecks();});
 addEventListener('betterCodex:session-ready',()=>{pinnedCheckedAt=0;pinnedEmit?.('pinned-threads-updated',{});});
 let lastCatalogPoll=0;
 const startSync=(event)=>{if(event?.type){invalidateReadChecks();stableIpcChecked.clear();}const interval=eventsSocket?.readyState===1?30000:5000;if(event?.type||Date.now()-lastCatalogPoll>=interval){lastCatalogPoll=Date.now();syncCatalog().catch(()=>{});}else diagnostics.catalogPollSkipped++;connectEvents().catch(()=>{});};addEventListener('online',startSync);addEventListener('focus',startSync);addEventListener('betterCodex:session-ready',startSync);addEventListener('pageshow',startSync);document.addEventListener('resume',startSync);document.addEventListener('visibilitychange',event=>{if(document.visibilityState==='visible')startSync(event);});
 const timer=setInterval(()=>{if(document.visibilityState==='visible'){startSync();refreshForeground();}},5000);
 const evictTimer=setInterval(()=>evict().catch(()=>{}),60000);

 // Read-only device inspection. Never fetch, hydrate, or touch eviction recency.
 function localCacheActivity(){
  const visible=window.__BETTER_CODEX_NATIVE_SIDEBAR__?.isList?null:location.pathname.split('/')[2];
  const queued=[...backgroundQueue];let reason=null;
  if(document.visibilityState!=='visible')reason='hidden';
  else if(!navigator.onLine)reason='offline';
  else if(window.__BETTER_CODEX_NATIVE_ONLINE__===false)reason='host_offline';
  else if(navigator.connection?.saveData)reason='save_data';
  else if(foregroundFreshReads.size)reason='foreground';
  else if(Date.now()-lastForeground<1800)reason='interaction';
  else if(queued.length&&!queued.some(id=>id!==visible))reason='visible';
  else if(queued.length&&!queued.some(id=>id!==visible&&Date.now()-(backgroundLast.get(id)||0)>10000))reason='backoff';
  return {busy:backgroundBusy,currentThread:diagnostics.background.currentThread||null,stage:diagnostics.background.stage||null,
   queued,pending:queued.length,preparing:[...rendererPending.keys()],prepareQueued:rendererQueue.size,reason,
   failures:[...backgroundErrors].map(([id,value])=>({id,...value})),nativeReady:!!nativeClient,androidReader};
 }
 async function inspectLocalCache(){
  if(await meta('auth-locked'))throw Error('请先登录后查看本机缓存');
  const db=await opening,generation=await meta('catalog-generation'),entries=new Map(),usage=new Map();let bytes=0,turnCount=0,itemCount=0;
  const scan=(source,visit,range)=>new Promise((resolve,reject)=>{const request=source.openCursor(range);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const cursor=request.result;if(!cursor)return resolve();visit(cursor.value);cursor.continue();};});
  await Promise.all([
   scan(db.transaction('records','readonly').objectStore('records').index('kind'),record=>{
    if(record.kind!=='catalog'||record.deleted||record.scope!==scope.id||hiddenThreads.has(record.payload?.threadId))return;
    if(generation&&record.sourceGeneration!==generation)return;const entry=record.payload;if(entry?.threadId)entries.set(entry.threadId,entry);
   },IDBKeyRange.only('catalog')),
   scan(db.transaction('usage','readonly').objectStore('usage'),value=>{
    if(!value.threadId)return;let row=usage.get(value.threadId);if(!row){row={bytes:0,turns:0,items:0,hasHistory:false};usage.set(value.threadId,row);}
    const size=Math.max(0,Number(value.bytes)||0);bytes+=size;row.bytes+=size;
    if(value.key.startsWith('turn:')){row.turns++;turnCount++;row.hasHistory=true;}
    else if(value.key.startsWith('item:')){row.items++;itemCount++;row.hasHistory=true;}
    else if(value.key.startsWith('read:'))try{const [method,params]=JSON.parse(value.key.slice(5));if(method==='thread/turns/list'||method==='thread/items/list'||method==='thread/read'&&params.includeTurns)row.hasHistory=true;}catch{}
   })
  ]);
  const recent=[...entries.values()].sort((a,b)=>(b.sourceUpdatedAt||b.sourceRecencyAt||0)-(a.sourceUpdatedAt||a.sourceRecencyAt||0)).slice(0,PREWARM_RECENT).map(entry=>entry.threadId);
  const targets=[...new Set([...priorityPinned,...recent,...knownRunning,...backgroundQueue])].filter(id=>!hiddenThreads.has(id));
  const rows=targets.map(id=>{const entry=entries.get(id),saved=usage.get(id);return {id,title:entry?.displayTitle||entry?.nativeThread?.name||'未命名会话',pinned:priorityPinned.has(id),stored:!!saved?.hasHistory,turns:saved?.turns||0,items:saved?.items||0,bytes:saved?.bytes||0,headReady:false,renderReady:false,confirmedAt:0};});
  let index=0;
  await Promise.all(Array.from({length:Math.min(2,rows.length)},async()=>{while(index<rows.length){const row=rows[index++];const snapshot=await window.__BETTER_CODEX_READ_COMMITTED_HISTORY__(row.id,{touch:false});row.headReady=!!snapshot;row.confirmedAt=snapshot?.confirmedAt||0;row.localNewer=!!snapshot&&(nativeActivity.get(row.id)||0)>snapshot.confirmedAt;if(snapshot&&nativeClient?.getConversation?.(row.id)?.turnsPagination){row.renderReady=(rendererPrepared.get(row.id)===snapshot.stamp||committedApplied.get(row.id)===snapshot.stamp)&&(nativeActivity.get(row.id)||0)<=snapshot.confirmedAt;}}}));
  return {scope:scope.id,at:Date.now(),catalogCount:entries.size,historyThreadCount:[...usage.values()].filter(row=>row.hasHistory).length,bytes,turnCount,itemCount,
   recentLimit:PREWARM_RECENT,targets:rows,headReady:rows.filter(row=>row.headReady).length,renderReady:rows.filter(row=>row.renderReady).length,
   androidImportedCursor:await meta('android-replica-read-cursor-v1:'+scope.id)||0,androidImportedGeneration:await meta('android-replica-source-generation-v1:'+scope.id)||'',activity:localCacheActivity()};
 }
 window.__BETTER_CODEX_NATIVE_CACHE__={inspectLocalCache,localCacheActivity,canReload:()=>![...composerViews.values()].some(view=>Object.values(JSON.parse(view.fingerprint)).some(value=>Array.isArray(value)?value.length:value&&typeof value==='object'?Object.keys(value).length:!!value)),opening,meta,saveMeta,get,put,read,catalog,syncCatalog,readKey,recordCommand,pendingCommands,persistAtom,restoreAtoms,importSnapshot,diagnostics:()=>{const id=location.pathname.split('/')[2],c=nativeClient?.getConversation?.(id);return {...diagnostics,background:{...diagnostics.background,pending:backgroundQueue.size,busy:backgroundBusy},nativeClient:!!nativeClient,remoteReady,online:window.__BETTER_CODEX_NATIVE_ONLINE__,executionConnected:window.__BETTER_CODEX_EXECUTION_CONNECTED__,nativeVersion:nativeClient?.requestClient?.getAppServerVersion?.(),turns:c?.turns?.length,historyKind:c?.turnHistory?.kind,historyEntities:Object.keys(c?.turnHistory?.history?.entitiesByKey||{}).length,resumeState:c?.resumeState,statusRecovery:window.__BETTER_CODEX_NATIVE_STATUS_RECOVERY__?.diagnostics()};},async close(){clearTimeout(rendererTimer);clearInterval(backgroundScanTimer);clearTimeout(committedTimer);clearTimeout(backgroundTimer);clearInterval(timer);clearInterval(evictTimer);clearTimeout(eventsRetry);eventsSocket?.close();broadcast?.close();(await opening).close();}};
})();

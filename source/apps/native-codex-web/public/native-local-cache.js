// Complete native DTOs and catalog metadata, committed with their cursor.
// This module never queues an execution or treats cached data as a write ACK.
(()=>{
 const scope=window.__DSH_SCOPE__;if(!scope)return;
 let composerModel={model:'gpt-6.1-sol',model_reasoning_effort:'max'};
 // A task's read-only model label is separate from execution settings. Never
 // populate latestCollaborationMode from a history cache: turn/start consumes it.
 const readModels=new Map(),readModelListeners=new Map();
 window.__DSH_USE_READ_MODEL__=(React,id)=>React.useSyncExternalStore(callback=>{let listeners=readModelListeners.get(id);if(!listeners){listeners=new Set();readModelListeners.set(id,listeners);}listeners.add(callback);return()=>{listeners.delete(callback);if(!listeners.size)readModelListeners.delete(id);};},()=>readModels.get(id)??null,()=>null);
 const rememberReadModel=(id,thread)=>{
  if(thread?.id!==id||typeof thread.model!=='string'||!thread.model.trim()||thread.reasoningEffort!=null&&!['none','minimal','low','medium','high','xhigh','max','ultra','persistent'].includes(thread.reasoningEffort))return;
  const effort=thread.reasoningEffort??null,prior=readModels.get(id);if(prior?.model===thread.model&&prior?.reasoningEffort===effort)return;
  readModels.set(id,{model:thread.model,reasoningEffort:effort});while(readModels.size>500){const oldest=readModels.keys().next().value;readModels.delete(oldest);for(const listener of readModelListeners.get(oldest)||[])listener();}for(const listener of readModelListeners.get(id)||[])listener();
 };
 const composerConfig=value=>value?.config?{...value,config:{...value.config,...composerModel}}:value;
 const refreshModelDirectory=()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'ipc-broadcast',method:'query-cache-invalidate',params:{queryKey:['models','list']}}}));
 const refreshComposer=()=>{for(const key of ['user-saved-config','config'])window.dispatchEvent(new MessageEvent('message',{data:{type:'ipc-broadcast',method:'query-cache-invalidate',params:{queryKey:[key]}}}));refreshModelDirectory();};
 // The renderer can start from an offline model/list snapshot. Once Native
 // returns, invalidate that discovery query without changing a draft's choice.
 let modelDirectoryConnected=window.__DSH_EXECUTION_CONNECTED__===true;
 addEventListener('dsh:execution-state',()=>{const connected=window.__DSH_EXECUTION_CONNECTED__===true;if(connected&&!modelDirectoryConnected)refreshModelDirectory();modelDirectoryConnected=connected;});
 window.__DSH_RESET_NEW_CHAT_MODEL__=()=>{composerModel={model:'gpt-6.1-sol',model_reasoning_effort:'max'};window.__DSH_NEW_CHAT_MODEL_RESET_GENERATION__=(window.__DSH_NEW_CHAT_MODEL_RESET_GENERATION__??0)+1;window.dispatchEvent(new CustomEvent('dsh:new-chat-model-reset'));refreshComposer();};
 const READS=new Set(['thread/read','thread/turns/list','thread/items/list']);
 const AUX=new Set(['getAuthStatus','config/read','model/list','modelProvider/capabilities/read','account/read','account/rateLimits/read','configRequirements/read','experimentalFeature/list','remoteControl/status/read','collaborationMode/list','permissionProfile/list','thread/list','thread/loaded/list','skills/list','app/list','mcpServerStatus/list']);
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,canonical(v[k])])):v;
 const normalize=(method,params)=>{const p={...(params||{})};if(p.cursor==null)delete p.cursor;if(method==='thread/read'&&p.includeTurns===undefined)p.includeTurns=false;if(method==='thread/turns/list'){p.limit=Math.min(20,Math.max(1,Number(p.limit)||12));p.itemsView??='summary';p.sortDirection??='desc';}if(method==='thread/items/list'){p.limit=Math.min(100,Math.max(1,Number(p.limit)||40));p.sortDirection??='asc';if(p.turnId==null)delete p.turnId;}return p;};
 const stableItemHead=p=>'stable-item-head:'+JSON.stringify([p.threadId,p.turnId,p.limit,p.sortDirection]);
 const readKey=(method,params)=>'read:'+JSON.stringify([method,canonical(normalize(method,params))]);
 const requestValue=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const done=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('本机缓存未能提交'));tx.onerror=()=>{};});
 const opening=new Promise((resolve,reject)=>{const r=indexedDB.open('dsh-native-v1-'+scope.id,5);r.onupgradeneeded=()=>{const db=r.result;
  if(!db.objectStoreNames.contains('records')){const records=db.createObjectStore('records',{keyPath:'key'});records.createIndex('kind','kind');records.createIndex('recency',['kind','recency','key']);records.createIndex('accessed',['kind','accessedAt']);}
  const catalogStore=r.transaction.objectStore('records');if(!catalogStore.indexNames.contains('created'))catalogStore.createIndex('created',['kind','createdAt','key']);if(!catalogStore.indexNames.contains('updated'))catalogStore.createIndex('updated',['kind','updatedAt','key']);const catalogUpgrade=catalogStore.index('kind').openCursor(IDBKeyRange.only('catalog'));catalogUpgrade.onsuccess=()=>{const c=catalogUpgrade.result;if(!c)return;const v=c.value;c.update({...v,createdAt:v.payload?.sourceCreatedAt||0,updatedAt:v.payload?.sourceUpdatedAt||0});c.continue();};
  for(const name of ['meta','catalog-stage','drafts','commands'])if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:'key'});
  const commandStore=r.transaction.objectStore('commands');if(!commandStore.indexNames.contains('state'))commandStore.createIndex('state','state');
  if(!db.objectStoreNames.contains('aliases')){const aliases=db.createObjectStore('aliases',{keyPath:'key'}),rKeys=r.transaction.objectStore('records').openKeyCursor();rKeys.onsuccess=()=>{const c=rKeys.result;if(!c)return;const key=c.primaryKey;if(typeof key==='string'&&key.startsWith('read:'))try{const [method,params]=JSON.parse(key.slice(5)),normalized=readKey(method,params);if(normalized!==key)aliases.put({key:normalized,target:key});}catch{}c.continue();};}
  if(!db.objectStoreNames.contains('usage')){const usage=db.createObjectStore('usage',{keyPath:'key'});usage.createIndex('accessedAt','accessedAt');const cursor=r.transaction.objectStore('records').openCursor();cursor.onsuccess=()=>{const c=cursor.result;if(!c)return;const v=c.value;if(['history','turn','item'].includes(v.kind)&&!v.deleted)usage.put({key:v.key,bytes:v.bytes||0,threadId:v.threadId,accessedAt:v.accessedAt||0});c.continue();};}
  };r.onsuccess=()=>{r.result.onversionchange=()=>r.result.close();resolve(r.result);};r.onerror=()=>reject(r.error);});
 const CACHE_IO_TIMEOUT_MS=1200;
 const CACHE_RETRY_BACKOFF_MS=5000;
 const openingState={ready:false,error:null,timedOutAt:0};
 opening.then(()=>{openingState.ready=true;openingState.timedOutAt=0;},error=>{openingState.error=error;});
 const cacheTimeout=(label)=>{const error=Error('本机缓存'+label+'超时');error.code='CACHE_TIMEOUT';return error;};
 const remaining=deadline=>Math.max(1,deadline-Date.now());
 function bounded(value,label,timeoutMs=CACHE_IO_TIMEOUT_MS,onTimeout){
  const ms=Math.max(1,Number(timeoutMs)||CACHE_IO_TIMEOUT_MS);
  return new Promise((resolve,reject)=>{let settled=false;const timer=setTimeout(()=>{if(settled)return;settled=true;try{onTimeout?.();}catch{}reject(cacheTimeout(label));},ms);
   Promise.resolve(value).then(result=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result);},error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);});
  });
 }
 async function cacheDb(timeoutMs=CACHE_IO_TIMEOUT_MS){
  if(openingState.error)throw openingState.error;
  if(!openingState.ready&&openingState.timedOutAt&&Date.now()-openingState.timedOutAt<CACHE_RETRY_BACKOFF_MS)throw cacheTimeout('初始化');
  return bounded(opening,'初始化',timeoutMs,()=>{if(!openingState.ready)openingState.timedOutAt=Date.now();});
 }
 const cacheRequest=(request,tx,label,timeoutMs)=>bounded(requestValue(request),label,timeoutMs,()=>{try{tx?.abort?.();}catch{}});
 const cacheCompletion=(tx,label,timeoutMs)=>bounded(done(tx),label,timeoutMs,()=>{try{tx?.abort?.();}catch{}});
 const readStoreValue=async(db,storeName,key,deadline,label)=>{const tx=db.transaction(storeName),request=tx.objectStore(storeName).get(key);return cacheRequest(request,tx,label,remaining(deadline));};
 const cacheCursor=(request,tx,label,timeoutMs,visit)=>bounded(new Promise((resolve,reject)=>{request.onerror=()=>reject(request.error);request.onsuccess=()=>{const cursor=request.result;if(!cursor)return resolve();try{if(visit(cursor)===false)return resolve();cursor.continue();}catch(error){reject(error);}};}),label,timeoutMs,()=>{try{tx?.abort?.();}catch{}});
 let memoryMeta=new Map(),volatileCatalog=null,catalogRevision=0,syncing=null,remoteServices=null,nativeClient=null,stopNativeAuthRecovery=null;
 let remoteReady=false,appHostGeneration=0,appHostError=null;const ipcReads=new Map(),rpcReads=new Map(),resumeReads=new Map();
 const appHostState=()=>{window.__DSH_APP_HOST_READY__=remoteReady;window.dispatchEvent(new CustomEvent('dsh:app-host-state'));};
 window.__DSH_RESET_APP_HOST__=()=>{appHostGeneration++;remoteReady=false;appHostError=null;resetAuxiliaryIpc();appHostState();};
 const hiddenThreads=new Set(),startedThreads=new Set();
 function listableThread(thread){
  if(!thread?.id)return true;
  const started=!!(thread.preview?.trim()||thread.name?.trim()||thread.turns?.length||thread.status?.type==='active');
  if(started)startedThreads.add(thread.id);
  const visible=startedThreads.has(thread.id);const changed=hiddenThreads.has(thread.id)===visible;
  if(visible)hiddenThreads.delete(thread.id);else hiddenThreads.add(thread.id);
  if(changed)queueMicrotask(()=>window.dispatchEvent(new Event('dsh:thread-list-visibility')));
  return visible;
 }
 const listableEntry=entry=>!entry?.nativeThread||listableThread(entry.nativeThread);
 const listResult=(method,value)=>method==='thread/list'&&value?{...value,data:(value.data||[]).filter(listableThread)}:value;
 window.__DSH_THREAD_LIST_VISIBILITY__={isHidden:id=>hiddenThreads.has(id),listableEntry};
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
 const auxiliaryIpcPending=new Map();
 const auxiliaryIpcId=(hostId,id)=>JSON.stringify([hostId||'local',id]);
 function completeAuxiliaryIpc(id,message,hostId,payload){const key=auxiliaryIpcId(hostId,id),shared=auxiliaryIpcPending.get(key);if(!shared||payload&&shared.payload!==payload)return;auxiliaryIpcPending.delete(key);for(const waiter of shared.waiters){rpcReads.delete(waiter.id);waiter.emit('mcp-response',{hostId:shared.hostId,message:{...structuredClone(message),id:waiter.id}});}}
 // A replaced AppHost has a new RPC lifetime. Retire only these pending reads;
 // never replay them or allow an old invocation failure to release a new leader.
 function resetAuxiliaryIpc(){const entries=[...auxiliaryIpcPending.values()];auxiliaryIpcPending.clear();for(const entry of entries){rpcReads.delete(entry.payload.request.id);entry.controller?.abort();const waiters=entry.controller?[{id:entry.payload.request.id,emit:entry.emit},...entry.waiters]:entry.waiters;for(const waiter of waiters){rpcReads.delete(waiter.id);waiter.emit('mcp-response',{hostId:entry.hostId,message:{id:waiter.id,error:{code:-32000,message:'读取连接已更换，请重试',data:{status:503}}}});}}}
 function resetStableIpc(){for(const [id,entry]of stableIpcPending){ipcReads.delete(id);for(const waiter of entry.waiters)waiter.emit('fetch-response',{requestId:waiter.id,responseType:'error',status:503,error:'连接正在恢复，请重试'});}stableIpcPending.clear();stableIpcChecked.clear();}
 // A successful host path descriptor is constant for this front epoch. It
 // is not a cached worktree status or an execution/permission decision.
 let hostPathEpoch=null,hostPaths=null;
 window.__DSH_HOST_METADATA_EPOCH__=epoch=>{if(typeof epoch==='string'&&epoch!==hostPathEpoch){hostPathEpoch=epoch;hostPaths=null;}};
 window.__DSH_READ_CODEX_HOME__=(hostId,read)=>hostId==='local'&&hostPaths?Promise.resolve(structuredClone(hostPaths)):read();
 addEventListener('dsh:authentication-required',()=>{hostPaths=null;hostPathEpoch=null;resetStableIpc();resetAuxiliaryIpc();});
 window.__DSH_IPC_CACHE_FAILURE__=(payload,error)=>{
  if(payload?.type==='mcp-request')completeAuxiliaryIpc(payload.request?.id,{error:{code:-32000,message:'读取连接已中断，请重试',data:{status:503}}},payload.hostId,payload);
  if(payload?.type!=='fetch')return;
  const id=payload.requestId,shared=stableIpcPending.get(id);stableIpcPending.delete(id);ipcReads.delete(id);pinnedRequests.delete(id);
  if(shared)for(const waiter of shared.waiters)waiter.emit('fetch-response',{requestId:waiter.id,responseType:'error',status:Number(error?.status)||503,error:String(error?.message||'连接读取失败，请重试')});
 };

 const IPC_READS=new Set(['get-global-state','get-configuration','get-settings','get-setting','account-info','os-info','locale-info','workspace-root-options','codex-home','home-directory','list-pinned-threads','list-automations','inbox-items','ide-context','app-server-connection-state','is-copilot-api-available','mcp-codex-config','worktree-shell-environment-config','paths-exist','developer-instructions','git-origins','get-copilot-api-proxy-info']);
 // This workspace's front owns one ordered local pin list; presentation hints do not change it.
 const ipcReadKey=(method,params)=>'ipc:'+JSON.stringify([method,canonical(method==='list-pinned-threads'&&(!params.hostId||params.hostId==='local')?{}:params)]);
 const pinnedRequests=new Map(),pinnedWarmed=new Set();let pinnedEpoch=0,pinnedDirty=false,pinnedCheckedAt=0,pinnedEmit=null,pinnedReadOrder=0,pinnedAcceptedOrder=0;const retiredPinnedReads=new Set();
 function resetPinnedReads(){for(const id of pinnedRequests.keys()){ipcReads.delete(id);retiredPinnedReads.add(id);}while(retiredPinnedReads.size>100)retiredPinnedReads.delete(retiredPinnedReads.values().next().value);pinnedRequests.clear();pinnedEpoch++;pinnedCheckedAt=0;}
 const statusSubscribers=new Set(),observationSubscribers=new Set(),installed=new WeakSet(),pendingReads=new Map();
 const offlineHydrated=new Set(),offlineHydrations=new Map();
 const broadcast=typeof BroadcastChannel==='function'?new BroadcastChannel('dsh-native-cache:'+scope.id):null;
 async function meta(key,{timeoutMs=CACHE_IO_TIMEOUT_MS}={}){if(memoryMeta.has(key))return memoryMeta.get(key);const deadline=Date.now()+timeoutMs,db=await cacheDb(remaining(deadline)),r=await readStoreValue(db,'meta',key,deadline,'读取缓存元数据');if(r)memoryMeta.set(key,r.value);return r?.value;}
 async function saveMeta(key,value,{timeoutMs=CACHE_IO_TIMEOUT_MS}={}){const deadline=Date.now()+timeoutMs,db=await cacheDb(remaining(deadline)),tx=db.transaction('meta','readwrite'),completion=cacheCompletion(tx,'写入缓存元数据',remaining(deadline));try{tx.objectStore('meta').put({key,value});await completion;memoryMeta.set(key,value);}catch(error){try{tx.abort?.();}catch{}await completion.catch(()=>{});throw error;}}
 // Only a server-confirmed ETag can make an online catalogue read a cache hit.
 // Keep the full Native page; none of these fields grants execution permission.
 const appCatalogWrites=new Map();
 const appCatalogKey=params=>{const p={...params};delete p.forceRefetch;return 'app-catalog-http-v1:'+JSON.stringify(['local',canonical(p)]);};
 const appCatalogHash=async value=>{if(!crypto.subtle?.digest)return null;return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),n=>n.toString(16).padStart(2,'0')).join('');};
 async function savedAppCatalog(params,deadlineAt){
  const value=await meta(appCatalogKey(params),deadlineAt?{timeoutMs:Math.min(CACHE_IO_TIMEOUT_MS,Math.max(1,deadlineAt-Date.now()))}:{}).catch(()=>null);
  if(!value||value.schemaVersion!==1||!/^"[a-f0-9]{64}"$/.test(value.etag)||!Array.isArray(value.result?.data)||typeof value.sha256!=='string')return null;
  return await appCatalogHash(value.result)===value.sha256?value:null;
 }
 async function conditionalAppCatalog(params,signal,deadlineAt){
  const key=appCatalogKey(params),write=Symbol();appCatalogWrites.set(key,write);
  try{
  const current=()=>{if(signal.aborted)throw Error('目录读取已取消');if(Date.now()>=deadlineAt)throw Object.assign(Error('目录读取确认超时，请重试'),{code:504});};current();
  const fresh=params.forceRefetch===true,saved=fresh?null:await savedAppCatalog(params,deadlineAt);current();
  const response=await window.__DSH_READ_APP_CATALOG__(params,{ifNoneMatch:saved?.etag??null,signal,fresh,deadlineAt});current();
  if(response?.status===304){if(!saved||response.etag!==saved.etag)throw Error('目录缓存版本不匹配，请重新读取');diagnostics.hits++;return structuredClone(saved.result);}
  if(response?.status!==200||!/^"[a-f0-9]{64}"$/.test(response.etag)||!Array.isArray(response.result?.data))throw Error('目录读取响应格式无效');
  const value=structuredClone(response.result),digest=await appCatalogHash(value);
  current();
  if(digest&&appCatalogWrites.get(key)===write)await saveMeta(key,{schemaVersion:1,etag:response.etag,sha256:digest,result:value},{timeoutMs:Math.min(CACHE_IO_TIMEOUT_MS,Math.max(1,deadlineAt-Date.now()))}).catch(()=>{diagnostics.catalogCacheFailures=(diagnostics.catalogCacheFailures||0)+1;});current();
  return structuredClone(value);
  }finally{if(appCatalogWrites.get(key)===write)appCatalogWrites.delete(key);}
 }
 async function get(key,{touch=true,timeoutMs=CACHE_IO_TIMEOUT_MS}={}){const deadline=Date.now()+timeoutMs,db=await cacheDb(remaining(deadline));let record=await readStoreValue(db,'records',key,deadline,'读取本机缓存');if(!record&&(key.startsWith('read:')||key.startsWith('stable-item-head:'))){const alias=await readStoreValue(db,'aliases',key,deadline,'读取缓存别名');if(alias)record=await readStoreValue(db,'records',alias.target,deadline,'读取缓存别名目标');}if(touch&&record?.kind==='history'&&!record.deleted){try{const tx=db.transaction('usage','readwrite');tx.objectStore('usage').put({key:record.key,bytes:record.bytes||0,threadId:record.threadId,accessedAt:Date.now()});cacheCompletion(tx,'更新缓存访问记录',Math.min(CACHE_IO_TIMEOUT_MS,remaining(deadline))).catch(()=>{});}catch{}}return record;}
 const IMPORT_KINDS=new Set(['catalog','history','turn','item','readAlias']),HISTORY_KINDS=new Set(['history','turn','item']);
 function stored(record){return {...record,recency:record.payload?.sourceRecencyAt||0,createdAt:record.payload?.sourceCreatedAt||0,updatedAt:record.payload?.sourceUpdatedAt||0,accessedAt:Date.now()};}
 const canReplace=(old,value)=>Number.isSafeInteger(value?.revision)&&(!old||!Number.isSafeInteger(old.revision)||old.revision<=value.revision);
 function entities(record){const result=record.payload?.result,params=record.payload?.params,method=record.payload?.method;if(!result||!params)return [];const values=[],id=params.threadId;
  const add=(key,kind,payload)=>values.push({...record,key,kind,payload,bytes:new TextEncoder().encode(JSON.stringify(payload)).length});
  for(const turn of (method==='thread/turns/list'?result.data:result.thread?.turns)||[]){const {items,...metadata}=turn;add('turn:'+id+':'+turn.id,'turn',{turn:metadata,itemsView:turn.itemsView||params.itemsView||(method==='thread/read'?'full':'summary')});if((turn.itemsView||params.itemsView||(method==='thread/read'?'full':'summary'))==='full')for(const item of items||[])add('item:'+id+':'+turn.id+':'+item.id,'item',{turnId:turn.id,item});}
  if(method==='thread/items/list')for(const value of result.data||[]){const item=value.item||value,turnId=value.turnId||params.turnId;if(turnId&&typeof item.id==='string')add('item:'+id+':'+turnId+':'+item.id,'item',{turnId,item});}return values;
 }
 async function putValues(tx,record,storeName='records',{deadline=Date.now()+CACHE_IO_TIMEOUT_MS,generationFence=null}={}){
  const store=tx.objectStore(storeName),usage=tx.objectStore('usage');
  for(const value of [record,...entities(record)]){
   if(value?.scope!==scope.id||!value?.key||!IMPORT_KINDS.has(value.kind)||typeof value.sourceGeneration!=='string'||!value.sourceGeneration||generationFence&&value.sourceGeneration!==generationFence)continue;
   const old=await cacheRequest(store.get(value.key),tx,'读取待写缓存记录',remaining(deadline));
   // `revision` is the server's monotonic commit order, including across a
   // thread rewrite. A late response from an older generation must therefore
   // lose to an already committed value even when its source generation is
   // otherwise valid for this cache.
   if(canReplace(old,value)){store.put(stored(value));if(HISTORY_KINDS.has(value.kind)){if(value.deleted)usage.delete(value.key);else usage.put({key:value.key,bytes:value.bytes||0,threadId:value.threadId,accessedAt:Date.now()});}}
  }
 }
 async function terminalItems(params,record,{timeoutMs=CACHE_IO_TIMEOUT_MS}={}){if(!record||!params.turnId)return false;const deadline=Date.now()+timeoutMs,generation=await meta('catalog-generation',{timeoutMs:remaining(deadline)});if(generation&&record.sourceGeneration!==generation)return false;const turn=await get('turn:'+params.threadId+':'+params.turnId,{touch:false,timeoutMs:remaining(deadline)});return turn?.payload?.turn?.status==='completed'&&turn.sourceGeneration===record.sourceGeneration&&turn.generation===record.generation;}
 async function put(record,{timeoutMs=CACHE_IO_TIMEOUT_MS,expectedGeneration=null}={}){if(!record?.key)return false;const deadline=Date.now()+timeoutMs;let stable=null;const method=record.payload?.method,params=method==='thread/items/list'?normalize(method,record.payload.params):null;
  if(params?.turnId&&params.cursor){try{if((await meta('history-cursors:'+params.threadId,{timeoutMs:remaining(deadline)}))?.itemsBackwardsCursor===params.cursor&&await terminalItems(params,record,{timeoutMs:remaining(deadline)}))stable=stableItemHead(params);}catch{}}
  const db=await cacheDb(remaining(deadline)),tx=db.transaction(['records','usage','aliases','meta'],'readwrite'),completion=cacheCompletion(tx,'写入本机缓存',remaining(deadline));
  try{
   const current=(await cacheRequest(tx.objectStore('meta').get('catalog-generation'),tx,'读取写入代际',remaining(deadline)))?.value||null;
   if(current&&expectedGeneration&&current!==expectedGeneration){await completion;return false;}
   const generationFence=expectedGeneration||current||record.sourceGeneration;
   await putValues(tx,record,'records',{deadline,generationFence});if(stable&&generationFence===record.sourceGeneration)tx.objectStore('aliases').put({key:stable,target:record.key});await completion;return true;
  }catch(error){try{tx.abort?.();}catch{}await completion.catch(()=>{});throw error;}
 }

 async function recordCommand(value,{timeoutMs=CACHE_IO_TIMEOUT_MS}={}){const deadline=Date.now()+timeoutMs,db=await cacheDb(remaining(deadline)),tx=db.transaction('commands','readwrite'),completion=cacheCompletion(tx,'记录待核对命令',remaining(deadline));try{tx.objectStore('commands').put({...value,key:value.id,at:Date.now()});await completion;}catch(error){try{tx.abort?.();}catch{}await completion.catch(()=>{});throw error;}}
 async function pendingCommands(threadId,{timeoutMs=CACHE_IO_TIMEOUT_MS}={}){const deadline=Date.now()+timeoutMs,db=await cacheDb(remaining(deadline)),tx=db.transaction('commands'),index=tx.objectStore('commands').index('state'),rows=(await Promise.all(['pending','unknown'].map(state=>cacheRequest(index.getAll(state),tx,'读取待核对命令',remaining(deadline))))).flat();return rows.filter(r=>['pending','unknown'].includes(r.state)&&(!threadId||r.threadId===threadId));}
 const warningDismissKey='full-access-warning-dismissed-at-v2',seenModelsKey='seen-model-upgrade-list';let localWarningDismissedAt=null,localSeenModels=[];
 const seenModels=value=>Array.isArray(value)&&value.length<=100&&value.every(x=>typeof x==='string'&&x.length>0&&x.length<=160)?[...new Set(value)]:null;
 async function persistAtom(update){
  if(typeof update.key!=='string'||update.key!==warningDismissKey&&update.key!==seenModelsKey&&!/^(?:composer-|prompt-history$|sidebar-|flat-project-sidebar-|unread-thread-)/.test(update.key))return false;
  if(update.key===seenModelsKey){const list=seenModels(update.value);if(update.recordUpdate||!update.deleted&&!list)return false;localSeenModels=update.deleted?[]:[...new Set([...localSeenModels,...list])];update={...update,value:localSeenModels};}
  if(update.key===warningDismissKey){if(update.recordUpdate||!update.deleted&&update.value!==null&&(!Number.isFinite(update.value)||update.value<0))return false;localWarningDismissedAt=update.deleted?null:update.value;}
  const deadline=Date.now()+CACHE_IO_TIMEOUT_MS,db=await cacheDb(remaining(deadline)),tx=db.transaction('drafts','readwrite'),completion=cacheCompletion(tx,'保存草稿',remaining(deadline)),store=tx.objectStore('drafts'),key='atom:'+update.key;let value=update.value;
  try{if(update.recordUpdate){const prior=await cacheRequest(store.get(key),tx,'读取草稿',remaining(deadline));value={...(prior?.value||{})};for(const[k,v]of Object.entries(update.recordUpdate.entries||{})){delete value[k];if(v!=null)value[k]=v.value;}}
   if(update.deleted)store.delete(key);else store.put({key,value,at:Date.now()});await completion;return true;
  }catch(error){try{tx.abort?.();}catch{}await completion.catch(()=>{});throw error;}
 }
 async function restoreAtoms({timeoutMs=CACHE_IO_TIMEOUT_MS}={}){const deadline=Date.now()+timeoutMs,db=await cacheDb(remaining(deadline)),tx=db.transaction('drafts'),rows=await cacheRequest(tx.objectStore('drafts').getAll(),tx,'读取草稿',remaining(deadline));const atoms=Object.fromEntries(rows.filter(r=>r.key.startsWith('atom:')).map(r=>[r.key.slice(5),r.value]));if(Number.isFinite(atoms[warningDismissKey]))localWarningDismissedAt=Math.max(localWarningDismissedAt||0,atoms[warningDismissKey]);localSeenModels=[...new Set([...localSeenModels,...seenModels(atoms[seenModelsKey])||[]])];if(localSeenModels.length)atoms[seenModelsKey]=localSeenModels;return atoms;}
 const composerViews=new Map(),viewFields=['imageAttachments','imageCommentDrafts','fileAttachments','pastedTextAttachments','addedFiles','appshotContexts','mcpAppModelContextAttachments','selectedTextAttachments','responseTextAnnotations'];
 window.__DSH_CACHE_COMPOSER_VIEW__=(key,value,restore)=>{
  const fields=Object.fromEntries(viewFields.filter(k=>value[k]!==undefined).map(k=>[k,value[k]])),fingerprint=JSON.stringify(fields);let view=composerViews.get(key);
  if(!view){view={fingerprint,loaded:false,restoring:false};composerViews.set(key,view);
   cacheDb().then(async db=>{const tx=db.transaction('drafts'),saved=await cacheRequest(tx.objectStore('drafts').get('view:'+key),tx,'读取编辑器附件草稿',CACHE_IO_TIMEOUT_MS);view.loaded=true;if(saved&&view.fingerprint===fingerprint){view.restoring=true;try{restore(saved.value);}finally{view.restoring=false;}}}).catch(()=>{view.loaded=true;});return;
  }
  const changed=view.fingerprint!==fingerprint;view.fingerprint=fingerprint;if(!view.loaded||view.restoring||!changed)return;
  cacheDb().then(async db=>{const tx=db.transaction('drafts','readwrite'),completion=cacheCompletion(tx,'保存编辑器附件草稿',CACHE_IO_TIMEOUT_MS);try{tx.objectStore('drafts').put({key:'view:'+key,value:fields,at:Date.now()});await completion;}catch{try{tx.abort?.();}catch{}await completion.catch(()=>{});}}).catch(()=>{});
 };
 async function evict(){const estimate=await navigator.storage?.estimate?.().catch(()=>null),budget=Math.min(androidReader?4*1024*1024*1024:128*1024*1024,Math.max(16*1024*1024,(estimate?.quota||512*1024*1024)*(androidReader?0.5:0.15))),deadline=Date.now()+CACHE_IO_TIMEOUT_MS,db=await cacheDb(remaining(deadline)),tx=db.transaction(['records','usage'],'readwrite'),completion=cacheCompletion(tx,'清理本机缓存',remaining(deadline)),store=tx.objectStore('records'),usage=tx.objectStore('usage');let total=0;const candidates=[];
  try{
   await cacheCursor(usage.index('accessedAt').openCursor(),tx,'读取缓存清理候选',remaining(deadline),cursor=>{const v=cursor.value;total+=v.bytes||0;candidates.push(v);});
   if(total>budget){const active=location.pathname.split('/')[2];for(const candidate of candidates.sort((a,b)=>Number(priorityPinned.has(a.threadId))-Number(priorityPinned.has(b.threadId)))){if(total<=budget*0.75)break;if(candidate.threadId===active)continue;if(priorityPinned.has(candidate.threadId)&&candidate.key.startsWith('read:')){try{const [method,params]=JSON.parse(candidate.key.slice(5));if(method==='thread/read'||method==='thread/turns/list'&&!params.cursor)continue;}catch{}}store.delete(candidate.key);usage.delete(candidate.key);total-=candidate.bytes;}}
   await completion;
  }catch(error){try{tx.abort?.();}catch{}await completion.catch(()=>{});throw error;}
 }

 async function durableCommitCatalog(page){
  // An empty, uninitialized source page carries no catalog snapshot. It can
  // report a fresh status/cursor boundary, but must never replace a valid
  // catalog already shown by the browser cache.
  if(page.generation==='uninitialized'&&!page.records.length&&!page.hasMore)return;
  if(!page.generation)return;
  const deadline=Date.now()+CACHE_IO_TIMEOUT_MS,current=await meta('catalog-generation',{timeoutMs:remaining(deadline)}),staging=current!==page.generation,db=await cacheDb(remaining(deadline));
  const tx=db.transaction(['records','meta','catalog-stage'],'readwrite'),completion=cacheCompletion(tx,'写入目录缓存',remaining(deadline)),records=tx.objectStore('records'),metadata=tx.objectStore('meta'),stage=tx.objectStore('catalog-stage');
  try{
   if(staging){const prior=await cacheRequest(metadata.get('stage-generation'),tx,'读取目录暂存代际',remaining(deadline));if(prior?.value!==page.generation){stage.clear();metadata.put({key:'stage-generation',value:page.generation});}}
   for(const record of page.records){if(record.scope!==scope.id||record.kind!=='catalog')throw Error('目录工作区或格式不匹配');const target=staging?stage:records,old=await cacheRequest(target.get(record.key),tx,'读取待写目录记录',remaining(deadline));if(canReplace(old,record))target.put(stored(record));}
   if(staging&&!page.hasMore){
    await cacheCursor(records.index('kind').openCursor(IDBKeyRange.only('catalog')),tx,'清理旧目录',remaining(deadline),cursor=>cursor.delete());
    await cacheCursor(stage.openCursor(),tx,'提升目录暂存',remaining(deadline),cursor=>records.put(cursor.value));stage.clear();metadata.put({key:'catalog-generation',value:page.generation});
   }
   metadata.put({key:staging&&page.hasMore?'stage-cursor':'catalog-cursor',value:page.cursor});
   if(!staging||!page.hasMore)metadata.put({key:'catalog-status',value:page.status});
   await completion;
  }catch(error){try{tx.abort?.();}catch{}await completion.catch(()=>{});throw error;}
  if(!staging||!page.hasMore){memoryMeta.set('catalog-generation',page.generation);memoryMeta.set('catalog-cursor',page.cursor);memoryMeta.set('catalog-status',page.status);catalogRevision=Math.max(catalogRevision,page.cursor,page.status?.revision||0);broadcast?.postMessage({type:'catalog',revision:catalogRevision});notifyStatus();const threads=page.records.filter(r=>!r.deleted).map(r=>r.payload?.nativeThread).filter(t=>t&&listableThread(t));if(threads.length)for(const callback of observationSubscribers)callback(rendererThreadObservation(threads));}
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
 async function deleteCatalog(store,tx,timeoutMs=CACHE_IO_TIMEOUT_MS){return cacheCursor(store.index('kind').openCursor(IDBKeyRange.only('catalog')),tx,'删除旧目录',timeoutMs,cursor=>cursor.delete());}
 async function copyStagedCatalog(stage,records,tx,timeoutMs=CACHE_IO_TIMEOUT_MS){return cacheCursor(stage.openCursor(),tx,'提升目录暂存',timeoutMs,cursor=>records.put(cursor.value));}
 async function importSnapshot(page){
  const checked=validateImportPage(page),expectedRead=nativeReadCursorKey(scope.id),expectedGeneration=nativeGenerationKey(scope.id);
  if(checked.readCursorKey!==expectedRead||checked.sourceGenerationKey!==expectedGeneration)throw Error('Android 缓存游标归属不匹配');
  return withWriter('catalog',async()=>{
   const deadline=Date.now()+CACHE_IO_TIMEOUT_MS*4,db=await cacheDb(remaining(deadline)),tx=db.transaction(['records','meta','catalog-stage','usage','aliases'],'readwrite'),completion=cacheCompletion(tx,'导入 Android 缓存',remaining(deadline)),records=tx.objectStore('records'),metadata=tx.objectStore('meta'),stage=tx.objectStore('catalog-stage'),aliases=tx.objectStore('aliases');
   const preserveCatalog=checked.generation==='uninitialized'&&!checked.records.length&&!checked.hasMore;
   let promoted=false,staging=false,oldCatalogCursor=0;
   try{
    const current=(await cacheRequest(metadata.get('catalog-generation'),tx,'读取目录代际',remaining(deadline)))?.value||'',lastAndroid=(await cacheRequest(metadata.get('android-source-generation'),tx,'读取 Android 来源代际',remaining(deadline)))?.value||'',stageGeneration=(await cacheRequest(metadata.get('stage-generation'),tx,'读取目录暂存代际',remaining(deadline)))?.value||'',priorRead=(await cacheRequest(metadata.get(expectedRead),tx,'读取 Android 游标',remaining(deadline)))?.value;
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
      const old=await cacheRequest(aliases.get(record.key),tx,'读取导入别名',remaining(deadline));
      if(record.deleted){if(canReplace(old,record))aliases.delete(record.key);}
      else if(canReplace(old,record))aliases.put({key:record.key,target:record.payload.targetKey,sourceGeneration:record.sourceGeneration,generation:record.generation,revision:record.revision});
     }else if(record.kind==='catalog'){
      if(preserveCatalog)continue;
      const target=staging?stage:records,old=await cacheRequest(target.get(record.key),tx,'读取导入目录记录',remaining(deadline));if(canReplace(old,record))target.put(stored(record));
     }else await putValues(tx,record,'records',{deadline,generationFence:checked.generation});
    }
    if(!preserveCatalog&&staging&&!checked.hasMore){await deleteCatalog(records,tx,remaining(deadline));await copyStagedCatalog(stage,records,tx,remaining(deadline));stage.clear();metadata.put({key:'catalog-generation',value:checked.generation});promoted=true;}
    if(!preserveCatalog&&staging&&checked.hasMore&&checked.catalogCursor!=null)metadata.put({key:'stage-cursor',value:checked.catalogCursor});
    if(!preserveCatalog&&!checked.hasMore){
     const oldCursor=(await cacheRequest(metadata.get('catalog-cursor'),tx,'读取目录游标',remaining(deadline)))?.value;oldCatalogCursor=Number.isSafeInteger(oldCursor)&&oldCursor>=0?oldCursor:0;
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
   if(!preserveCatalog&&!checked.hasMore){const revision=Math.max(catalogRevision,checked.catalogCursor||0,Number.isSafeInteger(checked.status?.revision)?checked.status.revision:0);catalogRevision=revision;broadcast?.postMessage({type:'catalog',revision});notifyStatus();const threads=checked.records.filter(record=>record.kind==='catalog'&&!record.deleted).map(record=>record.payload?.nativeThread).filter(thread=>thread&&listableThread(thread));if(threads.length)for(const callback of observationSubscribers)callback(rendererThreadObservation(threads));}
   return {scope:checked.scope,cursor:checked.readCursor,generation:checked.generation,hasMore:checked.hasMore};
  });
 }
 const withWriter=(name,work)=>navigator.locks?.request?navigator.locks.request('dsh-native:'+scope.id+':'+name,work):work();
 const cloud=!['127.0.0.1','localhost'].includes(location.hostname),base=cloud?'/sync/v1/w/'+scope.id:'/w/'+scope.id+'/api';
 async function api(path,body,priority='auto'){const startedAt=performance.now(),traceId=crypto.randomUUID(),threadId=body?.params?.threadId;let statusCode=0;const pendingTimer=setTimeout(()=>window.__DSH_CLIENT_LOG__?.event('transport',{component:'native-http',traceId,threadId,stage:'pending',reason:'timeout',routeClass:window.__DSH_CLIENT_LOG__?.routeClass(base+path),statusCode,method:body?.method,durationMs:Math.round(performance.now()-startedAt)}),15000);try{if(!cloud&&!scope.token){const session=await window.__DSH_SESSION_READY__;if(!session)throw Error('Mac 暂未连接');}const init={priority,...(body?{method:'POST',body:JSON.stringify(body)}:{}),headers:{'x-dsh-scope':scope.token||'','x-dsh-diagnostic-trace':traceId,...(body?{'content-type':'application/json'}:{})},cache:'no-store',redirect:'manual'};let r,value;if(typeof window.__DSH_CONNECTION_JSON__==='function'){const result=await window.__DSH_CONNECTION_JSON__(base+path,init,30000);r=result.response;value=result.data;}else{r=await fetch(base+path,init);if(r.ok)value=await r.json();}statusCode=r.status;if(r.status===401||r.type==='opaqueredirect'){window.dispatchEvent(new Event('dsh:authentication-required'));throw Error('请重新登录');}if(!r.ok)throw Object.assign(Error('当前暂不能同步'),{code:String(r.status),statusCode:r.status});if(typeof value?.nativeOnline==='boolean')window.__DSH_NATIVE_ONLINE__=value.nativeOnline;return value;}catch(error){window.__DSH_CLIENT_LOG__?.event('transport',{component:'native-http',traceId,threadId,stage:'failed',reason:error?.code==='DSH_CONNECTION_JSON_TIMEOUT'?'timeout':'upstream_failure',routeClass:window.__DSH_CLIENT_LOG__?.routeClass(base+path),statusCode,method:body?.method,durationMs:Math.round(performance.now()-startedAt)});throw error;}finally{clearTimeout(pendingTimer);}}

 async function syncCatalog(refresh=false){if(syncing)return syncing;syncing=withWriter('catalog',async()=>{
  memoryMeta.delete('catalog-cursor');memoryMeta.delete('catalog-generation');
  let cursor=await meta('catalog-cursor')||0,generation=await meta('catalog-generation')||'',first=true;
  do{const page=await api('/native-catalog?after='+cursor+'&generation='+encodeURIComponent(generation)+(refresh&&first?'&refresh=1':''));first=false;const next=importCursor(page.cursor);if(next==null||page.hasMore&&next<=cursor)throw Error('目录游标未前进');await commitCatalog(page);cursor=next;if(typeof page.generation==='string'&&page.generation)generation=page.generation;if(!page.hasMore)break;}while(true);
  return status();
 }).finally(()=>{syncing=null;});return syncing;}
 async function status(){const value=await meta('catalog-status'),generation=await meta('catalog-generation'),revision=Math.max(catalogRevision,await meta('catalog-cursor')||0,value?.revision||0),complete=!!(value?.payload?.complete??value?.complete??value?.bootstrapComplete);return {hosts:[{hostId:'local',isComplete:complete,revision:generation+':'+revision+':'+catalogDisplayRevision}],revision,isComplete:complete};}
 function notifyStatus(){status().then(value=>{for(const callback of statusSubscribers)callback(value);}).catch(()=>{});}
 function matches(entry,filter){if(!filter)return true;if(filter.excludeThreadIds?.includes(entry.threadId))return false;if(filter.projectId!=null&&filter.projectId!==entry.projectId)return false;if(filter.conversationOrigin!=null&&filter.conversationOrigin!==entry.conversationOrigin)return false;
  return filter.includeAll||filter.includeThreadIds?.includes(entry.threadId)||filter.cwdValues?.includes(entry.cwd)||filter.cwdPrefixes?.some(prefix=>entry.cwd?.startsWith(prefix));}
 async function cachedCatalogRecord(id){
  const record=volatileCatalog?.get('thread:'+id)||await get('thread:'+id);if(record?.deleted)return record;
  if(record&&listableEntry(record.payload))return record;
  const head=await get(readKey('thread/read',{threadId:id,includeTurns:false})),generation=await meta('catalog-generation');
  if(head&&!head.deleted&&(!generation||head.sourceGeneration===generation)&&head.payload?.result?.thread?.id===id&&listableThread(head.payload.result.thread))return {...head,payload:toEntry(head.payload.result.thread)};
  // Sidebar display metadata survives history eviction and catalog staging.
  // It never hydrates a conversation or supplies an execution/read ACK.
  const pins=await meta(ipcReadKey('list-pinned-threads',{})),snapshot=await meta('pinned-sidebar-v1');
  const entry=snapshot?.scope===scope.id&&pins?.threadIds?.includes(id)&&snapshot.entries?.[id];
  if(entry&&entry.threadId===id&&!await meta('auth-locked'))return {scope:scope.id,key:'thread:'+id,kind:'catalog',payload:entry,source:'pinned-sidebar'};
  return record||null;
 }
 async function catalogPage(p={}){
  if(p.hostId&&p.hostId!=='local')return {entries:[],nextCursor:null};const deadline=Date.now()+CACHE_IO_TIMEOUT_MS,db=await cacheDb(remaining(deadline)),limit=Math.min(100,Math.max(1,p.limit||50)),entries=[];
  if(p.manualOrder){const ids=p.manualOrder.threadIds.slice(p.manualOrder.startIndex||0),records=await Promise.all(ids.map(id=>cachedCatalogRecord(id)));let used=0;for(const record of records){used++;if(record&&!record.deleted&&listableEntry(record.payload)&&matches(record.payload,p.filter))entries.push(record.payload);if(entries.length===limit)break;}rememberPinnedEntries(entries).catch(()=>{});return {entries,nextManualIndex:(p.manualOrder.startIndex||0)+used,nextCursor:null};}
  const sortKey=p.sortKey||'updated_at',indexName=sortKey==='created_at'?'created':sortKey==='updated_at'?'updated':'recency',field=indexName==='created'?'createdAt':indexName==='updated'?'updatedAt':'recency';
  const generation=await meta('catalog-generation')||'volatile',signature=JSON.stringify(canonical(p.filter||{}));let position=null;
  if(p.cursor)try{const c=JSON.parse(decodeURIComponent(atob(p.cursor)));if(c.v!==2||c.generation!==generation||c.sortKey!==sortKey||c.signature!==signature||!Array.isArray(c.position))throw Error();position=c.position;}catch{throw Error('目录已更新，请重新打开列表');}
  let more=false,last=null;
  const accept=record=>{if(record.deleted||!listableEntry(record.payload)||!matches(record.payload,p.filter))return true;if(entries.length===limit){more=true;return false;}entries.push(record.payload);last=['catalog',record[field]||0,record.key];return true;};
  if(volatileCatalog){const rows=[...volatileCatalog.values()].sort((a,b)=>(b[field]||0)-(a[field]||0)||b.key.localeCompare(a.key));for(const r of rows){if(position&&((r[field]||0)>position[1]||(r[field]||0)===position[1]&&r.key>=position[2]))continue;if(!accept(r))break;}}
  else {const tx=db.transaction('records'),index=tx.objectStore('records').index(indexName),range=IDBKeyRange.bound(['catalog',0,''],position||['catalog',Number.MAX_VALUE,'\uffff'],false,!!position);
   await cacheCursor(index.openCursor(range,'prev'),tx,'读取目录分页',remaining(deadline),cursor=>accept(cursor.value));}
  window.__DSH_PERF__?.event('native_catalog_read',{count:entries.length,source:volatileCatalog?'memory':'indexeddb'});
  return {entries,nextCursor:more?btoa(encodeURIComponent(JSON.stringify({v:2,generation,sortKey,signature,position:last}))):null};
 }
 let catalogDisplayRevision=0;
 const missingCatalogReads=new Map();
 function prepareMissingCatalogEntry(threadId){
  if(missingCatalogReads.has(threadId)||!navigator.onLine||window.__DSH_EXECUTION_CONNECTED__!==true)return;
  const work=fetchRead('thread/read',{threadId,includeTurns:false},true).then(async record=>{
   const thread=record?.payload?.result?.thread;if(thread?.id!==threadId)return;
   await rememberPinnedEntries([toEntry(thread)]);catalogDisplayRevision++;notifyStatus();
   for(const callback of observationSubscribers)callback(rendererThreadObservation([thread]));
   pinnedEmit?.('pinned-threads-updated',{});
  }).catch(()=>{}).finally(()=>missingCatalogReads.delete(threadId));missingCatalogReads.set(threadId,work);
 }
 async function readEntries(keys){
  const requested=keys.filter(key=>key.hostId==='local');
  const records=await Promise.all(requested.map(({threadId})=>cachedCatalogRecord(threadId).catch(()=>null)));
  const entries=[];
  records.forEach((record,index)=>{if(!record)prepareMissingCatalogEntry(requested[index].threadId);else if(!record.deleted&&listableEntry(record.payload))entries.push(record.payload);});
  rememberPinnedEntries(entries).catch(()=>{});
  window.__DSH_CLIENT_LOG__?.event('client_health',{stage:'received',source:'indexeddb',count:entries.length,itemCount:requested.length,cacheReady:entries.length===requested.length});
  return entries;
 }
 const toEntry=t=>({hostId:'local',threadId:t.id,sourceKind:typeof t.source==='string'?t.source:'custom',displayTitle:t.name||t.preview||'新聊天',sourceCreatedAt:t.createdAt||0,sourceUpdatedAt:t.updatedAt||0,sourceRecencyAt:t.recencyAt??t.updatedAt??0,cwd:t.cwd,modelProvider:t.modelProvider||'',threadSource:t.threadSource||null,nativeThread:t});
 async function rememberPinnedEntries(entries){
  return withWriter('pinned-sidebar',async()=>{
   const pins=await meta(ipcReadKey('list-pinned-threads',{}));if(!pins?.threadIds||await meta('auth-locked'))return false;
   const previous=await meta('pinned-sidebar-v1'),kept=Object.fromEntries(Object.entries(previous?.scope===scope.id?previous.entries||{}:{}).filter(([id])=>pins.threadIds.includes(id)));
   for(const entry of entries){if(entry.hostId!=='local'||!pins.threadIds.includes(entry.threadId)||entry.nativeThread?.id!==entry.threadId||!listableEntry(entry))continue;
    const {turns,...thread}=entry.nativeThread;kept[entry.threadId]={...entry,nativeThread:thread};
   }
   if(previous?.scope===scope.id&&JSON.stringify(previous.entries)===JSON.stringify(kept))return false;
   await saveMeta('pinned-sidebar-v1',{scope:scope.id,entries:kept,at:Date.now()});return true;
  });
 }
 let pinnedSidebarPreparing=null,pinnedSidebarNext=null;
 async function preparePinnedSidebar(value){
  if(pinnedSidebarPreparing){pinnedSidebarNext=value;return pinnedSidebarPreparing;}
  const epoch=pinnedEpoch,ids=[...new Set(value?.threadIds||[])];
  pinnedSidebarPreparing=(async()=>{
   let changed=false;
   for(let i=0;i<ids.length;i+=4){
    if(epoch!==pinnedEpoch)break;
    const batch=await Promise.allSettled(ids.slice(i,i+4).map(async id=>{
     const cached=await cachedCatalogRecord(id);if(cached?.deleted)return null;
     if(cached&&listableEntry(cached.payload))return cached.payload;
     if(!navigator.onLine||window.__DSH_EXECUTION_CONNECTED__!==true)return null;
     const record=await fetchRead('thread/read',{threadId:id,includeTurns:false},true);return record?.payload?.result?.thread?.id===id?toEntry(record.payload.result.thread):null;
    }));
    if(epoch!==pinnedEpoch)break;
    changed=await rememberPinnedEntries(batch.flatMap(r=>r.status==='fulfilled'&&r.value?[r.value]:[]))||changed;
   }
   if(!ids.length)changed=await rememberPinnedEntries([])||changed;
   if(changed&&epoch===pinnedEpoch){pinnedEmit?.('pinned-threads-updated',{});broadcast?.postMessage({type:'pinned-sidebar'});}
  })().finally(()=>{pinnedSidebarPreparing=null;const next=pinnedSidebarNext;pinnedSidebarNext=null;if(next)preparePinnedSidebar(next).catch(()=>{});});return pinnedSidebarPreparing;
 }
 async function prepareSidebarBootstrap(config){
  const [pins,locked]=await Promise.all([meta(ipcReadKey('list-pinned-threads',{})).catch(()=>null),meta('auth-locked').catch(()=>true)]);
  if(locked||!config?.initialSidebarBootstrap)return config;
  // The boot configuration is a point-in-time snapshot. Project changes read
  // during the previous visit are newer and must join pins in the FIRST render.
  const initial=config.initialSidebarBootstrap,globals=new Map((initial.globalStateEntries||[]).map(entry=>[entry.key,entry.value]));
  const keys=['local-projects','selected-project','project-order','electron-saved-workspace-roots','electron-workspace-root-labels'];
  const saved=await Promise.all(keys.map(key=>meta(ipcReadKey('get-global-state',{key})).catch(()=>undefined)));
  for(let i=0;i<keys.length;i++)if(saved[i]&&Object.hasOwn(saved[i],'value'))globals.set(keys[i],saved[i].value);
  const ids=Array.isArray(pins?.threadIds)?pins.threadIds:null,entries=ids?await readEntries(ids.map(threadId=>({hostId:'local',threadId}))):[];
  const pinSet=new Set(ids||[]),byId=new Map((initial.catalogEntries||[]).filter(entry=>!pinSet.has(entry.threadId)).map(entry=>[entry.hostId+':'+entry.threadId,entry]));
  for(const entry of entries)byId.set(entry.hostId+':'+entry.threadId,entry);
  if(ids)globals.set('pinned-thread-ids',ids.slice());
  const roots=globals.get('electron-saved-workspace-roots'),labels=globals.get('electron-workspace-root-labels');
  const workspaceRootOptions=Array.isArray(roots)?{...initial.workspaceRootOptions,roots:roots.slice(),canonicalPathByRoot:Object.fromEntries(roots.map(root=>[root,root])),...(labels&&typeof labels==='object'?{labels}:{} )}:initial.workspaceRootOptions;
  return {...config,...(Array.isArray(roots)?{workspaceRoots:roots.slice()}:{}),initialSidebarBootstrap:{...initial,workspaceRootOptions,catalogEntries:[...byId.values()],globalStateEntries:[...globals].map(([key,value])=>({key,value}))}};
 }
 const validated=new Map(),foregroundFreshReads=new Set(),nativeActivity=new Map(),nativeEventEpoch=new Map();let lastForeground=Date.now();
 const validNativeRecord=(record,key)=>!!record&&record.scope===scope.id&&record.key===key&&!record.deleted&&typeof record.sourceGeneration==='string'&&record.sourceGeneration.length>0&&typeof record.generation==='string'&&record.generation.length>0&&Number.isSafeInteger(record.revision)&&record.revision>=1&&record.payload&&typeof record.payload==='object';
 async function fetchRead(method,params,fresh,priority='auto'){params=normalize(method,params);const key=readKey(method,params),pendingKey=key+(fresh?':fresh':':cached');if(pendingReads.has(key+':fresh'))return pendingReads.get(key+':fresh');if(pendingReads.has(pendingKey))return pendingReads.get(pendingKey);
  const viewStamp=historyViewEpoch,statusStamp=window.__DSH_NATIVE_STATUS_RECOVERY__?.beginRead(params.threadId,{fresh});
  const work=(async()=>{let record=await api('/native-read',{method,params,fresh},priority);if(!validNativeRecord(record,key))throw Error('历史缓存身份或版本不匹配');let generation=null,cacheHealthy=true;try{
    generation=await meta('catalog-generation');
    if(generation&&generation!==record.sourceGeneration){try{await bounded(syncCatalog(),'同步本机目录',CACHE_IO_TIMEOUT_MS);}catch{}generation=await meta('catalog-generation');if(generation&&generation!==record.sourceGeneration)throw Error('历史来源已更新，请重新读取');}
   }catch(error){if(error?.message==='历史来源已更新，请重新读取')throw error;cacheHealthy=false;}
   if(cacheHealthy){let stored=false;try{stored=await put(record,{expectedGeneration:generation||record.sourceGeneration});}catch{}if(stored){const committed=await get(key,{touch:false}).catch(()=>null);if(validNativeRecord(committed,key)&&committed.sourceGeneration===record.sourceGeneration&&committed.generation===record.generation&&committed.revision>record.revision)record={...committed,source:'indexeddb'};}}
   if(viewStamp===historyViewEpoch)window.__DSH_NATIVE_STATUS_RECOVERY__?.acceptRead(method,params,record,statusStamp);if(fresh&&(record.source==null||record.source==='native'))validated.set(key,Date.now());window.__DSH_CLIENT_LOG__?.event('history_read',{method,threadId:params.threadId,revision:record.revision,source:record.source||'native',fresh:!!fresh});if(validated.size>512)validated.delete(validated.keys().next().value);return record;})().finally(()=>{if(pendingReads.get(pendingKey)===work)pendingReads.delete(pendingKey);});pendingReads.set(pendingKey,work);return work;}
 async function read(method,params){const key=readKey(method,params),normalized=normalize(method,params);let cached=await get(key).catch(()=>null);
  // A background freshness check must not force the visible reader past its cache.
  const historyCursor=normalized.turnId?await meta('history-cursors:'+normalized.threadId).catch(()=>null):null;
  if(!cached&&method==='thread/items/list'&&normalized.turnId&&normalized.cursor&&historyCursor?.itemsBackwardsCursor===normalized.cursor){const stable=await get(stableItemHead(normalized),{touch:false}).catch(()=>null);if(stable&&!stable.deleted)try{if(await terminalItems(normalized,stable))cached=stable;}catch{}}
  let immutable=false;if(method==='thread/items/list'&&cached)try{immutable=await terminalItems(normalized,cached);}catch{}
  if(immutable&&normalized.cursor&&historyCursor?.itemsBackwardsCursor===normalized.cursor){const deadline=Date.now()+CACHE_IO_TIMEOUT_MS,key=stableItemHead(normalized);try{const db=await cacheDb(remaining(deadline)),readTx=db.transaction('aliases'),prior=await cacheRequest(readTx.objectStore('aliases').get(key),readTx,'读取稳定分页别名',remaining(deadline));if(prior?.target!==cached.key&&canReplace(prior,{revision:cached.revision})){const tx=db.transaction('aliases','readwrite'),completion=cacheCompletion(tx,'保存稳定分页别名',remaining(deadline));try{tx.objectStore('aliases').put({key,target:cached.key,sourceGeneration:cached.sourceGeneration,generation:cached.generation,revision:cached.revision});await completion;}catch(error){try{tx.abort?.();}catch{}await completion.catch(()=>{});}}}catch{}}


  if(cached&&!cached.deleted){window.__DSH_PERF__?.event('native_history_read',{source:'indexeddb'});if(navigator.onLine&&!immutable&&Date.now()-(validated.get(key)||0)>2000)fetchRead(method,params,true).then(record=>{if(record.revision>cached.revision){broadcast?.postMessage({type:'history',threadId:params.threadId});window.dispatchEvent(new CustomEvent('dsh:history-updated',{detail:{threadId:params.threadId}}));}}).catch(()=>{});return {result:structuredClone(cached.payload.result),cached:true,confirmedAt:cached.confirmedAt};}
  diagnostics.readMisses.push({method,limit:params?.limit,itemsView:params?.itemsView,sortDirection:params?.sortDirection,hasCursor:!!params?.cursor});if(diagnostics.readMisses.length>20)diagnostics.readMisses.shift();foregroundFreshReads.add(key);let record;try{record=await fetchRead(method,params,false);}finally{foregroundFreshReads.delete(key);}window.__DSH_PERF__?.event('native_history_read',{source:record.source||'cloud'});return {result:record.payload.result,cached:false};
 }
 // Background cache refresh never resumes, subscribes or executes a thread.
 const PREWARM_TURNS=(!!window.DSHAndroid||/DSHAndroid/i.test(navigator.userAgent))?12:6,PREWARM_RECENT=(!!window.DSHAndroid||/DSHAndroid/i.test(navigator.userAgent))?60:20;
 let priorityPinned=new Set();
 const backgroundErrors=new Map(),backgroundHeads=new Set(),backgroundQueue=new Set(),backgroundFresh=new Map(),backgroundLast=new Map(),knownRunning=new Set(),recentWarmed=new Map();let backgroundBusy=false,backgroundTimer=null,scanning=false;
 diagnostics.background={completed:0,failed:0,lastThread:null,turnsPerThread:PREWARM_TURNS,recentThreads:PREWARM_RECENT};
 function enqueueBackground(id,{fresh=true}={}){if(!/^[0-9a-f-]{36}$/i.test(id||''))return;queueCachedPreparation(id);backgroundQueue.add(id);backgroundFresh.set(id,fresh||backgroundFresh.get(id)||false);scheduleBackground();}
 async function warmPinned(value){priorityPinned=new Set(value?.threadIds||[]);preparePinnedSidebar(value).catch(()=>{});for(const id of value?.threadIds||[]){if(pinnedWarmed.has(id))continue;pinnedWarmed.add(id);enqueueBackground(id,{fresh:false});}}
 async function warmRecent(){const page=await catalogPage({limit:PREWARM_RECENT,sortKey:'updated_at'});for(const entry of page.entries){const version=entry.sourceUpdatedAt||entry.sourceRecencyAt||0;if(recentWarmed.get(entry.threadId)===version)continue;recentWarmed.set(entry.threadId,version);enqueueBackground(entry.threadId,{fresh:false});}if(recentWarmed.size>100)for(const id of [...recentWarmed.keys()].slice(0,recentWarmed.size-100))recentWarmed.delete(id);}
 function scheduleBackground(){if(backgroundTimer)return;backgroundTimer=setTimeout(()=>{backgroundTimer=null;runBackground().catch(()=>{});},1200);}
 async function prewarmRead(method,params,fresh){
  if(!fresh){const cached=await get(readKey(method,params)).catch(()=>null),generation=await meta('catalog-generation').catch(()=>null),invalid=await meta('invalid:invalidate:'+params.threadId).catch(()=>null);if(cached&&!cached.deleted&&(!generation||cached.sourceGeneration===generation)&&(!invalid||invalid.revision<=cached.revision))return cached;}
  return fetchRead(method,params,fresh,'low');
 }
 async function runBackground(){
  if(backgroundBusy||!backgroundQueue.size)return;
  if(document.visibilityState!=='visible'||!navigator.onLine||window.__DSH_NATIVE_ONLINE__===false||navigator.connection?.saveData||Date.now()-lastForeground<1800||foregroundFreshReads.size){scheduleBackground();return;}
  const visible=window.__DSH_NATIVE_SIDEBAR__?.isList?null:location.pathname.split('/')[2];
  const rank=id=>priorityPinned.has(id)?0:knownRunning.has(id)?1:recentWarmed.has(id)?2:3;
  const id=[...backgroundQueue].filter(id=>id!==visible&&Date.now()-(backgroundLast.get(id)||0)>10000).sort((a,b)=>Number(backgroundHeads.has(a))-Number(backgroundHeads.has(b))||rank(a)-rank(b))[0];
  if(!id){scheduleBackground();return;}backgroundQueue.delete(id);const fresh=backgroundFresh.get(id)!==false;backgroundFresh.delete(id);backgroundBusy=true;backgroundLast.set(id,Date.now());diagnostics.background.currentThread=id;diagnostics.background.stage=backgroundHeads.has(id)?'history':'head';
  try{
   if(!backgroundHeads.has(id)){
   const head=await prewarmRead('thread/read',{threadId:id,includeTurns:false},fresh);
   if(head.payload?.result?.thread?.historyMode==='legacy'){
    // Legacy threads expose full turns, not the durable item-page API.
    await prewarmRead('thread/turns/list',{threadId:id,limit:2,sortDirection:'desc',itemsView:'full'},fresh);
    queueCachedPreparation(id);backgroundErrors.delete(id);diagnostics.background.completed++;diagnostics.background.lastThread=id;return;
   }
   // Share the exact first-paint shape used by Android's durable history reader.
   await prewarmRead('thread/turns/list',{threadId:id,limit:20,sortDirection:'desc',itemsView:'summary'},fresh);
   saveMeta('history-prewarmed:'+id,{at:Date.now(),headReady:true,pinned:priorityPinned.has(id)}).catch(()=>{});
   queueCachedPreparation(id);backgroundHeads.add(id);backgroundLast.delete(id);enqueueBackground(id,{fresh});return;
   }
   if(Date.now()-lastForeground<1800){enqueueBackground(id,{fresh});return;}
   // Keep the native first-page shape hot, then prepare a deeper recent window.
   await prewarmRead('thread/turns/list',{threadId:id,limit:1,sortDirection:'desc',itemsView:'notLoaded'},fresh);
   if(Date.now()-lastForeground<1800||foregroundFreshReads.size){enqueueBackground(id,{fresh});return;}
   const page=await prewarmRead('thread/turns/list',{threadId:id,limit:PREWARM_TURNS,sortDirection:'desc',itemsView:'notLoaded'},fresh);
   for(const turn of page.payload.result.data||[]){
    if(document.visibilityState!=='visible'||!navigator.onLine||navigator.connection?.saveData||Date.now()-lastForeground<1800||foregroundFreshReads.size){enqueueBackground(id,{fresh});return;}
    await prewarmRead('thread/items/list',{threadId:id,turnId:turn.id,limit:window.__DSH_HISTORY_POLICY__?.initialTurnItems||20,sortDirection:'desc'},fresh);
   }
   if(androidReader)queueCachedPreparation(id);else if(fresh&&Date.now()-lastForeground>=1800)await nativeClient?.hydrateBackgroundThreads?.([id],{includeTurns:true,maxTurns:PREWARM_TURNS});backgroundHeads.delete(id);
   backgroundErrors.delete(id);diagnostics.background.completed++;diagnostics.background.lastThread=id;
   window.__DSH_PERF__?.event('prewarm',{bodyCount:diagnostics.background.completed,background:true});
  }catch{backgroundErrors.set(id,{at:Date.now()});if(backgroundErrors.size>100)backgroundErrors.delete(backgroundErrors.keys().next().value);backgroundHeads.delete(id);diagnostics.background.failed++;pinnedWarmed.delete(id);recentWarmed.delete(id);if(priorityPinned.has(id))enqueueBackground(id,{fresh:false});}finally{backgroundBusy=false;diagnostics.background.currentThread=null;diagnostics.background.stage=null;if(backgroundQueue.size)scheduleBackground();}
 }
 async function scanRunning(){if(scanning||document.visibilityState!=='visible')return;scanning=true;try{for(const id of window.__DSH_NATIVE_STATUS_RECOVERY__?.activeThreadIds()||[])enqueueBackground(id);await warmRecent();let cursor;const running=new Set();do{const page=await catalogPage({limit:100,cursor});for(const entry of page.entries)if(entry.nativeThread?.status?.type==='active'){running.add(entry.threadId);enqueueBackground(entry.threadId);}cursor=page.nextCursor;}while(cursor);for(const id of knownRunning)if(!running.has(id))enqueueBackground(id);knownRunning.clear();for(const id of running)knownRunning.add(id);}finally{scanning=false;}}
 document.addEventListener('input',()=>{lastForeground=Date.now();},true);
 addEventListener('dsh:native-route',()=>{lastForeground=Date.now();});
 addEventListener('dsh:session-ready',()=>scanRunning().catch(()=>{}));
 const backgroundScanTimer=setInterval(()=>scanRunning().catch(()=>{}),15000);setTimeout(()=>scanRunning().catch(()=>{}),5000);
 function hydrateCachedThread(id){if(androidReader)return refreshCommitted();if(!id||!nativeClient||window.__DSH_EXECUTION_CONNECTED__===true||offlineHydrated.has(id))return Promise.resolve();if(offlineHydrations.has(id))return offlineHydrations.get(id);const work=nativeClient.hydrateBackgroundThreads([id],{includeTurns:true,maxTurns:androidReader?6:1,...(androidReader?{refreshTurns:true,refreshGuard:()=>location.pathname==='/local/'+id}:{})}).then(async()=>{
   if(androidReader){offlineHydrated.add(id);window.__DSH_PERF__?.ready(id);return;}
   // Background hydration deliberately omits normal-page pagination in the
   // pinned renderer. Restore that READ cursor explicitly; never set resumed
   // or claim a Native writer just to make cached history scrollable.
   const page=(await read('thread/turns/list',{threadId:id,cursor:null,limit:1,sortDirection:'desc'})).result;let seed=await meta('history-cursors:'+id).catch(()=>null);if(!seed)try{seed=(await api('/native-cursors?threadId='+encodeURIComponent(id))).cursors;if(seed)await saveMeta('history-cursors:'+id,seed);}catch{};
   if(window.__DSH_EXECUTION_CONNECTED__!==true)nativeClient.updateConversationState?.(id,c=>{
    if(seed?.itemsBackwardsCursor){c.paginatedHistory={itemsBackwardsCursor:seed.itemsBackwardsCursor};c.turnsPagination={olderCursor:seed.turnsBackwardsCursor,oldestLoadedTurnId:null,isLoadingOlder:false,hasLoadedOldest:seed.turnsBackwardsCursor==null};}
    else c.turnsPagination={olderCursor:page.nextCursor??null,oldestLoadedTurnId:page.data?.at(-1)?.id??null,isLoadingOlder:false,hasLoadedOldest:page.nextCursor==null};
   });
   offlineHydrated.add(id);window.__DSH_PERF__?.ready(id);
  }).finally(()=>offlineHydrations.delete(id));offlineHydrations.set(id,work);return work;}
 let eventsSocket=null,eventsRetry=null,eventChain=Promise.resolve(),eventsStarting=false,eventsGeneration=0,eventsStopped=false,eventsControlPending=false;
 // Android already owns this subscription in SyncClient. In browsers the
 // optional replica socket yields to control: Chromium serializes handshakes
 // for a shared endpoint, so separate JS sockets are not independent lanes.
 const mayConnectEvents=()=>!eventsStopped&&!eventsControlPending&&!window.__DSH_ANDROID_BRIDGE__&&cloud&&navigator.onLine&&window.__DSH_EXECUTION_CONNECTED__===true;
 function yieldEventHandshake(){eventsGeneration++;clearTimeout(eventsRetry);eventsRetry=null;if(eventsSocket?.readyState===0)eventsSocket.close();}
 window.__DSH_BEFORE_CONTROL_CONNECT__=()=>{eventsControlPending=true;yieldEventHandshake();};
 window.__DSH_STOP_EVENT_CONNECTION__=()=>{eventsStopped=true;yieldEventHandshake();eventsSocket?.close();};
 addEventListener('dsh:authentication-required',window.__DSH_STOP_EVENT_CONNECTION__);
 addEventListener('offline',yieldEventHandshake);
 addEventListener('dsh:execution-state',()=>{if(window.__DSH_EXECUTION_CONNECTED__===true){eventsControlPending=false;connectEvents().catch(()=>{});}else yieldEventHandshake();});
 function replicaChanged(event){if(event?.type==='host'){window.__DSH_NATIVE_ONLINE__=!!event.online;window.dispatchEvent(new Event('dsh:connection-state'));}if(event?.type==='nativeChanged'){if(/^(thread:|catalog-)/.test(event.cacheKey||''))syncCatalog().catch(()=>{});const id=event.threadId,invalid=event.cacheKey?.startsWith('invalidate:');if(id&&invalid){for(const key of validated.keys())if(key.includes(id))validated.delete(key);if(location.pathname!=='/local/'+id||window.__DSH_NATIVE_SIDEBAR__?.isList)enqueueBackground(id);}if(id&&invalid&&location.pathname==='/local/'+id){if(androidReader){refreshForeground().catch(()=>{});return;}fetchRead('thread/read',{threadId:id,includeTurns:false},true).then(()=>nativeClient?.hydrateBackgroundThreads?.([id],{includeTurns:true,maxTurns:1})).catch(()=>{});}}}
 async function connectEvents(){if(eventsSocket||eventsStarting||!mayConnectEvents())return;eventsStarting=true;try{if(navigator.locks?.request)await navigator.locks.request('dsh-native:'+scope.id+':events',{ifAvailable:true},lock=>lock?openEvents():undefined);else await openEvents();}finally{eventsStarting=false;}}
 async function openEvents(){if(eventsSocket||!mayConnectEvents())return;const openingGeneration=eventsGeneration,cursor=await meta('event-cursor').catch(()=>null)||{};if(openingGeneration!==eventsGeneration||eventsSocket||!mayConnectEvents())return;const u=new URL('/sync/v1/w/'+scope.id+'/events',location.href);u.protocol=location.protocol==='https:'?'wss:':'ws:';u.searchParams.set('epoch',cursor.epoch||'');u.searchParams.set('after',cursor.seq||0);const connectionId=crypto.randomUUID(),startedAt=Date.now();u.searchParams.set('dshDiag',connectionId);const socket=new WebSocket(u.href);eventsSocket=socket;let lastMessageAt=0;const trace=(stage,fields={})=>window.__DSH_CLIENT_LOG__?.event('transport',{component:'cloud-events',connectionId,stage,...fields});trace('attempt');const handshake=setTimeout(()=>{if(eventsSocket!==socket||socket.readyState!==0)return;trace('failed',{reason:'timeout',socketState:socket.readyState,durationMs:Date.now()-startedAt});socket.close();},15000);socket.addEventListener('open',()=>{clearTimeout(handshake);trace('connected',{durationMs:Date.now()-startedAt});});socket.addEventListener('error',()=>trace('failed',{reason:'socket_error',socketState:socket.readyState}));socket.addEventListener('close',event=>trace('closed',{reason:'socket_closed',closeCode:event.code,wasClean:event.wasClean,durationMs:Date.now()-startedAt,lastMessageAgeMs:Date.now()-(lastMessageAt||startedAt)}));
  socket.addEventListener('message',event=>{lastMessageAt=Date.now();eventChain=eventChain.then(async()=>{const value=JSON.parse(event.data);
   if(value.type==='hello'){trace('received',{nativeOnline:!!value.online});replicaChanged({type:'host',online:value.online});broadcast?.postMessage({type:'sync-event',event:{type:'host',online:value.online}});return;}
   if(value.type==='resync'){await syncCatalog(true);await saveMeta('event-cursor',{epoch:value.epoch,seq:value.seq||0});socket.close();return;}
   if(!Number.isSafeInteger(value.seq)||value.scope!==scope.id)return;const previous=await meta('event-cursor')||{};
   if(value.epoch===previous.epoch&&value.seq<=previous.seq){socket.send(JSON.stringify({type:'ack',seq:previous.seq}));return;}
   if(value.epoch!==previous.epoch||value.seq!==(previous.seq||0)+1){await syncCatalog(true);await saveMeta('event-cursor',{epoch:value.epoch,seq:value.seq-1});}
   const deadline=Date.now()+CACHE_IO_TIMEOUT_MS,db=await cacheDb(remaining(deadline)),tx=db.transaction('meta','readwrite'),completion=cacheCompletion(tx,'保存事件游标',remaining(deadline)),store=tx.objectStore('meta');
   try{if(value.event?.type==='nativeChanged'&&value.event.cacheKey)store.put({key:'invalid:'+value.event.cacheKey,value:{revision:value.event.revision,generation:value.event.generation}});
    store.put({key:'event-cursor',value:{epoch:value.epoch,seq:value.seq}});await completion;memoryMeta.set('event-cursor',{epoch:value.epoch,seq:value.seq});
   }catch(error){try{tx.abort?.();}catch{}await completion.catch(()=>{});throw error;}
   socket.send(JSON.stringify({type:'ack',seq:value.seq}));
   replicaChanged(value.event);broadcast?.postMessage({type:'sync-event',event:value.event});
  }).catch(()=>socket.close());});
  const heartbeat=setInterval(()=>{if(socket.readyState===1)socket.send(JSON.stringify({type:'ping'}));},20000);
  socket.addEventListener('close',()=>{clearTimeout(handshake);clearInterval(heartbeat);if(eventsSocket!==socket)return;eventsSocket=null;clearTimeout(eventsRetry);eventsRetry=null;if(mayConnectEvents())eventsRetry=setTimeout(()=>connectEvents().catch(()=>{}),2000);});
  await new Promise(resolve=>socket.addEventListener('close',resolve,{once:true}));
 }
 // Catalog rows intentionally omit history. Adapt only the renderer-facing shape.
 function rendererThreadObservation(threads){return {hostId:'local',threads:threads.map(thread=>Array.isArray(thread.turns)?thread:{...thread,turns:[]})};}
 const catalog={readPage:catalogPage,readEntries,readStatus:status,setSourceEnabled:async()=>{},
  async requestSync(){const cached=await status();syncCatalog(true).catch(()=>{});return cached;},async requestStartupSync(){const generation=await meta('catalog-generation').catch(()=>null);if(generation){const cached=await status();syncCatalog(true).catch(()=>{});return cached;}return syncCatalog(true).catch(()=>status());},
  subscribeStatus(callback){statusSubscribers.add(callback);status().then(callback).catch(()=>{});},unsubscribeStatus(){statusSubscribers.clear();},
  subscribeThreadObservations(callback){observationSubscribers.add(callback);catalogPage({limit:50}).then(p=>callback(rendererThreadObservation(p.entries.map(e=>e.nativeThread).filter(Boolean)))).catch(()=>{});},unsubscribeThreadObservations(){observationSubscribers.clear();},
  notifyThread:()=>syncCatalog(true).catch(()=>{}),invalidateSource:()=>syncCatalog(true).catch(()=>{}),removeMissingEntry:async()=>false};
 function rememberHistoryCursors(id,result){if(!id||result?.thread?.id!==id||typeof result.itemsBackwardsCursor!=='string')return;saveMeta('history-cursors:'+id,{itemsBackwardsCursor:result.itemsBackwardsCursor,turnsBackwardsCursor:result.turnsBackwardsCursor??null,confirmedAt:Date.now()}).catch(()=>{});}
 window.__DSH_IPC_CACHE_RESPONSE__=payload=>{
  // Seen introductions are durable per device, including cached/offline starts.
  if(payload?.type==='persisted-atom-sync'||payload?.type==='persisted-atom-updated'&&payload.key===seenModelsKey){const remote=seenModels(payload.type==='persisted-atom-sync'?(payload.atoms||payload.state)?.[seenModelsKey]:payload.value);if(remote)localSeenModels=[...new Set([...localSeenModels,...remote])];if(localSeenModels.length){const value=[...localSeenModels];persistAtom({key:seenModelsKey,value}).catch(()=>{});if(payload.type==='persisted-atom-sync'){payload.state={...payload.state,[seenModelsKey]:value};payload.atoms={...payload.atoms,[seenModelsKey]:value};}else{payload.value=value;payload.deleted=false;}}}
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
  if(payload?.type==='codex-app-server-connection-changed'){window.__DSH_NATIVE_ONLINE__=payload.state==='connected';invalidateReadChecks();if(payload.state!=='connected'){resetPinnedReads();resetStableIpc();}}
  if(payload?.type==='mcp-response'){const message=payload.message;completeAuxiliaryIpc(message?.id,message,payload.hostId);const key=rpcReads.get(message?.id);rpcReads.delete(message?.id);if(key&&!message.error)saveMeta(key,message.result).catch(()=>{});}
  if(payload?.type==='fetch-response'){const shared=stableIpcPending.get(payload.requestId);if(shared){stableIpcPending.delete(payload.requestId);if(payload.responseType==='success')try{stableIpcChecked.set(shared.key,{value:JSON.parse(payload.bodyJsonString),at:Date.now()});}catch{}for(const waiter of shared.waiters)waiter.emit('fetch-response',{...payload,requestId:waiter.id});}}
  if(payload?.type==='fetch-response'){const key=ipcReads.get(payload.requestId),pin=pinnedRequests.get(payload.requestId);ipcReads.delete(payload.requestId);pinnedRequests.delete(payload.requestId);if(retiredPinnedReads.delete(payload.requestId)||(pin&&(pin.epoch!==pinnedEpoch||pin.order<pinnedAcceptedOrder))){payload.responseType='error';payload.status=409;payload.error='置顶列表读取已被较新的状态替换';delete payload.bodyJsonString;return true;}if(pin&&payload.responseType==='success')pinnedAcceptedOrder=pin.order;if(key&&payload.responseType==='success')try{const value=JSON.parse(payload.bodyJsonString),[method,params]=JSON.parse(key.slice(4));if(hostPathEpoch&&method==='codex-home'&&(!params.hostId||params.hostId==='local')&&typeof value?.codexHome==='string'&&value.codexHome.startsWith('/')&&(value.worktreesSegment==null||typeof value.worktreesSegment==='string'))hostPaths=structuredClone(value);if(pin){if(pin.epoch===pinnedEpoch){saveMeta(key,value).then(()=>{if(pin.epoch!==pinnedEpoch)return;pinnedDirty=false;pinnedCheckedAt=Date.now();warmPinned(value).catch(()=>{});broadcast?.postMessage({type:'pinned-cache',key});if(pin.previous!=null&&pin.previous!==JSON.stringify(value))pin.emit('pinned-threads-updated',{});}).catch(()=>{});}}else saveMeta(key,value).catch(()=>{});}catch{}}
 };
 // Consult immutable app-private copies before opening a remote file or entering the offline gate.
 async function localDeliverable(params){
  if(params?.hostId&&params.hostId!=='local')return null;
  const path=params?.path||params?.filePath;if(typeof path!=='string'||!path.startsWith('/'))return null;
  const bridge=window.__DSH_ANDROID_BRIDGE__;if(typeof bridge?.resolveDeliverable!=='function')return null;
  try{const value=await bridge.resolveDeliverable(path);return value?.available===true?value:null;}catch{return null;}
 }
 window.__DSH_LOCAL_DELIVERABLE__=localDeliverable;
 const localFileMetadata=d=>({isFile:true,isDirectory:false,sizeBytes:d.size,mtimeMs:d.mtimeMs,createdAtMs:d.createdAtMs,contentKind:d.contentKind});
 async function localFileBytes(d,maxBytes=20*1024*1024){
  if(d.size>maxBytes)throw Error('文件较大，请使用文件预览或保存入口');
  const r=await fetch(d.url,{credentials:'same-origin',cache:'no-store'});if(!r.ok||r.headers.get('etag')!=='"'+d.version+'"')throw Error('本机文件版本暂不可用');
  const bytes=new Uint8Array(await r.arrayBuffer());if(bytes.length!==d.size)throw Error('本机文件未完整保存');return bytes;
 }
 const base64=bytes=>{let value='';for(let i=0;i<bytes.length;i+=32768)value+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(value);};
 async function localFileRead(d,p={}){const bytes=await localFileBytes(d,p.maxBytes??20*1024*1024);let text;
  if(p.representation==='text')text=new TextDecoder().decode(bytes);else if(p.representation!=='blob')try{const decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!decoded.includes('\0'))text=decoded;}catch{}
  return {...(text===undefined?{blob:base64(bytes)}:{text}),etag:d.sourceVersion};
 }
 window.__DSH_IPC_CACHE__=async(channel,payload,emit)=>{
  if(channel==='open-file'){const d=await localDeliverable(payload);if(d)return {handled:true,value:{url:d.url}};}
  if(payload?.type==='fetch'){
   const method=String(payload.url||'').replace(/^vscode:\/\/codex\//,'');
   if(['read-file','read-file-binary','read-file-metadata'].includes(method)){
    let input={};try{input=typeof payload.body==='string'?JSON.parse(payload.body):payload.body||{};}catch{}
    const p=input.params||input,d=await localDeliverable(p);
    if(d){try{const value=method==='read-file-metadata'?localFileMetadata(d):method==='read-file'?{contents:(await localFileRead(d,{...p,representation:'text'})).text}:{contentsBase64:base64(await localFileBytes(d)),mimeType:d.mime};
      emit('fetch-response',{requestId:payload.requestId,responseType:'success',status:200,headers:{'content-type':'application/json'},bodyJsonString:JSON.stringify(value)});
     }catch(error){emit('fetch-response',{requestId:payload.requestId,responseType:'error',status:503,error:error.message});}return {handled:true,value:null};}
   }
  }
  const config=window.__CODEX_WEB_CONFIG__||{};
  if(channel==='codex_desktop:get-initial-sidebar-bootstrap'&&config.initialSidebarBootstrap&&!await meta('auth-locked').catch(()=>true))return {handled:true,value:(await prepareSidebarBootstrap(config)).initialSidebarBootstrap};
  // official-front's shared objects are a fixed scoped bootstrap snapshot; it
  // does not register these subscriptions or mutate them. Keep the same reply locally.
  if(channel==='codex_desktop:message-from-view'&&config.sharedObjectSnapshot&&['shared-object-subscribe','shared-object-unsubscribe'].includes(payload?.type)){
   diagnostics.localSharedNotifications++;if(payload.type==='shared-object-subscribe'){const key=payload.key||payload.objectId;emit('shared-object-updated',{key,value:config.sharedObjectSnapshot[key]});}return {handled:true,value:null};
  }
  const label=payload?.type==='fetch'?String(payload.url||'').replace(/^vscode:\/\/codex\//,''):payload?.type||channel;diagnostics.ipc[label]=(diagnostics.ipc[label]||0)+1;
  if(channel==='codex_desktop:worker:git:from-view'&&window.__DSH_EXECUTION_CONNECTED__===false){if(payload?.type==='worker-request')emit('codex_desktop:worker:git:for-view',{type:'worker-response',workerId:'git',response:{id:payload.request.id,method:payload.request.method,result:{type:'error',error:'Git 实时状态需要连接 Mac'}}});return {handled:true,value:null};}
  if((payload?.type==='mcp-request'&&['thread/start','thread/resume'].includes(payload.request?.method)||payload?.type==='thread-prewarm-start')&&window.__DSH_EXECUTION_CONNECTED__!==true){try{await waitForExecution();}catch(error){emit('mcp-response',{hostId:'local',message:{id:payload.request?.id,error:{code:-32000,message:error.message,data:{status:503,notSubmitted:true}}}});return {handled:true,value:null};}}
  if(payload?.type==='mcp-request'&&payload.request?.method==='thread/resume'){resumeReads.set(payload.request.id,payload.request.params?.threadId);while(resumeReads.size>100)resumeReads.delete(resumeReads.keys().next().value);}
  if(payload?.type==='mcp-request'&&AUX.has(payload.request?.method)){rpcReads.set(payload.request.id,'aux:'+JSON.stringify([payload.request.method,canonical(payload.request.params||{})]));while(rpcReads.size>500)rpcReads.delete(rpcReads.keys().next().value);}
  // Direct startup readers share one leader. A negotiated bulk read finishes
  // over HTTP; errors never replay the same request through the control socket.
  if(channel==='codex_desktop:message-from-view'&&payload?.type==='mcp-request'&&(window.__DSH_EXECUTION_CONNECTED__===true||navigator.onLine&&typeof window.__DSH_WAIT_BULK_READ_HTTP__==='function')&&['app/list','mcpServerStatus/list','thread/list'].includes(payload.request?.method)){
   const {id,method,params={}}=payload.request,hostId=payload.hostId||'local',key=JSON.stringify([channel,hostId,method,canonical(params)]);
   for(const entry of auxiliaryIpcPending.values())if(entry.key===key){entry.waiters.push({id,emit});diagnostics.coalesced++;return {handled:true,value:null};}
   const http=hostId==='local'&&navigator.onLine&&typeof window.__DSH_WAIT_BULK_READ_HTTP__==='function';
   const entry={key,hostId,payload,waiters:[],emit,controller:http?new AbortController():null,deadlineAt:Date.now()+30000},entryId=auxiliaryIpcId(hostId,id);auxiliaryIpcPending.set(entryId,entry);
   if(http){
    let message;
    try{
     const supported=await window.__DSH_WAIT_BULK_READ_HTTP__({signal:entry.controller.signal,deadlineAt:entry.deadlineAt});
     if(auxiliaryIpcPending.get(entryId)!==entry)return {handled:true,value:null};
     if(!supported){entry.controller=null;return null;}
     let result;
     if(method==='app/list')result=await conditionalAppCatalog(params,entry.controller.signal,entry.deadlineAt);
     else{const response=await window.__DSH_READ_BULK_RPC__(method,params,{signal:entry.controller.signal,deadlineAt:entry.deadlineAt});if(response?.status!==200||!Object.hasOwn(response,'result'))throw Error('读取响应格式无效');result=response.result;}
     message={id,result};
    }catch(error){message={id,error:{code:Number.isInteger(error?.rpcCode)?error.rpcCode:Number.isInteger(error?.code)&&error.code<0?error.code:-32000,message:String(error?.message||'目录读取失败'),data:{status:Number(error?.status)||(Number(error?.code)>=400?Number(error.code):503)}}};}
    if(auxiliaryIpcPending.get(entryId)===entry){
     if(method==='app/list'){completeAuxiliaryIpc(id,message,hostId,payload);rpcReads.delete(id);}
     else window.__DSH_IPC_CACHE_RESPONSE__({type:'mcp-response',hostId,message});
     emit('mcp-response',{hostId,message});
    }
    return {handled:true,value:null};
   }
  }
  if(payload?.type==='mcp-request'&&window.__DSH_EXECUTION_CONNECTED__===false){const request=payload.request,method=request?.method,params=request?.params||{};
   if(READS.has(method)||AUX.has(method)){try{let result;if(READS.has(method)){const record=await get(readKey(method,params));if(record&&!record.deleted)result=record.payload.result;}
     else result=(method==='app/list'&&!await meta('auth-locked').catch(()=>true)?(await savedAppCatalog(params))?.result:undefined)??await meta('aux:'+JSON.stringify([method,canonical(params)])).catch(()=>undefined)??config.dshReadDefaults?.[method];
     if(result===undefined){diagnostics.misses++;throw Error('这项内容尚未保存在本机缓存');}diagnostics.hits++;
     emit('mcp-response',{hostId:'local',message:{id:request.id,result}});
    }catch(error){emit('mcp-response',{hostId:'local',message:{id:request.id,error:{code:-32000,message:error.message,data:{status:503}}}});}
    return {handled:true,value:null};
   }
   emit('mcp-response',{hostId:'local',message:{id:request.id,error:{code:-32000,message:'当前为缓存阅读；连接 Mac 后可继续任务',data:{status:503}}}});return {handled:true,value:null};
  }
  if(payload?.type==='thread-prewarm-start'&&window.__DSH_EXECUTION_CONNECTED__===false){emit('mcp-response',{hostId:'local',message:{id:payload.request?.id,error:{code:-32000,message:'当前为缓存阅读',data:{status:503}}}});return {handled:true,value:null};}
  if(window.__DSH_EXECUTION_CONNECTED__===false){
   const direct={'codex_desktop:get-initial-sidebar-bootstrap':config.initialSidebarBootstrap,'codex_desktop:get-shared-object-snapshot':config.sharedObjectSnapshot,'codex_desktop:get-build-flavor':'prod','codex_desktop:get-system-theme-variant':matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light','codex_desktop:get-sentry-init-options':null};
   if(Object.hasOwn(direct,channel))return {handled:true,value:direct[channel]};
   if(payload?.type==='persisted-atom-sync-request'){const atoms={...config.persistedAtomSnapshot,...await restoreAtoms().catch(()=>({}))};emit('persisted-atom-sync',{state:atoms,atoms});return {handled:true,value:null};}
   if(['ready','view-ready'].includes(payload?.type)){const initialized=await meta('native-initialization').catch(()=>null);if(initialized)emit('codex-app-server-initialized',{...initialized,isSnapshot:true});emit('codex-app-server-connection-changed',{hostId:'local',state:'connected',transport:'websocket',isSnapshot:true});return {handled:true,value:null};}
  }
  // Non-request view notifications have no remote work while this transport
  // is disconnected. Avoid a retry/log storm against an absent front.
  if(payload?.type!=='fetch'){if(window.__DSH_EXECUTION_CONNECTED__===false&&payload?.type!=='persisted-atom-update')return {handled:true,value:null};return null;}const method=String(payload.url||'').replace(/^vscode:\/\/codex\//,'');if(!IPC_READS.has(method)){if(window.__DSH_EXECUTION_CONNECTED__===false){emit('fetch-response',{requestId:payload.requestId,responseType:'error',status:503,error:'这项操作需要连接 Mac'});return {handled:true,value:null};}return null;}
  let input={};try{input=typeof payload.body==='string'?JSON.parse(payload.body):payload.body||{};}catch{}const params=input.params||input,key=ipcReadKey(method,params);ipcReads.set(payload.requestId,key);while(ipcReads.size>500)ipcReads.delete(ipcReads.keys().next().value);
  if(method==='list-pinned-threads'){
   pinnedEmit=emit;const saved=await meta(key).catch(()=>undefined)??await meta('ipc:'+JSON.stringify([method,canonical(params)])).catch(()=>undefined),locked=await meta('auth-locked').catch(()=>false);
   if(saved!==undefined&&!locked&&!pinnedDirty){diagnostics.hits++;emit('fetch-response',{requestId:payload.requestId,responseType:'success',status:200,headers:{'content-type':'application/json'},bodyJsonString:JSON.stringify(saved)});warmPinned(saved).catch(()=>{});
    if(window.__DSH_EXECUTION_CONNECTED__===false||pinnedRequests.size||Date.now()-pinnedCheckedAt<60000){ipcReads.delete(payload.requestId);return {handled:true,value:null};}
    // The renderer has its cached answer; this original READ continues only to validate it.
    pinnedRequests.set(payload.requestId,{key,epoch:pinnedEpoch,order:++pinnedReadOrder,previous:JSON.stringify(saved),emit});return null;
   }
   if(window.__DSH_EXECUTION_CONNECTED__!==false)pinnedRequests.set(payload.requestId,{key,epoch:pinnedEpoch,order:++pinnedReadOrder,previous:null,emit});while(pinnedRequests.size>100)pinnedRequests.delete(pinnedRequests.keys().next().value);
  }
  if(window.__DSH_EXECUTION_CONNECTED__!==false&&STABLE_IPC.has(method)){
   const saved=stableIpcChecked.get(key);if(saved&&Date.now()-saved.at<60000){diagnostics.ipcStableHits++;ipcReads.delete(payload.requestId);emit('fetch-response',{requestId:payload.requestId,responseType:'success',status:200,headers:{'content-type':'application/json'},bodyJsonString:JSON.stringify(saved.value)});return {handled:true,value:null};}
   for(const entry of stableIpcPending.values())if(entry.key===key){entry.waiters.push({id:payload.requestId,emit});ipcReads.delete(payload.requestId);diagnostics.coalesced++;return {handled:true,value:null};}
   stableIpcPending.set(payload.requestId,{key,waiters:[]});
  }
  if(window.__DSH_EXECUTION_CONNECTED__!==false)return null;
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
  if(appHostError)return Promise.reject(appHostError);
  const ready=()=>window.__DSH_EXECUTION_CONNECTED__===true&&window.__DSH_APP_HOST_READY__!==false;
  if(navigator.onLine&&ready())return Promise.resolve();
  if(!navigator.onLine)return Promise.reject(Error('设备离线，操作尚未发送；可继续阅读缓存'));
  return new Promise((resolve,reject)=>{
   let timer,finished=false;
   const finish=error=>{if(finished)return;finished=true;clearTimeout(timer);for(const type of ['dsh:execution-state','dsh:app-host-state','dsh:session-ready','offline','dsh:authentication-required'])removeEventListener(type,changed);signal?.removeEventListener?.('abort',cancel);error?reject(error):resolve();};
   const cancel=()=>finish(Error('操作已取消，尚未发送'));
   const changed=event=>{if(event?.type==='dsh:authentication-required')return finish(Error('登录已过期，操作尚未发送'));if(!navigator.onLine)return finish(Error('设备离线，操作尚未发送；可继续阅读缓存'));if(appHostError)return finish(appHostError);if(ready())finish();};
   for(const type of ['dsh:execution-state','dsh:app-host-state','dsh:session-ready','offline','dsh:authentication-required'])addEventListener(type,changed);
   signal?.addEventListener?.('abort',cancel,{once:true});
   timer=setTimeout(()=>finish(Error('Mac 连接尚未恢复，操作未发送；草稿已保留')),30000);
   try{window.__DSH_RECONNECT_TRANSPORT__?.();}catch{}changed();
  });
 }
 const disposable=value=>Object.assign(value,{[Symbol.dispose]:()=>{}});
 const rpcValue=value=>{if(value&&typeof value==='object'&&typeof value[Symbol.dispose]!=='function')Object.defineProperty(value,Symbol.dispose,{value:()=>{},configurable:true});return value;};
 const rpcLocal=service=>{for(const key of Object.keys(service)){const method=service[key];if(typeof method!=='function')continue;service[key]=(...args)=>{const result=method(...args);return result?.then?disposable(Promise.resolve(result).then(rpcValue)):rpcValue(result);};}return rpcValue(service);};
 function remote(name,method,args){let call,binding,cancelled=false;const controller=typeof AbortController==='function'?new AbortController():null;const promise=Promise.resolve().then(async()=>{await waitForExecution(controller?.signal);binding=remoteServices;return binding;}).then(services=>{if(cancelled)throw Error('DSH_APP_HOST_ABORTED: 操作已取消，尚未提交');if(binding!==remoteServices||!remoteReady)throw Error('DSH_APP_HOST_REPLACED: 页面连接已更换，操作尚未提交');const service=services[name];if(!service?.[method])throw Error('这项操作需要 Mac 连接');call=service[method](...args);return call;});promise[Symbol.dispose]=()=>{cancelled=true;controller?.abort();call?.[Symbol.dispose]?.();};return promise;}
 const proxy=name=>new Proxy({},{get:(_,method)=>method==='then'?undefined:method===Symbol.dispose?()=>{}:(...args)=>remote(name,method,args)});
 window.__DSH_LOCAL_APP_HOST__=async remotePromise=>{
  diagnostics.hostCreated=true;const hostGeneration=++appHostGeneration;remoteReady=false;appHostError=null;appHostState();
  remoteServices=Promise.resolve(remotePromise).then(value=>{if(hostGeneration===appHostGeneration){remoteReady=true;appHostState();}return value;},error=>{if(hostGeneration===appHostGeneration){remoteReady=false;appHostError=Error('DSH_APP_HOST_UNAVAILABLE: 页面服务尚未恢复，操作未发送；草稿已保留');window.__DSH_CLIENT_LOG__?.reportError('transport',error,{component:'page-ws',stage:'failed',reason:'upstream_failure'});appHostState();}throw error;});remoteServices.catch(()=>{});try{await meta('catalog-generation');}catch{return remoteServices;}
  const services=Object.fromEntries(['threadArchive','httpFetch','threadProjectAssignments','clipboard','workspaceFiles','fileAttachments','dynamicToolCalls','clientCoordination'].map(name=>[name,proxy(name)]));
  const remoteFiles=services.workspaceFiles;
  services.workspaceFiles=new Proxy({},{get:(_,method)=>method==='then'?undefined:method===Symbol.dispose?()=>{}:(...args)=>{
   if(!['read','getThumbnailDataUrl','saveCopy','downloadCopy'].includes(method)||args[0]?.bytes)return remoteFiles[method](...args);
   let call;const pending=Promise.resolve().then(async()=>{const p=args[0]||{},d=await localDeliverable(p);
    if(d){if(['saveCopy','downloadCopy'].includes(method)){await window.__DSH_ANDROID_BRIDGE__.openDeliverable(d.path);return rpcValue({path:d.path});}if(method==='read')return rpcValue(await localFileRead(d,p));if(d.contentKind==='image')return rpcValue({dataUrl:'data:'+d.mime+';base64,'+base64(await localFileBytes(d))});}
    call=remoteFiles[method](...args);return call;
   });pending[Symbol.dispose]=()=>call?.[Symbol.dispose]?.();return pending;
  }});
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
   async readAll(){const cached=await meta('settings').catch(()=>remote('settings','readAll',[]))||{values:{followUpQueueMode:'steer',...window.__CODEX_WEB_CONFIG__?.dshSettings},configuredValues:{...window.__CODEX_WEB_CONFIG__?.dshSettings}};refreshOnce('settings',30000,async()=>{diagnostics.settingsRefreshes++;const epoch=settingsEpoch;return {epoch,value:await remote('settings','readAll',[])};},result=>cacheSettings(async()=>{if(result.epoch===settingsEpoch)await saveMeta('settings',result.value);})).catch(()=>{});const key='enabled-reasoning-efforts',levels=cached.values?.[key]||['low','medium','high','xhigh','ultra','persistent'];return {...cached,values:{...cached.values,[key]:[...new Set([...levels.filter(x=>!['ultra','persistent'].includes(x)),'max',...levels.filter(x=>['ultra','persistent'].includes(x))])]}};},
   async read(key){const value=(await services.settings.readAll());return {effective:value.values[key],configured:value.configuredValues[key]};},
   async write(key,value){settingsEpoch++;await remote('settings','write',[key,value]);settingsEpoch++;invalidateReadChecks();await cacheSetting(key,{effective:value,configured:value}).catch(()=>{});notifySetting(key,{effective:value,configured:value});},
   async subscribe(key,callback){let subscription=null,closed=false;let listeners=settingListeners.get(key);if(!listeners){listeners=new Set();settingListeners.set(key,listeners);}const localCallback=value=>{if(!closed)return callback(value);};listeners.add(localCallback);await callback(await services.settings.read(key));remote('settings','subscribe',[key,async value=>{settingsEpoch++;invalidateReadChecks();await cacheSetting(key,value).catch(()=>{});if(!closed){if(key==='enabled-reasoning-efforts')callback(await services.settings.read(key));else callback(value);}}]).then(s=>{subscription=s;if(closed)s.dispose();}).catch(()=>{});return {dispose(){closed=true;listeners.delete(localCallback);if(!listeners.size)settingListeners.delete(key);subscription?.dispose();},unsubscribe(){this.dispose();},[Symbol.dispose](){this.dispose();}};}
  };
  services.requestUserInputAutoResolution={async setConversationPresented(p){if(p.hostId!=='local')throw Error('工作区宿主不匹配');if(p.presented&&/^[0-9a-f-]{36}$/i.test(p.conversationId)){const path='/local/'+p.conversationId;if(window.__DSH_NAVIGATION__?.acceptRoute(path)===false)return;const url=new URL(location.href);url.pathname=path;url.searchParams.set('workspace',scope.id);if(window.__DSH_NATIVE_SIDEBAR__?.isList)url.searchParams.set('nativeList','1');const routeChanged=location.pathname!==path;history.replaceState(history.state,'',url.href);if(routeChanged)window.dispatchEvent(new CustomEvent('dsh:native-route',{detail:{path}}));window.__DSH_NAVIGATION__?.presented(p.conversationId);hydrateCachedThread(p.conversationId).catch(()=>{});}if(window.__DSH_EXECUTION_CONNECTED__===true)remote('requestUserInputAutoResolution','setConversationPresented',[p]).catch(()=>{});},async recordConversationActivity(p){if(window.__DSH_EXECUTION_CONNECTED__===true)remote('requestUserInputAutoResolution','recordConversationActivity',[p]).catch(()=>{});}};
  for(const name of ['localThreadCatalog','startup','appInfo','settings','httpFetch','requestUserInputAutoResolution'])rpcLocal(services[name]);
  return rpcValue(services);
 };
 function installCapacityRetryUI(client,original){
  let closed=false,pending=null,state=null,threadId='',version=0,lastRead=0,banner=null,label=null,stop=null;
  const visibleId=()=>window.__DSH_NATIVE_SIDEBAR__?.isList?null:location.pathname.match(/^\/local\/([0-9a-f-]{36})$/i)?.[1];
  const remove=()=>{banner?.remove();banner=null;label=null;stop=null;};
  const paint=()=>{
   if(closed||visibleId()!==threadId||!state||!['verifying','waiting','checking','dispatching','unknown','unavailable'].includes(state.state)){remove();return;}
   if(!banner){banner=document.createElement('aside');banner.className='dsh-capacity-retry';banner.setAttribute('role','status');banner.setAttribute('aria-live','polite');banner.style.cssText='position:fixed;left:12px;right:12px;bottom:80px;z-index:800;max-width:440px;margin:auto;padding:10px 12px;border:1px solid #90909055;border-radius:12px;background:Canvas;color:CanvasText;box-shadow:0 4px 20px #0002;display:flex;gap:12px;align-items:center;font-size:13px';label=document.createElement('span');label.style.flex='1';stop=document.createElement('button');stop.type='button';stop.textContent='停止自动重试';stop.style.cssText='border:1px solid #90909055;border-radius:8px;background:transparent;color:inherit;padding:6px 10px;white-space:nowrap';banner.append(label,stop);document.body.append(banner);stop.onclick=async()=>{const captured=state,stamp=version;stop.disabled=true;try{const value=await original('dsh/capacityRetry/cancel',{threadId:captured.threadId,failedTurnId:captured.failedTurnId});if(!closed&&version===stamp&&state===captured){state=value.retry;paint();}}catch{if(!closed&&version===stamp){label.textContent='停止结果尚未确认，正在核对';lastRead=0;refresh().catch(()=>{});}}};}
   const minutes=Math.max(1,Math.ceil((state.dueAt-Date.now())/60000));
   label.textContent=state.state==='waiting'?'模型容量暂满，约 '+minutes+' 分钟后自动继续':state.state==='unknown'?'自动继续的结果待核对，不会重复发送':state.state==='unavailable'?'自动继续未执行，连接恢复后可手动继续':'正在核实原失败回合并自动继续';
   stop.hidden=!['verifying','waiting','checking'].includes(state.state);stop.disabled=false;
  };
  async function refresh(){
   if(closed||window.__CODEX_WEB_CONFIG__?.dshCapacityRetry!==true||!navigator.onLine||window.__DSH_EXECUTION_CONNECTED__!==true)return;
   const id=visibleId();if(!id){state=null;threadId='';version++;remove();return;}
   if(id!==threadId){threadId=id;state=null;version++;remove();}
   const stamp=version;if(pending?.stamp===stamp)return pending.promise;
   const entry={stamp,promise:null,again:false};entry.promise=original('dsh/capacityRetry/read',{threadId:id}).then(value=>{if(!closed&&version===stamp&&visibleId()===id){state=value.retry;lastRead=Date.now();paint();}}).catch(()=>{}).finally(()=>{if(pending===entry){pending=null;if(entry.again&&!closed&&version===stamp)refresh().catch(()=>{});}});pending=entry;return entry.promise;
  }
  const changed=()=>{if(visibleId()!==threadId){version++;state=null;pending=null;remove();}refresh().catch(()=>{});};
  const disposers=['error','turn/completed','turn/started'].map(method=>client.addNotificationCallback?.(method,({params})=>{if(params.threadId===visibleId()){if(method==='turn/started'){version++;state=null;pending=null;remove();}else if(pending)pending.again=true;refresh().catch(()=>{});}}));
  for(const type of ['dsh:native-route','dsh:session-ready','dsh:execution-state'])addEventListener(type,changed);
  const timer=setInterval(()=>{if(document.visibilityState!=='visible')return;if(state){paint();if(['verifying','waiting','checking','dispatching'].includes(state.state)&&Date.now()-lastRead>=15000)refresh().catch(()=>{});}},1000);refresh().catch(()=>{});
  return ()=>{closed=true;version++;clearInterval(timer);remove();for(const type of ['dsh:native-route','dsh:session-ready','dsh:execution-state'])removeEventListener(type,changed);for(const dispose of disposers)if(typeof dispose==='function')dispose();};
 }
 window.__DSH_INSTALL_NATIVE_READ_CACHE__=client=>{
  const target=client.requestClient;if(client.hostId!=='local'||!target||installed.has(target))return;installed.add(target);nativeClient=client;window.__DSH_NATIVE_STATUS_RECOVERY__?.register(client);const original=target.sendRequest.bind(target);
  // Authentication is a current Native fact. A stale logged-out snapshot must
  // not win a live read and strand the official AuthProvider on onboarding.
  const isAuthRead=method=>method==='account/read'||method==='getAuthStatus';
  const liveAuthRead=(method,params,options)=>{const key='aux:'+JSON.stringify([method,canonical(params)]);return refreshOnce('live-auth:'+key,0,()=>original(method,params,options),value=>saveMeta(key,value).catch(()=>{diagnostics.authCacheFailures=(diagnostics.authCacheFailures||0)+1;}));};
  stopNativeAuthRecovery?.();invalidateReadChecks();
  let authEpoch=0,authReady=window.__DSH_EXECUTION_CONNECTED__===true,authRecovered=-1,authRecovery=null,authClosed=false,authPublishing=false;
  const reconcileAuth=()=>{
   if(authClosed||nativeClient!==client)return;
   const ready=window.__DSH_EXECUTION_CONNECTED__===true;
   if(ready!==authReady){authReady=ready;authEpoch++;authRecovery=null;invalidateReadChecks();}
   if(!ready||authRecovered===authEpoch||authRecovery?.epoch===authEpoch)return;
   const epoch=authEpoch,entry={epoch,promise:null};
   entry.promise=Promise.all([liveAuthRead('account/read',{refreshToken:false}),liveAuthRead('getAuthStatus',{includeToken:false,refreshToken:false})]).then(([account,status])=>{
    if(authClosed||nativeClient!==client||epoch!==authEpoch||window.__DSH_EXECUTION_CONNECTED__!==true)return;
    if(!account||!Object.hasOwn(account,'account')||!status||!Object.hasOwn(status,'authMethod'))return;
    authRecovered=epoch;authPublishing=true;
    try{client.onNotification?.('account/updated',{authMode:status.authMethod});}finally{authPublishing=false;}
   }).catch(()=>{}).finally(()=>{if(authRecovery===entry)authRecovery=null;});authRecovery=entry;
  };
  const invalidateAuth=()=>{if(authPublishing||authClosed||nativeClient!==client)return;authEpoch++;authRecovered=-1;authRecovery=null;invalidateReadChecks();};
  const disposeAuthNotification=client.addNotificationCallback?.('account/updated',invalidateAuth);
  addEventListener('dsh:execution-state',reconcileAuth);addEventListener('dsh:session-ready',reconcileAuth);
  stopNativeAuthRecovery=()=>{authClosed=true;authEpoch++;removeEventListener('dsh:execution-state',reconcileAuth);removeEventListener('dsh:session-ready',reconcileAuth);if(typeof disposeAuthNotification==='function')disposeAuthNotification();};
  const userStopIntents=new Map();
  const executionEpoch=new Map();
  // Body streaming changes history, not the command target. Only execution
  // transitions can invalidate a freshly verified turn identity.
  for(const method of ['turn/started','turn/completed','thread/reverted','thread/compacted'])client.addNotificationCallback?.(method,({params})=>{if(params.threadId)executionEpoch.set(params.threadId,(executionEpoch.get(params.threadId)||0)+1);});
  // A fresh Native head belongs to the current transport lifetime, even when
  // another surviving socket keeps the aggregate "connected" boolean true.
  let submissionGeneration=0;
  const invalidateSubmissionHead=()=>{submissionGeneration++;};
  // A route change selects a view; it does not retire the execution connection
  // or the explicit submission already bound to another conversation.
  const submissionEvents=['dsh:execution-state','dsh:app-host-state','dsh:authentication-required'];
  for(const event of submissionEvents)addEventListener(event,invalidateSubmissionHead);
  client.dshDisposeSubmissionHead=()=>{submissionGeneration++;for(const event of submissionEvents)removeEventListener(event,invalidateSubmissionHead);};
  const stopAuthRecovery=stopNativeAuthRecovery;stopNativeAuthRecovery=()=>{client.dshDisposeSubmissionHead();stopAuthRecovery?.();};
  const stoppingError=()=>{const error=Error('上一条消息仍在停止，请稍后再发送；草稿已保留');error.code='DSH_TURN_STOPPING';return error;};
  const stopOutcomeUnknown=(intent,error)=>{
   if(!intent.dispatched)return false;
   const status=error?.data?.status??error?.status??error?.code;
   if(error?.delivery?.stage==='outcome-unknown'||[408,503,504].includes(status)||/timeout|结果待核对|确认未收到/i.test(error?.message||''))return true;
   // A returned Native/validation rejection is definitive. A plain timeout,
   // disconnect or untyped dispatch error does not prove the stop was unsent.
   return !((Number.isInteger(status)&&status>=400&&status<500)||(status===502&&Number.isInteger(error?.jsonRpcCode))||[-32600,-32601,-32602].includes(error?.jsonRpcCode));
  };
  // Rendering may use a cached head. Sending must consult the current Native
  // turn before the official coordinator chooses queue, steer, or start.
  client.dshReadExecutionHead=async id=>{
   await waitForExecution();
   const stamp=executionEpoch.get(id)||0,generation=submissionGeneration,frontEpoch=hostPathEpoch,services=remoteServices;
   const [head,page,policyRead]=await Promise.all([original('thread/read',{threadId:id,includeTurns:false}),original('thread/turns/list',{threadId:id,limit:1,sortDirection:'desc',itemsView:'notLoaded'}),original('config/read',{includeLayers:false})]);
   if(head?.thread?.id!==id||!Array.isArray(page?.data))throw Error('当前轮次尚未核实，草稿已保留');
   const latest=page.data[0],activeTurnId=latest?.status==='inProgress'?latest.id:null;
   if(head.thread.status?.type==='active'&&!activeTurnId)throw Error('当前轮次正在变化，请稍后重试；草稿已保留');
   const stopping=userStopIntents.get(id);
   if(client.disposed||nativeClient!==client||generation!==submissionGeneration||frontEpoch!==hostPathEpoch||services!==remoteServices||!navigator.onLine||window.__DSH_EXECUTION_CONNECTED__!==true||stamp!==(executionEpoch.get(id)||0)){if(stopping)throw stoppingError();return {isCurrent:()=>false};}
   if(stopping){
    // Interrupt acceptance does not mean Native has released this turn. Do not
    // restore its optimistic interrupted state to running or steer a new draft
    // into the turn the user just stopped. Only Native can retire this intent.
    if(activeTurnId===stopping.turnId)throw stoppingError();
    if(head.thread.status?.type==='idle'&&!activeTurnId||latest&&(latest.id!==stopping.turnId||['completed','failed','interrupted'].includes(latest.status)))userStopIntents.delete(id);
   }
   const conversation=client.getConversation?.(id),turns=conversation?.turnHistory?.kind==='canonical'?Object.values(conversation.turnHistory.history.entitiesByKey||{}):conversation?.turns||[];
   client.onNotification?.('thread/status/changed',{threadId:id,status:head.thread.status});
   if(activeTurnId){
    if(!turns.some(turn=>turn.turnId===activeTurnId))client.onNotification?.('turn/started',{threadId:id,turn:latest});
    client.updateTurnState?.(id,activeTurnId,turn=>{turn.status='inProgress';if(Number.isFinite(latest.startedAt))turn.turnStartedAtMs=latest.startedAt*1000;});
   }else if(latest&&['completed','failed','interrupted'].includes(latest.status)){
    // Update display state directly; never synthesize completion notifications.
    client.updateTurnState?.(id,latest.id,turn=>{turn.status=latest.status;});
   }
   const settled=executionEpoch.get(id)||0;
   return {hostPolicy:policyRead?.config,threadId:id,activeTurnId,loaded:['idle','active'].includes(head.thread.status?.type),activeFlags:head.thread.status?.activeFlags||[],threadSource:head.thread.threadSource??null,isCurrent:()=>!client.disposed&&nativeClient===client&&generation===submissionGeneration&&frontEpoch===hostPathEpoch&&services===remoteServices&&navigator.onLine&&window.__DSH_EXECUTION_CONNECTED__===true&&!userStopIntents.has(id)&&settled===(executionEpoch.get(id)||0)};
  };

  // Read-only quota facade; persist only display fields, never account or reset-credit IDs.
  let quotaPending=null;
  const quotaDisplay=result=>({buckets:Object.values({...((result.rateLimits)?{[result.rateLimits.limitId||'codex']:result.rateLimits}:{}),...result.rateLimitsByLimitId}).map(b=>({id:b.limitId,name:b.limitName||'Codex',plan:b.planType,primary:b.primary,secondary:b.secondary,credits:b.credits?{unlimited:b.credits.unlimited,balance:b.credits.balance}:null})),resetsAvailable:result.rateLimitResetCredits?.availableCount});
  const rememberQuota=async result=>{const snapshot={data:quotaDisplay(result),checkedAt:Date.now()};await saveMeta('account-quota-v1',snapshot).catch(()=>{diagnostics.quotaCacheFailures=(diagnostics.quotaCacheFailures||0)+1;});window.dispatchEvent(new CustomEvent('dsh:quota-updated',{detail:snapshot}));return snapshot;};
  window.__DSH_READ_ACCOUNT_LIMITS__=async()=>{
   if(!navigator.onLine||window.__DSH_EXECUTION_CONNECTED__!==true)throw Error('连接恢复后可刷新额度');
   if(!quotaPending)quotaPending=original('account/rateLimits/read',{}).then(rememberQuota).finally(()=>{quotaPending=null;});
   return quotaPending;
  };
  client.addNotificationCallback?.('account/rateLimits/updated',()=>window.dispatchEvent(new Event('dsh:quota-invalidated')));
  client.addNotificationCallback?.('thread/started',({params})=>listableThread(params.thread));
  client.addNotificationCallback?.('turn/started',({params})=>{if(params.threadId)listableThread({id:params.threadId,status:{type:'active'}});});
  for(const method of ['item/started','item/completed','item/agentMessage/delta','item/reasoning/textDelta','item/commandExecution/outputDelta','turn/started','turn/completed','thread/reverted','thread/compacted'])client.addNotificationCallback?.(method,({params})=>{if(params.threadId){if(method==='thread/reverted'||method==='thread/compacted'){recoveryEpoch.set(params.threadId,(recoveryEpoch.get(params.threadId)||0)+1);finalRecovery.delete(params.threadId);restoredFinal.delete(params.threadId);memoryMeta.set(recoveryKey(params.threadId),null);saveMeta(recoveryKey(params.threadId),null).catch(()=>{});}nativeActivity.set(params.threadId,Date.now());nativeEventEpoch.set(params.threadId,(nativeEventEpoch.get(params.threadId)||0)+1);}});
  // RpcTarget exposes prototype methods only; instance functions are rejected before dispatch.
  const rendererMethods=Object.create(Object.getPrototypeOf(client));Object.setPrototypeOf(client,rendererMethods);
  const hydrateModel=client.hydrateBackgroundThreads?.bind(client);
  if(hydrateModel)Object.defineProperty(rendererMethods,'hydrateBackgroundThreads',{value:async function(ids,options){const result=await hydrateModel(ids,options);if(nativeClient===client)for(const id of ids)rememberReadModel(id,client.threadStore?.threadsById?.get(id));return result;}});
  client.addNotificationCallback?.('turn/completed',({params})=>{const stopping=userStopIntents.get(params.threadId);if(stopping?.turnId===params.turn?.id&&['completed','failed','interrupted'].includes(params.turn.status))userStopIntents.delete(params.threadId);});
  const older=client.loadOlderConversationHistoryPage?.bind(client);
  if(older)Object.defineProperty(rendererMethods,'loadOlderConversationHistoryPage',{value:async function(id,related=[],options={}){
   if(!androidReader&&window.__DSH_EXECUTION_CONNECTED__===true)return older(id,related,options);
   if(!client.getConversation?.(id)?.turnsPagination)await client.hydrateBackgroundThreads([id],{includeTurns:true,maxTurns:6,refreshTurns:true});return Promise.all([id,...related].map(threadId=>client.loadOlderConversationTurnsPage(threadId,options)));
  }});
  // Native normally broadcasts protocol capabilities after its socket hello.
  // Offline reads still need the last verified pagination format, not a guessed
  // unbounded thread/read fallback. This does not mark the Mac online.
  const protocolReady=meta('native-initialization').then(initialized=>{if(initialized&&!target.getAppServerVersion?.()){target.setAppServerVersion?.(initialized.appServerVersion);diagnostics.cachedProtocol=true;window.__codexWebBridgeHelpers?.deliverLocalRendererMessage?.('codex-app-server-initialized',{...initialized,isSnapshot:true});}}).catch(()=>{});
  protocolReady.then(()=>{const id=location.pathname.match(/^\/local\/([0-9a-f-]{36})$/i)?.[1];if(id&&window.__DSH_NATIVE_ONLINE__===false)queueMicrotask(()=>hydrateCachedThread(id).catch(()=>{}));});
  const interrupt=client.interruptConversation?.bind(client);if(interrupt)Object.defineProperty(rendererMethods,'interruptConversation',{value:async function(id,reason='system',expected){
   if(reason!=='user-stop'){window.__DSH_CLIENT_LOG__?.event('execution_control',{method:'turn/interrupt',threadId:id,turnId:expected,reason});return interrupt(id,reason,expected);}
   const pending=userStopIntents.get(id),turnId=expected??client.turnCoordinator?.options.submissionHost.getActiveTurnId(id)??pending?.turnId;
   if(!turnId){window.__DSH_CLIENT_LOG__?.event('execution_control',{method:'turn/interrupt',threadId:id,reason:'no_active_turn'});throw Error('当前执行回合尚未确认，请刷新后再停止');}
   if(pending){if(pending.turnId!==turnId)throw Error('上一回合的停止仍在确认，不会停止新回合');if(!pending.outcomeUnknown){window.__DSH_CLIENT_LOG__?.event('execution_control',{method:'turn/interrupt',threadId:id,turnId,reason:'stop_coalesced'});return pending.promise;}}
   const intent={turnId,promise:null};userStopIntents.set(id,intent);window.__DSH_CLIENT_LOG__?.event('execution_control',{method:'turn/interrupt',threadId:id,turnId,reason});
   const boundedExpected=expected??(client.getConversation(id)?.threadGoal?.status==='active'?undefined:turnId);
   intent.promise=Promise.resolve().then(()=>interrupt(id,reason,boundedExpected)).then(value=>{if(value!=null)intent.accepted=true;return value;}).catch(error=>{intent.outcomeUnknown=stopOutcomeUnknown(intent,error);window.__DSH_CLIENT_LOG__?.event('execution_control',{method:'turn/interrupt',threadId:id,turnId,reason:intent.outcomeUnknown?'outcome_unknown':'failed'});throw error;}).finally(()=>{if(!intent.accepted&&!intent.outcomeUnknown&&userStopIntents.get(id)===intent)userStopIntents.delete(id);});return intent.promise;
  }});
  async function ensureSubmissionThreadLoaded(id,options){
   // A renderer can survive a host restart with resumeState still "resumed".
   // This original RPC bypasses the display cache and returns Native runtime
   // status for this exact target. Listing every loaded thread would make a
   // send wait for unrelated workspace checks. Status is not a writer grant:
   // resume/start still pass the existing server ownership and writer gates.
   const checkCancelled=()=>{if(options?.signal?.aborted)throw Error('操作已取消，尚未发送');};
   checkCancelled();
   // The explicit submission already read this exact Native head. Reuse it
   // only inside that attempt and its execution generation; never use display
   // history or a time-based cache as proof that a thread is loaded.
   const verified=client.dshSubmissionHead?.(id);
   if(verified?.threadId===id&&verified.loaded&&verified.isCurrent())return;
   const result=await original('thread/read',{threadId:id,includeTurns:false},options);
   checkCancelled();
   if(result?.thread?.id!==id)throw Error('宿主返回的会话不匹配，操作尚未发送');
   const status=result.thread.status?.type;
   if(['idle','active','systemError'].includes(status))return;
   if(status!=='notLoaded')throw Error('无法核实当前宿主会话状态，操作尚未发送');
   const resumed=await original('thread/resume',{threadId:id,excludeTurns:true},options);
   checkCancelled();
   if(resumed?.thread?.id!==id)throw Error('恢复的会话不匹配，操作尚未发送');
   rememberHistoryCursors(id,resumed);
  }
  target.sendRequest=async(method,params={},options)=>{
   if(method==='turn/interrupt'){const intent=userStopIntents.get(params.threadId);if(intent&&params.turnId!==intent.turnId){window.__DSH_CLIENT_LOG__?.event('execution_control',{method,threadId:params.threadId,turnId:params.turnId,reason:'stop_target_changed'});throw Error('停止目标已改变，旧停止操作不会作用于新回合');}}
   if(['turn/interrupt','thread/stop'].includes(method))window.__DSH_CLIENT_LOG__?.event('execution_control',{method,threadId:params.threadId,turnId:params.turnId,reason:'dispatch'});
   if(['turn/start','turn/steer'].includes(method)&&typeof options?.onOutcomeUnknown==='function'){
    const onOutcomeUnknown=options.onOutcomeUnknown;
    options={...options,onOutcomeUnknown:value=>{try{return onOutcomeUnknown(value);}finally{window.dispatchEvent(new CustomEvent('dsh:submission-unknown',{detail:{threadId:params.threadId}}));}}};
   }
   // Cached protocol discovery only serves offline read projections. A live
   // control request must not wait for IndexedDB or Android history import.
   if(READS.has(method))await protocolReady;
   diagnostics.rpc[method]=(diagnostics.rpc[method]||0)+1;
   if(method==='config/batchWrite'){
    const edits=params.edits;if(params.filePath!=null||params.expectedVersion!=null||!Array.isArray(edits)||!edits.length||edits.length>2||edits.some(e=>!['model','model_reasoning_effort'].includes(e.keyPath)||!['upsert','replace'].includes(e.mergeStrategy)||typeof e.value!=='string'||!e.value.trim()||e.value.length>256))throw Error('这里只允许调整本次新会话的模型与推理强度');
    const next={...composerModel};for(const edit of edits)next[edit.keyPath]=edit.value;composerModel=next;invalidateReadChecks();return {status:'ok',version:'dsh-composer-local-v1',filePath:null};
   }
   if(READS.has(method))return (await read(method,params)).result;
   if(isAuthRead(method)&&navigator.onLine&&window.__DSH_EXECUTION_CONNECTED__===true)return liveAuthRead(method,params,options);
   // The picker must receive the live catalog. Persisted discovery is offline-only;
   // saving that projection must not delay the model response or a send.
   if(method==='model/list'&&navigator.onLine&&window.__DSH_EXECUTION_CONNECTED__===true){const key='aux:'+JSON.stringify([method,canonical(params)]);return refreshOnce('live-models:'+key,0,()=>original(method,params,options),value=>{saveMeta(key,value).catch(()=>{});});}
   if(method==='app/list'&&navigator.onLine&&typeof window.__DSH_WAIT_BULK_READ_HTTP__==='function')return original(method,params,options);
   if(AUX.has(method)){const key='aux:'+JSON.stringify([method,canonical(params)]),cached=await meta(key).catch(()=>undefined)??(window.__DSH_NATIVE_ONLINE__===false?window.__CODEX_WEB_CONFIG__?.dshReadDefaults?.[method]:undefined),ttl=['model/list','modelProvider/capabilities/read','collaborationMode/list','permissionProfile/list','configRequirements/read'].includes(method)?30000:2000;
    const refresh=()=>refreshOnce(key,cached===undefined?0:ttl,()=>{diagnostics.auxRefreshes++;return original(method,params,options);},value=>saveMeta(key,value));
    if(cached!==undefined){if(navigator.onLine&&window.__DSH_EXECUTION_CONNECTED__===true)refresh().catch(()=>{});return method==='config/read'?composerConfig(structuredClone(cached)):listResult(method,structuredClone(cached));}const value=await refresh();return method==='config/read'?composerConfig(value):listResult(method,value);}
   if(['thread/start','thread/resume'].includes(method))await waitForExecution(options?.signal);
   if(method==='turn/start'){await waitForExecution(options?.signal);await ensureSubmissionThreadLoaded(params.threadId,options);}
   if(['thread/start','turn/start'].includes(method)){
    // The fixed host owns policy. Reuse only this submission's live config
    // read, parallel with its head lookup; never trust cached composer hints.
    const head=method==='turn/start'?client.dshSubmissionHead?.(params.threadId):null;
    const c=head?.isCurrent()&&head.hostPolicy?head.hostPolicy:(await original('config/read',{includeLayers:false},options))?.config;
    if(!['danger-full-access','workspace-write','read-only'].includes(c?.sandbox_mode)||c.approval_policy==null)throw Error('无法核实当前宿主执行策略，草稿已保留');
    params={...params,approvalPolicy:c.approval_policy};delete params.sandbox;delete params.sandboxPolicy;delete params.permissions;
    if(method==='thread/start')params.sandbox=c.sandbox_mode;
    else params.sandboxPolicy={type:{'danger-full-access':'dangerFullAccess','workspace-write':'workspaceWrite','read-only':'readOnly'}[c.sandbox_mode]};
    if(c.approvals_reviewer!=null)params.approvalsReviewer=c.approvals_reviewer;else delete params.approvalsReviewer;
    window.__DSH_CLIENT_LOG__?.event('policy_aligned',{method,policy:c.sandbox_mode});
   }
   if(!navigator.onLine||window.__DSH_EXECUTION_CONNECTED__!==true)throw Error('Mac 暂未连接，操作尚未发送；草稿已保留');
   // Preparation can yield after the fresh head was read. A stop started in
   // that interval must still win before either kind of submission is sent.
   if(['turn/start','turn/steer'].includes(method)&&userStopIntents.has(params.threadId))throw stoppingError();
   if(['turn/start','turn/steer'].includes(method)){const head=client.dshSubmissionHead?.(params.threadId);if(head&&!head.isCurrent())throw Error('发送准备期间会话或连接已变化，消息尚未发送；草稿已保留');}
   if(method==='turn/interrupt'){const stopping=userStopIntents.get(params.threadId);if(stopping?.turnId===params.turnId)stopping.dispatched=true;}
   let result;try{result=await original(method,params,options);if(method==='turn/interrupt'){const stopping=userStopIntents.get(params.threadId);if(stopping?.turnId===params.turnId)stopping.accepted=true;}if(['turn/interrupt','thread/stop'].includes(method))window.__DSH_CLIENT_LOG__?.event('execution_control',{method,threadId:params.threadId,turnId:params.turnId,reason:'accepted'});}catch(error){if(['turn/interrupt','thread/stop'].includes(method))window.__DSH_CLIENT_LOG__?.event('execution_control',{method,threadId:params.threadId,turnId:params.turnId,reason:'failed'});if(['thread/resume','thread/start'].includes(method)){const text=String(error?.message||''),failureClass=/沙箱策略|执行策略|权限配置/.test(text)?'policy_mismatch':/too many open files|os error 24/i.test(text)?'host_resources':/writer|owner|already.*use|占用/i.test(text)?'writer_busy':/timeout|timed out|超时/i.test(text)?'timeout':/connect|socket|连接/i.test(text)?'connection':'native_rejected';diagnostics.executionFailure={at:Date.now(),method,failureClass,uiVersion:window.__DSH_UI_RELEASE__?.version};saveMeta('last-execution-failure',diagnostics.executionFailure).catch(()=>{});window.__DSH_CLIENT_LOG__?.event('execution_failed',{method,failureClass,threadId:params.threadId});}throw error;}invalidateReadChecks();if(method==='thread/resume')rememberHistoryCursors(params.threadId,result);return result;
  };
  const disposeCapacity=installCapacityRetryUI(client,original),disposeRecovery=stopNativeAuthRecovery;stopNativeAuthRecovery=()=>{disposeCapacity();disposeRecovery?.();};
  let refreshTimer;for(const method of ['turn/completed','thread/reverted','thread/compacted'])client.addNotificationCallback?.(method,({params})=>{if(location.pathname!=='/local/'+params.threadId)return;clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{if(androidReader){refreshForeground(true).catch(()=>{});return;}for(const key of pendingReads.keys())if(key.includes(params.threadId))return;fetchRead('thread/read',{threadId:params.threadId,includeTurns:false},true).then(()=>client.hydrateBackgroundThreads?.([params.threadId],{includeTurns:true,maxTurns:1})).catch(()=>{});},300);});
  // A resumed PageSession sends current thread status, not missed completion
  // events. An idle header alone cannot settle the renderer's old live turn.
  client.addNotificationCallback?.('thread/status/changed',({params})=>{
   if(androidReader&&params.status?.type==='idle'&&location.pathname==='/local/'+params.threadId)refreshEntry(true);
  });
 };
 // The Android renderer is a reader of other owners too. Reconcile the visible
 // history even when its event stream missed an update or its body was resumed.
 const androidReader=!!window.DSHAndroid||/DSHAndroid/i.test(navigator.userAgent)||document.documentElement.dataset.dshAndroid==='1';
 // Navigation owns the lifetime of foreground history work. A new entry may
 // replace an unfinished read, but the old read can never adopt into that view.
 let historyViewEpoch=0,visibleAdoptionEpoch=0;
 function resetHistoryView(id){
  window.__DSH_BEGIN_CONTENT_ENTRY__?.(id);
  historyViewEpoch++;visibleAdoptionEpoch++;foregroundRefresh=null;foregroundAgain=false;committedRefresh=null;committedPending=false;
  clearTimeout(committedTimer);committedTimer=null;
  if(id){rendererPending.delete(id);rendererPrepared.delete(id);committedApplied.delete(id);
   for(const key of pendingReads.keys())if(key.includes(id))pendingReads.delete(key);
  }
 }
 window.__DSH_HISTORY_RECOVERY__={
  begin(id){resetHistoryView(id);queueMicrotask(()=>{if(location.pathname==='/local/'+id)refreshEntry(true);});},
  cancel(){resetHistoryView();}
 };
 let foregroundRefresh=null,foregroundChecked=0,foregroundId='',foregroundAgain=false;
 const contentHash=text=>{let a=2166136261,b=2246822507;for(let i=0;i<String(text).length;i++){const c=String(text).charCodeAt(i);a=Math.imul(a^c,16777619);b=Math.imul(b^c,3266489909);}return(a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0');};
 window.__DSH_CONTENT_IDENTITY__=item=>{const text=item?.text??item?.content,id=item?.type==='assistant-message'?item?.searchItemId:item?.id;if(!['agentMessage','assistant-message'].includes(item?.type)||typeof text!=='string'||typeof id!=='string')return null;return contentHash(id+'\n'+text);};
 const preparedPaint=new Map();let paintFrame=0,paintedKey='',paintEntry={id:location.pathname.split('/')[2],started:performance.now(),traceId:crypto.randomUUID()};
 const intersects=(row)=>{const viewport=document.querySelector('[data-app-action-timeline-scroll]')?.getBoundingClientRect(),box=row.getBoundingClientRect();return !!viewport&&box.bottom>viewport.top&&box.top<viewport.bottom;};
 function checkPreparedPaint(){paintFrame=0;const entry=paintEntry,p=preparedPaint.get(entry.id);if(!p||document.visibilityState!=='visible'||location.pathname!=='/local/'+p.id||window.__DSH_NATIVE_SIDEBAR__?.isList)return;
  const key=entry.traceId+':'+p.turnId+':'+p.hash+':'+p.final;if(paintedKey===key)return;
  const matches=n=>(n.getAttribute('data-dsh-content-identities')||'').split(' ').includes(p.hash)&&(!p.final||n.getAttribute('data-dsh-final-thread-id')===p.id&&n.getAttribute('data-dsh-final-turn-id')===p.turnId&&(n.getAttribute('data-dsh-final-answer-identities')||'').split(' ').includes(p.identity));
  const row=[...document.querySelectorAll(p.final?'[data-dsh-final-thread-id][data-dsh-content-identities]':'[data-dsh-content-identities]')].find(matches);if(!row||!row.getClientRects().length||!intersects(row))return;
  requestAnimationFrame(()=>{if(paintEntry!==entry||preparedPaint.get(p.id)!==p||paintedKey===key||document.visibilityState!=='visible'||location.pathname!=='/local/'+p.id||window.__DSH_NATIVE_SIDEBAR__?.isList||!row.isConnected||!intersects(row)||!matches(row))return;paintedKey=key;if(p.final)window.__DSH_ANDROID_BRIDGE__?.markCompletionSeen?.(p.id,p.turnId);window.__DSH_CLIENT_LOG__?.event('client_health',{component:'android-webview',stage:'shown',reason:'content_painted',threadId:p.id,turnId:p.turnId,traceId:p.traceId,parentTraceId:entry.traceId,eventCursor:p.seq,revision:p.revision,generation:p.generation,contentHash:p.hash,durationMs:Math.round(performance.now()-entry.started),visibility:'visible',localStored:true,cacheReady:p.final,textAvailable:true});});
 }
 function schedulePaintEvidence(){if(!paintFrame)paintFrame=requestAnimationFrame(checkPreparedPaint);}
 window.__DSH_BEGIN_CONTENT_ENTRY__=id=>{paintEntry={id,started:performance.now(),traceId:crypto.randomUUID()};paintedKey='';if(id)window.__DSH_CLIENT_LOG__?.event('client_health',{component:'android-webview',stage:'started',reason:'visible',threadId:id,traceId:paintEntry.traceId});schedulePaintEvidence();};
 function observePreparedContent(id,snapshot){const final=finalFromSnapshot(snapshot),turn=final?snapshot.page.data.find(t=>t.id===final.turnId):snapshot.page.data.find(t=>(t.items||[]).some(i=>window.__DSH_CONTENT_IDENTITY__(i)));const item=turn&&[...turn.items].reverse().find(i=>final?window.__DSH_FINAL_IDENTITY__?.(i):window.__DSH_CONTENT_IDENTITY__(i));if(!item)return;
  const hash=window.__DSH_CONTENT_IDENTITY__(item),previous=preparedPaint.get(id);if(previous?.hash===hash&&previous.final===!!final&&previous.turnId===turn.id){schedulePaintEvidence();return;}if(turn.status!=='completed'&&previous&&performance.now()-previous.preparedAt<1000)return;
  const p={id,hash,final:!!final,identity:final?.identity,turnId:turn.id,seq:snapshot.streamCursor||0,revision:snapshot.revision,generation:snapshot.generation,traceId:crypto.randomUUID(),preparedAt:performance.now()};preparedPaint.set(id,p);if(preparedPaint.size>100){const oldest=[...preparedPaint.keys()].find(key=>key!==paintEntry.id);preparedPaint.delete(oldest);}
  window.__DSH_CLIENT_LOG__?.event('client_health',{component:'android-webview',stage:'committed',reason:'content_prepared',threadId:id,turnId:turn.id,traceId:p.traceId,eventCursor:p.seq,revision:snapshot.revision,generation:snapshot.generation,contentHash:hash,visibility:document.visibilityState,localStored:true,cacheReady:p.final,textAvailable:true});schedulePaintEvidence();
 }
 new MutationObserver(schedulePaintEvidence).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['data-dsh-content-identities']});
 addEventListener('dsh:native-route',()=>{const id=location.pathname.split('/')[2];if(paintEntry.id!==id)window.__DSH_BEGIN_CONTENT_ENTRY__(id);});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')window.__DSH_BEGIN_CONTENT_ENTRY__(location.pathname.split('/')[2]);});
 const rendererPrepared=new Map(),rendererPending=new Map(),rendererQueue=new Set(),rendererErrors=new Map();let rendererTimer=null,rendererBusy=false;
 function queueCachedPreparation(id){if(!androidReader)return;rendererQueue.add(id);scheduleCachedPreparation();}
 function scheduleCachedPreparation(){if(rendererTimer||rendererBusy||!rendererQueue.size)return;rendererTimer=setTimeout(async()=>{rendererTimer=null;if(!nativeClient||(document.visibilityState==='visible'&&Date.now()-lastForeground<1800)||foregroundFreshReads.size){scheduleCachedPreparation();return;}const id=[...rendererQueue].sort((a,b)=>Number(priorityPinned.has(b))-Number(priorityPinned.has(a)))[0];rendererQueue.delete(id);rendererBusy=true;try{await prepareCachedConversation(id);rendererErrors.delete(id);}catch{const at=Date.now();diagnostics.rendererPrepareFailedAt=at;rendererErrors.set(id,{at});if(rendererErrors.size>100)rendererErrors.delete(rendererErrors.keys().next().value);}finally{rendererBusy=false;}scheduleCachedPreparation();},200);}
 async function prepareCachedConversation(id){
  if(!androidReader||!nativeClient||window.__DSH_NAVIGATION__?.notificationTarget?.()?.threadId===id)return;if(rendererPending.has(id))return rendererPending.get(id);
  const prepareEpoch=readEpoch,viewEpoch=historyViewEpoch,adoptionEpoch=visibleAdoptionEpoch,deadline=Date.now()+CACHE_IO_TIMEOUT_MS;let retired=false;
  const build=(async()=>{const snapshot=await window.__DSH_READ_COMMITTED_HISTORY__(id,{preferSummary:true});if(retired||!snapshot||rendererPrepared.get(id)===snapshot.stamp)return;snapshot.completesVisibleTurn=completesVisibleTurn(id,snapshot);if(!snapshot.completesVisibleTurn&&(nativeActivity.get(id)||0)>snapshot.confirmedAt)return;const guard=()=>!retired&&visibleAdoptionEpoch===adoptionEpoch&&historyViewEpoch===viewEpoch&&readEpoch===prepareEpoch&&(!snapshot.sourceGeneration||memoryMeta.get('catalog-generation')===snapshot.sourceGeneration)&&(snapshot.completesVisibleTurn||(nativeActivity.get(id)||0)<=snapshot.confirmedAt);
   await nativeClient.hydrateBackgroundThreads([id],{includeTurns:true,maxTurns:20,refreshTurns:'dsh_local_cache',refreshGuard:guard,cachedSnapshot:snapshot});if(snapshot.applied&&guard()&&nativeClient.getConversation?.(id)?.turnsPagination){saveFinalRecovery(id,snapshot).catch(()=>{});observePreparedContent(id,snapshot);rendererPrepared.set(id,snapshot.stamp);if(rendererPrepared.size>100)rendererPrepared.delete(rendererPrepared.keys().next().value);diagnostics.rendererPrepared=(diagnostics.rendererPrepared||0)+1;window.__DSH_CLIENT_LOG__?.event('history_applied',{threadId:id,revision:snapshot.revision,generation:snapshot.generation,reason:document.visibilityState==='visible'?'visible':'hidden'});}
  })();const work=bounded(build,'准备显示',remaining(deadline),()=>{retired=true;}).finally(()=>{if(rendererPending.get(id)===work)rendererPending.delete(id);});rendererPending.set(id,work);return work;
 }
 window.__DSH_PREPARE_CACHED_CONVERSATION__=prepareCachedConversation;
 function summaryPagination(turn,previous={}){
  const opening=(turn.items||[]).find(item=>item.type!=='contextCompaction');
  return {...previous,olderCursor:null,isLoadingOlder:false,hasLoadedOldest:false,
   summaryItemIds:(turn.items||[]).map(item=>item.id),newestSnapshotItemId:turn.items?.at(-1)?.id,
   ...(opening?.type==='userMessage'?{oldestUserInput:opening.content,openingUserMessageId:opening.id,openingUserMessageClientId:opening.clientId}:{})};
 }
 function mergeCommittedCompletion(turn,stream,record,id){
  // A seeded final message and its ordered terminal event are already durable
  // on Android. Do not leave that text in an inProgress history projection
  // while a separate HTTP summary read is stalled. This only completes an
  // existing, exactly matching turn; it cannot create or resume execution.
  if(turn.status!=='inProgress'||!stream?.available||stream.gap||stream.scope!==scope.id||stream.threadId!==id||stream.sourceGeneration!==record.sourceGeneration)return false;
  // Older APK streams carry the source generation, but no rewritten-thread
  // generation. Fail closed for those threads until a native summary arrives.
  if(record.generation!==stream.sourceGeneration)return false;
  if(!Array.isArray(turn.items)||turn.itemsView==='notLoaded'||!turn.items.some(item=>item.type==='userMessage'))return false;
  const live=stream.turns?.find(t=>t.id===turn.id);
  if(live?.status!=='completed'||!Number.isFinite(live.startedAt)||live.startedAt!==turn.startedAt)return false;
  const final=[...(live.items||[])].reverse().find(item=>item.seeded===true&&window.__DSH_FINAL_IDENTITY__?.(item));
  if(!final)return false;
  const old=(turn.items||[]).find(item=>item.id===final.id);if(old&&old.type!=='agentMessage')return false;
  const item={id:final.id,type:'agentMessage',phase:'final_answer',text:final.text};
  turn.items=(turn.items||[]).filter(value=>value.id!==item.id).concat(item);
  turn.status='completed';if(Number.isFinite(live.completedAt))turn.completedAt=live.completedAt;
  return true;
 }
 const committedApplied=new Map();let committedTimer=null,committedPending=false,committedRefresh=null,committedRefreshId='';
  window.__DSH_READ_COMMITTED_HISTORY__=async(id,{touch=true,headRecord,turnRecord,itemRecords,streamRecord,eventEpoch,targetTurnId,preferSummary=false}={})=>{
  if(!headRecord&&!turnRecord&&preferSummary&&window.__DSH_ANDROID_BRIDGE__?.readThreadRecords){
   const local=await window.__DSH_ANDROID_BRIDGE__.readThreadRecords(id).catch(()=>null);
   if(local?.scope===scope.id&&local.threadId===id&&local.generation&&(!memoryMeta.get('catalog-generation')||memoryMeta.get('catalog-generation')===local.generation)){
    const records=(local.records||[]).map(r=>importRecord(r,local.generation)).filter(r=>r&&!r.deleted&&r.threadId===id).sort((a,b)=>b.revision-a.revision);
    const head=records.find(r=>r.key===readKey('thread/read',{threadId:id,includeTurns:false}));
    const turn=records.find(r=>{try{const [method,p]=JSON.parse(r.key.slice(5));return method==='thread/turns/list'&&p.itemsView==='summary'&&p.sortDirection==='desc'&&!p.cursor&&r.generation===head?.generation;}catch{return false;}});
    const latest=turn?.payload?.result?.data?.[0];
    const stream=latest?.status==='inProgress'?await window.__DSH_ANDROID_BRIDGE__?.readStream?.(id)?.catch(()=>null):null;
    if(head&&turn&&((latest?.items||[]).some(item=>window.__DSH_FINAL_IDENTITY__?.(item))||latest&&mergeCommittedCompletion(structuredClone(latest),stream,turn,id))){
     const snapshot=await window.__DSH_READ_COMMITTED_HISTORY__(id,{headRecord:{...head,source:'android'},turnRecord:{...turn,source:'android'},streamRecord:stream,preferSummary:true,targetTurnId});
     if(snapshot)return snapshot;
    }
   }
  }
  if(!headRecord||!turnRecord)await loadFinalRecovery(id);
  // One budget for a cached snapshot, not a fresh timeout for each old turn.
  const streamPromise=streamRecord??(!headRecord?window.__DSH_ANDROID_BRIDGE__?.readStream?.(id)?.catch(()=>null):null);
  const deadline=Date.now()+CACHE_IO_TIMEOUT_MS;
  const readRecord=key=>Date.now()>=deadline?Promise.resolve(null):get(key,{touch,timeoutMs:remaining(deadline)}).catch(()=>null);
  const freshInput=!!headRecord&&!!turnRecord;
  const [generation,head,catalog,candidates]=await Promise.all([
   freshInput?turnRecord.sourceGeneration:meta('catalog-generation',{timeoutMs:remaining(deadline)}).catch(()=>null),
   headRecord??readRecord(readKey('thread/read',{threadId:id,includeTurns:false})),
   freshInput?null:readRecord('thread:'+id),
   turnRecord?[turnRecord]:Promise.all([[2,'summary'],[2,'full'],[20,'summary'],[12,'notLoaded'],[6,'notLoaded'],[1,'notLoaded']].map(([limit,itemsView])=>readRecord(readKey('thread/turns/list',{threadId:id,limit,sortDirection:'desc',itemsView}))))
  ]);
  for(const record of candidates.filter(r=>r&&!r.deleted&&(!generation||r.sourceGeneration===generation)).sort((a,b)=>b.revision-a.revision)){
   const headBase=head&&!head.deleted&&head.sourceGeneration===record.sourceGeneration&&head.generation===record.generation?head.payload.result:null,catalogThread=catalog&&!catalog.deleted&&catalog.sourceGeneration===record.sourceGeneration&&catalog.generation===record.generation?catalog.payload?.nativeThread:null;
   const base=!headRecord&&catalogThread&&(!headBase?.thread||catalogThread.updatedAt>headBase.thread.updatedAt)?{...headBase,thread:catalogThread}:headBase;
   if(base?.thread?.id!==id||!Array.isArray(record.payload?.result?.data))continue;
   const page=structuredClone(record.payload.result),pagination={},bodyLoadedTurnIds=[],stream=await streamPromise;let complete=true,streamUsed=false,completedFromStream=false,stamp=record.sourceGeneration+':'+record.revision+':'+base.thread.updatedAt;
   for(const [turnIndex,turn] of page.data.entries()){
    if(mergeCommittedCompletion(turn,stream,record,id)){completedFromStream=true;streamUsed=true;bodyLoadedTurnIds.push(turn.id);}
    if(preferSummary&&turn.status==='completed'&&(turn.items||[]).some(item=>window.__DSH_FINAL_IDENTITY__?.(item))){
     turn.items=turn.items.filter(item=>item.type==='userMessage'||window.__DSH_FINAL_IDENTITY__?.(item));turn.itemsView='summary';
     pagination[turn.id]=summaryPagination(turn);bodyLoadedTurnIds.push(turn.id);continue;
    }
    if(turn.itemsView==='full'&&Array.isArray(turn.items)){bodyLoadedTurnIds.push(turn.id);continue;}
    if(turn.itemsView!=='notLoaded')pagination[turn.id]=summaryPagination(turn);
    // Keep older summary rows and pagination, but do not read their bodies on
    // the foreground path. A notification additionally selects its exact turn.
    if(turnIndex>=2&&turn.id!==targetTurnId)continue;
    let items=itemRecords?.get(turn.id)||null;
    const cachedItems=items||freshInput?[]:await Promise.all([...new Set([window.__DSH_HISTORY_POLICY__?.initialTurnItems||48,48,20,40,100])].map(limit=>readRecord(readKey('thread/items/list',{threadId:id,turnId:turn.id,limit,sortDirection:'desc'}))));
    for(const value of cachedItems){
     if(value&&!value.deleted&&value.sourceGeneration===record.sourceGeneration&&value.generation===record.generation&&Array.isArray(value.payload?.result?.data)&&(!items||value.revision>items.revision)){items=value;}
    }
    if(items&&!itemRecords?.has(turn.id)&&turn.itemsView!=='notLoaded'&&items.revision<record.revision)items=null;
    if(!items){if(turn.itemsView==='notLoaded'){complete=false;break;}continue;}
    // The tail page can omit the opening prompt. Preserve the official
    // pagination metadata from Native's summary instead of losing that input.
    const summaryOpening=(turn.items||[]).find(value=>value.type==='userMessage')||candidates.filter(value=>value&&!value.deleted&&value.sourceGeneration===record.sourceGeneration&&value.generation===record.generation).flatMap(value=>value.payload?.result?.data||[]).find(value=>value.id===turn.id&&(value.items||[]).some(item=>item.type==='userMessage'))?.items.find(value=>value.type==='userMessage');
    const firstPage=summaryOpening||freshInput?null:await readRecord(readKey('thread/items/list',{threadId:id,turnId:turn.id,limit:2,sortDirection:'asc'}));
    const opening=summaryOpening||(firstPage&&!firstPage.deleted&&firstPage.sourceGeneration===record.sourceGeneration&&firstPage.generation===record.generation?firstPage.payload?.result?.data?.map(value=>value.item||value).find(value=>value.type==='userMessage'):null);
    bodyLoadedTurnIds.push(turn.id);turn.items=items.payload.result.data.slice().reverse().map(v=>v.item||v);turn.itemsView=items.payload.result.nextCursor?'summary':'full';
    pagination[turn.id]={olderCursor:items.payload.result.nextCursor||null,isLoadingOlder:false,hasLoadedOldest:!items.payload.result.nextCursor,newestSnapshotItemId:turn.items.at(-1)?.id,...(opening?{oldestUserInput:opening.content,openingUserMessageId:opening.id,openingUserMessageClientId:opening.clientId}:{})};stamp+=':'+items.revision+':'+(opening?.id||'');
   }
   if(complete){
    if(stream?.available&&stream.scope===scope.id&&stream.threadId===id&&stream.sourceGeneration===record.sourceGeneration){
     for(const live of stream.turns||[]){const turn=page.data.find(t=>t.id===live.id);if(!turn||turn.status!=='inProgress'||!Array.isArray(turn.items)||!bodyLoadedTurnIds.includes(turn.id))continue;
      for(const value of live.items||[]){if(!value.seeded||value.type!=='agentMessage'||typeof value.text!=='string')continue;const old=turn.items.find(t=>t.id===value.id);if(old&&old.type!=='agentMessage')continue;if(old&&typeof old.text==='string'&&!value.text.startsWith(old.text))continue;
       const item={id:value.id,type:'agentMessage',phase:value.phase,text:value.text};if(old)Object.assign(old,item);else turn.items.push(item);streamUsed=true;
      }
     }
     if(streamUsed)stamp+=':stream:'+stream.epoch+':'+stream.seq;
    }
    const snapshot={finalFirst:preferSummary,completedFromStream,streamCursor:streamUsed?stream.seq:0,bodyLoadedTurnIds:[...new Set(bodyLoadedTurnIds)],verifiedNative:!!headRecord&&!!turnRecord&&[headRecord,turnRecord,...(itemRecords?.values()||[])].every(r=>(r.source==null||r.source==='native')&&r.sourceGeneration===record.sourceGeneration&&r.generation===record.generation),eventEpoch,sourceGeneration:record.sourceGeneration,applied:false,response:base,page,itemsPaginationByTurnId:pagination,stamp:stamp+(preferSummary?':final-first':''),revision:record.revision,generation:record.generation,confirmedAt:Math.max(typeof record.confirmedAt==='number'?record.confirmedAt:Date.parse(record.confirmedAt)||0,streamUsed?stream.updatedAt:0)};
    if(!acceptRecoverySnapshot(id,snapshot))continue;return snapshot;
   }
  }
  return null;
 };

 // A compact, read-only replica of official user/final items is the first paint
 // after a rebuild. Official summary pagination loads process items afterwards.
 const finalRecovery=new Map(),recoveryLoads=new Map(),recoverySaves=new Map(),reloadPreparing=new Map(),restoredFinal=new Map(),restoringFinal=new Map(),recoveryEpoch=new Map();
 const recoveryKey=id=>'final-recovery-v1:'+id;
 async function loadFinalRecovery(id){
  if(finalRecovery.has(id))return finalRecovery.get(id);if(recoveryLoads.has(id))return recoveryLoads.get(id);
  const epoch=recoveryEpoch.get(id)||0;const work=meta(recoveryKey(id)).then(value=>{if(epoch!==(recoveryEpoch.get(id)||0))return null;if(value?.response?.thread?.id===id&&value?.finalFirst&&finalFromSnapshot(value)){for(const turn of value.page.data)(value.itemsPaginationByTurnId??={})[turn.id]=summaryPagination(turn,value.itemsPaginationByTurnId?.[turn.id]);finalRecovery.set(id,value);}return finalRecovery.get(id)||null;}).catch(()=>null).finally(()=>recoveryLoads.delete(id));recoveryLoads.set(id,work);return work;
 }
 function currentRecovery(id){const value=finalRecovery.get(id),generation=memoryMeta.get('catalog-generation');return value&&(!generation||value.sourceGeneration===generation)?value:null;}
 const completedReplayLogged=new Set();
 window.__DSH_ACCEPT_NATIVE_NOTIFICATION__=(method,params)=>{
  const turnId=params?.turnId??params?.turn?.id,id=params?.threadId;
  if(!id||!turnId||typeof method!=='string'||!(method==='turn/started'||method.startsWith('item/')||method==='error'&&params.willRetry===true))return true;
  if(!finalFromSnapshot(currentRecovery(id),turnId))return true;
  // A PageSession can replay old deltas after a local completed body has been
  // restored. That immutable turn cannot become live again. Revert/compaction
  // and different/new turns still pass and invalidate recovery normally.
  const key=id+':'+turnId;
  if(!completedReplayLogged.has(key)){completedReplayLogged.add(key);if(completedReplayLogged.size>100)completedReplayLogged.delete(completedReplayLogged.values().next().value);window.__DSH_CLIENT_LOG__?.event('history_rejected',{threadId:id,turnId,reason:'live_event_superseded',cacheReady:true});}
  return false;
 };
 function acceptRecoverySnapshot(id,snapshot){
  const saved=currentRecovery(id);if(!saved||saved.sourceGeneration!==snapshot.sourceGeneration||saved.generation!==snapshot.generation)return true;
  const prior=saved.page.data[0],latest=snapshot.page.data[0];if(!latest)return false;
  if(latest.id!==prior.id)return Number(latest.startedAt)>Number(prior.startedAt);
  const final=finalFromSnapshot(snapshot),known=finalFromSnapshot(saved);return latest.status==='completed'&&!!final&&(final.identity===known?.identity||snapshot.revision>=saved.revision);
 }
 window.__DSH_ACCEPT_HISTORY_SNAPSHOT__=(id,snapshot)=>!(restoringFinal.has(id+':'+historyViewEpoch)&&!finalFromSnapshot(snapshot))&&acceptRecoverySnapshot(id,snapshot);
 async function saveFinalRecovery(id,snapshot){
  if(!finalFromSnapshot(snapshot))return null;
  const copy=structuredClone(snapshot);copy.verifiedNative=false;delete copy.completesVisibleTurn;delete copy.eventEpoch;copy.applied=false;copy.finalFirst=true;copy.stamp=copy.stamp.replace(/(?::recovery)+$/,'');if(!copy.stamp.endsWith(':final-first'))copy.stamp+=':final-first';
  copy.bodyLoadedTurnIds=[];copy.itemsPaginationByTurnId??={};
  for(const turn of copy.page.data){turn.items=(turn.items||[]).filter(item=>item.type==='userMessage'||window.__DSH_FINAL_IDENTITY__?.(item));turn.itemsView='summary';copy.bodyLoadedTurnIds.push(turn.id);copy.itemsPaginationByTurnId[turn.id]=summaryPagination(turn,copy.itemsPaginationByTurnId[turn.id]);}
  // Keep the Native turns page and its cursor paired; only item bodies shrink.
  const epoch=recoveryEpoch.get(id)||0;
  // Fence replay immediately in memory; a slow durable write must not delay
  // adopting the already committed Android body or protecting it from replay.
  const known=currentRecovery(id);if(known&&known.sourceGeneration===copy.sourceGeneration&&known.generation===copy.generation&&known.revision>copy.revision)return known;
  finalRecovery.set(id,copy);
  const previous=recoverySaves.get(id);const work=(previous?.catch(()=>{})||Promise.resolve()).then(async()=>{if(epoch!==(recoveryEpoch.get(id)||0))return null;const old=currentRecovery(id);if(old&&old.sourceGeneration===copy.sourceGeneration&&old.generation===copy.generation&&old.revision>copy.revision)return old;await saveMeta(recoveryKey(id),copy);if(epoch!==(recoveryEpoch.get(id)||0))return null;return currentRecovery(id)||copy;});recoverySaves.set(id,work);try{return await work;}finally{if(recoverySaves.get(id)===work)recoverySaves.delete(id);}
 }
 async function readFinalSummary(id,targetTurnId){
  const eventEpoch=nativeEventEpoch.get(id)||0;
  const [headRecord,turnRecord]=await Promise.all([fetchRead('thread/read',{threadId:id,includeTurns:false},true,'high'),fetchRead('thread/turns/list',{threadId:id,limit:2,sortDirection:'desc',itemsView:'summary'},true,'high')]);
  const snapshot=await window.__DSH_READ_COMMITTED_HISTORY__(id,{headRecord,turnRecord,eventEpoch,preferSummary:true,targetTurnId});
  return snapshot&&eventEpoch===(nativeEventEpoch.get(id)||0)&&finalFromSnapshot(snapshot,targetTurnId)?snapshot:null;
 }
 function visibleFinalIdentity(){const rows=[...document.querySelectorAll('[data-app-action-timeline-scroll] [data-dsh-final-answer-identities]')];return rows.filter(row=>row.getClientRects().length).at(-1)?.getAttribute('data-dsh-final-answer-identities')?.split(' ').filter(Boolean).at(-1)||null;}
 function recoveryReloadReady(){
  if(!androidReader||window.__DSH_NATIVE_SIDEBAR__?.isList)return true;
  const id=location.pathname.match(/^\/local\/([0-9a-f-]{36})$/i)?.[1],identity=visibleFinalIdentity();if(!id||!identity)return true;
  const saved=currentRecovery(id);if(finalFromSnapshot(saved)?.identity===identity&&!recoverySaves.has(id))return true;
  if(!reloadPreparing.has(id)){const work=(async()=>{await loadFinalRecovery(id);if(finalFromSnapshot(currentRecovery(id))?.identity===identity)return;const snapshot=await readFinalSummary(id);if(snapshot&&finalFromSnapshot(snapshot)?.identity===identity)await saveFinalRecovery(id,snapshot);})().catch(()=>{}).finally(()=>reloadPreparing.delete(id));reloadPreparing.set(id,work);}return false;
 }
 async function restoreFinalFirst(id){if(!androidReader||!nativeClient)return;const key=id+':'+historyViewEpoch;if(restoringFinal.has(key))return restoringFinal.get(key);const work=restoreFinalFirstInner(id).finally(()=>restoringFinal.delete(key));restoringFinal.set(key,work);return work;}
 async function restoreFinalFirstInner(id){
  const epoch=historyViewEpoch;if(restoredFinal.get(id)===epoch)return;
  await loadFinalRecovery(id);
  // The saved first paint can be from the previous visit. Prefer an already
  // committed newer completion; networking runs independently in refreshEntry.
  let snapshot=await window.__DSH_READ_COMMITTED_HISTORY__(id,{preferSummary:true});
  if(!finalFromSnapshot(snapshot))snapshot=currentRecovery(id);
  if(historyViewEpoch!==epoch||location.pathname!=='/local/'+id)return;
  if(finalFromSnapshot(snapshot)){saveFinalRecovery(id,snapshot).catch(()=>{});if(historyViewEpoch!==epoch||location.pathname!=='/local/'+id)return;await refreshCommitted(snapshot);if(snapshot.applied)await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));}
  if(historyViewEpoch===epoch&&snapshot?.applied)restoredFinal.set(id,epoch);
 }
 function finalFromSnapshot(snapshot,turnId){
  const turn=turnId?snapshot?.page.data.find(t=>t.id===turnId):snapshot?.page.data[0];
  if(turn?.status!=='completed'||!snapshot.bodyLoadedTurnIds?.includes(turn.id))return null;
  for(const item of [...(turn.items||[])].reverse()){const identity=window.__DSH_FINAL_IDENTITY__?.(item);if(identity)return {identity,turnId:turn.id};}
  return null;
 }
 function completesVisibleTurn(id,snapshot){
  const final=finalFromSnapshot(snapshot),conversation=nativeClient?.getConversation?.(id);
  if(!final||!conversation)return false;
  const turns=nativeClient.getLoadedConversationHistoryTurns?.(conversation)??conversation.turns??[];
  const latest=turns.filter(turn=>turn.turnId!=null).at(-1),incoming=snapshot.page.data[0];
  // A matching terminal turn is newer evidence than its retained live state.
  // Never use it to replace a later turn or a different history generation.
  return latest?.turnId===final.turnId&&['inProgress','completed'].includes(latest.status)&&
   (!latest.turnStartedAtMs||Number(incoming.startedAt)*1000===latest.turnStartedAtMs)&&
   (!memoryMeta.get('catalog-generation')||memoryMeta.get('catalog-generation')===snapshot.sourceGeneration);
 }
 function finalIsPainted(snapshot){const final=finalFromSnapshot(snapshot);return final&&[...document.querySelectorAll('[data-app-action-timeline-scroll] [data-dsh-final-answer-identities]')].some(row=>(row.getAttribute('data-dsh-final-answer-identities')||'').split(' ').includes(final.identity));}
 async function readFreshSnapshot(id,targetTurnId){
   const eventEpoch=nativeEventEpoch.get(id)||0;
   const [headRecord,summaryRecord]=await Promise.all([fetchRead('thread/read',{threadId:id,includeTurns:false},true,'high'),fetchRead('thread/turns/list',{threadId:id,limit:20,sortDirection:'desc',itemsView:'summary'},true,'high')]);
   // Keep official legacy/full and durable/item pagination separate. Only the
   // latest two full turns are read; Native's older-turn cursor stays intact.
   const turnRecord=headRecord.payload?.result?.thread?.historyMode==='legacy'
    ?await fetchRead('thread/turns/list',{threadId:id,limit:2,sortDirection:'desc',itemsView:'full'},true,'high'):summaryRecord;
   const itemRecords=new Map(await Promise.all((turnRecord.payload?.result?.data||[]).filter((turn,index)=>index<2||turn.id===targetTurnId).filter(turn=>turn.itemsView!=='full').map(async turn=>[turn.id,await fetchRead('thread/items/list',{threadId:id,turnId:turn.id,limit:48,sortDirection:'desc'},true,'high')])));
   return window.__DSH_READ_COMMITTED_HISTORY__(id,{headRecord,turnRecord,itemRecords,eventEpoch,targetTurnId});
 }
 window.__DSH_PREPARE_NOTIFICATION_CONTENT__=async(id,turnId,{isCurrent=()=>true,localOnly=false}={})=>{
  if(!androidReader||!nativeClient)return null;
  const epoch=historyViewEpoch,eventEpoch=nativeEventEpoch.get(id)||0;let adoptionEpoch=visibleAdoptionEpoch;
  const current=()=>isCurrent()&&historyViewEpoch===epoch&&(nativeEventEpoch.get(id)||0)===eventEpoch;
  let snapshot=currentRecovery(id),final=finalFromSnapshot(snapshot,turnId);
  if(!final){snapshot=await window.__DSH_READ_COMMITTED_HISTORY__(id,{targetTurnId:turnId,preferSummary:true});final=finalFromSnapshot(snapshot,turnId);}
  if(localOnly&&!final)return null;
  if(!final){snapshot=await readFinalSummary(id,turnId);final=finalFromSnapshot(snapshot,turnId);}
  if(!final){snapshot=await readFreshSnapshot(id,turnId);final=finalFromSnapshot(snapshot,turnId);}
  if(!snapshot||!final||!current())return null;
  snapshot.completesVisibleTurn=completesVisibleTurn(id,snapshot);
  const guard=()=>current()&&visibleAdoptionEpoch===adoptionEpoch&&(!snapshot.sourceGeneration||!memoryMeta.get('catalog-generation')||memoryMeta.get('catalog-generation')===snapshot.sourceGeneration);
  if(!guard())return null;adoptionEpoch=++visibleAdoptionEpoch;snapshot.applied=false;
  await nativeClient.hydrateBackgroundThreads([id],{includeTurns:true,maxTurns:20,refreshTurns:'dsh_local_cache',refreshGuard:guard,cachedSnapshot:snapshot});
  if(!snapshot.applied&&guard()){
   if(localOnly)return null;
   // An older notification may target a completed turn while a new turn is visible.
   // Read a current summary instead of repeatedly trying the same saved older page.
   snapshot=await readFinalSummary(id,turnId)||await readFreshSnapshot(id,turnId);final=finalFromSnapshot(snapshot,turnId);
   if(!snapshot||!final||!guard())return null;adoptionEpoch=++visibleAdoptionEpoch;snapshot.applied=false;
   await nativeClient.hydrateBackgroundThreads([id],{includeTurns:true,maxTurns:20,refreshTurns:'dsh_local_cache',refreshGuard:guard,cachedSnapshot:snapshot});
  }
  if(!snapshot.applied||!guard())return null;await saveFinalRecovery(id,snapshot);if(!guard())return null;
  window.dispatchEvent(new CustomEvent('dsh:history-adopted',{detail:{threadId:id,turnId:final.turnId}}));return final;
 };
 function scheduleCommitted(){committedPending=true;if(committedTimer)return;committedTimer=setTimeout(()=>{committedTimer=null;refreshCommitted().catch(()=>{});},300);}
 async function refreshCommitted(freshSnapshot){
  if(!androidReader||!nativeClient||document.visibilityState!=='visible'||window.__DSH_NATIVE_SIDEBAR__?.isList)return;
  const id=location.pathname.split('/')[2];if(!/^[0-9a-f-]{36}$/i.test(id||''))return;if(freshSnapshot&&freshSnapshot.response?.thread?.id!==id)return;
  if(window.__DSH_NAVIGATION__?.notificationTarget?.()?.threadId===id)return;
  // A fresh snapshot can supersede a slow local read; it never waits behind it.
  if(committedRefresh&&committedRefreshId===id&&!freshSnapshot)return committedRefresh;
  committedPending=false;committedRefreshId=id;
  const viewEpoch=historyViewEpoch,adoptionEpoch=freshSnapshot?++visibleAdoptionEpoch:visibleAdoptionEpoch;
  const work=(async()=>{
   const snapshot=freshSnapshot??await window.__DSH_READ_COMMITTED_HISTORY__(id,{preferSummary:true});
   if(!snapshot){window.__DSH_CLIENT_LOG__?.event('history_rejected',{threadId:id,reason:'empty'});return;}
   window.__DSH_CLIENT_LOG__?.event('history_read',{threadId:id,turnId:snapshot.page.data[0]?.id,revision:snapshot.revision,cacheReady:!!finalFromSnapshot(snapshot),reason:'cache_import',source:snapshot.verifiedNative?'native':'indexeddb'});
   snapshot.completesVisibleTurn=completesVisibleTurn(id,snapshot);
   const fresh=!!snapshot.verifiedNative,epoch=snapshot.eventEpoch??(nativeEventEpoch.get(id)||0);
   const guard=()=>visibleAdoptionEpoch===adoptionEpoch&&historyViewEpoch===viewEpoch&&location.pathname==='/local/'+id&&document.visibilityState==='visible'&&!window.__DSH_NATIVE_SIDEBAR__?.isList&&(nativeEventEpoch.get(id)||0)===epoch&&(fresh||snapshot.completesVisibleTurn||(nativeActivity.get(id)||0)<=snapshot.confirmedAt)&&(!snapshot.sourceGeneration||!memoryMeta.get('catalog-generation')||memoryMeta.get('catalog-generation')===snapshot.sourceGeneration);
   if(!guard()){window.__DSH_CLIENT_LOG__?.event('history_rejected',{threadId:id,revision:snapshot.revision,reason:'live_event_superseded'});return;}
   if(committedApplied.get(id)===snapshot.stamp&&nativeClient.getConversation?.(id)?.turnsPagination){window.__DSH_NAVIGATION__?.completedContentReady?.(id,finalFromSnapshot(snapshot));return;}
   const started=Date.now();snapshot.applied=false;
   await nativeClient.hydrateBackgroundThreads([id],{includeTurns:true,maxTurns:20,refreshTurns:'dsh_local_cache',refreshGuard:guard,cachedSnapshot:snapshot});
   if(snapshot.applied&&guard()){const final=finalFromSnapshot(snapshot);if(final){saveFinalRecovery(id,snapshot).catch(()=>{});window.__DSH_NAVIGATION__?.completedContentReady?.(id,final);}observePreparedContent(id,snapshot);committedApplied.set(id,snapshot.stamp);window.__DSH_CLIENT_LOG__?.event('history_applied',{threadId:id,revision:snapshot.revision,turnCount:snapshot.page.data.length,generation:snapshot.generation});diagnostics.committedRefreshedAt=Date.now();if(fresh||snapshot.completedFromStream)window.dispatchEvent(new CustomEvent('dsh:history-synchronized',{detail:{threadId:id}}));window.__DSH_PERF__?.event('cached_view',{source:'indexeddb',durationMs:Date.now()-started});}else window.__DSH_CLIENT_LOG__?.event('history_rejected',{threadId:id,revision:snapshot.revision,reason:guard()?'hydrate_not_applied':'live_event_superseded'});
  })().catch(error=>{diagnostics.committedRefreshFailedAt=Date.now();window.__DSH_CLIENT_LOG__?.reportError('sync_failed',error,{threadId:id});}).finally(()=>{if(committedRefresh===work){committedRefresh=null;if(committedPending)scheduleCommitted();}});
  committedRefresh=work;return work;
 }
 async function refreshForeground(force=false){
  if(!androidReader||!nativeClient||document.visibilityState!=='visible'||!navigator.onLine||(window.__DSH_NATIVE_ONLINE__===false&&window.__DSH_EXECUTION_CONNECTED__!==true)||window.__DSH_NATIVE_SIDEBAR__?.isList)return;
  const id=location.pathname.match(/^\/local\/([0-9a-f-]{36})$/i)?.[1];if(!id)return;
  if(window.__DSH_NAVIGATION__?.notificationTarget?.()?.threadId===id)return;
  if(foregroundRefresh&&foregroundId===id){if(force)foregroundAgain=true;return foregroundRefresh;}
  if(!force&&id===foregroundId&&Date.now()-foregroundChecked<10000)return;
  foregroundId=id;foregroundAgain=false;foregroundChecked=Date.now();const viewEpoch=historyViewEpoch;
  const work=(async()=>{
   // A finished turn needs its final summary first, not every process item.
   const snapshot=await readFinalSummary(id)||await readFreshSnapshot(id);
   if(!snapshot?.verifiedNative){window.__DSH_CLIENT_LOG__?.event('history_rejected',{threadId:id,reason:'freshness_unverified'});return;}
   if(historyViewEpoch===viewEpoch&&location.pathname==='/local/'+id){await refreshCommitted(snapshot);diagnostics.foregroundRefreshedAt=Date.now();diagnostics.foregroundThread=id;}
  })().catch(error=>{diagnostics.foregroundRefreshFailedAt=Date.now();window.__DSH_CLIENT_LOG__?.reportError('sync_failed',error,{threadId:id});}).finally(()=>{if(foregroundRefresh===work){foregroundRefresh=null;if(foregroundAgain&&location.pathname==='/local/'+id){foregroundAgain=false;queueMicrotask(()=>refreshForeground(true));}}});
  foregroundRefresh=work;return work;
 }
 function refreshEntry(force=false){queueMicrotask(()=>{
  const id=location.pathname.match(/^\/local\/([0-9a-f-]{36})$/i)?.[1];
  // These are independent sources. A slow workspace-wide import must never
  // hold the selected conversation's fresh read or local first paint hostage.
  if(id)restoreFinalFirst(id).then(()=>refreshCommitted()).catch(()=>{});
  else refreshCommitted().catch(()=>{});
  if(androidReader)window.__DSH_ANDROID_BRIDGE__?.refresh().then(()=>refreshCommitted()).catch(()=>{});
  refreshForeground(force).catch(()=>{});
 });}
 for(const type of ['dsh:native-route','dsh:session-ready','dsh:conversation-ready','dsh:connection-state','dsh:execution-state','focus','pageshow','online'])addEventListener(type,()=>refreshEntry(type!=='dsh:conversation-ready'));
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshEntry(true)});
 addEventListener('dsh:history-updated',event=>{const id=event.detail?.threadId;if(androidReader&&event.detail?.source==='android'&&id&&(location.pathname==='/local/'+id||priorityPinned.has(id)))queueCachedPreparation(id);if(id&&location.pathname==='/local/'+id){if(androidReader){if(event.detail?.source==='android')scheduleCommitted();else refreshEntry();}else nativeClient?.hydrateBackgroundThreads?.([id],{includeTurns:true,maxTurns:1}).catch(()=>{});}});
 addEventListener('dsh:android-cache-updated',event=>{
  if(event.detail?.scope!==scope.id)return;
  const id=location.pathname.match(/^\/local\/([0-9a-f-]{36})$/i)?.[1];
  if(id&&event.detail.threadIds?.includes(id))scheduleCommitted();
  for(const threadId of event.detail.threadIds||[])if(priorityPinned.has(threadId)||recentWarmed.has(threadId)||knownRunning.has(threadId))queueCachedPreparation(threadId);
 });
 // Cache only scoped, credential-free bootstrap data. Tokens remain in RAM.
 let bootstrapValue=window.__CODEX_WEB_CONFIG__;
 Object.defineProperty(window,'__CODEX_WEB_CONFIG__',{configurable:true,get:()=>bootstrapValue,set:value=>{if(value?.initialSidebarBootstrap)value={...value,initialSidebarBootstrap:{...value.initialSidebarBootstrap,catalogEntries:(value.initialSidebarBootstrap.catalogEntries||[]).filter(listableEntry)}};bootstrapValue=value;if(value){const copy=structuredClone(value);if(copy.gatewayWsUrl){const u=new URL(copy.gatewayWsUrl);u.search='';copy.gatewayWsUrl=u.href;}saveMeta('bootstrap',copy).catch(()=>{});}}});
 if(bootstrapValue)window.__CODEX_WEB_CONFIG__=bootstrapValue;
 broadcast?.addEventListener('message',event=>{if(event.data?.type==='pinned-sidebar'){memoryMeta.delete('pinned-sidebar-v1');pinnedEmit?.('pinned-threads-updated',{});}if(event.data?.type==='pinned-cache'){memoryMeta.delete(event.data.key);pinnedEpoch++;pinnedDirty=false;pinnedCheckedAt=Date.now();pinnedEmit?.('pinned-threads-updated',{});}if(event.data?.type==='sync-event'){memoryMeta.delete('event-cursor');replicaChanged(event.data.event);}if(event.data?.type==='history'&&event.data.threadId===location.pathname.split('/')[2]){scheduleCommitted();refreshForeground();}if(event.data?.type==='catalog'){memoryMeta.delete('catalog-generation');memoryMeta.delete('catalog-cursor');memoryMeta.delete('catalog-status');catalogRevision=Math.max(catalogRevision,event.data.revision||0);notifyStatus();}});
 addEventListener('dsh:authentication-required',()=>saveMeta('auth-locked',true).catch(()=>{}));
 addEventListener('offline',()=>{resetPinnedReads();resetStableIpc();invalidateReadChecks();});
 addEventListener('dsh:session-ready',()=>{pinnedCheckedAt=0;pinnedEmit?.('pinned-threads-updated',{});});
 let lastCatalogPoll=0;
 const startSync=(event)=>{if(event?.type){invalidateReadChecks();stableIpcChecked.clear();}const interval=eventsSocket?.readyState===1?30000:5000;if(event?.type||Date.now()-lastCatalogPoll>=interval){lastCatalogPoll=Date.now();syncCatalog().catch(()=>{});}else diagnostics.catalogPollSkipped++;connectEvents().catch(()=>{});};addEventListener('online',startSync);addEventListener('focus',startSync);addEventListener('dsh:session-ready',startSync);addEventListener('pageshow',startSync);document.addEventListener('resume',startSync);document.addEventListener('visibilitychange',event=>{if(document.visibilityState==='visible')startSync(event);});
 const timer=setInterval(()=>{if(document.visibilityState==='visible'){startSync();refreshForeground();}},5000);
 const evictTimer=setInterval(()=>evict().catch(()=>{}),60000);

 // Read-only device inspection. Never fetch, hydrate, or touch eviction recency.
 function localCacheActivity(){
  const visible=window.__DSH_NATIVE_SIDEBAR__?.isList?null:location.pathname.split('/')[2];
  const queued=[...backgroundQueue];let reason=null;
  if(document.visibilityState!=='visible')reason='hidden';
  else if(!navigator.onLine)reason='offline';
  else if(window.__DSH_NATIVE_ONLINE__===false)reason='host_offline';
  else if(navigator.connection?.saveData)reason='save_data';
  else if(foregroundFreshReads.size)reason='foreground';
  else if(Date.now()-lastForeground<1800)reason='interaction';
  else if(queued.length&&!queued.some(id=>id!==visible))reason='visible';
  else if(queued.length&&!queued.some(id=>id!==visible&&Date.now()-(backgroundLast.get(id)||0)>10000))reason='backoff';
  return {busy:backgroundBusy,currentThread:diagnostics.background.currentThread||null,stage:diagnostics.background.stage||null,
   queued,pending:queued.length,preparing:[...rendererPending.keys()],prepareQueued:rendererQueue.size,reason,
   failures:[...backgroundErrors].map(([id,value])=>({id,...value})),prepareFailures:[...rendererErrors].map(([id,value])=>({id,...value})),completed:diagnostics.background.completed,nativeReady:!!nativeClient,androidReader};
 }
 async function inspectLocalCache(){
  if(await meta('auth-locked'))throw Error('请先登录后查看本机缓存');
  const deadline=Date.now()+CACHE_IO_TIMEOUT_MS*4,db=await cacheDb(remaining(deadline)),generation=await meta('catalog-generation',{timeoutMs:remaining(deadline)}),entries=new Map(),usage=new Map();let bytes=0,turnCount=0,itemCount=0;
  const scan=(source,visit,range,tx,label)=>cacheCursor(source.openCursor(range),tx,label,remaining(deadline),cursor=>{visit(cursor.value);});
  await Promise.all([
   (()=>{const tx=db.transaction('records','readonly');return scan(tx.objectStore('records').index('kind'),record=>{
    if(record.kind!=='catalog'||record.deleted||record.scope!==scope.id||hiddenThreads.has(record.payload?.threadId))return;
    if(generation&&record.sourceGeneration!==generation)return;const entry=record.payload;if(entry?.threadId)entries.set(entry.threadId,entry);
   },IDBKeyRange.only('catalog'),tx,'扫描目录缓存');})(),
   (()=>{const tx=db.transaction('usage','readonly');return scan(tx.objectStore('usage'),value=>{
    if(!value.threadId)return;let row=usage.get(value.threadId);if(!row){row={bytes:0,turns:0,items:0,hasHistory:false};usage.set(value.threadId,row);}
    const size=Math.max(0,Number(value.bytes)||0);bytes+=size;row.bytes+=size;
    if(value.key.startsWith('turn:')){row.turns++;turnCount++;row.hasHistory=true;}
    else if(value.key.startsWith('item:')){row.items++;itemCount++;row.hasHistory=true;}
    else if(value.key.startsWith('read:'))try{const [method,params]=JSON.parse(value.key.slice(5));if(method==='thread/turns/list'||method==='thread/items/list'||method==='thread/read'&&params.includeTurns)row.hasHistory=true;}catch{}
   },undefined,tx,'扫描缓存使用记录');})()
  ]);
  const recent=[...entries.values()].sort((a,b)=>(b.sourceUpdatedAt||b.sourceRecencyAt||0)-(a.sourceUpdatedAt||a.sourceRecencyAt||0)).slice(0,PREWARM_RECENT).map(entry=>entry.threadId);
  const targets=[...new Set([...priorityPinned,...recent,...knownRunning,...backgroundQueue])].filter(id=>!hiddenThreads.has(id));
  const rows=targets.map(id=>{const entry=entries.get(id),saved=usage.get(id);return {id,title:entry?.displayTitle||entry?.nativeThread?.name||'未命名会话',pinned:priorityPinned.has(id),stored:!!saved?.hasHistory,turns:saved?.turns||0,items:saved?.items||0,bytes:saved?.bytes||0,headChecked:false,headReady:false,renderReady:false,confirmedAt:0};});
  let index=0;
  await Promise.all(Array.from({length:Math.min(2,rows.length)},async()=>{while(index<rows.length&&Date.now()<deadline){const row=rows[index++];let snapshot;try{snapshot=await bounded(window.__DSH_READ_COMMITTED_HISTORY__(row.id,{touch:false,preferSummary:true}),'读取缓存首屏统计',remaining(deadline));}catch{continue;}row.headChecked=true;row.headReady=!!snapshot;row.confirmedAt=snapshot?.confirmedAt||0;row.localNewer=!!snapshot&&(nativeActivity.get(row.id)||0)>snapshot.confirmedAt;if(snapshot&&nativeClient?.getConversation?.(row.id)?.turnsPagination){row.renderReady=(rendererPrepared.get(row.id)===snapshot.stamp||committedApplied.get(row.id)===snapshot.stamp)&&(nativeActivity.get(row.id)||0)<=snapshot.confirmedAt;}}}));
  return {scope:scope.id,at:Date.now(),catalogCount:entries.size,historyThreadCount:[...usage.values()].filter(row=>row.hasHistory).length,bytes,turnCount,itemCount,
   recentLimit:PREWARM_RECENT,targets:rows,headReady:rows.filter(row=>row.headReady).length,renderReady:rows.filter(row=>row.renderReady).length,
   androidImportedCursor:await meta('android-replica-read-cursor-v1:'+scope.id)||0,androidImportedGeneration:await meta('android-replica-source-generation-v1:'+scope.id)||'',activity:localCacheActivity()};
 }
 window.__DSH_NATIVE_CACHE__={prepareSidebarBootstrap,inspectLocalCache,localCacheActivity,canReload:()=>!window.__DSH_PREVIEW__?.isOpen?.()&&!window.__DSH_NAVIGATION__?.notificationTarget?.()&&recoveryReloadReady()&&![...composerViews.values()].some(view=>Object.values(JSON.parse(view.fingerprint)).some(value=>Array.isArray(value)?value.length:value&&typeof value==='object'?Object.keys(value).length:!!value)),opening,meta,saveMeta,get,put,read,catalog,syncCatalog,readKey,recordCommand,pendingCommands,persistAtom,restoreAtoms,importSnapshot,diagnostics:()=>{const id=location.pathname.split('/')[2],c=nativeClient?.getConversation?.(id);return {...diagnostics,background:{...diagnostics.background,pending:backgroundQueue.size,busy:backgroundBusy},nativeClient:!!nativeClient,remoteReady,online:window.__DSH_NATIVE_ONLINE__,executionConnected:window.__DSH_EXECUTION_CONNECTED__,nativeVersion:nativeClient?.requestClient?.getAppServerVersion?.(),turns:c?.turns?.length,historyKind:c?.turnHistory?.kind,historyEntities:Object.keys(c?.turnHistory?.history?.entitiesByKey||{}).length,resumeState:c?.resumeState,statusRecovery:window.__DSH_NATIVE_STATUS_RECOVERY__?.diagnostics()};},async close(){stopNativeAuthRecovery?.();clearTimeout(rendererTimer);clearInterval(backgroundScanTimer);clearTimeout(committedTimer);clearTimeout(backgroundTimer);clearInterval(timer);clearTimeout(evictTimer);window.__DSH_STOP_EVENT_CONNECTION__?.();broadcast?.close();const db=await cacheDb().catch(()=>null);db?.close();}};
})();

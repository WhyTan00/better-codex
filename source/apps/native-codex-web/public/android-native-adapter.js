// Android 混合 App 的 document-start 窄桥。没有 Android WebMessageListener 时
// 立即退出，因此不会改变浏览器/PWA 路径。
(()=>{
 'use strict';
 const ORIGIN='__BETTER_CODEX_ORIGIN__',PROTOCOL=1,SCOPES=new Set(['ai','zyy']);
 let bridge;
 try{if(location.origin!==ORIGIN||window.top!==window)return;bridge=window.DshNative;}catch{return;}
 if(!bridge||typeof bridge.postMessage!=='function'||window.__DSH_ANDROID_BRIDGE__)return;

 const SAFE_METHODS=new Set(['scopeSession','presentConversation','recordDiagnostics','readStream','readThreadRecords','readSavedThreadRecords','readSavedRecord','saveReadRecord','saveVisibleProcesses','readVisibleProcesses','invalidateVisibleProcesses','openDeliverable','resolveDeliverable','focusThread','diagnosticContext','status','requestSync','readRecords','startSync','stopSync','openSettings','getTheme','setTheme','saveDocument','getNotificationSettings','setDeviceOwner','setCompletionNotifications']),RECORD_KINDS=new Set(['catalog','history','turn','item','readAlias']);
 const pending=new Map(),states=new Map();
 let serial=0,currentScope=null,cache=null,scopeEpoch=0,pullPromise=null,pullAgain=false;
 const identities=new Set(),identityRequested=new Set();let nativeApkVersion=0,focusedKey='';
 function focusSelected(){if(nativeApkVersion<16||document.visibilityState==='hidden'||window.__DSH_NATIVE_SIDEBAR__?.isList)return;const id=location.pathname.match(/^\/local\/([a-f0-9-]{36})$/i)?.[1];if(!id)return;const key=currentScope+':'+id;if(key===focusedKey)return;focusedKey=key;nativeRequest('focusThread',{threadId:id}).then(result=>{if(result?.accepted!==true&&focusedKey===key)focusedKey='';}).catch(()=>{if(focusedKey===key)focusedKey='';});}
 let presentationKey='';
 function presentConversation(seenTurnId){
  if(nativeApkVersion<43||!currentScope)return;
  const threadId=document.visibilityState==='visible'&&!window.__DSH_NATIVE_SIDEBAR__?.isList?location.pathname.match(/^\/local\/([a-f0-9-]{36})$/i)?.[1]??'':'';
  const key=JSON.stringify([currentScope,threadId,seenTurnId||'']);if(key===presentationKey)return;presentationKey=key;
  nativeRequest('presentConversation',{threadId,visible:!!threadId,...threadId&&seenTurnId?{seenTurnId}:{}}).catch(()=>{if(presentationKey===key)presentationKey='';});
 }
 const log=(stage,values={})=>window.__DSH_CLIENT_LOG__?.event('client_health',{component:'android-bridge',stage,...values});
 function observeIdentity(status){const identity=status?.nativeDiagnostics;if(identity?.deviceId&&!identities.has(currentScope+':'+identity.processIdTag)){identities.add(currentScope+':'+identity.processIdTag);nativeApkVersion=Number(identity.apkVersion)||0;focusSelected();presentConversation();log('boot',{nativeDeviceId:identity.deviceId,processIdTag:identity.processIdTag,apkVersion:identity.apkVersion});}else if(!identity?.deviceId&&!identityRequested.has(currentScope)){const captured=currentScope;identityRequested.add(captured);nativeRequest('diagnosticContext').then(value=>{if(captured===currentScope&&value?.deviceId)observeIdentity({nativeDiagnostics:value});}).catch(()=>{});}}
 let statusTimer=null,probeTimer=null,scopeProbeTimer=null,closed=false,lastStatusFingerprint='';
 let readyResolve,cacheReadyResolve;const ready=new Promise(resolve=>{readyResolve=resolve;}),cacheReady=new Promise(resolve=>{cacheReadyResolve=resolve;});
 let cacheReadyStarted=false;
 const uuid=()=>crypto?.randomUUID?.()||'android-'+Date.now().toString(36)+'-'+(++serial).toString(36);
 const validScope=value=>SCOPES.has(value)?value:null;
 const scopeFromPage=()=>{
  const value=validScope(window.__DSH_SCOPE__?.id);
  if(value)return value;
  try{return validScope(new URL(location.href).searchParams.get('workspace'));}catch{return null;}
 };
 const stateFor=scope=>{let value=states.get(scope);if(!value){value={after:0,generation:'',running:null,changed:new Set()};states.set(scope,value);}return value;};
 const detail=(scope,value={})=>({scope,protocol:PROTOCOL,...value});
 const emit=(type,scope,value={})=>{try{window.dispatchEvent(new CustomEvent(type,{detail:detail(scope,value)}));}catch{}};
 const decode=value=>{
  if(value&&typeof value==='object')return value;
  if(typeof value!=='string')return null;
  try{const parsed=JSON.parse(value);return parsed&&typeof parsed==='object'?parsed:null;}catch{return null;}
 };
 const requestIdOf=value=>typeof value?.requestId==='string'?value.requestId:typeof value?.id==='string'?value.id:null;
 const onMessage=event=>{
 const origin=typeof event?.origin==='string'?event.origin:'';if(origin&&origin!==ORIGIN)return;
  const value=decode(event?.data??event);if(!value||value.version!==PROTOCOL)return;
  if(value.event==='status'){
   const scope=validScope(value.scope);if(!scope||scope!==currentScope)return;
   const status=value.status&&typeof value.status==='object'?value.status:value;
   stateFor(scope).historyWarmOwned=nativeApkVersion>=64&&status?.enabled===true&&status?.running===true;
   const fingerprint=JSON.stringify([scope,status.state,status.online,status.enabled,status.running,status.recordCursor,status.cursor,status.generation,status.catalogCursor,status.eventCursor]);
   emit('dsh:android-status',scope,{status});
   if(fingerprint!==lastStatusFingerprint){lastStatusFingerprint=fingerprint;pull('status').catch(()=>{});}
   return;
  }
  const id=requestIdOf(value),waiter=id&&pending.get(id);if(!waiter)return;
  if(value.scope!==waiter.scope){return;}
  pending.delete(id);clearTimeout(waiter.timer);if(waiter.method!=='recordDiagnostics')log(value.ok===false||value.error?'failed':'received',{traceId:id,durationMs:Math.round(performance.now()-waiter.at),method:waiter.method});
  if(value.ok===false||value.error){const error=typeof value.error==='string'?value.error:value.error?.message||'Android 桥请求失败';waiter.reject(Object.assign(Error(error),{code:value.error?.code||value.status}));return;}
  waiter.resolve(Object.hasOwn(value,'result')?value.result:value.data??value);
 };
 try{bridge.addEventListener?.('message',onMessage);bridge.onmessage=onMessage;}catch{}

 const nativeRequest=(method,body={},timeout=15000)=>{
  if(closed) return Promise.reject(Error('Android 桥已关闭'));
  if(!SAFE_METHODS.has(method))return Promise.reject(Error('Android 桥只允许同步读取与显式同步控制'));
  const scope=currentScope;if(!scope)return Promise.reject(Error('工作区尚未就绪'));
  const requestId=uuid(),message={version:PROTOCOL,requestId,id:requestId,method,scope};
  for(const[key,value]of Object.entries(body||{}))if(!['version','requestId','id','method','scope'].includes(key))message[key]=value;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{pending.delete(requestId);if(method!=='recordDiagnostics')log('failed',{traceId:requestId,method,reason:'timeout'});reject(Error('Android 同步请求超时'));},timeout);
   pending.set(requestId,{scope,timer,resolve,reject,at:performance.now(),method});if(method!=='recordDiagnostics')log('requested',{traceId:requestId,method});
   try{bridge.postMessage(JSON.stringify(message));}catch(error){clearTimeout(timer);pending.delete(requestId);reject(error);}
  });
 };
 const rejectScope=scope=>{for(const[id,waiter]of pending){if(waiter.scope!==scope)continue;clearTimeout(waiter.timer);pending.delete(id);waiter.reject(Error('工作区已切换'));}};

 const cursorKey=scope=>'android-replica-read-cursor-v1:'+scope;
 const generationKey=scope=>'android-replica-source-generation-v1:'+scope;
 const number=value=>Number.isSafeInteger(value)&&value>=0?value:null;
 const recordOk=(record,scope,generation)=>{
  if(!record||record.scope!==scope||typeof record.key!=='string'||record.key.length<1||record.key.length>512||!RECORD_KINDS.has(record.kind))return false;
  if(typeof record.sourceGeneration!=='string'||!record.sourceGeneration)return false;
  if(generation&&record.sourceGeneration!==generation)return false;
  if(record.threadId!=null&&(typeof record.threadId!=='string'||record.threadId.length>200))return false;
  if(!Number.isSafeInteger(record.revision)||record.revision<1||typeof record.generation!=='string'||!record.generation)return false;
  if(typeof record.deleted!=='boolean'||record.bytes!=null&&(typeof record.bytes!=='number'||record.bytes<0||record.bytes>64*1024*1024))return false;
  return true;
 };
 const pageOk=(page,scope)=>{
  if(!page||page.scope!==scope||typeof page.generation!=='string'||!page.generation||!Array.isArray(page.records)||page.records.length>200||page.hasMore===true&&!page.records.length)return false;
  const generation=page.generation;
  return page.records.every(record=>recordOk(record,scope,generation));
 };
 async function importPage(page,scope,epoch,after){
  if(epoch!==scopeEpoch||scope!==currentScope)return false;
  if(!pageOk(page,scope))throw Error('Android 缓存记录身份或格式不匹配');
  const next=number(page.cursor);if(next==null||next<after||(page.hasMore&&next===after))throw Error('Android 缓存游标无效');
  const state=stateFor(scope),generation=page.generation||page.records[0]?.sourceGeneration||state.generation;
  const payload={...page,scope,source:'android',readCursorKey:cursorKey(scope),readCursor:next,sourceGenerationKey:generationKey(scope)};
  if(typeof cache.importSnapshot!=='function')throw Error('Android 缓存导入入口尚未就绪');
  // 该入口负责 catalog staging、history entities 与读取游标同事务提交。
  await cache.importSnapshot(payload);
  if(generation&&state.generation&&generation!==state.generation)state.changed.clear();
  state.after=next;if(generation)state.generation=generation;
  const ids=[...new Set(page.records.map(record=>record.threadId).filter(id=>typeof id==='string'&&id))];
  for(const id of ids)state.changed.add(id);
  emit('dsh:android-cache-updated',scope,{cursor:next,generation:state.generation,hasMore:!!page.hasMore,catalogRecords:page.records.filter(record=>record.kind==='catalog').length,historyRecords:page.records.filter(record=>record.kind!=='catalog').length,threadIds:ids});
  return true;
 }
 async function pull(reason='manual'){
  if(!currentScope||!cache)return null;
  if(pullPromise){if(reason==='status'||reason==='foreground')pullAgain=true;return pullPromise;}
  const scope=currentScope,epoch=scopeEpoch,state=stateFor(scope);let completed=null;
  pullPromise=(async()=>{
   // meta/importSnapshot provide bounded storage operations; a raw opening promise can stall forever.
   let saved=number(await cache.meta(cursorKey(scope)).catch(()=>null));if(saved==null)saved=0;
   const savedGeneration=await cache.meta(generationKey(scope)).catch(()=>null);
   if(typeof savedGeneration==='string'&&savedGeneration)state.generation=savedGeneration;
   const status=await nativeRequest('status');
   if(epoch!==scopeEpoch||scope!==currentScope)return null;
   if(status?.scope&&status.scope!==scope)throw Error('Android 状态工作区不匹配');
   observeIdentity(status);state.historyWarmOwned=nativeApkVersion>=64&&status?.enabled===true&&status?.running===true;focusSelected();emit('dsh:android-status',scope,{status,reason});
   const statusGeneration=typeof status?.generation==='string'?status.generation:'';
   if(statusGeneration){if(state.generation&&state.generation!==statusGeneration)state.changed.clear();state.generation=statusGeneration;}
   // A source generation reset also clears Android's local change log. Older
   // builds can return an empty page with cursor still above the new maximum,
   // so generation evidence must rewind the local read cursor before reading.
   if(saved>0&&statusGeneration&&statusGeneration!==savedGeneration){
    saved=0;state.after=0;await cache.saveMeta(cursorKey(scope),0);
   }
   if(status?.resetRequired===true&&saved>0){saved=0;state.after=0;await cache.saveMeta(cursorKey(scope),0);}
   let after=saved,loops=0,resets=0;
   do{
    if(++loops>64)throw Error('Android 缓存分页超过单次上限');
    const page=await nativeRequest('readRecords',{after,limit:200},20000);
    if(epoch!==scopeEpoch||scope!==currentScope)return null;
    if(!page||page.scope!==scope)throw Error('Android 记录工作区不匹配');
    const pageGeneration=typeof page.generation==='string'?page.generation:'';
    if(after>0&&pageGeneration&&pageGeneration!==state.generation){
     if(++resets>2)throw Error('Android 缓存代际连续变化');
     after=0;state.after=0;await cache.saveMeta(cursorKey(scope),0);continue;
    }
    if(page.resetRequired===true){if(++resets>2)throw Error('Android 缓存连续要求重置');after=0;state.after=0;await cache.saveMeta(cursorKey(scope),0);continue;}
    await importPage(page,scope,epoch,after);
    after=number(page.cursor);
    if(after==null||!page.hasMore)break;
   }while(true);
   state.after=after;
   // SQLite pages are durable changes, not animation frames. Publish one
   // history invalidation after this import reaches its current head. Retain
   // changed identities across a failed page so a later import can finish it.
   if(epoch===scopeEpoch&&scope===currentScope){
    const ids=[...state.changed];state.changed.clear();
    completed={cursor:after,threadIds:ids};
   }
   return {scope,cursor:after,reason};
  })().catch(error=>{emit('dsh:android-sync-error',scope,{message:error.message,reason});throw error;}).finally(()=>{pullPromise=null;if(completed&&epoch===scopeEpoch&&scope===currentScope){for(const id of completed.threadIds)window.dispatchEvent(new CustomEvent('dsh:history-updated',{detail:{threadId:id,source:'android'}}));emit('dsh:android-import-complete',scope,completed);}if(pullAgain&&scope===currentScope&&epoch===scopeEpoch){pullAgain=false;queueMicrotask(()=>pull('coalesced').catch(()=>{}));}});
  return pullPromise;
 }
 async function setScope(next){
  next=validScope(next);if(!next||next===currentScope)return;
  const previous=currentScope,epoch=++scopeEpoch,previousPull=pullPromise;if(previous)rejectScope(previous);currentScope=next;focusedKey='';pullAgain=false;lastStatusFingerprint='';
  emit('dsh:android-scope-changed',next,{previous});
  if(cache){const start=()=>{if(epoch===scopeEpoch)pull('scope-change').catch(()=>{});};if(previousPull)previousPull.finally(start).catch(()=>{});else start();}
 }

 function hidePwaOnlyInApp(){
  let initialized=false;
  const mark=node=>{if(node&&node.nodeType===1){node.hidden=true;node.setAttribute('data-dsh-android-hidden','1');}};
  const button=node=>{if(node?.matches?.('button')&&(node.textContent||'').trim()==='安装')mark(node);};
  const settings=dialog=>{
   if(!dialog?.isConnected)return;
   const headings=[...dialog.querySelectorAll('h3')],owner=headings.find(node=>node.textContent.trim()==='这台设备的使用者'),quota=headings.find(node=>node.textContent.trim()==='账户额度');
   if(owner){let node=owner;while(node&&node!==quota){mark(node);node=node.nextElementSibling;}}
  };
  const added=(node,dialogs)=>{
   if(node?.nodeType!==1)return;
   button(node);
   for(const child of node.querySelectorAll?.('button')||[])button(child);
   const dialog=node.closest?.('.dsh-preferences');if(dialog)dialogs.add(dialog);
   for(const child of node.querySelectorAll?.('.dsh-preferences')||[])dialogs.add(child);
  };
  const initialize=()=>{
   const root=document.documentElement;if(initialized||!root)return false;
   initialized=true;root.dataset.dshAndroidApp='1';
   if(!document.getElementById('dsh-android-adapter-style')){const style=document.createElement('style');style.id='dsh-android-adapter-style';style.textContent='[data-dsh-android-hidden="1"]{display:none!important}';(document.head||root).append(style);}
   const dialogs=new Set();added(root,dialogs);for(const dialog of dialogs)settings(dialog);return true;
  };
  const observer=new MutationObserver(records=>{
   if(initialize())return;
   const dialogs=new Set();
   for(const record of records){
    // Streaming text must not rescan every button in the conversation.
    const target=record.target?.nodeType===1?record.target:record.target?.parentElement;
    button(target?.closest?.('button'));
    const dialog=target?.closest?.('.dsh-preferences');if(dialog)dialogs.add(dialog);
    for(const node of record.addedNodes||[])added(node,dialogs);
   }
   for(const dialog of dialogs)settings(dialog);
  });
  observer.observe(document,{childList:true,characterData:true,subtree:true});initialize();
  return ()=>observer.disconnect();
 }
 const unhide=hidePwaOnlyInApp();

 async function logout(){
  const scope=currentScope;if(!scope)return;
  try{await nativeRequest('stopSync');}finally{emit('dsh:android-logout',scope,{serviceStopped:true,credentialsCleared:false});}
 }
 async function close(){
  if(closed)return;closed=true;clearInterval(probeTimer);clearInterval(scopeProbeTimer);clearInterval(statusTimer);unhide?.();
  for(const[id,waiter]of pending){clearTimeout(waiter.timer);waiter.reject(Error('Android 桥已关闭'));pending.delete(id);}
  bridge.removeEventListener?.('message',onMessage);if(bridge.onmessage===onMessage)bridge.onmessage=null;
 }
 const api={
  scopeSession:({traceId}={})=>nativeRequest('scopeSession',{traceId},16000),
  protocol:PROTOCOL,isAndroid:true,ready,cacheReady,scope:()=>currentScope,importing:()=>!!pullPromise,status:()=>nativeRequest('status'),
  ownsHistoryWarm:()=>currentScope!==null&&stateFor(currentScope).historyWarmOwned===true,
  openDeliverable:path=>nativeRequest('openDeliverable',{path},60000),
  resolveDeliverable:path=>nativeApkVersion>=19?nativeRequest('resolveDeliverable',{path}):Promise.resolve({available:false}),
  requestSync:async()=>{const value=await nativeRequest('requestSync');await pull('request-sync');return value;},
  readStream:threadId=>nativeApkVersion>=23?nativeRequest('readStream',{threadId}):Promise.resolve(null),
  readThreadRecords:threadId=>nativeApkVersion>=24?nativeRequest('readThreadRecords',{threadId}):Promise.resolve(null),
  readSavedThreadRecords:threadId=>nativeApkVersion>=51?nativeRequest('readSavedThreadRecords',{threadId}):Promise.resolve(null),
  readSavedRecord:(key,version={})=>nativeApkVersion>=51?nativeRequest('readSavedRecord',{key,...version}):Promise.resolve(null),
  saveReadRecord:record=>nativeApkVersion>=51?nativeRequest('saveReadRecord',{record}):Promise.resolve(null),
  saveVisibleProcesses:value=>nativeApkVersion>=64?nativeRequest('saveVisibleProcesses',{value}):Promise.resolve(null),
  readVisibleProcesses:(threadId,turnId)=>nativeApkVersion>=64?nativeRequest('readVisibleProcesses',{threadId,turnId}):Promise.resolve(null),
  invalidateVisibleProcesses:(threadId,at)=>nativeApkVersion>=64?nativeRequest('invalidateVisibleProcesses',{threadId,at}):Promise.resolve(null),
  readRecords:({after=0,limit=200}={})=>nativeRequest('readRecords',{after:number(after)??0,limit:Math.min(200,Math.max(1,Number(limit)||200))},20000),
  getNotificationSettings:()=>nativeRequest('getNotificationSettings'),setDeviceOwner:owner=>nativeRequest('setDeviceOwner',{owner}),setCompletionNotifications:enabled=>nativeRequest('setCompletionNotifications',{enabled}),
  getTheme:()=>nativeRequest('getTheme'),setTheme:mode=>nativeRequest('setTheme',{mode}),openSettings:()=>nativeRequest('openSettings'),startSync:()=>nativeRequest('startSync'),stopSync:()=>nativeRequest('stopSync'),logout,refresh:()=>pull('manual'),close,
  saveDocument:async(blob,filename)=>{if(currentScope!=='zyy'||blob.type!=='application/vnd.openxmlformats-officedocument.wordprocessingml.document'||blob.size>8*1024*1024)throw Error('Word 文件无效或过大');const state=await nativeRequest('status');if(state.documentExport!==true)throw Object.assign(Error('请先更新 App，再保存 Word 文件'),{code:'APP_UPDATE_REQUIRED'});const bytes=new Uint8Array(await blob.arrayBuffer());let data='';for(let i=0;i<bytes.length;i+=32768)data+=String.fromCharCode(...bytes.subarray(i,i+32768));return nativeRequest('saveDocument',{filename,mimeType:blob.type,data:btoa(data)},300000);}
 };
 api.markCompletionSeen=(threadId,turnId)=>{if(location.pathname==='/local/'+threadId)presentConversation(turnId);};
 api.canRecordDiagnostics=()=>nativeApkVersion>=26;api.recordDiagnostics=events=>nativeRequest('recordDiagnostics',{events});
 window.__DSH_ANDROID_BRIDGE__=api;window.__DSH_ANDROID_CACHE_READY__=cacheReady;window.__DSH_ANDROID_APP__={isAndroid:true,protocol:PROTOCOL,scope:api.scope,ready,cacheReady,logout,openSettings:api.openSettings};
 const stopProbe=()=>{if(probeTimer!=null){clearInterval(probeTimer);probeTimer=null;}};
 const update=()=>{
  const next=scopeFromPage();if(next)setScope(next);
  const candidate=window.__DSH_NATIVE_CACHE__;if(candidate&&candidate!==cache)cache=candidate;
  if(!cache||!currentScope)return;
  if(!cacheReadyStarted){readyResolve(api);cacheReadyStarted=true;const startup=pull('startup');startup.then(value=>cacheReadyResolve({ok:true,value}),error=>cacheReadyResolve({ok:false,error:error.message}));}
  stopProbe();
 };
 probeTimer=setInterval(update,100);update();scopeProbeTimer=setInterval(()=>{if(document.visibilityState!=='hidden')update();},15000);
 const foreground=()=>{update();presentConversation();if(document.visibilityState!=='hidden'){focusSelected();pull('foreground').catch(()=>{});}else focusedKey='';};
 addEventListener('pageshow',foreground);addEventListener('focus',foreground);addEventListener('online',foreground);addEventListener('popstate',foreground);addEventListener('dsh:native-route',foreground);addEventListener('dsh:session-ready',foreground);document.addEventListener('visibilitychange',foreground);
 statusTimer=setInterval(()=>{if(document.visibilityState!=='hidden')pull('poll').catch(()=>{});},30000);
 addEventListener('pagehide',()=>{if(nativeApkVersion>=43)nativeRequest('presentConversation',{threadId:'',visible:false}).catch(()=>{}); /* 页面离开不停止后台同步；停止只属于显式 logout/stopSync。 */ });
})();

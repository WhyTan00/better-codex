import {PROJECT_STATE_KEYS,workspaceProjects,readWorkspaceGlobalState} from './workspace-projects.mjs';
import {pluginUiRoute,readPluginUi} from './plugin-ui-store.mjs';
import {ConnectionDiagnostics,hashDiagnosticId,rpcDiagnosticContext,errorDiagnosticFields,appHostError} from './connection-diagnostics.mjs';
// 私有官方界面前门：静态资源复用 OpenCodex，内容/命令统一经过固定 scope 原生适配器。
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import {readFile,mkdir} from 'node:fs/promises';
import {WebSocketServer,appHostCodec,appHostProtocol} from './runtime-dependencies.mjs';
import {portableConfig,runtimeProfile} from './runtime-profile.mjs';
import {randomBytes,createHmac,timingSafeEqual,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {SharedNative} from './shared-native.mjs';
import {officialReady} from './official-readiness.mjs';
import {OfficialBoundary} from './official-boundary.mjs';
import {NativeCapacityRetry} from './native-capacity-retry.mjs';
import {HistoryUpgradeBeforeResume} from './history-upgrade-before-resume.mjs';
import {scopeRuntimeAssets} from './official-assets.mjs';
import {createAppHostFactory} from './official-app-host.mjs';
import {OfficialGit} from './official-git.mjs';
import {OfficialState} from './official-state.mjs';
import {createOfficialSettings} from './official-settings.mjs';
import {PageSessions,PAGE_RESUME_PROTOCOL,REPLY_STREAM_PROTOCOL} from './page-sessions.mjs';
import {NativeEventDispatcher} from './native-event-dispatcher.mjs';
import {cacheableBootstrap} from './native-bootstrap.mjs';
import {nativeUIRelease,scopeSources} from './native-ui-release.mjs';
import {NativeReadCache} from './native-read-cache.mjs';
import {NativeQueue} from './native-queue.mjs';
import {QueuedSendLocks} from './queued-send-locks.mjs';
import {OfficialFiles} from './official-files.mjs';
import {FileDiagnostics} from './file-diagnostics.mjs';
import {loadShellAssets} from './shell-assets.mjs';
import {serveFileResponse} from './file-response.mjs';
import {Deliverables} from './deliverables.mjs';
import {PhoneCodeBroker} from './phone-code-broker.mjs';
import {wantsNativeNotification} from './notification-interest.mjs';
import {endToEndHeaders} from './http-headers.mjs';
import {nativeVersion} from './native-version.mjs';
import {safePerformanceEvents} from './performance-events.mjs';
import {OfficialDesktopMetadata} from './official-desktop-metadata.mjs';
import {TextResponses} from './official-http-text.mjs';
import {isWorkspaceNavigation,navigationDenial} from './navigation.mjs';
import {worktreeInitialAssetPrefix} from './official-worktree-precheck.mjs';
import {historyAssetPrefix,gestureHistoryAssetPrefix,menuHistoryAssetPrefix,composerHistoryAssetPrefix,lastHistoryAssetPrefix,previousHistoryAssetPrefix,followUpAssetPrefix,retainedFollowUpAssetPrefix,draftFollowUpAssetPrefix,lastFollowUpAssetPrefix,previousFollowUpAssetPrefix,upstreamAssetPrefix,historyClientAsset,patchInitialHistoryBudget,filePreviewClientAsset,patchFilePreviewChrome,followUpClientAsset,patchFollowUpControls,patchNativeModulePreloads} from './official-history-assets.mjs';
import {Journal} from './journal.mjs';
import {workspace,belongs,fail,SCOPES} from './registry.mjs';
import {projectData,projectMaterialFeedback} from './project-data.mjs';
const PRIVATE=runtimeProfile.runtime;
const codec=appHostCodec();
const {RpcSession,RpcTarget}=await appHostProtocol();
const CHANNEL='codex_desktop:message-for-view';
const BULK_READ_PROTOCOL='dsh-bulk-read-v1',BULK_READ_METHODS=new Set(['app/list','mcpServerStatus/list','thread/list','thread/read','thread/turns/list','thread/goal/get','config/read','configRequirements/read']);
const ATTACHMENT_UPLOAD_PROTOCOL='dsh-attachment-upload-v1',ATTACHMENT_MAX=20*1024*1024;
const BOOTSTRAP_READS=new Set(['codex_desktop:get-initial-sidebar-bootstrap','codex_desktop:get-shared-object-snapshot','codex_desktop:get-build-flavor','codex_desktop:get-system-theme-variant','codex_desktop:get-sentry-init-options']);
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
async function body(req){let s='',size=0;for await(const b of req){size+=b.length;if(size>29*1024*1024)throw fail(413,'请求过大');s+=b;}try{return JSON.parse(s);}catch{throw fail(400,'请求格式无效');}}
const statusOf=e=>typeof e.code==='number'&&e.code>=400&&e.code<=599?e.code:({ENOENT:404,EACCES:403,EPERM:403,ELOOP:403,EISDIR:400,ENOTDIR:400}[e.code]||500);
function errorShape(e){return {code:e.rpcCode||-32000,message:e.code?e.message:'官方桥接暂不可用',data:{status:statusOf(e)}};}
export async function createOfficialFront({port=3084,upstream=runtimeProfile.upstream,native=new SharedNative({reconnect:true,preserveProcessIdentity:false}),stateDir=PRIVATE+'/front-state',publicOrigin=null,historyUpgradeWaitMs=10000}={}){
 if(publicOrigin){const u=new URL(publicOrigin);if(portableConfig){if(publicOrigin!==portableConfig.origin)throw fail(400,'入口必须匹配部署配置');}else if(u.protocol!=='http:'||!['localhost','127.0.0.1'].includes(u.hostname))throw fail(400,'开发候选仅允许回环入口');publicOrigin=u.origin;}
 await mkdir(stateDir,{recursive:true,mode:0o700});const connectionLog=new ConnectionDiagnostics({file:path.join(stateDir,'connections.jsonl')});connectionLog.event({component:'front',stage:'boot',processId:process.pid});native.on('connection-diagnostic',entry=>connectionLog.event(entry));
 const phoneCodes=portableConfig?null:await new PhoneCodeBroker({root:path.join(stateDir,'phone-code')}).start();
 const historyReads=[],historyUpgrades=[];let historyUpgrade;
 const historyUpgradeBeforeResume=async target=>{
  const nativeHome=native.initialization?.codexHome;
  if(typeof nativeHome!=='string'||!path.isAbsolute(nativeHome))return {status:'unavailable'};
  if(!historyUpgrade||historyUpgrade.nativeHome!==nativeHome)historyUpgrade=new HistoryUpgradeBeforeResume({native,stateDir,nativeHome});
  return historyUpgrade.beforeResume(target);
 };
 const journal=new Journal(portableConfig?path.join(portableConfig.stateDir,'commands'):process.env.DSH_COMMAND_JOURNAL_DIR||stateDir),boundary=new OfficialBoundary({native,journal,historyUpgradeBeforeResume,historyUpgradeWaitMs,enableDefaultModeQuestions:true,onHistoryUpgrade:entry=>{
  historyUpgrades.push({at:new Date().toISOString(),...entry});if(historyUpgrades.length>200)historyUpgrades.shift();
  connectionLog.event({component:'front',method:'thread/resume',scope:entry.scope,threadId:entry.threadId,rpcIdHash:entry.rpcIdHash,traceId:entry.transactionId,durationMs:entry.durationMs,stage:entry.status==='verified'?'verified':['preparing','pending','in_progress'].includes(entry.status)?'pending':entry.status==='needs_review'?'failed':'skipped',...(entry.failureClass?{failureClass:entry.failureClass}:{}),...(entry.errorCode?{errorCode:entry.errorCode}:{})});
 },onNativeResponse:(scope,method,p,result)=>{if(method==='thread/resume')nativeCache.rememberCursors(scope,result);if(method==='thread/delete')nativeCache.deleteThread(scope,p.threadId);},onHistoryRead:entry=>{historyReads.push({at:new Date().toISOString(),...entry});if(historyReads.length>200)historyReads.shift();}});
 const capacityRetry=boundary.capacityRetry=portableConfig?null:new NativeCapacityRetry({boundary});
 native.on('interrupted',()=>capacityRetry?.connectionLost());
 const shell=await loadShellAssets();
 const clients=new Set(),clientById=new Map(),fileGrants=new Map(),diagnostics=new Map(),desktopMetadata=new OfficialDesktopMetadata(upstream);let bulkIdentityGeneration=0;
 native.on('interrupted',()=>{bulkIdentityGeneration++;});
 const performanceEvents=[];
 function trace(scope,kind,value){const name=typeof value==='string'&&/^[a-zA-Z0-9_:/.-]{1,150}$/.test(value)?value:'unknown',key=`${scope}:${kind}:${name}`;if(diagnostics.size<512||diagnostics.has(key))diagnostics.set(key,(diagnostics.get(key)||0)+1);}
 const localReleases=new Map();let releaseRefresh=null;
 const epoch=randomUUID(),sequence={ai:0,zyy:0},secret=randomBytes(32),textResponses=new TextResponses();let configCache=null,configAt=0,configLoading=null,runtimeAssets=null,gestureHistoryAssetLoading=null,filePreviewAssetLoading=null,menuHistoryAssetLoading=null,composerHistoryAssetLoading=null,historyAssetLoading=null,previousHistoryAssetLoading=null,lastHistoryAssetLoading=null,localReleaseLoading=null,followUpAssetLoading=null,lastFollowUpAssetLoading=null,draftFollowUpAssetLoading=null,legacyFollowUpAssetLoading=null,previousFollowUpAssetLoading=null;
 const sign=s=>createHmac('sha256',secret).update(s).digest('base64url');
 const token=ws=>{const s=Buffer.from(JSON.stringify({scope:ws.id,exp:Date.now()+12*3600000})).toString('base64url');return s+'.'+sign(s);};
 function authorized(req,scope,url){workspace(scope);const t=req.headers['x-dsh-scope']||url.searchParams.get('scopeToken')||'';const[a,b]=String(t).split('.');if(!a||!b||b.length!==43||!timingSafeEqual(Buffer.from(b),Buffer.from(sign(a))))throw fail(401,'工作区连接已失效，请刷新');let p;try{p=JSON.parse(Buffer.from(a,'base64url'));}catch{throw fail(401,'连接无效');}if(p.exp<Date.now())throw fail(401,'连接已过期');if(p.scope!==scope)throw fail(403,'工作区连接不匹配');return workspace(scope);}
 const fileDiagnostics=new FileDiagnostics({emit:entry=>console.log(JSON.stringify({event:'file-operation',...entry}))});
 const store=new OfficialState(stateDir),files=fileDiagnostics.observe(new OfficialFiles({stateDir,boundary}));boundary.files=files;const git=new OfficialGit({upstream,files,send});
 const state=scope=>store.read(scope),persist=scope=>store.persist(scope);const bootstrapDefaults=new Map(),failedAtomBroadcasts=new Set(),pendingAtomWrites=new Map();
 const settings=createOfficialSettings({RpcTarget,state,persist});
 const queuedSendLocks=new QueuedSendLocks(journal.db),nativeQueue=new NativeQueue({boundary,journal}),nativeCache=new NativeReadCache(portableConfig?path.join(portableConfig.stateDir,'native-cache'):process.env.DSH_NATIVE_CACHE_DIR||path.join(stateDir,'native-cache'),{boundary});
 const deliverables=new Deliverables({root:path.join(stateDir,'deliverables'),files,read:(scope,method,params)=>nativeCache.read(scope,method,params,{fresh:false}),check:(scope,id)=>boundary.checked(workspace(scope),id),fileUrl:artifactFileUrl});
 let cacheEvents=Promise.resolve();native.on('notification',m=>{cacheEvents=cacheEvents.then(()=>nativeCache.observe(m)).catch(()=>{});});
 const pageSessions=new PageSessions({onWireEvent:entry=>connectionLog.event(entry),onExpire:cleanupClient,shouldRetain:ws=>boundary.active.has(ws.presentedThreadId)||boundary.threads.get(ws.presentedThreadId)?.status?.type==='active'});
 const ensureScopedDirectory=(scope,value)=>files.directory(scope,value);
 async function config(scope,origin){if(!configCache||Date.now()-configAt>60000){if(!configLoading)configLoading=(async()=>{const r=await fetch(upstream+'/codex-web-config.js');if(!r.ok)throw fail(503,'官方界面尚未就绪');const context={window:{},location:{origin}};vm.runInNewContext(await r.text(),context,{timeout:1000});configCache=context.window.__CODEX_WEB_CONFIG__;configAt=Date.now();})().finally(()=>{configLoading=null});await configLoading;}
  const s=await state(scope),c=boundary.bootstrap(scope,{...configCache,gatewayBaseUrl:origin,gatewayWsUrl:origin.replace(/^http/,'ws')+'/ws'},s.globals),settings=await boundary.config();
  const mode={'danger-full-access':'full-access','read-only':'read-only','workspace-write':'auto'}[settings.sandbox_mode];
  c.initialSidebarBootstrap.catalogEntries=nativeCache.changes(0,100,scope,'catalog').records.filter(r=>!r.deleted).map(r=>r.payload);
  c.persistedAtomSnapshot={...c.persistedAtomSnapshot,...s.atoms,'home-composer-mode-v1':'work',...(mode?{'agent-mode-by-host-id':{local:mode},'config-derived-agent-mode-by-host-id':{local:mode}}:{})};c.initialSidebarBootstrap.globalStateEntries=c.initialSidebarBootstrap.globalStateEntries.map(x=>({key:x.key,value:PROJECT_STATE_KEYS.has(x.key)||x.key==='pending_worktrees'&&!Array.isArray(s.globals[x.key])?x.value:Object.hasOwn(s.globals,x.key)?s.globals[x.key]:x.value}));
  let cachedDefaults=bootstrapDefaults.get(scope);if(!cachedDefaults||Date.now()-cachedDefaults.at>60000){const methods=['config/read','model/list','account/read','getAuthStatus','configRequirements/read','modelProvider/capabilities/read','remoteControl/status/read','collaborationMode/list','permissionProfile/list','experimentalFeature/list'];const results=await Promise.allSettled(methods.map(method=>boundary.call(scope,{method,params:method==='permissionProfile/list'?{cwd:workspace(scope).root}:{} })));cachedDefaults={at:Date.now(),values:Object.fromEntries(results.flatMap((r,i)=>r.status==='fulfilled'?[[methods[i],r.value]]:[]))};bootstrapDefaults.set(scope,cachedDefaults);}
  const version=nativeVersion(native.initialization),readOnly=cacheableBootstrap(c,{initialization:{type:'codex-app-server-initialized',hostId:'local',appServerVersion:version,installedCodexVersion:version,isSnapshot:true},defaults:cachedDefaults.values,settings:{followUpQueueMode:'steer',...s.settings}});
  nativeCache.put(scope,'bootstrap','bootstrap','',{config:readOnly});return {...c,dshReadDefaults:readOnly.dshReadDefaults,dshNativeInitialization:readOnly.dshNativeInitialization,dshSettings:readOnly.dshSettings};}
 function send(ws,m){if(ws.resumeId)return pageSessions.send(ws,m);if(ws.readyState!==1)return false;if(ws.bufferedAmount>32*1024*1024){ws.close(1013,'请重新连接并核对快照');return false;}ws.send(JSON.stringify(m));return true;}
 function emit(ws,payload){return send(ws,{channel:CHANNEL,payload,dshEpoch:epoch,dshSeq:sequence[ws.scope]});}
 function rpcResponse(ws,request,value,error){const context=rpcDiagnosticContext({id:request?.id,method:request?.method,params:request?.params,scope:ws?.scope,connectionId:ws?.connectionId,pageId:ws?.diagnosticPageId});connectionLog.event({component:'front',stage:error?'failed':'received',...context,...(error?errorDiagnosticFields(error):{})});if(error){const reasons=[['运行工作区','runtime_workspace'],['权限配置','permission_profile'],['沙箱策略','sandbox_policy'],['执行策略','approval_policy'],['不允许覆写','config_override'],['模型提供方','model_provider']];trace(ws.scope,'rejected',reasons.find(([text])=>error.message?.includes(text))?.[1]||'other');}emit(ws,{type:'mcp-response',hostId:'local',message:{id:request.id,...(error?{error:errorShape(error)}:{result:value})}});}
 function notifyClientStatus(ws,payload){
  // Peers may expose partial services or disappear while a socket is closing.
  // Catch synchronous lookup/call errors as well as rejected remote calls.
  Promise.resolve().then(()=>ws.viewServices?.clientCoordination?.clientStatusChanged?.(payload)).catch(()=>{});
 }
 function emitInitialization(ws,{isSnapshot=true}={}){notifyClientStatus(ws,{sourceClientId:ws.pageId,params:{clientId:ws.pageId,clientType:'electron',isSelf:true,status:'connected'}});const version=nativeVersion(native.initialization);emit(ws,{type:'codex-app-server-initialized',hostId:'local',appServerVersion:version,installedCodexVersion:version,isSnapshot});emit(ws,{type:'codex-app-server-connection-changed',hostId:'local',state:native.state==='ready'?'connected':'disconnected',transport:'websocket',isSnapshot,dshNativeGeneration:native.generation});}
 async function syncClient(ws,{recover=false}={}){
  // Retained pages share a catch-up read across socket replacement. Readiness
  // belongs to this handshaken wire and the current Native connection, so an
  // older snapshot must not withhold it from the replacement connection.
  if(ws.syncing){ws.recoverNext||=recover;emitInitialization(ws);return ws.syncing;}
  ws.recoverNext=false;let snapshotGeneration=native.generation;
  const current=()=>native.generation===snapshotGeneration&&native.state==='ready';
  const pending=(async()=>{
   await native.start();snapshotGeneration=native.generation;emitInitialization(ws);
   const snapshot=await boundary.snapshot(ws.scope);
   // Native may have disconnected/restarted while this read was pending.
   // Its delayed result cannot overwrite current connection or thread state.
   if(!current()||ws.expired)return;
   send(ws,{type:'dsh:sync-state',epoch,seq:sequence[ws.scope],...snapshot});
   for(const t of snapshot.threads)emit(ws,{type:'mcp-notification',hostId:'local',method:'thread/status/changed',params:{threadId:t.id,status:t.status}});
   for(const request of snapshot.approvals)if(boundary.approvals.get(String(request.id))===request)emit(ws,{type:'mcp-request',hostId:'local',request});
   if(recover||ws.recoverNext)emit(ws,{type:'codex-app-server-connection-changed',hostId:'local',state:'connected',transport:'websocket',isSnapshot:false});
  })().catch(error=>{if(native.generation===snapshotGeneration)throw error;}).finally(()=>{
   if(ws.syncing!==pending)return;
   ws.syncing=null;
   // The ready event may have joined the obsolete read. Replace that read
   // once, after settlement, without parallel snapshots or a retry loop.
   if(native.generation!==snapshotGeneration&&native.state==='ready'&&ws.readyState===1&&!ws.expired)syncClient(ws,{recover:true}).catch(()=>{});
  });ws.syncing=pending;return pending;
 }
 async function invoke(scope,request,client){const channel=request.channel,args=Array.isArray(request.args)?request.args:('payload'in request?[request.payload]:[]),p=args[0]||{};
  trace(scope,'channel',channel);trace(scope,'message',p.type);if(p.type==='mcp-request'){trace(scope,'native',p.request?.method);if(['thread/start','thread/resume','turn/start'].includes(p.request?.method)){for(const key of Object.keys(p.request.params||{}))trace(scope,'native-field',key);for(const key of Object.keys(p.request.params?.config||{}))trace(scope,'native-config',key);}}if(p.type==='fetch')trace(scope,'fetch',String(p.url||'').replace(/^vscode:\/\/codex\//,''));
  if(channel==='codex_desktop:message-from-view'&&(p.type==='mcp-request'||p.type==='thread-prewarm-start')){
   if(p.type==='thread-prewarm-start'){rpcResponse(client,p.request,null,fail(409,'会话将在首次发送时创建'));return null;}
   const threadId=p.request?.params?.threadId;if(typeof threadId==='string'){client.readThreads??=new Map();client.readThreads.set(threadId,Date.now()+120000);while(client.readThreads.size>64)client.readThreads.delete(client.readThreads.keys().next().value);}
   if(p.type==='thread-prewarm-start'){for(const key of Object.keys(p.request?.params?.config||{}))trace(scope,'native-config',key);}
   if(p.hostId&&p.hostId!=='local')throw fail(403,'远程宿主不属于当前工作区');
   // 保持官方“IPC ACK + 异步 mcp-response”的协议，浏览器断开不取消已接受执行。
   const rpcContext=rpcDiagnosticContext({id:p.request?.id,method:p.request?.method,params:p.request?.params,scope,connectionId:client.connectionId,pageId:client.diagnosticPageId});connectionLog.event({component:'front',stage:'dispatch',...rpcContext});
   const operation=['fs/createDirectory','fs/writeFile','fs/remove'].includes(p.request?.method)?files.nativeAttachmentRequest(scope,p.request.method,p.request.params||{}):boundary.call(scope,p.request,{clientId:client.stableId,pageId:client.diagnosticPageId,connectionId:client.connectionId});
   operation.then(v=>rpcResponse(client,p.request,v),e=>rpcResponse(client,p.request,null,e));return null;
  }
  if(channel==='codex_desktop:message-from-view'&&p.type==='mcp-response'){await boundary.answer(scope,p.message||p.response||p);return null;}
  // These host descriptors do not depend on the renderer bootstrap, model
  // list, account reads, or the native history cache. In particular codex-home
  // is used by the official send precheck even for an ordinary workspace.
  const hostMethod=p.type==='fetch'?String(p.url||'').replace(/^vscode:\/\/codex\//,''):null;
  if(channel==='codex_desktop:message-from-view'&&['codex-home','home-directory','locale-info','worktree-shell-environment-config'].includes(hostMethod)){
   const started=performance.now(),context=rpcDiagnosticContext({id:p.requestId,method:hostMethod,scope,connectionId:client.connectionId,pageId:client.diagnosticPageId});
   connectionLog.event({component:'front',stage:'dispatch',...context});
   try{
    const input=typeof p.body==='string'?JSON.parse(p.body):p.body||{},params=input.params||input;
    if(params.hostId&&params.hostId!=='local')throw fail(403,'宿主不属于当前工作区');
    const value=hostMethod==='codex-home'?{codexHome:runtimeProfile.codexHome}:hostMethod==='home-directory'?{homeDirectory:workspace(scope).root}:hostMethod==='locale-info'?{ideLocale:'zh-CN',systemLocale:'zh-CN'}:{shellEnvironment:null};
    emit(client,{type:'fetch-response',requestId:p.requestId,responseType:'success',status:200,headers:{'content-type':'application/json'},bodyJsonString:JSON.stringify(value)});
    connectionLog.event({component:'front',stage:'received',...context,durationMs:Math.round(performance.now()-started)});
   }catch(error){
    connectionLog.event({component:'front',stage:'failed',...context,durationMs:Math.round(performance.now()-started),...errorDiagnosticFields(error)});
    emit(client,{type:'fetch-response',requestId:p.requestId,responseType:'error',status:statusOf(error),error:error.code?error.message:'宿主信息读取失败'});
   }
   return null;
  }
  // Only bootstrap consumers need its Native reads and replica write. In
  // particular notifications, Git inspection and settings writes must not
  // rebuild the full sidebar before their own operation can run.
  const s=await state(scope);
  if(channel==='open-file'){const target=await files.resolve(scope,p.path||p.filePath);return {url:await fileUrl(scope,target)};}
  if(channel==='pick-files')return files.upload(scope,(p.params||p).files||[]);
  if(channel==='codex_desktop:get-initial-sidebar-bootstrap')return (await config(scope,client.origin)).initialSidebarBootstrap;
  if(channel==='codex_desktop:get-shared-object-snapshot')return (await config(scope,client.origin)).sharedObjectSnapshot;
  if(channel==='codex_desktop:get-build-flavor')return 'prod';
  if(channel==='codex_desktop:get-system-theme-variant')return 'light';
  if(channel==='codex_desktop:get-sentry-init-options')return null;
  if(channel==='codex_desktop:worker:git:from-view'){trace(scope,'git',p.request?.method);await git.invoke(client,p);return null;}
  if(channel!=='codex_desktop:message-from-view')throw fail(403,'文件、终端及此桌面能力暂未开放');
  if(p.type==='archive-thread'||p.type==='unarchive-thread'){if(p.hostId&&p.hostId!=='local')throw fail(403,'宿主不属于当前工作区');// pendingThreadArchives emits this notification before the canonical RPC.
   // Executing it here archives twice and turns a successful action into an error.
   await boundary.checked(workspace(scope),p.conversationId);return null;}
  if(p.type==='mcp-response'){await boundary.answer(scope,p.message||p.response||p);return null;}
  if(p.type==='persisted-atom-sync-request'){const c=await config(scope,client.origin);emit(client,{type:'persisted-atom-sync',state:c.persistedAtomSnapshot});return null;}
  if(p.type==='persisted-atom-update'){
   const key=p.key;if(typeof key!=='string'||key.length>256||['__proto__','constructor','prototype'].includes(key))throw fail(400,'无效状态键');
   let value=p.deleted?undefined:p.value;
   if(p.recordUpdate){const update=p.recordUpdate,old=s.atoms[key]??s.atoms[update.legacyStorageKey];value={...(old&&typeof old==='object'&&!Array.isArray(old)?old:{})};for(const[k,v]of Object.entries(update.entries||{})){delete value[k];if(v!=null)Object.defineProperty(value,k,{value:v.value,writable:true,enumerable:true,configurable:true});}if(Number.isSafeInteger(update.maxEntries)&&update.maxEntries>=0)for(const k of Object.keys(value).slice(0,Math.max(0,Object.keys(value).length-update.maxEntries)))delete value[k];}
   // Keep the original persistence/ACK boundary, including retry after a disk
   // error. Equal record JSON includes property order (the renderer's LRU).
   const unchanged=Object.hasOwn(s.atoms,key)===(value!==undefined)&&(value===undefined||JSON.stringify(s.atoms[key])===JSON.stringify(value)),failureKey=JSON.stringify([scope,key]);
   if(value===undefined)delete s.atoms[key];else Object.defineProperty(s.atoms,key,{value,writable:true,enumerable:true,configurable:true});
   const alreadyPending=(pendingAtomWrites.get(failureKey)||0)>0;pendingAtomWrites.set(failureKey,(pendingAtomWrites.get(failureKey)||0)+1);
   try{await persist(scope);}catch(error){failedAtomBroadcasts.add(failureKey);throw error;}finally{const remaining=pendingAtomWrites.get(failureKey)-1;if(remaining)pendingAtomWrites.set(failureKey,remaining);else pendingAtomWrites.delete(failureKey);}
   // A failed earlier write updated memory but never notified peers. Its
   // successful same-value retry must still publish the original full value.
   const retryAfterFailure=failedAtomBroadcasts.delete(failureKey);
   if(unchanged&&!retryAfterFailure&&!alreadyPending)return null;
   for(const ws of clients)if(ws.scope===scope&&ws.pageId)emit(ws,{type:'persisted-atom-updated',key,value:value??null,deleted:value===undefined});return null;
  }
  if(p.type==='shared-object-subscribe'){const c=await config(scope,client.origin);emit(client,{type:'shared-object-updated',key:p.key||p.objectId,value:c.sharedObjectSnapshot[p.key||p.objectId]});return null;}
  if(p.type==='fetch'){
   const started=performance.now(),context=rpcDiagnosticContext({id:p.requestId,method:hostMethod,scope,connectionId:client.connectionId,pageId:client.diagnosticPageId});
   connectionLog.event({component:'front',stage:'dispatch',...context});
   try{
   const method=String(p.url||'').replace(/^vscode:\/\/codex\//,'');let input={};try{input=typeof p.body==='string'?JSON.parse(p.body):p.body||{};}catch{}const a=input.params||input;let value;
   if(method==='app-server-connection-state'){if(a.hostId&&a.hostId!=='local')throw fail(403,'宿主不属于当前工作区');value={state:native.state==='ready'?'connected':'disconnected',progress:null,error:null};}
   else if(method==='read-file'){const r=await files.read(scope,{...a,representation:'text'});value={contents:r.text};}
   else if(method==='read-file-binary'){if(a.hostId&&a.hostId!=='local')throw fail(403,'宿主不属于当前工作区');const r=await files.bytes(scope,a.path);value={contentsBase64:r.bytes.toString('base64'),mimeType:r.mime};}
   else if(method==='read-file-metadata')value=await files.metadata(scope,a);
   else if(method==='workspace-directory-entries')value=await files.entries(scope,a);
   else if(method==='get-global-state')value={value:readWorkspaceGlobalState(workspace(scope),s.globals,a.key)};
   else if(method==='set-global-state'){if(a.key==='queued-follow-ups')throw fail(409,'队列已改为 Mac 后台执行，请刷新此旧页面后重试');if(typeof a.key!=='string'||a.key.length>256||['__proto__','constructor','prototype'].includes(a.key))throw fail(400,'无效状态键');s.globals[a.key]=PROJECT_STATE_KEYS.has(a.key)?workspaceProjects(workspace(scope),{...s.globals,[a.key]:a.value}).globals[a.key]:a.value;await persist(scope);value={success:true};}
   else if(method==='get-configuration'){value=await boundary.call(scope,{method:'config/read',params:{}});}
   else if(method==='get-settings')value={values:await settings.values(scope),configuredValues:s.settings};
   else if(method==='get-setting')value={value:(await settings.read(scope,a.key)).effective};
   else if(method==='set-setting'){await settings.write(scope,a.key,a.value);value={success:true};}
   else if(method==='queued-follow-up-send-lock-acquire'||method==='queued-follow-up-send-lock-release'){
    await boundary.checked(workspace(scope),a.conversationId);
    value=method.endsWith('-acquire')?{acquired:false}:queuedSendLocks.release(scope,a,client.stableId);
   }
   else if(method==='paths-exist'){const existingPaths=[];for(const p of Array.isArray(a.paths)?a.paths:[])if(await belongs(p,workspace(scope)))existingPaths.push(p);value={existingPaths};}
   else if(method==='git-origins')value={origins:{}};
   else if(method==='ide-context')value=null;
   else if(['account-info','os-info','codex-command-keymap-state'].includes(method))value=await desktopMetadata.read(method);
   else if(method==='workspace-root-options')value=(await config(scope,client.origin)).initialSidebarBootstrap.workspaceRootOptions;
   else if(method==='list-pinned-threads'){const threadIds=[],seen=new Set();let cursor;for(let page=0;page<64;page++){const r=await boundary.call(scope,{method:'thread/list',params:{sectionId:'01984de2-8f74-7c91-a3b2-5c5e937cf318',sortKey:'section_position',sortDirection:'asc',cursor}});threadIds.push(...(r.data||[]).map(t=>t.id));cursor=r.nextCursor;if(!cursor)break;if(seen.has(cursor))throw fail(503,'置顶分页异常');seen.add(cursor);}value={threadIds,serverOrderedThreadIds:threadIds};}
   else if(method==='set-thread-pinned'||method==='set-pinned-threads-order'){
    if(a.hostId&&a.hostId!=='local')throw fail(403,'宿主不属于当前工作区');
    const moved=a.threadId||a.movedThreadId;if(!moved)throw fail(400,'请选择需要移动的会话');
    await boundary.call(scope,{id:p.requestId,method:'thread/section/move',params:{threadId:moved,sectionId:method==='set-thread-pinned'&&!a.pinned?null:'01984de2-8f74-7c91-a3b2-5c5e937cf318',beforeThreadId:a.beforeThreadId??null}},{clientId:client.stableId});value={success:true};for(const ws of clients)if(ws.scope===scope&&ws.pageId)emit(ws,{type:'pinned-threads-updated'});
   }
   else if(method==='list-automations')value={items:[]};
   else if(method==='inbox-items')value={items:[],unreadRunCounts:{total:0,unreadRuns:[]}};
   else if(method==='is-copilot-api-available')value={available:false};
   else if(method==='get-copilot-api-proxy-info')value=null;
   else if(method==='mcp-codex-config'){if(a.cwd&&!await belongs(a.cwd,workspace(scope)))throw fail(403,'工作目录超出当前工作区');value={config:{}};}
   else if(method==='developer-instructions'){if(a.cwd&&!await belongs(a.cwd,workspace(scope)))throw fail(403,'工作目录超出当前工作区');value={instructions:typeof a.baseInstructions==='string'?a.baseInstructions:''};}
   else if(method==='ensure-directory')value=await ensureScopedDirectory(scope,a.path);
   else if(['set-remote-control-connections-enabled','set-remote-wsl-connections-enabled'].includes(method))value={enabled:false};
   else throw fail(403,'此桌面请求尚未开放');
   connectionLog.event({component:'front',stage:'received',...context,durationMs:Math.round(performance.now()-started)});
   emit(client,{type:'fetch-response',requestId:p.requestId,responseType:'success',status:200,headers:{'content-type':'application/json'},bodyJsonString:JSON.stringify(value)});
   }catch(e){connectionLog.event({component:'front',stage:'failed',...context,durationMs:Math.round(performance.now()-started),...errorDiagnosticFields(e)});emit(client,{type:'fetch-response',requestId:p.requestId,responseType:'error',status:statusOf(e),error:e.code?e.message:'官方请求暂不可用'});}
   return null;
  }
  if(p.type==='ready'||p.type==='view-ready'){emitInitialization(client);return null;}
  if(['log-message','electron-window-focus-changed','analytics-event','view-ready','set-title','window-focused','ipc-broadcast','cancel-fetch','shared-object-unsubscribe','app-shell-shortcut-state-changed','browser-sidebar-annotation-multi-select-enabled-changed','browser-sidebar-site-annotation-api-enabled-changed','browser-sidebar-owner-sync','electron-window-zoom-changed','electron-window-focus-request','mac-menu-bar-enabled-changed','global-dictation-enabled-changed','codex-runtimes-config-changed','electron-avatar-overlay-restore-ready','electron-avatar-overlay-feedback-diagnostics-changed','local-thread-activity-changed','set-telemetry-user','electron-set-badge-count','tray-menu-threads-changed','power-save-blocker-set','avatar-overlay-open-state-request','browser-sidebar-tweaks-enabled-changed','electron-set-window-mode','view-focused','remote-hosted-pip-active-thread-changed','keyboard-layout-map-changed','workspace-settings-webview-presentation-changed','ready'].includes(p.type))return null;
  if(p.type==='shared-object-set')return null;
  throw fail(403,'此官方消息类型尚未适配');
 }
 async function fileUrl(scope,target,download=false){const version=(await files.version(scope,target)).etag;let grant;for(const [id,entry] of fileGrants)if(entry.scope===scope&&entry.target===target&&entry.download===download&&entry.version===version&&entry.expiresAt>Date.now()+60000){grant=id;break;}if(!grant){grant=randomBytes(24).toString('base64url');fileGrants.set(grant,{scope,target,download,version,expiresAt:Date.now()+10*60*1000});while(fileGrants.size>512)fileGrants.delete(fileGrants.keys().next().value);}return '/w/'+scope+'/api/local-file/'+grant+'/'+encodeURIComponent(path.basename(target));}
 async function artifactFileUrl(scope,object){let grant;for(const[id,entry]of fileGrants)if(entry.scope===scope&&entry.artifact&&entry.target===object.internalPath&&entry.version===object.version&&entry.expiresAt>Date.now()+60000){grant=id;break;}
  if(!grant){grant=randomBytes(24).toString('base64url');fileGrants.set(grant,{scope,target:object.internalPath,version:object.version,immutableVersion:object.version,mime:object.mime,name:object.name,artifact:true,expiresAt:Date.now()+10*60*1000});while(fileGrants.size>512)fileGrants.delete(fileGrants.keys().next().value);}
  return '/w/'+scope+'/api/local-file/'+grant+'/'+encodeURIComponent(object.name);
 }
 async function serveGrantedFile(scope,grant,req,res){const entry=fileGrants.get(grant);if(!entry||entry.scope!==scope||entry.expiresAt<Date.now())throw fail(404,'文件链接已失效，请重新打开文件');return serveFileResponse({files:entry.artifact?{resolve:async()=>deliverables.resolve(scope,entry)}:files,scope,entry,req,res});}

 const browserActions=new Map();
 function browserAction(client,action,payload){const requestId=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{browserActions.delete(requestId);reject(fail(408,'页面未确认操作'));},10000);browserActions.set(requestId,{client,resolve,reject,timer});if(!send(client,{type:'dsh:browser-action',requestId,action,payload})){clearTimeout(timer);browserActions.delete(requestId);reject(fail(409,'页面已断开'));}});}
 const makeAppHost=createAppHostFactory({RpcTarget,boundary,state,persist,files,native,clients,send,browserAction,fileUrl,settings,titleDiagnostic:entry=>trace(entry.scope,'title-generation',entry.status)});
 function appHost(ws,portId){if(ws.ports.has(portId))return ws.ports.get(portId);if(ws.ports.size>=8)throw fail(429,'连接过多');let queue=[],waiters=[],closed=false,queuedBytes=0;
  const transport={send:async raw=>{if(!send(ws,{type:'app-host-port-message',portId,...codec.encodeMessageData(JSON.parse(raw))}))throw Error('page disconnected');},receive:()=>closed?Promise.reject(Error('page disconnected')):queue.length?Promise.resolve(takeQueued()):new Promise((resolve,reject)=>waiters.push({resolve,reject})),abort:()=>close()};
  function takeQueued(){const value=queue.shift();queuedBytes-=Buffer.byteLength(value);return value;}
  function close(){closed=true;queuedBytes=0;for(const w of waiters)w.reject(Error('page disconnected'));waiters=[];queue=[];}
  const portEvent=(stage,extra={})=>connectionLog.event({component:'app-host',stage,scope:ws.scope,connectionId:ws.connectionId,pageId:ws.diagnosticPageId,rpcIdHash:hashDiagnosticId(portId),...extra});
  const portError=error=>{const result=appHostError(error);portEvent('failed',{reason:'rpc_error',...result.fields});return result.error;};
  portEvent('attempt');const session=new RpcSession(transport,makeAppHost(ws.scope,ws),{onSendError:portError});session.getRemoteMain().services.then(services=>{if(closed)return;ws.viewServices=services;portEvent('hello');}).catch(portError);const entry={session,close,receive(data){const raw=JSON.stringify(data);if(Buffer.byteLength(raw)>29*1024*1024||queuedBytes+Buffer.byteLength(raw)>32*1024*1024||queue.length>128)throw fail(429,'app-host队列超限');if(waiters.length)waiters.shift().resolve(raw);else{queue.push(raw);queuedBytes+=Buffer.byteLength(raw);}}};ws.ports.set(portId,entry);send(ws,{type:'app-host-port-connected',portId});return entry;
 }
 const boundPort=()=>server.address()?.port??port;
 const allowedOrigins=()=>[runtimeProfile.origin,`http://127.0.0.1:${boundPort()}`,`http://localhost:${boundPort()}`,...(publicOrigin?[publicOrigin]:[])];
 const server=http.createServer(async(req,res)=>{try{
  const host=req.headers.host||'',origin=allowedOrigins().find(value=>new URL(value).host===host);if(!origin)throw fail(403,'Host不受信任');
  if(req.method==='GET'&&req.url==='/'){res.writeHead(303,{location:'/?workspace=ai','cache-control':'no-store'});return res.end();}
  const safeNavigation=isWorkspaceNavigation(req);
  if(!safeNavigation&&(req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site')){navigationDenial(req,'front');throw fail(403,'跨站请求被拒绝');}
  const u=new URL(req.url,origin),route=u.pathname;res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','same-origin');
  if(route.startsWith('/__phone-code/')){if(!phoneCodes)throw fail(404,'phone_code_unavailable');return await phoneCodes.local(req,res,route.slice('/__phone-code/'.length));}
  if(['GET','HEAD'].includes(req.method)&&shell.serve(req,res,route))return;
  if(req.method==='GET'&&(route==='/conversations'||route==='/'&&u.searchParams.get('view')!=='chat'&&u.searchParams.get('nativeList')!=='1')){const ws=workspace(u.searchParams.get('workspace')||'ai');res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-dsh-cacheable-shell':'1','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});return res.end(shell.home(ws.id));}
  if(req.method==='GET'&&/^(?:\/official\/?|\/workspaces\/(?:ai|zyy)\/?)$/.test(route)){const ws=workspace(route.match(/^\/workspaces\/(ai|zyy)/)?.[1]||u.searchParams.get('workspace')||'ai');res.writeHead(303,{location:'/?workspace='+ws.id,'cache-control':'no-store'});return res.end();}
  if(/^\/official-patched-v\d+\/assets\//.test(route)){if(!localReleaseLoading)localReleaseLoading=nativeUIRelease(upstream).catch(e=>{localReleaseLoading=null;throw e;});const frozen=(await localReleaseLoading).files.get(route);if(frozen!=null)return textResponses.send(req,res,frozen,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-dsh-edge-cache':'static'});}
  if(route==='/dsh-native-release.json'||route.startsWith('/dsh-native-assets/')){if(route==='/dsh-native-release.json'){if(!releaseRefresh)releaseRefresh=nativeUIRelease(upstream).then(release=>{localReleaseLoading=Promise.resolve(release);localReleases.set(release.manifest.version,release);while(localReleases.size>3)localReleases.delete(localReleases.keys().next().value);return release;}).finally(()=>{releaseRefresh=null;});return json(res,200,(await releaseRefresh).manifest);}if(!localReleaseLoading)localReleaseLoading=nativeUIRelease(upstream).catch(e=>{localReleaseLoading=null;throw e;});const release=localReleases.get(route.split('/')[2])||await localReleaseLoading;const value=release.files.get(route);if(value==null)throw fail(404,'此界面版本不可用');return textResponses.send(req,res,value,{'content-type':route.endsWith('.html')?'text/html; charset=utf-8':route.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-dsh-edge-cache':'static',...(route.endsWith('/shell.html')?{'x-dsh-credential-free-shell':'1'}:{})});}
  if(req.method==='GET'&&(route==='/'||/^\/local\/[0-9a-f-]{36}$/i.test(route))){workspace(u.searchParams.get('workspace')||'ai');if(!localReleaseLoading)localReleaseLoading=nativeUIRelease(upstream).catch(e=>{localReleaseLoading=null;throw e;});const release=await localReleaseLoading;res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-dsh-credential-free-shell':'1'});return res.end(release.files.get(release.manifest.shell));}
  if(route==='/opencodex-runtime-bootstrap.js'){if(!runtimeAssets){const r=await fetch(upstream+route);if(!r.ok)throw fail(503,'官方浏览器适配尚未就绪');runtimeAssets=scopeRuntimeAssets(await r.text());}return await textResponses.send(req,res,runtimeAssets,{'content-type':'text/javascript','cache-control':'private, no-cache'},{adapter:true});}
  const projectFiles={'/projects':['projects.html','text/html'],'/projects.js':[portableConfig?'portable-projects.js':'projects.js','text/javascript'],'/projects.css':['projects.css','text/css']};
  if(projectFiles[route]&&req.method==='GET'){if(route==='/projects')workspace(u.searchParams.get('workspace')||'ai');const [name,type]=projectFiles[route];res.writeHead(200,{'content-type':type+'; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});return res.end(await readFile(new URL('../public/'+name,import.meta.url)));}
  if(route==='/readyz'){
   if(req.method!=='GET')return json(res,405,{ready:false});
   const controller=new AbortController(),cancel=()=>controller.abort();req.once('aborted',cancel);res.once('close',cancel);
   try{const ready=await officialReady({native,upstream,signal:controller.signal,portable:!!portableConfig});if(!res.destroyed)json(res,ready?200:503,{ready});}
   finally{req.off('aborted',cancel);res.off('close',cancel);}return;
  }
  if(route==='/healthz')return json(res,200,{status:'ok',service:'official-codex-front',version:'1.0.0',epoch,...await boundary.hostActivity(),nativeState:native.state,officialUpstream:upstream});
  const pluginAsset=pluginUiRoute(route);if(pluginAsset&&['GET','HEAD'].includes(req.method)){try{const file=await readPluginUi(path.join(PRIVATE,'plugin-ui'),pluginAsset);res.writeHead(200,{'content-type':file.type,'cache-control':file.cache});return res.end(req.method==='HEAD'?undefined:file.body);}catch{return json(res,404,{error:'插件界面版本尚不可用'});}}
  if(route==='/dsh-scope-session'&&req.method==='GET'){
   const ws=workspace(u.searchParams.get('workspace')),value=req.headers['x-dsh-diagnostic-trace'],started=performance.now();
   const context={component:'front',scope:ws.id,routeClass:'scope_session',method:'GET',reason:'scope_renewal',...typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value)?{traceId:value}:{}};
   connectionLog.event({...context,stage:'received'});
   res.once('finish',()=>connectionLog.event({...context,stage:'committed',statusCode:res.statusCode,durationMs:Math.round(performance.now()-started)}));
   res.once('close',()=>{if(!res.writableFinished)connectionLog.event({...context,stage:'failed',reason:'write_failed',statusCode:res.statusCode,durationMs:Math.round(performance.now()-started)});});
   return json(res,200,{id:ws.id,token:token(ws),...(portableConfig?{portable:true,label:ws.label,workspaces:Object.values(portableConfig.workspaces).map(({id,label})=>({id,label}))}:{})});
  }
  if(route==='/ui/official'&&req.method==='GET'){const ws=workspace(u.searchParams.get('workspace')||'ai');res.writeHead(303,{location:'/?workspace='+ws.id,'cache-control':'no-store'});return res.end();}
  if(route==='/workbench'&&req.method==='GET'){const ws=workspace(u.searchParams.get('workspace')||'ai');res.writeHead(303,{location:portableConfig?'/?workspace='+ws.id:runtimeProfile.origin+'/workbench?workspace='+ws.id,'cache-control':'no-store'});return res.end();}
  if(portableConfig&&route==='/portable-icon.svg'){res.writeHead(200,{'content-type':'image/svg+xml','cache-control':'public, max-age=86400'});return res.end(await readFile(new URL('../public/portable-icon.svg',import.meta.url)));}
  if(route==='/manifest.webmanifest'){
   const ws=workspace(u.searchParams.get('workspace')||'ai');res.writeHead(200,{'content-type':'application/manifest+json; charset=utf-8','cache-control':'no-cache'});return res.end(JSON.stringify({id:'/workspaces/'+ws.id,name:'Codex · '+ws.label,short_name:'Codex '+ws.label,lang:'zh-CN',description:'原生 Codex 聊天与私人工作台',start_url:'/?workspace='+ws.id+'&view=chat&nativeList=1&pwa='+ws.id+'&launch=1',scope:'/',display:'standalone',display_override:['standalone','minimal-ui'],background_color:'#ffffff',theme_color:'#ffffff',orientation:'any',prefer_related_applications:false,launch_handler:{client_mode:'navigate-existing'},icons:portableConfig?[{src:'/portable-icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}]:[{src:'/assets/pwa-icon-192.png',sizes:'192x192',type:'image/png'},{src:'/assets/pwa-icon-512.png',sizes:'512x512',type:'image/png'}],shortcuts:[{name:'新对话',url:'/ui/official?workspace='+ws.id},{name:'工作台',url:'/workbench?workspace='+ws.id}]}));
  }
  const pwaFiles={'/dsh-pwa.js':['official-pwa.js','text/javascript'],'/dsh-pwa.css':['official-pwa.css','text/css'],'/dsh-offline.html':['official-offline.html','text/html']};
  if(pwaFiles[route]){const[file,type]=pwaFiles[route];res.writeHead(200,{'content-type':type+'; charset=utf-8','cache-control':'no-cache'});return res.end(await readFile(new URL('../public/'+file,import.meta.url)));}
  if(route==='/dsh-scope-bootstrap.js'){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});const scripts=await Promise.all(scopeSources.map(name=>readFile(new URL('../public/'+name,import.meta.url),'utf8')));return res.end(scripts.join('\n'));}
  if(route==='/codex-web-config.js'){const scope=u.searchParams.get('workspace'),ws=authorized(req,scope,u);const c=await config(ws.id,origin);c.gatewayWsUrl+='?scopeToken='+encodeURIComponent(u.searchParams.get('scopeToken'));return await textResponses.send(req,res,'window.__CODEX_WEB_CONFIG__='+JSON.stringify(c)+';',{'content-type':'text/javascript','cache-control':'no-store'});}
  const scoped=route.match(/^\/w\/(ai|zyy)(\/.*)$/);
  if(scoped){const scope=scoped[1],endpoint=scoped[2],grantMatch=endpoint.match(/^\/api\/local-file\/([A-Za-z0-9_-]{32})\/[^/]+$/);if(grantMatch&&['GET','HEAD'].includes(req.method))return await serveGrantedFile(scope,grantMatch[1],req,res);const ws=authorized(req,scope,u);
   if(endpoint.startsWith('/api/phone-code/')){if(!phoneCodes||scope!=='ai')throw fail(403,'phone_code_scope_denied');return await phoneCodes.phone(req,res,endpoint.slice('/api/phone-code/'.length));}
   if(req.method==='GET'&&(endpoint==='/api/projects'||/^\/api\/projects\/[a-z0-9-]+$/.test(endpoint)))return json(res,200,await projectData(scope,endpoint.split('/')[3]));
   if(endpoint==='/api/projects/comfyui-video/material-feedback'&&req.method==='POST'){const b=await body(req);return json(res,200,await projectMaterialFeedback(scope,'comfyui-video',b));}
   if(endpoint==='/api/native-cursors'&&req.method==='GET'){const id=u.searchParams.get('threadId');await boundary.checked(workspace(scope),id);const record=nativeCache.get(scope,'history-cursors:'+id);return json(res,200,{cursors:record&&!record.deleted?record.payload:null});}
   if(endpoint==='/api/native-bootstrap'&&req.method==='GET')return json(res,200,await config(scope,origin));
   if(endpoint==='/api/deliverables/prepare'&&req.method==='POST')return json(res,200,await deliverables.prepare(scope,await body(req)));
   if(endpoint==='/api/native-read'&&req.method==='POST'){const b=await body(req);return json(res,200,await nativeCache.read(scope,b.method,b.params,{fresh:!!b.fresh}));}
   if(endpoint==='/api/attachment-upload'&&req.method==='POST'){
    const requestId=req.headers['x-dsh-upload-id'];if(typeof requestId!=='string'||!/^[a-f0-9-]{36}$/i.test(requestId))throw fail(400,'附件请求身份无效');
    const page=clientById.get(scope+':'+req.headers['x-dsh-page-id']),wire=page?.wire,nativeGeneration=native.generation;
    const current=()=>page&&!page.expired&&clientById.get(scope+':'+page.pageId)===page&&page.wire===wire&&wire?.readyState===1&&page.resumeId===req.headers['x-dsh-page-resume']&&page.stableId===req.headers['x-dsh-client-id']&&page.connectionId===req.headers['x-dsh-connection-id']&&req.headers['x-dsh-front-epoch']===epoch&&String(nativeGeneration)===req.headers['x-dsh-native-generation']&&native.state==='ready'&&native.generation===nativeGeneration;
    if(!current())throw fail(409,'附件上传连接已更换');
    if(req.headers['content-type']!=='application/octet-stream')throw fail(400,'附件数据格式无效');
    let metadata;const header=req.headers['x-dsh-upload-files'];if(typeof header!=='string'||header.length>16384)throw fail(400,'附件清单无效');
    try{metadata=JSON.parse(decodeURIComponent(header));}catch{throw fail(400,'附件清单无效');}
    if(!Array.isArray(metadata)||!metadata.length||metadata.length>20||metadata.some(f=>!f||typeof f.name!=='string'||f.name.length>512||typeof f.type!=='string'||f.type.length>128||!Number.isSafeInteger(f.size)||f.size<0))throw fail(400,'附件清单无效');
    const expected=metadata.reduce((sum,f)=>sum+f.size,0);if(expected>ATTACHMENT_MAX)throw fail(413,'每次附件总量最多 20 MB');
    const started=performance.now(),context={component:'attachment-upload',scope,traceId:requestId,pageId:page.diagnosticPageId,connectionId:page.connectionId,fileCount:metadata.length,bodyBytes:expected};connectionLog.event({...context,stage:'dispatch'});
    res.once('finish',()=>connectionLog.event({...context,stage:'committed',statusCode:res.statusCode,durationMs:Math.round(performance.now()-started)}));
    res.once('close',()=>{if(!res.writableFinished)connectionLog.event({...context,stage:'failed',reason:'write_failed',durationMs:Math.round(performance.now()-started)});});
    const chunks=[];let received=0;for await(const chunk of req){received+=chunk.length;if(received>ATTACHMENT_MAX||received>expected)throw fail(413,'附件数据超出清单');chunks.push(chunk);}
    if(received!==expected)throw fail(400,'附件数据不完整');if(!current())throw fail(409,'附件上传连接已更换');
    connectionLog.event({...context,stage:'received',durationMs:Math.round(performance.now()-started)});
    const result=await files.uploadBytes(scope,metadata,Buffer.concat(chunks,received));
    // Upload stores input bytes only; no Native execution has been submitted.
    // A changed page cannot adopt the old receipt, and it must not auto-retry.
    if(!current())throw fail(409,'附件已保存，但页面连接已更换；消息尚未发送');
    res.setHeader('x-dsh-upload-id',requestId);res.setHeader('x-dsh-front-epoch',epoch);res.setHeader('x-dsh-native-generation',String(nativeGeneration));
    return json(res,200,{requestId,epoch,nativeGeneration,protocol:ATTACHMENT_UPLOAD_PROTOCOL,result});
   }
   if(endpoint==='/api/bulk-read'&&req.method==='GET'){
    // Directory and bounded execution-metadata reads use this response channel. The same boundary
    // and Native connection remain authoritative; no writer or page sequence is
    // created, and no result is also emitted onto the control WebSocket.
    const method=u.searchParams.get('method'),requestId=u.searchParams.get('requestId');
    if(!BULK_READ_METHODS.has(method))throw fail(403,'此读取通道不接受执行请求');
    if(typeof requestId!=='string'||requestId.length<1||requestId.length>160)throw fail(400,'读取请求身份无效');
    let params;try{params=JSON.parse(u.searchParams.get('params')||'{}');}catch{throw fail(400,'读取参数无效');}
    if(!params||typeof params!=='object'||Array.isArray(params))throw fail(400,'读取参数无效');
    if(params.hostId&&params.hostId!=='local')throw fail(403,'远程宿主不属于当前工作区');
    const only=keys=>Object.keys(params).every(key=>keys.includes(key));
    if(method==='thread/read'&&(!only(['threadId','includeTurns'])||params.includeTurns!==false))throw fail(403,'此通道只读取会话元数据');
    if(method==='thread/goal/get'&&(!only(['threadId'])||typeof params.threadId!=='string'||!params.threadId))throw fail(403,'此通道只读取当前会话目标');
    if(method==='thread/turns/list'&&(!only(['threadId','limit','sortDirection','itemsView','cursor'])||params.limit!==1||params.sortDirection!=='desc'||params.itemsView!=='notLoaded'||params.cursor!=null))throw fail(403,'此通道只读取当前轮次身份');
    if(method==='config/read'&&(!only(['cwd','includeLayers'])||params.includeLayers!=null&&typeof params.includeLayers!=='boolean'))throw fail(403,'执行配置读取参数无效');
    if(method==='configRequirements/read'&&!only([]))throw fail(403,'执行约束读取参数无效');
    const page=clientById.get(scope+':'+req.headers['x-dsh-page-id']),wire=page?.wire,nativeGeneration=native.generation,identityGeneration=bulkIdentityGeneration;
    const current=()=>page&&!page.expired&&clientById.get(scope+':'+page.pageId)===page&&page.wire===wire&&wire?.readyState===1&&page.resumeId===req.headers['x-dsh-page-resume']&&page.stableId===req.headers['x-dsh-client-id']&&page.connectionId===req.headers['x-dsh-connection-id']&&req.headers['x-dsh-front-epoch']===epoch&&String(nativeGeneration)===req.headers['x-dsh-native-generation']&&native.state==='ready'&&native.generation===nativeGeneration&&bulkIdentityGeneration===identityGeneration;
    if(!current())throw fail(409,'读取连接已更换，请重新读取');
    let canceled=false;const closed=()=>{if(!res.writableEnded)canceled=true;};res.on('close',closed);
    const started=performance.now(),context=rpcDiagnosticContext({id:requestId,method,params,scope,pageId:page.diagnosticPageId,connectionId:page.connectionId});connectionLog.event({component:'front',stage:'dispatch',...context});
    try{
     let value;try{value=method==='app/list'?await boundary.readAppCatalog(scope,{params,ifNoneMatch:req.headers['if-none-match']||null,fresh:u.searchParams.get('fresh')==='1',diagnostic:context}):{status:200,result:await boundary.call(scope,{id:requestId,method,params},{clientId:page.stableId,pageId:page.diagnosticPageId,connectionId:page.connectionId})};}
     catch(error){value={status:200,error:errorShape(error)};}
     if(canceled)return;
     if(!current())throw fail(409,'读取期间连接已更换，请重新读取');
     const headers={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store, no-transform','x-dsh-front-epoch':epoch,'x-dsh-native-generation':String(nativeGeneration),'x-dsh-read-id':requestId,...(value.etag?{etag:value.etag}:{})};
     connectionLog.event({component:'front',stage:value.error?'failed':'received',...context,statusCode:value.status,durationMs:Math.round(performance.now()-started)});
     if(value.status===304){res.writeHead(304,headers);return res.end();}
     return await textResponses.send(req,res,JSON.stringify({requestId,epoch,nativeGeneration,...value}),headers);
    }finally{res.off('close',closed);}
   }
   if(endpoint==='/api/native-catalog'&&req.method==='GET'){const after=Number(u.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)throw fail(400,'缓存游标无效');nativeCache.catalog(scope,{fresh:u.searchParams.get('refresh')==='1'}).catch(()=>{});return json(res,200,{...nativeCache.changes(after,200,scope,'catalog'),status:nativeCache.get(scope,'catalog-status')});}
   if(endpoint==='/api/native-queue'&&req.method==='GET')return json(res,200,u.searchParams.has('commandId')?nativeQueue.requestStatus(scope,u.searchParams.get('commandId')):await nativeQueue.read(scope,u.searchParams.get('threadId')));
   if(endpoint==='/api/native-command-status'&&req.method==='GET')return json(res,200,await boundary.commandStatus(scope,Object.fromEntries(u.searchParams)));
   if(endpoint==='/api/native-queue'&&req.method==='POST'){const b=await body(req);return json(res,200,await nativeQueue.command(scope,b.request,b.clientId));}
   if(endpoint==='/api/token-usage'&&req.method==='GET'){let threadId=u.searchParams.get('threadId');const turnId=u.searchParams.get('turnId');let usage=null;if(threadId){await boundary.checked(ws,threadId);usage=boundary.usage.get(threadId+':'+turnId)||null;}else{for(const value of boundary.usage.values())if(value.turnId===turnId)try{await boundary.checked(ws,value.threadId);threadId=value.threadId;usage=value;break;}catch{}}return json(res,200,{threadId,turnId,usage,source:'native-notification'});}
   if(endpoint==='/api/opencodex/plugins/config'&&req.method==='GET')return json(res,200,{plugins:[{id:'opencodex.smart-model-router',feature:'smart-model-router',enabled:false,values:{}}]});
   if(endpoint==='/api/opencodex/model-router/injections'&&['GET','POST'].includes(req.method)){if(req.method==='POST'){const p=await body(req);trace(scope,'disabled-router-report',p.point);}return json(res,200,{enabled:false,status:'disabled',runtime:{version:'26.901.51231'},items:['app-server-router','auto-model-catalog','settings-page','composer-adapter','summary-adapter','route-presentation'].map(id=>({id,status:'disabled',reportedAt:0}))});}
   if(endpoint==='/api/opencodex/runtime-compatibility/reports'&&req.method==='POST'){const p=await body(req);for(const r of Array.isArray(p.reports)?p.reports.slice(0,100):[])trace(scope,'compatibility-report',r.point?.id);return json(res,200,{reportEpoch:epoch,received:true,persisted:false});}
   if(endpoint.startsWith('/api/app-fs/@fs/')&&req.method==='GET'){const value=decodeURIComponent(endpoint.slice('/api/app-fs/@fs/'.length)),target=await files.resolve(scope,'/'+value);res.writeHead(303,{'location':await fileUrl(scope,target,u.searchParams.get('download')==='1'),'cache-control':'no-store'});return res.end();}
   if(endpoint==='/api/local-file/view-path'&&req.method==='POST'){const p=await body(req),target=await files.resolve(scope,p.path);return json(res,200,{url:await fileUrl(scope,target,false)});}
   if(endpoint==='/api/local-file/download-path'&&req.method==='POST'){const p=await body(req),target=await files.resolve(scope,p.path);return json(res,200,{url:await fileUrl(scope,target,true)});}
   if(endpoint==='/api/auth/status')return json(res,200,{authenticated:true,passwordRequired:false});
   if(endpoint==='/api/ipc/invoke'&&req.method==='POST'){const b=await body(req),client=clientById.get(scope+':'+b.clientId);if(!client&&!BOOTSTRAP_READS.has(b.channel))throw fail(409,'请先连接事件通道');return json(res,200,{ok:true,value:await invoke(scope,b,client||{origin,stableId:'bootstrap-read'})});}
   if(endpoint==='/api/sync'){await native.start();return json(res,200,{epoch,seq:sequence[scope],...await boundary.snapshot(scope)});}
   if(endpoint==='/api/performance'&&req.method==='POST'){const b=await body(req);for(const entry of safePerformanceEvents(b.events))performanceEvents.push({scope,at:new Date().toISOString(),...entry});if(performanceEvents.length>300)performanceEvents.splice(0,performanceEvents.length-300);return json(res,200,{received:true});}
   if(endpoint==='/api/diagnostics')return json(res,200,{counts:Object.fromEntries([...diagnostics].filter(([key])=>key.startsWith(scope+':'))),fileOperations:fileDiagnostics.snapshot(scope),historyReads:historyReads.filter(e=>e.scope===scope),historyUpgrades:historyUpgrades.filter(e=>e.scope===scope),performance:performanceEvents.filter(e=>e.scope===scope),nativeVersion:nativeVersion(native.initialization)});
   if(endpoint==='/api/request'&&req.method==='POST'){const b=await body(req);return json(res,200,await boundary.call(scope,b.request,{clientId:b.clientId}));}
   throw fail(403,'文件、插件配置及此接口暂未开放');
  }
  if(route.startsWith('/api/')||route==='/ws')throw fail(403,'请求必须携带固定工作区');
  if(!['GET','HEAD'].includes(req.method))throw fail(405,'方法不允许');
  if(['/sw.js','/workbench-sw.js'].includes(route)){
   if(!localReleaseLoading)localReleaseLoading=nativeUIRelease(upstream).catch(e=>{localReleaseLoading=null;throw e;});
   const release=await localReleaseLoading,worker=release.worker??(await readFile(new URL('../public/official-service-worker.js',import.meta.url),'utf8'))+'\n// dsh-native-release:'+release.manifest.version+'\n';
   res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-cache','service-worker-allowed':'/'});return res.end(worker);
  }
  // 流式转发保持压缩、ETag 与缓存头；只对导航 HTML 做必要的 scope bootstrap 注入。
  const headers={};for(const k of ['accept','accept-encoding','if-none-match','if-modified-since','range'])if(req.headers[k])headers[k]=req.headers[k];headers.host=new URL(upstream).host;
  const navigation=!path.extname(route)||route.endsWith('.html');if(navigation)delete headers['accept-encoding'];
  if(route===lastHistoryAssetPrefix+historyClientAsset){if(!lastHistoryAssetLoading)lastHistoryAssetLoading=fetch(upstream+upstreamAssetPrefix+historyClientAsset).then(async r=>{if(!r.ok)throw fail(503,'原生历史模块暂不可用');return patchInitialHistoryBudget(await r.text(),{cacheView:false});}).catch(e=>{lastHistoryAssetLoading=null;throw e;});return textResponses.send(req,res,await lastHistoryAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-dsh-edge-cache':'static'});}
  if(route===previousHistoryAssetPrefix+historyClientAsset){if(!previousHistoryAssetLoading)previousHistoryAssetLoading=fetch(upstream+upstreamAssetPrefix+historyClientAsset).then(async r=>{if(!r.ok)throw fail(503,'原生历史模块暂不可用');return patchInitialHistoryBudget(await r.text(),{legacy:true});}).catch(e=>{previousHistoryAssetLoading=null;throw e;});return textResponses.send(req,res,await previousHistoryAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-dsh-edge-cache':'static'});}
  if(route===composerHistoryAssetPrefix+historyClientAsset){if(!composerHistoryAssetLoading)composerHistoryAssetLoading=fetch(upstream+upstreamAssetPrefix+historyClientAsset).then(async response=>{if(!response.ok)throw fail(503,'官方历史模块尚未就绪');return patchInitialHistoryBudget(await response.text(),{menuLifecycle:false});}).catch(error=>{composerHistoryAssetLoading=null;throw error;});return await textResponses.send(req,res,await composerHistoryAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-dsh-edge-cache':'static'});}
  if(route===menuHistoryAssetPrefix+historyClientAsset){if(!menuHistoryAssetLoading)menuHistoryAssetLoading=fetch(upstream+upstreamAssetPrefix+historyClientAsset).then(async response=>{if(!response.ok)throw fail(503,'官方历史模块尚未就绪');return patchInitialHistoryBudget(await response.text(),{scrollableMenus:false});}).catch(error=>{menuHistoryAssetLoading=null;throw error;});return await textResponses.send(req,res,await menuHistoryAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-dsh-edge-cache':'static'});}
  if(route===gestureHistoryAssetPrefix+historyClientAsset){if(!gestureHistoryAssetLoading)gestureHistoryAssetLoading=fetch(upstream+upstreamAssetPrefix+historyClientAsset).then(async response=>{if(!response.ok)throw fail(503,'官方历史模块尚未就绪');return patchInitialHistoryBudget(await response.text());}).catch(error=>{gestureHistoryAssetLoading=null;throw error;});return await textResponses.send(req,res,await gestureHistoryAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-dsh-edge-cache':'static'});}
  if(route===historyAssetPrefix+historyClientAsset){if(!historyAssetLoading)historyAssetLoading=fetch(upstream+upstreamAssetPrefix+historyClientAsset).then(async response=>{if(!response.ok)throw fail(503,'官方历史模块尚未就绪');return patchInitialHistoryBudget(await response.text(),{compactFilePreview:true});}).catch(error=>{historyAssetLoading=null;throw error;});return await textResponses.send(req,res,await historyAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-dsh-edge-cache':'static'});}
  if(route===historyAssetPrefix+filePreviewClientAsset){if(!filePreviewAssetLoading)filePreviewAssetLoading=fetch(upstream+upstreamAssetPrefix+filePreviewClientAsset).then(async response=>{if(!response.ok)throw fail(503,'官方历史模块尚未就绪');return patchFilePreviewChrome(await response.text());}).catch(error=>{filePreviewAssetLoading=null;throw error;});return await textResponses.send(req,res,await filePreviewAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-dsh-edge-cache':'static'});}
  if(route===previousHistoryAssetPrefix+followUpClientAsset){if(!legacyFollowUpAssetLoading)legacyFollowUpAssetLoading=fetch(upstream+upstreamAssetPrefix+followUpClientAsset).then(async response=>{if(!response.ok)throw fail(503,'原生输入模块尚未就绪');return patchFollowUpControls(await response.text(),{legacy:true});}).catch(error=>{legacyFollowUpAssetLoading=null;throw error;});return await textResponses.send(req,res,await legacyFollowUpAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-dsh-edge-cache':'static'});}
  if(route===draftFollowUpAssetPrefix+followUpClientAsset){if(!draftFollowUpAssetLoading)draftFollowUpAssetLoading=fetch(upstream+upstreamAssetPrefix+followUpClientAsset).then(async r=>{if(!r.ok)throw fail(503,'原生输入模块暂不可用');return patchFollowUpControls(await r.text(),{retainedDrafts:false});}).catch(e=>{draftFollowUpAssetLoading=null;throw e;});return textResponses.send(req,res,await draftFollowUpAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-dsh-edge-cache':'static'});}
  if(route===lastFollowUpAssetPrefix+followUpClientAsset){if(!lastFollowUpAssetLoading)lastFollowUpAssetLoading=fetch(upstream+upstreamAssetPrefix+followUpClientAsset).then(async r=>{if(!r.ok)throw fail(503,'原生输入模块暂不可用');return patchFollowUpControls(await r.text(),{cacheDrafts:false});}).catch(e=>{lastFollowUpAssetLoading=null;throw e;});return textResponses.send(req,res,await lastFollowUpAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-dsh-edge-cache':'static'});}
  if(route===previousFollowUpAssetPrefix+followUpClientAsset){if(!previousFollowUpAssetLoading)previousFollowUpAssetLoading=fetch(upstream+upstreamAssetPrefix+followUpClientAsset).then(async response=>{if(!response.ok)throw fail(503,'原生输入模块尚未就绪');return patchFollowUpControls(await response.text(),{previous:true});}).catch(error=>{previousFollowUpAssetLoading=null;throw error;});return await textResponses.send(req,res,await previousFollowUpAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-dsh-edge-cache':'static'});}
  if(route===retainedFollowUpAssetPrefix+followUpClientAsset){const response=await fetch(upstream+upstreamAssetPrefix+followUpClientAsset);if(!response.ok)throw fail(503,'原生输入模块尚未就绪');return textResponses.send(req,res,patchFollowUpControls(await response.text(),{modeSwitch:false}),{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-dsh-edge-cache':'static'});}
  if(route===followUpAssetPrefix+followUpClientAsset){if(!followUpAssetLoading)followUpAssetLoading=fetch(upstream+upstreamAssetPrefix+followUpClientAsset).then(async response=>{if(!response.ok)throw fail(503,'原生输入模块尚未就绪');return patchFollowUpControls(await response.text());}).catch(error=>{followUpAssetLoading=null,legacyFollowUpAssetLoading=null;throw error;});return await textResponses.send(req,res,await followUpAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-dsh-edge-cache':'static'});}
  const versionPrefix=[historyAssetPrefix,gestureHistoryAssetPrefix,menuHistoryAssetPrefix,composerHistoryAssetPrefix,lastHistoryAssetPrefix,previousHistoryAssetPrefix,followUpAssetPrefix,retainedFollowUpAssetPrefix,draftFollowUpAssetPrefix,lastFollowUpAssetPrefix,previousFollowUpAssetPrefix].find(prefix=>route.startsWith(prefix)),proxyRoute=versionPrefix?upstreamAssetPrefix+route.slice(versionPrefix.length):route;
  const upstreamReq=http.request(upstream+(navigation?'/':proxyRoute+u.search),{method:req.method,headers},r=>{
   const h=endToEndHeaders(r.headers);delete h['set-cookie'];
   // The pinned versioned renderer assets are immutable. Its development
   // server's no-store default must not force every device/cloud read upstream.
   if(r.statusCode===200&&/^\/official-patched-v\d+\/assets\/[^/]+\.(?:js|css|woff2?|png|svg)$/.test(route)&&!/(?:text\/html|application\/json)/.test(String(h['content-type']))){h['cache-control']='private, max-age=31536000, immutable';h['x-dsh-edge-cache']='static';}
   if(String(h['content-type']).includes('text/html')&&r.statusCode===200){let chunks=[];r.on('data',b=>chunks.push(b));r.on('end',()=>{try{const scope=u.searchParams.get('workspace')||'ai',ws=workspace(scope),t=token(ws);let html=patchNativeModulePreloads(Buffer.concat(chunks).toString()).replace(/<meta\b[^>]*\bname\s*=\s*(['"])(?:viewport|theme-color|color-scheme)\1[^>]*>/gi,'');html=html.replace('<head>',`<head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#ffffff"><style>html,body{background:#fff}@media(prefers-color-scheme:dark){html,body{background:#000}}html[data-dsh-theme="dark"],html[data-dsh-theme="dark"] body{background:#000}html[data-dsh-theme="light"],html[data-dsh-theme="light"] body{background:#fff}</style><meta name="initial-route" content="${/^\/local\/[0-9a-f-]{36}$/i.test(route)?route:'/'}"><script>window.__DSH_SCOPE__=${JSON.stringify({id:scope,token:t,...(portableConfig?{portable:true,label:ws.label,workspaces:Object.values(portableConfig.workspaces).map(({id,label})=>({id,label}))}:{}),nativeList:u.searchParams.get("nativeList")==="1"})};</script><script src="/dsh-scope-bootstrap.js"></script><link rel="stylesheet" href="/dsh-pwa.css"><script defer src="/dsh-pwa.js"></script>`).replaceAll('/manifest.webmanifest','/manifest.webmanifest?workspace='+scope).replaceAll('/codex-web-config.js',`/codex-web-config.js?workspace=${scope}&amp;scopeToken=${t}`);delete h['content-length'];delete h.etag;h['cache-control']='no-store';res.writeHead(200,h);res.end(html);}catch(e){json(res,statusOf(e),{error:e.message});}});
   }else{res.writeHead(r.statusCode,h);r.pipe(res);}
  });upstreamReq.on('error',()=>{if(!res.headersSent)json(res,503,{error:'官方界面正在恢复'});else res.destroy();});res.on('close',()=>{if(!res.writableEnded)upstreamReq.destroy();});upstreamReq.end();
 }catch(e){if(!res.headersSent)json(res,statusOf(e),{error:e.code?e.message:'服务暂不可用'});else res.end();}});
 function cleanupClient(ws){
  git.close(ws);
  for(const c of clients)if(c!==ws&&c.scope===ws.scope)notifyClientStatus(c,{sourceClientId:ws.pageId,params:{clientId:ws.pageId,clientType:'electron',isSelf:false,status:'disconnected'}});
  for(const[id,p]of browserActions)if(p.client===ws){clearTimeout(p.timer);browserActions.delete(id);p.reject(fail(409,'页面已断开'));}
  clients.delete(ws);if(clientById.get(ws.scope+':'+ws.pageId)===ws)clientById.delete(ws.scope+':'+ws.pageId);
  for(const p of ws.ports.values())p.close();for(const close of ws.cleanup||[])close();ws.cleanup?.clear();
 }
 const wss=new WebSocketServer({noServer:true,maxPayload:29*1024*1024,perMessageDeflate:{threshold:1024,serverNoContextTakeover:true,clientNoContextTakeover:true,concurrencyLimit:2,zlibDeflateOptions:{level:3}}});
 server.on('upgrade',(req,socket,head)=>{let connectionId=randomUUID(),diagnosticScope;const startedAt=Date.now();try{
  const u=new URL(req.url,'http://'+req.headers.host),m=u.pathname.match(/^\/w\/(ai|zyy)\/ws$/);if(!m)throw fail(403,'scope missing');
  const scope=m[1];diagnosticScope=scope;const offered=u.searchParams.get('dshDiag');if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(offered||''))connectionId=offered;connectionLog.event({component:'page-ws',stage:'attempt',connectionId,scope});authorized(req,scope,u);const origin=req.headers.origin;if(origin&&!allowedOrigins().includes(origin))throw fail(403,'origin');
  wss.handleUpgrade(req,socket,head,wire=>{
   let ws=wire,handshaken=false,lastMessageAt=Date.now();const wireDiagnostic=(stage,extra={})=>connectionLog.event({component:'page-ws',stage,connectionId,scope,pageId:u.searchParams.get('dshDiagPage'),uiVersion:u.searchParams.get('dshDiagUI'),handshakeComplete:handshaken,nativeReady:native.state==='ready',...extra});wireDiagnostic('open');wire.on('error',error=>wireDiagnostic('failed',{reason:'socket_error',errorCode:error?.code||'unknown'}));Object.assign(ws,{scope,ports:new Map(),origin:origin||`http://127.0.0.1:${boundPort()}`,stableId:'',pageId:''});
   wire.on('message',raw=>{lastMessageAt=Date.now();Promise.resolve().then(async()=>{
    const m=JSON.parse(raw);
    if(m.type==='hello'){
     if(handshaken)throw fail(400,'重复身份握手');
     if(typeof m.clientId!=='string'||m.clientId.length>160)throw fail(400,'invalid client');
     const stableId=typeof m.dshClientId==='string'&&m.dshClientId.length<=160?m.dshClientId:m.clientId;
     let resumed=false;
     if(m.dshProtocol===PAGE_RESUME_PROTOCOL){
      try{({session:ws,resumed}=pageSessions.attach(wire,{scope,pageId:m.clientId,stableId,origin:ws.origin,resumeId:m.dshResumeId,ack:m.dshAck??0,replyProtocol:m.dshReplyProtocol,replyAck:m.dshReplyAck}));}
      catch(error){const reason=['page_resume_unavailable','page_ack_invalid','page_session_limit'].includes(error?.message)?error.message:'page_resume_unavailable';wireDiagnostic('rejected',{reason});wire.send(JSON.stringify({type:'dsh:resume-unavailable',reason}));wire.close(4009,reason);return;}
   }else{ws.pageId=m.clientId;ws.stableId=stableId;}
     ws.connectionId=connectionId;ws.diagnosticPageId=u.searchParams.get('dshDiagPage');
     handshaken=true;wireDiagnostic('hello',{resumed,durationMs:Date.now()-startedAt});if(resumed)ws.needsCatchup=false;clients.add(ws);clientById.set(scope+':'+ws.pageId,ws);
      const ack={type:'hello-ack',clientId:m.clientId,...(ws.resumeId?{dshProtocol:PAGE_RESUME_PROTOCOL,dshResumeId:ws.resumeId,dshResumed:resumed,dshReceivedSeq:ws.receivedSeq,dshBulkReadProtocol:BULK_READ_PROTOCOL,dshAttachmentUploadProtocol:ATTACHMENT_UPLOAD_PROTOCOL,dshIsolatedReadMethods:[...BULK_READ_METHODS],dshEpoch:epoch,dshNativeGeneration:native.generation,dshNativeConnected:native.state==='ready',...(ws.replyProtocol?{dshReplyProtocol:REPLY_STREAM_PROTOCOL,dshReplySnapshotSeq:ws.replies.rpc.sentSeq}:{})}:{})};
     if(ws.resumeId){pageSessions.control(ws,ack);pageSessions.replay(ws);}else send(ws,ack);
     await syncClient(ws,{recover:resumed});return;
    }
    if(!handshaken)throw fail(403,'hello required');
    if(ws.resumeId){
     if(ws.wire!==wire)return;
     if(m.type==='dsh:reply-ack'){if(!ws.replyProtocol)throw fail(400,'未协商回应通道');pageSessions.acknowledgeReply(ws,m.stream,m.seq);return;}
     if(m.type==='dsh:ack'){pageSessions.acknowledge(ws,m.seq);if(ws.needsCatchup&&!ws.catchingUp&&ws.bytes<1024*1024){ws.needsCatchup=false;ws.catchingUp=syncClient(ws,{recover:true}).catch(()=>{ws.needsCatchup=true;}).finally(()=>{ws.catchingUp=null;});}return;}
     if(m.type!=='dsh:ping'&&m.type!=='dsh:sync'){
      const first=pageSessions.accept(ws,m.dshClientSeq);pageSessions.control(ws,{type:'dsh:ack',seq:ws.receivedSeq});if(!first)return;
     }
    }
    if(m.type==='dsh:ping'){const pong={type:'dsh:pong',nonce:m.nonce};if(ws.resumeId)pageSessions.control(ws,pong);else send(ws,pong);return;}
    if(m.type==='dsh:browser-action-result'){const pending=browserActions.get(m.requestId);if(pending?.client!==ws)throw fail(403,'页面操作不匹配');clearTimeout(pending.timer);browserActions.delete(m.requestId);m.ok?pending.resolve(m.result):pending.reject(fail(400,typeof m.error==='string'?m.error.slice(0,200):'页面操作失败'));return;}
    if(m.type==='dsh:sync'){await syncClient(ws,{recover:!!m.recoverConversation});return;}
    if(m.type==='app-host-connect'){if(ws.ports.has(m.portId))send(ws,{type:'app-host-port-connected',portId:m.portId});else appHost(ws,m.portId);return;}
    if(m.type==='app-host-port-message'){const data=codec.decodeMessageData(m);if(data==null){ws.ports.get(m.portId)?.close();ws.ports.delete(m.portId);}else appHost(ws,m.portId).receive(data);return;}
    if(m.type==='opencodex:ipc-invoke'){try{const value=await invoke(scope,m.request,ws);send(ws,{type:'opencodex:ipc-result',requestId:m.requestId,ok:true,value});}catch(e){send(ws,{type:'opencodex:ipc-result',requestId:m.requestId,ok:false,status:statusOf(e),error:e.message});}return;}
    throw fail(403,'unsupported frame');
   }).catch(e=>{wireDiagnostic('failed',{reason:'protocol_error',statusCode:statusOf(e)});if(ws.resumeId&&/^page_/.test(e.message)){pageSessions.expire(ws,'page_protocol_error');return;}send(ws,{type:'dsh:error',status:statusOf(e),error:e.code?e.message:'无效协议帧'});});});
   wire.on('close',(code)=>{wireDiagnostic('closed',{reason:'socket_closed',closeCode:code,durationMs:Date.now()-startedAt,lastMessageAgeMs:Date.now()-lastMessageAt,bufferedBytes:wire.bufferedAmount});if(ws.resumeId){pageSessions.detach(ws,wire);}else cleanupClient(ws);});
  });
 }catch(error){connectionLog.event({component:'page-ws',stage:'rejected',connectionId,scope:diagnosticScope,reason:'upgrade_rejected',statusCode:statusOf(error),durationMs:Date.now()-startedAt});socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');}});
 const eventDispatcher=new NativeEventDispatcher({boundary,clients,scopes:SCOPES,wants:wantsNativeNotification,emit,advance:scope=>sequence[scope]++,filtered:(scope,method)=>trace(scope,'stream-filtered',method)});
 const onNative=m=>{if(['account/updated','account/login/completed'].includes(m.method)){bulkIdentityGeneration++;eventDispatcher.barrier();}boundary.observe(m);eventDispatcher.dispatch(m);};
 native.on('notification',onNative);native.on('request',onNative);let reconnecting=false;
 native.on('interrupted',()=>{eventDispatcher.barrier();connectionLog.event({component:'front',stage:'closed',reason:'native_disconnected'});reconnecting=true;for(const ws of clients){ws.ownedThreads?.clear();emit(ws,{type:'codex-app-server-connection-changed',hostId:'local',state:'disconnected',transport:'websocket',isSnapshot:false});send(ws,{type:'dsh:sync-state',epoch,seq:sequence[ws.scope],hostState:'disconnected'});}});
 native.on('ready',()=>{connectionLog.event({component:'front',stage:'ready',reason:'native_ready'});if(!reconnecting)return;reconnecting=false;for(const ws of clients)if(ws.pageId){emitInitialization(ws,{isSnapshot:false});syncClient(ws).catch(()=>{});}});
 await native.start();
 return {server,boundary,native,journal,async close(){phoneCodes?.close();capacityRetry?.close();eventDispatcher.barrier();pageSessions.close();for(const ws of clients)ws.close();wss.close();await new Promise(r=>server.close(r));await Promise.allSettled([...boundary.historyPreparations.values()].map(r=>r.promise));native.close();await store.flush();await cacheEvents;nativeCache.close();journal.close();connectionLog.event({component:'front',stage:'stopped',reason:'shutdown'});await connectionLog.close();}};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){const port=Number(process.env.PORT||3084),front=await createOfficialFront({port,stateDir:process.env.DSH_OFFICIAL_STATE_DIR,publicOrigin:process.env.DSH_OFFICIAL_PUBLIC_ORIGIN||null});front.server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({service:'official-codex-front',port,pid:process.pid})));for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await front.close();process.exit(0);});}

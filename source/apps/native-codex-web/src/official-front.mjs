// 私有官方界面前门：静态资源复用 OpenCodex，内容/命令统一经过固定 scope 原生适配器。
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomBytes,createHmac,timingSafeEqual,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {SharedNative} from './shared-native.mjs';
import {OfficialBoundary} from './official-boundary.mjs';
import {scopeRuntimeAssets} from './official-assets.mjs';
import {createAppHostFactory} from './official-app-host.mjs';
import {OfficialGit} from './official-git.mjs';
import {OfficialState} from './official-state.mjs';
import {createOfficialSettings} from './official-settings.mjs';
import {PageSessions,PAGE_RESUME_PROTOCOL} from './page-sessions.mjs';
import {cacheableBootstrap} from './native-bootstrap.mjs';
import {nativeUIRelease,scopeSources} from './native-ui-release.mjs';
import {NativeReadCache} from './native-read-cache.mjs';
import {NativeQueue} from './native-queue.mjs';
import {QueuedSendLocks} from './queued-send-locks.mjs';
import {OfficialFiles} from './official-files.mjs';
import {FileDiagnostics} from './file-diagnostics.mjs';
import {loadShellAssets} from './shell-assets.mjs';
import {serveFileResponse} from './file-response.mjs';
import {wantsNativeNotification} from './notification-interest.mjs';
import {endToEndHeaders} from './http-headers.mjs';
import {nativeVersion} from './native-version.mjs';
import {safePerformanceEvents} from './performance-events.mjs';
import {OfficialDesktopMetadata} from './official-desktop-metadata.mjs';
import {TextResponses} from './official-http-text.mjs';
import {isWorkspaceNavigation,navigationDenial} from './navigation.mjs';
import {historyAssetPrefix,gestureHistoryAssetPrefix,menuHistoryAssetPrefix,composerHistoryAssetPrefix,lastHistoryAssetPrefix,previousHistoryAssetPrefix,followUpAssetPrefix,retainedFollowUpAssetPrefix,draftFollowUpAssetPrefix,lastFollowUpAssetPrefix,previousFollowUpAssetPrefix,upstreamAssetPrefix,historyClientAsset,patchInitialHistoryBudget,filePreviewClientAsset,patchFilePreviewChrome,followUpClientAsset,patchFollowUpControls,patchNativeModulePreloads} from './official-history-assets.mjs';
import {Journal} from './journal.mjs';
import {workspace,belongs,fail} from './registry.mjs';
import {projectData,projectMaterialFeedback} from './project-data.mjs';
const PRIVATE='${BETTER_CODEX_HOME}/.better-codex/official-runtime-20260908';
const require=createRequire(PRIVATE+'/opencodex-pinned/package.json');
const {WebSocketServer}=require('ws');
const codec=require('./web-shell/codex-app-host-message-codec.js');
const {RpcSession,RpcTarget}=await import(PRIVATE+'/adapter-deps/node_modules/capnweb/dist/index.js');
const CHANNEL='codex_desktop:message-for-view';
const BOOTSTRAP_READS=new Set(['codex_desktop:get-initial-sidebar-bootstrap','codex_desktop:get-shared-object-snapshot','codex_desktop:get-build-flavor','codex_desktop:get-system-theme-variant','codex_desktop:get-sentry-init-options']);
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
async function body(req){let s='',size=0;for await(const b of req){size+=b.length;if(size>29*1024*1024)throw fail(413,'请求过大');s+=b;}try{return JSON.parse(s);}catch{throw fail(400,'请求格式无效');}}
const statusOf=e=>typeof e.code==='number'&&e.code>=400&&e.code<=599?e.code:({ENOENT:404,EACCES:403,EPERM:403,ELOOP:403,EISDIR:400,ENOTDIR:400}[e.code]||500);
function errorShape(e){return {code:e.rpcCode||-32000,message:e.code?e.message:'官方桥接暂不可用',data:{status:statusOf(e)}};}
export async function createOfficialFront({port=3084,upstream='http://127.0.0.1:3082',native=new SharedNative({reconnect:true}),stateDir=PRIVATE+'/front-state',publicOrigin=null}={}){
 if(publicOrigin){const u=new URL(publicOrigin);if(u.protocol!=='http:'||!['localhost','127.0.0.1'].includes(u.hostname))throw fail(400,'开发候选仅允许回环入口');publicOrigin=u.origin;}
 await mkdir(stateDir,{recursive:true,mode:0o700});const historyReads=[],journal=new Journal(process.env.BETTER_CODEX_COMMAND_JOURNAL_DIR||stateDir),boundary=new OfficialBoundary({native,journal,enableDefaultModeQuestions:true,onNativeResponse:(scope,method,p,result)=>{if(method==='thread/resume')nativeCache.rememberCursors(scope,result);},onHistoryRead:entry=>{historyReads.push({at:new Date().toISOString(),...entry});if(historyReads.length>200)historyReads.shift();}});
 const shell=await loadShellAssets();
 const clients=new Set(),clientById=new Map(),fileGrants=new Map(),eventQueues=new Map(),diagnostics=new Map(),desktopMetadata=new OfficialDesktopMetadata(upstream);
 const performanceEvents=[];
 function trace(scope,kind,value){const name=typeof value==='string'&&/^[a-zA-Z0-9_:/.-]{1,150}$/.test(value)?value:'unknown',key=`${scope}:${kind}:${name}`;if(diagnostics.size<512||diagnostics.has(key))diagnostics.set(key,(diagnostics.get(key)||0)+1);}
 const localReleases=new Map();let releaseRefresh=null;
 const epoch=randomUUID(),sequence={ai:0,secondary:0},secret=randomBytes(32),textResponses=new TextResponses();let configCache=null,configAt=0,configLoading=null,runtimeAssets=null,gestureHistoryAssetLoading=null,filePreviewAssetLoading=null,menuHistoryAssetLoading=null,composerHistoryAssetLoading=null,historyAssetLoading=null,previousHistoryAssetLoading=null,lastHistoryAssetLoading=null,localReleaseLoading=null,followUpAssetLoading=null,lastFollowUpAssetLoading=null,draftFollowUpAssetLoading=null,legacyFollowUpAssetLoading=null,previousFollowUpAssetLoading=null;
 const sign=s=>createHmac('sha256',secret).update(s).digest('base64url');
 const token=ws=>{const s=Buffer.from(JSON.stringify({scope:ws.id,exp:Date.now()+12*3600000})).toString('base64url');return s+'.'+sign(s);};
 function authorized(req,scope,url){workspace(scope);const t=req.headers['x-betterCodex-scope']||url.searchParams.get('scopeToken')||'';const[a,b]=String(t).split('.');if(!a||!b||b.length!==43||!timingSafeEqual(Buffer.from(b),Buffer.from(sign(a))))throw fail(401,'工作区连接已失效，请刷新');let p;try{p=JSON.parse(Buffer.from(a,'base64url'));}catch{throw fail(401,'连接无效');}if(p.exp<Date.now())throw fail(401,'连接已过期');if(p.scope!==scope)throw fail(403,'工作区连接不匹配');return workspace(scope);}
 const fileDiagnostics=new FileDiagnostics({emit:entry=>console.log(JSON.stringify({event:'file-operation',...entry}))});
 const store=new OfficialState(stateDir),files=fileDiagnostics.observe(new OfficialFiles({stateDir,boundary}));boundary.files=files;const git=new OfficialGit({upstream,files,send});
 const state=scope=>store.read(scope),persist=scope=>store.persist(scope);const bootstrapDefaults=new Map();
 const settings=createOfficialSettings({RpcTarget,state,persist});
 const queuedSendLocks=new QueuedSendLocks(journal.db),nativeQueue=new NativeQueue({boundary,journal}),nativeCache=new NativeReadCache(process.env.BETTER_CODEX_NATIVE_CACHE_DIR||path.join(stateDir,'native-cache'),{boundary});
 let cacheEvents=Promise.resolve();native.on('notification',m=>{cacheEvents=cacheEvents.then(()=>nativeCache.observe(m)).catch(()=>{});});
 const pageSessions=new PageSessions({onExpire:cleanupClient,shouldRetain:ws=>boundary.active.has(ws.presentedThreadId)||boundary.threads.get(ws.presentedThreadId)?.status?.type==='active'});
 const ensureScopedDirectory=(scope,value)=>files.directory(scope,value);
 async function config(scope,origin){if(!configCache||Date.now()-configAt>60000){if(!configLoading)configLoading=(async()=>{const r=await fetch(upstream+'/codex-web-config.js');if(!r.ok)throw fail(503,'官方界面尚未就绪');const context={window:{},location:{origin}};vm.runInNewContext(await r.text(),context,{timeout:1000});configCache=context.window.__CODEX_WEB_CONFIG__;configAt=Date.now();})().finally(()=>{configLoading=null});await configLoading;}
  const c=boundary.bootstrap(scope,{...configCache,gatewayBaseUrl:origin,gatewayWsUrl:origin.replace(/^http/,'ws')+'/ws'}),s=await state(scope),settings=await boundary.config();
  const mode={'danger-full-access':'full-access','read-only':'read-only','workspace-write':'auto'}[settings.sandbox_mode];
  c.initialSidebarBootstrap.catalogEntries=nativeCache.changes(0,100,scope,'catalog').records.filter(r=>!r.deleted).map(r=>r.payload);
  c.persistedAtomSnapshot={...c.persistedAtomSnapshot,...s.atoms,'home-composer-mode-v1':'work',...(mode?{'agent-mode-by-host-id':{local:mode},'config-derived-agent-mode-by-host-id':{local:mode}}:{})};c.initialSidebarBootstrap.globalStateEntries=c.initialSidebarBootstrap.globalStateEntries.map(x=>({key:x.key,value:x.key==='pending_worktrees'&&!Array.isArray(s.globals[x.key])?x.value:Object.hasOwn(s.globals,x.key)?s.globals[x.key]:x.value}));
  let cachedDefaults=bootstrapDefaults.get(scope);if(!cachedDefaults||Date.now()-cachedDefaults.at>60000){const methods=['config/read','model/list','account/read','getAuthStatus','configRequirements/read','modelProvider/capabilities/read','remoteControl/status/read','collaborationMode/list','permissionProfile/list','experimentalFeature/list'];const results=await Promise.allSettled(methods.map(method=>boundary.call(scope,{method,params:method==='permissionProfile/list'?{cwd:workspace(scope).root}:{} })));cachedDefaults={at:Date.now(),values:Object.fromEntries(results.flatMap((r,i)=>r.status==='fulfilled'?[[methods[i],r.value]]:[]))};bootstrapDefaults.set(scope,cachedDefaults);}
  const version=nativeVersion(native.initialization),readOnly=cacheableBootstrap(c,{initialization:{type:'codex-app-server-initialized',hostId:'local',appServerVersion:version,installedCodexVersion:version,isSnapshot:true},defaults:cachedDefaults.values,settings:{followUpQueueMode:'steer',...s.settings}});
  nativeCache.put(scope,'bootstrap','bootstrap','',{config:readOnly});return {...c,betterCodexReadDefaults:readOnly.betterCodexReadDefaults,betterCodexNativeInitialization:readOnly.betterCodexNativeInitialization,betterCodexSettings:readOnly.betterCodexSettings};}
 function send(ws,m){if(ws.resumeId)return pageSessions.send(ws,m);if(ws.readyState!==1)return false;if(ws.bufferedAmount>32*1024*1024){ws.close(1013,'请重新连接并核对快照');return false;}ws.send(JSON.stringify(m));return true;}
 function emit(ws,payload){return send(ws,{channel:CHANNEL,payload,betterCodexEpoch:epoch,betterCodexSeq:sequence[ws.scope]});}
 function rpcResponse(ws,request,value,error){if(error){const reasons=[['运行工作区','runtime_workspace'],['权限配置','permission_profile'],['沙箱策略','sandbox_policy'],['执行策略','approval_policy'],['不允许覆写','config_override'],['模型提供方','model_provider']];trace(ws.scope,'rejected',reasons.find(([text])=>error.message?.includes(text))?.[1]||'other');}emit(ws,{type:'mcp-response',hostId:'local',message:{id:request.id,...(error?{error:errorShape(error)}:{result:value})}});}
  function emitInitialization(ws,{isSnapshot=true}={}){if(ws.viewServices)ws.viewServices.clientCoordination.clientStatusChanged({sourceClientId:ws.pageId,params:{clientId:ws.pageId,clientType:'electron',isSelf:true,status:'connected'}}).catch(()=>{});const version=nativeVersion(native.initialization);emit(ws,{type:'codex-app-server-initialized',hostId:'local',appServerVersion:version,installedCodexVersion:version,isSnapshot});emit(ws,{type:'codex-app-server-connection-changed',hostId:'local',state:native.state==='ready'?'connected':'disconnected',transport:'websocket',isSnapshot});}
 async function syncClient(ws,{recover=false}={}){if(ws.syncing){ws.recoverNext||=recover;return ws.syncing;}ws.recoverNext=false;ws.syncing=(async()=>{await native.start();emitInitialization(ws);const snapshot=await boundary.snapshot(ws.scope);send(ws,{type:'betterCodex:sync-state',epoch,seq:sequence[ws.scope],...snapshot});for(const t of snapshot.threads)emit(ws,{type:'mcp-notification',hostId:'local',method:'thread/status/changed',params:{threadId:t.id,status:t.status}});for(const request of snapshot.approvals)if(boundary.approvals.get(String(request.id))===request)emit(ws,{type:'mcp-request',hostId:'local',request});if(recover||ws.recoverNext)emit(ws,{type:'codex-app-server-connection-changed',hostId:'local',state:'connected',transport:'websocket',isSnapshot:false});})().finally(()=>{ws.syncing=null;});return ws.syncing;}
 async function invoke(scope,request,client){const channel=request.channel,args=Array.isArray(request.args)?request.args:('payload'in request?[request.payload]:[]),p=args[0]||{};
  trace(scope,'channel',channel);trace(scope,'message',p.type);if(p.type==='mcp-request'){trace(scope,'native',p.request?.method);if(['thread/start','thread/resume','turn/start'].includes(p.request?.method)){for(const key of Object.keys(p.request.params||{}))trace(scope,'native-field',key);for(const key of Object.keys(p.request.params?.config||{}))trace(scope,'native-config',key);}}if(p.type==='fetch')trace(scope,'fetch',String(p.url||'').replace(/^vscode:\/\/codex\//,''));
  if(channel==='codex_desktop:message-from-view'&&(p.type==='mcp-request'||p.type==='thread-prewarm-start')){
   const threadId=p.request?.params?.threadId;if(typeof threadId==='string'){client.readThreads??=new Map();client.readThreads.set(threadId,Date.now()+120000);while(client.readThreads.size>64)client.readThreads.delete(client.readThreads.keys().next().value);}
   if(p.type==='thread-prewarm-start'){for(const key of Object.keys(p.request?.params?.config||{}))trace(scope,'native-config',key);}
   if(p.hostId&&p.hostId!=='local')throw fail(403,'远程宿主不属于当前工作区');
   // 保持官方“IPC ACK + 异步 mcp-response”的协议，浏览器断开不取消已接受执行。
   const operation=['fs/createDirectory','fs/writeFile','fs/remove'].includes(p.request?.method)?files.nativeAttachmentRequest(scope,p.request.method,p.request.params||{}):boundary.call(scope,p.request,{clientId:client.stableId});
   operation.then(v=>rpcResponse(client,p.request,v),e=>rpcResponse(client,p.request,null,e));return null;
  }
  if(channel==='codex_desktop:message-from-view'&&p.type==='mcp-response'){await boundary.answer(scope,p.message||p.response||p);return null;}
  const s=await state(scope),c=await config(scope,client.origin);
  if(channel==='open-file'){const target=await files.resolve(scope,p.path||p.filePath);return {url:await fileUrl(scope,target)};}
  if(channel==='pick-files')return files.upload(scope,(p.params||p).files||[]);
  if(channel==='codex_desktop:get-initial-sidebar-bootstrap')return c.initialSidebarBootstrap;
  if(channel==='codex_desktop:get-shared-object-snapshot')return c.sharedObjectSnapshot;
  if(channel==='codex_desktop:get-build-flavor')return 'prod';
  if(channel==='codex_desktop:get-system-theme-variant')return 'light';
  if(channel==='codex_desktop:get-sentry-init-options')return null;
  if(channel==='codex_desktop:worker:git:from-view'){trace(scope,'git',p.request?.method);await git.invoke(client,p);return null;}
  if(channel!=='codex_desktop:message-from-view')throw fail(403,'文件、终端及此桌面能力暂未开放');
  if(p.type==='archive-thread'||p.type==='unarchive-thread'){if(p.hostId&&p.hostId!=='local')throw fail(403,'宿主不属于当前工作区');await boundary.call(scope,{id:randomUUID(),method:p.type==='archive-thread'?'thread/archive':'thread/unarchive',params:{threadId:p.conversationId}},{clientId:client.stableId});return null;}
  if(p.type==='mcp-response'){await boundary.answer(scope,p.message||p.response||p);return null;}
  if(p.type==='persisted-atom-sync-request'){emit(client,{type:'persisted-atom-sync',state:c.persistedAtomSnapshot,atoms:c.persistedAtomSnapshot});return null;}
  if(p.type==='persisted-atom-update'){
   const key=p.key;if(typeof key!=='string'||key.length>256||['__proto__','constructor','prototype'].includes(key))throw fail(400,'无效状态键');
   let value=p.deleted?undefined:p.value;
   if(p.recordUpdate){const update=p.recordUpdate,old=s.atoms[key]??s.atoms[update.legacyStorageKey];value={...(old&&typeof old==='object'&&!Array.isArray(old)?old:{})};for(const[k,v]of Object.entries(update.entries||{})){delete value[k];if(v!=null)Object.defineProperty(value,k,{value:v.value,writable:true,enumerable:true,configurable:true});}if(Number.isSafeInteger(update.maxEntries)&&update.maxEntries>=0)for(const k of Object.keys(value).slice(0,Math.max(0,Object.keys(value).length-update.maxEntries)))delete value[k];}
   if(value===undefined)delete s.atoms[key];else Object.defineProperty(s.atoms,key,{value,writable:true,enumerable:true,configurable:true});await persist(scope);
   for(const ws of clients)if(ws.scope===scope&&ws.pageId)emit(ws,{type:'persisted-atom-updated',key,value:value??null,deleted:value===undefined});return null;
  }
  if(p.type==='shared-object-subscribe'){emit(client,{type:'shared-object-updated',key:p.key||p.objectId,value:c.sharedObjectSnapshot[p.key||p.objectId]});return null;}
  if(p.type==='fetch'){
   try{
   const method=String(p.url||'').replace(/^vscode:\/\/codex\//,'');let input={};try{input=typeof p.body==='string'?JSON.parse(p.body):p.body||{};}catch{}const a=input.params||input;let value;
   if(method==='app-server-connection-state'){if(a.hostId&&a.hostId!=='local')throw fail(403,'宿主不属于当前工作区');value={state:native.state==='ready'?'connected':'disconnected',progress:null,error:null};}
   else if(method==='read-file'){const r=await files.read(scope,{...a,representation:'text'});value={contents:r.text};}
   else if(method==='read-file-binary'){if(a.hostId&&a.hostId!=='local')throw fail(403,'宿主不属于当前工作区');const r=await files.bytes(scope,a.path);value={contentsBase64:r.bytes.toString('base64'),mimeType:r.mime};}
   else if(method==='read-file-metadata')value=await files.metadata(scope,a);
   else if(method==='workspace-directory-entries')value=await files.entries(scope,a);
   else if(method==='get-global-state'){const key=a.key;value={value:key?(s.globals[key]??c.initialSidebarBootstrap.globalStateEntries.find(x=>x.key===key)?.value):Object.fromEntries(c.initialSidebarBootstrap.globalStateEntries.map(x=>[x.key,x.value]))};}
   else if(method==='set-global-state'){if(a.key==='queued-follow-ups')throw fail(409,'队列已改为 Mac 后台执行，请刷新此旧页面后重试');if(typeof a.key!=='string'||a.key.length>256||['__proto__','constructor','prototype'].includes(a.key))throw fail(400,'无效状态键');s.globals[a.key]=a.value;await persist(scope);value={success:true};}
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
   else if(method==='locale-info')value={ideLocale:'zh-CN',systemLocale:'zh-CN'};
   else if(method==='workspace-root-options')value=c.initialSidebarBootstrap.workspaceRootOptions;
   else if(method==='codex-home')value={codexHome:'${BETTER_CODEX_HOME}/.codex'};
   else if(method==='home-directory')value={homeDirectory:workspace(scope).root};
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
   else if(method==='worktree-shell-environment-config')value={shellEnvironment:null};
   else if(method==='developer-instructions'){if(a.cwd&&!await belongs(a.cwd,workspace(scope)))throw fail(403,'工作目录超出当前工作区');value={instructions:typeof a.baseInstructions==='string'?a.baseInstructions:''};}
   else if(method==='ensure-directory')value=await ensureScopedDirectory(scope,a.path);
   else if(['set-remote-control-connections-enabled','set-remote-wsl-connections-enabled'].includes(method))value={enabled:false};
   else throw fail(403,'此桌面请求尚未开放');
   emit(client,{type:'fetch-response',requestId:p.requestId,responseType:'success',status:200,headers:{'content-type':'application/json'},bodyJsonString:JSON.stringify(value)});
   }catch(e){emit(client,{type:'fetch-response',requestId:p.requestId,responseType:'error',status:statusOf(e),error:e.code?e.message:'官方请求暂不可用'});}
   return null;
  }
  if(p.type==='ready'||p.type==='view-ready'){emitInitialization(client);return null;}
  if(['log-message','electron-window-focus-changed','analytics-event','view-ready','set-title','window-focused','ipc-broadcast','cancel-fetch','shared-object-unsubscribe','app-shell-shortcut-state-changed','browser-sidebar-annotation-multi-select-enabled-changed','browser-sidebar-site-annotation-api-enabled-changed','browser-sidebar-owner-sync','electron-window-zoom-changed','electron-window-focus-request','mac-menu-bar-enabled-changed','global-dictation-enabled-changed','codex-runtimes-config-changed','electron-avatar-overlay-restore-ready','electron-avatar-overlay-feedback-diagnostics-changed','local-thread-activity-changed','set-telemetry-user','electron-set-badge-count','tray-menu-threads-changed','power-save-blocker-set','avatar-overlay-open-state-request','browser-sidebar-tweaks-enabled-changed','electron-set-window-mode','view-focused','remote-hosted-pip-active-thread-changed','keyboard-layout-map-changed','workspace-settings-webview-presentation-changed','ready'].includes(p.type))return null;
  if(p.type==='shared-object-set')return null;
  throw fail(403,'此官方消息类型尚未适配');
 }
 async function fileUrl(scope,target,download=false){const version=(await files.version(scope,target)).etag;let grant;for(const [id,entry] of fileGrants)if(entry.scope===scope&&entry.target===target&&entry.download===download&&entry.version===version&&entry.expiresAt>Date.now()+60000){grant=id;break;}if(!grant){grant=randomBytes(24).toString('base64url');fileGrants.set(grant,{scope,target,download,version,expiresAt:Date.now()+10*60*1000});while(fileGrants.size>512)fileGrants.delete(fileGrants.keys().next().value);}return '/w/'+scope+'/api/local-file/'+grant+'/'+encodeURIComponent(path.basename(target));}
 async function serveGrantedFile(scope,grant,req,res){const entry=fileGrants.get(grant);if(!entry||entry.scope!==scope||entry.expiresAt<Date.now())throw fail(404,'文件链接已失效，请重新打开文件');return serveFileResponse({files,scope,entry,req,res});}

 const browserActions=new Map();
 function browserAction(client,action,payload){const requestId=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{browserActions.delete(requestId);reject(fail(408,'页面未确认操作'));},10000);browserActions.set(requestId,{client,resolve,reject,timer});if(!send(client,{type:'betterCodex:browser-action',requestId,action,payload})){clearTimeout(timer);browserActions.delete(requestId);reject(fail(409,'页面已断开'));}});}
 const makeAppHost=createAppHostFactory({RpcTarget,boundary,state,persist,files,native,clients,send,browserAction,fileUrl,settings});
 function appHost(ws,portId){if(ws.ports.has(portId))return ws.ports.get(portId);if(ws.ports.size>=8)throw fail(429,'连接过多');let queue=[],waiters=[],closed=false,queuedBytes=0;
  const transport={send:async raw=>{if(!send(ws,{type:'app-host-port-message',portId,...codec.encodeMessageData(JSON.parse(raw))}))throw Error('page disconnected');},receive:()=>closed?Promise.reject(Error('page disconnected')):queue.length?Promise.resolve(takeQueued()):new Promise((resolve,reject)=>waiters.push({resolve,reject})),abort:()=>close()};
  function takeQueued(){const value=queue.shift();queuedBytes-=Buffer.byteLength(value);return value;}
  function close(){closed=true;queuedBytes=0;for(const w of waiters)w.reject(Error('page disconnected'));waiters=[];queue=[];}
  const session=new RpcSession(transport,makeAppHost(ws.scope,ws),{onSendError:e=>new Error(e.code?e.message:'此桌面服务暂未开放')});session.getRemoteMain().services.then(services=>{ws.viewServices=services;}).catch(()=>{});const entry={session,close,receive(data){const raw=JSON.stringify(data);if(Buffer.byteLength(raw)>29*1024*1024||queuedBytes+Buffer.byteLength(raw)>32*1024*1024||queue.length>128)throw fail(429,'app-host队列超限');if(waiters.length)waiters.shift().resolve(raw);else{queue.push(raw);queuedBytes+=Buffer.byteLength(raw);}}};ws.ports.set(portId,entry);send(ws,{type:'app-host-port-connected',portId});return entry;
 }
 const boundPort=()=>server.address()?.port??port;
 const allowedOrigins=()=>['http://localhost:3080',`http://127.0.0.1:${boundPort()}`,`http://localhost:${boundPort()}`,...(publicOrigin?[publicOrigin]:[])];
 const server=http.createServer(async(req,res)=>{try{
  const host=req.headers.host||'',allowed=allowedOrigins().map(o=>new URL(o).host);if(!allowed.includes(host))throw fail(403,'Host不受信任');const origin=(host==='localhost:3080'?'https://':'http://')+host;
  if(req.method==='GET'&&req.url==='/'){res.writeHead(303,{location:'/?workspace=ai','cache-control':'no-store'});return res.end();}
  const safeNavigation=isWorkspaceNavigation(req);
  if(!safeNavigation&&(req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site')){navigationDenial(req,'front');throw fail(403,'跨站请求被拒绝');}
  const u=new URL(req.url,origin),route=u.pathname;res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','same-origin');
  if(['GET','HEAD'].includes(req.method)&&shell.serve(req,res,route))return;
  if(req.method==='GET'&&(route==='/conversations'||route==='/'&&u.searchParams.get('view')!=='chat'&&u.searchParams.get('nativeList')!=='1')){const ws=workspace(u.searchParams.get('workspace')||'ai');res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-betterCodex-cacheable-shell':'1','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});return res.end(shell.home(ws.id));}
  if(req.method==='GET'&&/^(?:\/official\/?|\/workspaces\/(?:ai|secondary)\/?)$/.test(route)){const ws=workspace(route.match(/^\/workspaces\/(ai|secondary)/)?.[1]||u.searchParams.get('workspace')||'ai');res.writeHead(303,{location:'/?workspace='+ws.id,'cache-control':'no-store'});return res.end();}
  if(route==='/betterCodex-native-release.json'||route.startsWith('/betterCodex-native-assets/')){if(route==='/betterCodex-native-release.json'){if(!releaseRefresh)releaseRefresh=nativeUIRelease(upstream).then(release=>{localReleaseLoading=Promise.resolve(release);localReleases.set(release.manifest.version,release);while(localReleases.size>3)localReleases.delete(localReleases.keys().next().value);return release;}).finally(()=>{releaseRefresh=null;});return json(res,200,(await releaseRefresh).manifest);}if(!localReleaseLoading)localReleaseLoading=nativeUIRelease(upstream).catch(e=>{localReleaseLoading=null;throw e;});const release=localReleases.get(route.split('/')[2])||await localReleaseLoading;const value=release.files.get(route);if(value==null)throw fail(404,'此界面版本不可用');return textResponses.send(req,res,value,{'content-type':route.endsWith('.html')?'text/html; charset=utf-8':route.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-betterCodex-edge-cache':'static',...(route.endsWith('/shell.html')?{'x-betterCodex-credential-free-shell':'1'}:{})});}
  if(req.method==='GET'&&(route==='/'||/^\/local\/[0-9a-f-]{36}$/i.test(route))){workspace(u.searchParams.get('workspace')||'ai');if(!localReleaseLoading)localReleaseLoading=nativeUIRelease(upstream).catch(e=>{localReleaseLoading=null;throw e;});const release=await localReleaseLoading;res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-betterCodex-credential-free-shell':'1'});return res.end(release.files.get(release.manifest.shell));}
  if(route==='/opencodex-runtime-bootstrap.js'){if(!runtimeAssets){const r=await fetch(upstream+route);if(!r.ok)throw fail(503,'官方浏览器适配尚未就绪');runtimeAssets=scopeRuntimeAssets(await r.text());}return await textResponses.send(req,res,runtimeAssets,{'content-type':'text/javascript','cache-control':'private, no-cache'},{adapter:true});}
  const projectFiles={'/projects':['projects.html','text/html'],'/projects.js':['projects.js','text/javascript'],'/projects.css':['projects.css','text/css']};
  if(projectFiles[route]&&req.method==='GET'){if(route==='/projects')workspace(u.searchParams.get('workspace')||'ai');const [name,type]=projectFiles[route];res.writeHead(200,{'content-type':type+'; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});return res.end(await readFile(new URL('../public/'+name,import.meta.url)));}
  if(route==='/healthz')return json(res,200,{status:'ok',service:'official-codex-front',version:'1.0.0',epoch,...await boundary.hostActivity(),nativeState:native.state,officialUpstream:upstream});
  if(route==='/betterCodex-scope-session'&&req.method==='GET'){const ws=workspace(u.searchParams.get('workspace'));return json(res,200,{id:ws.id,token:token(ws)});}
  if(route==='/ui/official'&&req.method==='GET'){const ws=workspace(u.searchParams.get('workspace')||'ai');res.writeHead(303,{location:'/?workspace='+ws.id,'cache-control':'no-store'});return res.end();}
  if(route==='/workbench'&&req.method==='GET'){const ws=workspace(u.searchParams.get('workspace')||'ai');res.writeHead(303,{location:'http://localhost:3080/workbench?workspace='+ws.id,'cache-control':'no-store'});return res.end();}
  if(route==='/manifest.webmanifest'){
   const ws=workspace(u.searchParams.get('workspace')||'ai');res.writeHead(200,{'content-type':'application/manifest+json; charset=utf-8','cache-control':'no-cache'});return res.end(JSON.stringify({id:'/workspaces/'+ws.id,name:'Codex · '+ws.id.toUpperCase(),short_name:'Codex '+ws.id.toUpperCase(),lang:'zh-CN',description:'原生 Codex 聊天与私人工作台',start_url:'/?workspace='+ws.id+'&view=chat&nativeList=1&pwa='+ws.id+'&launch=1',scope:'/',display:'standalone',display_override:['standalone','minimal-ui'],background_color:'#ffffff',theme_color:'#ffffff',orientation:'any',prefer_related_applications:false,launch_handler:{client_mode:'navigate-existing'},icons:[{src:'/assets/pwa-icon-192.png',sizes:'192x192',type:'image/png'},{src:'/assets/pwa-icon-512.png',sizes:'512x512',type:'image/png'}],shortcuts:[{name:'新对话',url:'/ui/official?workspace='+ws.id},{name:'工作台',url:'/workbench?workspace='+ws.id}]}));
  }
  const pwaFiles={'/betterCodex-pwa.js':['official-pwa.js','text/javascript'],'/betterCodex-pwa.css':['official-pwa.css','text/css'],'/betterCodex-offline.html':['official-offline.html','text/html']};
  if(pwaFiles[route]){const[file,type]=pwaFiles[route];res.writeHead(200,{'content-type':type+'; charset=utf-8','cache-control':'no-cache'});return res.end(await readFile(new URL('../public/'+file,import.meta.url)));}
  if(route==='/betterCodex-scope-bootstrap.js'){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});const scripts=await Promise.all(scopeSources.map(name=>readFile(new URL('../public/'+name,import.meta.url),'utf8')));return res.end(scripts.join('\n'));}
  if(route==='/codex-web-config.js'){const scope=u.searchParams.get('workspace'),ws=authorized(req,scope,u);const c=await config(ws.id,origin);c.gatewayWsUrl+='?scopeToken='+encodeURIComponent(u.searchParams.get('scopeToken'));return await textResponses.send(req,res,'window.__CODEX_WEB_CONFIG__='+JSON.stringify(c)+';',{'content-type':'text/javascript','cache-control':'no-store'});}
  const scoped=route.match(/^\/w\/(ai|secondary)(\/.*)$/);
  if(scoped){const scope=scoped[1],endpoint=scoped[2],grantMatch=endpoint.match(/^\/api\/local-file\/([A-Za-z0-9_-]{32})\/[^/]+$/);if(grantMatch&&['GET','HEAD'].includes(req.method))return await serveGrantedFile(scope,grantMatch[1],req,res);const ws=authorized(req,scope,u);
   if(req.method==='GET'&&(endpoint==='/api/projects'||/^\/api\/projects\/[a-z0-9-]+$/.test(endpoint)))return json(res,200,await projectData(scope,endpoint.split('/')[3]));
   if(endpoint==='/api/projects/comfyui-video/material-feedback'&&req.method==='POST'){const b=await body(req);return json(res,200,await projectMaterialFeedback(scope,'comfyui-video',b));}
   if(endpoint==='/api/native-cursors'&&req.method==='GET'){const id=u.searchParams.get('threadId');await boundary.checked(workspace(scope),id);const record=nativeCache.get(scope,'history-cursors:'+id);return json(res,200,{cursors:record&&!record.deleted?record.payload:null});}
   if(endpoint==='/api/native-bootstrap'&&req.method==='GET')return json(res,200,await config(scope,origin));
   if(endpoint==='/api/native-read'&&req.method==='POST'){const b=await body(req);return json(res,200,await nativeCache.read(scope,b.method,b.params,{fresh:!!b.fresh}));}
   if(endpoint==='/api/native-catalog'&&req.method==='GET'){const after=Number(u.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)throw fail(400,'缓存游标无效');nativeCache.catalog(scope,{fresh:u.searchParams.get('refresh')==='1'}).catch(()=>{});return json(res,200,{...nativeCache.changes(after,200,scope,'catalog'),status:nativeCache.get(scope,'catalog-status')});}
   if(endpoint==='/api/native-queue'&&req.method==='GET')return json(res,200,u.searchParams.has('commandId')?nativeQueue.requestStatus(scope,u.searchParams.get('commandId')):await nativeQueue.read(scope,u.searchParams.get('threadId')));
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
   if(endpoint==='/api/diagnostics')return json(res,200,{counts:Object.fromEntries([...diagnostics].filter(([key])=>key.startsWith(scope+':'))),fileOperations:fileDiagnostics.snapshot(scope),historyReads:historyReads.filter(e=>e.scope===scope),performance:performanceEvents.filter(e=>e.scope===scope),nativeVersion:nativeVersion(native.initialization)});
   if(endpoint==='/api/request'&&req.method==='POST'){const b=await body(req);return json(res,200,await boundary.call(scope,b.request,{clientId:b.clientId}));}
   throw fail(403,'文件、插件配置及此接口暂未开放');
  }
  if(route.startsWith('/api/')||route==='/ws')throw fail(403,'请求必须携带固定工作区');
  if(!['GET','HEAD'].includes(req.method))throw fail(405,'方法不允许');
  if(['/sw.js','/workbench-sw.js'].includes(route)){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-cache','service-worker-allowed':'/'});if(!localReleaseLoading)localReleaseLoading=nativeUIRelease(upstream).catch(e=>{localReleaseLoading=null;throw e;});const release=await localReleaseLoading;return res.end((await readFile(new URL('../public/official-service-worker.js',import.meta.url),'utf8'))+'\n// betterCodex-native-release:'+release.manifest.version+'\n');}
  // 流式转发保持压缩、ETag 与缓存头；只对导航 HTML 做必要的 scope bootstrap 注入。
  const headers={};for(const k of ['accept','accept-encoding','if-none-match','if-modified-since','range'])if(req.headers[k])headers[k]=req.headers[k];headers.host='127.0.0.1:3082';
  const navigation=!path.extname(route)||route.endsWith('.html');if(navigation)delete headers['accept-encoding'];
  if(route===lastHistoryAssetPrefix+historyClientAsset){if(!lastHistoryAssetLoading)lastHistoryAssetLoading=fetch(upstream+upstreamAssetPrefix+historyClientAsset).then(async r=>{if(!r.ok)throw fail(503,'原生历史模块暂不可用');return patchInitialHistoryBudget(await r.text(),{cacheView:false});}).catch(e=>{lastHistoryAssetLoading=null;throw e;});return textResponses.send(req,res,await lastHistoryAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-betterCodex-edge-cache':'static'});}
  if(route===previousHistoryAssetPrefix+historyClientAsset){if(!previousHistoryAssetLoading)previousHistoryAssetLoading=fetch(upstream+upstreamAssetPrefix+historyClientAsset).then(async r=>{if(!r.ok)throw fail(503,'原生历史模块暂不可用');return patchInitialHistoryBudget(await r.text(),{legacy:true});}).catch(e=>{previousHistoryAssetLoading=null;throw e;});return textResponses.send(req,res,await previousHistoryAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-betterCodex-edge-cache':'static'});}
  if(route===composerHistoryAssetPrefix+historyClientAsset){if(!composerHistoryAssetLoading)composerHistoryAssetLoading=fetch(upstream+upstreamAssetPrefix+historyClientAsset).then(async response=>{if(!response.ok)throw fail(503,'官方历史模块尚未就绪');return patchInitialHistoryBudget(await response.text(),{menuLifecycle:false});}).catch(error=>{composerHistoryAssetLoading=null;throw error;});return await textResponses.send(req,res,await composerHistoryAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-betterCodex-edge-cache':'static'});}
  if(route===menuHistoryAssetPrefix+historyClientAsset){if(!menuHistoryAssetLoading)menuHistoryAssetLoading=fetch(upstream+upstreamAssetPrefix+historyClientAsset).then(async response=>{if(!response.ok)throw fail(503,'官方历史模块尚未就绪');return patchInitialHistoryBudget(await response.text(),{scrollableMenus:false});}).catch(error=>{menuHistoryAssetLoading=null;throw error;});return await textResponses.send(req,res,await menuHistoryAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-betterCodex-edge-cache':'static'});}
  if(route===gestureHistoryAssetPrefix+historyClientAsset){if(!gestureHistoryAssetLoading)gestureHistoryAssetLoading=fetch(upstream+upstreamAssetPrefix+historyClientAsset).then(async response=>{if(!response.ok)throw fail(503,'官方历史模块尚未就绪');return patchInitialHistoryBudget(await response.text());}).catch(error=>{gestureHistoryAssetLoading=null;throw error;});return await textResponses.send(req,res,await gestureHistoryAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-betterCodex-edge-cache':'static'});}
  if(route===historyAssetPrefix+historyClientAsset){if(!historyAssetLoading)historyAssetLoading=fetch(upstream+upstreamAssetPrefix+historyClientAsset).then(async response=>{if(!response.ok)throw fail(503,'官方历史模块尚未就绪');return patchInitialHistoryBudget(await response.text(),{compactFilePreview:true});}).catch(error=>{historyAssetLoading=null;throw error;});return await textResponses.send(req,res,await historyAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-betterCodex-edge-cache':'static'});}
  if(route===historyAssetPrefix+filePreviewClientAsset){if(!filePreviewAssetLoading)filePreviewAssetLoading=fetch(upstream+upstreamAssetPrefix+filePreviewClientAsset).then(async response=>{if(!response.ok)throw fail(503,'官方历史模块尚未就绪');return patchFilePreviewChrome(await response.text());}).catch(error=>{filePreviewAssetLoading=null;throw error;});return await textResponses.send(req,res,await filePreviewAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-betterCodex-edge-cache':'static'});}
  if(route===previousHistoryAssetPrefix+followUpClientAsset){if(!legacyFollowUpAssetLoading)legacyFollowUpAssetLoading=fetch(upstream+upstreamAssetPrefix+followUpClientAsset).then(async response=>{if(!response.ok)throw fail(503,'原生输入模块尚未就绪');return patchFollowUpControls(await response.text(),{legacy:true});}).catch(error=>{legacyFollowUpAssetLoading=null;throw error;});return await textResponses.send(req,res,await legacyFollowUpAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-betterCodex-edge-cache':'static'});}
  if(route===draftFollowUpAssetPrefix+followUpClientAsset){if(!draftFollowUpAssetLoading)draftFollowUpAssetLoading=fetch(upstream+upstreamAssetPrefix+followUpClientAsset).then(async r=>{if(!r.ok)throw fail(503,'原生输入模块暂不可用');return patchFollowUpControls(await r.text(),{retainedDrafts:false});}).catch(e=>{draftFollowUpAssetLoading=null;throw e;});return textResponses.send(req,res,await draftFollowUpAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-betterCodex-edge-cache':'static'});}
  if(route===lastFollowUpAssetPrefix+followUpClientAsset){if(!lastFollowUpAssetLoading)lastFollowUpAssetLoading=fetch(upstream+upstreamAssetPrefix+followUpClientAsset).then(async r=>{if(!r.ok)throw fail(503,'原生输入模块暂不可用');return patchFollowUpControls(await r.text(),{cacheDrafts:false});}).catch(e=>{lastFollowUpAssetLoading=null;throw e;});return textResponses.send(req,res,await lastFollowUpAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-betterCodex-edge-cache':'static'});}
  if(route===previousFollowUpAssetPrefix+followUpClientAsset){if(!previousFollowUpAssetLoading)previousFollowUpAssetLoading=fetch(upstream+upstreamAssetPrefix+followUpClientAsset).then(async response=>{if(!response.ok)throw fail(503,'原生输入模块尚未就绪');return patchFollowUpControls(await response.text(),{previous:true});}).catch(error=>{previousFollowUpAssetLoading=null;throw error;});return await textResponses.send(req,res,await previousFollowUpAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-betterCodex-edge-cache':'static'});}
  if(route===retainedFollowUpAssetPrefix+followUpClientAsset){const response=await fetch(upstream+upstreamAssetPrefix+followUpClientAsset);if(!response.ok)throw fail(503,'原生输入模块尚未就绪');return textResponses.send(req,res,patchFollowUpControls(await response.text(),{modeSwitch:false}),{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-betterCodex-edge-cache':'static'});}
  if(route===followUpAssetPrefix+followUpClientAsset){if(!followUpAssetLoading)followUpAssetLoading=fetch(upstream+upstreamAssetPrefix+followUpClientAsset).then(async response=>{if(!response.ok)throw fail(503,'原生输入模块尚未就绪');return patchFollowUpControls(await response.text());}).catch(error=>{followUpAssetLoading=null,legacyFollowUpAssetLoading=null;throw error;});return await textResponses.send(req,res,await followUpAssetLoading,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=31536000, immutable','x-betterCodex-edge-cache':'static'});}
  const versionPrefix=[historyAssetPrefix,gestureHistoryAssetPrefix,menuHistoryAssetPrefix,composerHistoryAssetPrefix,lastHistoryAssetPrefix,previousHistoryAssetPrefix,followUpAssetPrefix,retainedFollowUpAssetPrefix,draftFollowUpAssetPrefix,lastFollowUpAssetPrefix,previousFollowUpAssetPrefix].find(prefix=>route.startsWith(prefix)),proxyRoute=versionPrefix?upstreamAssetPrefix+route.slice(versionPrefix.length):route;
  const upstreamReq=http.request(upstream+(navigation?'/':proxyRoute+u.search),{method:req.method,headers},r=>{
   const h=endToEndHeaders(r.headers);delete h['set-cookie'];
   // The pinned versioned renderer assets are immutable. Its development
   // server's no-store default must not force every device/cloud read upstream.
   if(r.statusCode===200&&/^\/official-patched-v\d+\/assets\/[^/]+\.(?:js|css|woff2?|png|svg)$/.test(route)&&!/(?:text\/html|application\/json)/.test(String(h['content-type']))){h['cache-control']='private, max-age=31536000, immutable';h['x-betterCodex-edge-cache']='static';}
   if(String(h['content-type']).includes('text/html')&&r.statusCode===200){let chunks=[];r.on('data',b=>chunks.push(b));r.on('end',()=>{try{const scope=u.searchParams.get('workspace')||'ai',ws=workspace(scope),t=token(ws);let html=patchNativeModulePreloads(Buffer.concat(chunks).toString()).replace(/<meta\b[^>]*\bname\s*=\s*(['"])(?:viewport|theme-color|color-scheme)\1[^>]*>/gi,'');html=html.replace('<head>',`<head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#ffffff"><style>html,body{background:#fff}@media(prefers-color-scheme:dark){html,body{background:#000}}html[data-betterCodex-theme="dark"],html[data-betterCodex-theme="dark"] body{background:#000}html[data-betterCodex-theme="light"],html[data-betterCodex-theme="light"] body{background:#fff}</style><meta name="initial-route" content="${/^\/local\/[0-9a-f-]{36}$/i.test(route)?route:'/'}"><script>window.__BETTER_CODEX_SCOPE__=${JSON.stringify({id:scope,token:t,nativeList:u.searchParams.get("nativeList")==="1"})};</script><script src="/betterCodex-scope-bootstrap.js"></script><link rel="stylesheet" href="/betterCodex-pwa.css"><script defer src="/betterCodex-pwa.js"></script>`).replaceAll('/manifest.webmanifest','/manifest.webmanifest?workspace='+scope).replaceAll('/codex-web-config.js',`/codex-web-config.js?workspace=${scope}&amp;scopeToken=${t}`);delete h['content-length'];delete h.etag;h['cache-control']='no-store';res.writeHead(200,h);res.end(html);}catch(e){json(res,statusOf(e),{error:e.message});}});
   }else{res.writeHead(r.statusCode,h);r.pipe(res);}
  });upstreamReq.on('error',()=>{if(!res.headersSent)json(res,503,{error:'官方界面正在恢复'});else res.destroy();});res.on('close',()=>{if(!res.writableEnded)upstreamReq.destroy();});upstreamReq.end();
 }catch(e){if(!res.headersSent)json(res,statusOf(e),{error:e.code?e.message:'服务暂不可用'});else res.end();}});
 function cleanupClient(ws){
  git.close(ws);
  for(const c of clients)if(c!==ws&&c.scope===ws.scope&&c.viewServices)c.viewServices.clientCoordination.clientStatusChanged({sourceClientId:ws.pageId,params:{clientId:ws.pageId,clientType:'electron',isSelf:false,status:'disconnected'}}).catch(()=>{});
  for(const[id,p]of browserActions)if(p.client===ws){clearTimeout(p.timer);browserActions.delete(id);p.reject(fail(409,'页面已断开'));}
  clients.delete(ws);if(clientById.get(ws.scope+':'+ws.pageId)===ws)clientById.delete(ws.scope+':'+ws.pageId);
  for(const p of ws.ports.values())p.close();for(const close of ws.cleanup||[])close();ws.cleanup?.clear();
 }
 const wss=new WebSocketServer({noServer:true,maxPayload:29*1024*1024,perMessageDeflate:{threshold:1024,serverNoContextTakeover:true,clientNoContextTakeover:true,concurrencyLimit:2,zlibDeflateOptions:{level:3}}});
 server.on('upgrade',(req,socket,head)=>{try{
  const u=new URL(req.url,'http://'+req.headers.host),m=u.pathname.match(/^\/w\/(ai|secondary)\/ws$/);if(!m)throw fail(403,'scope missing');
  const scope=m[1];authorized(req,scope,u);const origin=req.headers.origin;if(origin&&!allowedOrigins().includes(origin))throw fail(403,'origin');
  wss.handleUpgrade(req,socket,head,wire=>{
   let ws=wire,handshaken=false;Object.assign(ws,{scope,ports:new Map(),origin:origin||`http://127.0.0.1:${boundPort()}`,stableId:'',pageId:''});
   wire.on('message',raw=>{Promise.resolve().then(async()=>{
    const m=JSON.parse(raw);
    if(m.type==='hello'){
     if(handshaken)throw fail(400,'重复身份握手');
     if(typeof m.clientId!=='string'||m.clientId.length>160)throw fail(400,'invalid client');
     const stableId=typeof m.betterCodexClientId==='string'&&m.betterCodexClientId.length<=160?m.betterCodexClientId:m.clientId;
     let resumed=false;
     if(m.betterCodexProtocol===PAGE_RESUME_PROTOCOL){
      try{({session:ws,resumed}=pageSessions.attach(wire,{scope,pageId:m.clientId,stableId,origin:ws.origin,resumeId:m.betterCodexResumeId,ack:m.betterCodexAck??0}));}
      catch{wire.send(JSON.stringify({type:'betterCodex:resume-unavailable',reason:'page_resume_unavailable'}));wire.close(4009,'page resume unavailable');return;}
     }else{ws.pageId=m.clientId;ws.stableId=stableId;}
     handshaken=true;if(resumed)ws.needsCatchup=false;clients.add(ws);clientById.set(scope+':'+ws.pageId,ws);
     const ack={type:'hello-ack',clientId:m.clientId,...(ws.resumeId?{betterCodexProtocol:PAGE_RESUME_PROTOCOL,betterCodexResumeId:ws.resumeId,betterCodexResumed:resumed,betterCodexReceivedSeq:ws.receivedSeq}:{})};
     if(ws.resumeId){pageSessions.control(ws,ack);pageSessions.replay(ws);}else send(ws,ack);
     await syncClient(ws,{recover:resumed});return;
    }
    if(!handshaken)throw fail(403,'hello required');
    if(ws.resumeId){
     if(ws.wire!==wire)return;
     if(m.type==='betterCodex:ack'){pageSessions.acknowledge(ws,m.seq);if(ws.needsCatchup&&!ws.catchingUp&&ws.bytes<1024*1024){ws.needsCatchup=false;ws.catchingUp=syncClient(ws,{recover:true}).catch(()=>{ws.needsCatchup=true;}).finally(()=>{ws.catchingUp=null;});}return;}
     if(m.type!=='betterCodex:ping'&&m.type!=='betterCodex:sync'){
      const first=pageSessions.accept(ws,m.betterCodexClientSeq);pageSessions.control(ws,{type:'betterCodex:ack',seq:ws.receivedSeq});if(!first)return;
     }
    }
    if(m.type==='betterCodex:ping'){const pong={type:'betterCodex:pong',nonce:m.nonce};if(ws.resumeId)pageSessions.control(ws,pong);else send(ws,pong);return;}
    if(m.type==='betterCodex:browser-action-result'){const pending=browserActions.get(m.requestId);if(pending?.client!==ws)throw fail(403,'页面操作不匹配');clearTimeout(pending.timer);browserActions.delete(m.requestId);m.ok?pending.resolve(m.result):pending.reject(fail(400,typeof m.error==='string'?m.error.slice(0,200):'页面操作失败'));return;}
    if(m.type==='betterCodex:sync'){await syncClient(ws,{recover:!!m.recoverConversation});return;}
    if(m.type==='app-host-connect'){if(ws.ports.has(m.portId))send(ws,{type:'app-host-port-connected',portId:m.portId});else appHost(ws,m.portId);return;}
    if(m.type==='app-host-port-message'){const data=codec.decodeMessageData(m);if(data==null){ws.ports.get(m.portId)?.close();ws.ports.delete(m.portId);}else appHost(ws,m.portId).receive(data);return;}
    if(m.type==='opencodex:ipc-invoke'){try{const value=await invoke(scope,m.request,ws);send(ws,{type:'opencodex:ipc-result',requestId:m.requestId,ok:true,value});}catch(e){send(ws,{type:'opencodex:ipc-result',requestId:m.requestId,ok:false,status:statusOf(e),error:e.message});}return;}
    throw fail(403,'unsupported frame');
   }).catch(e=>{if(ws.resumeId&&/^page_/.test(e.message)){pageSessions.expire(ws,'page_protocol_error');return;}send(ws,{type:'betterCodex:error',status:statusOf(e),error:e.code?e.message:'无效协议帧'});});});
   wire.on('close',()=>{if(ws.resumeId){pageSessions.detach(ws,wire);}else cleanupClient(ws);});
  });
 }catch{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');}});
 const onNative=m=>{boundary.observe(m);for(const scope of ['ai','secondary']){const prev=eventQueues.get(scope)||Promise.resolve();eventQueues.set(scope,prev.then(async()=>{const filtered=await boundary.notification(scope,m);if(!filtered)return;sequence[scope]++;for(const ws of clients)if(ws.scope===scope&&ws.pageId){if(!wantsNativeNotification(ws,m,boundary.threads)){trace(scope,'stream-filtered',m.method);continue;}emit(ws,m.id===undefined?{type:'mcp-notification',hostId:'local',method:m.method,params:m.params}:{type:'mcp-request',hostId:'local',request:m});}}).catch(()=>{}));}};
 native.on('notification',onNative);native.on('request',onNative);let reconnecting=false;
 native.on('interrupted',()=>{reconnecting=true;for(const ws of clients){ws.ownedThreads?.clear();emit(ws,{type:'codex-app-server-connection-changed',hostId:'local',state:'disconnected',transport:'websocket',isSnapshot:false});send(ws,{type:'betterCodex:sync-state',epoch,seq:sequence[ws.scope],hostState:'disconnected'});}});
 native.on('ready',()=>{if(!reconnecting)return;reconnecting=false;for(const ws of clients)if(ws.pageId){emitInitialization(ws,{isSnapshot:false});syncClient(ws).catch(()=>{});}});
 await native.start();
 return {server,boundary,native,journal,async close(){pageSessions.close();for(const ws of clients)ws.close();wss.close();native.close();await new Promise(r=>server.close(r));await store.flush();await cacheEvents;nativeCache.close();journal.close();}};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){const port=Number(process.env.PORT||3084),front=await createOfficialFront({port,stateDir:process.env.BETTER_CODEX_OFFICIAL_STATE_DIR,publicOrigin:process.env.BETTER_CODEX_OFFICIAL_PUBLIC_ORIGIN||null});front.server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({service:'official-codex-front',port,pid:process.pid})));for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await front.close();process.exit(0);});}

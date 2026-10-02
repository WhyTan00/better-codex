// 官方脚本之前安装固定 scope 的 I/O/缓存命名空间；不修改官方布局和组件。
(()=>{const scope=window.__DSH_SCOPE__;if(!scope)return;const prefix='dsh-official:'+scope.id+':';const rawGet=Storage.prototype.getItem,rawSet=Storage.prototype.setItem,rawRemove=Storage.prototype.removeItem;let client=rawGet.call(sessionStorage,prefix+'client');if(!client){client=crypto.randomUUID();rawSet.call(sessionStorage,prefix+'client',client);}
 window.__DSH_STORAGE_PREFIX__=prefix;
 const local=localStorage,session=sessionStorage,rawClear=Storage.prototype.clear;const scoped=s=>s===local||s===session;
 Storage.prototype.getItem=function(key){return rawGet.call(this,scoped(this)?prefix+key:key);};
 Storage.prototype.setItem=function(key,value){return rawSet.call(this,scoped(this)?prefix+key:key,value);};
 Storage.prototype.removeItem=function(key){return rawRemove.call(this,scoped(this)?prefix+key:key);};
 Storage.prototype.clear=function(){if(!scoped(this))return rawClear.call(this);for(const key of Object.keys(this))if(key.startsWith(prefix))rawRemove.call(this,key);};
 function connectionTrace(values){try{if(window.__DSH_CLIENT_LOG__)window.__DSH_CLIENT_LOG__.event('transport',values);else{const rows=window.__DSH_EARLY_CONNECTION_EVENTS__||=[];rows.push(values);if(rows.length>40)rows.shift();}}catch{}}
 let loginRequired=false,credentialRevision=0;
 function recoverLogin(){if(loginRequired)return;connectionTrace({component:'scope-session',stage:'failed',reason:'auth_required',failureClass:'auth',count:credentialRevision});window.dispatchEvent(new Event('dsh:authentication-required'));loginRequired=true;blocked=true;window.__DSH_CONNECTION_PAUSED__=true;window.__DSH_PAGE_NAVIGATION_DIAGNOSTICS__?.authRequired();connectionStatus('unavailable');}
 // A read rejection is not proof that the current login is invalid. Only the
 // authoritative scope check may retire control; a late read cannot supersede
 // a successful newer credential generation. Never replay a write.
 function checkReadAuthentication(revision,source){
  connectionTrace({component:'native-http',stage:'failed',reason:revision===credentialRevision?'auth_required':'session_replaced',failureClass:'auth',routeClass:source,count:revision});
  if(revision!==credentialRevision||loginRequired)return;
  void renewScope();
 }
 const originalFetch=window.fetch.bind(window);const SCOPE_RENEWAL_DEADLINE_MS=15000,HANDSHAKE_DEADLINE_MS=15000;let operationGeneration=0;
 function deadlineOperation(kind,ms,onDeadline){const operation={kind,generation:++operationGeneration,done:false,timedOut:false,timer:null,timerGeneration:0};operation.arm=budget=>{if(operation.done)return;if(operation.timer!==null)clearTimeout(operation.timer);const timerGeneration=++operation.timerGeneration;operation.timer=setTimeout(()=>{if(operation.done||timerGeneration!==operation.timerGeneration)return;operation.timer=null;operation.done=true;operation.timedOut=true;onDeadline(operation);},budget);};operation.pause=()=>{if(operation.done)return;if(operation.timer!==null)clearTimeout(operation.timer);operation.timer=null;operation.timerGeneration++;};operation.cleanup=()=>{if(operation.timer!==null)clearTimeout(operation.timer);operation.timer=null;operation.timerGeneration++;operation.done=true;};if(Number.isFinite(ms)&&ms>0)operation.arm(ms);return operation;}
 async function connectionJSON(url,init={},timeoutMs=SCOPE_RENEWAL_DEADLINE_MS){const at=performance.now(),component=String(url).startsWith('/dsh-scope-session')?'scope-session':'native-http';let statusCode=0,timeoutReject,controller=null;try{if(typeof AbortController==='function')controller=new AbortController();}catch{}
  const budget=Number.isFinite(timeoutMs)&&timeoutMs>0?timeoutMs:SCOPE_RENEWAL_DEADLINE_MS;const deadline=deadlineOperation('connection-json',budget,operation=>{connectionTrace({component,stage:'pending',reason:'timeout',statusCode,durationMs:Math.round(performance.now()-at)});const error=Error('connection JSON timed out');error.code='DSH_CONNECTION_JSON_TIMEOUT';timeoutReject?.(error);try{controller?.abort(error);}catch{}});
  const timeout=new Promise((_,reject)=>{timeoutReject=reject;});const requestInit={...init},callerSignal=init.signal;let cancel;const canceled=new Promise((_,reject)=>{cancel=()=>{try{controller?.abort(callerSignal?.reason);}catch{}reject(callerSignal?.reason||Object.assign(Error('读取已取消'),{name:'AbortError'}));};});if(controller)requestInit.signal=controller.signal;
  try{if(callerSignal?.aborted)throw callerSignal.reason||Object.assign(Error('读取已取消'),{name:'AbortError'});callerSignal?.addEventListener('abort',cancel,{once:true});const response=await Promise.race([originalFetch(url,requestInit),timeout,canceled]);statusCode=response.status;if(response.type==='opaqueredirect'||response.status===401||response.status===302||response.status===303||response.ok===false||response.status>=400)return {response,data:null};const data=await Promise.race([response.json(),timeout,canceled]);return {response,data};}catch(error){connectionTrace({component,stage:'failed',reason:error?.code==='DSH_CONNECTION_JSON_TIMEOUT'?'timeout':'upstream_failure',statusCode,durationMs:Math.round(performance.now()-at)});throw error;}finally{callerSignal?.removeEventListener('abort',cancel);deadline.cleanup();}}
 window.__DSH_CONNECTION_JSON__=connectionJSON;window.fetch=async(input,init={})=>{const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin===location.origin&&url.pathname.startsWith('/api/')){url.pathname='/w/'+scope.id+url.pathname;input=input instanceof Request?new Request(url.href,input):url.href;}if(url.origin===location.origin&&url.pathname.startsWith('/w/'+scope.id+'/')){if(!scope.token)await renewScope();const headers=new Headers(init.headers||(input instanceof Request?input.headers:undefined));headers.set('x-dsh-scope',scope.token);init={...init,headers};}const protectedAPI=url.origin===location.origin&&(url.pathname.startsWith('/w/'+scope.id+'/')||url.pathname==='/dsh-scope-session');if(protectedAPI)init={...init,redirect:'manual'};const requestCredentialRevision=credentialRevision;return originalFetch(input,init).then(async r=>{if(!protectedAPI)return r;if(r.type==='opaqueredirect'||r.status===303||r.status===302){checkReadAuthentication(requestCredentialRevision,'other');return r;}if(r.status===401){if(url.pathname==='/dsh-scope-session'){checkReadAuthentication(requestCredentialRevision,'scope_session');return r;}const renewed=requestCredentialRevision!==credentialRevision||await renewScope(),method=(init.method||(input instanceof Request?input.method:'GET')).toUpperCase();if(renewed&&['GET','HEAD'].includes(method)){const headers=new Headers(init.headers);headers.set('x-dsh-scope',scope.token);return originalFetch(input,{...init,headers});}}return r;});};
 let renewal=null;function renewScope(){if(renewal)return renewal.promise;const at=performance.now();let statusCode=0;const traceId=crypto.randomUUID(),init={cache:'no-store',redirect:'manual',headers:{'x-dsh-diagnostic-trace':traceId}},renewalOperation={promise:null};renewal=renewalOperation;
  renewalOperation.promise=(async()=>{try{connectionTrace({component:'scope-session',stage:'attempt',reason:'request_start',traceId,count:credentialRevision});
   const nativeControl=window.__DSH_ANDROID_BRIDGE__?.scopeSession;
   const result=nativeControl?await nativeControl({traceId}).then(value=>({response:{status:value.status,ok:value.status===200,type:'basic'},data:value.data})):await window.__DSH_CONNECTION_JSON__('/dsh-scope-session?workspace='+encodeURIComponent(scope.id),init,SCOPE_RENEWAL_DEADLINE_MS),r=result.response;statusCode=r.status;if(r.type==='opaqueredirect'||[301,302,303,307,308,401].includes(r.status)){recoverLogin();throw Error('login expired');}if(!r.ok)throw Error('scope renewal unavailable');const next=result.data;if(renewal!==renewalOperation)throw Error('stale scope renewal');if(next.id!==scope.id||(typeof next.token!=='string'||!next.token))throw Error('invalid scope renewal');scope.token=next.token;if(next.portable===true&&Array.isArray(next.workspaces)){scope.portable=true;scope.label=next.label;scope.workspaces=next.workspaces;}credentialRevision++;window.dispatchEvent(new Event('dsh:scope-renewed'));connectionTrace({component:'scope-session',stage:'received',reason:'scope_renewal_ok',traceId,statusCode,durationMs:Math.round(performance.now()-at)});return true;}catch(error){connectionTrace({component:'scope-session',stage:'failed',reason:'scope_renewal_failed',traceId,failureClass:error?.code==='DSH_CONNECTION_JSON_TIMEOUT'?'timeout':'connection',statusCode,durationMs:Math.round(performance.now()-at)});return false;}finally{if(renewal===renewalOperation)renewal=null;}})();return renewalOperation.promise;}

 window.__DSH_RENEW_SCOPE__=renewScope;

 // Keep the renderer and its AppHost session alive across socket replacement.
 // The server acknowledges transport sequence numbers; a resumed session never
 // executes an already accepted Prompt/approval twice. A new host is never
 // given unacknowledged messages from an old session.
 const NativeWS=window.WebSocket,sockets=new Set(),outbound=new Map();
 let resumeId=null,serverSeq=0,clientSeq=0,outboundBytes=0,observedEpoch=null;
 let frozen=false,wasHidden=false,activeTasks=false,blocked=false,heartbeatTimer=null,syncing=null;
 let generation=0,rebuilding=null,rebuildAttempts=[],hostNeedsRecreation=false;
 const BULK_READ_PROTOCOL='dsh-bulk-read-v1',BULK_READ_DEADLINE_MS=30000,bulkMethods=new Set(['app/list','mcpServerStatus/list','thread/list']),bulkWaiters=new Set(),bulkOperations=new Set();let bulkAuthBlocked=false;
 const bulkError=(message,status=503)=>Object.assign(Error(message),{status,statusCode:status});
 const bulkDeadline=at=>Math.min(Number.isFinite(at)?at:Infinity,Date.now()+BULK_READ_DEADLINE_MS),bulkTimeout=()=>Object.assign(bulkError('目录读取超时',504),{code:'DSH_CONNECTION_JSON_TIMEOUT'});
 function bulkState(){const wire=[...sockets].reverse().find(ws=>ws.__dshGeneration===generation&&ws.readyState===1&&ws.__dshHelloReceived);if(!wire)return null;if(wire.__dshBulkReadProtocol!==BULK_READ_PROTOCOL)return {supported:false,wire};return wire.__dshNativeConnected&&Number.isSafeInteger(wire.__dshNativeGeneration)&&wire.__dshFrontEpoch?{supported:true,wire}:null;}
 function refreshBulkState(error){const state=bulkAuthBlocked||blocked||loginRequired?null:bulkState();window.__DSH_BULK_READ_HTTP_READY__=window.__DSH_APP_CATALOG_HTTP_READY__=state?.supported===true;for(const waiter of [...bulkWaiters]){if(error)waiter.finish(error);else if(state)waiter.finish(null,state.supported);}}
 function cancelBulkReads(error,wire){for(const operation of bulkOperations)if(!wire||operation.wire===wire)operation.controller.abort(error);for(const waiter of [...bulkWaiters])if(!wire||waiter.wire===wire)waiter.finish(error);refreshBulkState();}
 window.__DSH_BULK_READ_HTTP_READY__=window.__DSH_APP_CATALOG_HTTP_READY__=false;
 // Negotiation occurs before the existing gateway waits for its hello ACK.
 // Unknown capability must not send the first large catalog onto the old lane.
 window.__DSH_WAIT_BULK_READ_HTTP__=({signal,deadlineAt}={})=>{
  if(signal?.aborted)return Promise.reject(signal.reason||Object.assign(Error('读取已取消'),{name:'AbortError'}));
  if(bulkAuthBlocked||blocked||loginRequired)return Promise.reject(bulkError('目录读取连接暂不可用'));
  const remaining=bulkDeadline(deadlineAt)-Date.now();if(remaining<=0)return Promise.reject(bulkTimeout());
  const state=bulkState();if(state)return Promise.resolve(state.supported);
  return new Promise((resolve,reject)=>{let done=false,timer=null;const waiter={wire:[...sockets].reverse().find(ws=>ws.__dshGeneration===generation&&ws.readyState<=1),finish(error,value){if(done)return;done=true;clearTimeout(timer);bulkWaiters.delete(waiter);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);}},abort=()=>waiter.finish(signal.reason||Object.assign(Error('读取已取消'),{name:'AbortError'}));bulkWaiters.add(waiter);timer=setTimeout(()=>waiter.finish(bulkTimeout()),remaining);signal?.addEventListener('abort',abort,{once:true});});
 };
 window.__DSH_READ_BULK_RPC__=async(method,params={},options={})=>{
  if(!bulkMethods.has(method))throw bulkError('此读取通道不接受执行请求',403);
  const deadlineAt=bulkDeadline(options.deadlineAt);
  if(!await window.__DSH_WAIT_BULK_READ_HTTP__({signal:options.signal,deadlineAt}))throw bulkError('此版本尚未提供目录读取通道');
  const state=bulkState(),wire=state?.wire;if(!state?.supported)throw bulkError('目录读取连接已更换');
  const identity={wire,generation,resumeId,credentialRevision,epoch:wire.__dshFrontEpoch,nativeGeneration:wire.__dshNativeGeneration},controller=new AbortController(),operation={wire,controller},abort=()=>controller.abort(options.signal?.reason||Object.assign(Error('读取已取消'),{name:'AbortError'}));
  const current=()=>!bulkAuthBlocked&&!blocked&&!loginRequired&&generation===identity.generation&&sockets.has(wire)&&wire.readyState===1&&wire.__dshNativeConnected&&resumeId===identity.resumeId&&wire.__dshFrontEpoch===identity.epoch&&wire.__dshNativeGeneration===identity.nativeGeneration;
  if(options.signal?.aborted)throw options.signal.reason||Object.assign(Error('读取已取消'),{name:'AbortError'});options.signal?.addEventListener('abort',abort,{once:true});bulkOperations.add(operation);
  try{
   if(!current())throw bulkError('目录读取连接已更换');
   const requestId=crypto.randomUUID(),url=new URL('/w/'+scope.id+'/api/bulk-read',location.origin);url.searchParams.set('method',method);url.searchParams.set('params',JSON.stringify(params));url.searchParams.set('requestId',requestId);if(options.fresh)url.searchParams.set('fresh','1');
   const headers={'x-dsh-scope':scope.token,'x-dsh-page-id':wire.__dshPageId,'x-dsh-page-resume':identity.resumeId,'x-dsh-client-id':client,'x-dsh-connection-id':wire.__dshDiagnosticId,'x-dsh-front-epoch':identity.epoch,'x-dsh-native-generation':String(identity.nativeGeneration),...(method==='app/list'&&options.ifNoneMatch?{'if-none-match':options.ifNoneMatch}:{})};
   // originalFetch inside connectionJSON cannot be redirected by the history
   // cache's /sync/v1 transport. Negotiation, cache validation and HTTP/body
   // share the existing read deadline; entering another phase never resets it.
   const remaining=deadlineAt-Date.now();if(remaining<=0)throw bulkTimeout();
   const {response,data}=await connectionJSON(url.href,{method:'GET',headers,cache:'no-store',redirect:'manual',signal:controller.signal},remaining);
   if(!current()||controller.signal.aborted)throw controller.signal.reason||bulkError('目录读取连接已更换');
   if(response.status===401||response.type==='opaqueredirect'||[302,303].includes(response.status)){checkReadAuthentication(identity.credentialRevision,'native_catalog');throw bulkError('目录鉴权需要重新核实',401);}
   if(!current()||controller.signal.aborted)throw controller.signal.reason||bulkError('目录读取连接已更换');
   if(Date.now()>=deadlineAt)throw bulkTimeout();
   if(response.status!==200&&response.status!==304)throw bulkError('目录读取暂不可用',response.status||503);
   if(response.headers.get('x-dsh-read-id')!==requestId||response.headers.get('x-dsh-front-epoch')!==identity.epoch||response.headers.get('x-dsh-native-generation')!==String(identity.nativeGeneration))throw bulkError('目录读取身份不匹配');
   const etag=response.headers.get('etag');
   if(response.status===304){if(method!=='app/list'||!options.ifNoneMatch||etag!==options.ifNoneMatch)throw bulkError('目录缓存版本不匹配');return {status:304,etag};}
   if(!data||data.requestId!==requestId||data.epoch!==identity.epoch||data.nativeGeneration!==identity.nativeGeneration||data.status!==200)throw bulkError('目录读取响应无效');
   if(data.error)throw Object.assign(bulkError(data.error.message,data.error.data?.status||502),{rpcCode:data.error.code});
   return {status:200,...(etag?{etag}:{}),result:data.result};
  }finally{options.signal?.removeEventListener('abort',abort);bulkOperations.delete(operation);}
 };
 window.__DSH_READ_APP_CATALOG__=(params,options)=>window.__DSH_READ_BULK_RPC__('app/list',params,options);
 addEventListener('dsh:authentication-required',()=>{bulkAuthBlocked=true;cancelBulkReads(bulkError('请重新登录',401));});
 let connectionState='connected',statusTimer=null,statusNode=null,lastSyncAt=0,recoveryStartedAt=null;
 function connectionStatus(state,{silent=false,reason}={}){
  if(loginRequired)state='unavailable';
  connectionState=state;
  if(state==='unavailable')window.__DSH_CONNECTION_PAUSED__=true;
  if(state!=='connected'&&document.visibilityState==='visible'&&recoveryStartedAt===null)recoveryStartedAt=Date.now();const durationMs=state==='connected'&&recoveryStartedAt!==null?Date.now()-recoveryStartedAt:undefined;if(state==='connected')recoveryStartedAt=null;
  window.__DSH_PERF__?.event('transport',{reason:state,openSockets:sockets.size,...(durationMs===undefined?{}:{durationMs})});
  const transportConnected=[...sockets].some(ws=>ws.readyState===1&&ws.__dshHelloReceived);
  window.dispatchEvent(new CustomEvent('dsh:connection-state',{detail:{state,reason,transportConnected}}));
  clearTimeout(statusTimer);
  if(state==='connected'||silent){if(silent)connectionTrace({component:'page-ws',stage:'skipped',reason:reason||'visible',transportConnected});if(statusNode)connectionTrace({component:'page-ws',stage:'settled',reason:reason||'native_ready',durationMs:Date.now()-(Number(statusNode.dataset.shownAt)||Date.now()),transportConnected});statusNode?.remove();statusNode=null;return;}
  if(!document.createElement)return;
  statusTimer=setTimeout(()=>{
   if(!statusNode){statusNode=document.createElement('div');statusNode.setAttribute('role','status');statusNode.className='dsh-connection-status';document.body?.append(statusNode);}
   statusNode.dataset.dshNeedsAction=state==='unavailable'?'1':'0';
   statusNode.dataset.shownAt=String(Date.now());
   statusNode.textContent=loginRequired?'登录已过期':state==='unavailable'?'连接暂不可用':state==='syncing'?'同步中…':'连接中…';
   connectionTrace({component:'page-ws',stage:'shown',reason:reason||(state==='syncing'?'native':'client_reconnect'),transportConnected});
   if(state==='unavailable'){
    const retry=document.createElement('button');retry.type='button';retry.textContent=loginRequired?'重新登录':'重新连接';
    retry.addEventListener('click',()=>{if(loginRequired)location.replace(location.pathname+location.search);else rebuildConnection(true);});statusNode.append(retry);
   }
  },400);
 }
 function rebuildConnection(manual=false,scopeReady=false){
  if(rebuilding)return rebuilding;connectionTrace({component:'page-ws',stage:'reconnecting',reason:'session_replaced',attempt:rebuildAttempts.length});
  rebuildAttempts=manual?[]:rebuildAttempts.filter(at=>Date.now()-at<30000);
  if(rebuildAttempts.length>=2){blocked=true;connectionStatus('unavailable');return;}
  if(typeof window.__DSH_RESET_BROWSER_PORTS__!=='function'||typeof window.__DSH_RECREATE_APP_HOST__!=='function'){blocked=true;connectionStatus('unavailable');return;}
  rebuildAttempts.push(Date.now());
  rebuilding=(async()=>{
   const rebuildGeneration=++generation;blocked=true;window.__DSH_CONNECTION_PAUSED__=true;connectionStatus('syncing');
   // Never replay messages into a replacement server session. Drop the old
   // transport only, rebuild the original native AppHost, then read history.
   hostNeedsRecreation=true;window.__DSH_RESET_APP_HOST__?.();window.__DSH_RESET_BROWSER_PORTS__();outbound.clear();outboundBytes=0;clientSeq=0;serverSeq=0;resumeId=null;
   for(const ws of sockets)ws.close(4000,'page session replacement');
   const renewed=scopeReady||await renewScope();if(!renewed||loginRequired||rebuildGeneration!==generation){blocked=true;window.__DSH_CONNECTION_PAUSED__=true;connectionStatus('unavailable');return;}
   blocked=false;window.__DSH_CONNECTION_PAUSED__=false;
   window.__DSH_RECONNECT_TRANSPORT__?.();
   await window.__DSH_RECREATE_APP_HOST__();
   if(rebuildGeneration!==generation||loginRequired)return;
   hostNeedsRecreation=false;wasHidden=true;await sync();
  })().catch(()=>{blocked=true;connectionStatus('unavailable');}).finally(()=>{rebuilding=null;});return rebuilding;
 }
 function acknowledgeClient(seq){
  if(!Number.isSafeInteger(seq)||seq<0||seq>clientSeq)throw Error('invalid transport acknowledgement');
  for(const [id,frame] of outbound){if(id>seq)break;outboundBytes-=frame.bytes;outbound.delete(id);}
 }
 function control(ws,value){if(ws.readyState===1)NativeWS.prototype.send.call(ws,JSON.stringify(value));}
 function pauseHeartbeat(){clearTimeout(heartbeatTimer);for(const ws of sockets){clearTimeout(ws.__dshPingTimer);ws.__dshPingTimer=null;ws.__dshPingNonce=null;}}
 function heartbeat(){
  clearTimeout(heartbeatTimer);if(blocked||frozen||navigator.onLine===false)return;
  for(const ws of sockets)if(ws.readyState===1&&ws.__dshHelloReceived&&ws.__dshNegotiated){
   // A half-open socket can still say OPEN after the phone changes networks.
   // Hidden pages keep a best-effort heartbeat while the browser permits it.
   // Only a visible page uses a deadline: throttling must not kill a healthy socket.
   if(document.visibilityState!=='visible'){control(ws,{type:'dsh:ping',nonce:crypto.randomUUID()});continue;}
   // Probe on foreground; a missed response replaces only that socket.
   if(!ws.__dshPingTimer){const nonce=crypto.randomUUID();ws.__dshPingNonce=nonce;control(ws,{type:'dsh:ping',nonce});
    ws.__dshPingTimer=setTimeout(()=>{ws.__dshPingTimer=null;if(document.visibilityState==='visible'&&ws.__dshPingNonce===nonce){connectionTrace({component:'page-ws',stage:'failed',reason:'heartbeat_timeout',connectionId:ws.__dshDiagnosticId,lastMessageAgeMs:Date.now()-(ws.__dshLastMessageAt||ws.__dshOpenedAt||Date.now()),lastPongAgeMs:Date.now()-(ws.__dshLastPongAt||ws.__dshOpenedAt||Date.now()),socketState:ws.readyState,bufferedBytes:ws.bufferedAmount});ws.close(4000,'foreground connection stale');}},8000);}
  }
  heartbeatTimer=setTimeout(heartbeat,activeTasks?20000:60000);
 }
 function pauseHandshakeDeadlines(){for(const ws of sockets)ws.__dshHandshakeOperation?.pause?.();}
 function resumeHandshakeDeadlines(){if(document.visibilityState!=='visible'||frozen||blocked)return;for(const ws of sockets)if(ws.readyState<=1&&!ws.__dshHelloReceived)ws.__dshHandshakeOperation?.arm?.(HANDSHAKE_DEADLINE_MS);}
 window.WebSocket=class extends NativeWS{
  constructor(url,protocols){
   const next=new URL(url,location.href),owned=next.origin===location.origin.replace(/^http/,'ws')&&next.pathname==='/w/'+scope.id+'/ws';
   const connectionId=owned?crypto.randomUUID():null;if(owned){next.searchParams.set('scopeToken',scope.token);next.searchParams.set('dshDiag',connectionId);const identity=window.__DSH_CLIENT_LOG__?.identity?.();if(identity?.pageId)next.searchParams.set('dshDiagPage',identity.pageId);if(identity?.uiVersion)next.searchParams.set('dshDiagUI',identity.uiVersion);}if(owned)window.__DSH_BEFORE_CONTROL_CONNECT__?.();super(next.href,protocols);if(!owned)return;this.__dshDiagnosticId=connectionId;const startedAt=Date.now();const handshake=deadlineOperation('page-ws-handshake',document.visibilityState==='visible'&&!frozen?HANDSHAKE_DEADLINE_MS:0,operation=>{const socket=operation.socket;if(!socket||socket.__dshHandshakeOperation!==operation||!sockets.has(socket)||socket.readyState>1||socket.__dshHelloReceived)return;if(document.visibilityState!=='visible'||frozen){operation.done=false;operation.timedOut=false;operation.arm(HANDSHAKE_DEADLINE_MS);return;}connectionTrace({component:'page-ws',stage:'pending',connectionId,reason:'timeout',handshakeComplete:false,socketState:socket.readyState,durationMs:Date.now()-startedAt});connectionTrace({component:'page-ws',stage:'failed',connectionId,reason:'timeout',handshakeComplete:false,socketState:socket.readyState,durationMs:Date.now()-startedAt});const healthy=[...sockets].some(ws=>ws!==socket&&ws.__dshGeneration===generation&&ws.readyState===1&&ws.__dshHelloReceived&&ws.__dshNegotiated);socket.close(4000,'hello timeout');if(!healthy&&!blocked&&!loginRequired&&!frozen&&navigator.onLine!==false){connectionStatus('reconnecting');window.__DSH_RECONNECT_TRANSPORT__?.();}});handshake.socket=this;this.__dshHandshakeOperation=handshake;connectionTrace({component:'page-ws',stage:'attempt',connectionId});this.addEventListener('open',()=>{this.__dshOpenedAt=Date.now();connectionTrace({component:'page-ws',stage:'connected',connectionId,durationMs:Date.now()-startedAt,handshakeComplete:false});});this.addEventListener('error',()=>connectionTrace({component:'page-ws',stage:'failed',connectionId,reason:'socket_error',socketState:this.readyState,handshakeComplete:!!this.__dshHelloReceived}));
    this.__dshOwned=true;this.__dshGeneration=generation;sockets.add(this);for(const waiter of bulkWaiters)if(!waiter.wire)waiter.wire=this;
    this.addEventListener('close',event=>{handshake.cleanup();connectionTrace({component:'page-ws',stage:'closed',connectionId,reason:'socket_closed',closeCode:event.code,wasClean:event.wasClean,handshakeComplete:!!this.__dshHelloReceived,durationMs:Date.now()-startedAt,lastMessageAgeMs:Date.now()-(this.__dshLastMessageAt||startedAt),socketState:this.readyState,bufferedBytes:this.bufferedAmount});sockets.delete(this);cancelBulkReads(bulkError('目录读取连接已中断'),this);clearTimeout(this.__dshPingTimer);const connected=[...sockets].some(ws=>ws.__dshGeneration===generation&&ws.readyState===1&&ws.__dshNativeConnected);window.__DSH_EXECUTION_CONNECTED__=connected;window.dispatchEvent(new Event('dsh:execution-state'));if(!connected){if(this.__dshHelloReceived&&!blocked)connectionStatus('reconnecting');renewScope();}});
   this.addEventListener('message',event=>{const receivedAt=Date.now(),receivedMono=typeof performance==='undefined'?receivedAt:performance.now();this.__dshLastMessageAt=receivedAt;
    if(this.__dshGeneration!==generation){event.stopImmediatePropagation?.();return;}
    let m;try{m=JSON.parse(event.data);}catch{return;}
    const receivedFrame=window.__DSH_CLIENT_LOG__?.beginReceivedFrame?.(event.data,m,{connectionId,receivedAt,receivedMono,parsedAt:Date.now(),parsedMono:typeof performance==='undefined'?Date.now():performance.now()});
    if(m.type==='dsh:resume-unavailable'){connectionTrace({component:'page-ws',stage:'failed',connectionId,reason:'resume_unavailable'});
     clearTimeout(heartbeatTimer);event.stopImmediatePropagation?.();rebuildConnection();return;
    }
    if(m.type==='hello-ack'){
     handshake.cleanup();this.__dshHelloReceived=true;this.__dshPageId=m.clientId;this.__dshBulkReadProtocol=m.dshBulkReadProtocol;this.__dshFrontEpoch=m.dshEpoch;this.__dshNativeGeneration=m.dshNativeGeneration;connectionTrace({component:'page-ws',stage:'received',connectionId,handshakeComplete:true,resumed:!!m.dshResumed,durationMs:Date.now()-startedAt});this.__dshNegotiated=m.dshProtocol==='dsh-page-resume-v1';
     if(this.__dshNegotiated){
      if(resumeId&&(!m.dshResumed||resumeId!==m.dshResumeId)){event.stopImmediatePropagation?.();rebuildConnection();return;}
      resumeId=m.dshResumeId;
      try{acknowledgeClient(m.dshReceivedSeq);}catch{this.close(4000,'transport sequence invalid');return;}
      // Only resume the same server session. Sequence deduplication precedes
      // server dispatch; this is not re-submission of a native operation.
      for(const frame of outbound.values())NativeWS.prototype.send.call(this,frame.raw);
      if(m.dshResumed)connectionStatus('syncing');
     }
     heartbeat();refreshBulkState();
    }
    if(m.type==='dsh:ack'){try{acknowledgeClient(m.seq);}catch{this.close(4000,'transport acknowledgement invalid');}event.stopImmediatePropagation?.();return;}
    if(m.type==='dsh:pong'){this.__dshLastPongAt=Date.now();if(m.nonce===this.__dshPingNonce){clearTimeout(this.__dshPingTimer);this.__dshPingTimer=null;this.__dshPingNonce=null;}event.stopImmediatePropagation?.();return;}
    if(Number.isSafeInteger(m.dshPageSeq)){
     if(m.dshPageSeq<=serverSeq){control(this,{type:'dsh:ack',seq:serverSeq});event.stopImmediatePropagation?.();return;}
     if(m.dshPageSeq!==serverSeq+1){event.stopImmediatePropagation?.();this.close(4000,'transport gap');return;}
     serverSeq=m.dshPageSeq;control(this,{type:'dsh:ack',seq:serverSeq});
    }
    // Preserve transport ACK/order even when an old replay cannot modify an
    // already completed local turn. The official renderer handles other events.
    if(m.payload?.type==='mcp-notification'&&window.__DSH_ACCEPT_NATIVE_NOTIFICATION__?.(m.payload.method,m.payload.params)===false){event.stopImmediatePropagation?.();return;}
    if(m.payload?.type==='codex-app-server-connection-changed'){const oldGeneration=this.__dshNativeGeneration;this.__dshNativeConnected=m.payload.state==='connected';if(Number.isSafeInteger(m.payload.dshNativeGeneration))this.__dshNativeGeneration=m.payload.dshNativeGeneration;if(m.dshEpoch)this.__dshFrontEpoch=m.dshEpoch;if(!this.__dshNativeConnected||oldGeneration!==this.__dshNativeGeneration)cancelBulkReads(bulkError('目录读取宿主连接已更换'),this);else refreshBulkState();connectionTrace({component:'page-ws',stage:this.__dshNativeConnected?'connected':'unavailable',connectionId,reason:this.__dshNativeConnected?'native_ready':'native_disconnected',nativeOnline:this.__dshNativeConnected});window.__DSH_EXECUTION_CONNECTED__=[...sockets].some(ws=>ws.__dshGeneration===generation&&ws.readyState===1&&ws.__dshNativeConnected);window.dispatchEvent(new Event('dsh:execution-state'));}
    if(m.dshEpoch||m.epoch)window.__DSH_HOST_METADATA_EPOCH__?.(m.dshEpoch||m.epoch);
    if(window.__DSH_IPC_CACHE_RESPONSE__?.(m.payload)===true)Object.defineProperty(event,'data',{value:JSON.stringify(m)});
    receivedFrame?.();
    if(['mcp-response','fetch-response'].includes(m.payload?.type))window.__DSH_CLIENT_LOG__?.response(m.payload);
    if(m.payload?.type==='mcp-response')window.__DSH_PERF__?.finish(m.payload.message?.id,event.data.length,m.payload.message?.error);
    if(m.payload?.type==='mcp-notification'&&m.payload.method==='turn/started'){activeTasks=true;heartbeat();}
    if(m.type==='dsh:browser-action'){
     Promise.resolve().then(async()=>{
      if(m.action==='clipboard')await navigator.clipboard.writeText(m.payload.text);
      else if(m.action==='download'){const u=new URL(m.payload.url,location.origin);if(u.origin!==location.origin||!u.pathname.startsWith('/w/'+scope.id+'/'))throw Error('下载地址不属于当前工作区');if(window.__DSH_ANDROID_DOWNLOAD__)window.__DSH_ANDROID_DOWNLOAD__.open(u.href);else{const a=document.createElement('a');a.href=u.href;a.download='';document.body.appendChild(a);a.click();a.remove();}}
      else throw Error('页面操作未支持');
      this.send(JSON.stringify({type:'dsh:browser-action-result',requestId:m.requestId,ok:true}));
     }).catch(error=>this.send(JSON.stringify({type:'dsh:browser-action-result',requestId:m.requestId,ok:false,error:error.message})));return;
    }
    if(m.type==='dsh:route'&&(/^(?:\/|\/local\/[0-9a-f-]{36})$/i.test(m.path))){
     // Older hosts replay presentation acknowledgements as routes. They must
     // never retarget the URL independently of the official router/composer.
     if(m.path!==location.pathname)return;
     return;
    }
    if(m.type==='dsh:sync-state'){
     // Epoch changes are reported and reconciled; never flash/reload the page.
     if(observedEpoch&&m.epoch&&observedEpoch!==m.epoch)connectionStatus('syncing');
     if(m.epoch)observedEpoch=m.epoch;activeTasks=(m.activeThreadIds?.length||0)>0;
     window.dispatchEvent(new MessageEvent('message',{data:{type:'ipc-broadcast',method:'query-cache-invalidate',params:{queryKey:['recent-conversations-meta']}}}));
     window.dispatchEvent(new MessageEvent('message',{data:{type:'electron-window-focus-changed',focused:document.visibilityState==='visible'}}));
     if(window.__DSH_NATIVE_SIDEBAR__?.isList||!location.pathname?.startsWith('/local/'))connectionStatus('connected');
    }
   });
  }
  send(raw){
   if(!this.__dshOwned)return super.send(raw);
   if(this.__dshGeneration!==generation)throw Error('旧连接已替换，请核对当前会话');
   const m=JSON.parse(raw),rpc=m.request?.args?.[0]?.request;if(rpc)window.__DSH_PERF__?.start(rpc.id,rpc.method);
   if(m.type==='hello'){m.dshClientId=client;m.dshProtocol='dsh-page-resume-v1';if(resumeId)m.dshResumeId=resumeId;m.dshAck=serverSeq;return super.send(JSON.stringify(m));}
   if(blocked)throw Error('页面连接尚未恢复，请保留草稿后重试');
   if(this.readyState!==1)throw Error('连接正在恢复，消息尚未发送');
   if(this.__dshNegotiated&&!['dsh:sync','dsh:ping','dsh:ack'].includes(m.type)){
    m.dshClientSeq=clientSeq+1;const encoded=JSON.stringify(m),bytes=encoded.length*2;
    if(outboundBytes+bytes>32*1024*1024)throw Error('连接尚未确认，请稍后重试');
    // Native WS semantics: do not retain a call that failed before send.
    super.send(encoded);clientSeq++;outbound.set(clientSeq,{raw:encoded,bytes});outboundBytes+=bytes;return;
   }
   return super.send(raw);
  }
 };
 async function sync(){
  if(document.visibilityState!=='visible'){wasHidden=true;pauseHeartbeat();pauseHandshakeDeadlines();heartbeat();return;}
  frozen=false;resumeHandshakeDeadlines();
  if(blocked)return;
  const recover=wasHidden;wasHidden=false;if(recover)recoveryStartedAt=Date.now();
  const silent=window.__DSH_ANDROID_APP__?.isAndroid===true&&window.__DSH_EXECUTION_CONNECTED__===true&&connectionState==='connected'&&[...sockets].some(ws=>ws.readyState===1&&ws.__dshHelloReceived);
  if(syncing){if(recover){syncing.recover=true;connectionStatus('syncing',{silent:syncing.silent||silent,reason:'visible'});}return syncing.promise;}
  for(const ws of sockets){clearTimeout(ws.__dshPingTimer);ws.__dshPingTimer=null;}
  heartbeat();
  const operation={generation:++operationGeneration,transportGeneration:generation,recover,silent,done:false,promise:null};syncing=operation;
  operation.promise=(async()=>{const renewing=renewScope();const sendSync=recoverConversation=>{for(const ws of sockets)if(ws.readyState===1&&(!ws.__dshOwned||ws.__dshHelloReceived)){if(recoverConversation)connectionStatus('syncing',{silent:operation.silent,reason:'visible'});control(ws,{type:'dsh:sync',recoverConversation});lastSyncAt=Date.now();}};sendSync(recover);const renewed=await renewing;if(syncing!==operation||operation.done||operation.transportGeneration!==generation)return;if(!renewed){wasHidden||=operation.recover;const connected=connectionState==='connected'&&[...sockets].some(ws=>ws.__dshGeneration===generation&&ws.readyState===1&&ws.__dshHelloReceived&&ws.__dshNativeConnected);if(!loginRequired&&!blocked&&!connected)connectionStatus('reconnecting');return;}if(operation.recover&&!recover)sendSync(true);if(![...sockets].some(ws=>ws.readyState===0||ws.readyState===1)&&!blocked&&!rebuilding)window.__DSH_RECONNECT_TRANSPORT__?.();})().finally(()=>{operation.done=true;if(syncing===operation)syncing=null;});return operation.promise;
 }
 function acceptSessionReady(){if(loginRequired||rebuilding)return false;
  // A successful credential refresh does not restore disposed MessagePorts.
  // Complete the same bounded rebuild before the loader advertises readiness.
  // The fresh scope is already verified; no duplicate request or write replay.
  if(hostNeedsRecreation){rebuildConnection(false,true);return false;}const recovering=blocked||connectionState==='unavailable';blocked=false;window.__DSH_CONNECTION_PAUSED__=false;if(recovering){wasHidden=true;connectionStatus('reconnecting');}return true;}
 window.__DSH_ACCEPT_SESSION_READY__=acceptSessionReady;
 addEventListener('pageshow',event=>{frozen=false;if(event?.persisted)wasHidden=true;return sync();});
 addEventListener('online',()=>{wasHidden=true;return sync();});
 // Android may replace a VPN/default path without a browser offline/online
 // transition. Retire only the transport; keep renderer, drafts and resume ACKs.
 let androidNetwork=null;
 addEventListener('dsh:android-status',event=>{
  if(event.detail?.scope!==scope.id)return;
  const state=event.detail?.status?.background;
  if(typeof state?.networkMonitorId!=='string'||!Number.isSafeInteger(state.networkGeneration))return;
  const previous=androidNetwork;
  if(previous?.id===state.networkMonitorId&&previous.generation>=state.networkGeneration)return;
  androidNetwork={id:state.networkMonitorId,generation:state.networkGeneration};
  if(previous===null)return;
  wasHidden=true;
  for(const ws of [...sockets])if(ws.__dshOwned&&ws.readyState<=1){ws.__dshNativeConnected=false;ws.close(4000,'network path changed');}
  window.__DSH_EXECUTION_CONNECTED__=false;window.dispatchEvent(new Event('dsh:execution-state'));
  if(state.networkAvailable&&document.visibilityState==='visible'&&!blocked&&!loginRequired){connectionStatus('reconnecting');window.__DSH_RECONNECT_TRANSPORT__?.();}
 });
 document.addEventListener('visibilitychange',sync);document.addEventListener('resume',()=>{frozen=false;wasHidden=true;return sync();});
 document.addEventListener('freeze',()=>{frozen=true;wasHidden=true;pauseHeartbeat();pauseHandshakeDeadlines();});
 addEventListener('pagehide',()=>{frozen=true;wasHidden=true;pauseHeartbeat();pauseHandshakeDeadlines();});
 addEventListener('dsh:conversation-ready',()=>connectionStatus('connected'));
 // Reusing an existing renderer does not emit another conversation-ready event.
 // A committed notification completion also settles the selected route even
 // when an unrelated HTTP refresh is still pending. Execution must be online.
 for(const type of ['dsh:history-synchronized','dsh:history-adopted'])addEventListener(type,event=>{
  if(!blocked&&!loginRequired&&['syncing','reconnecting'].includes(connectionState)&&window.__DSH_EXECUTION_CONNECTED__===true&&event.detail?.threadId&&location.pathname==='/local/'+event.detail.threadId)connectionStatus('connected');
 });
 const idb=window.indexedDB;if(idb){const open=idb.open.bind(idb),del=idb.deleteDatabase.bind(idb);idb.open=(name,version)=>version===undefined?open(prefix+name):open(prefix+name,version);idb.deleteDatabase=name=>del(prefix+name);}
 if(window.BroadcastChannel){const BC=window.BroadcastChannel;window.BroadcastChannel=class extends BC{constructor(name){super(prefix+name);}};}
})();

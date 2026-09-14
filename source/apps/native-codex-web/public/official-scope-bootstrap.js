// 官方脚本之前安装固定 scope 的 I/O/缓存命名空间；不修改官方布局和组件。
(()=>{const scope=window.__BETTER_CODEX_SCOPE__;if(!scope)return;const prefix='betterCodex-official:'+scope.id+':';const rawGet=Storage.prototype.getItem,rawSet=Storage.prototype.setItem,rawRemove=Storage.prototype.removeItem;let client=rawGet.call(sessionStorage,prefix+'client');if(!client){client=crypto.randomUUID();rawSet.call(sessionStorage,prefix+'client',client);}
 const local=localStorage,session=sessionStorage,rawClear=Storage.prototype.clear;const scoped=s=>s===local||s===session;
 Storage.prototype.getItem=function(key){return rawGet.call(this,scoped(this)?prefix+key:key);};
 Storage.prototype.setItem=function(key,value){return rawSet.call(this,scoped(this)?prefix+key:key,value);};
 Storage.prototype.removeItem=function(key){return rawRemove.call(this,scoped(this)?prefix+key:key);};
 Storage.prototype.clear=function(){if(!scoped(this))return rawClear.call(this);for(const key of Object.keys(this))if(key.startsWith(prefix))rawRemove.call(this,key);};
 let loginRequired=false;
 function recoverLogin(){if(loginRequired)return;window.dispatchEvent(new Event('betterCodex:authentication-required'));loginRequired=true;blocked=true;window.__BETTER_CODEX_CONNECTION_PAUSED__=true;window.__BETTER_CODEX_PAGE_NAVIGATION_DIAGNOSTICS__?.authRequired();connectionStatus('unavailable');}
 const originalFetch=window.fetch.bind(window);window.fetch=async(input,init={})=>{const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin===location.origin&&url.pathname.startsWith('/api/')){url.pathname='/w/'+scope.id+url.pathname;input=input instanceof Request?new Request(url.href,input):url.href;}if(url.origin===location.origin&&url.pathname.startsWith('/w/'+scope.id+'/')){if(!scope.token)await renewScope();const headers=new Headers(init.headers||(input instanceof Request?input.headers:undefined));headers.set('x-betterCodex-scope',scope.token);init={...init,headers};}const protectedAPI=url.origin===location.origin&&(url.pathname.startsWith('/w/'+scope.id+'/')||url.pathname==='/betterCodex-scope-session');if(protectedAPI)init={...init,redirect:'manual'};return originalFetch(input,init).then(async r=>{if(!protectedAPI)return r;if(r.type==='opaqueredirect'||r.status===303||r.status===302){recoverLogin();return r;}if(r.status===401){if(url.pathname==='/betterCodex-scope-session'){recoverLogin();return r;}const renewed=await renewScope(),method=(init.method||(input instanceof Request?input.method:'GET')).toUpperCase();if(renewed&&['GET','HEAD'].includes(method)){const headers=new Headers(init.headers);headers.set('x-betterCodex-scope',scope.token);return originalFetch(input,{...init,headers});}}return r;});};
 let renewal=null;function renewScope(){if(renewal)return renewal;renewal=originalFetch('/betterCodex-scope-session?workspace='+encodeURIComponent(scope.id),{cache:'no-store',redirect:'manual'}).then(async r=>{if(r.type==='opaqueredirect'||r.status===401){recoverLogin();throw Error('login expired');}if(!r.ok)throw Error('scope renewal unavailable');const next=await r.json();if(next.id!==scope.id||typeof next.token!=='string')throw Error('invalid scope renewal');scope.token=next.token;return true;}).catch(()=>false).finally(()=>{renewal=null;});return renewal;}
 // Keep the renderer and its AppHost session alive across socket replacement.
 // The server acknowledges transport sequence numbers; a resumed session never
 // executes an already accepted Prompt/approval twice. A new host is never
 // given unacknowledged messages from an old session.
 const NativeWS=window.WebSocket,sockets=new Set(),outbound=new Map();
 let resumeId=null,serverSeq=0,clientSeq=0,outboundBytes=0,observedEpoch=null;
 let frozen=false,wasHidden=false,activeTasks=false,blocked=false,heartbeatTimer=null,syncing=null;
 let generation=0,rebuilding=null,rebuildAttempts=[];
 let statusTimer=null,statusNode=null,lastSyncAt=0,recoveryStartedAt=null;
 function connectionStatus(state){
  if(loginRequired)state='unavailable';
  if(state==='unavailable')window.__BETTER_CODEX_CONNECTION_PAUSED__=true;
  if(state!=='connected'&&document.visibilityState==='visible'&&recoveryStartedAt===null)recoveryStartedAt=Date.now();const durationMs=state==='connected'&&recoveryStartedAt!==null?Date.now()-recoveryStartedAt:undefined;if(state==='connected')recoveryStartedAt=null;
  window.__BETTER_CODEX_PERF__?.event('transport',{reason:state,openSockets:sockets.size,...(durationMs===undefined?{}:{durationMs})});
  window.dispatchEvent(new CustomEvent('betterCodex:connection-state',{detail:{state}}));
  clearTimeout(statusTimer);
  if(state==='connected'){statusNode?.remove();statusNode=null;return;}
  if(!document.createElement)return;
  statusTimer=setTimeout(()=>{
   if(!statusNode){statusNode=document.createElement('div');statusNode.setAttribute('role','status');statusNode.className='betterCodex-connection-status';document.body?.append(statusNode);}
   statusNode.textContent=loginRequired?'登录已过期，页面和草稿已保留。':state==='unavailable'?'连接未能恢复，页面和草稿已保留。':state==='syncing'?'正在同步最新消息…':'正在恢复连接…';
   if(state==='unavailable'){
    const retry=document.createElement('button');retry.type='button';retry.textContent=loginRequired?'重新登录':'重新连接';
    retry.addEventListener('click',()=>{if(loginRequired)location.replace(location.pathname+location.search);else rebuildConnection(true);});statusNode.append(retry);
   }
  },400);
 }
 function rebuildConnection(manual=false){
  if(rebuilding)return rebuilding;
  rebuildAttempts=manual?[]:rebuildAttempts.filter(at=>Date.now()-at<30000);
  if(rebuildAttempts.length>=2){blocked=true;connectionStatus('unavailable');return;}
  if(typeof window.__BETTER_CODEX_RESET_BROWSER_PORTS__!=='function'||typeof window.__BETTER_CODEX_RECREATE_APP_HOST__!=='function'){blocked=true;connectionStatus('unavailable');return;}
  rebuildAttempts.push(Date.now());window.__BETTER_CODEX_CONNECTION_PAUSED__=false;
  rebuilding=(async()=>{
   blocked=true;connectionStatus('syncing');generation++;
   // Never replay messages into a replacement server session. Drop the old
   // transport only, rebuild the original native AppHost, then read history.
   window.__BETTER_CODEX_RESET_BROWSER_PORTS__();outbound.clear();outboundBytes=0;clientSeq=0;serverSeq=0;resumeId=null;
   for(const ws of sockets)ws.close(4000,'page session replacement');
   await renewScope();blocked=false;
   window.__BETTER_CODEX_RECONNECT_TRANSPORT__?.();
   await window.__BETTER_CODEX_RECREATE_APP_HOST__();
   wasHidden=true;await sync();
  })().catch(()=>{blocked=true;connectionStatus('unavailable');}).finally(()=>{rebuilding=null;});return rebuilding;
 }
 function acknowledgeClient(seq){
  if(!Number.isSafeInteger(seq)||seq<0||seq>clientSeq)throw Error('invalid transport acknowledgement');
  for(const [id,frame] of outbound){if(id>seq)break;outboundBytes-=frame.bytes;outbound.delete(id);}
 }
 function control(ws,value){if(ws.readyState===1)NativeWS.prototype.send.call(ws,JSON.stringify(value));}
 function pauseHeartbeat(){clearTimeout(heartbeatTimer);for(const ws of sockets){clearTimeout(ws.__betterCodexPingTimer);ws.__betterCodexPingTimer=null;ws.__betterCodexPingNonce=null;}}
 function heartbeat(){
  clearTimeout(heartbeatTimer);if(blocked||frozen||navigator.onLine===false)return;
  for(const ws of sockets)if(ws.readyState===1&&ws.__betterCodexHelloReceived&&ws.__betterCodexNegotiated){
   // A half-open socket can still say OPEN after the phone changes networks.
   // Hidden pages keep a best-effort heartbeat while the browser permits it.
   // Only a visible page uses a deadline: throttling must not kill a healthy socket.
   if(document.visibilityState!=='visible'){control(ws,{type:'betterCodex:ping',nonce:crypto.randomUUID()});continue;}
   // Probe on foreground; a missed response replaces only that socket.
   if(!ws.__betterCodexPingTimer){const nonce=crypto.randomUUID();ws.__betterCodexPingNonce=nonce;control(ws,{type:'betterCodex:ping',nonce});
    ws.__betterCodexPingTimer=setTimeout(()=>{ws.__betterCodexPingTimer=null;if(document.visibilityState==='visible'&&ws.__betterCodexPingNonce===nonce)ws.close(4000,'foreground connection stale');},8000);}
  }
  heartbeatTimer=setTimeout(heartbeat,activeTasks?20000:60000);
 }
 window.WebSocket=class extends NativeWS{
  constructor(url,protocols){
   const next=new URL(url,location.href),owned=next.origin===location.origin.replace(/^http/,'ws')&&next.pathname==='/w/'+scope.id+'/ws';
   if(owned)next.searchParams.set('scopeToken',scope.token);super(next.href,protocols);if(!owned)return;
   this.__betterCodexOwned=true;this.__betterCodexGeneration=generation;sockets.add(this);
   this.addEventListener('close',()=>{sockets.delete(this);clearTimeout(this.__betterCodexPingTimer);const connected=[...sockets].some(ws=>ws.__betterCodexGeneration===generation&&ws.readyState===1&&ws.__betterCodexNativeConnected);window.__BETTER_CODEX_EXECUTION_CONNECTED__=connected;window.dispatchEvent(new Event('betterCodex:execution-state'));if(!connected){if(this.__betterCodexHelloReceived&&!blocked)connectionStatus('reconnecting');renewScope();}});
   this.addEventListener('message',event=>{
    if(this.__betterCodexGeneration!==generation){event.stopImmediatePropagation?.();return;}
    let m;try{m=JSON.parse(event.data);}catch{return;}
    if(m.type==='betterCodex:resume-unavailable'){
     clearTimeout(heartbeatTimer);event.stopImmediatePropagation?.();rebuildConnection();return;
    }
    if(m.type==='hello-ack'){
     this.__betterCodexHelloReceived=true;this.__betterCodexNegotiated=m.betterCodexProtocol==='betterCodex-page-resume-v1';
     if(this.__betterCodexNegotiated){
      if(resumeId&&(!m.betterCodexResumed||resumeId!==m.betterCodexResumeId)){event.stopImmediatePropagation?.();rebuildConnection();return;}
      resumeId=m.betterCodexResumeId;
      try{acknowledgeClient(m.betterCodexReceivedSeq);}catch{this.close(4000,'transport sequence invalid');return;}
      // Only resume the same server session. Sequence deduplication precedes
      // server dispatch; this is not re-submission of a native operation.
      for(const frame of outbound.values())NativeWS.prototype.send.call(this,frame.raw);
      if(m.betterCodexResumed)connectionStatus('syncing');
     }
     heartbeat();
    }
    if(m.type==='betterCodex:ack'){try{acknowledgeClient(m.seq);}catch{this.close(4000,'transport acknowledgement invalid');}event.stopImmediatePropagation?.();return;}
    if(m.type==='betterCodex:pong'){if(m.nonce===this.__betterCodexPingNonce){clearTimeout(this.__betterCodexPingTimer);this.__betterCodexPingTimer=null;this.__betterCodexPingNonce=null;}event.stopImmediatePropagation?.();return;}
    if(Number.isSafeInteger(m.betterCodexPageSeq)){
     if(m.betterCodexPageSeq<=serverSeq){control(this,{type:'betterCodex:ack',seq:serverSeq});event.stopImmediatePropagation?.();return;}
     if(m.betterCodexPageSeq!==serverSeq+1){event.stopImmediatePropagation?.();this.close(4000,'transport gap');return;}
     serverSeq=m.betterCodexPageSeq;control(this,{type:'betterCodex:ack',seq:serverSeq});
    }
    if(m.payload?.type==='codex-app-server-connection-changed'){this.__betterCodexNativeConnected=m.payload.state==='connected';window.__BETTER_CODEX_EXECUTION_CONNECTED__=[...sockets].some(ws=>ws.__betterCodexGeneration===generation&&ws.readyState===1&&ws.__betterCodexNativeConnected);window.dispatchEvent(new Event('betterCodex:execution-state'));}
    if(window.__BETTER_CODEX_IPC_CACHE_RESPONSE__?.(m.payload)===true)Object.defineProperty(event,'data',{value:JSON.stringify(m)});
    if(m.payload?.type==='mcp-response')window.__BETTER_CODEX_PERF__?.finish(m.payload.message?.id,event.data.length,m.payload.message?.error);
    if(m.payload?.type==='mcp-notification'&&m.payload.method==='turn/started'){activeTasks=true;heartbeat();}
    if(m.type==='betterCodex:browser-action'){
     Promise.resolve().then(async()=>{
      if(m.action==='clipboard')await navigator.clipboard.writeText(m.payload.text);
      else if(m.action==='download'){const u=new URL(m.payload.url,location.origin);if(u.origin!==location.origin||!u.pathname.startsWith('/w/'+scope.id+'/'))throw Error('下载地址不属于当前工作区');if(window.__BETTER_CODEX_ANDROID_DOWNLOAD__)window.__BETTER_CODEX_ANDROID_DOWNLOAD__.open(u.href);else{const a=document.createElement('a');a.href=u.href;a.download='';document.body.appendChild(a);a.click();a.remove();}}
      else throw Error('页面操作未支持');
      this.send(JSON.stringify({type:'betterCodex:browser-action-result',requestId:m.requestId,ok:true}));
     }).catch(error=>this.send(JSON.stringify({type:'betterCodex:browser-action-result',requestId:m.requestId,ok:false,error:error.message})));return;
    }
    if(m.type==='betterCodex:route'&&(/^(?:\/|\/local\/[0-9a-f-]{36})$/i.test(m.path))){
     window.dispatchEvent(new CustomEvent('betterCodex:native-route',{detail:{path:m.path}}));const u=new URL(m.path,location.origin);u.searchParams.set('workspace',scope.id);if(m.path==='/')u.searchParams.set('view','chat');if(window.__BETTER_CODEX_EMBEDDED__)u.searchParams.set('betterCodexEmbedded','1');
     if(window.__BETTER_CODEX_NATIVE_SIDEBAR__?.isList){u.pathname=location.pathname.startsWith('/local/')?location.pathname:'/';u.searchParams.set('nativeList','1');u.searchParams.set('view','chat');}history.replaceState(history.state,'',u.href);
    }
    if(m.type==='betterCodex:sync-state'){
     // Epoch changes are reported and reconciled; never flash/reload the page.
     if(observedEpoch&&m.epoch&&observedEpoch!==m.epoch)connectionStatus('syncing');
     if(m.epoch)observedEpoch=m.epoch;activeTasks=(m.activeThreadIds?.length||0)>0;
     window.dispatchEvent(new MessageEvent('message',{data:{type:'ipc-broadcast',method:'query-cache-invalidate',params:{queryKey:['recent-conversations-meta']}}}));
     window.dispatchEvent(new MessageEvent('message',{data:{type:'electron-window-focus-changed',focused:document.visibilityState==='visible'}}));
     if(window.__BETTER_CODEX_NATIVE_SIDEBAR__?.isList||!location.pathname?.startsWith('/local/'))connectionStatus('connected');
    }
   });
  }
  send(raw){
   if(!this.__betterCodexOwned)return super.send(raw);
   if(this.__betterCodexGeneration!==generation)throw Error('旧连接已替换，请核对当前会话');
   const m=JSON.parse(raw),rpc=m.request?.args?.[0]?.request;if(rpc)window.__BETTER_CODEX_PERF__?.start(rpc.id,rpc.method);
   if(m.type==='hello'){m.betterCodexClientId=client;m.betterCodexProtocol='betterCodex-page-resume-v1';if(resumeId)m.betterCodexResumeId=resumeId;m.betterCodexAck=serverSeq;return super.send(JSON.stringify(m));}
   if(blocked)throw Error('页面连接尚未恢复，请保留草稿后重试');
   if(this.readyState!==1)throw Error('连接正在恢复，消息尚未发送');
   if(this.__betterCodexNegotiated&&!['betterCodex:sync','betterCodex:ping','betterCodex:ack'].includes(m.type)){
    m.betterCodexClientSeq=clientSeq+1;const encoded=JSON.stringify(m),bytes=encoded.length*2;
    if(outboundBytes+bytes>32*1024*1024)throw Error('连接尚未确认，请稍后重试');
    // Native WS semantics: do not retain a call that failed before send.
    super.send(encoded);clientSeq++;outbound.set(clientSeq,{raw:encoded,bytes});outboundBytes+=bytes;return;
   }
   return super.send(raw);
  }
 };
 async function sync(){
  if(document.visibilityState!=='visible'){wasHidden=true;pauseHeartbeat();heartbeat();return;}
  frozen=false;
  if(blocked)return;if(syncing)return syncing;
  const recover=wasHidden;wasHidden=false;if(recover)recoveryStartedAt=Date.now();
  for(const ws of sockets){clearTimeout(ws.__betterCodexPingTimer);ws.__betterCodexPingTimer=null;}
  heartbeat();
  syncing=(async()=>{const renewing=renewScope();for(const ws of sockets)if(ws.readyState===1&&(!ws.__betterCodexOwned||ws.__betterCodexHelloReceived)){
   if(recover)connectionStatus('syncing');control(ws,{type:'betterCodex:sync',recoverConversation:recover});lastSyncAt=Date.now();
  }await renewing;if(![...sockets].some(ws=>ws.readyState===0||ws.readyState===1)&&!blocked)window.__BETTER_CODEX_RECONNECT_TRANSPORT__?.();})().finally(()=>{syncing=null;});return syncing;
 }
 addEventListener('pageshow',event=>{frozen=false;if(event?.persisted)wasHidden=true;return sync();});
 addEventListener('online',()=>{wasHidden=true;return sync();});
 document.addEventListener('visibilitychange',sync);document.addEventListener('resume',()=>{frozen=false;wasHidden=true;return sync();});
 document.addEventListener('freeze',()=>{frozen=true;wasHidden=true;pauseHeartbeat();});
 addEventListener('pagehide',()=>{frozen=true;wasHidden=true;pauseHeartbeat();});
 addEventListener('betterCodex:conversation-ready',()=>connectionStatus('connected'));
 const idb=window.indexedDB;if(idb){const open=idb.open.bind(idb),del=idb.deleteDatabase.bind(idb);idb.open=(name,version)=>version===undefined?open(prefix+name):open(prefix+name,version);idb.deleteDatabase=name=>del(prefix+name);}
 if(window.BroadcastChannel){const BC=window.BroadcastChannel;window.BroadcastChannel=class extends BC{constructor(name){super(prefix+name);}};}
})();

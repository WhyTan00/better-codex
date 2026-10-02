// Adapt the original queue UI; Native is the sole automatic consumer.
(()=>{
 const scope=window.__DSH_SCOPE__;if(!scope)return;
 const installed=new WeakSet(),clientId=crypto.randomUUID(),inflightCommands=new Map();
 async function rawAPI(request,threadId,commandId){
  if(window.__DSH_NATIVE_ONLINE__===false)throw Error('Mac 暂未连接，消息尚未提交');
  const query=commandId?'?commandId='+encodeURIComponent(commandId):threadId?'?threadId='+encodeURIComponent(threadId):'';
  const response=await fetch('/w/'+scope.id+'/api/native-queue'+query,{method:request?'POST':'GET',headers:{'x-dsh-scope':scope.token,...(request?{'content-type':'application/json'}:{})},...(request?{body:JSON.stringify({clientId,request})}:{}),cache:'no-store',redirect:'manual'});
  if(response.status===401||response.type==='opaqueredirect')throw Error('请重新登录；消息接收结果待核对');const result=await response.json();if(!response.ok)throw Error(result.error||'Mac 队列暂不可用');return result;
 }
 async function resolveCommand(command){
  const result=await rawAPI(null,null,command.id);
  if(['accepted','rejected'].includes(result.state)){
   await window.__DSH_NATIVE_CACHE__.recordCommand({...command,state:result.state}).catch(()=>{});
   const waiting=inflightCommands.get(command.id);
   if(result.state==='accepted')waiting?.resolve(result.result);
   else waiting?.reject(Error(result.result?.error||'Mac 未接收这项队列操作'));
  }
  return result;
 }
 async function reconcile(threadId){const commands=await window.__DSH_NATIVE_CACHE__.pendingCommands(threadId);for(const command of commands){const result=await resolveCommand(command);if(!['accepted','rejected'].includes(result.state))throw Error('上一条排队操作的接收结果待核对，暂不重复提交');}}
 async function api(request,threadId){
  if(!request)return rawAPI(null,threadId);
  if(window.__DSH_NATIVE_ONLINE__===false)throw Error('Mac 暂未连接，消息尚未提交');
  const command={id:request.commandId,threadId:request.threadId,operation:request.operation,state:'pending'};
  // Persist identity before transmitting. Never turn a lost response into a
  // new automatic operation, including after the browser closes or reloads.
  try{await window.__DSH_NATIVE_CACHE__.recordCommand(command);}catch{throw Error('这台设备暂时无法保存发送状态，消息尚未提交；草稿已保留');}
  const recovered=new Promise((resolve,reject)=>inflightCommands.set(command.id,{resolve,reject}));
  try{const result=await Promise.race([rawAPI(request,threadId),recovered]);await window.__DSH_NATIVE_CACHE__.recordCommand({...command,state:'accepted'}).catch(()=>{});return result;}
  catch(error){await window.__DSH_NATIVE_CACHE__.recordCommand({...command,state:'unknown'}).catch(()=>{});let status;try{status=await resolveCommand(command);}catch{}if(status?.state==='accepted')return status.result;if(status?.state==='rejected')throw error;throw Error('Mac 接收结果待核对，不会自动重发；请恢复连接后查看队列和会话');}finally{inflightCommands.delete(command.id);}
 }
 window.__DSH_INSTALL_NATIVE_QUEUE__=client=>{
  if(client.hostId!=='local'||installed.has(client))return;
  const q=client.turnCoordinator;if(!q){setTimeout(()=>window.__DSH_INSTALL_NATIVE_QUEUE__(client),50);return;}
  installed.add(client);let state={},revisions={},loaded=false,refreshing=null,writes=Promise.resolve(),sequence=0,cacheWrite=Promise.resolve();
  const applied=new Map(),reads=new Map(),mutating=new Set();
  const feedback=error=>window.dispatchEvent(new CustomEvent('dsh:queue-error',{detail:{message:error?.message||'队列操作未完成，请稍后重试'}}));
  const originalStorage=q.options.storage;window.__DSH_NATIVE_CACHE__?.meta('native-queue').then(cached=>{if(cached&&!loaded){state=cached.state||{};revisions=cached.revisions||{};loaded=true;publish();}}).catch(()=>{});
  function accept(result,ticket=++sequence,readScope=null){
   if(!result||result.authority!=='mac-native'||!result.state||!result.revisions)throw Error('队列结果尚未确认');
   for(const [id,messages]of Object.entries(result.state)){
    if(!Array.isArray(messages)||ticket<(applied.get(id)||0)||readScope==='*'&&(q.pending.has(id)||mutating.has(id)))continue;
    applied.set(id,ticket);state={...state,[id]:messages};revisions={...revisions,[id]:result.revisions[id]};
   }
   loaded=true;
   const snapshot=structuredClone({state,revisions,authority:'mac-native'});
   cacheWrite=cacheWrite.catch(()=>{}).then(()=>window.__DSH_NATIVE_CACHE__?.saveMeta('native-queue',snapshot));
   cacheWrite.catch(()=>{});return state;
  }
  async function load(threadId){
   const key=threadId||'*';if(reads.has(key))return reads.get(key);
   const ticket=++sequence,operation=api(null,threadId).then(result=>accept(result,ticket,key)).finally(()=>reads.delete(key));
   reads.set(key,operation);return operation;
  }
  function publish(){if(q.disposed)return;q.loadedState=state;for(const [id]of q.messages)if(!q.pending.has(id))q.messages.set(id,{messages:state[id]||[],refreshing:false});q.options.onQueueChanged?.(null);}
  async function refresh(){
   if(refreshing||q.disposed)return refreshing;
   refreshing=(async()=>{
    const current=location.pathname.match(/^\/local\/([0-9a-f-]{36})$/i)?.[1];
    const ids=new Set([current,...Object.keys(state).filter(id=>state[id]?.length),...[...q.messages].filter(([,value])=>value.messages?.length).map(([id])=>id)].filter(Boolean));
    const one=async id=>{if(q.pending.has(id)||mutating.has(id)){await reconcile(id).catch(()=>{});if(q.pending.has(id)||mutating.has(id))return;}await load(id);publish();};
    // A broken historical queue must not prevent the visible thread from clearing.
    if(current){ids.delete(current);await one(current).catch(()=>{});}
    await Promise.allSettled([...ids].map(one));
   })().finally(()=>{refreshing=null;});return refreshing;
  }
  // Disable automatic browser execution before exposing any persisted queue.
  const start=q.startExecution;
  q.startExecution=execution=>start({...execution,isClientReady:()=>false});
  if(q.execution)q.execution.isClientReady=()=>false;
  // Queue mutations go directly to Mac even when another page owns rendering.
  q.options.getStreamRole=()=>({role:'owner'});q.options.coordination=undefined;
  const sending=new Map(),host=q.options.submissionHost;
  // A transport timeout is not a rejected Native command. The official
  // RequestClient deliberately retains these promises for the original reply.
  // Recover that reply by identity after an accepted stop or a reconnect; do
  // not clear a submit lock or turn an unknown command into another write.
  const submissionRequests=new Map(),controlRequests=new Map(),receiptReads=new Map(),receiptWaiting=new Set();
  const requestClient=client.requestClient;
  const commandMethods=new Set(['turn/start','turn/steer']);
  const validId=value=>typeof value==='string'&&/^[0-9a-f-]{36}$/i.test(value);
  function rememberSubmission(value){
   const threadId=value.conversationId??value.params?.threadId,requestId=value.id??value.requestId,
    clientUserMessageId=value.clientUserMessageId??value.params?.clientUserMessageId;
   if(!commandMethods.has(value.method)||!validId(threadId)||!validId(clientUserMessageId)||typeof requestId!=='string'||!requestId)return;
   let requests=submissionRequests.get(threadId);if(!requests){requests=new Map();submissionRequests.set(threadId,requests);}
   requests.set(requestId,{threadId,requestId,clientUserMessageId,method:value.method});
  }
  function forgetSubmission(requestId){for(const [id,requests]of submissionRequests){requests.delete(requestId);if(!requests.size){submissionRequests.delete(id);receiptWaiting.delete(id);}}}
  async function readSubmissionReceipt(command){
   const params=new URLSearchParams(command),url='/w/'+scope.id+'/api/native-command-status?'+params;
   const init={headers:{'x-dsh-scope':scope.token||''},cache:'no-store',redirect:'manual'};
   const fetched=typeof window.__DSH_CONNECTION_JSON__==='function'?await window.__DSH_CONNECTION_JSON__(url,init):null;
   const response=fetched?.response??await fetch(url,init);
   if(!response.ok)throw Error('原消息接收结果尚未核实，草稿已保留');
   const receipt=fetched?fetched.data:await response.json();
   if(receipt?.requestId!==command.requestId||receipt.threadId!==command.threadId||receipt.clientUserMessageId!==command.clientUserMessageId||receipt.method!==command.method)throw Error('原消息回执身份不匹配，草稿已保留');
   return receipt;
  }
  async function reconcileSubmission(id){
   if(q.disposed)return false;
   if(receiptReads.has(id))return receiptReads.get(id);
   for(const pending of client.getConversation?.(id)?.unconfirmedTurnSubmissions||[])rememberSubmission({...pending,conversationId:id});
   if(!submissionRequests.get(id)?.size)return false;
   receiptWaiting.add(id);
   const work=(async()=>{let settled=false;
    for(const command of [...submissionRequests.get(id).values()]){
     const receipt=await readSubmissionReceipt(command);
     if(q.disposed)return settled;
     if(!['accepted','rejected'].includes(receipt.state))continue;
     if(receipt.state==='accepted'&&!validId(command.method==='turn/start'?receipt.result?.turn?.id:receipt.result?.turnId))throw Error('原消息回执尚未完整核实，草稿已保留');
     // The original response may win the HTTP race. Only its still-pending
     // request can be completed; an observation is never a second dispatch.
     if(requestClient?.requestPromises?.has(command.requestId)){
      if(receipt.state==='accepted')requestClient.onResult(command.requestId,receipt.result);
      else requestClient.onError(command.requestId,Object.assign(Error(receipt.result?.error||'原消息未被接收'),{code:receipt.result?.code}));
     }else{
      // A retained history snapshot may outlive its RequestClient promise.
      // Positive journal evidence retires only that exact unknown marker.
      client.updateConversationState?.(id,conversation=>{
       const remaining=conversation.unconfirmedTurnSubmissions?.filter(p=>!(p.requestId===command.requestId&&p.method===command.method&&p.clientUserMessageId===command.clientUserMessageId));
       if(remaining?.length)conversation.unconfirmedTurnSubmissions=remaining;
       else if(remaining)delete conversation.unconfirmedTurnSubmissions;
      });
     }
     forgetSubmission(command.requestId);settled=true;
     window.__DSH_CLIENT_LOG__?.event('send_flow',{stage:'reconciled',method:command.method,threadId:id,traceId:command.clientUserMessageId,reason:receipt.state==='accepted'?'accepted':'failed'});
    }
    // A recovered start receipt describes acceptance time. The turn may have
    // been stopped or finished since then; retain the original receipt for
    // promise settlement and separately observe the current Native head.
    if(settled)await client.dshReadExecutionHead?.(id);
    return settled;
   })().finally(()=>{if(receiptReads.get(id)===work)receiptReads.delete(id);});
   receiptReads.set(id,work);return work;
  }
  // Receipt lookup uses authenticated HTTP and can recover the command while
  // the page's event/RPC WebSocket is still disconnected.
  const reconcileVisibleSubmission=event=>{const id=event?.detail?.threadId||location.pathname.match(/^\/local\/([0-9a-f-]{36})$/i)?.[1];if(id&&!(typeof navigator!=='undefined'&&navigator.onLine===false))reconcileSubmission(id).catch(()=>{});};
  const stopReceiptListener=requestClient?.addRequestLifecycleListener?.(event=>{
   if(q.disposed)return;
   if(event.type==='started'){
    rememberSubmission(event);
    if(['turn/interrupt','thread/stop'].includes(event.method)&&event.params?.threadId)controlRequests.set(event.id,event.params.threadId);
    return;
   }
   if(!['completed','failed','timed-out'].includes(event.type))return;
   forgetSubmission(event.id);const id=controlRequests.get(event.id);controlRequests.delete(event.id);
   if(id&&event.type==='completed')Promise.resolve().then(()=>reconcileSubmission(id)).catch(()=>{});
  });
  const receiptEvents=['dsh:execution-state','dsh:session-ready','dsh:submission-unknown','online','focus'];
  for(const type of receiptEvents)addEventListener(type,reconcileVisibleSubmission);
  const activeTurn=host.getActiveTurnId.bind(host),finalAnswer=host.hasFinalAnswer.bind(host);
  host.getActiveTurnId=id=>{const head=sending.get(id);return head?.isCurrent()?head.activeTurnId:activeTurn(id);};
  host.hasFinalAnswer=id=>{const head=sending.get(id);return head?.isCurrent()&&head.activeTurnId!==activeTurn(id)?false:finalAnswer(id);};
  client.dshSubmissionHead=id=>sending.get(id);
  // Navigation still owns its original full hydration promise. Only an explicit
  // send with a fresh, current Native head may use the *same* resume attempt's
  // completed execution phase. A loaded thread is never an ownership grant.
  const resumeConversation=client.resumeConversation?.bind(client),resumeSubmission=host.resume?.bind(host);
  const submissionReady=id=>{
   const head=sending.get(id),conversation=client.getConversation?.(id);
   return !!(head?.loaded&&head.isCurrent()&&!head.activeFlags?.length&&conversation&&!conversation.unconfirmedTurnSubmissions?.length&&client.getStreamRole?.(id)?.role==='owner'&&!client.pendingThreadSettingsUpdates?.has(id)&&client.getThreadWorkspaceState?.(id)?.pendingRevision==null);
  };
  if(resumeConversation){
   const submissionMethods=Object.create(Object.getPrototypeOf(client));Object.setPrototypeOf(client,submissionMethods);
   Object.defineProperty(submissionMethods,'dshResumeForSubmission',{value:async function(params,options,fallback=resumeConversation){
    const id=params.conversationId,head=sending.get(id),entry=client.inFlightConversationResumes?.get(id);
    if(submissionReady(id)&&entry?.executionReady){
     const owner=client.getStreamRole(id),result=await entry.executionReady;
     if(result?.status!=='ready')return result;
     if(sending.get(id)!==head||!submissionReady(id)||client.getStreamRole(id)!==owner)throw Error('发送准备期间会话状态已变化，消息尚未发送；草稿已保留');
     return {status:'ready',activeTurnId:head.activeTurnId,threadSource:head.threadSource};
    }
    // Starting the original attempt is synchronous; its execution and history
    // continuations have separate promises. This also covers the first send,
    // when navigation has not already created a resume attempt.
    const full=Promise.resolve(fallback(params,options));full.catch(()=>{});
    const attempt=client.inFlightConversationResumes?.get(id);
    const result=await(attempt?.executionReady??full);
    if(result?.status!=='ready')return result;
    if(head&&sending.get(id)===head){
     await client.waitForPendingThreadSettingsUpdate?.(id);
     const current=await client.dshReadExecutionHead(id);sending.set(id,current);
     if(!current.isCurrent()||!submissionReady(id))throw Error('发送执行状态已变化，消息尚未发送；草稿已保留');
     return {status:'ready',activeTurnId:current.activeTurnId,threadSource:current.threadSource};
    }
    return result;
   }});
   if(resumeSubmission)host.resume=async params=>{await client.waitForPendingThreadSettingsUpdate?.(params.conversationId);return client.dshResumeForSubmission(params);};
  }
  const sendMessage=q.sendMessage.bind(q);
  const sendMessageWithPreflight=async(request,...args)=>{
   const id=request.conversationId;
   if(sending.has(id)){
    await reconcileSubmission(id);
    // Let the original request's handlers release their own retained draft and
    // in-flight guard. A still-live preparation cannot be stolen by this click.
    if(sending.has(id))throw Error('这条消息正在提交，请等待接收结果');
   }
   // Drafts without a Native conversation use the original creation path.
   if(!/^[0-9a-f-]{36}$/i.test(id||'')||!client.getConversation?.(id))return sendMessage(request,...args);
   // The explicit request owns its captured conversation, not the page that is
   // visible after an asynchronous preparation. Browsing B must not cancel A.
   // The client and its Native head still fence retirement, stop and reconnect.
   const initial={isCurrent:()=>false};sending.set(id,initial);
   try{
    if(!client.dshReadExecutionHead)throw Error('发送状态尚未就绪，草稿已保留');
    const resume=client.inFlightConversationResumes?.get(id);
    if(resume?.executionReady){const ready=await resume.executionReady;if(ready?.status!=='ready')throw Error('会话尚未完成发送准备，草稿已保留');}
    if(q.disposed||client.disposed)throw Error('发送客户端已变化，消息尚未发送；草稿已保留');
    const head=await client.dshReadExecutionHead(id);
    if(!head.isCurrent()||q.disposed||client.disposed)throw Error('发送准备期间会话或连接已变化，消息尚未发送；草稿已保留');
    sending.set(id,head);return await sendMessage(request,...args);
   }
   finally{sending.delete(id);}
  };

  async function preparedInput(id,message){
   if(message.dshNativeOnly)throw Error('请在原执行端编辑这条排队消息');
   if(!q.execution?.prepare)throw Error('消息准备尚未就绪，请稍后重试');
   const prepared=await q.execution.prepare(id,message,'start');
   if(prepared.status!=='ready')throw Error(prepared.reason||'此消息尚不能加入 Mac 队列');
   const submission=prepared.submission,start=submission.start;
   if(start?.context?.responseItems?.length)throw Error('此应用附件需要直接发送，暂不能加入 Mac 队列');
   const input=start?.request?.input||submission.steer?.input;
   if(!input?.length)throw Error('消息内容尚未准备完成');
   const additional=start?.request?.additionalContext;
   // Preserve additional textual context when Native queue has no separate field.
   if(additional!=null&&additional!==''&&!(Array.isArray(additional)&&!additional.length)){
    if(typeof additional!=='string')throw Error('此上下文需要直接发送，暂不能加入 Mac 队列');
    return [...input,{type:'text',text:additional,text_elements:[]}];
   }
   return input;
  }
  q.options.storage={
   read:()=>({isLoading:!loaded,value:state}),
   load:async()=>{try{await load();}catch{if(!loaded)throw Error('队列暂时无法读取');}return state;},
   update:fn=>{const next=writes.catch(()=>{}).then(async()=>{
    const proposed=fn(structuredClone(state));
    const changed=[...new Set([...Object.keys(state),...Object.keys(proposed)])].filter(id=>JSON.stringify(state[id]||[])!==JSON.stringify(proposed[id]||[]));
    for(const id of changed){await reconcile(id);await load(id);}
    const before=structuredClone(state),after=fn(structuredClone(before));
    for(const id of new Set([...Object.keys(before),...Object.keys(after)])){
     const messages=after[id]||[];if(JSON.stringify(before[id]||[])===JSON.stringify(messages))continue;
     await reconcile(id);if(!revisions[id])await load(id);
     const inputs={};for(const message of messages)if(JSON.stringify((before[id]||[]).find(m=>m.id===message.id))!==JSON.stringify(message))inputs[message.id]=await preparedInput(id,message);
     accept(await api({commandId:crypto.randomUUID(),threadId:id,operation:'sync',revision:revisions[id],messages,inputs}));
    }
    return state;
   });writes=next;next.catch(feedback).finally(()=>{refresh();}).catch(()=>{});return next;}
  };
  const sendQueuedMessageNow=async(id,messageId)=>{
   if(mutating.has(id))throw Error('正在更新这条会话的队列');mutating.add(id);
   try{
    await writes.catch(()=>{});await reconcile(id);await load(id);publish();
    if(!state[id]?.some(message=>message.id===messageId))throw Error('队列已更新，这条消息已不在等待列表中');
    accept(await api({commandId:crypto.randomUUID(),threadId:id,operation:'send-now',revision:revisions[id],messageId}));publish();
    return {status:'sent',messageId,turnId:q.options.submissionHost.getActiveTurnId(id)};
   }catch(error){feedback(error);await load(id).then(publish).catch(()=>{});throw error;}finally{mutating.delete(id);refresh();}
  };
  // RpcTarget exposes prototype methods, never per-instance function fields.
  // Retain the original instance/private fields and its existing class chain.
  class NativeQueueRpc extends q.constructor {
   sendMessage(...args){return sendMessageWithPreflight(...args);}
   sendQueuedMessageNow(...args){return sendQueuedMessageNow(...args);}
  }
  Object.setPrototypeOf(q,NativeQueueRpc.prototype);
  // Legacy drafts are never silently re-sent: preserve them visibly, and let
  // an explicit queue edit migrate the prepared input with a fresh command.
  const legacy=originalStorage.read?.();
  if(legacy?.value)for(const[id,messages]of Object.entries(legacy.value))if(messages?.length)state[id]=messages.map(m=>({...m,pausedReason:'旧网页队列尚未交给 Mac，请编辑后重新排队'}));
  const timer=setInterval(()=>{if(q.disposed){clearInterval(timer);stopReceiptListener?.();client.dshDisposeSubmissionHead?.();for(const type of receiptEvents)removeEventListener(type,reconcileVisibleSubmission);submissionRequests.clear();controlRequests.clear();receiptWaiting.clear();}else if(document.visibilityState==='visible'){
   refresh();
   // Continue an unresolved receipt observation on the existing foreground
   // refresh tick. A later accepted journal entry must not require a new click
   // through the still-busy composer, and no command is dispatched here.
   const id=location.pathname.match(/^\/local\/([0-9a-f-]{36})$/i)?.[1];if(id&&receiptWaiting.has(id))reconcileVisibleSubmission();
  }},3000);
  addEventListener('online',refresh);addEventListener('focus',refresh);addEventListener('dsh:native-route',refresh);
  const refreshAfterActivity=event=>{const id=event.detail?.threadId||location.pathname.match(/^\/local\/([0-9a-f-]{36})$/i)?.[1];if(id&&(q.pending.has(id)||mutating.has(id)||state[id]?.length||q.messages.get(id)?.messages?.length))refresh();};
  addEventListener('dsh:history-updated',refreshAfterActivity);addEventListener('dsh:android-status',refreshAfterActivity);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){refresh();reconcileVisibleSubmission();}});refresh();
 };
})();

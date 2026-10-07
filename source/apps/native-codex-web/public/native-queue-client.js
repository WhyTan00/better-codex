// Adapt the original queue UI; Native is the sole automatic consumer.
(()=>{
 const scope=window.__DSH_SCOPE__;if(!scope)return;
 const installed=new WeakSet(),clientId=crypto.randomUUID(),inflightCommands=new Map();
 const ackDeadlines=new WeakMap(),terminalWrites=new Map();
 function markAccepted(command,result){
  if(!ackDeadlines.has(result))ackDeadlines.set(result,Date.now()+1200);
  if(!terminalWrites.has(command.id)){
   const write=Promise.resolve().then(()=>window.__DSH_NATIVE_CACHE__.recordCommand({...command,state:'accepted'},{timeoutMs:Math.max(1,ackDeadlines.get(result)-Date.now())}));
   terminalWrites.set(command.id,write);write.catch(()=>{});
   write.finally(()=>{if(terminalWrites.get(command.id)===write)terminalWrites.delete(command.id);}).catch(()=>{});
  }
  return result;
 }
  // One active write and one replacement latest snapshot, never a
  // write-per-refresh promise chain. Epochs are local scheduling fences, not
  // an ordering claim about opaque Native queue revision hashes.
  let activeQueueClient=null,snapshotEpoch=0,durableEpoch=0,latestSnapshot=null,pendingSnapshot=null,snapshotWriter=null;
  const checkpointWaiters=new Set(),cacheStats={writes:0,failures:0,timeouts:0};
  const cacheEvent=(reason,stored)=>{try{window.__DSH_CLIENT_LOG__?.event('client_health',{component:'native-queue-cache',reason,localStored:stored});}catch{}};
  function settleCheckpoints(epoch,result){
   for(const waiter of [...checkpointWaiters])if(waiter.target<=epoch){checkpointWaiters.delete(waiter);clearTimeout(waiter.timer);waiter.resolve(result);}
  }
  function pumpSnapshots(){
   if(snapshotWriter||!pendingSnapshot)return;
   snapshotWriter=Promise.resolve().then(async()=>{
    while(pendingSnapshot){
     const next=pendingSnapshot;pendingSnapshot=null;
     if(next.epoch<=durableEpoch)continue;
     try{
      const save=window.__DSH_NATIVE_CACHE__?.saveMeta;
      if(!save)throw Error('display cache unavailable');
      cacheStats.writes++;
      await save.call(window.__DSH_NATIVE_CACHE__,'native-queue',next.snapshot,{timeoutMs:1200});
      durableEpoch=Math.max(durableEpoch,next.epoch);
      settleCheckpoints(durableEpoch,{localStored:true,reason:'committed'});
     }catch(error){
      cacheStats.failures++;
      // A failed old read write must not fail a newer command checkpoint.
      settleCheckpoints(next.epoch,{localStored:false,reason:'cache_failed'});
      cacheEvent('checkpoint_cache_failed',false);
     }
    }
   }).finally(()=>{snapshotWriter=null;if(pendingSnapshot)pumpSnapshots();});
   snapshotWriter.catch(()=>{});
  }
  function scheduleSnapshot(snapshot,changed){
   if(changed||!latestSnapshot){latestSnapshot={epoch:++snapshotEpoch,snapshot:structuredClone(snapshot)};}
   if(durableEpoch>=latestSnapshot.epoch)return;
   pendingSnapshot=latestSnapshot;pumpSnapshots();
  }
  function checkpointSnapshot(target=snapshotEpoch,deadline=Date.now()+1200){
   if(durableEpoch>=target)return Promise.resolve({localStored:true,reason:'already_committed'});
   if(!latestSnapshot)return Promise.resolve({localStored:false,reason:'unavailable'});
   scheduleSnapshot(latestSnapshot.snapshot,false);
   return new Promise(resolve=>{
    const waiter={target,resolve,timer:null};
    waiter.timer=setTimeout(()=>{checkpointWaiters.delete(waiter);cacheStats.timeouts++;cacheEvent('checkpoint_timeout',false);resolve({localStored:false,reason:'cache_timeout'});},Math.max(0,deadline-Date.now()));
    checkpointWaiters.add(waiter);
   });
  }

 async function rawAPI(request,threadId,commandId){
  if(window.__DSH_NATIVE_ONLINE__===false)throw Error('Mac 暂未连接，消息尚未提交');
  const query=commandId?'?commandId='+encodeURIComponent(commandId):threadId?'?threadId='+encodeURIComponent(threadId):'';
  const response=await fetch('/w/'+scope.id+'/api/native-queue'+query,{method:request?'POST':'GET',headers:{'x-dsh-scope':scope.token,...(request?{'content-type':'application/json'}:{})},...(request?{body:JSON.stringify({clientId,request})}:{}),cache:'no-store',redirect:'manual'});
  if(response.status===401||response.type==='opaqueredirect')throw Error('请重新登录；消息接收结果待核对');const result=await response.json();if(!response.ok)throw Error(result.error||'Mac 队列暂不可用');return result;
 }
 async function resolveCommand(command){
  const result=await rawAPI(null,null,command.id);
  if(['accepted','rejected'].includes(result.state)){
   if(result.state==='accepted')markAccepted(command,result.result);
   else await window.__DSH_NATIVE_CACHE__.recordCommand({...command,state:result.state}).catch(()=>{});
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
  try{const result=await Promise.race([rawAPI(request,threadId),recovered]);return markAccepted(command,result);}
  catch(error){await window.__DSH_NATIVE_CACHE__.recordCommand({...command,state:'unknown'}).catch(()=>{});let status;try{status=await resolveCommand(command);}catch{}if(status?.state==='accepted')return status.result;if(status?.state==='rejected')throw error;throw Error('Mac 接收结果待核对，不会自动重发；请恢复连接后查看队列和会话');}finally{inflightCommands.delete(command.id);}
 }
 window.__DSH_INSTALL_NATIVE_QUEUE__=client=>{
  if(client.hostId!=='local'||installed.has(client))return;
  const q=client.turnCoordinator;if(!q){setTimeout(()=>window.__DSH_INSTALL_NATIVE_QUEUE__(client),50);return;}
  installed.add(client);activeQueueClient=client;let state=structuredClone(latestSnapshot?.snapshot.state||{}),revisions=structuredClone(latestSnapshot?.snapshot.revisions||{}),loaded=!!latestSnapshot,refreshing=null,writes=Promise.resolve(),sequence=0;
  const applied=new Map(),reads=new Map(),mutating=new Set();
  let dshEmptyQueueEpoch=0,dshQueueMutationPending=0;const dshEmptyQueueReads=new Map();
  const dshRetireEmptyQueue=()=>{dshEmptyQueueEpoch++;dshEmptyQueueReads.clear();};
  const dshEmptyQueueEvents=['dsh:execution-state','dsh:app-host-state','dsh:authentication-required','dsh:session-ready','dsh:submission-unknown'];
  for(const event of dshEmptyQueueEvents)addEventListener(event,dshRetireEmptyQueue);
  const feedback=error=>window.dispatchEvent(new CustomEvent('dsh:queue-error',{detail:{message:error?.message||'队列操作未完成，请稍后重试'}}));
  const originalStorage=q.options.storage;window.__DSH_NATIVE_CACHE__?.meta('native-queue').then(cached=>{if(client===activeQueueClient&&!client.disposed&&!q.disposed&&cached&&!loaded){state=cached.state||{};revisions=cached.revisions||{};loaded=true;publish();}}).catch(()=>{});
  function accept(result,ticket=++sequence,readScope=null,dshReadEpoch=null){
   if(client!==activeQueueClient||client.disposed||q.disposed)return state;
   if(!result||result.authority!=='mac-native'||!result.state||!result.revisions)throw Error('队列结果尚未确认');
   let changed=false;
   for(const [id,messages]of Object.entries(result.state)){
    if(!Array.isArray(messages)||ticket<(applied.get(id)||0)||readScope==='*'&&(q.pending.has(id)||mutating.has(id)))continue;
    applied.set(id,ticket);if(readScope!==null&&dshReadEpoch===dshEmptyQueueEpoch)dshEmptyQueueReads.set(id,{epoch:dshReadEpoch,revision:result.revisions[id]});else dshEmptyQueueReads.delete(id);
    if(revisions[id]===result.revisions[id]&&JSON.stringify(state[id]||[])===JSON.stringify(messages))continue;
    changed=true;state={...state,[id]:messages};revisions={...revisions,[id]:result.revisions[id]};
   }
   loaded=true;
   scheduleSnapshot({state,revisions,authority:'mac-native'},changed);return state;
  }
  async function load(threadId){
   const key=threadId||'*';if(reads.has(key))return reads.get(key);
   const ticket=++sequence,dshReadEpoch=dshEmptyQueueEpoch,operation=api(null,threadId).then(result=>accept(result,ticket,key,dshReadEpoch)).finally(()=>reads.delete(key));
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
   const command={threadId,requestId,clientUserMessageId,method:value.method};
   requests.set(requestId,command);return command;
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
  const receiptClientActive=()=>client===activeQueueClient&&!client.disposed&&!q.disposed;
  const receiptCanObserve=()=>receiptClientActive()&&document.visibilityState==='visible'&&!(typeof navigator!=='undefined'&&navigator.onLine===false);
  async function reconcileSubmission(id){
   if(!receiptCanObserve())return false;
   if(receiptReads.has(id))return receiptReads.get(id);
   for(const pending of client.getConversation?.(id)?.unconfirmedTurnSubmissions||[])rememberSubmission({...pending,conversationId:id});
   if(!submissionRequests.get(id)?.size)return false;
   receiptWaiting.add(id);
   const work=(async()=>{let settled=false;
    for(const command of [...submissionRequests.get(id).values()]){
     if(!receiptCanObserve())return settled;
     const receipt=await readSubmissionReceipt(command);
     if(!receiptClientActive())return settled;
     // A completed RPC or a retired observation cannot mutate its successor.
     if(submissionRequests.get(id)?.get(command.requestId)!==command)continue;
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
    if(settled&&receiptClientActive())await client.dshReadExecutionHead?.(id);
    return settled;
   })().finally(()=>{if(receiptReads.get(id)===work)receiptReads.delete(id);});
   receiptReads.set(id,work);return work;
  }
  // Receipt lookup uses authenticated HTTP and can recover the command while
  // the page's event/RPC WebSocket is still disconnected.
  const reconcileVisibleSubmission=event=>{if(!receiptCanObserve())return;const id=event?.detail?.threadId||location.pathname.match(/^\/local\/([0-9a-f-]{36})$/i)?.[1];if(id)reconcileSubmission(id).catch(()=>{});};
  const stopReceiptListener=requestClient?.addRequestLifecycleListener?.(event=>{
   if(!receiptClientActive())return;
   if(event.type==='started'){
    const command=rememberSubmission(event);if(command)receiptWaiting.add(command.threadId);
    if(['turn/interrupt','thread/stop'].includes(event.method)&&event.params?.threadId)controlRequests.set(event.id,event.params.threadId);
    return;
   }
   if(!['completed','failed','timed-out'].includes(event.type))return;
   // Plain timeouts retain observation only while their original promise or
   // exact unknown marker remains; a rejected request alone must stop polling.
   const timedOutCommand=event.type==='timed-out'&&[...submissionRequests.values()].map(requests=>requests.get(event.id)).find(Boolean);
   const keepTimedOut=timedOutCommand&&(requestClient?.requestPromises?.has(event.id)||client.getConversation?.(timedOutCommand.threadId)?.unconfirmedTurnSubmissions?.some(p=>p.requestId===event.id&&p.method===timedOutCommand.method&&p.clientUserMessageId===timedOutCommand.clientUserMessageId));
   if(!keepTimedOut)forgetSubmission(event.id);const id=controlRequests.get(event.id);controlRequests.delete(event.id);
   if(event.type==='dispatch'&&['turn/interrupt','thread/stop','thread/resume','thread/settings/update'].includes(event.method))dshRetireEmptyQueue();if(id&&event.type==='completed')Promise.resolve().then(()=>reconcileSubmission(id)).catch(()=>{});
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
   const traceId=request.message?.id;
   let prerequisite='thread/read';
   try{
    if(!client.dshReadExecutionHead)throw Error('发送状态尚未就绪，草稿已保留');
    window.__DSH_CLIENT_LOG__?.event('send_flow',{stage:'preparing',reason:'native',method:'thread/read',threadId:id,traceId});
    // Start the independently authenticated head read alongside the existing
    // Native resume. Its owner/configuration acceptance remains mandatory;
    // display preparation must not add another sequential head-read wait.
    const readingHead=Promise.resolve().then(()=>client.dshReadExecutionHead(id));readingHead.catch(()=>{});
    const resume=client.inFlightConversationResumes?.get(id);
    const failureTag=Symbol('send-prerequisite');
    const check=(work,method)=>Promise.resolve(work).catch(error=>{throw {tag:failureTag,method,error};});
    const resumeReady=resume?.executionReady?Promise.resolve(resume.executionReady).then(ready=>{if(ready?.status!=='ready')throw Error('会话尚未完成发送准备，草稿已保留');return ready;}):Promise.resolve(null);
    if(resume?.executionReady)window.__DSH_CLIENT_LOG__?.event('send_flow',{stage:'preparing',reason:'preparation',method:'thread/resume',threadId:id,traceId});
    let head;
    try{[head]=await Promise.all([check(readingHead,'thread/read'),check(resumeReady,'thread/resume')]);}
    catch(failure){if(failure?.tag===failureTag){prerequisite=failure.method;throw failure.error;}throw failure;}
    if(q.disposed||client.disposed)throw Error('发送客户端已变化，消息尚未发送；草稿已保留');
    prerequisite='thread/read';
    // A cold resume/reconnect can retire the parallel head while the same
    // original preparation is completing. Recheck reads once, after that
    // preparation; no command has been submitted and no write is replayed.
    if(!head.isCurrent()){
     window.__DSH_CLIENT_LOG__?.event('send_flow',{stage:'preparing',reason:'preparation',method:'thread/read',threadId:id,traceId});
     head=await client.dshReadExecutionHead(id);
    }
    if(!head.isCurrent()||q.disposed||client.disposed)throw Error('发送准备期间会话或连接已变化，消息尚未发送；草稿已保留');
    sending.set(id,head);prerequisite=null;
    window.__DSH_CLIENT_LOG__?.event('send_flow',{stage:'received',reason:'preparation',method:'thread/read',threadId:id,traceId});
    return await sendMessage(request,...args);
   }
   catch(error){if(prerequisite)window.__DSH_CLIENT_LOG__?.event('send_flow',{stage:'failed',reason:'preparation',method:prerequisite,threadId:id,traceId,notSubmitted:true});throw error;}
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
   dshCanSkipEmptyResume:id=>{const stamp=dshEmptyQueueReads.get(id);return !!(receiptClientActive()&&window.__DSH_EXECUTION_CONNECTED__===true&&navigator.onLine&&loaded&&stamp&&stamp.epoch===dshEmptyQueueEpoch&&typeof stamp.revision==='string'&&stamp.revision&&stamp.revision===revisions[id]&&Object.hasOwn(state,id)&&Array.isArray(state[id])&&state[id].length===0&&!refreshing&&!reads.size&&!mutating.size&&dshQueueMutationPending===0&&!inflightCommands.size&&!terminalWrites.size&&!submissionRequests.has(id)&&!receiptWaiting.has(id)&&![...controlRequests.values()].includes(id));},
   read:()=>({isLoading:!loaded,value:state}),
   load:async()=>{try{await load();}catch{if(!loaded)throw Error('队列暂时无法读取');}return state;},
   update:fn=>{dshQueueMutationPending++;const next=writes.catch(()=>{}).then(async()=>{
    const proposed=fn(structuredClone(state));
    const changed=[...new Set([...Object.keys(state),...Object.keys(proposed)])].filter(id=>JSON.stringify(state[id]||[])!==JSON.stringify(proposed[id]||[]));
    for(const id of changed){await reconcile(id);await load(id);}
    const before=structuredClone(state),after=fn(structuredClone(before));
    for(const id of new Set([...Object.keys(before),...Object.keys(after)])){
     const messages=after[id]||[];if(JSON.stringify(before[id]||[])===JSON.stringify(messages))continue;
     await reconcile(id);if(!revisions[id])await load(id);
     const inputs={};for(const message of messages)if(JSON.stringify((before[id]||[]).find(m=>m.id===message.id))!==JSON.stringify(message))inputs[message.id]=await preparedInput(id,message);
     const result=await api({commandId:crypto.randomUUID(),threadId:id,operation:'sync',revision:revisions[id],messages,inputs});accept(result);
     checkpointSnapshot(snapshotEpoch,ackDeadlines.get(result)).catch(()=>{});
    }
    return state;
   });writes=next;next.catch(feedback).finally(()=>{dshQueueMutationPending--;refresh();}).catch(()=>{});return next;}
  };
  const sendQueuedMessageNow=async(id,messageId)=>{
   if(mutating.has(id))throw Error('正在更新这条会话的队列');mutating.add(id);
   try{
    await writes.catch(()=>{});await reconcile(id);await load(id);publish();
    if(!state[id]?.some(message=>message.id===messageId))throw Error('队列已更新，这条消息已不在等待列表中');
    const result=await api({commandId:crypto.randomUUID(),threadId:id,operation:'send-now',revision:revisions[id],messageId});accept(result);publish();
    checkpointSnapshot(snapshotEpoch,ackDeadlines.get(result)).catch(()=>{});
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
  const timer=setInterval(()=>{if(!receiptClientActive()){clearInterval(timer);for(const event of dshEmptyQueueEvents)removeEventListener(event,dshRetireEmptyQueue);dshRetireEmptyQueue();stopReceiptListener?.();client.dshDisposeSubmissionHead?.();for(const type of receiptEvents)removeEventListener(type,reconcileVisibleSubmission);submissionRequests.clear();controlRequests.clear();receiptWaiting.clear();}else if(document.visibilityState==='visible'){
   refresh();
   // Continue an unresolved receipt observation on the existing foreground
   // refresh tick. A later accepted journal entry must not require a new click
   // through the still-busy composer, and no command is dispatched here.
   if(receiptCanObserve())for(const id of [...receiptWaiting])reconcileSubmission(id).catch(()=>{});
  }},3000);
  addEventListener('online',refresh);addEventListener('focus',refresh);addEventListener('dsh:native-route',refresh);
  const refreshAfterActivity=event=>{const id=event.detail?.threadId||location.pathname.match(/^\/local\/([0-9a-f-]{36})$/i)?.[1];if(id&&(q.pending.has(id)||mutating.has(id)||state[id]?.length||q.messages.get(id)?.messages?.length))refresh();};
  addEventListener('dsh:history-updated',refreshAfterActivity);addEventListener('dsh:android-status',refreshAfterActivity);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){refresh();reconcileVisibleSubmission();}});refresh();
 };
})();

// Shared attachment handoff, followed by Android-only presentation.
(()=>{
 const scope=window.__DSH_SCOPE__;if(!scope)return;
 function afterVisiblePaint(){return new Promise(resolve=>{let first=0,second=0,done=false;const finish=()=>{if(done)return;done=true;cancelAnimationFrame(first);cancelAnimationFrame(second);document.removeEventListener('visibilitychange',hidden);removeEventListener('pagehide',finish);resolve();},hidden=()=>{if(document.visibilityState==='hidden')finish();};if(document.visibilityState==='hidden'){finish();return;}document.addEventListener('visibilitychange',hidden);addEventListener('pagehide',finish,{once:true});first=requestAnimationFrame(()=>{second=requestAnimationFrame(finish);});});}
 // Show selected local bytes before serialization or the private upload request.
 // Preview objects never enter storage, the transcript or a second upload queue.
 const localUploads=new Set();
 function clearUpload(ticket){ticket.node.remove();for(const url of ticket.urls)URL.revokeObjectURL(url);ticket.urls=[];ticket.release?.();ticket.release=null;localUploads.delete(ticket);}
 const currentUpload=ticket=>ticket.path===location.pathname&&ticket.host.isConnected;
 function reconcileUploads(){
  for(const ticket of localUploads){
   if(ticket.path!==location.pathname||!ticket.host.isConnected){clearUpload(ticket);continue;}
   if(ticket.node.parentNode!==ticket.host)ticket.host.prepend(ticket.node);
   if(ticket.state!=='ready')continue;
   const images=[...ticket.host.querySelectorAll('img')].filter(n=>!n.closest('[data-dsh-upload-preview]')&&!ticket.priorImages.has(n));
   const originals=[...ticket.host.querySelectorAll('[title],[aria-label]')].filter(n=>!n.closest('[data-dsh-upload-preview]'));
   if(images.length>=ticket.imageCount&&ticket.otherNames.every(name=>originals.some(n=>(n.getAttribute('title')||'').includes(name)||(n.getAttribute('aria-label')||'').includes(name))))clearUpload(ticket);
  }
 }
 window.__DSH_ANDROID_UPLOAD__={
  busy:()=>[...localUploads].some(t=>currentUpload(t)&&['uploading','handoff','failed'].includes(t.state)),
  showPending(){for(const t of localUploads)if(currentUpload(t)){if(t.state==='uploading')t.status.textContent='附件正在上传，完成后即可发送';else if(t.state==='handoff')t.status.textContent='正在将附件加入消息，完成后即可发送';else if(t.state==='failed')t.status.textContent='附件未加入消息，请重新选择，或移除此附件后继续';}},
  clearReady(){for(const t of [...localUploads])if(t.state==='ready')clearUpload(t);},
  begin(files,{awaitHandoff=false}={}){
   const editor=document.querySelector('[data-codex-composer]'),host=editor?.closest('[data-codex-composer-root]');
   if(!host)return null;
   // A new, completed picker choice is an explicit replacement for a failed
   // selection. Merely cancelling the system picker does not clear the fault.
   for(const prior of [...localUploads])if(prior.state==='failed'&&prior.host===host&&currentUpload(prior))clearUpload(prior);
   const node=document.createElement('div');node.dataset.dshUploadPreview='1';node.className='dsh-upload-preview';
   const items=document.createElement('div');items.className='dsh-upload-preview-items';
   const status=document.createElement('small');status.setAttribute('role','status');status.textContent='正在上传附件…';
   const ticket={node,host,status,path:location.pathname,state:'uploading',awaitHandoff,release:null,urls:[],priorImages:new Set(host.querySelectorAll('img')),imageCount:0,otherNames:[]};
   for(const file of files){const item=document.createElement('div');item.className='dsh-upload-preview-item';
    if(/^image\//.test(file.type)){const img=document.createElement('img'),url=URL.createObjectURL(file);ticket.urls.push(url);ticket.imageCount++;img.src=url;img.alt=file.name;item.append(img);}else ticket.otherNames.push(file.name);
    const name=document.createElement('span');name.textContent=file.name;item.append(name);items.append(item);
   }
   node.append(items,status);localUploads.add(ticket);host.prepend(node);
   const painted=afterVisiblePaint();
   return {presented:()=>painted,complete(_result,release){if(!localUploads.has(ticket)){release?.();return}ticket.release=release;ticket.state=ticket.awaitHandoff?'handoff':'ready';status.textContent='已上传，正在加入附件…';requestAnimationFrame(reconcileUploads);},accepted(){if(!localUploads.has(ticket))return;ticket.state='ready';status.textContent='附件已加入消息';ticket.release?.();ticket.release=null;requestAnimationFrame(reconcileUploads);},cancel(){clearUpload(ticket);},fail(handoff=false){if(!localUploads.has(ticket))return;ticket.release?.();ticket.release=null;ticket.state='failed';status.textContent=handoff?'附件未加入消息，请重新选择，或移除此附件后继续':'附件上传失败，请重新选择，或移除此附件后继续';if(ticket.close)return;const close=document.createElement('button');ticket.close=close;close.type='button';close.textContent='移除此附件';close.onclick=()=>clearUpload(ticket);node.append(close);}};
  }
 };
 new MutationObserver(reconcileUploads).observe(document,{subtree:true,childList:true});
 addEventListener('dsh:native-route',()=>{for(const t of [...localUploads])if(t.path!==location.pathname)clearUpload(t);reconcileUploads();});
 addEventListener('pagehide',event=>{if(!event.persisted)for(const t of [...localUploads])clearUpload(t);});
 // End shared attachment handoff.
 if(!window.__DSH_ANDROID_HOST__&&!/\bDSHAndroid\//.test(navigator.userAgent||''))return;
 document.documentElement.dataset.dshAndroid='1';
 // Hide application chrome when the IME reduces or pans the visual viewport.
 // Track the unobscured height separately for each fold/orientation width.
 const inputRoot=document.documentElement,viewport=window.visualViewport;
 let nativeIme=null;
 let inputWidth=Math.round(innerWidth),unobscuredHeight=Math.max(innerHeight,viewport?.height||0),inputFrame=0;
 function inputFocused(){let node=document.activeElement;try{if(node?.tagName==='IFRAME')node=node.contentDocument?.activeElement;}catch{}return !!node?.closest?.('textarea,input:not([type="hidden"]),[contenteditable="true"]');}
 function updateInputChrome(){
  inputFrame=0;const width=Math.round(innerWidth),height=viewport?.height||innerHeight,focused=inputFocused();
  if(Math.abs(width-inputWidth)>32){inputWidth=width;unobscuredHeight=Math.max(innerHeight,height);}
  if(height>unobscuredHeight)unobscuredHeight=Math.max(innerHeight,height);
  const reduced=Math.max(unobscuredHeight,innerHeight)-height>120;
  const panned=(viewport?.offsetTop||0)>8;
  const open=focused&&(nativeIme===true||reduced||panned);
  if(open)inputRoot.dataset.dshKeyboard='1';else delete inputRoot.dataset.dshKeyboard;
 }
 function scheduleInputChrome(){if(!inputFrame)inputFrame=requestAnimationFrame(updateInputChrome);}
 window.__DSH_ANDROID_INPUT__={refresh:scheduleInputChrome,insets:(open,height)=>{nativeIme=open;scheduleInputChrome();}};
 function inputGeometry(reason,stage,traceId){const node=document.activeElement,box=node?.getBoundingClientRect?.();window.__DSH_CLIENT_LOG__?.event('client_health',{component:'android-webview',stage,reason,traceId,viewportHeight:Math.round(viewport?.height||innerHeight),viewportOffset:Math.round(Math.abs(viewport?.offsetTop||0)),documentOffset:Math.round(Math.abs(scrollY)),composerTop:Math.round(Math.abs(box?.top||0)),composerBottom:Math.round(Math.abs(box?.bottom||0)),fresh:document.visibilityState==='visible'});}
 document.addEventListener('input',event=>{
  const editor=event.target?.closest?.('textarea,[contenteditable="true"]');if(!editor||(editor.value??editor.textContent??'').trim())return;
  const traceId=crypto.randomUUID();inputGeometry('input_empty','received',traceId);
  const settle=()=>{if(document.activeElement!==editor||document.documentElement.dataset.dshPlugin)return;
   // Correct only the outer viewport, never the editor selection or transcript position.
   if(window.scrollX||window.scrollY)window.scrollTo(0,0);
   scheduleInputChrome();inputGeometry('input_empty','settled',traceId);
  };requestAnimationFrame(settle);setTimeout(settle,250);
 },true);
 addEventListener('resize',scheduleInputChrome);viewport?.addEventListener('resize',scheduleInputChrome);viewport?.addEventListener('scroll',scheduleInputChrome);
 document.addEventListener('focusin',scheduleInputChrome,true);document.addEventListener('focusout',scheduleInputChrome,true);
 addEventListener('dsh:native-route',scheduleInputChrome);addEventListener('pageshow',scheduleInputChrome);
 scheduleInputChrome();

 const pendingKey='dsh-pending-display-v1:'+scope.id;let pendingPersisted=true;
 let queueNotice=null,queueNoticeTimer=null;
 addEventListener('dsh:queue-error',event=>{queueNotice?.remove();clearTimeout(queueNoticeTimer);queueNotice=document.createElement('div');queueNotice.className='dsh-connection-status';queueNotice.setAttribute('role','alert');queueNotice.textContent=event.detail?.message||'队列操作未完成';document.body.append(queueNotice);queueNoticeTimer=setTimeout(()=>{queueNotice?.remove();queueNotice=null;},10000);});

 // Pending prompts belong to the transcript. Keep their delivery state separate
 // from committed native items; never replay a stored pending prompt.
 const pendingPrompts=new Map();let pendingFrame=0,pendingRoot=null,followingPrompt=null,tailFrame=0,tailFinal=false;
 const currentThread=()=>location.pathname.match(/^\/local\/([0-9a-f-]{36})$/i)?.[1]||null;
 // The official timeline is reversed: its first child is the newest edge.
 // Keep the send handoff at that edge, and stop immediately on a reading gesture.
 const reversed=root=>getComputedStyle(root).flexDirection==='column-reverse';
 function stopFollowing(){followingPrompt=null;tailFinal=false;cancelAnimationFrame(tailFrame);tailFrame=0;}
 function settleLatest(){
  if(!followingPrompt)return;cancelAnimationFrame(tailFrame);
  const record=followingPrompt;
  const pin=()=>{if(followingPrompt!==record||!matchesPage(record)||window.__DSH_NATIVE_SIDEBAR__?.isList||document.documentElement.dataset.dshPlugin)return false;const root=document.querySelector('[data-app-action-timeline-scroll]');if(!root)return false;root.scrollTop=reversed(root)?0:Math.max(0,root.scrollHeight-root.clientHeight);return true;};
  tailFrame=requestAnimationFrame(()=>{tailFrame=0;if(!pin())return;tailFrame=requestAnimationFrame(()=>{tailFrame=0;pin();if(tailFinal&&followingPrompt===record)stopFollowing();});});
 }
 for(const type of ['wheel','touchstart','pointerdown','keydown'])document.addEventListener(type,event=>{if(!event.isTrusted||!followingPrompt||!event.target?.closest?.('[data-app-action-timeline-scroll]'))return;if(type==='keydown'&&!['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))return;stopFollowing();},{capture:true,passive:true});
 addEventListener('dsh:native-route',()=>{if(followingPrompt&&!matchesPage(followingPrompt))stopFollowing();});
 addEventListener('resize',settleLatest);window.visualViewport?.addEventListener('resize',settleLatest);
 function persistPending(){try{if(pendingPrompts.size)sessionStorage.setItem(pendingKey,JSON.stringify([...pendingPrompts.values()].map(v=>v.record)));else sessionStorage.removeItem(pendingKey);pendingPersisted=true;}catch{pendingPersisted=false;}}
 function dropPending(id){if(followingPrompt?.id===id){tailFinal=true;settleLatest();}const entry=pendingPrompts.get(id);entry?.row?.remove();entry?.badge?.remove();pendingPrompts.delete(id);persistPending();if(!pendingPrompts.size){pendingRoot?.remove();pendingRoot=null;}}
 function matchesPage(record){return !!currentThread()&&(record.threadId===currentThread()||record.clientThreadId===currentThread())||!record.threadId&&record.path===location.pathname;}
 function nativeRow(record){
  const ids=new Set([record.id,record.messageId].filter(Boolean).map(id=>encodeURIComponent(id)));
  return [...document.querySelectorAll('[data-local-conversation-item-target-ids]')].find(n=>!n.closest('[data-dsh-pending-prompts]')&&(n.getAttribute('data-local-conversation-item-target-ids')||'').split(' ').some(id=>ids.has(id)));
 }
 function pendingHost(){
  // The reverse scroller contains an absolute composer and a separate normal-flow
  // content column. Only that column owns the footer spacer and message insets.
  return document.querySelector('[data-app-action-timeline-scroll] [data-thread-user-message-navigation-content]');
 }
 function renderPending(){
  pendingFrame=0;for(const entry of pendingPrompts.values())if(!matchesPage(entry.record)){entry.row?.remove();entry.badge?.remove();}const visible=[...pendingPrompts.values()].filter(v=>matchesPage(v.record));
  if(!visible.length||window.__DSH_NATIVE_SIDEBAR__?.isList||document.documentElement.dataset.dshPlugin){if(window.__DSH_NATIVE_SIDEBAR__?.isList||document.documentElement.dataset.dshPlugin)stopFollowing();pendingRoot?.remove();for(const v of pendingPrompts.values())v.badge?.remove();return;}
  for(const entry of visible){
   const record=entry.record,real=nativeRow(record);
   if(real&&(record.state==='accepted'||record.state==='queued')){dropPending(record.id);continue;}
   const label=record.state==='accepted'?'已发送':record.state==='queued'?'已排队':record.state==='failed'?(record.reason||'未发送，请重试'):record.state==='unknown'?'发送结果待确认，请勿重复发送':record.state==='preparing'?(record.reason||'准备发送…'):'正在发送…';
   if(real){record.renderOwner='native';entry.row?.remove();if(!entry.badge){entry.badge=document.createElement('small');entry.badge.className='dsh-inline-send-state';entry.badge.setAttribute('role','status');}if(entry.badge.textContent!==label)entry.badge.textContent=label;if(entry.badge.parentNode!==real)real.append(entry.badge);continue;}
   entry.badge?.remove();
   if(record.renderOwner==='native'&&!['failed','unknown'].includes(record.state)){entry.row?.remove();continue;}
   const host=pendingHost();if(!host)continue;
   if(!pendingRoot){pendingRoot=document.createElement('div');pendingRoot.dataset.dshPendingPrompts='1';pendingRoot.className='dsh-inline-prompts';}
   if(pendingRoot.parentNode!==host||host.lastElementChild!==pendingRoot)host.append(pendingRoot);
   if(!entry.row){
    const row=document.createElement('article');row.className='dsh-inline-prompt';row.dataset.pendingId=record.id;
    const text=document.createElement('div');text.className='dsh-inline-prompt-text';text.dataset.markdownTextTone='user-message';text.textContent=record.text;
    const status=document.createElement('small');status.className='dsh-inline-send-state';status.setAttribute('role','status');
    const actions=document.createElement('div');actions.className='dsh-inline-send-actions';
    const copy=document.createElement('button');copy.type='button';copy.textContent='复制';copy.hidden=!!record.attachmentOnly;copy.onclick=()=>navigator.clipboard.writeText(record.text).catch(()=>{});
    const dismiss=document.createElement('button');dismiss.type='button';dismiss.textContent='收起提示';dismiss.onclick=()=>dropPending(record.id);actions.append(copy,dismiss);
    row.append(text,status,actions);entry.row=row;entry.status=status;entry.actions=actions;
   }
   if(entry.status.textContent!==label)entry.status.textContent=label;
   const failed=record.state==='failed'||record.state==='unknown';entry.actions.hidden=!failed;entry.row.dataset.delivery=record.state;
   if(entry.row.parentNode!==pendingRoot){pendingRoot.append(entry.row);if(!record.localShown){record.localShown=true;window.__DSH_CLIENT_LOG__?.event('send_flow',{stage:'shown',reason:'preparation',traceId:record.id,threadId:record.threadId,durationMs:Date.now()-record.at});}}
  }
  settleLatest();
 }
 // A React commit can land after our animation-frame callback. Retire only
 // the matching local row in the mutation microtask, before the next paint.
 function handoffPendingBeforePaint(){
  for(const entry of pendingPrompts.values()){
   if(!matchesPage(entry.record)||!entry.row?.isConnected||!nativeRow(entry.record))continue;
   entry.record.renderOwner='native';entry.row.remove();
   window.__DSH_CLIENT_LOG__?.event('send_flow',{stage:'shown',reason:'accepted',traceId:entry.record.id,threadId:entry.record.threadId,durationMs:Date.now()-entry.record.at});
   if(entry.record.state==='accepted'||entry.record.state==='queued')dropPending(entry.record.id);
  }
  if(pendingRoot?.isConnected&&!pendingRoot.childElementCount)pendingRoot.remove();
 }
 // The renderer may optimistically create a row before Native accepts it.
 // Reconcile missing receipts only against scoped, committed Native history.
 let reconcilingPending=false;
 async function reconcilePendingHistory(){
  const threadId=currentThread();if(reconcilingPending||!threadId||typeof window.__DSH_READ_COMMITTED_HISTORY__!=='function'||![...pendingPrompts.values()].some(({record})=>matchesPage(record)&&['failed','unknown'].includes(record.state)))return;
  reconcilingPending=true;
  try{const snapshot=await window.__DSH_READ_COMMITTED_HISTORY__(threadId,{touch:false,preferSummary:true});if(currentThread()!==threadId||snapshot?.response?.thread?.id!==threadId)return;
   const ids=new Map();for(const turn of snapshot.page?.data||[]){for(const item of turn.items||[])if(item.type==='userMessage'){if(item.id)ids.set(item.id,item.id);if(item.clientId)ids.set(item.clientId,item.id);}const page=snapshot.itemsPaginationByTurnId?.[turn.id];if(page?.openingUserMessageClientId)ids.set(page.openingUserMessageClientId,page.openingUserMessageId);}
   for(const {record}of pendingPrompts.values())if(matchesPage(record)&&['failed','unknown'].includes(record.state)&&(ids.has(record.id)||record.messageId&&ids.has(record.messageId))){record.messageId=ids.get(record.id)||record.messageId;record.state='accepted';record.reason=null;}
   persistPending();schedulePending();
  }catch{}finally{reconcilingPending=false;}
 }
 for(const event of ['dsh:history-updated','dsh:conversation-ready','dsh:native-route'])addEventListener(event,reconcilePendingHistory);
 function schedulePending(){if(!pendingFrame&&pendingPrompts.size)pendingFrame=requestAnimationFrame(renderPending);}
 function putPending(record){if(record.state==='sending'||record.state==='preparing'){followingPrompt=record;tailFinal=false;}const entry={record,row:null,badge:null};pendingPrompts.set(record.id,entry);cancelAnimationFrame(pendingFrame);renderPending();persistPending();return entry;}
 // Render the accepted local intent before any configuration/upload/network wait.
 const capturedComposers=new WeakMap(),failedComposerDrafts=new WeakMap();
 window.__DSH_ANDROID_PENDING__={capture(value){
  const controller=value.controller,editor=controller?.view?.dom;if(!controller||!editor||capturedComposers.has(controller)||typeof value.text!=='string')return null;
  const retained=value.retain();if(typeof retained!=='function')return null;
  const previous=failedComposerDrafts.get(controller);failedComposerDrafts.delete(controller);
  // Only a draft explicitly restored by this composer can be a retry. Never
  // reconcile independent messages by matching transcript text.
  const retryOf=previous&&previous.path===location.pathname&&previous.persistedText===value.persistedText?previous.id:null;
  let released=false;const state={...value,edited:false,claimed:false,finished:false};
  const events=['beforeinput','input','paste','drop','compositionstart'],edited=event=>{if(event.isTrusted)state.edited=true;};
  state.release=accepted=>{if(released)return false;released=true;return retained(accepted);};
  state.end=()=>{if(state.finished)return;state.finished=true;const record=pendingPrompts.get(state.id)?.record;if(record?.state==='failed'&&!state.edited&&controller.getPersistedText?.()===state.persistedText)failedComposerDrafts.set(controller,{id:state.id,path:location.pathname,persistedText:state.persistedText});for(const type of events)editor.removeEventListener(type,edited,true);if(capturedComposers.get(controller)===state)capturedComposers.delete(controller);};
  for(const type of events)editor.addEventListener(type,edited,true);capturedComposers.set(controller,state);
  window.__DSH_ANDROID_UPLOAD__.clearReady();
  state.pending=this.begin({id:value.id,retryOf,text:value.text.trim()?value.text:'附件消息',attachmentOnly:!value.text.trim(),threadId:value.threadId,clientThreadId:value.clientThreadId,state:'preparing'});
  state.cancel=reason=>{if(state.finished)return;state.pending.fail(false,reason||'已取消，未发送');const ownsDraft=state.release(false);if(ownsDraft&&!state.edited&&state.pending.isCurrent()&&!controller.getText())controller.setPromptText(state.persistedText);state.end();};
  try{controller.setText('');}catch{state.cancel('未发送，请重试');return null;}
  return state;
 },begin(value){
  const record={...value,id:value.id||crypto.randomUUID(),threadId:Object.hasOwn(value,'threadId')?value.threadId:currentThread(),path:location.pathname,at:Date.now(),state:value.state==='preparing'?'preparing':'sending'};putPending(record);const painted=afterVisiblePaint();
  const update=(state,result,reason)=>{if(!pendingPrompts.has(record.id))return;if(['accepted','queued'].includes(record.state)&&!['accepted','queued'].includes(state))return;if(['accepted','queued'].includes(state)&&record.retryOf){let id=record.retryOf;const seen=new Set([record.id]);while(id&&!seen.has(id)){seen.add(id);const prior=pendingPrompts.get(id)?.record;if(prior?.state!=='failed'||!matchesPage(prior))break;id=prior.retryOf;dropPending(prior.id);}}record.state=state;record.reason=reason||null;if(result?.threadId)record.threadId=result.threadId;const messageId=result?.messageResult?.messageId??result?.messageId;if(messageId)record.messageId=messageId;if(state==='accepted')window.__DSH_CLIENT_LOG__?.event('send_flow',{stage:'accepted',reason:'native',traceId:record.id,threadId:record.threadId,durationMs:Date.now()-record.at,textAvailable:!!nativeRow(record)});persistPending();schedulePending();};
  return {presented:()=>painted,isCurrent:()=>matchesPage(record),preparing(reason){update('preparing',null,reason);},sending(){update('sending');},added(){record.nativeAnnounced=true;handoffPendingBeforePaint();persistPending();schedulePending();},finish(result){update('accepted',result);if(record.renderOwner==='native'||nativeRow(record))dropPending(record.id);else schedulePending();},queued(result){update('queued',result);dropPending(record.id);},fail(unknown,reason){update(unknown?'unknown':'failed',null,reason);}};
 }};
 const restorePending=()=>{try{const saved=JSON.parse(sessionStorage.getItem(pendingKey));for(const value of Array.isArray(saved)?saved:saved?[saved]:[]){if(!value?.text||value.state==='accepted'||value.state==='queued')continue;putPending({...value,id:value.id||crypto.randomUUID(),path:value.path||location.pathname,state:['accepted','queued','failed'].includes(value.state)?value.state:value.state==='preparing'?'failed':'unknown',reason:value.state==='preparing'?(value.attachmentOnly?'尚未发送，请确认附件后重发':'尚未发送，请重新发送'):value.reason});}}catch{}};
 if(document.body)restorePending();else document.addEventListener('DOMContentLoaded',restorePending,{once:true});
 new MutationObserver(()=>{handoffPendingBeforePaint();schedulePending();}).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['data-local-conversation-item-target-ids']});
 addEventListener('resize',schedulePending);addEventListener('dsh:native-route',schedulePending);addEventListener('dsh:conversation-ready',schedulePending);
 window.__DSH_ANDROID_CAN_RELOAD__=()=>window.__DSH_NAVIGATION__?.canApplyUiUpdate?.()===true&&!window.__DSH_ANDROID_UPLOAD__.busy()&&pendingPersisted&&![...pendingPrompts.values()].some(({record})=>['preparing','sending'].includes(record.state))&&window.__DSH_NATIVE_WORKBENCH__?.canReload?.()!==false&&!document.querySelector('[role="dialog"],dialog[open]')&&document.visibilityState==='visible'&&window.__DSH_NATIVE_CACHE__?.canReload?.()===true&&![...document.querySelectorAll('textarea,input:not([type="hidden"]),[contenteditable="true"]')].some(node=>(node.value??node.textContent??'').trim())&&!document.activeElement?.closest?.('[data-codex-composer],textarea,input,[contenteditable="true"]');
 let dialog=null,previousFocus=null;
 const special=/\.(?:apk|apks|aab|zip|7z|rar|tar|gz|bz2|xz|docx?|xlsx?|pptx?|csv|tsv|epub|mobi|dmg|exe|msi|iso)$/i;
 function target(value){
  const url=new URL(value,location.origin);
  if(url.origin!==location.origin||url.protocol!=='https:'||url.username||url.password)throw Error('下载地址不可用');
  const workspace=url.pathname.match(/^\/(?:sync\/v1\/)?w\/(ai|zyy)\//)?.[1];
  if(workspace&&workspace!==scope.id)throw Error('下载地址不属于当前工作区');
  return url;
 }
 function dismiss(){dialog?.remove();dialog=null;if(previousFocus?.isConnected)previousFocus.focus();}
 function open(value){
  const url=target(value);dismiss();previousFocus=document.activeElement;
  dialog=document.createElement('dialog');dialog.className='dsh-download-dialog';
  const heading=document.createElement('h2');heading.textContent='下载文件';heading.id='dsh-download-heading';dialog.setAttribute('aria-labelledby',heading.id);
  const name=document.createElement('p');try{name.textContent=decodeURIComponent(url.pathname.split('/').pop()||'文件');}catch{name.textContent='文件';}
  const hint=document.createElement('p');hint.textContent='在浏览器中保存文件；如需登录，沿用私有站登录。';
  const actions=document.createElement('div');actions.className='dsh-download-actions';
  const edge=document.createElement('a');edge.textContent='在 Edge 下载';edge.href='microsoft-edge-https://'+url.host+url.pathname+url.search+url.hash;edge.className='dsh-primary';
  edge.addEventListener('click',()=>{hint.textContent='若浏览器未打开，可复制链接到浏览器下载。';});
  const copy=document.createElement('button');copy.type='button';copy.textContent='复制下载链接';
  const address=document.createElement('input');address.readOnly=true;address.value=url.href;address.setAttribute('aria-label','下载链接');address.hidden=true;
  copy.onclick=async()=>{try{await navigator.clipboard.writeText(url.href);hint.textContent='链接已复制，可粘贴到浏览器。';}catch{address.hidden=false;address.focus();address.select();hint.textContent='请复制下方链接，在浏览器中打开。';}};
  const close=document.createElement('button');close.type='button';close.textContent='取消';close.onclick=dismiss;
  actions.append(edge,copy,close);dialog.append(heading,name,hint,actions,address);dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss();});document.body.append(dialog);dialog.showModal();edge.focus();
  return {requested:true,downloadConfirmed:false};
 }
 window.__DSH_ANDROID_DOWNLOAD__={open};
 document.addEventListener('click',event=>{
  const link=event.target.closest?.('a[href]');if(!link||link.closest('.dsh-download-dialog'))return;
  let url;try{url=target(link.href);}catch{return;}
  let name;try{name=decodeURIComponent(url.pathname);}catch{name=url.pathname;}
  if(!link.hasAttribute('download')&&url.searchParams.get('download')!=='1'&&!special.test(name))return;
  event.preventDefault();event.stopImmediatePropagation();open(url.href);
 },true);
})();

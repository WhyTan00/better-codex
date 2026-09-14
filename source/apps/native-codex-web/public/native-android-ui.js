// Android-only presentation and explicit download handoff. No native interface change.
(()=>{
 if(!window.__BETTER_CODEX_ANDROID_HOST__&&!/\bBETTER_CODEXAndroid\//.test(navigator.userAgent||''))return;
 const scope=window.__BETTER_CODEX_SCOPE__;if(!scope)return;
 document.documentElement.dataset.betterCodexAndroid='1';
 // Hide application chrome when the IME reduces or pans the visual viewport.
 // Track the unobscured height separately for each fold/orientation width.
 const inputRoot=document.documentElement,viewport=window.visualViewport;
 let inputWidth=Math.round(innerWidth),unobscuredHeight=Math.max(innerHeight,viewport?.height||0),inputFrame=0;
 function inputFocused(){let node=document.activeElement;try{if(node?.tagName==='IFRAME')node=node.contentDocument?.activeElement;}catch{}return !!node?.closest?.('textarea,input:not([type="hidden"]),[contenteditable="true"]');}
 function updateInputChrome(){
  inputFrame=0;const width=Math.round(innerWidth),height=viewport?.height||innerHeight,focused=inputFocused();
  if(Math.abs(width-inputWidth)>32){inputWidth=width;unobscuredHeight=Math.max(innerHeight,height);}
  if(height>unobscuredHeight)unobscuredHeight=Math.max(innerHeight,height);
  const reduced=Math.max(unobscuredHeight,innerHeight)-height>120;
  const panned=(viewport?.offsetTop||0)>8;
  const open=focused&&(reduced||panned);
  if(open)inputRoot.dataset.betterCodexKeyboard='1';else delete inputRoot.dataset.betterCodexKeyboard;
 }
 function scheduleInputChrome(){if(!inputFrame)inputFrame=requestAnimationFrame(updateInputChrome);}
 window.__BETTER_CODEX_ANDROID_INPUT__={refresh:scheduleInputChrome};
 addEventListener('resize',scheduleInputChrome);viewport?.addEventListener('resize',scheduleInputChrome);viewport?.addEventListener('scroll',scheduleInputChrome);
 document.addEventListener('focusin',scheduleInputChrome,true);document.addEventListener('focusout',scheduleInputChrome,true);
 addEventListener('betterCodex:native-route',scheduleInputChrome);addEventListener('pageshow',scheduleInputChrome);
 scheduleInputChrome();

 const pendingKey='betterCodex-pending-display-v1:'+scope.id;
 let queueNotice=null,queueNoticeTimer=null;
 addEventListener('betterCodex:queue-error',event=>{queueNotice?.remove();clearTimeout(queueNoticeTimer);queueNotice=document.createElement('div');queueNotice.className='betterCodex-connection-status';queueNotice.setAttribute('role','alert');queueNotice.textContent=event.detail?.message||'队列操作未完成';document.body.append(queueNotice);queueNoticeTimer=setTimeout(()=>{queueNotice?.remove();queueNotice=null;},10000);});

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
  const pin=()=>{if(followingPrompt!==record||!matchesPage(record)||window.__BETTER_CODEX_NATIVE_SIDEBAR__?.isList||document.documentElement.dataset.betterCodexPlugin)return false;const root=document.querySelector('[data-app-action-timeline-scroll]');if(!root)return false;root.scrollTop=reversed(root)?0:Math.max(0,root.scrollHeight-root.clientHeight);return true;};
  tailFrame=requestAnimationFrame(()=>{tailFrame=0;if(!pin())return;tailFrame=requestAnimationFrame(()=>{tailFrame=0;pin();if(tailFinal&&followingPrompt===record)stopFollowing();});});
 }
 for(const type of ['wheel','touchstart','pointerdown','keydown'])document.addEventListener(type,event=>{if(!event.isTrusted||!followingPrompt||!event.target?.closest?.('[data-app-action-timeline-scroll]'))return;if(type==='keydown'&&!['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))return;stopFollowing();},{capture:true,passive:true});
 addEventListener('betterCodex:native-route',()=>{if(followingPrompt&&!matchesPage(followingPrompt))stopFollowing();});
 addEventListener('resize',settleLatest);window.visualViewport?.addEventListener('resize',settleLatest);
 function persistPending(){try{if(pendingPrompts.size)sessionStorage.setItem(pendingKey,JSON.stringify([...pendingPrompts.values()].map(v=>v.record)));else sessionStorage.removeItem(pendingKey);}catch{}}
 function dropPending(id){if(followingPrompt?.id===id){tailFinal=true;settleLatest();}const entry=pendingPrompts.get(id);entry?.row?.remove();entry?.badge?.remove();pendingPrompts.delete(id);persistPending();if(!pendingPrompts.size){pendingRoot?.remove();pendingRoot=null;}}
 function matchesPage(record){return !!currentThread()&&(record.threadId===currentThread()||record.clientThreadId===currentThread())||!record.threadId&&record.path===location.pathname;}
 function nativeRow(record){
  const ids=new Set([record.id,record.messageId].filter(Boolean).map(id=>encodeURIComponent(id)));
  return [...document.querySelectorAll('[data-local-conversation-item-target-ids]')].find(n=>!n.closest('[data-betterCodex-pending-prompts]')&&(n.getAttribute('data-local-conversation-item-target-ids')||'').split(' ').some(id=>ids.has(id)));
 }
 function pendingHost(){
  // The reverse scroller contains an absolute composer and a separate normal-flow
  // content column. Only that column owns the footer spacer and message insets.
  return document.querySelector('[data-app-action-timeline-scroll] [data-thread-user-message-navigation-content]');
 }
 function renderPending(){
  pendingFrame=0;for(const entry of pendingPrompts.values())if(!matchesPage(entry.record)){entry.row?.remove();entry.badge?.remove();}const visible=[...pendingPrompts.values()].filter(v=>matchesPage(v.record));
  if(!visible.length||window.__BETTER_CODEX_NATIVE_SIDEBAR__?.isList||document.documentElement.dataset.betterCodexPlugin){if(window.__BETTER_CODEX_NATIVE_SIDEBAR__?.isList||document.documentElement.dataset.betterCodexPlugin)stopFollowing();pendingRoot?.remove();for(const v of pendingPrompts.values())v.badge?.remove();return;}
  for(const entry of visible){
   const record=entry.record,real=nativeRow(record);
   if(real&&(record.state==='accepted'||record.state==='queued')){dropPending(record.id);continue;}
   const label=record.state==='accepted'?'':record.state==='queued'?'已排队':record.state==='failed'?(record.reason||'未发送，请重试'):record.state==='unknown'?'发送结果待确认，请勿重复发送':record.state==='preparing'?(record.reason||'准备发送…'):'正在发送…';
   if(real){entry.row?.remove();if(!entry.badge){entry.badge=document.createElement('small');entry.badge.className='betterCodex-inline-send-state';entry.badge.setAttribute('role','status');}if(entry.badge.textContent!==label)entry.badge.textContent=label;if(entry.badge.parentNode!==real)real.append(entry.badge);continue;}
   entry.badge?.remove();
   if(record.renderOwner==='native'&&!['failed','unknown'].includes(record.state)){entry.row?.remove();continue;}
   const host=pendingHost();if(!host)continue;
   if(!pendingRoot){pendingRoot=document.createElement('div');pendingRoot.dataset.betterCodexPendingPrompts='1';pendingRoot.className='betterCodex-inline-prompts';}
   if(pendingRoot.parentNode!==host||host.lastElementChild!==pendingRoot)host.append(pendingRoot);
   if(!entry.row){
    const row=document.createElement('article');row.className='betterCodex-inline-prompt';row.dataset.pendingId=record.id;
    const text=document.createElement('div');text.className='betterCodex-inline-prompt-text';text.dataset.markdownTextTone='user-message';text.textContent=record.text;
    const status=document.createElement('small');status.className='betterCodex-inline-send-state';status.setAttribute('role','status');
    const actions=document.createElement('div');actions.className='betterCodex-inline-send-actions';
    const copy=document.createElement('button');copy.type='button';copy.textContent='复制';copy.hidden=!!record.attachmentOnly;copy.onclick=()=>navigator.clipboard.writeText(record.text).catch(()=>{});
    const dismiss=document.createElement('button');dismiss.type='button';dismiss.textContent='收起提示';dismiss.onclick=()=>dropPending(record.id);actions.append(copy,dismiss);
    row.append(text,status,actions);entry.row=row;entry.status=status;entry.actions=actions;
   }
   if(entry.status.textContent!==label)entry.status.textContent=label;
   const failed=record.state==='failed'||record.state==='unknown';entry.actions.hidden=!failed;entry.row.dataset.delivery=record.state;
   if(entry.row.parentNode!==pendingRoot)pendingRoot.append(entry.row);
  }
  settleLatest();
 }
 // A React commit can land after our animation-frame callback. Retire only
 // the matching local row in the mutation microtask, before the next paint.
 function handoffPendingBeforePaint(){
  for(const entry of pendingPrompts.values()){
   if(!matchesPage(entry.record)||!entry.row?.isConnected||!nativeRow(entry.record))continue;
   entry.row.remove();
  }
  if(pendingRoot?.isConnected&&!pendingRoot.childElementCount)pendingRoot.remove();
 }
 function schedulePending(){if(!pendingFrame&&pendingPrompts.size)pendingFrame=requestAnimationFrame(renderPending);}
 function putPending(record){if(record.state==='sending'||record.state==='preparing'){followingPrompt=record;tailFinal=false;}const entry={record,row:null,badge:null};pendingPrompts.set(record.id,entry);cancelAnimationFrame(pendingFrame);renderPending();persistPending();return entry;}
 // Render the accepted local intent before any configuration/upload/network wait.
 const capturedComposers=new WeakMap();
 function afterVisiblePaint(){return new Promise(resolve=>{let first=0,second=0,done=false;const finish=()=>{if(done)return;done=true;cancelAnimationFrame(first);cancelAnimationFrame(second);document.removeEventListener('visibilitychange',hidden);removeEventListener('pagehide',finish);resolve();},hidden=()=>{if(document.visibilityState==='hidden')finish();};if(document.visibilityState==='hidden'){finish();return;}document.addEventListener('visibilitychange',hidden);addEventListener('pagehide',finish,{once:true});first=requestAnimationFrame(()=>{second=requestAnimationFrame(finish);});});}
 // Show selected local bytes before serialization or the private upload request.
 // Preview objects never enter storage, the transcript or a second upload queue.
 const localUploads=new Set();
 function clearUpload(ticket){ticket.node.remove();for(const url of ticket.urls)URL.revokeObjectURL(url);localUploads.delete(ticket);}
 function reconcileUploads(){
  for(const ticket of localUploads){
   if(ticket.path!==location.pathname||!ticket.host.isConnected){ticket.node.remove();continue;}
   if(ticket.node.parentNode!==ticket.host)ticket.host.prepend(ticket.node);
   if(ticket.state!=='ready')continue;
   const images=[...ticket.host.querySelectorAll('img')].filter(n=>!n.closest('[data-betterCodex-upload-preview]')&&!ticket.priorImages.has(n));
   const originals=[...ticket.host.querySelectorAll('[title],[aria-label]')].filter(n=>!n.closest('[data-betterCodex-upload-preview]'));
   if(images.length>=ticket.imageCount&&ticket.otherNames.every(name=>originals.some(n=>(n.getAttribute('title')||'').includes(name)||(n.getAttribute('aria-label')||'').includes(name))))clearUpload(ticket);
  }
 }
 window.__BETTER_CODEX_ANDROID_UPLOAD__={
  busy:()=>[...localUploads].some(t=>t.state==='uploading'),
  showPending(){for(const t of localUploads)if(t.state==='uploading')t.status.textContent='附件正在上传，完成后即可发送';},
  clearReady(){for(const t of [...localUploads])if(t.state==='ready')clearUpload(t);},
  begin(files){
   const editor=document.querySelector('[data-codex-composer]'),host=editor?.closest('[data-codex-composer-root]');
   if(!host)return null;
   const node=document.createElement('div');node.dataset.betterCodexUploadPreview='1';node.className='betterCodex-upload-preview';
   const items=document.createElement('div');items.className='betterCodex-upload-preview-items';
   const status=document.createElement('small');status.setAttribute('role','status');status.textContent='正在上传附件…';
   const ticket={node,host,status,path:location.pathname,state:'uploading',urls:[],priorImages:new Set(host.querySelectorAll('img')),imageCount:0,otherNames:[]};
   for(const file of files){const item=document.createElement('div');item.className='betterCodex-upload-preview-item';
    if(/^image\//.test(file.type)){const img=document.createElement('img'),url=URL.createObjectURL(file);ticket.urls.push(url);ticket.imageCount++;img.src=url;img.alt=file.name;item.append(img);}else ticket.otherNames.push(file.name);
    const name=document.createElement('span');name.textContent=file.name;item.append(name);items.append(item);
   }
   node.append(items,status);localUploads.add(ticket);host.prepend(node);
   const painted=afterVisiblePaint();
   return {presented:()=>painted,complete(){ticket.state='ready';status.textContent='已上传，正在加入附件…';requestAnimationFrame(reconcileUploads);},fail(){ticket.state='failed';status.textContent='附件上传失败，请重新选择';const close=document.createElement('button');close.type='button';close.textContent='关闭';close.onclick=()=>clearUpload(ticket);node.append(close);}};
  }
 };
 new MutationObserver(reconcileUploads).observe(document,{subtree:true,childList:true});
 addEventListener('betterCodex:native-route',()=>{for(const t of [...localUploads])if(t.state!=='uploading'&&t.path!==location.pathname)clearUpload(t);reconcileUploads();});
 addEventListener('pagehide',event=>{if(!event.persisted)for(const t of [...localUploads])clearUpload(t);});
 window.__BETTER_CODEX_ANDROID_PENDING__={capture(value){
  const controller=value.controller,editor=controller?.view?.dom;if(!controller||!editor||capturedComposers.has(controller)||typeof value.text!=='string')return null;
  const retained=value.retain();if(typeof retained!=='function')return null;
  let released=false;const state={...value,edited:false,claimed:false,finished:false};
  const events=['beforeinput','input','paste','drop','compositionstart'],edited=event=>{if(event.isTrusted)state.edited=true;};
  state.release=accepted=>{if(released)return false;released=true;return retained(accepted);};
  state.end=()=>{if(state.finished)return;state.finished=true;for(const type of events)editor.removeEventListener(type,edited,true);if(capturedComposers.get(controller)===state)capturedComposers.delete(controller);};
  for(const type of events)editor.addEventListener(type,edited,true);capturedComposers.set(controller,state);
  window.__BETTER_CODEX_ANDROID_UPLOAD__.clearReady();
  state.pending=this.begin({id:value.id,text:value.text.trim()?value.text:'附件消息',attachmentOnly:!value.text.trim(),threadId:value.threadId,clientThreadId:value.clientThreadId,state:'preparing'});
  state.cancel=reason=>{if(state.finished)return;state.pending.fail(false,reason||'已取消，未发送');const ownsDraft=state.release(false);if(ownsDraft&&!state.edited&&state.pending.isCurrent()&&!controller.getText())controller.setPromptText(state.persistedText);state.end();};
  try{controller.setText('');}catch{state.cancel('未发送，请重试');return null;}
  return state;
 },begin(value){
  const record={...value,id:value.id||crypto.randomUUID(),threadId:value.threadId||currentThread(),path:location.pathname,at:Date.now(),state:value.state==='preparing'?'preparing':'sending'};putPending(record);const painted=afterVisiblePaint();
  const update=(state,result,reason)=>{if(!pendingPrompts.has(record.id))return;record.state=state;record.reason=reason||null;if(result?.threadId)record.threadId=result.threadId;if(result?.messageId)record.messageId=result.messageId;persistPending();schedulePending();};
  return {presented:()=>painted,isCurrent:()=>matchesPage(record),preparing(reason){update('preparing',null,reason);},sending(){update('sending');},added(){record.renderOwner='native';const entry=pendingPrompts.get(record.id);entry?.row?.remove();entry?.badge?.remove();persistPending();schedulePending();},finish(result){update('accepted',result);dropPending(record.id);},queued(result){update('queued',result);dropPending(record.id);},fail(unknown,reason){update(unknown?'unknown':'failed',null,reason);}};
 }};
 const restorePending=()=>{try{const saved=JSON.parse(sessionStorage.getItem(pendingKey));for(const value of Array.isArray(saved)?saved:saved?[saved]:[]){if(!value?.text||value.state==='accepted'||value.state==='queued')continue;putPending({...value,id:value.id||crypto.randomUUID(),path:value.path||location.pathname,state:['accepted','queued','failed'].includes(value.state)?value.state:value.state==='preparing'?'failed':'unknown',reason:value.state==='preparing'?(value.attachmentOnly?'尚未发送，请确认附件后重发':'尚未发送，请重新发送'):value.reason});}}catch{}};
 if(document.body)restorePending();else document.addEventListener('DOMContentLoaded',restorePending,{once:true});
 new MutationObserver(()=>{handoffPendingBeforePaint();schedulePending();}).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['data-local-conversation-item-target-ids']});
 addEventListener('resize',schedulePending);addEventListener('betterCodex:native-route',schedulePending);addEventListener('betterCodex:conversation-ready',schedulePending);
 window.__BETTER_CODEX_ANDROID_CAN_RELOAD__=()=>!window.__BETTER_CODEX_ANDROID_UPLOAD__.busy()&&!pendingPrompts.size&&window.__BETTER_CODEX_NATIVE_WORKBENCH__?.canReload?.()!==false&&!document.querySelector('[role="dialog"],dialog[open]')&&document.visibilityState==='visible'&&window.__BETTER_CODEX_NATIVE_CACHE__?.canReload?.()===true&&![...document.querySelectorAll('textarea,input:not([type="hidden"]),[contenteditable="true"]')].some(node=>(node.value??node.textContent??'').trim())&&!document.activeElement?.closest?.('[data-codex-composer],textarea,input,[contenteditable="true"]');
 let dialog=null,previousFocus=null;
 const special=/\.(?:apk|apks|aab|zip|7z|rar|tar|gz|bz2|xz|docx?|xlsx?|pptx?|csv|tsv|epub|mobi|dmg|exe|msi|iso)$/i;
 function target(value){
  const url=new URL(value,location.origin);
  if(url.origin!==location.origin||url.protocol!=='https:'||url.username||url.password)throw Error('下载地址不可用');
  const workspace=url.pathname.match(/^\/(?:sync\/v1\/)?w\/(ai|secondary)\//)?.[1];
  if(workspace&&workspace!==scope.id)throw Error('下载地址不属于当前工作区');
  return url;
 }
 function dismiss(){dialog?.remove();dialog=null;if(previousFocus?.isConnected)previousFocus.focus();}
 function open(value){
  const url=target(value);dismiss();previousFocus=document.activeElement;
  dialog=document.createElement('dialog');dialog.className='betterCodex-download-dialog';
  const heading=document.createElement('h2');heading.textContent='下载文件';heading.id='betterCodex-download-heading';dialog.setAttribute('aria-labelledby',heading.id);
  const name=document.createElement('p');try{name.textContent=decodeURIComponent(url.pathname.split('/').pop()||'文件');}catch{name.textContent='文件';}
  const hint=document.createElement('p');hint.textContent='在浏览器中保存文件；如需登录，沿用私有站登录。';
  const actions=document.createElement('div');actions.className='betterCodex-download-actions';
  const edge=document.createElement('a');edge.textContent='在 Edge 下载';edge.href='microsoft-edge-https://'+url.host+url.pathname+url.search+url.hash;edge.className='betterCodex-primary';
  edge.addEventListener('click',()=>{hint.textContent='若浏览器未打开，可复制链接到浏览器下载。';});
  const copy=document.createElement('button');copy.type='button';copy.textContent='复制下载链接';
  const address=document.createElement('input');address.readOnly=true;address.value=url.href;address.setAttribute('aria-label','下载链接');address.hidden=true;
  copy.onclick=async()=>{try{await navigator.clipboard.writeText(url.href);hint.textContent='链接已复制，可粘贴到浏览器。';}catch{address.hidden=false;address.focus();address.select();hint.textContent='请复制下方链接，在浏览器中打开。';}};
  const close=document.createElement('button');close.type='button';close.textContent='取消';close.onclick=dismiss;
  actions.append(edge,copy,close);dialog.append(heading,name,hint,actions,address);dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss();});document.body.append(dialog);dialog.showModal();edge.focus();
  return {requested:true,downloadConfirmed:false};
 }
 window.__BETTER_CODEX_ANDROID_DOWNLOAD__={open};
 document.addEventListener('click',event=>{
  const link=event.target.closest?.('a[href]');if(!link||link.closest('.betterCodex-download-dialog'))return;
  let url;try{url=target(link.href);}catch{return;}
  let name;try{name=decodeURIComponent(url.pathname);}catch{name=url.pathname;}
  if(!link.hasAttribute('download')&&url.searchParams.get('download')!=='1'&&!special.test(name))return;
  event.preventDefault();event.stopImmediatePropagation();open(url.href);
 },true);
})();

// The native conversation stays mounted behind its list. Browser Back from a
// detail always reaches that list, including a fresh standalone deep link.
(()=>{
 // The official row and committed cache use the same id + complete-text revision.
 window.__DSH_FINAL_IDENTITY__=item=>{
  if(item?.type==='assistant-message')return item.phase==='final_answer'&&item.completed&&typeof item.dshFinalIdentity==='string'?item.dshFinalIdentity:null;
  if(item?.type!=='agentMessage'||item.phase!=='final_answer'||typeof item.id!=='string'||typeof item.text!=='string'||!item.text.trim())return null;
  let a=2166136261,b=5381;for(let i=0;i<item.text.length;i++){const c=item.text.charCodeAt(i);a=Math.imul(a^c,16777619);b=Math.imul(b,33)^c;}
  return encodeURIComponent(item.id)+':'+item.text.length+':'+(a>>>0).toString(16)+(b>>>0).toString(16);
 };
 const scope=window.__DSH_SCOPE__;
 if(!scope||window.parent!==window&&new URL(location.href).searchParams.get('dshEmbedded')==='1')return;
 const push=history.pushState.bind(history),replace=history.replaceState.bind(history);
 const managed=u=>u.origin===location.origin&&(/^\/local\/[0-9a-f-]{36}$/i.test(u.pathname)||u.pathname==='/');
 let cursor=Number.isSafeInteger(history.state?.dshNavIndex)?history.state.dshNavIndex:0,pendingEntry=null,notificationNavigation=0,selectedPresentation=null,selectionRevision=0;
 const strictFinal=window.__DSH_NOTIFICATION_FINAL_GATE__===true;
 let pendingNotification=null,notificationOverlay=null,notificationTimer=null,notificationObserver=null,notificationFrame=null;
 const notificationLog=(p,stage)=>window.__DSH_CLIENT_LOG__?.event('client_health',{component:'android-webview',stage,reason:'notification_open',threadId:p.path.split('/')[2],turnId:p.turnId||undefined,traceId:p.traceId});
 function revealTarget(p){
  if(pendingNotification!==p||!p.layout||location.pathname!==p.path)return;
  delete document.documentElement.dataset.dshNavigationPending;
  notificationOverlay?.classList?.add('dsh-notification-content-status');
 }
 function preparationFailed(p,error){
  if(pendingNotification!==p)return;
  p.status.textContent='回复同步未完成';p.retry.hidden=false;
  notificationLog(p,'failed');if(error)window.__DSH_CLIENT_LOG__?.reportError('sync_failed',error,{threadId:p.path.split('/')[2],turnId:p.turnId,traceId:p.traceId});revealTarget(p);
 }
 function findFinal(p){return [...document.querySelectorAll('[data-app-action-timeline-scroll] [data-dsh-final-answer-identities][data-dsh-final-thread-id][data-dsh-final-turn-id]')].find(row=>{
  const identities=(row.getAttribute('data-dsh-final-answer-identities')||'').split(' ').filter(Boolean);
  // Activity groups aggregate identities too. Only the actual final message
  // carries its thread/turn pair; never anchor to the surrounding turn/prompt.
  return row.getAttribute('data-dsh-final-thread-id')===p.path.split('/')[2]&&row.getAttribute('data-dsh-final-turn-id')===p.turnId&&(p.identity?identities.includes(p.identity):identities.length>0);
 });}
 function alignFinal(timeline,row){
  // Move just the transcript, keeping the app shell and composer in place.
  const delta=row.getBoundingClientRect().top-timeline.getBoundingClientRect().top-12;
  if(Number.isFinite(delta)&&Math.abs(delta)>1)timeline.scrollTop+=delta;
 }
 let completionEntry={path:location.pathname,baseline:null,touched:false,presented:false},completionObserver=null,completionFrame=null;
 const finalIdentityAt=path=>[...document.querySelectorAll('[data-app-action-timeline-scroll] [data-dsh-final-answer-identities][data-dsh-final-thread-id][data-dsh-final-turn-id]')].filter(row=>row.getAttribute('data-dsh-final-thread-id')===path.split('/')[2]).map(row=>row.getAttribute('data-dsh-final-answer-identities')||'').filter(Boolean).join(' ')||null;
 const lastFinal=()=>finalIdentityAt(location.pathname);
 function clearCompletionAnchor(){completionObserver?.disconnect();completionObserver=null;if(completionFrame)cancelAnimationFrame(completionFrame);completionFrame=null;}
 function beginCompletionEntry(baseline=null){clearCompletionAnchor();completionEntry={path:location.pathname,baseline,touched:false,presented:false};}
 function completedContentReady(id,final){
  const entry=completionEntry,path='/local/'+id;
  if(!final||entry.path!==path||location.pathname!==path||entry.touched||entry.presented||pendingNotification||entry.baseline?.split(' ').includes(final.identity))return;
  entry.target={path,turnId:final.turnId,identity:final.identity};
  const align=()=>{
   if(completionEntry!==entry||entry.touched||entry.presented||location.pathname!==path||document.visibilityState!=='visible'||window.__DSH_NATIVE_SIDEBAR__?.isList)return;
   const row=findFinal(entry.target),timeline=document.querySelector('[data-app-action-timeline-scroll]');if(!row||!timeline||!row.getClientRects().length||completionFrame)return;
   alignFinal(timeline,row);
   completionFrame=requestAnimationFrame(()=>{completionFrame=null;if(completionEntry!==entry||entry.touched||entry.presented||location.pathname!==path)return;const current=findFinal(entry.target);if(!current)return;alignFinal(timeline,current);entry.baseline=final.identity;entry.presented=true;clearCompletionAnchor();window.__DSH_ANDROID_BRIDGE__?.markCompletionSeen?.(id,final.turnId);window.__DSH_CLIENT_LOG__?.event('client_health',{component:'android-webview',stage:'shown',reason:'content_painted',threadId:id,turnId:final.turnId,cacheReady:true,textAvailable:true});});
  };
  clearCompletionAnchor();completionObserver=new MutationObserver(align);completionObserver.observe(document.body,{subtree:true,childList:true});align();
 }
 let hiddenFinal=null;
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){hiddenFinal=lastFinal();clearCompletionAnchor();}else{beginCompletionEntry(hiddenFinal);completionEntry.presented=!!document.querySelector('[data-app-action-timeline-scroll]')?.getClientRects?.().length;}});
 addEventListener('dsh:native-route',()=>{if(completionEntry.path!==location.pathname)beginCompletionEntry();});
 function checkFinal(){
  const p=pendingNotification;if(!p?.strict||!p.layout||location.pathname!==p.path||notificationFrame)return;
  const timeline=document.querySelector('[data-app-action-timeline-scroll]');if(!timeline)return;
  const row=findFinal(p);
  if(!row){if(!p.scrolled){p.scrolled=true;timeline.scrollTop=getComputedStyle(timeline).flexDirection==='column-reverse'?0:timeline.scrollHeight;}return;}
  alignFinal(timeline,row);
  notificationFrame=requestAnimationFrame(()=>{notificationFrame=null;if(pendingNotification!==p||location.pathname!==p.path)return;const final=findFinal(p);if(final){alignFinal(timeline,final);notificationLog(p,'shown');clearNotification();}});
 }
 async function prepareFinal(localOnly=false){
  checkFinal();if(notificationFrame)return;
  const p=pendingNotification;if(!p?.strict||!p.layout||typeof window.__DSH_PREPARE_NOTIFICATION_CONTENT__!=='function')return;
  const busy=localOnly?'localPreparing':'preparing',again=localOnly?'localAgain':'again';if(p[busy]){p[again]=true;return;}
  p[busy]=true;p[again]=false;
  try{const result=await window.__DSH_PREPARE_NOTIFICATION_CONTENT__?.(p.path.split('/')[2],p.turnId,{isCurrent:()=>pendingNotification===p,localOnly});if(pendingNotification!==p)return;if(!result){if(!localOnly)p.status.textContent='正在准备最终回复…';return;}p.identity=result.identity;p.scrolled=false;notificationLog(p,'committed');checkFinal();}
  catch(error){if(!localOnly)preparationFailed(p,error);}finally{p[busy]=false;if(pendingNotification===p&&p[again]&&!p.identity)Promise.resolve().then(()=>prepareFinal(localOnly));}
 }

 let view=new URL(location.href).searchParams.get('nativeList')==='1'||scope.nativeList?'list':'chat';
 function state(value,mode,index=cursor){return {...value,dshNavVersion:2,dshNavScope:scope.id,dshNavIndex:index,dshListPage:mode==='list',dshNativeList:mode==='list',dshThreadPage:mode==='chat'};}
 function url(value,mode){const u=new URL(value??location.href,location.href);u.searchParams.set('workspace',scope.id);if(mode==='list'){u.searchParams.set('nativeList','1');u.searchParams.set('view','chat');}else u.searchParams.delete('nativeList');return u.pathname+u.search+u.hash;}
 const initial=new URL(location.href);
 if(managed(initial)){
  // A persisted flag or an old "came from list" timestamp cannot prove that
  // an installed app's newly created browser history still has that ancestor.
  if(view==='chat'){
   const previous=history.state||{};replace(state(previous,'list'),'',url(initial.href,'list'));
   cursor++;push(state(previous,'chat'),'',url(initial.href,'chat'));
  }else replace(state(history.state,'list'),'',url(initial.href,'list'));
 }
 for(const method of ['pushState','replaceState'])history[method]=(value,title,target)=>{
  const u=new URL(target??location.href,location.href);
  if(!managed(u))return (method==='pushState'?push:replace)(value,title,target);
  const mode=u.searchParams.get('nativeList')==='1'||window.__DSH_NATIVE_SIDEBAR__?.isList?'list':'chat';
  if(method==='pushState'&&!value?.dshPluginPage&&pendingEntry?.path===u.pathname&&pendingEntry.index===cursor&&mode==='chat'){
   pendingEntry=null;view=mode;return replace(state(value,mode),title,url(u.href,mode));
  }
  if(method==='pushState'){cursor++;pendingEntry=null;}
  view=mode;return (method==='pushState'?push:replace)(state(value,mode),title,url(u.href,mode));
 };
 function clearNotification(){if(pendingNotification&&location.pathname===pendingNotification.path){const u=new URL(location.href);for(const key of ['fromNotification','notificationTurn','notificationThread'])u.searchParams.delete(key);replace(history.state,'',u.pathname+u.search+u.hash);}notificationObserver?.disconnect();notificationObserver=null;if(notificationFrame)cancelAnimationFrame(notificationFrame);notificationFrame=null;clearTimeout(notificationTimer);notificationTimer=null;pendingNotification=null;notificationOverlay?.remove();notificationOverlay=null;delete document.documentElement.dataset.dshNavigationPending;}
 function notificationTarget(path,turnId=null){
  clearNotification();const ticket=++notificationNavigation;pendingNotification={path,ticket,turnId,strict:strictFinal&&!!turnId,traceId:globalThis.crypto?.randomUUID?.()};
  if(pendingNotification.strict){notificationLog(pendingNotification,'preparing');notificationObserver=new MutationObserver(checkFinal);notificationObserver.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['data-dsh-final-answer-identities','data-dsh-final-thread-id','data-dsh-final-turn-id']});}
  // Final readiness controls preparation and scrolling, never page visibility.
  // Keep the native shell and cached content usable throughout a slow read.
  const overlay=notificationOverlay=document.createElement('div');overlay.className='dsh-notification-navigation';
  const status=document.createElement('p');status.setAttribute('role','status');status.textContent='正在打开会话…';overlay.append(status);pendingNotification.status=status;
  const retry=document.createElement('button');retry.type='button';retry.textContent='重试';retry.hidden=true;pendingNotification.retry=retry;
  retry.addEventListener('click',()=>{const target=new URL(path,location.origin);target.searchParams.set('workspace',scope.id);target.searchParams.set('fromNotification','1');if(turnId)target.searchParams.set('notificationTurn',turnId);if(!window.__DSH_NAVIGATION__.openConversation(target.href))location.assign(target.href);});
  const back=document.createElement('button');back.type='button';back.textContent='返回列表';back.addEventListener('click',()=>window.__DSH_NAVIGATION__.backToList());overlay.append(retry,back);document.body.append(overlay);
  notificationTimer=setTimeout(()=>{if(pendingNotification?.ticket!==ticket)return;checkFinal();if(notificationFrame)return;status.textContent=pendingNotification.layout?'回复同步较慢':'会话连接较慢';retry.hidden=false;},15000);
 }
 function revealList(){window.__DSH_HISTORY_RECOVERY__?.cancel();notificationNavigation++;selectionRevision++;selectedPresentation=null;if(pendingNotification)clearNotification();pendingEntry=null;view='list';replace(state(history.state,'list'),'',url(location.href,'list'));window.__DSH_NATIVE_SIDEBAR__?.show(false);window.dispatchEvent(new CustomEvent('dsh:conversation-selection'));}
 window.__DSH_NAVIGATION__={
  completedContentReady,
  presentationPath:()=>selectedPresentation??location.pathname,
  selectionRevision:()=>selectionRevision,
  confirmSendTarget({threadId,clientThreadId}){
   const path=selectedPresentation??location.pathname,route=path.match(/^\/local\/([0-9a-f-]{36})$/i)?.[1]??null;
   if(threadId!=null?route!==threadId:route!=null&&route!==clientThreadId)return false;
   if(path!==location.pathname){const target=new URL(location.href);target.pathname=path;target.searchParams.delete('nativeList');replace(state(history.state,'chat'),'',url(target.href,'chat'));window.dispatchEvent(new CustomEvent('dsh:native-route',{detail:{path}}));}
   return true;
  },
  // Downloads may run anywhere; applying an update waits for the list so it
  // cannot rebuild a conversation that has just become readable.
  canApplyUiUpdate:()=>!pendingNotification&&!window.__DSH_NATIVE_WORKBENCH__?.current&&(window.__DSH_NATIVE_SIDEBAR__?.isList===true||view==='list'),
  notificationTarget:()=>pendingNotification?.strict?{threadId:pendingNotification.path.split('/')[2],turnId:pendingNotification.turnId}:null,
  acceptRoute(path){return (!pendingNotification||pendingNotification.path===path)&&(!selectedPresentation||selectedPresentation==='/'||selectedPresentation===path);},
  // Called by the original renderer's setConversationPresented layout effect,
  // after its target DOM commits. Neither a route URL nor a cache read is enough.
  presented(id){if(selectedPresentation==='/local/'+id||selectedPresentation==='/')selectedPresentation=null;if(pendingNotification?.path!=='/local/'+id||location.pathname!==pendingNotification.path)return;if(!pendingNotification.strict){clearNotification();return;}pendingNotification.layout=true;pendingNotification.status.textContent='正在同步回复…';revealTarget(pendingNotification);prepareFinal();checkFinal();},
  openConversation(target){
   let u;try{u=new URL(target,location.href);}catch{return false;}
   if(u.origin!==location.origin||u.searchParams.get('workspace')!==scope.id||!/^\/local\/[0-9a-f-]{36}$/i.test(u.pathname)||!document.querySelector('[data-app-shell-sidebar-trigger]'))return false;
   const guarded=strictFinal&&!!u.searchParams.get('notificationTurn');
   const id=u.pathname.split('/')[2],same=location.pathname===u.pathname&&(!pendingNotification||pendingNotification.layout);
   window.__DSH_FOCUS_POLICY__?.reset('notification');
   this.beginConversation(u.pathname);if(guarded||!same)notificationTarget(u.pathname,u.searchParams.get('notificationTurn'));window.__DSH_NATIVE_SIDEBAR__?.openWorkbench();view='chat';
   if(same){if(guarded)pendingNotification.layout=true;replace(state(history.state,'chat'),'',url(u.href,'chat'));window.dispatchEvent(new CustomEvent('dsh:native-route',{detail:{path:u.pathname}}));if(guarded){revealTarget(pendingNotification);prepareFinal();}return true;}
   // Routing owns navigation; a slow cache preparation must never keep the old
   // conversation visible or schedule a later route that overrides user input.
   window.postMessage({type:'navigate-to-route',path:u.pathname},location.origin);
   Promise.resolve().then(()=>window.__DSH_PREPARE_CACHED_CONVERSATION__?.(id)).catch(()=>{});return true;
  },
  pushPreview(value,title,target){cursor++;pendingEntry=null;push(state(value,'chat'),title,target);},
  handleBack(){
   if(window.__DSH_PREVIEW__?.close())return true;
   if(pendingNotification){revealList();return true;}
   if(window.__DSH_NATIVE_SIDEBAR__?.isList||!/^\/local\/[0-9a-f-]{36}$/i.test(location.pathname)||document.querySelector('dialog[open],[role="dialog"][data-state="open"]'))return false;
   revealList();return true;
  },
  beginConversation(path){
   selectedPresentation=path;selectionRevision++;window.dispatchEvent(new CustomEvent('dsh:conversation-selection',{detail:{path}}));
   // A route presentation can precede its transcript. Preserve an already
   // mounted final on return; a fresh body still gets its first final anchor.
   beginCompletionEntry(finalIdentityAt(path));completionEntry.path=path;
   window.__DSH_HISTORY_RECOVERY__?.begin(path.split('/')[2]);
   if(pendingNotification)clearNotification();
   if(view!=='list')return;
   // A cached conversation may not make the native router push any entry.
   // Preserve the list before revealing its already-mounted conversation.
   replace(state(history.state,'list'),'',url(location.href,'list'));
   cursor++;view='chat';pendingEntry={path,index:cursor};push(state(history.state,'chat'),'',url(location.href,'chat'));
  },
  backToList(){revealList();},
 };
 if(initial.searchParams.get('fromNotification')==='1'&&/^\/local\/[0-9a-f-]{36}$/i.test(initial.pathname))notificationTarget(initial.pathname,initial.searchParams.get('notificationTurn'));
 for(const type of ['wheel','touchstart','pointerdown','keydown'])document.addEventListener(type,event=>{
  if(!event.isTrusted||!event.target?.closest?.('[data-app-action-timeline-scroll]'))return;
  if(type==='keydown'&&!['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))return;
  completionEntry.touched=true;clearCompletionAnchor();if(pendingNotification)clearNotification();
 },{capture:true,passive:true});
 for(const type of ['dsh:history-updated','dsh:history-adopted','dsh:history-synchronized','dsh:session-ready','dsh:conversation-ready','dsh:android-import-complete'])addEventListener(type,()=>{if(!pendingNotification?.identity)prepareFinal();else checkFinal();});
 addEventListener('dsh:android-cache-updated',event=>{const p=pendingNotification;if(event.detail?.scope===scope.id&&p&&event.detail.threadIds?.includes(p.path.split('/')[2]))prepareFinal(true);});
 addEventListener('popstate',event=>{
  // Module history overlays the existing document. Consume it before the
  // official router can remount or treat it as leaving a conversation.
  if(window.__DSH_NATIVE_WORKBENCH__?.onPopState?.(event)){cursor=event.state?.dshNavIndex??cursor;view=event.state?.dshListPage?'list':'chat';event.stopImmediatePropagation?.();return;}
  if(window.__DSH_PREVIEW__?.onPopState(event)){cursor=event.state?.dshNavIndex??cursor;return;}
  window.__DSH_HISTORY_RECOVERY__?.cancel();
  selectionRevision++;selectedPresentation=null;
  if(pendingNotification)clearNotification();
  pendingEntry=null;
  const target=event.state||history.state||{},next=Number.isSafeInteger(target.dshNavIndex)?target.dshNavIndex:null;
  const backwards=next===null||next<cursor,wasChat=view==='chat';
  if(next!==null)cursor=next;
  if(wasChat&&backwards&&managed(new URL(location.href)))revealList();
  else view=target.dshListPage||new URL(location.href).searchParams.get('nativeList')==='1'?'list':'chat';
 },{capture:true});
})();

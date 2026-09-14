// Reuse the official sidebar and keep the official renderer mounted.
(()=>{
 const scope=window.__BETTER_CODEX_SCOPE__;if(!scope)return;
 const root=document.documentElement,touch=matchMedia('(pointer:coarse)').matches||(navigator.maxTouchPoints||0)>1;
 root.dataset.betterCodexTouch=touch?'1':'0';
 // Coordinate the official React menu roots. Closing remounts that root so its
 // portals, focus scope and dismissable layer are disposed together.
 let activeMenu=null;
 const menuLog=reason=>window.__BETTER_CODEX_CLIENT_LOG__?.event('native_menu',{reason});
 window.__BETTER_CODEX_USE_NATIVE_MENU__=(React,onOpenChange)=>{
  const [key,setKey]=React.useState(0),ref=React.useRef(null);
  if(!ref.current)ref.current={open:false,mounted:true};
  const self=ref.current;self.onOpenChange=onOpenChange;
  self.close=reason=>{if(!self.open||!self.mounted)return;self.open=false;if(activeMenu===self)activeMenu=null;self.onOpenChange?.(false);setKey(k=>k+1);menuLog(reason);};
  React.useEffect(()=>{self.mounted=true;return()=>{self.mounted=false;if(activeMenu===self)activeMenu=null;};},[]);
  return {key,modal:touch?false:undefined,change:original=>open=>{
   if(open){if(activeMenu!==self)activeMenu?.close('menu_replaced');activeMenu=self;self.open=true;menuLog('menu_open');}
   else{self.open=false;if(activeMenu===self)activeMenu=null;menuLog('menu_close');}
   original?.(open);
  }};
 };
 // Bubble after the official click handler, so dismissing never removes a
 // pressed row before its navigation/action receives the click.
 addEventListener('click',event=>{if(!event.target.closest?.('[role="menu"],[aria-haspopup="menu"]'))activeMenu?.close('menu_outside');});
 addEventListener('keydown',event=>{if(event.key==='Escape')activeMenu?.close('menu_escape');});
 for(const type of ['betterCodex:native-route','popstate','pagehide'])addEventListener(type,()=>activeMenu?.close('menu_navigation'));
 const outsideMenu=target=>!target?.closest?.('[role="menu"]');
 let scrollTouch=null;
 addEventListener('touchstart',event=>{const t=event.touches[0];scrollTouch=activeMenu&&t&&outsideMenu(event.target)?{x:t.clientX,y:t.clientY}:null;},{capture:true,passive:true});
 addEventListener('touchmove',event=>{const t=event.touches[0];if(scrollTouch&&t&&Math.hypot(t.clientX-scrollTouch.x,t.clientY-scrollTouch.y)>=8){activeMenu?.close('menu_outside');scrollTouch=null;}},{capture:true,passive:true});
 for(const type of ['touchend','touchcancel'])addEventListener(type,()=>{scrollTouch=null;},{passive:true});
 addEventListener('wheel',event=>{if(outsideMenu(event.target))activeMenu?.close('menu_outside');},{capture:true,passive:true});
 document.addEventListener('scroll',event=>{if(outsideMenu(event.target))activeMenu?.close('menu_outside');},{capture:true,passive:true});
 // A touch pan on a sidebar row is scrolling, not desktop drag-to-reparent.
 // Preserve ordinary clicks and explicit menu controls; mouse dragging remains.
 document.addEventListener('pointerdown',event=>{
  if(event.pointerType!=='touch')return;
  const target=event.target,drag=target.closest?.('[aria-roledescription="draggable"],[data-app-action-sidebar-thread-row],[data-app-action-sidebar-project-row]');
  if(drag?.closest('#app-shell-sidebar')&&!target.closest?.('button[aria-haspopup],input,textarea,[role="menu"]'))event.stopPropagation();
 },true);
 window.__BETTER_CODEX_HISTORY_POLICY__={initialTurnItems:(!!window.BETTER_CODEXAndroid||/BETTER_CODEXAndroid/i.test(navigator.userAgent))?48:touch?20:48};
 // Install before the original module graph. Only the history-policy module
 // changes; its dependencies retain the existing cached native asset URLs.
 if(HTMLScriptElement.supports?.('importmap')&&!document.querySelector('script[data-betterCodex-native-import-map]')){const imports={};for(const version of [8,1004,1005,1006,1007,1008,1009,1010,1011,1012,1013,1014]){const prefix='/official-patched-v'+version+'/assets/';imports[prefix+'app-initial-cadb12d4a15e.js']='/official-patched-v1013/assets/app-initial-cadb12d4a15e.js';imports[prefix+'review-file-source-item-78465d2172ff.js']='/official-patched-v1013/assets/review-file-source-item-78465d2172ff.js';imports[prefix+'app-primary-6cd7b8b3f5e3.js']='/official-patched-v1014/assets/app-primary-6cd7b8b3f5e3.js';if(version!==8)imports[prefix]='/official-patched-v8/assets/';}const map=document.createElement('script');map.type='importmap';map.dataset.betterCodexNativeImportMap='1';map.textContent=JSON.stringify({imports});document.head.append(map);}
 if(!['127.0.0.1','localhost'].includes(location.hostname))window.__BETTER_CODEX_PERF_ENDPOINT__='/sync/v1/w/'+scope.id+'/performance';
 const registered=new WeakSet(),warmed=new Map();let prewarmClient=null,prewarmRunning=false;
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function prewarm(){if(prewarmRunning||!prewarmClient)return;prewarmRunning=true;let metadata=0,bodies=0;
  try{await sleep(2500);if(!list||document.visibilityState!=='visible')return;const [pins,recent]=await Promise.all([prewarmClient.sendRequest('thread/list',{sectionId:'01984de2-8f74-7c91-a3b2-5c5e937cf318',sortKey:'section_position',sortDirection:'asc',limit:40}),prewarmClient.sendRequest('thread/list',{sortKey:'updated_at',limit:8})]);const targets=[...new Map([...pins.data,...recent.data].map(t=>[t.id,t])).values()];
   for(const target of targets){if(document.visibilityState!=='visible'||!list)break;if(warmed.get(target.id)===target.updatedAt)continue;
    // Original read-only native hydration: metadata + latest completed turn.
    // It neither resumes an execution nor changes the visible conversation.
    await prewarmClient.hydrateBackgroundThreads([target.id],{includeTurns:false});metadata++;
    if(target.status?.type!=='active'&&list&&document.visibilityState==='visible'){await prewarmClient.hydrateBackgroundThreads([target.id],{includeTurns:true,maxTurns:1});bodies++;warmed.set(target.id,target.updatedAt);}
    window.__BETTER_CODEX_PERF__?.event('prewarm',{metadataCount:metadata,bodyCount:bodies});await sleep(300);
   }
  }catch{window.__BETTER_CODEX_PERF__?.event('prewarm',{metadataCount:metadata,bodyCount:bodies,failed:true});}finally{prewarmRunning=false;}
 }
 window.__BETTER_CODEX_REGISTER_NATIVE_CLIENT__=client=>{window.__BETTER_CODEX_INSTALL_NATIVE_READ_CACHE__?.(client);window.__BETTER_CODEX_READING_POSITION__?.register(client);window.__BETTER_CODEX_INSTALL_NATIVE_QUEUE__?.(client);if(registered.has(client))return;registered.add(client);if(client.hostId==='local'&&typeof client.hydrateBackgroundThreads==='function'){prewarmClient=client;setTimeout(prewarm,1500);}};

 const listUrl='/?workspace='+scope.id+'&view=chat&nativeList=1';let list=!!scope.nativeList||new URL(location.href).searchParams.get('nativeList')==='1',intent=false,scheduled=false,lastReady=null;
 let sidebarWasOpen=false,sidebarWidth=innerWidth,keepSidebarClosedUntil=0,initialSidebarClose=touch&&!list;
 function preserveSidebarOnResize(){
  if(!touch)return;
  if(innerWidth!==sidebarWidth){if(!list&&!sidebarWasOpen)keepSidebarClosedUntil=Date.now()+1000;sidebarWidth=innerWidth;}
  if(list)return;
  const toggle=document.querySelector('[data-app-shell-sidebar-trigger][aria-controls="app-shell-sidebar"]');if(!toggle)return;
  const expanded=toggle.getAttribute('aria-expanded')==='true';
  // The native desktop breakpoint can open its panel during a fold/unfold.
  // Keep the user's closed mobile chat panel closed through that transition.
  if((initialSidebarClose||Date.now()<keepSidebarClosedUntil)&&expanded){initialSidebarClose=false;closeSidebar();return;}
  initialSidebarClose=false;sidebarWasOpen=expanded;
 }
 function applyThreadVisibility(){for(const row of document.querySelectorAll('#root [data-app-action-sidebar-thread-row]')){const id=row.getAttribute('data-app-action-sidebar-thread-id')?.replace(/^local:/,''),hidden=window.__BETTER_CODEX_THREAD_LIST_VISIBILITY__?.isHidden(id);if(hidden)row.setAttribute('data-betterCodex-unsent-thread','1');else row.removeAttribute('data-betterCodex-unsent-thread');}}
 addEventListener('betterCodex:thread-list-visibility',applyThreadVisibility);
 function setView(value){list=value;root.dataset.betterCodexView=value?'list':'chat';if(value)ensureSidebar();}
 let listReadyReported=false;function ensureSidebar(){if(!list)return;if(!listReadyReported&&document.querySelector('[data-app-action-sidebar-thread-row]')){listReadyReported=true;window.__BETTER_CODEX_PERF__?.event('native_list_ready');}const toggle=document.querySelector('[data-app-shell-sidebar-trigger][aria-controls="app-shell-sidebar"][aria-expanded="false"]');toggle?.click();}
 function closeSidebar(){if(!touch)return;document.querySelector('[data-app-shell-sidebar-trigger][aria-controls="app-shell-sidebar"][aria-expanded="true"]')?.click();}
 function show(push=true){document.activeElement?.blur();window.__BETTER_CODEX_FOCUS_POLICY__?.reset('list');intent=false;setView(true);if(push&&window.__BETTER_CODEX_NAVIGATION__){window.__BETTER_CODEX_NAVIGATION__.backToList();}else if(push){const u=new URL(location.href);if(!/^\/local\/[0-9a-f-]{36}$/i.test(u.pathname)){u.pathname='/';u.searchParams.set('view','chat');}u.searchParams.set('workspace',scope.id);u.searchParams.set('nativeList','1');history.pushState({...history.state,betterCodexListPage:true,betterCodexNativeList:true},'',u.href);}window.__BETTER_CODEX_PERF__?.event('list_visible');prewarm();}
 window.__BETTER_CODEX_NATIVE_SIDEBAR__={show,openWorkbench(){list=false;root.dataset.betterCodexView='chat';closeSidebar();},get isList(){return list;},restore(){setView(new URL(location.href).searchParams.get('nativeList')==='1'||!!history.state?.betterCodexListPage);}};
 setView(list);
 document.addEventListener('click',event=>{
  const target=event.target,button=target.closest?.('button'),row=target.closest?.('[data-app-action-sidebar-thread-row]');
  if(target.closest?.('[role="menu"]')||button?.getAttribute('aria-haspopup')==='menu')return;
  if(event.isTrusted&&target.closest?.('[data-app-shell-sidebar-trigger]')){keepSidebarClosedUntil=0;initialSidebarClose=false;sidebarWasOpen=button?.getAttribute('aria-expanded')!=='true';}
  const label=button?.getAttribute('aria-label')||'',text=button?.textContent?.trim()||'';
  const action=/置顶|归档|Pin |Unpin|Archive/i.test(label);
  const newChat=/^(新对话|New chat)$/.test(label)||/^(新对话|New chat)$/.test(text)||/中开始新聊天/.test(label);
  if(action||(!row&&!newChat))return;
  if(newChat)window.__BETTER_CODEX_RESET_NEW_CHAT_MODEL__?.();
  const clicked=row?.getAttribute('data-app-action-sidebar-thread-id')?.replace(/^local:/,''),cached=list&&clicked&&lastReady===clicked&&location.pathname==='/local/'+clicked;intent=true;sidebarWasOpen=false;setView(false);if(window.__BETTER_CODEX_NAVIGATION__)window.__BETTER_CODEX_NAVIGATION__.beginConversation(clicked?'/local/'+clicked:'/');else{const u=new URL(location.href);u.searchParams.delete('nativeList');history.replaceState({...history.state,betterCodexListPage:false,betterCodexNativeList:false},'',u.href);}window.__BETTER_CODEX_PERF__?.navigation(Date.now());window.__BETTER_CODEX_PERF__?.event('list_click');queueMicrotask(closeSidebar);if(cached)requestAnimationFrame(()=>requestAnimationFrame(()=>{window.__BETTER_CODEX_PERF__?.event('cached_view');window.__BETTER_CODEX_PERF__?.ready(clicked);}));
 },true);
 addEventListener('betterCodex:conversation-ready',()=>{lastReady=location.pathname.match(/^\/local\/([0-9a-f-]{36})$/i)?.[1]||null;});
 addEventListener('betterCodex:native-route',()=>{if(intent||!list){setView(false);intent=false;}});
 addEventListener('popstate',()=>window.__BETTER_CODEX_NATIVE_SIDEBAR__.restore());
 let resizeSettle;addEventListener('resize',()=>{if(innerWidth!==sidebarWidth){root.dataset.betterCodexResizing='1';clearTimeout(resizeSettle);resizeSettle=setTimeout(()=>delete root.dataset.betterCodexResizing,240);}preserveSidebarOnResize();});
 new MutationObserver(()=>{if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;applyThreadVisibility();if(list)ensureSidebar();else preserveSidebarOnResize();});}).observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-expanded']});
 // Retire only the obsolete custom-chat worker; keep native asset caches.
 navigator.serviceWorker?.getRegistrations().then(registrations=>{for(const registration of registrations){const worker=registration.active||registration.waiting;if(worker&&new URL(worker.scriptURL).pathname==='/app/sw.js')registration.unregister();}}).catch(()=>{});
})();

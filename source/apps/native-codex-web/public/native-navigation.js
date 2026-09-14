// The native conversation stays mounted behind its list. Browser Back from a
// detail always reaches that list, including a fresh standalone deep link.
(()=>{
 const scope=window.__BETTER_CODEX_SCOPE__;
 if(!scope||window.parent!==window&&new URL(location.href).searchParams.get('betterCodexEmbedded')==='1')return;
 const push=history.pushState.bind(history),replace=history.replaceState.bind(history);
 const managed=u=>u.origin===location.origin&&(/^\/local\/[0-9a-f-]{36}$/i.test(u.pathname)||u.pathname==='/');
 let cursor=Number.isSafeInteger(history.state?.betterCodexNavIndex)?history.state.betterCodexNavIndex:0,pendingEntry=null,notificationNavigation=0;
 let view=new URL(location.href).searchParams.get('nativeList')==='1'||scope.nativeList?'list':'chat';
 function state(value,mode,index=cursor){return {...value,betterCodexNavVersion:2,betterCodexNavScope:scope.id,betterCodexNavIndex:index,betterCodexListPage:mode==='list',betterCodexNativeList:mode==='list',betterCodexThreadPage:mode==='chat'};}
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
  const mode=u.searchParams.get('nativeList')==='1'||window.__BETTER_CODEX_NATIVE_SIDEBAR__?.isList?'list':'chat';
  if(method==='pushState'&&pendingEntry?.path===u.pathname&&pendingEntry.index===cursor&&mode==='chat'){
   pendingEntry=null;view=mode;return replace(state(value,mode),title,url(u.href,mode));
  }
  if(method==='pushState'){cursor++;pendingEntry=null;}
  view=mode;return (method==='pushState'?push:replace)(state(value,mode),title,url(u.href,mode));
 };
 function revealList(){notificationNavigation++;pendingEntry=null;view='list';replace(state(history.state,'list'),'',url(location.href,'list'));window.__BETTER_CODEX_NATIVE_SIDEBAR__?.show(false);}
 window.__BETTER_CODEX_NAVIGATION__={
  openConversation(target){
   let u;try{u=new URL(target,location.href);}catch{return false;}
   if(u.origin!==location.origin||u.searchParams.get('workspace')!==scope.id||!/^\/local\/[0-9a-f-]{36}$/i.test(u.pathname)||!document.querySelector('[data-app-shell-sidebar-trigger]'))return false;
   const id=u.pathname.split('/')[2],same=location.pathname===u.pathname,ticket=++notificationNavigation;
   window.__BETTER_CODEX_FOCUS_POLICY__?.reset('notification');
   this.beginConversation(u.pathname);window.__BETTER_CODEX_NATIVE_SIDEBAR__?.openWorkbench();view='chat';
   if(same){replace(state(history.state,'chat'),'',url(u.href,'chat'));window.dispatchEvent(new CustomEvent('betterCodex:native-route',{detail:{path:u.pathname}}));return true;}
   // This prepares only already committed local records, never a network read.
   Promise.resolve(window.__BETTER_CODEX_PREPARE_CACHED_CONVERSATION__?.(id)).catch(()=>{}).then(()=>{
    if(ticket===notificationNavigation&&view==='chat')window.postMessage({type:'navigate-to-route',path:u.pathname},location.origin);
   });return true;
  },
  handleBack(){
   if(window.__BETTER_CODEX_NATIVE_SIDEBAR__?.isList||!/^\/local\/[0-9a-f-]{36}$/i.test(location.pathname)||document.querySelector('dialog[open],[role="dialog"][data-state="open"]'))return false;
   revealList();return true;
  },
  beginConversation(path){
   if(view!=='list')return;
   // A cached conversation may not make the native router push any entry.
   // Preserve the list before revealing its already-mounted conversation.
   replace(state(history.state,'list'),'',url(location.href,'list'));
   cursor++;view='chat';pendingEntry={path,index:cursor};push(state(history.state,'chat'),'',url(location.href,'chat'));
  },
  backToList(){revealList();},
 };
 addEventListener('popstate',event=>{
  pendingEntry=null;
  const target=event.state||history.state||{},next=Number.isSafeInteger(target.betterCodexNavIndex)?target.betterCodexNavIndex:null;
  const backwards=next===null||next<cursor,wasChat=view==='chat';
  if(next!==null)cursor=next;
  if(wasChat&&backwards&&managed(new URL(location.href)))revealList();
  else view=target.betterCodexListPage||new URL(location.href).searchParams.get('nativeList')==='1'?'list':'chat';
 },{capture:true});
})();

// The official renderer owns the live viewport. A cached anchor may assist only
// the first, still-unpresented frame; it must never seek after the user sees it.
(()=>{
 const cache=window.__DSH_NATIVE_CACHE__;if(!cache)return;
 let tab=sessionStorage.getItem('dsh-reading-tab');if(!tab){tab=crypto.randomUUID();sessionStorage.setItem('dsh-reading-tab',tab);}
 const thread=()=>location.pathname.match(/^\/local\/([0-9a-f-]{36})$/i)?.[1];
 const scroller=()=>document.querySelector('[data-app-action-timeline-scroll]');
 const nodes=root=>[...root.querySelectorAll('[data-local-conversation-item-target-ids],[data-turn-key]')];
 const identity=node=>node.hasAttribute('data-local-conversation-item-target-ids')?{attribute:'data-local-conversation-item-target-ids',value:node.getAttribute('data-local-conversation-item-target-ids')}:{attribute:'data-turn-key',value:node.getAttribute('data-turn-key')};
 const direction=root=>getComputedStyle(root).flexDirection==='column-reverse'?'column-reverse':'column';
 const key=id=>'reading:'+tab+':'+id,recent=new Map(),pending=new Map(),writes=new Map();
 let visit=null,saving=null;
 function current(){const id=thread();if(!visit||visit.id!==id)visit={id,attempted:false,sealed:false,presented:false,restored:false};return visit;}
 function flush(){clearTimeout(saving);saving=null;for(const[k,value]of pending){pending.delete(k);const work=(writes.get(k)||Promise.resolve()).catch(()=>{}).then(()=>cache.saveMeta(k,value));writes.set(k,work);work.catch(()=>{}).finally(()=>{if(writes.get(k)===work)writes.delete(k);});}}
 function save(){
  const id=thread(),root=scroller();if(!id||!root||window.__DSH_NATIVE_SIDEBAR__?.isList||document.visibilityState==='hidden')return;
  const top=root.getBoundingClientRect().top,anchor=nodes(root).find(n=>n.getBoundingClientRect().bottom>top+12);if(!anchor)return;
  const mode=direction(root),value={version:2,anchor:identity(anchor),offset:anchor.getBoundingClientRect().top-top,scrollTop:root.scrollTop,atEnd:mode==='column-reverse'?Math.abs(root.scrollTop)<80:root.scrollHeight-root.scrollTop-root.clientHeight<80,direction:mode,width:innerWidth,at:Date.now()};
  // Capture identity/geometry now, never after a debounce on another thread.
  const k=key(id);recent.delete(k);recent.set(k,value);while(recent.size>100)recent.delete(recent.keys().next().value);pending.set(k,value);clearTimeout(saving);saving=setTimeout(flush,200);
 }
 async function restore(){
  const owner=current(),id=owner.id,root=scroller();
  if(!id||owner.attempted||owner.sealed||!root||!nodes(root).length||window.__DSH_NATIVE_SIDEBAR__?.isList||document.visibilityState==='hidden')return;
  owner.attempted=true;const initialTop=root.scrollTop;
  // An IndexedDB result arriving after the initial frame is too late to move
  // a viewport that the official renderer has already positioned.
  requestAnimationFrame(()=>{owner.sealed=true;});
  const saved=recent.get(key(id))||await cache.meta(key(id)).catch(()=>null);
  if(visit!==owner||owner.sealed||thread()!==id||scroller()!==root||root.isConnected===false||root.scrollTop!==initialTop||window.__DSH_NATIVE_SIDEBAR__?.isList||document.visibilityState==='hidden')return;
  // Old snapshots used a forward-only end calculation on a reversed timeline.
  if(saved?.version!==2||saved.direction!==direction(root)||saved.atEnd||!Number.isFinite(saved.offset))return;
  if(!['data-local-conversation-item-target-ids','data-turn-key'].includes(saved.anchor?.attribute)||typeof saved.anchor.value!=='string')return;
  const found=nodes(root).find(n=>n.getAttribute(saved.anchor.attribute)===saved.anchor.value);if(!found)return;
  const delta=found.getBoundingClientRect().top-root.getBoundingClientRect().top-saved.offset;
  if(Number.isFinite(delta)&&Math.abs(delta)>1)root.scrollTop+=delta;
  owner.restored=true;
 }
 function present(id,{hasRestore=false}={}){
  const owner=current(),root=scroller();if(owner.id!==id||owner.presented||!root||window.__DSH_NATIVE_SIDEBAR__?.isList||document.visibilityState==='hidden')return;
  // Explicit notification/search navigation and an existing reading position
  // have priority. Choose the actual reply row, never a turn/prompt wrapper.
  if(!owner.restored&&!hasRestore&&!location.hash&&!window.__DSH_NAVIGATION__?.notificationTarget?.()){
   const row=[...root.querySelectorAll('[data-dsh-final-answer-identities][data-dsh-final-thread-id][data-dsh-final-turn-id]')]
    .filter(node=>node.getAttribute('data-dsh-final-thread-id')===id&&node.getClientRects?.().length).at(-1);
   if(row){const delta=row.getBoundingClientRect().top-root.getBoundingClientRect().top-12;if(Number.isFinite(delta)&&Math.abs(delta)>1)root.scrollTop+=delta;}
  }
  owner.sealed=true;owner.presented=true;save();
 }
 window.__DSH_READING_POSITION__={register(){},save,restore,present,hasPresented:id=>current().id===id&&current().presented};
 document.addEventListener('scroll',event=>{if(event.target===scroller())save();},{capture:true,passive:true});
 for(const name of ['wheel','touchstart','pointerdown','keydown'])document.addEventListener(name,event=>{if(event.isTrusted){current().sealed=true;current().presented=true;}},{capture:true,passive:true});
 addEventListener('dsh:conversation-ready',()=>{current().sealed=true;current().presented=true;});
 addEventListener('dsh:native-route',()=>{current();flush();});
 addEventListener('pagehide',flush);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){current().sealed=true;flush();}});
 new MutationObserver(()=>{restore();}).observe(document,{subtree:true,childList:true});
})();

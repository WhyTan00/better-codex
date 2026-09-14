// A viewport width is never a navigation mode or a conversation identity.
// Restore a native turn/item anchor; scrollTop only wakes the virtualized range.
(()=>{
 const cache=window.__BETTER_CODEX_NATIVE_CACHE__;if(!cache)return;let tab=sessionStorage.getItem('betterCodex-reading-tab');if(!tab){tab=crypto.randomUUID();sessionStorage.setItem('betterCodex-reading-tab',tab);}
 let client=null,saving=null,restoring=false,restoreKey=null,userMoved=false,lastWidth=innerWidth;
 const thread=()=>location.pathname.match(/^\/local\/([0-9a-f-]{36})$/i)?.[1];
 const scroller=()=>document.querySelector('[data-app-action-timeline-scroll]');
 const nodes=root=>[...root.querySelectorAll('[data-local-conversation-item-target-ids],[data-turn-key]')];
 const identity=node=>node.hasAttribute('data-local-conversation-item-target-ids')?{attribute:'data-local-conversation-item-target-ids',value:node.getAttribute('data-local-conversation-item-target-ids')}:{attribute:'data-turn-key',value:node.getAttribute('data-turn-key')};
 function save(){clearTimeout(saving);saving=setTimeout(()=>{const id=thread(),root=scroller();if(!id||!root||restoring||window.__BETTER_CODEX_NATIVE_SIDEBAR__?.isList)return;const top=root.getBoundingClientRect().top,anchor=nodes(root).find(n=>n.getBoundingClientRect().bottom>top+12);if(!anchor)return;const expanded=nodes(root).filter(n=>n.querySelector('button[aria-expanded="true"]')).map(identity).slice(0,80);cache.saveMeta('reading:'+tab+':'+id,{anchor:identity(anchor),offset:anchor.getBoundingClientRect().top-top,scrollTop:root.scrollTop,atEnd:root.scrollHeight-root.scrollTop-root.clientHeight<80,expanded,width:innerWidth,at:Date.now()}).catch(()=>{});},200);}
 async function restore(){const id=thread();if(!id||restoreKey===id||restoring||window.__BETTER_CODEX_NATIVE_SIDEBAR__?.isList)return;restoring=true;const saved=await cache.meta('reading:'+tab+':'+id).catch(()=>null);if(!saved){restoreKey=id;restoring=false;return;}const root=scroller();if(!root||nodes(root).length===0){restoring=false;return;}restoreKey=id;restoring=true;userMoved=false;
  try{if(saved.atEnd)return;root.scrollTop=saved.scrollTop;
   let found=null;const deadline=Date.now()+5000;for(let attempt=0;attempt<120&&Date.now()<deadline&&!userMoved&&thread()===id;attempt++){
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    found=nodes(root).find(n=>n.getAttribute(saved.anchor.attribute)===saved.anchor.value);
    if(found){root.scrollTop+=found.getBoundingClientRect().top-root.getBoundingClientRect().top-saved.offset;break;}
    if(attempt%3===2&&client?.loadOlderConversationTurnsPage)await client.loadOlderConversationTurnsPage(id);else root.scrollTop=Math.min(saved.scrollTop,Math.max(0,root.scrollHeight-root.clientHeight));
   }
   if(!userMoved)for(const item of saved.expanded||[]){const node=nodes(root).find(n=>n.getAttribute(item.attribute)===item.value);node?.querySelector('button[aria-expanded="false"]')?.click();}
  }catch{}finally{restoring=false;}
 }
 window.__BETTER_CODEX_READING_POSITION__={register(value){client=value;},save,restore};
 document.addEventListener('scroll',event=>{if(event.target===scroller())save();},{capture:true,passive:true});
 for(const name of ['wheel','touchstart','pointerdown'])document.addEventListener(name,event=>{if(event.isTrusted&&restoring)userMoved=true;},{capture:true,passive:true});
 addEventListener('betterCodex:conversation-ready',restore);addEventListener('betterCodex:native-route',()=>{if(restoreKey!==thread())restoreKey=null;});
 addEventListener('pagehide',save);addEventListener('resize',()=>{if(innerWidth!==lastWidth){lastWidth=innerWidth;save();}});
 new MutationObserver(()=>{if(thread()!==restoreKey)restore();}).observe(document,{subtree:true,childList:true});
})();

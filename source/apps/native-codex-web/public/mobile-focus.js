// Mobile conversation entry must not summon the keyboard. Direct editor taps
// and keyboard navigation still work; desktop focus behavior is untouched.
(()=>{
 if(typeof HTMLElement==='undefined'||typeof matchMedia!=='function'||!(matchMedia('(pointer:coarse)').matches||matchMedia('(max-width:767px)').matches))return;
 const selector='.ProseMirror,[contenteditable="true"][role="textbox"]',original=HTMLElement.prototype.focus,modes=new WeakMap(),editors=new Set();let permitted=false,route=location.pathname?.startsWith('/local/')?location.pathname:'new',suppressed=0;
 const editor=e=>e?.matches?.(selector)?e:e?.closest?.(selector);
 function restore(e){const mode=modes.get(e);if(mode==null)e.removeAttribute('inputmode');else e.setAttribute('inputmode',mode);}
 function discover(e){if(!e?.matches)return;const found=[...(e.matches(selector)?[e]:[]),...e.querySelectorAll(selector)];for(const node of found){if(!modes.has(node))modes.set(node,node.getAttribute('inputmode'));editors.add(node);if(permitted)restore(node);else node.setAttribute('inputmode','none');}for(const node of editors)if(!node.isConnected)editors.delete(node);}
 function allow(){permitted=true;for(const e of editors)restore(e);}
 function reset(next){if(next===route)return;if(route==='new'&&permitted&&editor(document.activeElement)&&next?.startsWith('/local/')){route=next;return;}route=next;permitted=false;const active=editor(document.activeElement);active?.blur();for(const e of editors)e.setAttribute('inputmode','none');}
 HTMLElement.prototype.focus=function(...args){if(editor(this)&&!permitted&&document.activeElement!==this){suppressed++;return;}return original.apply(this,args);};
 document.addEventListener('pointerdown',e=>{if(e.isTrusted&&editor(e.target))allow();},true);
 document.addEventListener('keydown',e=>{if(e.isTrusted&&e.key==='Tab')allow();},true);
 document.addEventListener('focusin',e=>{const target=editor(e.target);if(target&&!permitted){suppressed++;e.stopImmediatePropagation();target.blur();}},true);
 addEventListener('dsh:native-route',e=>reset(e.detail.path));
 const observer=new MutationObserver(records=>{for(const r of records){if(r.type==='attributes'){if(r.target.matches?.(selector)){const node=r.target;if(!modes.has(node))modes.set(node,node.getAttribute('inputmode'));editors.add(node);if(permitted)restore(node);else node.setAttribute('inputmode','none');}}else for(const n of r.addedNodes)discover(n);}});observer.observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['class','contenteditable','role']});discover(document.documentElement);
 window.__DSH_FOCUS_POLICY__={reset,get suppressed(){return suppressed;}};
})();

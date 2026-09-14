// Resizing a foldable display or keyboard is a layout event, never navigation.
// Keep a visible message anchored rather than restoring a stale pixel offset.
export function viewportContinuity(container,{key,read,write}){
 let anchor=null,frame=null,saving=false;
 function capture(){if(saving)return;const top=container.getBoundingClientRect().top,bottom=container.scrollHeight-container.scrollTop-container.clientHeight<80;let visible;
  if(!bottom)for(const node of container.querySelectorAll('[data-item-id]'))if(node.getBoundingClientRect().bottom>top+4){visible=node;break;}
  anchor={bottom,itemId:visible?.dataset.itemId??null,offset:visible?visible.getBoundingClientRect().top-top:0,scrollTop:container.scrollTop};
 }
 function restore(value=anchor){if(!value)return;saving=true;if(value.bottom)container.scrollTop=container.scrollHeight;else{let node;for(const candidate of container.querySelectorAll('[data-item-id]'))if(candidate.dataset.itemId===value.itemId){node=candidate;break;}if(node)container.scrollTop+=node.getBoundingClientRect().top-container.getBoundingClientRect().top-value.offset;else container.scrollTop=value.scrollTop;}saving=false;capture();}
 function resized(){if(frame!=null)cancelAnimationFrame(frame);const previous=anchor;frame=requestAnimationFrame(()=>{frame=null;restore(previous);});}
 container.addEventListener('scroll',capture,{passive:true});const observer=typeof ResizeObserver==='function'?new ResizeObserver(resized):null;observer?.observe(container);addEventListener('resize',resized);window.visualViewport?.addEventListener('resize',resized);
 addEventListener('pagehide',()=>{capture();if(key())write(key(),JSON.stringify(anchor));});addEventListener('pageshow',()=>resized());
 return {capture,restoreSaved(){let value;try{value=JSON.parse(read(key())||'null');}catch{}if(value)requestAnimationFrame(()=>restore(value));else capture();},destroy(){observer?.disconnect();removeEventListener('resize',resized);window.visualViewport?.removeEventListener('resize',resized);}};
}

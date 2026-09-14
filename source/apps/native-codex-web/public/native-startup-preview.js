// Paint a sanitized snapshot of the official sidebar, then hand over to that same renderer.
(()=>{
 const scope=window.__BETTER_CODEX_SCOPE__;if(!scope)return;
 // Android already loads the official renderer from its local package and data cache.
 // Sanitized DOM snapshots lose layout selectors and are visibly a different list.
 if(window.__BETTER_CODEX_ANDROID_HOST__||/\bBETTER_CODEXAndroid\//.test(navigator.userAgent||'')){window.__BETTER_CODEX_STARTUP_PREVIEW__={show:async()=>{},hide:()=>{},diagnostics:()=>({visible:false,reason:'native-renderer-only'})};return;}
 const key='official-sidebar-preview-v1',allowedTags=new Set(['DIV','SPAN','P','BUTTON','A','LABEL','UL','OL','LI','NAV','ASIDE','HEADER','FOOTER','SECTION','H1','H2','H3','SMALL','STRONG','B','SVG','PATH','G','CIRCLE','RECT','LINE','POLYLINE','POLYGON','ELLIPSE','TITLE']);
 const allowedAttributes=new Set(['style','class','role','aria-label','aria-hidden','aria-expanded','aria-selected','aria-current','data-betterCodex-header-row','data-betterCodex-sidebar-header','data-betterCodex-new-chat','data-betterCodex-action-label','title','data-betterCodex-preview-action','data-betterCodex-preview-thread','viewbox','d','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','width','height','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','points','transform']);
 let overlay=null,queued=null,finishing=false,timer=null,saving=false,again=false,lastSaved='',firstPreviewAt=null;
 const liveSidebar=()=>document.querySelector('#root #app-shell-sidebar');
 const liveRows=()=>document.querySelectorAll('#root [data-app-action-sidebar-thread-row]');
 function clean(element,mark=false){
  element.classList.add('betterCodex-snapshot-sidebar');
  for(const node of [element,...element.querySelectorAll('*')]){
   if(node.hidden||node.dataset.betterCodexUnused==='1'){node.remove();continue;}
   if(node.id==='betterCodex-workspace-nav')node.classList.add('betterCodex-snapshot-nav');
   if(node.id==='betterCodex-plugin-shortcuts')node.classList.add('betterCodex-snapshot-shortcuts');
   if(node.tagName==='SELECT'){const label=document.createElement('span');label.className='betterCodex-snapshot-select';label.textContent=node.selectedOptions?.[0]?.textContent||'';node.replaceWith(label);}
  }
  for(const spinner of element.querySelectorAll('.animate-spin'))spinner.remove();
  for(const node of [...element.querySelectorAll('*')]){
   if(!allowedTags.has(node.tagName.toUpperCase())){node.remove();continue;}
   if(mark){
    const id=node.getAttribute('data-app-action-sidebar-thread-id')?.replace(/^local:/,'');
    if(/^[0-9a-f-]{36}$/i.test(id||''))node.setAttribute('data-betterCodex-preview-thread',id);
    const label=node.getAttribute('aria-label')||node.textContent?.trim()||'';
    if(node.tagName==='BUTTON'&&/^(新对话|New chat)$/.test(label))node.setAttribute('data-betterCodex-preview-action','new');
    if(node.tagName==='BUTTON'&&/^(设置|Settings)$/.test(label))node.setAttribute('data-betterCodex-preview-action','settings');
    if(node.tagName==='BUTTON'&&/个人资料|profile menu|帮助菜单|help menu/i.test(label)){node.remove();continue;}
   }
  }
  const layoutStyles=new Set(['display','position','top','right','bottom','left','width','height','min-width','max-width','min-height','max-height','padding-top','padding-bottom','padding-left','padding-right','margin-top','margin-bottom','margin-left','margin-right','transform','transform-origin','opacity','flex','flex-shrink','flex-grow','align-items','gap','overflow','overflow-y','contain','box-sizing','z-index','inset']);
  for(const node of [element,...element.querySelectorAll('*')]){
   if(node.style){for(const property of [...node.style])if(!layoutStyles.has(property)||/url\s*\(|expression|javascript:|data:/i.test(node.style.getPropertyValue(property)))node.style.removeProperty(property);}
   for(const attr of [...node.attributes]){
    const name=attr.name.toLowerCase();
    if(!allowedAttributes.has(name)||/url\s*\(|javascript:|data:/i.test(attr.value))node.removeAttribute(attr.name);
   }
   if(node.matches('[data-betterCodex-preview-thread],[data-betterCodex-preview-action]')){node.setAttribute('role','button');node.setAttribute('tabindex','0');}
  }
  // Snapshot buttons are inert markup; only the explicit handover actions above respond.
  for(const node of [...element.querySelectorAll('button,a')]){const div=document.createElement('div');for(const attr of [...node.attributes])div.setAttribute(attr.name,attr.value);div.classList.add('betterCodex-snapshot-button');div.append(...node.childNodes);node.replaceWith(div);}
  return element;
 }
 async function pruneEmptyRows(element){
  const cache=window.__BETTER_CODEX_NATIVE_CACHE__,visibility=window.__BETTER_CODEX_THREAD_LIST_VISIBILITY__;if(!cache||!visibility)return;
  await Promise.all([...element.querySelectorAll('[data-betterCodex-preview-thread]')].map(async row=>{const id=row.dataset.betterCodexPreviewThread;if(visibility.isHidden(id)){row.remove();return;}const record=await cache.get('thread:'+id).catch(()=>null);if(record?.deleted||record?.payload&&!visibility.listableEntry(record.payload))row.remove();}));
 }
 function hide(){overlay?.remove();overlay=null;queued=null;finishing=false;}
 function forward(action){
  if(!action)return;
  if(action.thread){for(const row of liveRows())if(row.getAttribute('data-app-action-sidebar-thread-id')?.replace(/^local:/,'')===action.thread){row.click();return;}location.assign('/local/'+action.thread+'?workspace='+scope.id+'&view=chat');return;}
  const labels=action.action==='new'?/^(新对话|New chat)$/:/^(设置|Settings)$/;
  for(const button of document.querySelectorAll('#root button'))if(labels.test(button.getAttribute('aria-label')||button.textContent?.trim()||'')){button.click();return;}
 }
 function ready(){if(!overlay||finishing||!liveRows().length)return;finishing=true;requestAnimationFrame(()=>requestAnimationFrame(()=>{const action=queued;hide();forward(action);}));}
 async function capture(){
  if(saving){again=true;return;}if(document.visibilityState!=='visible'||document.documentElement.dataset.betterCodexView!=='list'||!liveRows().length)return;
  const sidebar=liveSidebar();if(!sidebar||[sidebar,...sidebar.querySelectorAll('*')].some(node=>node.scrollTop>1))return;saving=true;
  try{const clone=clean(sidebar.cloneNode(true),true);await pruneEmptyRows(clone);const html=clone.outerHTML;if(html.length>500000||html===lastSaved)return;
   await window.__BETTER_CODEX_NATIVE_CACHE__?.saveMeta(key,{schema:2,scope:scope.id,entry:window.__BETTER_CODEX_UI_RELEASE__?.entry,uiVersion:window.__BETTER_CODEX_UI_RELEASE__?.version,width:Math.round(innerWidth),android:document.documentElement.dataset.betterCodexAndroid==='1',at:Date.now(),html});lastSaved=html;
  }catch{}finally{saving=false;if(again){again=false;schedule();}}
 }
 function schedule(){if(timer)return;timer=setTimeout(()=>{timer=null;capture();},400);}
 async function show(){
  if(!scope.nativeList||overlay||liveRows().length)return;
  try{const value=await window.__BETTER_CODEX_NATIVE_CACHE__?.meta(key);if(!value||value.schema!==2||value.scope!==scope.id||value.entry!==window.__BETTER_CODEX_UI_RELEASE__?.entry||value.uiVersion!==window.__BETTER_CODEX_UI_RELEASE__?.version||value.width!==Math.round(innerWidth)||value.android!==(document.documentElement.dataset.betterCodexAndroid==='1')||Date.now()-value.at>7*86400000||typeof value.html!=='string'||value.html.length>500000)return;
   const template=document.createElement('template');template.innerHTML=value.html;const content=template.content.firstElementChild;if(!content||content.tagName!=='DIV')return;clean(content);await pruneEmptyRows(content);
   if(!content.querySelector('[data-betterCodex-preview-thread]'))return;
   overlay=document.createElement('div');overlay.className='app-shell-left-panel betterCodex-startup-preview';overlay.setAttribute('aria-label','会话列表');overlay.append(content);
   const status=document.createElement('div');status.className='betterCodex-startup-preview-status';status.setAttribute('role','status');status.textContent='正在打开…';overlay.append(status);
   const choose=event=>{const target=event.target.closest?.('[data-betterCodex-preview-thread],[data-betterCodex-preview-action]');if(!target)return;event.preventDefault();event.stopPropagation();queued={thread:target.dataset.betterCodexPreviewThread,action:target.dataset.betterCodexPreviewAction};status.textContent='正在打开…';ready();};
   overlay.addEventListener('click',choose);overlay.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' ')choose(event);});document.body.append(overlay);
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));firstPreviewAt=Math.round(performance.now());window.__BETTER_CODEX_PERF__?.event('cached_view',{reason:'startup'});ready();
  }catch{hide();}
 }
 window.__BETTER_CODEX_STARTUP_PREVIEW__={show,hide,diagnostics:()=>({firstPreviewAt,visible:!!overlay,pendingAction:!!queued})};
 new MutationObserver(()=>{ready();schedule();}).observe(document,{subtree:true,childList:true,characterData:true});
 addEventListener('betterCodex:authentication-required',()=>{hide();lastSaved='';window.__BETTER_CODEX_NATIVE_CACHE__?.saveMeta(key,null).catch(()=>{});});
})();

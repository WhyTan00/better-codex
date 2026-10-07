// Small workspace/PWA chrome around the unmodified official renderer.
// Reuses the existing DSH install lifecycle; it never sends or retries a prompt.
(()=>{
 const scope=window.__DSH_SCOPE__;if(!scope)return;
 const mode=matchMedia('(display-mode: standalone)');let installPrompt=null,registration=null;
 const root=document.documentElement;
 let manifest=document.querySelector('link[rel="manifest"]');if(!manifest){manifest=document.createElement('link');manifest.rel='manifest';document.head.append(manifest);}manifest.href='/manifest.webmanifest?workspace='+(window.__DSH_INSTALLATION__?.id||scope.id)+'&theme='+(root.dataset.dshTheme||'light');
 const updateViewport=()=>{const viewport=document.querySelector('meta[name="viewport"]');const content='width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content';if(viewport&&viewport.content!==content)viewport.content=content;};
 updateViewport();document.addEventListener('DOMContentLoaded',updateViewport,{once:true});
 // Keep workspace in native router URLs so reload, copied links and PWA reopening
 // do not silently switch a ZYY thread back to AI.
 for(const method of ['pushState','replaceState']){const original=history[method].bind(history);history[method]=(state,title,url)=>{if(url!=null){const u=new URL(url,location.href);if(u.origin===location.origin&&!u.searchParams.has('workspace')){u.searchParams.set('workspace',scope.id);if(window.__DSH_INSTALLATION__?.id)u.searchParams.set('pwa',window.__DSH_INSTALLATION__.id);url=u.pathname+u.search+u.hash;}}return original(state,title,url);};}
 function button(text,fn){const b=document.createElement('button');b.type='button';b.textContent=text;b.addEventListener('click',fn);return b;}
 const nav=document.createElement('nav');nav.id='dsh-workspace-nav';nav.setAttribute('aria-label','工作区与工作台');
 const mobile={get matches(){return root.dataset.dshTouch==='1'||matchMedia('(max-width:767px)').matches;}};
 function closeNativeSidebar(){if(!mobile.matches)return;const toggle=document.querySelector('[data-app-shell-sidebar-trigger][aria-controls="app-shell-sidebar"][aria-expanded="true"]');toggle?.click();}
 const back=button('‹',closeNativeSidebar);back.setAttribute('aria-label','返回聊天');back.className='dsh-mobile-back';nav.append(back);
 const select=document.createElement('select');select.setAttribute('aria-label','切换工作区');for(const[id,label]of (scope.workspaces?.map(({id,label})=>[id,label])||[['ai','Workspace']])){const o=new Option(label,id);o.selected=id===scope.id;select.add(o);}select.addEventListener('change',()=>{try{window.__DSH_SET_PREFERRED_WORKSPACE__?.(select.value);}catch{}const target=new URL('/?workspace='+select.value+'&view=chat&nativeList=1&switchWorkspace=1',location.origin);if(window.__DSH_INSTALLATION__?.id)target.searchParams.set('pwa',window.__DSH_INSTALLATION__.id);location.href=target.href;});nav.append(select);
 addEventListener('dsh:scope-renewed',()=>{if(!scope.workspaces)return;select.replaceChildren(...scope.workspaces.map(({id,label})=>{const option=new Option(label,id);option.selected=id===scope.id;return option;}));});
 const install=button('安装',async()=>{if(!installPrompt)return;const p=installPrompt;installPrompt=null;install.hidden=true;await p.prompt();await p.userChoice;});install.hidden=true;nav.append(install);
 const update=button('设置',async()=>{try{const preferences=window.__DSH_PWA_PREFERENCES__;if(!preferences)throw Error('设置未加载，请关闭后重新打开应用');await preferences.open();}catch(error){status.textContent=error.message||'设置暂时无法打开，请重新打开应用';status.hidden=false;}});nav.append(update);
 addEventListener('dsh:update-available',e=>{update.textContent='设置';update.title=e.detail?.available?'有新版可用':'账户额度、通知与更新';update.dataset.updateAvailable=String(!!e.detail?.available);});
 const status=document.createElement('span');status.setAttribute('role','status');status.className='dsh-pwa-status';status.hidden=true;nav.append(status);
 function online(){const connected=navigator.onLine&&window.__DSH_NATIVE_ONLINE__!==false;status.textContent=connected?'':'缓存阅读 · 任务状态待同步';status.hidden=connected;}
 addEventListener('dsh:connection-state',online);addEventListener('dsh:session-ready',online);addEventListener('offline',online);addEventListener('online',online);online();
 addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;install.hidden=mode.matches;});addEventListener('appinstalled',()=>{installPrompt=null;install.hidden=true;});
 const shortcuts=document.createElement('div');shortcuts.id='dsh-plugin-shortcuts';let pluginDefinitions=window.__DSH_NATIVE_WORKBENCH__?.peekList?.()||null,pluginLoading=false,nextPluginTry=0;
 const paths={portfolio:'M3 17l5-5 4 3 8-10M15 5h5v5',quant:'M4 19V9m5 10V5m6 14v-7m5 7V3',agenda:'M6 3v4m12-4v4M3 10h18M5 5h14a2 2 0 0 1 2 2v13H3V7a2 2 0 0 1 2-2',cockpit:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',fiction:'M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4zM13 7a3 3 0 0 1 3-3h5v15h-4a4 4 0 0 0-4 2'};
 function loadPlugins(){if(pluginLoading||pluginDefinitions||Date.now()<nextPluginTry)return;pluginLoading=true;window.__DSH_NATIVE_WORKBENCH__?.list().then(values=>{if(!pluginDefinitions)pluginDefinitions=values;mount();}).catch(()=>{nextPluginTry=Date.now()+5000;setTimeout(loadPlugins,5100);}).finally(()=>{pluginLoading=false;});}
 addEventListener('dsh:plugin-definitions',event=>{if(!Array.isArray(event.detail)||JSON.stringify(pluginDefinitions)===JSON.stringify(event.detail))return;pluginDefinitions=event.detail;for(const child of [...shortcuts.children]){const item=pluginDefinitions.find(p=>p.id===child.dataset.dshPluginLink);if(!item)child.remove();else{const label=child.querySelector('[data-dsh-action-label]');if(label&&label.textContent!==item.label)label.textContent=item.label;}}mount();});
 let sidebar=null,scheduled=false;
 function mount(){scheduled=false;sidebar=document.querySelector('[aria-label="已安排任务文件夹"],[aria-label="Scheduled task folders"]');if(!sidebar)return;
  const panel=sidebar.closest('.app-shell-left-panel')||sidebar;
  const buttons=[...panel.querySelectorAll('button')],newChat=buttons.find(b=>/^(新对话|New chat)$/.test((b.getAttribute('aria-label')||b.textContent).trim()));
  for(const b of buttons)if(!b.dataset.dshPluginLink&&/^(Pull requests?|拉取请求|Scheduled(?: tasks)?|已安排(?:任务)?|计划任务|定时任务|Plugins|插件)$/i.test(b.textContent.trim())){b.hidden=true;b.dataset.dshUnused='1';}
  if(newChat&&pluginDefinitions){for(const plugin of pluginDefinitions){const existing=[...shortcuts.children].find(child=>child.dataset.dshPluginLink===plugin.id);if(existing)continue;const b=button(plugin.label,()=>window.__DSH_NATIVE_WORKBENCH__.open(plugin.id).catch(()=>{}));b.className=newChat.className;b.dataset.dshPluginLink=plugin.id;
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.7');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');const nativeContent=newChat.firstElementChild,nativeSlot=newChat.querySelector('.icon-leading-slot'),nativeSVG=nativeSlot?.querySelector('svg'),nativeLabel=newChat.querySelector('.text-fade-truncate');for(const attr of ['width','height'])svg.setAttribute(attr,nativeSVG?.getAttribute(attr)||'16');if(nativeSVG?.getAttribute('class'))svg.setAttribute('class',nativeSVG.getAttribute('class'));svg.classList.add('dsh-plugin-icon');const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',paths[plugin.id]||paths.cockpit);svg.append(path);const inner=document.createElement('div');inner.className=nativeContent?.className||'flex min-w-0 items-center text-base gap-2 flex-1 text-default';const slot=document.createElement('span');slot.className=nativeSlot?.className||'flex icon-leading-slot w-4 shrink-0 items-center justify-center';slot.append(svg);const label=document.createElement('span');label.className=nativeLabel?.className||'text-fade-truncate';label.dataset.dshActionLabel='1';label.textContent=plugin.label;inner.append(slot,label);b.replaceChildren(inner);shortcuts.append(b);}
   const scroll=panel.querySelector('[data-app-action-sidebar-scroll]');if(scroll&&shortcuts.parentNode!==scroll)scroll.prepend(shortcuts);if(scroll){const spare=shortcuts.nextElementSibling;if(spare){const empty=!spare.textContent.trim()&&!spare.querySelector('button,a,input,[role=status]');if(empty)spare.dataset.dshEmptyActions='1';else delete spare.dataset.dshEmptyActions;}}
  }
  const brand=panel.querySelector('button[aria-label^="切换模式"],button[aria-label^="Switch mode"]'),search=panel.querySelector('button[aria-label="搜索"],button[aria-label="Search"]');
  if(brand&&search){let header=brand.parentElement;while(header&&header!==sidebar&&!header.contains(search))header=header.parentElement;
   if(header&&header!==sidebar){header.dataset.dshHeaderRow='1';const actions=[...header.children].find(child=>child.contains(search));if(nav.parentNode!==header||nav.nextElementSibling!==actions)header.insertBefore(nav,actions||null);}
  }
  if(newChat){newChat.dataset.dshNewChat='1';const label=newChat.querySelector('.text-fade-truncate');if(label)label.dataset.dshActionLabel='1';}
  if(!sidebar.dataset.dshMobileNavigation){sidebar.dataset.dshMobileNavigation='true';sidebar.addEventListener('click',e=>{if(e.target.closest('[data-app-action-sidebar-thread-row],button[aria-label="新对话"],button[aria-label="New chat"]'))queueMicrotask(closeNativeSidebar);});}
  loadPlugins();
 }
 const observer=new MutationObserver(()=>{if(scheduled)return;scheduled=true;requestAnimationFrame(mount);});
 addEventListener('resize',()=>{if(!scheduled){scheduled=true;requestAnimationFrame(mount);}});
 const start=()=>{observer.observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-expanded']});mount();};start();
 if('serviceWorker'in navigator&&!window.__DSH_ANDROID_HOST__&&!window.__DSH_ANDROID_APP__){
  const pinCache=worker=>{const version=window.__DSH_UI_RELEASE__?.version;if(version)worker?.postMessage({type:'DSH_CACHE_CLIENT_VERSION',version});};
  navigator.serviceWorker.addEventListener('message',event=>{if(event.data?.type==='DSH_CACHE_VERSION_REQUEST')pinCache(event.source);});
  navigator.serviceWorker.addEventListener('controllerchange',()=>pinCache(navigator.serviceWorker.controller));
  navigator.serviceWorker.register('/workbench-sw.js',{scope:'/',updateViaCache:'none'}).then(r=>{registration=r;pinCache(r.active);r.update().catch(()=>{});r.active?.postMessage({type:'PREPARE_NATIVE_CACHE'});window.__DSH_PWA_PREFERENCES__?.ready(r);}).catch(()=>{});
 }
 root.dataset.dshWorkspace=scope.id;
})();

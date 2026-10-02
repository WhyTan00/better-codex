// A credential-free entry to the same pinned native renderer.
(()=>{
 const release=__DSH_NATIVE_RELEASE__,url=new URL(location.href),valid=value=>['ai','zyy'].includes(value);
 const requested=url.searchParams.get('workspace');if(requested&&!valid(requested)){document.getElementById('root').textContent='工作区不可访问';return;}
 // Capture unscoped storage before the native renderer installs its workspace wrapper.
 let get=()=>null,set=()=>{},sessionGet=()=>null,sessionSet=()=>{};
 try{get=localStorage.getItem.bind(localStorage);set=localStorage.setItem.bind(localStorage);sessionGet=sessionStorage.getItem.bind(sessionStorage);sessionSet=sessionStorage.setItem.bind(sessionStorage);}catch{}
 const read=(key,fallback=null)=>{try{return get(key)||fallback;}catch{return fallback;}},write=(key,value)=>{try{set(key,value);}catch{}};
 const standalone=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
 let installation=url.searchParams.get('pwa');if(!valid(installation)){installation=null;if(standalone){try{installation=sessionGet('dsh-pwa-installation');}catch{}if(!valid(installation))installation=valid(requested)?requested:read('dsh-preferred-workspace','ai');}}
 if(!valid(installation))installation=null;
 if(installation)try{sessionSet('dsh-pwa-installation',installation);}catch{}
 const preferenceKey='dsh-preferred-workspace:'+(installation||'browser'),legacy=!url.searchParams.has('pwa')?read('dsh-preferred-workspace'):null;
 const notificationId=url.searchParams.get('fromNotification')==='1'&&/^[0-9a-f-]{36}$/i.test(url.searchParams.get('notificationThread')||'')?url.searchParams.get('notificationThread'):null;
 const targetPath=notificationId?'/local/'+notificationId:url.pathname;
 const preferred=read(preferenceKey,legacy),deep=/^\/local\/[0-9a-f-]{36}$/i.test(targetPath),explicit=url.searchParams.get('switchWorkspace')==='1'||url.searchParams.get('fromNotification')==='1'||deep;
 const id=explicit&&valid(requested)?requested:valid(preferred)?preferred:requested||installation||'ai';
 window.__DSH_INSTALLATION__={id:installation,standalone};
 window.__DSH_SET_PREFERRED_WORKSPACE__=value=>{if(valid(value)){write(preferenceKey,value);if(!installation)write('dsh-preferred-workspace',value);}};
 // Reading a notification or a shared conversation never changes the next launch.
 if(!deep&&url.searchParams.get('fromNotification')!=='1')window.__DSH_SET_PREFERRED_WORKSPACE__(id);
 let deviceKey=null;
 window.__DSH_DEVICE_SETTINGS__={getOwner:()=>{const value=read('dsh-notification-owner-v1');return valid(value)?value:null;},setOwner:value=>{if(valid(value))write('dsh-notification-owner-v1',value);},getDeviceKey:()=>{if(deviceKey)return deviceKey;const saved=read('dsh-push-device-v2');deviceKey=/^[a-f0-9]{64}$/.test(saved||'')?saved:Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');write('dsh-push-device-v2',deviceKey);return deviceKey;}};
 // A root URL is a launch/reload target, not proof of an intentional New chat click.
 // New chat stays an in-page navigation; keep drafts and explicit conversation links.
 const embedded=window.parent!==window&&url.searchParams.get('dshEmbedded')==='1';
 const home=url.searchParams.get('nativeList')==='1'||!deep&&!embedded;
 window.__DSH_EXECUTION_CONNECTED__=false;window.__DSH_NATIVE_ONLINE__=false;window.__DSH_SCOPE__={id,token:'',nativeList:home};
 /* __DSH_EARLY_THEME__ */
 window.__DSH_UI_RELEASE__=release;
 /* __DSH_EARLY_DIAGNOSTICS__ */
 const canonical=new URL(url);if(url.pathname===release.shell){canonical.pathname=deep?targetPath:'/';canonical.searchParams.set('view','chat');canonical.searchParams.delete('notificationThread');}
 if(home){canonical.searchParams.set('nativeList','1');canonical.searchParams.set('view','chat');}
 canonical.searchParams.set('workspace',id);canonical.searchParams.delete('switchWorkspace');canonical.searchParams.delete('launch');if(installation)canonical.searchParams.set('pwa',installation);
 if(canonical.href!==url.href)history.replaceState(history.state,'',canonical.pathname+canonical.search+canonical.hash);
 const route=deep?targetPath:'/';
 let meta=document.querySelector('meta[name="initial-route"]');if(!meta){meta=document.createElement('meta');meta.name='initial-route';document.head.append(meta);}meta.content=route;
 function script(src,module=false){return new Promise((resolve,reject)=>{const e=document.createElement('script');if(module)e.type='module';e.src=src;e.onload=resolve;e.onerror=()=>reject(Error('界面资源暂不可用'));document.head.append(e);});}
 const waitForAndroidCache=()=>{const pending=window.__DSH_ANDROID_CACHE_READY__;if(!pending||typeof pending.then!=='function')return Promise.resolve(null);return Promise.race([Promise.resolve(pending),new Promise(resolve=>setTimeout(()=>resolve(null),1200))]).catch(()=>null);};
 // Credentials authorize control; the optional bootstrap only refreshes a read cache.
 // Both initial boot and reconnect share the scope layer's single in-flight renewal.
 let configured=false,authenticated=false,authBlocked=false,cache;
 const controlReady=()=>{if(!configured||!authenticated||authBlocked||window.__DSH_ACCEPT_SESSION_READY__?.()!==true)return;window.__DSH_NATIVE_ONLINE__=true;cache.saveMeta('auth-locked',false).catch(()=>{});window.dispatchEvent(new Event('dsh:session-ready'));if(window.__DSH_EXECUTION_CONNECTED__!==true)window.__DSH_RECONNECT_TRANSPORT__?.();};
 async function freshSession(){const ok=await window.__DSH_RENEW_SCOPE__();if(!ok)throw Error('Mac 暂未连接');return true;}
 async function freshBootstrap(){const {response,data}=await window.__DSH_CONNECTION_JSON__('/w/'+id+'/api/native-bootstrap',{headers:{'x-dsh-scope':window.__DSH_SCOPE__.token},cache:'no-store',redirect:'manual'},30000);if(!response.ok||!data)throw Error('启动配置暂不可用');if(!authBlocked){const copy=structuredClone(data);if(copy.gatewayWsUrl){const u=new URL(copy.gatewayWsUrl);u.search='';copy.gatewayWsUrl=u.href;}cache.saveMeta('bootstrap',copy).catch(()=>{});}return data;}
 (async()=>{
  await script(release.scope);cache=window.__DSH_NATIVE_CACHE__;const atomsReady=cache.restoreAtoms().catch(()=>({}));
 addEventListener('dsh:authentication-required',()=>{authBlocked=true;authenticated=false;window.__DSH_NATIVE_ONLINE__=false;});
 addEventListener('dsh:scope-renewed',()=>{authenticated=true;controlReady();});
  let failed=null;const session=window.__DSH_SESSION_READY__=freshSession().catch(error=>{failed=error;return false;});
  const online=session.then(ok=>ok?freshBootstrap():null).catch(()=>null);
  const [locked,saved]=await Promise.all([cache.meta('auth-locked').catch(()=>false),cache.meta('bootstrap').catch(()=>null)]);let cached=locked?null:saved;
  // An existing local boot does not wait for the Android delta importer.
  if(!cached&&!locked){await waitForAndroidCache();cached=await cache.meta('bootstrap').catch(()=>null);}
  const cloudBootstrap=!cached&&!['127.0.0.1','localhost'].includes(location.hostname)?window.__DSH_CONNECTION_JSON__('/sync/v1/w/'+id+'/native-bootstrap',{cache:'no-store',redirect:'manual'},30000).then(({response:r,data})=>{if(r.status===401||r.type==='opaqueredirect')throw Object.assign(Error('请重新登录'),{login:true});if(!r.ok)return null;return data?.config;}).catch(()=>null):Promise.resolve(null);
  const requireConfig=value=>{if(!value)throw Error('启动配置暂不可用');return value;};const config=cached||await Promise.any([cloudBootstrap.then(requireConfig),online.then(requireConfig)]).catch(()=>null);if(!config)throw failed||Error('尚未缓存此工作区，请先在线打开一次');
  const initial=await cache.prepareSidebarBootstrap(structuredClone(config));initial.gatewayBaseUrl=location.origin+'/w/'+id;initial.gatewayWsUrl=location.origin.replace(/^http/,'ws')+'/w/'+id+'/ws';
  initial.persistedAtomSnapshot={...initial.persistedAtomSnapshot,...await atomsReady};if(initial.dshNativeInitialization)cache.saveMeta('native-initialization',initial.dshNativeInitialization).catch(()=>{});window.__CODEX_WEB_CONFIG__=initial;document.documentElement.dataset.dshCachedBoot=cached?'1':'0';window.__DSH_PERF__?.event('native_cache_boot',{source:cached?'indexeddb':'network'});
  configured=true;controlReady();
  // A late failed read must never overwrite a newer successful renewal/socket.
  session.then(ok=>{if(!ok&&!authenticated&&!authBlocked&&window.__DSH_EXECUTION_CONNECTED__!==true)window.dispatchEvent(new CustomEvent('dsh:connection-state',{detail:{state:'offline-cache'}}));});
  let recovering=false;const recover=()=>{if(recovering||authBlocked||window.__DSH_EXECUTION_CONNECTED__===true)return;recovering=true;freshSession().catch(()=>{}).finally(()=>{recovering=false;});};addEventListener('online',recover);addEventListener('focus',recover);setInterval(recover,15000);
  if(cached&&home)await window.__DSH_STARTUP_PREVIEW__?.show();
  await Promise.all([script(release.runtime),script(release.pwa)]);await script(release.entry,true);
 })().catch(error=>{window.__DSH_CLIENT_LOG__?.reportError('boot_error',error);window.__DSH_STARTUP_PREVIEW__?.hide();const root=document.getElementById('root');if(root){root.replaceChildren();const p=document.createElement('p');p.className='dsh-cache-boot-error';p.textContent=error.message;root.append(p);const a=document.createElement('a');a.href=location.pathname+location.search;a.textContent='重新连接';root.append(a);}});
})();

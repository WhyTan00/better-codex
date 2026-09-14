// A credential-free entry to the same pinned native renderer.
(()=>{
 const release=__BETTER_CODEX_NATIVE_RELEASE__,url=new URL(location.href),valid=value=>['ai','secondary'].includes(value);
 const requested=url.searchParams.get('workspace');if(requested&&!valid(requested)){document.getElementById('root').textContent='工作区不可访问';return;}
 // Capture unscoped storage before the native renderer installs its workspace wrapper.
 let get=()=>null,set=()=>{},sessionGet=()=>null,sessionSet=()=>{};
 try{get=localStorage.getItem.bind(localStorage);set=localStorage.setItem.bind(localStorage);sessionGet=sessionStorage.getItem.bind(sessionStorage);sessionSet=sessionStorage.setItem.bind(sessionStorage);}catch{}
 const read=(key,fallback=null)=>{try{return get(key)||fallback;}catch{return fallback;}},write=(key,value)=>{try{set(key,value);}catch{}};
 const standalone=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
 let installation=url.searchParams.get('pwa');if(!valid(installation)){installation=null;if(standalone){try{installation=sessionGet('betterCodex-pwa-installation');}catch{}if(!valid(installation))installation=valid(requested)?requested:read('betterCodex-preferred-workspace','ai');}}
 if(!valid(installation))installation=null;
 if(installation)try{sessionSet('betterCodex-pwa-installation',installation);}catch{}
 const preferenceKey='betterCodex-preferred-workspace:'+(installation||'browser'),legacy=!url.searchParams.has('pwa')?read('betterCodex-preferred-workspace'):null;
 const notificationId=url.searchParams.get('fromNotification')==='1'&&/^[0-9a-f-]{36}$/i.test(url.searchParams.get('notificationThread')||'')?url.searchParams.get('notificationThread'):null;
 const targetPath=notificationId?'/local/'+notificationId:url.pathname;
 const preferred=read(preferenceKey,legacy),deep=/^\/local\/[0-9a-f-]{36}$/i.test(targetPath),explicit=url.searchParams.get('switchWorkspace')==='1'||url.searchParams.get('fromNotification')==='1'||deep;
 const id=explicit&&valid(requested)?requested:valid(preferred)?preferred:requested||installation||'ai';
 window.__BETTER_CODEX_INSTALLATION__={id:installation,standalone};
 window.__BETTER_CODEX_SET_PREFERRED_WORKSPACE__=value=>{if(valid(value)){write(preferenceKey,value);if(!installation)write('betterCodex-preferred-workspace',value);}};
 // Reading a notification or a shared conversation never changes the next launch.
 if(!deep&&url.searchParams.get('fromNotification')!=='1')window.__BETTER_CODEX_SET_PREFERRED_WORKSPACE__(id);
 let deviceKey=null;
 window.__BETTER_CODEX_DEVICE_SETTINGS__={getOwner:()=>{const value=read('betterCodex-notification-owner-v1');return valid(value)?value:null;},setOwner:value=>{if(valid(value))write('betterCodex-notification-owner-v1',value);},getDeviceKey:()=>{if(deviceKey)return deviceKey;const saved=read('betterCodex-push-device-v2');deviceKey=/^[a-f0-9]{64}$/.test(saved||'')?saved:Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');write('betterCodex-push-device-v2',deviceKey);return deviceKey;}};
 // A root URL is a launch/reload target, not proof of an intentional New chat click.
 // New chat stays an in-page navigation; keep drafts and explicit conversation links.
 const embedded=window.parent!==window&&url.searchParams.get('betterCodexEmbedded')==='1';
 const home=url.searchParams.get('nativeList')==='1'||!deep&&!embedded;
 window.__BETTER_CODEX_EXECUTION_CONNECTED__=false;window.__BETTER_CODEX_NATIVE_ONLINE__=false;window.__BETTER_CODEX_SCOPE__={id,token:'',nativeList:home};
 /* __BETTER_CODEX_EARLY_THEME__ */
 window.__BETTER_CODEX_UI_RELEASE__=release;
 const canonical=new URL(url);if(url.pathname===release.shell){canonical.pathname=deep?targetPath:'/';canonical.searchParams.set('view','chat');canonical.searchParams.delete('notificationThread');}
 if(home){canonical.searchParams.set('nativeList','1');canonical.searchParams.set('view','chat');}
 canonical.searchParams.set('workspace',id);canonical.searchParams.delete('switchWorkspace');canonical.searchParams.delete('launch');if(installation)canonical.searchParams.set('pwa',installation);
 if(canonical.href!==url.href)history.replaceState(history.state,'',canonical.pathname+canonical.search+canonical.hash);
 const route=deep?targetPath:'/';
 let meta=document.querySelector('meta[name="initial-route"]');if(!meta){meta=document.createElement('meta');meta.name='initial-route';document.head.append(meta);}meta.content=route;
 function script(src,module=false){return new Promise((resolve,reject)=>{const e=document.createElement('script');if(module)e.type='module';e.src=src;e.onload=resolve;e.onerror=()=>reject(Error('界面资源暂不可用'));document.head.append(e);});}
 const waitForAndroidCache=()=>{const pending=window.__BETTER_CODEX_ANDROID_CACHE_READY__;if(!pending||typeof pending.then!=='function')return Promise.resolve(null);return Promise.race([Promise.resolve(pending),new Promise(resolve=>setTimeout(()=>resolve(null),1200))]).catch(()=>null);};
 async function fresh(){const r=await fetch('/betterCodex-scope-session?workspace='+id,{cache:'no-store',redirect:'manual'});if(r.type==='opaqueredirect'||r.status===401)throw Object.assign(Error('请重新登录'),{login:true});if(!r.ok)throw Error('Mac 暂未连接');const session=await r.json();window.__BETTER_CODEX_SCOPE__.token=session.token;const response=await fetch('/w/'+id+'/api/native-bootstrap',{headers:{'x-betterCodex-scope':session.token},cache:'no-store',redirect:'manual'});if(!response.ok)throw Error('启动配置暂不可用');return response.json();}
 (async()=>{
  await script(release.scope);const cache=window.__BETTER_CODEX_NATIVE_CACHE__;const atomsReady=cache.restoreAtoms().catch(()=>({}));
  let failed=null;const online=window.__BETTER_CODEX_SESSION_READY__=fresh().catch(error=>{failed=error;return null;});
  const [locked,saved]=await Promise.all([cache.meta('auth-locked').catch(()=>false),cache.meta('bootstrap').catch(()=>null)]);let cached=locked?null:saved;
  // An existing local boot does not wait for the Android delta importer.
  if(!cached&&!locked){await waitForAndroidCache();cached=await cache.meta('bootstrap').catch(()=>null);}
  const cloudBootstrap=!['127.0.0.1','localhost'].includes(location.hostname)?fetch('/sync/v1/w/'+id+'/native-bootstrap',{cache:'no-store',redirect:'manual'}).then(async r=>{if(r.status===401||r.type==='opaqueredirect')throw Object.assign(Error('请重新登录'),{login:true});if(!r.ok)return null;return (await r.json()).config;}).catch(()=>null):Promise.resolve(null);
  const config=cached||await cloudBootstrap||await online;if(!config)throw failed||Error('尚未缓存此工作区，请先在线打开一次');
  const initial=structuredClone(config);initial.gatewayBaseUrl=location.origin+'/w/'+id;initial.gatewayWsUrl=location.origin.replace(/^http/,'ws')+'/w/'+id+'/ws';
  initial.persistedAtomSnapshot={...initial.persistedAtomSnapshot,...await atomsReady};if(initial.betterCodexNativeInitialization)cache.saveMeta('native-initialization',initial.betterCodexNativeInitialization).catch(()=>{});window.__CODEX_WEB_CONFIG__=initial;document.documentElement.dataset.betterCodexCachedBoot=cached?'1':'0';window.__BETTER_CODEX_PERF__?.event('native_cache_boot',{source:cached?'indexeddb':'network'});
  online.then(value=>{window.__BETTER_CODEX_NATIVE_ONLINE__=!!value;if(value){cache.saveMeta('auth-locked',false).catch(()=>{});window.__BETTER_CODEX_CONNECTION_PAUSED__=false;const copy=structuredClone(value);if(copy.gatewayWsUrl){const u=new URL(copy.gatewayWsUrl);u.search='';copy.gatewayWsUrl=u.href;}cache.saveMeta('bootstrap',copy).catch(()=>{});window.dispatchEvent(new Event('betterCodex:session-ready'));}else{window.__BETTER_CODEX_CONNECTION_PAUSED__=true;window.dispatchEvent(new CustomEvent('betterCodex:connection-state',{detail:{state:'offline-cache'}}));if(failed?.login)window.dispatchEvent(new Event('betterCodex:authentication-required'));}});
  let recovering=false;const recover=()=>{if(recovering||window.__BETTER_CODEX_EXECUTION_CONNECTED__===true)return;recovering=true;fresh().then(()=>{cache.saveMeta('auth-locked',false).catch(()=>{});window.__BETTER_CODEX_NATIVE_ONLINE__=true;window.__BETTER_CODEX_CONNECTION_PAUSED__=false;window.__BETTER_CODEX_RECONNECT_TRANSPORT__?.();window.dispatchEvent(new Event('betterCodex:session-ready'));}).catch(()=>{}).finally(()=>{recovering=false;});};addEventListener('online',recover);addEventListener('focus',recover);setInterval(recover,15000);
  if(cached&&home)await window.__BETTER_CODEX_STARTUP_PREVIEW__?.show();
  await Promise.all([script(release.runtime),script(release.pwa)]);await script(release.entry,true);
 })().catch(error=>{window.__BETTER_CODEX_STARTUP_PREVIEW__?.hide();const root=document.getElementById('root');if(root){root.replaceChildren();const p=document.createElement('p');p.className='betterCodex-cache-boot-error';p.textContent=error.message;root.append(p);const a=document.createElement('a');a.href=location.pathname+location.search;a.textContent='重新连接';root.append(a);}});
})();

// BETTER_CODEX PWA lifecycle adapted for pinned official renderer assets.
// Credentials and mutations never enter CacheStorage. Native content lives in
// the scoped transactional database; only a credential-free shell is cached.
const CACHE='betterCodex-official-static-v2';
const SHELL_CACHE='betterCodex-native-shell-v1',RELEASE='/betterCodex-native-release.json';
const OFFLINE='/betterCodex-offline.html';
const DEVICE_CACHE='betterCodex-notification-device-v1',RECIPIENT_KEY='/__betterCodex-notification-recipient-v1';
async function notificationRecipient(){try{const saved=await(await caches.open(DEVICE_CACHE)).match(RECIPIENT_KEY);const recipient=saved?(await saved.json()).recipient:null;return ['ai','secondary'].includes(recipient)?recipient:null;}catch{return null;}}
const STATIC=/^(?:\/official-patched-v[0-9]+\/assets\/[^?]+\.(?:js|css|woff2?|png|svg)|\/betterCodex-shell\/[0-9a-f]{16}\/[a-z-]+\.(?:mjs|css))$/;
const NATIVE_STATIC=/^\/betterCodex-native-assets\/[a-f0-9]{16}\/[a-z-]+\.(?:js|css)$/;
function reportCache(event,hit){if(event.clientId)self.clients.get(event.clientId).then(client=>client?.postMessage({type:'betterCodex-static-cache',hit})).catch(()=>{});}
const CORE=/\/(?:app-initial-|app-primary-|index-|rolldown-runtime-|zh-CN-)[^/]+\.(?:js|css)$/;
let preparing=null;
async function prepareShell(){if(preparing)return preparing;preparing=(async()=>{
 const cache=await caches.open(CACHE),response=await fetch(RELEASE,{cache:'no-store',redirect:'manual'});if(!response.ok||response.redirected)throw Error('release unavailable');const manifest=await response.json();if(manifest.disabled===true){const shells=await caches.open(SHELL_CACHE);await shells.delete(RELEASE);return;}
 if(manifest.schemaVersion!==1||!/^\/betterCodex-native-assets\/[a-f0-9]{16}\/shell\.html$/.test(manifest.shell))throw Error('invalid shell');
 const nativeFiles=[manifest.scope,manifest.runtime,manifest.pwa,manifest.css,manifest.loader],startup=manifest.startupAssets||[];if(nativeFiles.some(p=>!NATIVE_STATIC.test(p))||!Array.isArray(startup)||startup.some(p=>typeof p!=='string'||!(STATIC.test(p)||NATIVE_STATIC.test(p)&&p===manifest.base+'turn.js')))throw Error('invalid assets');const files=[...new Set([...nativeFiles,...startup])];
 const shells=await caches.open(SHELL_CACHE),prior=await shells.match(RELEASE).catch(()=>null);if(prior&&(await prior.json()).version===manifest.version&&await shells.match(manifest.shell,{ignoreVary:true})&&(await Promise.all(files.map(p=>cache.match(p,{ignoreVary:true})))).every(Boolean))return manifest.version;
 // Bounded parallel preparation shortens cold install without competing with every lazy chunk.
 for(let start=0;start<files.length;start+=4)await Promise.all(files.slice(start,start+4).map(async path=>{if(await cache.match(path,{ignoreVary:true}))return;const result=await fetch(path,{cache:'reload',redirect:'manual'});if(!result.ok||result.redirected||/text\/html|application\/json/.test(result.headers.get('content-type')||''))throw Error('asset unavailable');await cache.put(path,result);}));
 const shell=await fetch(manifest.shell,{cache:'reload',redirect:'manual'});if(!shell.ok||shell.redirected||shell.headers.get('x-betterCodex-credential-free-shell')!=='1')throw Error('shell not verified');
 await shells.put(manifest.shell,shell);await shells.put(RELEASE,new Response(JSON.stringify(manifest),{headers:{'content-type':'application/json'}}));return manifest.version;
})().catch(()=>{}).finally(()=>{preparing=null;});return preparing;}
self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(CACHE);const r=await fetch(OFFLINE,{cache:'reload'});if(r.ok&&!r.redirected&&r.headers.get('content-type')?.includes('text/html'))await cache.put(OFFLINE,r);await prepareShell();})().catch(()=>{})));
self.addEventListener('activate',event=>event.waitUntil(Promise.all([self.clients.claim(),prepareShell()])));
self.addEventListener('message',event=>{if(event.data?.type==='SET_NOTIFICATION_RECIPIENT')event.waitUntil(setNotificationRecipient(event));if(event.data?.type==='ACTIVATE_UPDATE')event.waitUntil(prepareShell().then(version=>{if(version)return self.skipWaiting();}));if(event.data?.type==='PREPARE_NATIVE_CACHE')event.waitUntil(prepareShell().then(version=>event.ports?.[0]?.postMessage({ready:!!version,version})));});
async function setNotificationRecipient(event){const recipient=event.data.recipient;let origin;try{origin=new URL(event.source?.url).origin;}catch{}if(origin!==self.location.origin||!['ai','secondary'].includes(recipient))return;try{await(await caches.open(DEVICE_CACHE)).put(RECIPIENT_KEY,new Response(JSON.stringify({recipient}),{headers:{'content-type':'application/json'}}));event.ports?.[0]?.postMessage({recipient});}catch{event.ports?.[0]?.postMessage({error:'storage unavailable'});}}
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin)return;
 if(url.pathname==='/app/assets/icon.svg'&&!url.search){event.respondWith((async()=>{
  const cache=await caches.open(CACHE).catch(()=>null),cached=await cache?.match(request).catch(()=>null);
  const refresh=async()=>{const response=await fetch(request);if(cache&&response.ok&&!response.redirected&&response.headers.get('content-type')?.includes('image/svg+xml')){const headers=new Headers(response.headers);headers.set('x-betterCodex-cached-at',String(Date.now()));await cache.put(request,new Response(await response.clone().arrayBuffer(),{status:response.status,headers})).catch(()=>{});}return response;};
  if(cached){reportCache(event,true);if(Date.now()-Number(cached.headers.get('x-betterCodex-cached-at')||0)>86400000)event.waitUntil?.(refresh().catch(()=>{}));return cached;}reportCache(event,false);return refresh();
 })());return;}
 if((STATIC.test(url.pathname)||NATIVE_STATIC.test(url.pathname))&&!url.search){event.respondWith((async()=>{
  const cache=await caches.open(CACHE).catch(()=>null);
  // Fetch exposes decoded bodies but hides the browser's Accept-Encoding
  // header. Matching that Vary value causes a miss on every navigation.
  const cached=cache?await cache.match(request,{ignoreVary:true}).catch(()=>null):null;
  if(cached&&(cached.headers.get('vary')||'').split(',').every(v=>!v.trim()||v.trim().toLowerCase()==='accept-encoding')){reportCache(event,true);return cached;}
  reportCache(event,false);const response=await fetch(request),type=response.headers.get('content-type')||'';
  if(cache&&response.ok&&!response.redirected&&!type.includes('text/html')&&!type.includes('application/json')){try{
   await cache.put(request,response.clone());const keys=await cache.keys();let extra=keys.length-512;
   for(const old of keys){if(extra<=0)break;const path=new URL(old.url).pathname;if(path!==OFFLINE&&!CORE.test(path)&&!NATIVE_STATIC.test(path)){await cache.delete(old);extra--;}}
  }catch{}}
  return response;
 })());return;}
 if(request.mode==='navigate')event.respondWith((async()=>{
  const nativeRoute=(url.pathname==='/'||/^\/local\/[0-9a-f-]{36}$/i.test(url.pathname))&&!url.searchParams.has('logout');
  if(nativeRoute)try{const cache=await caches.open(SHELL_CACHE),manifestResponse=await cache.match(RELEASE),manifest=manifestResponse?await manifestResponse.json():null;if(manifest){const shell=await cache.match(manifest.shell,{ignoreVary:true});if(shell){event.waitUntil?.(prepareShell());return shell;}}}catch{}
  try{return await fetch(request);}catch{const page=await caches.match(OFFLINE).catch(()=>null);return page||new Response('暂时离线，请恢复网络后重新连接。',{status:503,headers:{'content-type':'text/plain;charset=utf-8'}});}
 })());
});

// Background completion delivery, including when no conversation page is open.
function notificationTarget(data){
 if(!data||!['ai','secondary'].includes(data.scope))return null;
 let target;try{target=new URL(data.url||'/',self.location.origin);}catch{return null;}
 if(target.origin!==self.location.origin||target.searchParams.get('workspace')!==data.scope||!(target.pathname==='/'||/^\/local\/[0-9a-f-]{36}$/i.test(target.pathname)))return null;
 target.searchParams.set('fromNotification','1');return target.href;
}
self.addEventListener('push',event=>event.waitUntil((async()=>{
 let data;try{data=event.data?.json();}catch{return;}
 const target=notificationTarget(data);if(data?.recipient!==data?.scope||await notificationRecipient()!==data?.scope)return;if(!target||!/^\w{32}$/.test(data.jobId||'')||!/^\w{32}$/.test(data.receipt||''))return;
 await self.registration.showNotification(data.title||'Codex · 会话已完成',{body:data.body||'有一个会话已完成，点按查看。',tag:'betterCodex-'+data.jobId,renotify:false,data:{url:target,scope:data.scope},icon:'/app/assets/icon.svg'});
 await fetch('/sync/v1/w/'+data.scope+'/push-received',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId:data.jobId,receipt:data.receipt}),credentials:'same-origin',cache:'no-store'}).catch(()=>{});
})()));
self.addEventListener('notificationclick',event=>{
 event.notification.close();const target=notificationTarget(event.notification.data);if(!target)return;
 event.waitUntil((async()=>{if(await notificationRecipient()!==event.notification.data?.scope)return;const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});const existing=windows.find(client=>client.url===target);if(existing)return existing.focus();return self.clients.openWindow(target);})());
});

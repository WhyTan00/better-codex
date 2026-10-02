// DSH PWA lifecycle adapted for pinned official renderer assets.
// Credentials and mutations never enter CacheStorage. Native content lives in
// the scoped transactional database; only a credential-free shell is cached.
const CACHE='dsh-official-static-v2';
const SHELL_CACHE='dsh-native-shell-v1',RELEASE='/dsh-native-release.json';
const OFFLINE='/dsh-offline.html';
const DEVICE_CACHE='dsh-notification-device-v1',RECIPIENT_KEY='/__dsh-notification-recipient-v1';
async function notificationRecipient(){try{const saved=await(await caches.open(DEVICE_CACHE)).match(RECIPIENT_KEY);const recipient=saved?(await saved.json()).recipient:null;return ['ai','zyy'].includes(recipient)?recipient:null;}catch{return null;}}
const STATIC=/^(?:\/official-patched-v[0-9]+\/assets\/[^?]+\.(?:js|css|woff2?|png|svg)|\/dsh-shell\/[0-9a-f]{16}\/[a-z-]+\.(?:mjs|css))$/;
const NATIVE_STATIC=/^\/dsh-native-assets\/[a-f0-9]{16}\/[a-z-]+\.(?:js|css)$/;
function reportCache(event,hit){if(event.clientId)self.clients.get(event.clientId).then(client=>client?.postMessage({type:'dsh-static-cache',hit})).catch(()=>{});}
const CORE=/\/(?:app-initial-|app-primary-|index-|rolldown-runtime-|zh-CN-)[^/]+\.(?:js|css)$/;
// Release ownership replaces permanent exemptions for every historical bundle.
const RELEASE_RECORD='/__dsh-ui-release/',MAX_CACHE_BYTES=128*1024*1024,MAX_CACHE_ENTRIES=512;
const clientPins=new Map();let cacheMutation=Promise.resolve(),preparingAssets=new Set(),queuedCacheWrites=0;
const serializedCache=work=>{const next=cacheMutation.catch(()=>{}).then(work);cacheMutation=next.catch(()=>{});return next;};
async function cacheProtection(){
 const shells=await caches.open(SHELL_CACHE),keys=await shells.keys(),records=[];
 for(const key of keys)if(new URL(key.url).pathname.startsWith(RELEASE_RECORD)){try{records.push(await(await shells.match(key)).json());}catch{}}
 const current=await shells.match(RELEASE);if(current){try{const value=await current.json();if(!records.some(r=>r.version===value.version))records.push(value);}catch{}}
 const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});const ids=new Set(clients.map(c=>c.id));for(const id of clientPins.keys())if(!ids.has(id))clientPins.delete(id);
 const versions=new Set(records.slice(-2).map(r=>r.version));let unknown=false;
 const paths=new Set([OFFLINE,...preparingAssets]);for(const client of clients){const pin=clientPins.get(client.id);if(pin){versions.add(pin.version);for(const path of pin.paths)paths.add(path);}else{unknown=true;client.postMessage?.({type:'DSH_CACHE_VERSION_REQUEST'});}}
 for(const r of records)if(versions.has(r.version))for(const path of [r.scope,r.runtime,r.pwa,r.css,r.loader,r.initial,r.primary,r.thread,...(r.startupAssets||[])])if(path)paths.add(path);
 return {shells,keys,versions,protected:path=>paths.has(path)||[...versions].some(v=>path.startsWith('/dsh-native-assets/'+v+'/'))||unknown&&(CORE.test(path)||NATIVE_STATIC.test(path))};
}
async function trimStatic(cache,incomingPath=null,incomingBytes=0){
 const protection=await cacheProtection(),rows=[];let bytes=incomingBytes,count=incomingPath?1:0;
 for(const key of await cache.keys()){const path=new URL(key.url).pathname;if(path===incomingPath)continue;const response=await cache.match(key,{ignoreVary:true});if(!response)continue;let size=Number(response.headers.get('x-dsh-cache-bytes'));
  if(!response.headers.has('x-dsh-cache-bytes')||!Number.isFinite(size)){const body=await response.arrayBuffer();size=body.byteLength;const headers=new Headers(response.headers);headers.set('x-dsh-cache-bytes',String(size));headers.delete('content-encoding');headers.delete('content-length');await cache.put(key,new Response(body,{status:response.status,headers}));}
  rows.push({key,path,size});bytes+=size;count++;
 }
 for(const row of rows){if(bytes<=MAX_CACHE_BYTES&&count<=MAX_CACHE_ENTRIES)break;if(protection.protected(row.path))continue;await cache.delete(row.key);bytes-=row.size;count--;}
 // In-flight/unknown live pages win over admission of new optional resources.
 // Once they close/announce their version, the next pass reclaims stale bundles.
 for(const key of protection.keys){const path=new URL(key.url).pathname,version=path.startsWith(RELEASE_RECORD)?path.slice(RELEASE_RECORD.length):path.match(/^\/dsh-native-assets\/([a-f0-9]{16})\/shell\.html$/)?.[1];if(version&&!protection.versions.has(version))await protection.shells.delete(key);}
 return bytes<=MAX_CACHE_BYTES&&count<=MAX_CACHE_ENTRIES;
}
async function cacheStatic(cache,path,response){if(queuedCacheWrites>=32)return false;queuedCacheWrites++;return serializedCache(async()=>{const body=await response.arrayBuffer(),pathname=new URL(typeof path==='string'?path:path.url,self.location.origin).pathname;if(!await trimStatic(cache,pathname,body.byteLength))return false;const headers=new Headers(response.headers);headers.set('x-dsh-cache-bytes',String(body.byteLength));headers.delete('content-encoding');headers.delete('content-length');await cache.put(path,new Response(body,{status:response.status,headers}));return true;}).finally(()=>{queuedCacheWrites--;});}
async function pinClient(event){let client;try{client=event.source;if(new URL(client.url).origin!==self.location.origin||!client.id||!/^[a-f0-9]{16}$/.test(event.data.version))return;}catch{return;}const old=clientPins.get(client.id);clientPins.set(client.id,{version:event.data.version,paths:old?.version===event.data.version?old.paths:new Set()});await serializedCache(async()=>trimStatic(await caches.open(CACHE)));}
let preparing=null;
async function prepareShell(){if(preparing)return preparing;preparing=(async()=>{
 const cache=await caches.open(CACHE),response=await fetch(RELEASE,{cache:'no-store',redirect:'manual'});if(!response.ok||response.redirected)throw Error('release unavailable');const manifest=await response.json();if(manifest.disabled===true){const shells=await caches.open(SHELL_CACHE);await shells.delete(RELEASE);return;}
 if(manifest.schemaVersion!==1||!/^\/dsh-native-assets\/[a-f0-9]{16}\/shell\.html$/.test(manifest.shell))throw Error('invalid shell');
 const nativeFiles=[manifest.scope,manifest.runtime,manifest.pwa,manifest.css,manifest.loader],startup=manifest.startupAssets||[];if(nativeFiles.some(p=>!NATIVE_STATIC.test(p))||!Array.isArray(startup)||startup.some(p=>typeof p!=='string'||!(STATIC.test(p)||NATIVE_STATIC.test(p)&&p===manifest.base+'turn.js')))throw Error('invalid assets');const files=[...new Set([...nativeFiles,...startup])];
 preparingAssets=new Set(files);const shells=await caches.open(SHELL_CACHE),prior=await shells.match(RELEASE).catch(()=>null);if(prior&&(await prior.json()).version===manifest.version&&await shells.match(manifest.shell,{ignoreVary:true})&&(await Promise.all(files.map(p=>cache.match(p,{ignoreVary:true})))).every(Boolean))return manifest.version;
 // Bounded parallel preparation shortens cold install without competing with every lazy chunk.
 for(let start=0;start<files.length;start+=4)await Promise.all(files.slice(start,start+4).map(async path=>{if(await cache.match(path,{ignoreVary:true}))return;const result=await fetch(path,{cache:'reload',redirect:'manual'});if(!result.ok||result.redirected||/text\/html|application\/json/.test(result.headers.get('content-type')||''))throw Error('asset unavailable');if(!await cacheStatic(cache,path,result))throw Error('cache budget occupied by active pages');}));
 const shell=await fetch(manifest.shell,{cache:'reload',redirect:'manual'});if(!shell.ok||shell.redirected||shell.headers.get('x-dsh-credential-free-shell')!=='1')throw Error('shell not verified');
 await shells.put(manifest.shell,shell);await shells.put(RELEASE_RECORD+manifest.version,new Response(JSON.stringify(manifest),{headers:{'content-type':'application/json'}}));await shells.put(RELEASE,new Response(JSON.stringify(manifest),{headers:{'content-type':'application/json'}}));await serializedCache(()=>trimStatic(cache));return manifest.version;
})().catch(()=>{}).finally(()=>{preparing=null;preparingAssets=new Set();});return preparing;}
self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(CACHE);const r=await fetch(OFFLINE,{cache:'reload'});if(r.ok&&!r.redirected&&r.headers.get('content-type')?.includes('text/html'))await cache.put(OFFLINE,r);await prepareShell();})().catch(()=>{})));
self.addEventListener('activate',event=>event.waitUntil(Promise.all([self.clients.claim(),prepareShell()])));
self.addEventListener('message',event=>{if(event.data?.type==='DSH_CACHE_CLIENT_VERSION')event.waitUntil(pinClient(event));if(event.data?.type==='SET_NOTIFICATION_RECIPIENT')event.waitUntil(setNotificationRecipient(event));if(event.data?.type==='ACTIVATE_UPDATE')event.waitUntil(prepareShell().then(version=>{if(version)return self.skipWaiting();}));if(event.data?.type==='PREPARE_NATIVE_CACHE')event.waitUntil(prepareShell().then(version=>event.ports?.[0]?.postMessage({ready:!!version,version})));});
async function setNotificationRecipient(event){const recipient=event.data.recipient;let origin;try{origin=new URL(event.source?.url).origin;}catch{}if(origin!==self.location.origin||!['ai','zyy'].includes(recipient))return;try{await(await caches.open(DEVICE_CACHE)).put(RECIPIENT_KEY,new Response(JSON.stringify({recipient}),{headers:{'content-type':'application/json'}}));event.ports?.[0]?.postMessage({recipient});}catch{event.ports?.[0]?.postMessage({error:'storage unavailable'});}}
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin)return;
 if(url.pathname==='/app/assets/icon.svg'&&!url.search){event.respondWith((async()=>{
  const cache=await caches.open(CACHE).catch(()=>null),cached=await cache?.match(request).catch(()=>null);
  const refresh=async()=>{const response=await fetch(request);if(cache&&response.ok&&!response.redirected&&response.headers.get('content-type')?.includes('image/svg+xml')){const headers=new Headers(response.headers);headers.set('x-dsh-cached-at',String(Date.now()));await cache.put(request,new Response(await response.clone().arrayBuffer(),{status:response.status,headers})).catch(()=>{});}return response;};
  if(cached){reportCache(event,true);if(Date.now()-Number(cached.headers.get('x-dsh-cached-at')||0)>86400000)event.waitUntil?.(refresh().catch(()=>{}));return cached;}reportCache(event,false);return refresh();
 })());return;}
 if((STATIC.test(url.pathname)||NATIVE_STATIC.test(url.pathname))&&!url.search){clientPins.get(event.clientId)?.paths.add(url.pathname);event.respondWith((async()=>{
  const cache=await caches.open(CACHE).catch(()=>null);
  // Fetch exposes decoded bodies but hides the browser's Accept-Encoding
  // header. Matching that Vary value causes a miss on every navigation.
  const cached=cache?await cache.match(request,{ignoreVary:true}).catch(()=>null):null;
  if(cached&&(cached.headers.get('vary')||'').split(',').every(v=>!v.trim()||v.trim().toLowerCase()==='accept-encoding')){reportCache(event,true);return cached;}
  reportCache(event,false);const response=await fetch(request),type=response.headers.get('content-type')||'';
  if(cache&&response.ok&&!response.redirected&&!type.includes('text/html')&&!type.includes('application/json')){try{
   const caching=cacheStatic(cache,request,response.clone());if(event.waitUntil)event.waitUntil(caching.catch(()=>{}));else await caching;
  }catch{}}
  return response;
 })());return;}
 if(request.mode==='navigate')event.respondWith((async()=>{
  const nativeRoute=(url.pathname==='/'||/^\/local\/[0-9a-f-]{36}$/i.test(url.pathname))&&!url.searchParams.has('logout');
  const retry=nativeRoute&&url.searchParams.has('_codex_retry');let prepared;
  if(retry){
   // A renderer's explicit retry must not immediately reopen the crashed old
   // shell. Keep ordinary navigation fast and never reload another live page.
   const pending=prepareShell();event.waitUntil?.(pending);let timer;
   try{prepared=await Promise.race([pending,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),20000);})]);}finally{clearTimeout(timer);}
  }
  if(nativeRoute)try{const cache=await caches.open(SHELL_CACHE),manifestResponse=await cache.match(RELEASE),manifest=manifestResponse?await manifestResponse.json():null;if(manifest){const shell=await cache.match(manifest.shell,{ignoreVary:true});if(shell){
   if(!retry){event.waitUntil?.(prepareShell());return shell;}
   const current=prepared===manifest.version,headers=new Headers(shell.headers);headers.set('x-dsh-shell-recovery',current?'updated':'cached-fallback');headers.set('cache-control','no-store');headers.delete('content-length');headers.delete('content-encoding');headers.delete('etag');
   if(current)return new Response(shell.body,{status:shell.status,headers});
   // This notice belongs only to the failed retry response, never CacheStorage.
   // No query values, credentials, drafts or Native state are rewritten.
   const html=await shell.text(),notice='<aside role="status" data-dsh-recovery-fallback style="position:fixed;z-index:2147483647;top:env(safe-area-inset-top,0px);left:0;right:0;padding:8px 12px;background:#fff4d6;color:#453410;font:14px/1.4 system-ui;pointer-events:none">暂时无法取得新版，正在使用已保存的界面。恢复连接后可重试。</aside>';
   return new Response(/<body\b[^>]*>/i.test(html)?html.replace(/<body\b[^>]*>/i,body=>body+notice):notice+html,{status:shell.status,headers});
  }}}catch{}
  try{return await fetch(request);}catch{const page=await caches.match(OFFLINE).catch(()=>null);return page||new Response('暂时离线，请恢复网络后重新连接。',{status:503,headers:{'content-type':'text/plain;charset=utf-8'}});}
 })());
});

// Background completion delivery, including when no conversation page is open.
function notificationTarget(data){
 if(!data||!['ai','zyy'].includes(data.scope))return null;
 let target;try{target=new URL(data.url||'/',self.location.origin);}catch{return null;}
 if(target.origin!==self.location.origin||target.searchParams.get('workspace')!==data.scope||!(target.pathname==='/'||/^\/local\/[0-9a-f-]{36}$/i.test(target.pathname)))return null;
 target.searchParams.set('fromNotification','1');return target.href;
}
self.addEventListener('push',event=>event.waitUntil((async()=>{
 let data;try{data=event.data?.json();}catch{return;}
 const target=notificationTarget(data);if(data?.recipient!==data?.scope||await notificationRecipient()!==data?.scope)return;if(!target||!/^\w{32}$/.test(data.jobId||'')||!/^\w{32}$/.test(data.receipt||''))return;
 await self.registration.showNotification(data.title||'Codex · 会话已完成',{body:data.body||'有一个会话已完成，点按查看。',tag:'dsh-'+data.jobId,renotify:false,data:{url:target,scope:data.scope},icon:'/app/assets/icon.svg'});
 await fetch('/sync/v1/w/'+data.scope+'/push-received',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId:data.jobId,receipt:data.receipt}),credentials:'same-origin',cache:'no-store'}).catch(()=>{});
})()));
self.addEventListener('notificationclick',event=>{
 event.notification.close();const target=notificationTarget(event.notification.data);if(!target)return;
 event.waitUntil((async()=>{if(await notificationRecipient()!==event.notification.data?.scope)return;const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});const existing=windows.find(client=>client.url===target);if(existing)return existing.focus();return self.clients.openWindow(target);})());
});

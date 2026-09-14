import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
async function setup(){const handlers={},entries=new Map(),network=[];let offline=false,skip=0,claimed=0;const base='http://localhost:3080';const url=k=>typeof k==='string'?new URL(k,base).href:k.url;const cache={match:async k=>entries.get(url(k))?.clone(),put:async(k,v)=>entries.set(url(k),v.clone()),keys:async()=>[...entries.keys()].map(u=>new Request(u)),delete:async k=>entries.delete(url(k))};
 const context={URL,Response,Request,Headers,self:{location:{origin:base},addEventListener:(k,f)=>handlers[k]=f,clients:{claim:async()=>claimed++},skipWaiting:()=>skip++},caches:{open:async()=>cache,match:cache.match},fetch:async req=>{network.push(url(req));if(offline)throw Error('offline');return new Response(url(req).endsWith('/betterCodex-offline.html')?'离线状态':'export const asset=true',{headers:{'content-type':url(req).endsWith('.html')?'text/html':'text/javascript'}})}};
 vm.runInNewContext(await readFile(new URL('../public/official-service-worker.js',import.meta.url),'utf8'),context);return {handlers,entries,network,base,context,setOffline:v=>offline=v,get skip(){return skip},get claimed(){return claimed}};}
test('static renderer reopens from cache but credentials, private reads and writes never enter it',async()=>{const s=await setup();let installed;s.handlers.install({waitUntil:p=>installed=p});await installed;
 const request=new Request(s.base+'/official-patched-v8/assets/renderer-123.js');let r;s.handlers.fetch({request,respondWith:p=>r=p});assert.equal((await r).status,200);s.setOffline(true);s.handlers.fetch({request,respondWith:p=>r=p});assert.match(await(await r).text(),/asset/);
 for(const request of [new Request(s.base+'/w/ai/api/sync'),new Request(s.base+'/codex-web-config.js?scopeToken=private'),new Request(s.base+'/w/ai/api/request',{method:'POST',body:'QA'})]){let handled=false;s.handlers.fetch({request,respondWith:()=>handled=true});assert.equal(handled,false);}
 assert(![...s.entries.keys()].some(k=>k.includes('scopeToken')||k.includes('/api/')));
});
test('offline navigation shows recovery without replay and updates activate only on explicit selection',async()=>{const s=await setup();let p;s.handlers.install({waitUntil:x=>p=x});await p;assert.equal(s.skip,0);s.setOffline(true);s.handlers.fetch({request:{url:s.base+'/?workspace=secondary',method:'GET',mode:'navigate'},respondWith:x=>p=x});assert.match(await(await p).text(),/离线/);s.handlers.message({data:{type:'ACTIVATE_UPDATE'},waitUntil:x=>p=x});await p;assert.equal(s.skip,0); // A failed preparation cannot activate a partial update.
 s.setOffline(false);const version='a'.repeat(16),base='/betterCodex-native-assets/'+version+'/';const manifest={schemaVersion:1,version,shell:base+'shell.html',scope:base+'scope.js',runtime:base+'runtime.js',pwa:base+'pwa.js',css:base+'pwa.css',loader:base+'loader.js'};s.context.fetch=async path=>new Response(path==='/betterCodex-native-release.json'?JSON.stringify(manifest):path.endsWith('.html')?'<html>new</html>':'asset',{headers:{'content-type':path.endsWith('.html')?'text/html':'text/javascript','x-betterCodex-credential-free-shell':'1'}});let ack;s.handlers.message({data:{type:'PREPARE_NATIVE_CACHE'},ports:[{postMessage:v=>ack=v}],waitUntil:x=>p=x});await p;assert.equal(ack.version,version);assert.equal(ack.ready,true);assert.equal(s.skip,0);s.handlers.message({data:{type:'ACTIVATE_UPDATE'},waitUntil:x=>p=x});await p;assert.equal(s.skip,1);});
test('a login redirect or HTML response cannot poison a cached script',async()=>{const s=await setup();s.context.fetch=async()=>new Response('<html>sign in</html>',{headers:{'content-type':'text/html'}});let p;s.handlers.fetch({request:new Request(s.base+'/official-patched-v8/assets/main-123.js'),respondWith:x=>p=x});await p;assert.equal(s.entries.size,0);});
test('disabled cache storage and cache quota failures preserve successful online responses',async()=>{
 for(const mode of ['open','put']){const s=await setup();s.context.caches.open=mode==='open'?async()=>{throw Error('storage unavailable')}:async()=>({match:async()=>null,put:async()=>{throw Error('quota')},keys:async()=>[]});let p;s.handlers.install({waitUntil:x=>p=x});await p;s.handlers.fetch({request:new Request(s.base+'/official-patched-v8/assets/main-123.js'),respondWith:x=>p=x});assert.equal((await p).status,200);}
});

test('compressed static assets reuse decoded cache bodies despite hidden Accept-Encoding; other Vary values remain distinct',async()=>{
 const s=await setup(),request=new Request(s.base+'/official-patched-v8/assets/app-primary-hash.js');let usedOptions;
 s.context.caches.open=async()=>({match:async(k,options)=>{usedOptions=options;return options?.ignoreVary?new Response('cached decoded module',{headers:{vary:'Accept-Encoding'}}):undefined;}});
 s.setOffline(true);let p;s.handlers.fetch({request,respondWith:x=>p=x});assert.equal(await(await p).text(),'cached decoded module');assert.equal(usedOptions.ignoreVary,true);assert.equal(s.network.length,0);
 s.context.caches.open=async()=>({match:async()=>new Response('wrong representation',{headers:{vary:'Accept-Language'}})});
 s.handlers.fetch({request,respondWith:x=>p=x});await assert.rejects(p,/offline/);
});
test('background prefetch cannot evict core startup bundles',async()=>{
 const s=await setup(),core=s.base+'/official-patched-v8/assets/app-primary-hash.js';s.entries.set(core,new Response('core'));
 for(let i=0;i<520;i++)s.entries.set(s.base+'/official-patched-v8/assets/optional-'+i+'.js',new Response('optional'));
 let p;s.handlers.fetch({request:new Request(s.base+'/official-patched-v8/assets/new-file.js'),respondWith:x=>p=x});await p;assert(s.entries.has(core));assert(s.entries.size<=512);
});

test('release preparation caches startup bundles and preserves the old shell if a required bundle fails',async()=>{
 const s=await setup(),old='a'.repeat(16),next='b'.repeat(16),core='/official-patched-v8/assets/app-initial-ready.js',missing='/official-patched-v8/assets/app-primary-new.js';let version=old,fail=false;const fetched=[];
 const manifest=()=>{const base='/betterCodex-native-assets/'+version+'/';return {schemaVersion:1,version,shell:base+'shell.html',scope:base+'scope.js',runtime:base+'runtime.js',pwa:base+'pwa.js',css:base+'pwa.css',loader:base+'loader.js',startupAssets:version===old?[core]:[core,missing]};};
 s.context.fetch=async path=>{fetched.push(path);if(fail&&path===missing)return new Response('unavailable',{status:503});return new Response(path==='/betterCodex-native-release.json'?JSON.stringify(manifest()):path.endsWith('.html')?'<html>native</html>':'asset',{headers:{'content-type':path.endsWith('.html')?'text/html':'text/javascript','x-betterCodex-credential-free-shell':'1'}});};
 async function prepare(){let p,ack;s.handlers.message({data:{type:'PREPARE_NATIVE_CACHE'},ports:[{postMessage:v=>ack=v}],waitUntil:x=>p=x});await p;return ack;}
 assert.equal((await prepare()).version,old);assert(s.entries.has(s.base+core));version=next;fail=true;assert.equal((await prepare()).ready,false);assert.equal((await s.entries.get(s.base+'/betterCodex-native-release.json').clone().json()).version,old);
 fail=false;assert.equal((await prepare()).version,next);assert.equal(fetched.filter(p=>p===core).length,1);assert(s.entries.has(s.base+missing));
});

test('private app icon remains available offline and login HTML cannot enter its cache',async()=>{
 const s=await setup(),request=new Request(s.base+'/app/assets/icon.svg');let p;s.context.fetch=async()=>new Response('<svg/>',{headers:{'content-type':'image/svg+xml'}});s.handlers.fetch({request,respondWith:x=>p=x});await p;
 s.context.fetch=async()=>{throw Error('offline')};s.handlers.fetch({request,respondWith:x=>p=x});assert.equal(await(await p).text(),'<svg/>');
 const fresh=await setup();fresh.context.fetch=async()=>new Response('<html>login</html>',{headers:{'content-type':'text/html'}});fresh.handlers.fetch({request,respondWith:x=>p=x});await p;assert.equal(fresh.entries.size,0);
});
test('cold shell preparation downloads at most four assets concurrently before committing the shell',async()=>{
 const s=await setup(),version='c'.repeat(16),base='/betterCodex-native-assets/'+version+'/',manifest={schemaVersion:1,version,shell:base+'shell.html',scope:base+'scope.js',runtime:base+'runtime.js',pwa:base+'pwa.js',css:base+'pwa.css',loader:base+'loader.js'};let active=0,peak=0;
 s.context.fetch=async path=>{if(path==='/betterCodex-native-release.json')return new Response(JSON.stringify(manifest));if(!path.endsWith('.html')){active++;peak=Math.max(peak,active);await new Promise(r=>setImmediate(r));active--;}else assert.equal(active,0);return new Response(path.endsWith('.html')?'<html/>':'asset',{headers:{'content-type':path.endsWith('.html')?'text/html':'text/javascript','x-betterCodex-credential-free-shell':'1'}});};
 let p,ack;s.handlers.message({data:{type:'PREPARE_NATIVE_CACHE'},ports:[{postMessage:v=>ack=v}],waitUntil:x=>p=x});await p;assert.equal(ack.ready,true);assert.equal(peak,4);
});

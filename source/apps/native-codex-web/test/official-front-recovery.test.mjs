import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {createOfficialFront} from '../src/official-front.mjs';
const require=createRequire('${BETTER_CODEX_HOME}/.better-codex/official-runtime-20260908/opencodex-pinned/package.json'),WS=require('ws');
const ai='00000000-0000-4000-8000-4ba7215b54d2',secondary='00000000-0000-4000-8000-f82fe242e2a8';
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'betterCodex-front-recovery-'));
 const runtime=await readFile('${BETTER_CODEX_HOME}/.better-codex/official-runtime-20260908/opencodex-pinned/web-shell/internal/providers/codex-bridge-polyfill.js','utf8');
 const upstream=http.createServer((req,res)=>{if(req.url==='/opencodex-runtime-bootstrap.js'){res.setHeader('content-type','text/javascript');res.end(runtime);}else if(req.url.endsWith('.css')){res.setHeader('content-type','text/css');res.end('/* auxiliary style fixture */');}else if(req.url==='/codex-web-config.js'){res.setHeader('content-type','text/javascript');res.end('window.__CODEX_WEB_CONFIG__={persistedAtomSnapshot:{}};');}else{res.setHeader('content-type','text/html');res.end('<html><head><meta name="theme-color" content="#ffffff"><meta name="color-scheme" content="light"><link rel="preload" as="script" href="/codex-web-config.js"><script src="/codex-web-config.js"></script><script type="module" src="/official-patched-v8/assets/index-7064d932a767.js"></script></head><body><div id="root"></div></body></html>');}});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const native=new EventEmitter();native.state='ready';native.start=async()=>{};native.close=()=>{};
 native.rpc=async(method,p)=>method==='config/read'?{config:{sandbox_mode:'danger-full-access',approval_policy:'never'}}:method==='thread/start'?{thread:{id:ai,cwd:'${BETTER_CODEX_WORKSPACE}',status:{type:'idle'}}}:method==='thread/loaded/list'?{data:[ai,secondary]}:method==='thread/read'?{thread:{id:p.threadId,cwd:p.threadId===ai?'${BETTER_CODEX_WORKSPACE}':'${BETTER_CODEX_SECONDARY_WORKSPACE}',status:{type:'active',activeFlags:[]}}}:{};
 const front=await createOfficialFront({port:0,native,stateDir:dir,upstream:'http://127.0.0.1:'+upstream.address().port});await new Promise(r=>front.server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+front.server.address().port,headers={origin:base},clients=[];
 t.after(async()=>{for(const ws of clients)ws.close();await front.close();await new Promise(r=>upstream.close(r));await rm(dir,{recursive:true,force:true});});
 const session=async scope=>(await fetch(base+'/betterCodex-scope-session?workspace='+scope,{headers})).json();
 async function client(scope){const binding=await session(scope),ws=new WS(base.replace('http','ws')+'/w/'+scope+'/ws?scopeToken='+binding.token,{headers,perMessageDeflate:false}),events=[];clients.push(ws);ws.on('message',b=>events.push(JSON.parse(b)));await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});ws.send(JSON.stringify({type:'hello',clientId:'test-'+clients.length}));return {ws,events,send:p=>ws.send(JSON.stringify({type:'opencodex:ipc-invoke',requestId:String(Math.random()),request:{channel:'codex_desktop:message-from-view',args:[p]}}))};}
 const until=async(fn)=>{const end=Date.now()+2000;while(Date.now()<end){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,5));}throw Error('Expected frame missing');};
 return {front,native,base,headers,session,client,until};
}
test('official fetch responses and shared-object events match actual renderer protocol',async t=>{
 const x=await fixture(t),c=await x.client('ai');
 c.send({type:'fetch',requestId:'settings',url:'vscode://codex/get-settings'});
 const success=await x.until(()=>c.events.find(e=>e.payload?.requestId==='settings'));
 assert.equal(success.payload.responseType,'success');assert.equal(JSON.parse(success.payload.bodyJsonString).values.localeOverride,'zh-CN');
 c.send({type:'fetch',requestId:'unsupported',url:'vscode://codex/not-enabled'});
 const denied=await x.until(()=>c.events.find(e=>e.payload?.requestId==='unsupported'));assert.equal(denied.payload.responseType,'error');assert.equal(denied.payload.status,403);
 c.send({type:'shared-object-subscribe',key:'host_config'});const shared=await x.until(()=>c.events.find(e=>e.payload?.type==='shared-object-updated'));assert.equal(shared.payload.value.id,'local');
});
test('reconnect snapshot restores same-host CLI active status and pending approval without cross-scope frames',async t=>{
 const x=await fixture(t);x.front.boundary.observe({id:'pending-cli',method:'item/tool/requestUserInput',params:{threadId:ai,questions:[]}});
 const c=await x.client('ai'),z=await x.client('secondary');
 const snapshot=await x.until(()=>c.events.find(e=>e.type==='betterCodex:sync-state'));assert.deepEqual(snapshot.activeThreadIds,[ai]);assert.equal(snapshot.approvals[0].id,'pending-cli');assert.equal(x.front.journal.ownsThread('ai',ai),false);
 await x.until(()=>c.events.find(e=>e.payload?.request?.id==='pending-cli'));const other=await x.until(()=>z.events.find(e=>e.type==='betterCodex:sync-state'));assert.deepEqual(other.activeThreadIds,[secondary]);assert.deepEqual(other.approvals,[]);assert(!JSON.stringify(z.events).includes(ai));
 const wrong=await fetch(x.base+'/betterCodex-scope-session?workspace=ai',{headers:{...x.headers,origin:'https://attacker.invalid'}});assert.equal(wrong.status,403);
 const binding=await x.session('ai');const accepted=await fetch(x.base+'/w/ai/api/sync',{headers:{...x.headers,'x-betterCodex-scope':binding.token}});assert.equal(accepted.status,200);
});
test('foreground scope renewal updates subsequent WebSocket and fetch credentials without replaying prompts',async()=>{
 class Storage{constructor(){this.values=new Map()}getItem(k){return this.values.get(k)||null}setItem(k,v){this.values.set(k,v)}removeItem(k){this.values.delete(k)}clear(){this.values.clear()}}
 const calls=[],listeners={},localStorage=new Storage(),sessionStorage=new Storage();
 class Socket{constructor(url){this.url=url;this.readyState=1;this.listeners={};this.sent=[]}addEventListener(k,fn){this.listeners[k]=fn}send(v){this.sent.push(v)}}
 const context={setTimeout:()=>1,clearTimeout(){},CustomEvent,Storage,localStorage,sessionStorage,crypto:{randomUUID:()=> 'stable-test'},URL,Headers,Request,MessageEvent,location:{href:'http://localhost:3080/?workspace=ai',origin:'http://localhost:3080'},document:{visibilityState:'visible',addEventListener:(k,f)=>listeners[k]=f},addEventListener:(k,f)=>listeners[k]=f};
 context.window={__BETTER_CODEX_SCOPE__:{id:'ai',token:'before'},WebSocket:Socket,fetch:async(input,init)=>{calls.push({input,init});return {ok:true,json:async()=>({id:'ai',token:'renewed'})}},dispatchEvent:()=>{}};
 vm.runInNewContext(await readFile(new URL('../public/official-scope-bootstrap.js',import.meta.url),'utf8'),context);
 const first=new context.window.WebSocket('wss://localhost:3080/w/ai/ws?scopeToken=before');first.listeners.message({data:JSON.stringify({type:'hello-ack'})});await listeners.pageshow();assert.deepEqual(first.sent.map(v=>JSON.parse(v).type),['betterCodex:sync']);
 const next=new context.window.WebSocket(first.url);assert.equal(new URL(next.url).searchParams.get('scopeToken'),'renewed');
 await context.window.fetch('/w/ai/api/sync');assert.equal(calls.at(-1).init.headers.get('x-betterCodex-scope'),'renewed');
 assert(!first.sent.some(s=>s.includes('turn/start')));
});

test('native shell contains no workspace credentials; authenticated bootstrap remains scoped',async t=>{
 const x=await fixture(t),response=await fetch(x.base+'/?workspace=ai&view=chat',{headers:x.headers}),html=await response.text();assert.equal(response.status,200);
 assert.equal(response.headers.get('x-betterCodex-credential-free-shell'),'1');assert.equal((html.match(/name="viewport"/g)||[]).length,1);assert.equal((html.match(/name="theme-color"/g)||[]).length,2);assert.match(html,/name="theme-color" media="\(prefers-color-scheme: light\)"/);assert.match(html,/name="theme-color" media="\(prefers-color-scheme: dark\)"/);assert.equal((html.match(/name="color-scheme"/g)||[]).length,1);assert(html.includes('interactive-widget=resizes-content'));
 assert(!html.includes('scopeToken'));assert(!html.includes('window.__BETTER_CODEX_SCOPE__='));assert(!html.includes('codex-web-config.js'));assert.match(html,/\/betterCodex-native-assets\/[a-f0-9]{16}\/loader.js/);
 const preloads=[...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(m=>m[1]);assert(preloads.length>=3);assert(preloads.some(src=>src.startsWith('/official-patched-v1009/')&&src.includes('app-initial-')));assert(preloads.some(src=>src.startsWith('/official-patched-v1010/')&&src.includes('app-primary-')));assert(html.indexOf('type="importmap"')<html.indexOf('rel="modulepreload"'));
 const binding=await x.session('ai'),bootstrap=await fetch(x.base+'/w/ai/api/native-bootstrap',{headers:{...x.headers,'x-betterCodex-scope':binding.token}});assert.equal(bootstrap.status,200);const config=await bootstrap.json();assert.equal(config.persistedAtomSnapshot['agent-mode-by-host-id'].local,'full-access');assert(!JSON.stringify(config).includes('${BETTER_CODEX_SECONDARY_WORKSPACE}'));
 const cross=await fetch(x.base+'/w/secondary/api/native-bootstrap',{headers:{...x.headers,'x-betterCodex-scope':binding.token}});assert.equal(cross.status,403);
});
test('entry displays a small conversation list shell and loads versioned local-cache assets',async t=>{
 const x=await fixture(t),r=await fetch(x.base+'/?workspace=ai'),html=await r.text();assert.match(html,/会话列表/);assert.match(html,/id="new-chat"/);assert(!html.includes('scopeToken'));assert(!html.includes('codex-web-config.js'));assert(html.length<5000);
 const module=html.match(/src="(\/betterCodex-shell\/[a-f0-9]{16}\/home.mjs)"/)[1];const js=await fetch(x.base+module);assert(js.ok);assert.match(js.headers.get('cache-control'),/immutable/);assert.match(await js.text(),/ReadCache/);
 const direct=await fetch(x.base+'/local/'+ai+'?workspace=ai');assert.equal(direct.status,200);assert.match(await direct.text(),/betterCodex-native-assets/);
});

test('PWA manifests retain per-workspace launch identity and use real service worker routes',async t=>{
 const x=await fixture(t);for(const scope of ['ai','secondary']){
  const r=await fetch(x.base+'/manifest.webmanifest?workspace='+scope,{headers:x.headers});assert.match(r.headers.get('content-type'),/manifest/);const m=await r.json();assert.equal(m.id,'/workspaces/'+scope);const launch=new URL(m.start_url,'http://localhost:3080');assert.equal(launch.searchParams.get('workspace'),scope);assert.equal(launch.searchParams.get('pwa'),scope);assert.equal(launch.searchParams.get('launch'),'1');assert.equal(launch.searchParams.get('view'),'chat');assert.equal(m.display,'standalone');assert.equal(m.lang,'zh-CN');
 }
 const sw=await fetch(x.base+'/workbench-sw.js',{headers:x.headers});assert.equal(sw.headers.get('service-worker-allowed'),'/');assert.match(await sw.text(),/addEventListener\('fetch'/);
 const offline=await fetch(x.base+'/betterCodex-offline.html',{headers:x.headers});assert.equal(offline.status,200);assert.match(await offline.text(),/恢复网络/);
});

test('project existence and root options are scoped rather than disabling the native composer',async t=>{
 const x=await fixture(t),c=await x.client('ai');c.send({type:'fetch',requestId:'paths',url:'vscode://codex/paths-exist',body:JSON.stringify({paths:['${BETTER_CODEX_WORKSPACE}','${BETTER_CODEX_SECONDARY_WORKSPACE}']})});
 const r=await x.until(()=>c.events.find(e=>e.payload?.requestId==='paths'));assert.deepEqual(JSON.parse(r.payload.bodyJsonString).existingPaths,['${BETTER_CODEX_WORKSPACE}']);
 c.send({type:'fetch',requestId:'roots',url:'vscode://codex/workspace-root-options'});const roots=await x.until(()=>c.events.find(e=>e.payload?.requestId==='roots'));assert.deepEqual(JSON.parse(roots.payload.bodyJsonString).roots,['${BETTER_CODEX_WORKSPACE}']);
});

test('official prewarm uses the same native request and response contract as thread start',async t=>{
 const x=await fixture(t),c=await x.client('ai');c.send({type:'thread-prewarm-start',hostId:'local',request:{id:'prewarm-one',method:'thread/start',params:{cwd:'${BETTER_CODEX_WORKSPACE}'}}});
 const r=await x.until(()=>c.events.find(e=>e.payload?.type==='mcp-response'&&e.payload.message?.id==='prewarm-one'));assert.equal(r.payload.message.result.thread.id,ai);assert.equal(x.front.journal.ownsThread('ai',ai),true);
});

test('actual initialization version and connection events precede native state and repeat on view-ready',async t=>{
 const x=await fixture(t);x.front.native.initialization={userAgent:'Codex Desktop/0.153.4 (Mac OS 27.0.0; arm64)'};const c=await x.client('ai');await x.until(()=>c.events.find(e=>e.type==='betterCodex:sync-state'));
 const init=c.events.find(e=>e.payload?.type==='codex-app-server-initialized');assert.equal(init.payload.appServerVersion,'0.153.4');assert(c.events.indexOf(init)<c.events.findIndex(e=>e.type==='betterCodex:sync-state'));c.send({type:'view-ready'});await x.until(()=>c.events.filter(e=>e.payload?.type==='codex-app-server-initialized').length===2);
});
test('maintenance UA advertises its true server version so the renderer selects item pagination',async t=>{
 const x=await fixture(t);x.front.native.initialization={userAgent:'betterCodex_desktop_runtime_maintenance/0.153.4 (Mac OS; probe 1.0.0)'};const c=await x.client('ai');const init=await x.until(()=>c.events.find(e=>e.payload?.type==='codex-app-server-initialized'));assert.equal(init.payload.appServerVersion,'0.153.4');
});
test('official record delta drafts merge, persist and broadcast only in their workspace',async t=>{
 const x=await fixture(t),a=await x.client('ai'),b=await x.client('ai'),z=await x.client('secondary');await x.until(()=>z.events.find(e=>e.type==='betterCodex:sync-state'));
 a.send({type:'persisted-atom-update',key:'composer-prompt-drafts-v2',recordUpdate:{entries:{first:{value:'draft one'}}}});await x.until(()=>b.events.find(e=>e.payload?.key==='composer-prompt-drafts-v2'));
 b.send({type:'persisted-atom-update',key:'composer-prompt-drafts-v2',recordUpdate:{entries:{second:{value:'draft two'}}}});const merged=await x.until(()=>a.events.find(e=>e.payload?.key==='composer-prompt-drafts-v2'&&e.payload.value?.second));assert.deepEqual(merged.payload.value,{first:'draft one',second:'draft two'});assert(!z.events.some(e=>e.payload?.key==='composer-prompt-drafts-v2'));
 a.send({type:'persisted-atom-update',key:'composer-prompt-drafts-v2',recordUpdate:{entries:{first:null}}});await x.until(()=>b.events.find(e=>e.payload?.key==='composer-prompt-drafts-v2'&&e.payload.value?.second&&!e.payload.value.first));
});
test('missing scoped files return a real 404 without crashing the front',async t=>{const x=await fixture(t),binding=await x.session('ai');const r=await fetch(x.base+'/w/ai/api/app-fs/@fs${BETTER_CODEX_WORKSPACE}/.nonexistent-candidate-file',{headers:{...x.headers,'x-betterCodex-scope':binding.token}});assert.equal(r.status,404);assert.equal((await fetch(x.base+'/healthz')).status,200);});
test('OpenCodex ancillary reports acknowledge receipts and expose the actual disabled router state',async t=>{
 const x=await fixture(t),binding=await x.session('ai'),headers={...x.headers,'x-betterCodex-scope':binding.token,'content-type':'application/json'};
 const config=await(await fetch(x.base+'/w/ai/api/opencodex/plugins/config',{headers})).json();assert.equal(config.plugins[0].enabled,false);
 const status=await(await fetch(x.base+'/w/ai/api/opencodex/model-router/injections',{method:'POST',headers,body:JSON.stringify({point:'settings-page',clientId:'test'})})).json();assert.equal(status.status,'disabled');assert.equal(status.enabled,false);assert(status.items.every(i=>i.status==='disabled'));
 const receipt=await(await fetch(x.base+'/w/ai/api/opencodex/runtime-compatibility/reports',{method:'POST',headers,body:JSON.stringify({reports:[{point:{id:'file-picker'}}]})})).json();assert.equal(receipt.received,true);assert.equal(receipt.persisted,false);assert.equal(typeof receipt.reportEpoch,'string');
});
test('reconnected and back-forward cached pages preserve their renderer without a document reload',async()=>{
 const script=await readFile(new URL('../public/official-scope-bootstrap.js',import.meta.url),'utf8');
 for(const scenario of ['reconnect','bfcache']){class Storage{getItem(){return null}setItem(){}removeItem(){}clear(){}}const listeners={};let reloads=0,stopped=0;
 class Socket{constructor(){this.readyState=1;this.listeners={};this.sent=[];}addEventListener(k,f){this.listeners[k]=f;}send(v){this.sent.push(v);}}
 const location={href:'http://127.0.0.1:3095/?workspace=ai',origin:'http://127.0.0.1:3095',reload:()=>reloads++},document={visibilityState:'visible',addEventListener:(k,f)=>listeners[k]=f};
 const context={setTimeout:()=>1,clearTimeout(){},CustomEvent,Storage,localStorage:new Storage(),sessionStorage:new Storage(),crypto:{randomUUID:()=> 'stable'},URL,Headers,Request,MessageEvent,location,document,addEventListener:(k,f)=>listeners[k]=f,window:{__BETTER_CODEX_SCOPE__:{id:'ai',token:'test'},WebSocket:Socket,fetch:async()=>({ok:true,json:async()=>({id:'ai',token:'renewed'})}),dispatchEvent(){}}};vm.runInNewContext(script,context);
 if(scenario==='reconnect'){const first=new context.window.WebSocket('ws://127.0.0.1:3095/w/ai/ws');first.listeners.message({data:JSON.stringify({type:'hello-ack'})});first.listeners.close();document.visibilityState='hidden';const second=new context.window.WebSocket('ws://127.0.0.1:3095/w/ai/ws');second.listeners.message({data:JSON.stringify({type:'hello-ack'}),stopImmediatePropagation:()=>stopped++});assert.equal(stopped,0);assert.equal(reloads,0);document.visibilityState='visible';await listeners.visibilitychange();assert(!second.sent.some(x=>x.includes('turn/start')));}else{context.window.__BETTER_CODEX_RELOADING__=true;await listeners.pageshow({persisted:true});}
 assert.equal(reloads,0);if(scenario==='bfcache')await listeners.pageshow({persisted:true});else await listeners.visibilitychange();assert.equal(reloads,0);
 }
});
test('token details use actual scoped native counters; absent history is null rather than fabricated zero',async t=>{
 const x=await fixture(t),binding=await x.session('ai'),headers={...x.headers,'x-betterCodex-scope':binding.token};x.front.boundary.observe({method:'thread/tokenUsage/updated',params:{threadId:ai,turnId:'usage-turn',tokenUsage:{last:{inputTokens:10,cachedInputTokens:4,outputTokens:2,reasoningOutputTokens:1,totalTokens:12}}}});
 const result=await(await fetch(x.base+'/w/ai/api/token-usage?threadId='+ai+'&turnId=usage-turn',{headers})).json();assert.equal(result.usage.totalTokens,12);assert.equal(result.usage.cachedInputTokens,4);assert.equal(result.source,'native-notification');const missing=await(await fetch(x.base+'/w/ai/api/token-usage?threadId='+ai+'&turnId=missing',{headers})).json();assert.equal(missing.usage,null);
 const other=await x.session('secondary');const denied=await fetch(x.base+'/w/secondary/api/token-usage?threadId='+ai+'&turnId=usage-turn',{headers:{...x.headers,'x-betterCodex-scope':other.token}});assert.equal(denied.status,404);
});
test('preview and download URLs grant only one file and never expose a workspace capability to artifact scripts',async t=>{
 const x=await fixture(t),c=await x.client('ai');await x.until(()=>c.events.find(e=>e.type==='betterCodex:sync-state'));
 const uploadId='file-grant-upload';c.ws.send(JSON.stringify({type:'opencodex:ipc-invoke',requestId:uploadId,request:{channel:'pick-files',args:[{params:{files:[{name:'qa.html',contentsBase64:Buffer.from('<h1>isolated preview</h1>').toString('base64')}]}}]}}));const uploaded=await x.until(()=>c.events.find(e=>e.requestId===uploadId));assert.equal(uploaded.ok,true);const file=uploaded.value.files[0].path,binding=await x.session('ai'),url=x.base+'/w/ai/api/app-fs/@fs/'+file.slice(1)+'?scopeToken='+binding.token;
 const redirect=await fetch(url,{redirect:'manual'});assert.equal(redirect.status,303);const grant=redirect.headers.get('location');assert(!grant.includes('scopeToken'));assert(!grant.includes(binding.token));assert(!grant.includes('/'+'Users'+'/'));
 const view=await fetch(x.base+grant);assert.equal(view.status,200);assert.match(view.headers.get('content-security-policy'),/sandbox allow-scripts/);assert(!view.headers.get('content-security-policy').includes('allow-same-origin'));assert.equal(await view.text(),'<h1>isolated preview</h1>');
 assert.equal((await fetch(x.base+grant.replace('/w/ai/','/w/secondary/'))).status,404);
 const download=await(await fetch(x.base+'/w/ai/api/local-file/download-path',{method:'POST',headers:{'content-type':'application/json','x-betterCodex-scope':binding.token},body:JSON.stringify({path:file})})).json();assert.match((await fetch(x.base+download.url)).headers.get('content-disposition'),/^attachment;/);
});

test('PWA and SSO top-level entries accept opaque origins but cross-site API calls remain forbidden',async t=>{
 const x=await fixture(t);
 const request=(path,headers,method='GET')=>new Promise((resolve,reject)=>{const r=http.request(x.base+path,{method,headers},v=>{let body='';v.on('data',b=>body+=b);v.on('end',()=>resolve({status:v.statusCode,location:v.headers.location,body}));});r.on('error',reject);r.end();});
 const nav={'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document',origin:'null',accept:'text/html'};
 const home=await request('/',{'sec-fetch-site':'cross-site'});assert.equal(home.status,303);assert.equal(home.location,'/?workspace=ai');
 for(const path of ['/ui/official?workspace=ai','/workspaces/secondary','/official/?workspace=ai']){const r=await request(path,nav);assert.equal(r.status,303);assert.match(r.location,/^\/\?workspace=(ai|secondary)$/);}
 assert.equal((await request('/?workspace=ai',nav)).status,200);
 assert.equal((await request('/ui/official?workspace=ai',{origin:'null',accept:'text/html','sec-fetch-site':'cross-site'})).status,303);
 for(const headers of [{origin:'null','sec-fetch-site':'cross-site'},{origin:'null',accept:'*/*','sec-fetch-site':'cross-site'},{...nav,'sec-fetch-dest':'empty'}]){
  assert.equal((await request('/?workspace=ai',headers)).status,200);
  assert.equal((await request('/ui/official?workspace=ai',headers)).status,303);
  assert.equal((await request('/betterCodex-scope-session?workspace=ai',headers)).status,403);
 }
 for(const path of ['/w/ai/api/request','/betterCodex-scope-session?workspace=ai','/codex-web-config.js'])assert.equal((await request(path,nav)).status,403);
 assert.equal((await request('/ui/official?workspace=ai',{...nav,'sec-fetch-mode':'cors','sec-fetch-dest':'empty'})).status,403);
 assert.equal((await request('/ui/official?workspace=ai',nav,'POST')).status,403);
});

test('browser WebSocket negotiates stateless compression and preserves native response bytes',async t=>{
 const x=await fixture(t),binding=await x.session('ai');
 const ws=new WS(x.base.replace('http','ws')+'/w/ai/ws?scopeToken='+binding.token,{headers:x.headers,perMessageDeflate:true});t.after(()=>ws.close());
 const events=[];ws.on('message',b=>events.push(JSON.parse(b)));await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});
 assert.match(ws.extensions,/permessage-deflate/);ws.send(JSON.stringify({type:'hello',clientId:'compression-test'}));
 const snapshot=await x.until(()=>events.find(e=>e.type==='betterCodex:sync-state'));assert.deepEqual(snapshot.activeThreadIds,[ai]);
});


test('native reconnect invokes official websocket recovery and clears stale browser ownership',async t=>{
 const x=await fixture(t),c=await x.client('ai');
 await x.until(()=>c.events.find(e=>e.type==='betterCodex:sync-state'));
 const before=c.events.filter(e=>e.payload?.type==='codex-app-server-initialized');
 assert.equal(before[0].payload.isSnapshot,true);
 x.native.state='disconnected';x.native.emit('interrupted');
 const disconnected=await x.until(()=>c.events.find(e=>e.payload?.type==='codex-app-server-connection-changed'&&e.payload.state==='disconnected'));
 assert.equal(disconnected.payload.transport,'websocket');assert.equal(disconnected.payload.isSnapshot,false);
 x.native.state='ready';x.native.emit('ready',{generation:2});
 const connected=await x.until(()=>c.events.find(e=>e.payload?.type==='codex-app-server-connection-changed'&&e.payload.state==='connected'&&e.payload.isSnapshot===false));
 assert.equal(connected.payload.transport,'websocket');
 assert(c.events.some(e=>e.payload?.type==='codex-app-server-initialized'&&e.payload.isSnapshot===false));
});

test('same CapnWeb objects work after socket loss and duplicate transport cannot steer twice',async t=>{
 const x=await fixture(t),binding=await x.session('ai');
 const {RpcSession,RpcTarget}=await import('${BETTER_CODEX_HOME}/.better-codex/official-runtime-20260908/adapter-deps/node_modules/capnweb/dist/index.js');
 const codec=require('./web-shell/codex-app-host-message-codec.js');
 let socket,resumeId,seq=0,received=0,steers=0;const messages=[],frames=[],waiters=[];
 const original=x.native.rpc;x.native.rpc=async(method,p)=>{if(method==='turn/steer'){steers++;await new Promise(r=>setTimeout(r,40));return {turnId:'active-turn'};}return original(method,p);};
 function send(message){const data={...message,betterCodexClientSeq:++seq};socket.send(JSON.stringify(data));return data;}
 async function connect(){
  socket=new WS(x.base.replace('http','ws')+'/w/ai/ws?scopeToken='+binding.token,{headers:x.headers});
  socket.on('message',raw=>{const m=JSON.parse(raw);messages.push(m);if(m.type==='hello-ack')resumeId=m.betterCodexResumeId;
   if(m.betterCodexPageSeq){if(m.betterCodexPageSeq<=received)return;assert.equal(m.betterCodexPageSeq,received+1);received=m.betterCodexPageSeq;socket.send(JSON.stringify({type:'betterCodex:ack',seq:received}));}
   if(m.type==='app-host-port-message'){const raw=JSON.stringify(codec.decodeMessageData(m));if(waiters.length)waiters.shift()(raw);else frames.push(raw);}
  });
  await new Promise((r,j)=>{socket.once('open',r);socket.once('error',j);});const before=messages.length;
  socket.send(JSON.stringify({type:'hello',clientId:'stable-renderer',betterCodexClientId:'stable-tab',betterCodexProtocol:'betterCodex-page-resume-v1',betterCodexResumeId:resumeId,betterCodexAck:received}));
  await x.until(()=>messages.slice(before).find(m=>m.type==='hello-ack'));send({type:'app-host-connect',portId:'same-port'});
 }
 await connect();
 class Coordination extends RpcTarget{clientStatusChanged(){}}
 class Browser extends RpcTarget{get services(){return {clientCoordination:new Coordination()};}}
 const rpc=new RpcSession({send:async raw=>send({type:'app-host-port-message',portId:'same-port',...codec.encodeMessageData(JSON.parse(raw))}),receive:()=>frames.length?Promise.resolve(frames.shift()):new Promise(r=>waiters.push(r)),abort(){}},new Browser());
 t.after(()=>{rpc.getRemoteMain()[Symbol.dispose]();socket.close();});
 const services=await rpc.getRemoteMain().services;
 await services.settings.write('followUpQueueMode','queue');assert.equal((await services.settings.read('followUpQueueMode')).effective,'queue');
 const steer=send({type:'opencodex:ipc-invoke',requestId:'steer-ipc',request:{channel:'codex_desktop:message-from-view',args:[{type:'mcp-request',hostId:'local',request:{id:'steer-once',method:'turn/steer',params:{threadId:ai,expectedTurnId:'active-turn',input:[{type:'text',text:'isolated protocol fixture'}]}}}]}});
 await x.until(()=>steers===1);const first=socket;first.terminate();await new Promise(r=>first.once('close',r));await new Promise(r=>setTimeout(r,60));
 await connect();socket.send(JSON.stringify(steer));
 assert(messages.some(m=>m.type==='hello-ack'&&m.betterCodexResumed===true));
 assert.equal((await services.settings.read('followUpQueueMode')).effective,'queue');await services.settings.write('followUpQueueMode','steer');
 assert.equal((await services.settings.read('followUpQueueMode')).effective,'steer');
 await x.until(()=>messages.find(m=>m.payload?.message?.id==='steer-once'));assert.equal(steers,1);
 assert(messages.some(m=>m.payload?.type==='codex-app-server-connection-changed'&&m.payload.isSnapshot===false));
});

test('synchronous bootstrap reads work before a WebSocket exists, while operations still require it',async t=>{const x=await fixture(t),binding=await x.session('ai'),headers={...x.headers,'x-betterCodex-scope':binding.token,'content-type':'application/json'};const invoke=channel=>fetch(x.base+'/w/ai/api/ipc/invoke',{method:'POST',headers,body:JSON.stringify({channel,args:[],clientId:'not-connected-yet'})});const bootstrap=await invoke('codex_desktop:get-initial-sidebar-bootstrap');assert.equal(bootstrap.status,200);const data=await bootstrap.json();assert.deepEqual(data.value.globalStateEntries.find(x=>x.key==='pending_worktrees').value,[]);assert(!JSON.stringify(data).includes('${BETTER_CODEX_SECONDARY_WORKSPACE}'));assert.equal((await invoke('codex_desktop:get-shared-object-snapshot')).status,200);assert.equal((await invoke('codex_desktop:message-from-view')).status,409);assert.equal((await invoke('pick-files')).status,409);});

test('project page and its read API preserve scope and omit retired projects',async t=>{
 const x=await fixture(t),page=await fetch(x.base+'/projects?workspace=ai',{headers:x.headers});assert.equal(page.status,200);assert.match(await page.text(),/项目工作台/);
 const a=await x.session('ai'),z=await x.session('secondary');
 const read=async(scope,token,suffix='')=>fetch(x.base+'/w/'+scope+'/api/projects'+suffix,{headers:{...x.headers,'x-betterCodex-scope':token}});
 assert.equal((await read('secondary',a.token)).status,403);
 const aiProjects=await (await read('ai',a.token)).json();assert(!aiProjects.projects.some(p=>p.id==='secondary-project'||p.lifecycle==='retired'||p.lifecycle==='archived'));
 const invest=await (await read('ai',a.token,'/invest')).json();assert(!invest.actions.some(action=>action.state==='archived'));
 const secondaryProjects=await (await read('secondary',z.token)).json();assert.deepEqual(secondaryProjects.projects.map(p=>p.id),['secondary-project']);
 assert.equal((await read('ai',a.token,'/secondary-project')).status,404);
});

import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
import {env as diagnosticFixture} from '../../../../scripts/lib/client-diagnostics-fixture.mjs';
const sourceScript=await readFile(process.env.DSH_RECOVERY_SOURCE||new URL('../public/official-scope-bootstrap.js',import.meta.url),'utf8');
const bundle=process.env.DSH_RECOVERY_SCOPE_BUNDLE?await readFile(process.env.DSH_RECOVERY_SCOPE_BUNDLE,'utf8'):null;
const marker=sourceScript.split('\n')[0];
if(bundle&&bundle.split(sourceScript.trim()).length!==2)throw Error('Final scope bundle lacks the exact recovery component');
const script=sourceScript;
const loader=await readFile(process.env.DSH_LOADER_TEST_SOURCE||new URL('../public/native-loader.js',import.meta.url),'utf8');
function fixture(fetchImpl,{beforeScope,storage}={}){
 class Storage{constructor(){this.values=new Map()}get length(){return this.values.size}key(i){return [...this.values.keys()][i]??null}getItem(k){return this.values.get(k)||null}setItem(k,v){this.values.set(k,v)}removeItem(k){this.values.delete(k)}clear(){this.values.clear()}}
 const listeners={},timers=new Map(),events=[],sockets=[],connectionEvents=[],controllers=[];let timerId=0,reloads=0,ids=0,now=Date.now();
 class AbortController{constructor(){this.signal={aborted:false};controllers.push(this)}abort(){this.signal.aborted=true}}
 class Socket{constructor(url){this.url=url;this.readyState=1;this.bufferedAmount=0;this.listeners={};this.sent=[];sockets.push(this)}addEventListener(k,fn){(this.listeners[k]??=[]).push(fn)}send(raw){this.sent.push(JSON.parse(raw))}close(code=1000,reason=''){this.readyState=3;this.emit('close',{code,reason,wasClean:code===1000})}emit(type,p){const event={...p,stopped:false,stopImmediatePropagation(){this.stopped=true}};for(const fn of this.listeners[type]||[]){fn(event);if(event.stopped)break;}}}
 const registered=new Map(),intervals=new Map();const listen=(k,f)=>{const list=registered.get(k)||[];list.push(f);registered.set(k,list);listeners[k]=(...args)=>{const results=list.map(fn=>fn(...args));return results.some(x=>x?.then)?Promise.all(results):results.at(-1)}};
 const document={visibilityState:'visible',addEventListener:listen};
 const location={href:'https://workbench.example.test/',origin:'https://workbench.example.test',pathname:'/',reload(){reloads++},replace(){reloads++}};
 const context={Date:class extends Date{static now(){return now;}},performance,navigator:{onLine:true},AbortController,Storage,localStorage:new Storage(),sessionStorage:new Storage(),URL,Headers,Request,MessageEvent,CustomEvent,Event,location,document,crypto:{randomUUID:()=>'00000000-0000-4000-8000-'+String(++ids).padStart(12,'0')},setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id},clearTimeout(id){timers.delete(id)},clearInterval(id){intervals.delete(id)},setInterval(fn,ms){const id=++timerId;intervals.set(id,{fn,ms});return id},addEventListener:listen};
 context.window={__DSH_CLIENT_LOG__:{event:(kind,e)=>connectionEvents.push({kind,...e}),identity:()=>({pageId:"abcd1234",uiVersion:"1234567890abcdef"})},WebSocket:Socket,__DSH_SCOPE__:{id:'ai',token:'scope'},fetch:fetchImpl||(async()=>({ok:true,json:async()=>({id:'ai',token:'renewed'})})),dispatchEvent:event=>{events.push(event);listeners[event.type]?.(event);}};
 if(storage)context.localStorage.values=storage;
 beforeScope?.(context);
 vm.runInNewContext(script,context);
 const create=()=>{const socket=new context.window.WebSocket('wss://workbench.example.test/w/ai/ws');socket.send(JSON.stringify({type:'hello',clientId:'native-renderer'}));return socket;};
 const message=(socket,m)=>socket.emit('message',{data:JSON.stringify(m)});
 const hello=(socket,{resumed=false,received=0}={})=>message(socket,{type:'hello-ack',clientId:'native-renderer',dshProtocol:'dsh-page-resume-v1',dshResumeId:'same-session',dshResumed:resumed,dshReceivedSeq:received});
 return {context,document,listeners,timers,events,sockets,connectionEvents,controllers,create,message,hello,advance:ms=>{now+=ms;},get reloads(){return reloads}};
}
test('successful wire records the live connection and prior unacknowledged frames',()=>{
 const receipts=[],x=fixture(undefined,{beforeScope(c){c.window.__DSH_CLIENT_LOG__.wire=(payload,fields,clock)=>receipts.push({payload,fields,clock});}}),socket=x.create();x.hello(socket);
 x.message(socket,{payload:{type:'codex-app-server-connection-changed',state:'connected'}});
 const ping=socket.sent.findLast(m=>m.type==='dsh:ping');if(ping)x.message(socket,{type:'dsh:pong',nonce:ping.nonce});
 x.advance(120);socket.bufferedAmount=2048;
 const frame=id=>JSON.stringify({type:'opencodex:ipc-invoke',request:{args:[{request:{id,method:'turn/start',params:{private:'not-log-metadata'}}}]}});
 socket.send(frame('first'));socket.send(frame('second'));
 assert.equal(receipts.length,2);assert.equal(receipts[0].fields.count,0);assert.equal(receipts[1].fields.count,1);
 for(const {fields,clock}of receipts){assert.equal(fields.socketState,1);assert.equal(fields.bufferedBytes,2048);assert.equal(fields.handshakeComplete,true);assert.equal(fields.transportConnected,true);assert.equal(fields.nativeOnline,true);assert.equal(fields.lastMessageAgeMs,120);assert(Number.isFinite(clock.at));assert(Number.isFinite(clock.mono));assert(!JSON.stringify(fields).includes('not-log-metadata'));}
});
test('a failed diagnostic sink cannot turn successful sending into failure or lose resume tracking',()=>{
 const x=fixture(undefined,{beforeScope(c){c.window.__DSH_CLIENT_LOG__.wire=()=>{throw Error('diagnostic sink unavailable');};}}),old=x.create();x.hello(old);
 assert.doesNotThrow(()=>old.send(JSON.stringify({type:'opencodex:ipc-invoke',requestId:'tracked-despite-diagnostic-failure'})));
 assert.equal(old.sent.at(-1).dshClientSeq,1);old.close(1006);const next=x.create();x.hello(next,{resumed:true,received:0});
 const replay=next.sent.filter(m=>m.requestId==='tracked-despite-diagnostic-failure');assert.equal(replay.length,1);assert.equal(replay[0].dshClientSeq,1);
});
test('real wire logger persists and uploads the connection snapshot without request content',async()=>{
 const log=diagnosticFixture(),x=fixture(undefined,{beforeScope(c){c.window.__DSH_CLIENT_LOG__=log.log;}}),socket=x.create();x.hello(socket);x.message(socket,{payload:{type:'codex-app-server-connection-changed',state:'connected'}});
 const p={type:'mcp-request',request:{id:'wire-test',method:'turn/start',params:{threadId:'11111111-1111-4111-8111-111111111111',clientUserMessageId:'22222222-2222-4222-8222-222222222222',input:[{text:'PRIVATE_WIRE_INPUT'}]}}};
 log.log.ipc('invoke',p);socket.send(JSON.stringify({type:'opencodex:ipc-invoke',request:{args:[p]}}));
 const receipt=log.log.snapshot().events.find(e=>e.kind==='rpc'&&e.stage==='dispatch');assert(receipt);assert.equal(receipt.handshakeComplete,true);assert.equal(receipt.nativeOnline,true);assert.equal(receipt.socketState,1);assert.equal(receipt.transportConnected,true);assert.equal(receipt.count,0);assert.equal(receipt.bufferedBytes,0);assert.equal(receipt.lastMessageAgeMs,0);
 assert(!JSON.stringify(log.log.snapshot()).includes('PRIVATE_WIRE_INPUT'));const reopened=diagnosticFixture({storage:log.storage,online:true});assert(reopened.log.snapshot().events.some(e=>e.eventId===receipt.eventId));await reopened.log.flush();assert(reopened.uploads.flatMap(x=>x.events).some(e=>e.eventId===receipt.eventId&&e.handshakeComplete===true&&e.count===0));
});
function loaderFixture(fetchImpl){
 const x=fixture(fetchImpl),root={textContent:''},loaded=[],cache={prepareSidebarBootstrap:async config=>config,restoreAtoms:async()=>({}),meta:async key=>key==='auth-locked'?false:null,saveMeta:async()=>{}};
 x.context.structuredClone=structuredClone;x.context.matchMedia=()=>({matches:false});x.context.history={state:{},replaceState(){}};x.context.document.documentElement={dataset:{}};x.context.document.getElementById=()=>root;x.context.document.querySelector=()=>null;x.context.document.createElement=()=>({setAttribute(){},addEventListener(){},append(){},remove(){}});x.context.document.head={append(element){loaded.push(element.src||element.name||'');if(typeof element.onload==='function')queueMicrotask(()=>element.onload());}};x.context.window.__DSH_NATIVE_CACHE__=cache;x.context.window.__DSH_THEME_COLOR__={};
 vm.runInNewContext(loader.replace('__DSH_NATIVE_RELEASE__',JSON.stringify({shell:'/shell.html',scope:'/scope.js',runtime:'/runtime.js',pwa:'/pwa.js',entry:'/entry.js'})),x.context);return {...x,root,loaded,cache};
}
test('foreground recovery requests native catch-up without replacing page or resending an accepted prompt',async()=>{
 const x=fixture(),first=x.create();x.hello(first);
 first.send(JSON.stringify({type:'opencodex:ipc-invoke',requestId:'prompt',request:{channel:'codex_desktop:message-from-view',args:[{request:{id:5,method:'turn/steer'}}]}}));
 x.message(first,{type:'dsh:ack',seq:1});x.document.visibilityState='hidden';await x.listeners.visibilitychange();first.close();
 x.document.visibilityState='visible';const next=x.create();assert.equal(next.sent[0].dshResumeId,'same-session');x.hello(next,{resumed:true,received:1});await x.listeners.visibilitychange();
 assert.equal(next.sent.some(m=>m.requestId==='prompt'),false);assert(next.sent.some(m=>m.type==='dsh:sync'&&m.recoverConversation));assert.equal(x.reloads,0);
});
test('missed outgoing transport is sent only to the same retained session; incoming duplicate is suppressed',()=>{
 const x=fixture(),first=x.create();x.hello(first);first.send(JSON.stringify({type:'app-host-port-message',portId:'original',data:['native-rpc']}));first.close();
 const next=x.create();x.hello(next,{resumed:true,received:0});assert.equal(next.sent.filter(m=>m.dshClientSeq===1).length,1);
 let received=0;next.addEventListener('message',()=>received++);x.message(next,{type:'app-host-port-message',data:'same',dshPageSeq:1});x.message(next,{type:'app-host-port-message',data:'same',dshPageSeq:1});assert.equal(received,1);assert.equal(x.reloads,0);
});
test('silent OPEN socket is replaced after foreground probe, without a document reload',async()=>{
 const x=fixture(),socket=x.create();x.hello(socket);const probe=[...x.timers.values()].find(t=>t.ms===8000);assert(probe);probe.fn();assert.equal(socket.readyState,3);assert.equal(x.reloads,0);
});
test('heartbeat retirement starts reconnect before delayed close and old close cannot retire a new ready socket',()=>{
 const x=fixture(),old=x.create();x.hello(old);x.message(old,{payload:{type:'codex-app-server-connection-changed',state:'connected'}});
 old.close=function(code,reason){this.readyState=2;this.closing={code,reason};};let attempts=0;x.context.window.__DSH_RECONNECT_TRANSPORT__=()=>attempts++;
 const probe=[...x.timers.values()].find(t=>t.ms===8000);assert(probe);probe.fn();assert.equal(old.readyState,2);assert.equal(attempts,1);assert.equal(x.context.window.__DSH_EXECUTION_CONNECTED__,false);
 const next=x.create();x.hello(next,{resumed:true});x.message(next,{payload:{type:'codex-app-server-connection-changed',state:'connected'}});assert.equal(x.context.window.__DSH_EXECUTION_CONNECTED__,true);
 const lifetimes=x.events.filter(e=>e.type==='dsh:execution-state').length;old.readyState=3;old.emit('close',{...old.closing,wasClean:false});assert.equal(x.context.window.__DSH_EXECUTION_CONNECTED__,true);assert.equal(x.events.filter(e=>e.type==='dsh:execution-state').length,lifetimes);assert.equal(x.reloads,0);
});
test('duplicate Native-ready snapshots preserve reads but an actual Native generation change retires them',()=>{
 const x=fixture(),socket=x.create();x.hello(socket);const ready=generation=>x.message(socket,{dshEpoch:'same-front',payload:{type:'codex-app-server-connection-changed',state:'connected',dshNativeGeneration:generation}});ready(7);
 const count=()=>x.events.filter(event=>event.type==='dsh:execution-state').length,before=count();ready(7);ready(7);assert.equal(count(),before,'same readiness snapshot cannot cancel a live send');ready(8);assert.equal(count(),before+1,'new Native generation must invalidate old execution authority');assert.equal(x.context.window.__DSH_EXECUTION_CONNECTED__,true);
});
test('a live pong avoids replacement; bfcache return asks for current state in place',async()=>{
 const x=fixture(),socket=x.create();x.hello(socket);const ping=socket.sent.find(m=>m.type==='dsh:ping');x.message(socket,{type:'dsh:pong',nonce:ping.nonce});assert.equal([...x.timers.values()].some(t=>t.ms===8000),false);
 await x.listeners.pageshow({persisted:true});assert(socket.sent.some(m=>m.type==='dsh:sync'&&m.recoverConversation));assert.equal(x.reloads,0);
});
test('server session loss rebuilds native AppHost only and never replays old messages to a fresh session',async()=>{
 const x=fixture(),first=x.create();x.hello(first);first.send(JSON.stringify({type:'opencodex:ipc-invoke',requestId:'old-prompt'}));let resetPorts=0,recreated=0,next;
 x.context.window.__DSH_RESET_BROWSER_PORTS__=()=>resetPorts++;
 x.context.window.__DSH_RECREATE_APP_HOST__=async()=>{recreated++;next=x.create();x.hello(next);};
 x.message(first,{type:'dsh:resume-unavailable'});for(let i=0;i<12;i++)await Promise.resolve();
 assert.equal(resetPorts,1);assert.equal(recreated,1);assert.equal(next.sent[0].dshResumeId,undefined);assert.equal(next.sent.some(m=>m.requestId==='old-prompt'),false);assert.equal(x.reloads,0);
});

test('a retired socket response cannot reach a new same-id IPC reader after AppHost replacement',async()=>{
 const received=[],x=fixture(undefined,{beforeScope(context){context.window.__DSH_CLIENT_LOG__.response=()=>{};context.window.__DSH_IPC_CACHE_RESPONSE__=payload=>{if(payload?.type==='mcp-response')received.push(payload.message.result);};}}),old=x.create();x.hello(old);
 let current;x.context.window.__DSH_RESET_BROWSER_PORTS__=()=>{};x.context.window.__DSH_RECREATE_APP_HOST__=async()=>{current=x.create();x.hello(current);};
 x.message(old,{type:'dsh:resume-unavailable'});for(let i=0;i<12;i++)await Promise.resolve();assert(current);
 const frame=result=>({channel:'codex_desktop:message-for-view',payload:{type:'mcp-response',message:{id:'same-id',result}},dshPageSeq:1});
 x.message(old,frame('old'));assert.equal(received.length,0,'old wire is rejected before cache fanout');x.message(current,frame('fresh'));assert.deepEqual(received,['fresh']);
});

test('frame timing observes parse and cache boundaries without changing official event delivery',()=>{
 const phases=[],x=fixture(undefined,{beforeScope(context){context.window.__DSH_CLIENT_LOG__.response=()=>{};context.window.__DSH_CLIENT_LOG__.beginReceivedFrame=(raw,value,clock)=>{assert.equal(JSON.parse(raw).dshPageSeq,value.dshPageSeq);assert(Number.isFinite(clock.receivedMono));phases.push('parsed');return()=>phases.push('cache-returned');};context.window.__DSH_IPC_CACHE_RESPONSE__=()=>{phases.push('cache');};}}),socket=x.create();x.hello(socket);phases.length=0;
 const frame={channel:'codex_desktop:message-for-view',dshPageSeq:1,payload:{type:'mcp-response',message:{id:'fixture',result:{data:[]}}}},raw=JSON.stringify(frame);
 socket.addEventListener('message',event=>{assert.equal(event.data,raw);phases.push('official-listener');});x.message(socket,frame);assert.deepEqual(phases,['parsed','cache','cache-returned','official-listener']);
});

test('expired page scope renews a read in place instead of treating it as an expired SSO login',async()=>{
 const calls=[];let reads=0;const x=fixture(async(input,init)=>{calls.push({input:String(input),token:init.headers?.get?.('x-dsh-scope')});if(String(input).startsWith('/dsh-scope-session'))return {ok:true,status:200,json:async()=>({id:'ai',token:'fresh'})};return {status:++reads===1?401:200};});
 const response=await x.context.window.fetch('/w/ai/api/diagnostics');assert.equal(response.status,200);assert.equal(reads,2);assert.equal(calls.at(-1).token,'fresh');assert(x.events.some(e=>e.type==='dsh:scope-renewed'));assert.equal(x.reloads,0);
});
test('scope renewal never automatically repeats a mutation',async()=>{
 let writes=0;const x=fixture(async(input)=>{if(String(input).startsWith('/dsh-scope-session'))return {ok:true,status:200,json:async()=>({id:'ai',token:'fresh'})};writes++;return {status:401};});
 const response=await x.context.window.fetch('/w/ai/api/request',{method:'POST',body:'{}'});assert.equal(response.status,401);assert.equal(writes,1);assert.equal(x.reloads,0);
});
test('scope renewal fetch timeout aborts once and returns the original protected response',async()=>{
 let x;const fetchImpl=async input=>String(input).startsWith('/dsh-scope-session')?new Promise(()=>{}):{status:401};x=fixture(fetchImpl);
 const request=x.context.window.fetch('/w/ai/api/diagnostics');for(let i=0;i<4;i++)await Promise.resolve();const deadline=[...x.timers.values()].find(t=>t.ms===15000);assert(deadline);deadline.fn();const response=await request;
 assert.equal(response.status,401);assert.equal(x.controllers.length,1);assert.equal(x.controllers[0].signal.aborted,true);assert(x.connectionEvents.some(e=>e.component==='scope-session'&&e.stage==='failed'&&e.reason==='scope_renewal_failed'&&e.failureClass==='timeout'));
});
test('scope renewal body timeout is bounded even when response.json never settles',async()=>{
 let bodyCalls=0;const x=fixture(async input=>String(input).startsWith('/dsh-scope-session')?{ok:true,status:200,json:()=>{bodyCalls++;return new Promise(()=>{})}}:{status:401});
 const request=x.context.window.fetch('/w/ai/api/diagnostics');for(let i=0;i<4;i++)await Promise.resolve();const deadline=[...x.timers.values()].find(t=>t.ms===15000);assert(deadline);deadline.fn();const response=await request;
 assert.equal(response.status,401);assert.equal(bodyCalls,1);assert.equal(x.controllers[0].signal.aborted,true);assert(x.connectionEvents.some(e=>e.component==='scope-session'&&e.stage==='failed'&&e.reason==='scope_renewal_failed'&&e.failureClass==='timeout'));
});
test('finite scope renewal failure keeps recovery paused and does not recreate the host',async()=>{
 const x=fixture(async input=>String(input).startsWith('/dsh-scope-session')?{ok:false,status:503}:{ok:true,status:200});let reset=0,recreated=0,reconnect=0;
 x.context.window.__DSH_RESET_BROWSER_PORTS__=()=>reset++;x.context.window.__DSH_RECREATE_APP_HOST__=async()=>recreated++;x.context.window.__DSH_RECONNECT_TRANSPORT__=()=>reconnect++;
 const socket=x.create();x.hello(socket);x.message(socket,{type:'dsh:resume-unavailable'});for(let i=0;i<12;i++)await Promise.resolve();
 assert.equal(reset,1);assert.equal(recreated,0);assert.equal(reconnect,0);assert.equal(x.context.window.__DSH_CONNECTION_PAUSED__,true);assert.equal(socket.readyState,3);
});
test('foreground recover intent survives an in-flight normal sync',async()=>{
 let resolveRenew;const x=fixture(async input=>String(input).startsWith('/dsh-scope-session')?new Promise(resolve=>{resolveRenew=()=>resolve({ok:true,status:200,json:async()=>({id:'ai',token:'fresh'})})}):{ok:true,status:200});
 const socket=x.create();x.hello(socket);x.listeners.visibilitychange();x.document.visibilityState='hidden';x.listeners.visibilitychange();x.document.visibilityState='visible';const recovery=x.listeners.visibilitychange();
 assert.deepEqual(socket.sent.filter(m=>m.type==='dsh:sync').map(m=>!!m.recoverConversation),[false]);resolveRenew();await recovery;
 assert.deepEqual(socket.sent.filter(m=>m.type==='dsh:sync').map(m=>!!m.recoverConversation),[false,true]);
});

test('SSO redirects during recovery preserve the document and draft until an explicit login click',async()=>{
 const x=fixture(async()=>({type:'opaqueredirect',status:0})),nodes=[];
 x.context.sessionStorage.setItem('qa-draft','未发送草稿');
 x.document.createElement=tag=>{const node={tag,dataset:{},events:{},setAttribute(){},addEventListener:(k,fn)=>node.events[k]=fn,append(){},remove(){}};nodes.push(node);return node;};x.document.body={append(){}};
 await x.context.window.fetch('/w/ai/api/diagnostics');assert.equal(x.reloads,0);assert.equal(x.context.sessionStorage.getItem('qa-draft'),'未发送草稿');assert.equal(x.context.window.__DSH_CONNECTION_PAUSED__,true);
 const banner=[...x.timers.values()].find(t=>t.ms===400);assert(banner);banner.fn();const login=nodes.find(n=>n.tag==='button');assert.equal(login.textContent,'重新登录');assert.equal(x.reloads,0);login.events.click();assert.equal(x.reloads,1);
});

test('background and frozen-page timers cannot close a healthy socket on foreground return',async()=>{const x=fixture(),socket=x.create();x.hello(socket);const oldProbe=[...x.timers.values()].find(t=>t.ms===8000);assert(oldProbe);x.document.visibilityState='hidden';await x.listeners.visibilitychange();assert.equal([...x.timers.values()].some(t=>t.ms===8000),false);x.document.visibilityState='visible';oldProbe.fn();assert.equal(socket.readyState,1);await x.listeners.visibilitychange();const ping=socket.sent.filter(m=>m.type==='dsh:ping').at(-1);x.message(socket,{type:'dsh:pong',nonce:ping.nonce});assert.equal(socket.readyState,1);x.listeners.freeze();assert.equal([...x.timers.values()].some(t=>t.ms===8000),false);});
test('closing an older socket cannot mark a replacement native connection offline',()=>{
 const x=fixture(),first=x.create();x.hello(first);x.message(first,{payload:{type:'codex-app-server-connection-changed',state:'connected'}});
 const next=x.create();x.hello(next,{resumed:true});x.message(next,{payload:{type:'codex-app-server-connection-changed',state:'connected'}});
 first.close();assert.equal(x.context.window.__DSH_EXECUTION_CONNECTED__,true);
 next.close();assert.equal(x.context.window.__DSH_EXECUTION_CONNECTED__,false);assert.equal(x.reloads,0);
});

test('OPEN without hello closes once, requests bounded transport recovery, and ignores a stale timer',()=>{
 const x=fixture(),socket=x.create();let reconnects=0;x.context.window.__DSH_RECONNECT_TRANSPORT__=()=>reconnects++;
 socket.emit('open',{});const observation=[...x.timers.values()].find(t=>t.ms===15000);assert(observation);observation.fn();
 assert.equal(socket.readyState,3);assert.equal(reconnects,1);assert.equal([...x.timers.values()].some(t=>t.ms===8000),false);
 const pending=x.connectionEvents.find(e=>e.stage==='pending');assert.equal(pending.handshakeComplete,false);assert.equal(new URL(socket.url).searchParams.get('dshDiag'),pending.connectionId);
 assert(x.connectionEvents.some(e=>e.stage==='failed'&&e.reason==='timeout'&&e.connectionId===pending.connectionId));assert.equal(socket.sent.length,1);assert.equal(socket.sent[0].type,'hello');
 const next=x.create();x.hello(next);observation.fn();assert.equal(next.readyState,1);assert.equal(reconnects,1);
});
test('handshake deadline pauses while hidden or frozen and stale timers cannot close the foreground socket',async()=>{
 const x=fixture(),socket=x.create();const initial=[...x.timers.values()].find(t=>t.ms===15000);assert(initial);
 x.document.visibilityState='hidden';await x.listeners.visibilitychange();assert.equal(socket.readyState,1);assert.equal([...x.timers.values()].some(t=>t.ms===15000),false);
 initial.fn();assert.equal(socket.readyState,1);
 x.document.visibilityState='visible';await x.listeners.visibilitychange();const foreground=[...x.timers.values()].find(t=>t.ms===15000);assert(foreground);initial.fn();assert.equal(socket.readyState,1);
 x.listeners.freeze();foreground.fn();assert.equal(socket.readyState,1);await x.listeners.pageshow({persisted:true});const resumed=[...x.timers.values()].find(t=>t.ms===15000);assert(resumed);foreground.fn();assert.equal(socket.readyState,1);
 resumed.fn();assert.equal(socket.readyState,3);
});
test('loader session-ready recreates the AppHost destroyed before a failed renewal',async()=>{
 let scopeCalls=0;const x=loaderFixture(async input=>{const url=String(input);if(url.startsWith('/dsh-scope-session')){scopeCalls++;if(scopeCalls===2)return {ok:false,status:503};return {ok:true,status:200,json:async()=>({id:'ai',token:'fresh-'+scopeCalls})};}return {ok:true,status:200,json:async()=>({nativeBootstrap:true})};});
 await x.context.window.__DSH_SESSION_READY__;for(let i=0;i<30;i++)await Promise.resolve();let reconnects=0,recreated=0;const order=[];x.context.window.__DSH_RESET_BROWSER_PORTS__=()=>{};x.context.window.__DSH_RECREATE_APP_HOST__=async()=>{recreated++;order.push('recreated');};x.context.window.__DSH_RECONNECT_TRANSPORT__=()=>{reconnects++;order.push('reconnect');};const socket=x.create();x.hello(socket);x.message(socket,{type:'dsh:resume-unavailable'});for(let i=0;i<20;i++)await Promise.resolve();assert.equal(x.context.window.__DSH_CONNECTION_PAUSED__,true);assert.throws(()=>socket.send(JSON.stringify({type:'opencodex:ipc-invoke',requestId:'blocked-mutation'})),/旧连接已替换/);
 x.context.addEventListener('dsh:session-ready',()=>order.push('session-ready'));x.listeners.focus();for(let i=0;i<30;i++)await Promise.resolve();assert.equal(x.context.window.__DSH_CONNECTION_PAUSED__,false);assert.equal(recreated,1,'a connected socket cannot replace the disposed AppHost');assert.deepEqual(order,['reconnect','recreated']);assert.equal(reconnects,1);assert.equal(socket.readyState,3);assert.equal(x.reloads,0);
});
test('loader session-ready recovery remains blocked after login is required',async()=>{
 let loginEndpoint401=false,scopeCalls=0;const x=loaderFixture(async input=>{const url=String(input);if(url.startsWith('/dsh-scope-session')){scopeCalls++;if(loginEndpoint401)return {ok:false,status:401};return {ok:true,status:200,json:async()=>({id:'ai',token:'fresh-'+scopeCalls})};}return {ok:true,status:200,json:async()=>({nativeBootstrap:true})};});
 await x.context.window.__DSH_SESSION_READY__;await new Promise(setImmediate);let reconnects=0;x.context.window.__DSH_RECONNECT_TRANSPORT__=()=>{reconnects++;};loginEndpoint401=true;assert.equal(await x.context.window.__DSH_RENEW_SCOPE__(),false);assert.equal(x.context.window.__DSH_CONNECTION_PAUSED__,true);loginEndpoint401=false;const order=[];x.context.addEventListener('dsh:session-ready',()=>order.push('session-ready'));x.listeners.focus();for(let i=0;i<30;i++)await Promise.resolve();assert.deepEqual(order,[]);assert.equal(reconnects,0);assert.equal(x.context.window.__DSH_CONNECTION_PAUSED__,true);
});
test('connection close and scope renewal failures preserve precise stages without raw URLs or errors',async()=>{
 const x=fixture(async()=>({ok:false,status:503})),socket=x.create();socket.emit('close',{code:1006,wasClean:false});
 for(let i=0;i<10;i++)await Promise.resolve();
 assert(x.connectionEvents.some(e=>e.stage==='closed'&&e.closeCode===1006&&e.wasClean===false));
 assert(x.connectionEvents.some(e=>e.component==='scope-session'&&e.statusCode===503&&e.reason==='scope_renewal_failed'));
 assert(!JSON.stringify(x.connectionEvents).includes('scopeToken'));
});

test('resumed renderer clears recovery only after current history adoption and native readiness',()=>{
 const x=fixture(),id='01a06345-b705-7e80-8e30-25572df87241';x.context.location.pathname='/local/'+id;
 const first=x.create();x.hello(first);first.close();const next=x.create();x.hello(next,{resumed:true});
 const state=()=>x.events.filter(e=>e.type==='dsh:connection-state').at(-1).detail.state;
 assert.equal(state(),'syncing');
 const ready=threadId=>x.context.window.dispatchEvent(new CustomEvent('dsh:history-synchronized',{detail:{threadId}}));
 ready(id);assert.equal(state(),'syncing');
 x.message(next,{payload:{type:'codex-app-server-connection-changed',state:'connected'}});assert.equal(state(),'syncing');
 ready('other');assert.equal(state(),'syncing');ready(id);assert.equal(state(),'connected');
 const count=x.events.length;ready(id);assert.equal(x.events.length,count+1,'repeated adoption must not trigger a refresh loop');
 next.close();ready(id);assert.equal(state(),'reconnecting');
});
test('replayed presentation routes are acknowledged without changing the official route or composer',()=>{
 const x=fixture(),socket=x.create();x.hello(socket);
 const current='/local/22222222-2222-4222-a222-222222222222';x.context.location.pathname=current;
 x.context.history={replaceState(){assert.fail('presentation must not own navigation')}};
 for(const [index,path]of ['/local/11111111-1111-4111-a111-111111111111','/',current].entries())x.message(socket,{type:'dsh:route',path,dshPageSeq:index+1});
 assert.equal(x.context.location.pathname,current);assert(socket.sent.some(m=>m.type==='dsh:ack'&&m.seq===3));assert(!x.events.some(e=>e.type==='dsh:native-route'));
});

test('actual Android early diagnostic source survives the actual scope Storage wrapper and a new page',async()=>{
 const diagnostic=await readFile(new URL('../public/client-diagnostics.js',import.meta.url),'utf8');
 const install=context=>{delete context.window.__DSH_CLIENT_LOG__;vm.runInNewContext(diagnostic,context);};
 const x=fixture(undefined,{beforeScope:install}),log=x.context.window.__DSH_CLIENT_LOG__;
 const id=log.event('render_error',{failureClass:'connection'});
 assert([...x.context.localStorage.values.keys()].some(k=>k.endsWith(':event:'+id)));
 const y=fixture(undefined,{beforeScope:install,storage:x.context.localStorage.values});
 assert(y.context.window.__DSH_CLIENT_LOG__.snapshot().events.some(e=>e.eventId===id));
});

// Deterministic virtual-time fault sequences run the exact production recovery
// component. Each case checks the resulting host and messages, not a log label.
test('recovery fault matrix: no disposed host, duplicate prompt, or lost draft after transient failures',async t=>{
 for(const failure of ['http503','network','body-timeout'])for(const acknowledged of [false,true])for(const factoryFailure of [false,true])for(const hidden of [false,true]){
  await t.test(`${failure}/ack=${acknowledged}/factory=${factoryFailure}/hidden=${hidden}`,async()=>{
   let scopeCalls=0;
   const x=loaderFixture(async input=>{
    if(String(input).startsWith('/dsh-scope-session')){
     scopeCalls++;
     if(scopeCalls===2){if(failure==='network')throw Error('fixture connection reset');if(failure==='body-timeout')return {ok:true,status:200,json:()=>new Promise(()=>{})};return {ok:false,status:503};}
     return {ok:true,status:200,json:async()=>({id:'ai',token:'fresh-'+scopeCalls})};
    }
    return {ok:true,status:200,json:async()=>({nativeBootstrap:true})};
   });
   await x.context.window.__DSH_SESSION_READY__;for(let i=0;i<30;i++)await Promise.resolve();
   x.context.sessionStorage.setItem('draft','preserved unsent draft');
   let factoryCalls=0,hostReady=false,newSocket;
   x.context.window.__DSH_RESET_APP_HOST__=()=>{hostReady=false;};
   x.context.window.__DSH_RESET_BROWSER_PORTS__=()=>{};
   x.context.window.__DSH_RECONNECT_TRANSPORT__=()=>{};
   x.context.window.__DSH_RECREATE_APP_HOST__=async()=>{factoryCalls++;if(factoryFailure&&factoryCalls===1)throw Error('fixture host factory unavailable');newSocket=x.create();x.hello(newSocket);hostReady=true;};
   const old=x.create();x.hello(old);old.send(JSON.stringify({type:'opencodex:ipc-invoke',requestId:'original-user-message'}));if(acknowledged)x.message(old,{type:'dsh:ack',seq:1});
   x.document.visibilityState=hidden?'hidden':'visible';x.message(old,{type:'dsh:resume-unavailable'});for(let i=0;i<30;i++)await Promise.resolve();
   if(failure==='body-timeout'){const deadline=[...x.timers.values()].find(timer=>timer.ms===15000);assert(deadline);deadline.fn();for(let i=0;i<30;i++)await Promise.resolve();}
   assert.equal(hostReady,false);assert.equal(factoryCalls,0);assert.equal(x.context.window.__DSH_CONNECTION_PAUSED__,true);
   x.document.visibilityState='visible';x.advance(31000);x.listeners.focus();x.listeners.focus();for(let i=0;i<80;i++)await Promise.resolve();
   if(factoryFailure){assert.equal(hostReady,false);assert.equal(x.context.window.__DSH_CONNECTION_PAUSED__,true);x.advance(31000);x.listeners.focus();for(let i=0;i<80;i++)await Promise.resolve();}
   assert.equal(factoryCalls,factoryFailure?2:1);assert.equal(hostReady,true);assert.equal(x.context.window.__DSH_CONNECTION_PAUSED__,false);
   assert.equal(newSocket.sent.some(m=>m.requestId==='original-user-message'),false);assert.equal(newSocket.sent[0].dshResumeId,undefined);
   assert.equal(old.readyState,3);assert.equal(x.context.sessionStorage.getItem('draft'),'preserved unsent draft');assert.equal(x.reloads,0);
   // A new explicit operation uses the rebuilt connection exactly once.
   newSocket.send(JSON.stringify({type:'opencodex:ipc-invoke',requestId:'new-explicit-message'}));assert.equal(newSocket.sent.filter(m=>m.requestId==='new-explicit-message').length,1);
  });
 }
});


// A credential refresh must not overwrite newer, verified completion of the
// same live page recovery. Auth rejection and incomplete recovery still block.
async function pendingForegroundScope({status=503,proof=true,closed=false}={}){
 let finish,requests=0;const x=fixture(async()=>{requests++;return new Promise(resolve=>finish=()=>resolve({ok:status===200,status,json:async()=>({id:'ai',token:'fresh-after-sync'})}));});
 const id='11111111-1111-4111-a111-111111111111';x.context.location.pathname='/local/'+id;
 const socket=x.create();x.hello(socket);x.message(socket,{payload:{type:'codex-app-server-connection-changed',state:'connected'}});x.context.window.dispatchEvent(new CustomEvent('dsh:conversation-ready'));
 x.document.visibilityState='hidden';await x.listeners.visibilitychange();x.document.visibilityState='visible';const pending=x.listeners.visibilitychange();for(let i=0;i<6;i++)await Promise.resolve();
 const state=()=>x.events.filter(e=>e.type==='dsh:connection-state').at(-1)?.detail.state;
 assert.equal(state(),'syncing');
 if(proof){x.context.window.dispatchEvent(new CustomEvent('dsh:history-adopted',{detail:{threadId:id}}));assert.equal(state(),'connected');}
 if(closed)socket.close();finish();await pending;for(let i=0;i<6;i++)await Promise.resolve();
 assert.equal(requests,1);assert.equal(x.reloads,0);assert.equal(socket.sent.some(m=>m.type==='opencodex:ipc-invoke'),false);
 return {x,socket,state};
}
test('late failed foreground scope renewal preserves newer current history completion',async()=>{
 const {x,socket,state}=await pendingForegroundScope();assert.equal(state(),'connected');assert.equal(socket.readyState,1);assert.equal(x.context.window.__DSH_EXECUTION_CONNECTED__,true);assert.notEqual(x.context.window.__DSH_CONNECTION_PAUSED__,true);
 assert(x.connectionEvents.some(e=>e.component==='scope-session'&&e.reason==='scope_renewal_failed'&&e.statusCode===503));
});
test('failed foreground scope renewal without completed history remains reconnecting',async()=>{
 const {state}=await pendingForegroundScope({proof:false});assert.equal(state(),'reconnecting');
});
test('authentication rejection still blocks even after current history completion',async()=>{
 const {x,state}=await pendingForegroundScope({status:401});assert.equal(state(),'unavailable');assert.equal(x.context.window.__DSH_CONNECTION_PAUSED__,true);
});
test('closed wire cannot use previous history completion to hide failed scope renewal',async()=>{
 const {x,socket,state}=await pendingForegroundScope({closed:true});assert.equal(state(),'reconnecting');assert.equal(socket.readyState,3);assert.equal(x.context.window.__DSH_EXECUTION_CONNECTED__,false);
});
test('late successful foreground renewal updates credentials and preserves completed history',async()=>{
 const {x,state}=await pendingForegroundScope({status:200});assert.equal(state(),'connected');assert.equal(x.context.window.__DSH_SCOPE__.token,'fresh-after-sync');
});

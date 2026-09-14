import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const script=await readFile(new URL('../public/official-scope-bootstrap.js',import.meta.url),'utf8');
function fixture(fetchImpl){
 class Storage{constructor(){this.values=new Map()}getItem(k){return this.values.get(k)||null}setItem(k,v){this.values.set(k,v)}removeItem(k){this.values.delete(k)}clear(){this.values.clear()}}
 const listeners={},timers=new Map(),events=[],sockets=[];let timerId=0,reloads=0,ids=0;
 class Socket{constructor(url){this.url=url;this.readyState=1;this.listeners={};this.sent=[];sockets.push(this)}addEventListener(k,fn){(this.listeners[k]??=[]).push(fn)}send(raw){this.sent.push(JSON.parse(raw))}close(){this.readyState=3;this.emit('close',{})}emit(type,p){const event={...p,stopped:false,stopImmediatePropagation(){this.stopped=true}};for(const fn of this.listeners[type]||[]){fn(event);if(event.stopped)break;}}}
 const document={visibilityState:'visible',addEventListener:(k,f)=>listeners[k]=f};
 const location={href:'http://localhost:3080/',origin:'http://localhost:3080',pathname:'/',reload(){reloads++},replace(){reloads++}};
 const context={Storage,localStorage:new Storage(),sessionStorage:new Storage(),URL,Headers,Request,MessageEvent,CustomEvent,Event,location,document,crypto:{randomUUID:()=>String(++ids)},setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id},clearTimeout(id){timers.delete(id)},addEventListener:(k,f)=>listeners[k]=f};
 context.window={WebSocket:Socket,__BETTER_CODEX_SCOPE__:{id:'ai',token:'scope'},fetch:fetchImpl||(async()=>({ok:true,json:async()=>({id:'ai',token:'renewed'})})),dispatchEvent:event=>{events.push(event);listeners[event.type]?.(event);}};
 vm.runInNewContext(script,context);
 const create=()=>{const socket=new context.window.WebSocket('wss://localhost:3080/w/ai/ws');socket.send(JSON.stringify({type:'hello',clientId:'native-renderer'}));return socket;};
 const message=(socket,m)=>socket.emit('message',{data:JSON.stringify(m)});
 const hello=(socket,{resumed=false,received=0}={})=>message(socket,{type:'hello-ack',clientId:'native-renderer',betterCodexProtocol:'betterCodex-page-resume-v1',betterCodexResumeId:'same-session',betterCodexResumed:resumed,betterCodexReceivedSeq:received});
 return {context,document,listeners,timers,events,sockets,create,message,hello,get reloads(){return reloads}};
}
test('foreground recovery requests native catch-up without replacing page or resending an accepted prompt',async()=>{
 const x=fixture(),first=x.create();x.hello(first);
 first.send(JSON.stringify({type:'opencodex:ipc-invoke',requestId:'prompt',request:{channel:'codex_desktop:message-from-view',args:[{request:{id:5,method:'turn/steer'}}]}}));
 x.message(first,{type:'betterCodex:ack',seq:1});x.document.visibilityState='hidden';await x.listeners.visibilitychange();first.close();
 x.document.visibilityState='visible';const next=x.create();assert.equal(next.sent[0].betterCodexResumeId,'same-session');x.hello(next,{resumed:true,received:1});await x.listeners.visibilitychange();
 assert.equal(next.sent.some(m=>m.requestId==='prompt'),false);assert(next.sent.some(m=>m.type==='betterCodex:sync'&&m.recoverConversation));assert.equal(x.reloads,0);
});
test('missed outgoing transport is sent only to the same retained session; incoming duplicate is suppressed',()=>{
 const x=fixture(),first=x.create();x.hello(first);first.send(JSON.stringify({type:'app-host-port-message',portId:'original',data:['native-rpc']}));first.close();
 const next=x.create();x.hello(next,{resumed:true,received:0});assert.equal(next.sent.filter(m=>m.betterCodexClientSeq===1).length,1);
 let received=0;next.addEventListener('message',()=>received++);x.message(next,{type:'app-host-port-message',data:'same',betterCodexPageSeq:1});x.message(next,{type:'app-host-port-message',data:'same',betterCodexPageSeq:1});assert.equal(received,1);assert.equal(x.reloads,0);
});
test('silent OPEN socket is replaced after foreground probe, without a document reload',async()=>{
 const x=fixture(),socket=x.create();x.hello(socket);const probe=[...x.timers.values()].find(t=>t.ms===8000);assert(probe);probe.fn();assert.equal(socket.readyState,3);assert.equal(x.reloads,0);
});
test('a live pong avoids replacement; bfcache return asks for current state in place',async()=>{
 const x=fixture(),socket=x.create();x.hello(socket);const ping=socket.sent.find(m=>m.type==='betterCodex:ping');x.message(socket,{type:'betterCodex:pong',nonce:ping.nonce});assert.equal([...x.timers.values()].some(t=>t.ms===8000),false);
 await x.listeners.pageshow({persisted:true});assert(socket.sent.some(m=>m.type==='betterCodex:sync'&&m.recoverConversation));assert.equal(x.reloads,0);
});
test('server session loss rebuilds native AppHost only and never replays old messages to a fresh session',async()=>{
 const x=fixture(),first=x.create();x.hello(first);first.send(JSON.stringify({type:'opencodex:ipc-invoke',requestId:'old-prompt'}));let resetPorts=0,recreated=0,next;
 x.context.window.__BETTER_CODEX_RESET_BROWSER_PORTS__=()=>resetPorts++;
 x.context.window.__BETTER_CODEX_RECREATE_APP_HOST__=async()=>{recreated++;next=x.create();x.hello(next);};
 x.message(first,{type:'betterCodex:resume-unavailable'});for(let i=0;i<12;i++)await Promise.resolve();
 assert.equal(resetPorts,1);assert.equal(recreated,1);assert.equal(next.sent[0].betterCodexResumeId,undefined);assert.equal(next.sent.some(m=>m.requestId==='old-prompt'),false);assert.equal(x.reloads,0);
});

test('expired page scope renews a read in place instead of treating it as an expired SSO login',async()=>{
 const calls=[];let reads=0;const x=fixture(async(input,init)=>{calls.push({input:String(input),token:init.headers?.get?.('x-betterCodex-scope')});if(String(input).startsWith('/betterCodex-scope-session'))return {ok:true,status:200,json:async()=>({id:'ai',token:'fresh'})};return {status:++reads===1?401:200};});
 const response=await x.context.window.fetch('/w/ai/api/diagnostics');assert.equal(response.status,200);assert.equal(reads,2);assert.equal(calls.at(-1).token,'fresh');assert.equal(x.reloads,0);
});
test('scope renewal never automatically repeats a mutation',async()=>{
 let writes=0;const x=fixture(async(input)=>{if(String(input).startsWith('/betterCodex-scope-session'))return {ok:true,status:200,json:async()=>({id:'ai',token:'fresh'})};writes++;return {status:401};});
 const response=await x.context.window.fetch('/w/ai/api/request',{method:'POST',body:'{}'});assert.equal(response.status,401);assert.equal(writes,1);assert.equal(x.reloads,0);
});

test('SSO redirects during recovery preserve the document and draft until an explicit login click',async()=>{
 const x=fixture(async()=>({type:'opaqueredirect',status:0})),nodes=[];
 x.context.sessionStorage.setItem('qa-draft','未发送草稿');
 x.document.createElement=tag=>{const node={tag,events:{},setAttribute(){},addEventListener:(k,fn)=>node.events[k]=fn,append(){},remove(){}};nodes.push(node);return node;};x.document.body={append(){}};
 await x.context.window.fetch('/w/ai/api/diagnostics');assert.equal(x.reloads,0);assert.equal(x.context.sessionStorage.getItem('qa-draft'),'未发送草稿');assert.equal(x.context.window.__BETTER_CODEX_CONNECTION_PAUSED__,true);
 const banner=[...x.timers.values()].find(t=>t.ms===400);assert(banner);banner.fn();const login=nodes.find(n=>n.tag==='button');assert.equal(login.textContent,'重新登录');assert.equal(x.reloads,0);login.events.click();assert.equal(x.reloads,1);
});

test('background and frozen-page timers cannot close a healthy socket on foreground return',async()=>{const x=fixture(),socket=x.create();x.hello(socket);const oldProbe=[...x.timers.values()].find(t=>t.ms===8000);assert(oldProbe);x.document.visibilityState='hidden';await x.listeners.visibilitychange();assert.equal([...x.timers.values()].some(t=>t.ms===8000),false);x.document.visibilityState='visible';oldProbe.fn();assert.equal(socket.readyState,1);await x.listeners.visibilitychange();const ping=socket.sent.filter(m=>m.type==='betterCodex:ping').at(-1);x.message(socket,{type:'betterCodex:pong',nonce:ping.nonce});assert.equal(socket.readyState,1);x.listeners.freeze();assert.equal([...x.timers.values()].some(t=>t.ms===8000),false);});
test('closing an older socket cannot mark a replacement native connection offline',()=>{
 const x=fixture(),first=x.create();x.hello(first);x.message(first,{payload:{type:'codex-app-server-connection-changed',state:'connected'}});
 const next=x.create();x.hello(next,{resumed:true});x.message(next,{payload:{type:'codex-app-server-connection-changed',state:'connected'}});
 first.close();assert.equal(x.context.window.__BETTER_CODEX_EXECUTION_CONNECTED__,true);
 next.close();assert.equal(x.context.window.__BETTER_CODEX_EXECUTION_CONNECTED__,false);assert.equal(x.reloads,0);
});

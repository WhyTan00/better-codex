import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {browser} from './fixtures/bulk-read-browser.mjs';
const moduleSource=await readFile(new URL('../public/native-local-cache.js',import.meta.url),'utf8');
const finalBundle=process.env.DSH_PIN_BUNDLE?await readFile(process.env.DSH_PIN_BUNDLE,'utf8'):null;
if(finalBundle)assert(finalBundle.includes(moduleSource.trim()),'final shell includes the exact tested pin cache');
const source=finalBundle?finalBundle.slice(finalBundle.indexOf(moduleSource.trim()),finalBundle.indexOf(moduleSource.trim())+moduleSource.trim().length):moduleSource;
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const key='ipc:'+JSON.stringify(['list-pinned-threads',{}]);
function fixture(initial={threadIds:['11111111-1111-1111-1111-111111111111']}){
 const stores=new Map(),events={},sent=[],broadcasts=[];let online=true,clock=100000;
 const rows=name=>{if(!stores.has(name))stores.set(name,new Map());return stores.get(name);};
 rows('meta').set(key,{key,value:structuredClone(initial)});
 function request(result){const r={result:structuredClone(result)};setImmediate(()=>r.onsuccess?.());return r;}
 const db={transaction(names){const tx={objectStore(name){return {get:k=>request(rows(name).get(k)),put:v=>{rows(name).set(v.key,structuredClone(v));return request(v.key);},delete:k=>rows(name).delete(k)};}};setImmediate(()=>setImmediate(()=>tx.oncomplete?.()));return tx;},close(){}};
 class BroadcastChannel{addEventListener(type,fn){this.receive=fn;}postMessage(value){broadcasts.push(value);}close(){}}
 const window={__DSH_SCOPE__:{id:'ai'},__DSH_EXECUTION_CONNECTED__:true,__DSH_NATIVE_ONLINE__:true,__CODEX_WEB_CONFIG__:{},fetch(){throw Error('No network expected in fixture');},dispatchEvent(e){for(const f of events[e.type]||[])f(e);}};
 const context={performance,crypto,queueMicrotask,Event,MutationObserver:class{observe(){}},window,indexedDB:{open(){const r={result:db};setImmediate(()=>r.onsuccess?.());return r;}},navigator:{get onLine(){return online;}},location:{hostname:'workbench.example.test',pathname:'/',origin:'https://workbench.example.test'},document:{documentElement:{dataset:{}},visibilityState:'visible',addEventListener(){},querySelector(){return null;}},BroadcastChannel,matchMedia:()=>({matches:false}),structuredClone,TextEncoder,URL,Promise,Map,Set,WeakSet,Date:class extends Date{static now(){return clock;}},setTimeout(){return 1;},clearTimeout(){},setInterval(){return 1;},clearInterval(){},addEventListener(type,fn){(events[type]??=[]).push(fn);}};
 vm.runInNewContext(source,context);
 const emit=(type,value)=>sent.push({type,...value}),read=id=>window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',{type:'fetch',url:'vscode://codex/list-pinned-threads',body:'{}',requestId:id},emit);
 const response=(id,value)=>{const payload={type:'fetch-response',requestId:id,responseType:'success',bodyJsonString:JSON.stringify(value)};const changed=window.__DSH_IPC_CACHE_RESPONSE__(payload);return {changed,payload};};
 return {window,read,response,sent,broadcasts,rows,async flush(){for(let i=0;i<8;i++)await settle();},disconnect(){window.__DSH_EXECUTION_CONNECTED__=false;online=false;},advance(){clock+=61000;}};
}
test('online pinned sidebar returns durable cache immediately while one native read validates it',async()=>{
 const f=fixture();assert.equal(await f.read('first'),null);assert.equal(f.sent[0].requestId,'first');assert.equal(JSON.parse(f.sent[0].bodyJsonString).threadIds.length,1);
 assert.equal((await f.read('second')).handled,true);assert.equal(f.sent.length,2);
 const newer={threadIds:['22222222-2222-2222-2222-222222222222'],serverOrderedThreadIds:['22222222-2222-2222-2222-222222222222']};f.response('first',newer);await f.flush();assert.deepEqual(f.rows('meta').get(key).value,newer);assert(f.sent.some(e=>e.type==='pinned-threads-updated'));
 assert.equal((await f.read('third')).handled,true);assert.deepEqual(JSON.parse(f.sent.at(-1).bodyJsonString),newer);assert(f.broadcasts.some(e=>e.type==='pinned-cache'));
});
test('a pin change bypasses stale values and prevents the previous in-flight read overwriting new order',async()=>{
 const f=fixture();await f.read('old');f.window.__DSH_IPC_CACHE_RESPONSE__({type:'pinned-threads-updated'});const prior=f.sent.length;assert.equal(await f.read('new'),null);assert.equal(f.sent.length,prior);
 const updated={threadIds:['33333333-3333-3333-3333-333333333333']};f.response('new',updated);await f.flush();f.response('old',{threadIds:[]});await f.flush();assert.deepEqual(f.rows('meta').get(key).value,updated);
});
test('offline pinned order remains readable and authentication lock prevents online cache shortcut',async()=>{
 const f=fixture();f.disconnect();assert.equal((await f.read('offline')).handled,true);assert.equal(f.sent[0].responseType,'success');
 const locked=fixture();locked.rows('meta').set('auth-locked',{key:'auth-locked',value:true});assert.equal(await locked.read('locked'),null);assert.equal(locked.sent.length,0);
});

test('a disconnected validation cannot suppress future pin refreshes',async()=>{
 const f=fixture();await f.read('lost');f.window.__DSH_IPC_CACHE_RESPONSE__({type:'codex-app-server-connection-changed',state:'disconnected'});assert.equal(await f.read('reconnected'),null);f.response('lost',{threadIds:[]});await f.flush();assert.equal(f.rows('meta').get(key).value.threadIds.length,1);
});

test('a retired pin reply cannot reach the renderer as an authoritative empty list',async()=>{
 const f=fixture();f.window.__DSH_IPC_CACHE_RESPONSE__({type:'pinned-threads-updated'});await f.read('old-waiting');
 f.window.__DSH_IPC_CACHE_RESPONSE__({type:'pinned-threads-updated'});await f.read('current');
 f.response('current',{threadIds:['33333333-3333-3333-3333-333333333333']});await f.flush();
 const late=f.response('old-waiting',{threadIds:[]});await f.flush();
 assert.equal(late.changed,true,'the actual transport must serialize the invalidated reply');
 assert.equal(late.payload.responseType,'error','renderer may retain cached pins but cannot adopt stale success');
 assert.deepEqual(f.rows('meta').get(key).value.threadIds,['33333333-3333-3333-3333-333333333333']);
});

test('out-of-order reads in the same pin generation cannot undo the latest accepted order',async()=>{
 const f=fixture();f.window.__DSH_IPC_CACHE_RESPONSE__({type:'pinned-threads-updated'});await f.read('older');await f.read('newer');
 const current={threadIds:['33333333-3333-3333-3333-333333333333']};f.response('newer',current);await f.flush();
 const stale=f.response('older',{threadIds:[]});await f.flush();assert.equal(stale.payload.responseType,'error');assert.deepEqual(f.rows('meta').get(key).value,current);
});
test('a reply from the disconnected pin generation is rejected by the renderer boundary',async()=>{
 const f=fixture();await f.read('lost');f.window.__DSH_IPC_CACHE_RESPONSE__({type:'codex-app-server-connection-changed',state:'disconnected'});
 const late=f.response('lost',{threadIds:[]});assert.equal(late.changed,true);assert.equal(late.payload.responseType,'error');await f.flush();assert.equal(f.rows('meta').get(key).value.threadIds.length,1);
});
test('a current explicit unpin to an empty list still replaces both display reply and durable cache',async()=>{
 const f=fixture();f.window.__DSH_IPC_CACHE_RESPONSE__({type:'pinned-threads-updated'});await f.read('current');const result=f.response('current',{threadIds:[],serverOrderedThreadIds:[]});
 assert.equal(result.payload.responseType,'success');await f.flush();assert.deepEqual(f.rows('meta').get(key).value.threadIds,[]);
});

test('actual page transport delivers the retired pin error instead of the stale success to renderer listeners',async()=>{
 const f=fixture(),transport=browser(()=>new Promise(()=>{}));transport.window.__DSH_IPC_CACHE_RESPONSE__=f.window.__DSH_IPC_CACHE_RESPONSE__;
 const wire=transport.create();transport.hello(wire);await f.read('old');f.window.__DSH_IPC_CACHE_RESPONSE__({type:'pinned-threads-updated'});
 let delivered;wire.addEventListener('message',e=>{delivered=JSON.parse(e.data).payload;});
 wire.emit('message',{data:JSON.stringify({payload:{type:'fetch-response',requestId:'old',responseType:'success',bodyJsonString:'{"threadIds":[]}'}})});
 assert.equal(delivered.responseType,'error');assert.equal(delivered.bodyJsonString,undefined);assert.equal(delivered.status,409);
});

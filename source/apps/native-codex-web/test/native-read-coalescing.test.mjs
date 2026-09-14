import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/native-local-cache.js',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const key='ipc:'+JSON.stringify(['list-pinned-threads',{}]);
function fixture(initial={threadIds:['11111111-1111-1111-1111-111111111111']}){
 const stores=new Map(),events={},sent=[],broadcasts=[];let online=true,clock=100000;
 const rows=name=>{if(!stores.has(name))stores.set(name,new Map());return stores.get(name);};
 rows('meta').set(key,{key,value:structuredClone(initial)});
 function request(result){const r={result:structuredClone(result)};setImmediate(()=>r.onsuccess?.());return r;}
 const db={transaction(names){const tx={objectStore(name){return {get:k=>request(rows(name).get(k)),put:v=>{rows(name).set(v.key,structuredClone(v));return request(v.key);},delete:k=>rows(name).delete(k)};}};setImmediate(()=>setImmediate(()=>tx.oncomplete?.()));return tx;},close(){}};
 class BroadcastChannel{addEventListener(type,fn){this.receive=fn;}postMessage(value){broadcasts.push(value);}close(){}}
 const window={__BETTER_CODEX_SCOPE__:{id:'ai'},__BETTER_CODEX_EXECUTION_CONNECTED__:true,__BETTER_CODEX_NATIVE_ONLINE__:true,__CODEX_WEB_CONFIG__:{},fetch(){throw Error('No network expected in fixture');},dispatchEvent(e){for(const f of events[e.type]||[])f(e);}};
 const context={window,indexedDB:{open(){const r={result:db};setImmediate(()=>r.onsuccess?.());return r;}},navigator:{get onLine(){return online;}},location:{hostname:'localhost:3080',pathname:'/',origin:'http://localhost:3080'},document:{visibilityState:'visible',addEventListener(){}},BroadcastChannel,matchMedia:()=>({matches:false}),structuredClone,TextEncoder,URL,Promise,Map,Set,WeakSet,Date:class extends Date{static now(){return clock;}},setTimeout(){return 1;},clearTimeout(){},setInterval(){return 1;},clearInterval(){},addEventListener(type,fn){(events[type]??=[]).push(fn);}};
 vm.runInNewContext(source,context);
 const emit=(type,value)=>sent.push({type,...value}),read=id=>window.__BETTER_CODEX_IPC_CACHE__('codex_desktop:message-from-view',{type:'fetch',url:'vscode://codex/list-pinned-threads',body:'{}',requestId:id},emit);
 const response=(id,value)=>window.__BETTER_CODEX_IPC_CACHE_RESPONSE__({type:'fetch-response',requestId:id,responseType:'success',bodyJsonString:JSON.stringify(value)});
 return {window,read,response,sent,broadcasts,rows,async flush(){for(let i=0;i<8;i++)await settle();},disconnect(){window.__BETTER_CODEX_EXECUTION_CONNECTED__=false;online=false;},advance(){clock+=61000;}};
}

test('stable IPC cold reads share one response, warm reads avoid another trip, disconnect releases waiters',async()=>{
 const f=fixture(),emit=(type,value)=>f.sent.push({type,...value});const read=id=>f.window.__BETTER_CODEX_IPC_CACHE__('codex_desktop:message-from-view',{type:'fetch',url:'vscode://codex/os-info',body:'{}',requestId:id},emit);
 assert.equal(await read('a'),null);assert.equal((await read('b')).handled,true);assert.equal(f.sent.length,0);f.response('a',{platform:'darwin'});await f.flush();assert.equal(f.sent[0].requestId,'b');assert.equal((await read('c')).handled,true);assert.equal(f.sent.at(-1).requestId,'c');
 f.advance();assert.equal(await read('d'),null);assert.equal((await read('e')).handled,true);f.window.__BETTER_CODEX_IPC_CACHE_RESPONSE__({type:'codex-app-server-connection-changed',state:'disconnected'});assert.equal(f.sent.at(-1).status,503);assert.equal(await read('f'),null);
});
test('settings fanout refreshes once and a write cannot be overwritten by an older pending snapshot',async()=>{
 const f=fixture();let reads=0,resolve;const remote={settings:{readAll(){reads++;return new Promise(r=>resolve=r);},async write(){}}};const host=await f.window.__BETTER_CODEX_LOCAL_APP_HOST__(Promise.resolve(remote));
 await Promise.all(Array.from({length:100},()=>host.settings.read('theme')));await f.flush();assert.equal(reads,1);
 await host.settings.write('theme','dark');resolve({values:{theme:'light'},configuredValues:{theme:'light'}});await f.flush();assert.equal(f.rows('meta').get('settings').value.values.theme,'dark');
 await host.settings.read('theme');await f.flush();assert.equal(reads,2);resolve({values:{theme:'dark'},configuredValues:{theme:'dark'}});await f.flush();await host.settings.read('theme');await f.flush();assert.equal(reads,2);
});
test('auxiliary cold reads coalesce; warm reads skip fresh validation and mutations invalidate it',async()=>{
 const f=fixture();let reads=0,resolve;const target={sendRequest(method){if(method==='model/list'){reads++;return new Promise(r=>resolve=r);}return Promise.resolve({ok:true});},getAppServerVersion:()=> '1'};f.window.__BETTER_CODEX_INSTALL_NATIVE_READ_CACHE__({hostId:'local',requestClient:target});
 const first=target.sendRequest('model/list',{}),second=target.sendRequest('model/list',{});await f.flush();assert.equal(reads,1);resolve({data:[{id:'model-a'}]});await Promise.all([first,second]);await f.flush();await target.sendRequest('model/list',{});await f.flush();assert.equal(reads,1);
 await target.sendRequest('config/value/write',{});await target.sendRequest('model/list',{});await f.flush();assert.equal(reads,2);resolve({data:[{id:'model-b'}]});await f.flush();
});

test('fixed shared-object subscriptions use the current scoped bootstrap without a network trip',async()=>{
 const f=fixture();f.window.__CODEX_WEB_CONFIG__={sharedObjectSnapshot:{host_config:{id:'local',kind:'local'}}};const sent=[],emit=(type,payload)=>sent.push({type,...payload});
 assert.equal((await f.window.__BETTER_CODEX_IPC_CACHE__('codex_desktop:message-from-view',{type:'shared-object-subscribe',key:'host_config'},emit)).handled,true);assert.equal(sent[0].value.id,'local');
 assert.equal((await f.window.__BETTER_CODEX_IPC_CACHE__('codex_desktop:message-from-view',{type:'shared-object-subscribe',key:'missing'},emit)).handled,true);assert.equal(sent[1].value,undefined);assert.equal((await f.window.__BETTER_CODEX_IPC_CACHE__('codex_desktop:message-from-view',{type:'shared-object-unsubscribe',key:'host_config'},emit)).handled,true);assert.equal(sent.length,2);
});

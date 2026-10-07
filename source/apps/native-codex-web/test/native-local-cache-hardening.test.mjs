import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto,randomUUID} from 'node:crypto';

const source=await readFile(process.env.DSH_TEST_CACHE_SOURCE||new URL('../public/native-local-cache.js',import.meta.url),'utf8');
if(process.env.DSH_STOP_SCOPE)assert((await readFile(process.env.DSH_STOP_SCOPE,'utf8')).includes(source.trim()),'the final renderer scope must contain this exact tested cache implementation');
const threadId='11111111-1111-4111-a111-111111111111';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const timer=(fn,ms,...args)=>{const handle=setTimeout(fn,ms,...args);handle.unref?.();return handle;};
const interval=(fn,ms,...args)=>{const handle=setInterval(fn,ms,...args);handle.unref?.();return handle;};

function fixture({stallOpen=false,stallWrite=false,stallMeta=false,connectionJSON=false,scopeId='ai',persistedStores=new Map()}={}){
 const stores=persistedStores,events={},navigationEvents=[],network=[];let location=new URL('https://workbench.example.test/?workspace=ai'),abortCount=0;
 const rows=name=>{if(!stores.has(name))stores.set(name,new Map());return stores.get(name);};
 function request(value){const result={result:structuredClone(value),onsuccess:null,onerror:null};timer(()=>result.onsuccess?.(),0);return result;}
 function transaction(names,mode){
  let pending=0,closed=false,aborted=false;const writeStall=stallWrite&&mode==='readwrite',undo=[];
  const rollback=()=>{for(const restore of undo.reverse())restore();undo.length=0;};
  const tx={error:null,oncomplete:null,onabort:null,onerror:null,abort(){if(closed||aborted)return;aborted=true;abortCount++;rollback();tx.error=Error('transaction aborted');timer(()=>tx.onabort?.(),0);},objectStore(name){
   const store=rows(name);
   return {get(key){if(stallMeta&&names==='meta')return {};pending++;const r=request(store.get(key));const success=r.onsuccess;Object.defineProperty(r,'onsuccess',{configurable:true,set(fn){success;this._success=fn;},get(){return this._success;}});timer(()=>{pending--;r._success?.();finish();},0);return r;},
    getAll(range){pending++;const r=request([...store.values()].filter(row=>!range||row.key>=range.lower&&row.key<=range.upper));timer(()=>{pending--;r.onsuccess?.();finish();},0);return r;},
    put(value){const had=store.has(value.key),prior=had?structuredClone(store.get(value.key)):undefined;undo.push(()=>{if(had)store.set(value.key,prior);else store.delete(value.key);});store.set(value.key,structuredClone(value));pending++;const r=request(value.key);timer(()=>{pending--;r.onsuccess?.();finish();},0);return r;},
    delete(key){const had=store.has(key),prior=had?structuredClone(store.get(key)):undefined;undo.push(()=>{if(had)store.set(key,prior);else store.delete(key);});store.delete(key);pending++;const r=request(undefined);timer(()=>{pending--;r.onsuccess?.();finish();},0);return r;},
    clear(){const prior=[...store.entries()].map(([key,value])=>[key,structuredClone(value)]);undo.push(()=>{store.clear();for(const [key,value]of prior)store.set(key,value);});store.clear();pending++;const r=request(undefined);timer(()=>{pending--;r.onsuccess?.();finish();},0);return r;},
    index(){return {getAll:()=>{pending++;const r=request([...store.values()]);timer(()=>{pending--;r.onsuccess?.();finish();},0);return r;}};}};
  }};
  const finish=()=>{if(closed||aborted||pending||writeStall)return;closed=true;undo.length=0;timer(()=>tx.oncomplete?.(),0);};
  timer(finish,0);return tx;
 }
 const db={transaction,close(){}};
 const indexedDB={open(){const request={result:db};if(!stallOpen)timer(()=>request.onsuccess?.(),0);return request;}};
 const freshRecord=(method='thread/read',params={threadId,includeTurns:false})=>({scope:'ai',key:cacheKey(method,params),kind:'history',threadId,sourceGeneration:'source-1',generation:'thread-1',revision:1,confirmedAt:Date.now(),deleted:false,payload:{method,params,result:method==='thread/items/list'?{data:[],nextCursor:null}:{thread:{id:threadId,status:{type:'idle'},turns:[]}},eventEpoch:'epoch-1'}});
 const fakeFetch=async(_url,init)=>{const body=JSON.parse(init.body||'{}'),value=freshRecord(body.method,body.params);network.push(value);return {status:200,ok:true,type:'basic'};};
 const window={__DSH_SCOPE__:{id:scopeId,token:'scope-token'},__DSH_EXECUTION_CONNECTED__:true,__DSH_NATIVE_ONLINE__:true,__CODEX_WEB_CONFIG__:{},dispatchEvent(event){for(const callback of events[event.type]||[])callback(event);if(event.type==='dsh:native-route')navigationEvents.push(event.type);},fetch:fakeFetch};
 const navigation={acceptRoute(){return true;},presented(){}};
 window.__DSH_NAVIGATION__=navigation;
 const document={visibilityState:'visible',documentElement:{dataset:{}},addEventListener(){},querySelector(){return null}};
 const history={state:null,replaceState(_state,_title,url){navigationEvents.push('history');location=new URL(url,location.href);}};
 class CustomEvent{constructor(type,init={}){this.type=type;this.detail=init.detail;}}
 const context={IDBKeyRange:{bound:(lower,upper)=>({lower,upper})},MutationObserver:class{observe(){}disconnect(){}},requestAnimationFrame:fn=>timer(fn,0),cancelAnimationFrame:clearTimeout,window,indexedDB,navigator:{onLine:true,userAgent:''},location,history,document,crypto:{randomUUID,getRandomValues:array=>webcrypto.getRandomValues(array)},performance,Response,Event,CustomEvent,MessageEvent,structuredClone,TextEncoder,URL,Promise,Map,Set,WeakSet,Date,Symbol,queueMicrotask,setTimeout:timer,clearTimeout, setInterval:interval,clearInterval,addEventListener(type,fn){(events[type]??=[]).push(fn);},removeEventListener(type,fn){events[type]=(events[type]||[]).filter(value=>value!==fn);}};
 if(connectionJSON)window.__DSH_CONNECTION_JSON__=async(_url,init,timeoutMs)=>{const body=JSON.parse(init.body||'{}'),value=freshRecord(body.method,body.params);network.push(value);return {response:{status:200,ok:true,type:'basic'},data:value,timeoutMs};};
 vm.runInNewContext(source,context);
 const cacheKey=(method,params)=>'read:'+JSON.stringify([method,Object.fromEntries(Object.keys(params).sort().map(key=>[key,params[key]]))]);
 return {window,context,rows,network,navigationEvents,cacheKey,abortCount:()=>abortCount,async flush(){for(let i=0;i<8;i++)await settle();},get location(){return location;}};
}

// The startup ThreadStore calls requestClient directly, before the manager's
// AUX facade. Exercise that real pinned caller through the complete cache file.
async function recentListCaller(requestClient){
 const baseline=new URL('../../../acceptance/submission-before/pwa-initial.js',import.meta.url);
 const fallback=new URL('../../../runtime/quant-send-edit-review-20260928/ui/pwa/native-assets/v1033/app-initial-cadb12d4a15e.js',import.meta.url);
 const initial=process.env.DSH_THREAD_LIST_INITIAL?await readFile(process.env.DSH_THREAD_LIST_INITIAL,'utf8'):await readFile(baseline,'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return readFile(fallback,'utf8');});
 const begin=initial.indexOf('async listRecentThreads({cursor:e,limit:t,background:n=!1})'),end=initial.indexOf('async hydrateThreads(',begin);
 assert(begin>=0&&end>begin,'actual startup ThreadStore list caller is present');
 const context={ALt:['cli','vscode','exec','appServer','unknown'],Q_:'durable',u5t:()=>true};
 vm.createContext(context);vm.runInContext('globalThis.store={'+initial.slice(begin,end)+'};',context);
 context.store.params={hostId:'local',requestClient};context.store.recentConversationSortKey='updated_at';return context.store;
}
function ipcReader(f,{hostId='local',channel='codex_desktop:message-from-view'}={}){
 const wire=[],calls=[],waiting=new Map();let counter=0;
 const emit=(_type,payload)=>{const message=payload.message,callback=waiting.get(message.id);if(!callback)return;waiting.delete(message.id);message.error?callback.reject(message.error):callback.resolve(message.result);};
 const client={getCompatibleThreadSortKey:key=>key,sendRequest(method,params,options){
  const payload={type:'mcp-request',hostId,request:{id:'reader-'+(++counter),method,params}};calls.push({payload,options});
  return new Promise((resolve,reject)=>{waiting.set(payload.request.id,{resolve,reject});f.window.__DSH_IPC_CACHE__(channel,payload,emit).then(result=>{if(!result?.handled)wire.push(payload);},reject);});
 }};
 return {client,wire,calls,waiting,reply(payload,result){const response={type:'mcp-response',hostId,message:{id:payload.request.id,result}};f.window.__DSH_IPC_CACHE_RESPONSE__(response);emit('mcp-response',response);}};
}

async function actualModelDirectoryConsumer(){
 const initial=await readFile(process.env.DSH_THREAD_LIST_INITIAL||new URL('./fixtures/reasoning-catalog-original.js',import.meta.url),'utf8');
 const a=initial.indexOf('function Bgr('),b=initial.indexOf('));',a)+3,c=initial.indexOf('function X$a('),d=initial.indexOf('var Z$a',c);
 assert(a>=0&&b>a&&c>=0&&d>c,'the final renderer query key and default-model consumer must match this regression');
 const g=initial.indexOf('function Wgr('),h=initial.indexOf('function Ggr(',g);assert(g>=0,'actual unsupported-model guard is pinned');
 const guard=h>g?initial.slice(g,h):initial.slice(g);
 const context={t:fn=>{fn();},Y$a:(models,model)=>models?.find(row=>row.model===model),qgr:(_model,mode)=>{assert.equal(mode,'standard');return true;},Ggr:(_model,mode)=>{assert.equal(mode,'standard');return false;}};vm.createContext(context);vm.runInContext(initial.slice(a,b)+'\n'+initial.slice(c,d)+'\n'+guard,context);
 const producer=JSON.parse(await readFile(new URL('./fixtures/native-model-producer-0159.json',import.meta.url),'utf8'));
 return {key:Array.from(context.Bgr('local','chatgpt')),producer,choose:data=>{const selected=context.X$a({userSavedModelString:producer.config.model,userSavedReasoningEffort:producer.config.model_reasoning_effort,listModelsData:{models:data.data}});return {...selected,model:context.Wgr(data.data,selected.model,'standard')?.model};}};
}
test('reconnection refreshes the actual model query after offline startup and keeps current composer choices',async()=>{
 const f=fixture(),actual=await actualModelDirectoryConsumer(),reader=ipcReader(f);await f.flush();
 const old=JSON.parse(await readFile(new URL('./fixtures/native-model-directory-before-sol61.json',import.meta.url),'utf8'));assert(old.data.length);
 f.window.__DSH_EXECUTION_CONNECTED__=false;f.window.dispatchEvent(new f.context.CustomEvent('dsh:execution-state'));
 await f.window.__DSH_NATIVE_CACHE__.saveMeta('aux:'+JSON.stringify(['model/list',{}]),old);
 let directory=await reader.client.sendRequest('model/list',{});assert.notEqual(actual.choose(directory).model,'gpt-6.1-sol');
 const reads=[],invalidations=[];f.context.addEventListener('message',event=>{const key=event.data?.params?.queryKey;if(event.data?.method!=='query-cache-invalidate'||!key?.every((x,i)=>actual.key[i]===x))return;invalidations.push(Array.from(key));reads.push(reader.client.sendRequest('model/list',{}).then(value=>directory=value));});
 f.window.__DSH_EXECUTION_CONNECTED__=true;for(let i=0;i<3;i++)f.window.dispatchEvent(new f.context.CustomEvent('dsh:execution-state'));await f.flush();
 assert.equal(reader.wire.length,1,'offline startup must refetch the active native catalog exactly once');reader.reply(reader.wire[0],actual.producer);await Promise.all(reads);
 assert.equal(actual.choose(directory).model,'gpt-6.1-sol');assert.equal(actual.choose(directory).reasoningEffort,'max');assert.deepEqual(invalidations,[['models','list']]);
 assert.equal(f.window.__DSH_NEW_CHAT_MODEL_RESET_GENERATION__,undefined,'reconnection is read-only and must not reset a manual choice or draft');assert(reader.calls.every(x=>x.payload.request.method==='model/list'));
});
test('explicit new chat invalidates the real model directory even while the native connection stays online',async()=>{
 const f=fixture(),actual=await actualModelDirectoryConsumer(),keys=[];await f.flush();f.context.addEventListener('message',event=>{if(event.data?.method==='query-cache-invalidate')keys.push(Array.from(event.data.params.queryKey));});
 f.window.__DSH_RESET_NEW_CHAT_MODEL__();assert(keys.some(key=>key.length===2&&key.every((x,i)=>actual.key[i]===x)),'new chat must not leave the renderer on a stale unsupported-model fallback');assert.equal(f.window.__DSH_NEW_CHAT_MODEL_RESET_GENERATION__,undefined);
});

test('actual startup thread-list callers share one wire read and retain their individual options and results',async()=>{
 const f=fixture(),reader=ipcReader(f);await f.flush();const caller=await recentListCaller(reader.client);
 const reads=Array.from({length:12},(_,i)=>caller.listRecentThreads({cursor:null,limit:50,background:i%2===0}));await f.flush();
 assert.equal(reader.wire.length,1,'same startup page must not cross the slow wire twelve times');
 assert(reader.calls.every((call,i)=>call.options.source==='recent_threads'&&(call.options.priority==='background')===(i%2===0)));
 reader.reply(reader.wire[0],{data:[{id:threadId}],nextCursor:null});const results=await Promise.all(reads);
 assert(results.every(result=>result.data[0].id===threadId));results[0].data[0].id='changed';assert.equal(results[1].data[0].id,threadId,'consumer results must not share mutable DTOs');
 const again=caller.listRecentThreads({cursor:null,limit:50});await f.flush();assert.equal(reader.wire.length,2,'completion is not a stale-result cache');reader.reply(reader.wire[1],{data:[],nextCursor:null});await again;
});

test('thread-list IPC sharing uses exact params and preserves scope, host, channel and write boundaries',async()=>{
 const f=fixture(),other=fixture({scopeId:'another-workspace'});await Promise.all([f.flush(),other.flush()]);const emit=()=>{},base={limit:50,cursor:null,sortKey:'updated_at',archived:false,modelProviders:null};
 let n=0;const send=(params=base,hostId='local',method='thread/list',channel='codex_desktop:message-from-view',window=f.window)=>window.__DSH_IPC_CACHE__(channel,{type:'mcp-request',hostId,request:{id:'boundary-'+(++n),method,params}},emit);
 assert.equal(await send(),null);assert.equal((await send({archived:false,sortKey:'updated_at',cursor:null,modelProviders:null,limit:50})).handled,true,'object key order is not a different request');
 for(const params of [{...base,cursor:'page-2'},{...base,sortKey:'created_at'},{...base,sortDirection:'asc'},{...base,limit:49},{...base,archived:true},{...base,modelProviders:['openai']},{...base,sourceKinds:['exec']},{...base,useStateDbOnly:false},{...base,parentThreadId:threadId},{...base,searchTerm:'isolated-fixture'}])assert.equal(await send(params),null);
 assert.equal(await send(base,'another-host'),null);assert.equal(await send(base,'local','thread/list','another-channel'),null);assert.equal(await send(base,'local','thread/list','codex_desktop:message-from-view',other.window),null);
 for(let i=0;i<2;i++)assert.equal(await send({threadId,input:[{type:'text',text:'isolated-fixture'}]},'local','turn/start'),null,'writes never join');
});

test('thread-list IPC errors preserve the original rejection and a cancelled consumer does not cancel other readers',async()=>{
 const f=fixture(),reader=ipcReader(f);await f.flush();const a=reader.client.sendRequest('thread/list',{limit:50},{priority:'critical'}),b=reader.client.sendRequest('thread/list',{limit:50},{priority:'background'});const outcomes=Promise.allSettled([a,b]);await f.flush();assert.equal(reader.wire.length,1);
 // Native's caller has its own cancellation. Removing a disposed local
 // listener must not cancel the shared read or manufacture a successful ACK.
 const cancelled=reader.client.sendRequest('thread/list',{limit:50},{signal:new AbortController().signal});cancelled.catch(()=>{});await f.flush();const cancelledId=reader.calls.at(-1).payload.request.id;reader.waiting.get(cancelledId).reject(new DOMException('cancelled','AbortError'));reader.waiting.delete(cancelledId);
 const error={code:-32602,message:'isolated rejection',data:{status:400,notSubmitted:true}},payload={type:'mcp-response',message:{id:reader.wire[0].request.id,error}};
 f.window.__DSH_IPC_CACHE_RESPONSE__(payload);const leader=reader.waiting.get(payload.message.id);reader.waiting.delete(payload.message.id);leader.reject(error);
 const results=await outcomes;assert(results.every(result=>result.status==='rejected'&&result.reason.code===-32602&&result.reason.data.notSubmitted===true));
 const next=reader.client.sendRequest('thread/list',{limit:50});await f.flush();assert.equal(reader.wire.length,2);reader.reply(reader.wire[1],{data:[]});await next;
});

test('same request ids from different hosts cannot exchange coalesced thread-list responses',async()=>{
 const f=fixture(),replies=[];await f.flush();const request=(hostId,id)=>({type:'mcp-request',hostId,request:{id,method:'thread/list',params:{limit:50}}});
 for(const hostId of ['local','other-host']){assert.equal(await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',request(hostId,'same-id'),(_type,p)=>replies.push(p)),null);assert.equal((await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',request(hostId,'follower'),(_type,p)=>replies.push(p))).handled,true);}
 f.window.__DSH_IPC_CACHE_RESPONSE__({type:'mcp-response',hostId:'other-host',message:{id:'same-id',result:{data:['other']}}});assert.equal(replies.length,1);assert.equal(replies[0].hostId,'other-host');
 f.window.__DSH_IPC_CACHE_RESPONSE__({type:'mcp-response',hostId:'local',message:{id:'same-id',result:{data:['local']}}});assert.equal(replies.length,2);assert.equal(replies[1].hostId,'local');assert.equal(replies[1].message.result.data[0],'local');
});

test('AppHost replacement retires old coalesced reads and late old leader failure cannot settle the new generation',async()=>{
 const f=fixture();await f.flush();const replies=[],emit=(_type,payload)=>replies.push(payload),payload=id=>({type:'mcp-request',hostId:'local',request:{id,method:'thread/list',params:{limit:50}}});
 const old=payload('reused-id');assert.equal(await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',old,emit),null);assert.equal((await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',payload('old-follower'),emit)).handled,true);
 f.window.__DSH_RESET_APP_HOST__();assert.equal(replies.length,1);assert.equal(replies[0].message.id,'old-follower');assert.equal(replies[0].message.error.data.status,503);
 const fresh=payload('reused-id');assert.equal(await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',fresh,emit),null);assert.equal((await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',payload('new-follower'),emit)).handled,true);
 f.window.__DSH_IPC_CACHE_FAILURE__(old,Error('late old-wire invocation failure'));assert.equal(replies.length,1,'retired payload cannot complete new same-id readers');
 f.window.__DSH_IPC_CACHE_RESPONSE__({type:'mcp-response',message:{id:'reused-id',result:{data:['fresh']}}});assert.equal(replies.length,2);assert.equal(replies[1].message.id,'new-follower');assert.equal(replies[1].message.result.data[0],'fresh');
});

test('AppHost replacement also releases pre-existing MCP followers without replaying their old leader',async()=>{
 const f=fixture();await f.flush();const replies=[],emit=(_type,payload)=>replies.push(payload),payload=id=>({type:'mcp-request',request:{id,method:'mcpServerStatus/list',params:{}}});
 const old=payload('same-id');assert.equal(await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',old,emit),null);assert.equal((await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',payload('old-child'),emit)).handled,true);
 f.window.__DSH_RESET_APP_HOST__();assert.equal(replies.length,1);assert.equal(replies[0].message.id,'old-child');assert(replies[0].message.error);
 const fresh=payload('same-id');assert.equal(await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',fresh,emit),null);assert.equal((await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',payload('new-child'),emit)).handled,true);
 f.window.__DSH_IPC_CACHE_FAILURE__(old,Error('late previous invocation'));assert.equal(replies.length,1);f.window.__DSH_IPC_CACHE_FAILURE__(fresh,Error('current invocation'));assert.equal(replies.length,2);assert.equal(replies[1].message.id,'new-child');
});

test('an IndexedDB opening stall degrades to the network and releases the in-flight read',async()=>{
 const f=fixture({stallOpen:true,connectionJSON:true}),started=Date.now(),first=await f.window.__DSH_NATIVE_CACHE__.read('thread/read',{threadId,includeTurns:false});
 assert.equal(first.cached,false);assert.equal(first.result.thread.id,threadId);assert(f.network.length===1);assert(Date.now()-started<2500,'a cache stall must not permanently block a fresh read');
 const second=await f.window.__DSH_NATIVE_CACHE__.read('thread/read',{threadId,includeTurns:false});
 assert.equal(second.cached,false);assert.equal(f.network.length,2,'pendingReads must be released after the first network result');
 const item=await f.window.__DSH_NATIVE_CACHE__.read('thread/items/list',{threadId,turnId:threadId,cursor:'older-cursor',limit:20,sortDirection:'desc'});
 assert.deepEqual(item.result.data,[],'a missing history cursor must not block the network fallback');assert.equal(f.network.length,3);
});

test('an opened cache write that never completes aborts and releases fresh history reads',async()=>{
 const f=fixture({stallWrite:true,connectionJSON:true}),params={threadId,includeTurns:false};
 const first=await f.window.__DSH_NATIVE_CACHE__.read('thread/read',params);
 assert.equal(first.cached,false);assert.equal(first.result.thread.id,threadId);assert.equal(f.network.length,1);
 assert(f.abortCount()>=1,'a stuck write transaction must be aborted after the cache deadline');
 const second=await f.window.__DSH_NATIVE_CACHE__.read('thread/read',params);
 assert.equal(second.cached,false,'an aborted cache write must not turn the network result into a false cache hit');
 assert.equal(f.network.length,2,'pendingReads must be released after a stuck write');
 assert(f.abortCount()>=2,'the second fresh read must get its own bounded write attempt');
});

test('a late older-generation record cannot overwrite a newer revision or event epoch',async()=>{
 const f=fixture();await f.flush();const key=f.cacheKey('thread/read',{threadId,includeTurns:false});
 const newer={scope:'ai',key,kind:'history',threadId,sourceGeneration:'source-1',generation:'thread-new',revision:8,confirmedAt:800,deleted:false,eventEpoch:'epoch-new',payload:{method:'thread/read',params:{threadId,includeTurns:false},result:{thread:{id:threadId,status:{type:'idle'},turns:[{id:'new'}]}},eventEpoch:'epoch-new'}};
 const older={...newer,generation:'thread-old',revision:7,confirmedAt:700,eventEpoch:'epoch-old',payload:{...newer.payload,result:{thread:{id:threadId,status:{type:'idle'},turns:[{id:'old'}]}},eventEpoch:'epoch-old'}};
 assert.equal(await f.window.__DSH_NATIVE_CACHE__.put(newer),true);assert.equal(await f.window.__DSH_NATIVE_CACHE__.put(older),true);
 const kept=await f.window.__DSH_NATIVE_CACHE__.get(key,{touch:false});assert.equal(kept.revision,8);assert.equal(kept.generation,'thread-new');assert.equal(kept.payload.eventEpoch,'epoch-new');assert.equal(kept.payload.result.thread.turns[0].id,'new');
 f.rows('meta').set('catalog-generation',{key:'catalog-generation',value:'source-2'});
 const foreign={...older,sourceGeneration:'source-1',revision:9};await f.window.__DSH_NATIVE_CACHE__.put(foreign);const still=await f.window.__DSH_NATIVE_CACHE__.get(key,{touch:false});assert.equal(still.generation,'thread-new','a stale source generation is rejected by the current catalog fence');assert.equal(still.revision,8);
});

test('only the current local renderer presentation mirrors its memory route into the browser URL',async()=>{
 const f=fixture();await f.flush();const calls=[];let target='/local/'+threadId;
 f.window.__DSH_NAVIGATION__={acceptRoute:path=>path===target,presented:id=>calls.push(id)};
 const host=await f.window.__DSH_LOCAL_APP_HOST__(Promise.resolve({}));
 const present=id=>host.requestUserInputAutoResolution.setConversationPresented({hostId:'local',presented:true,conversationId:id});
 await present(threadId);assert.equal(f.location.pathname,target);assert.deepEqual(calls,[threadId]);assert(f.navigationEvents.includes('dsh:native-route'));
 const other='22222222-2222-4222-a222-222222222222';target='/local/'+other;
 await present(threadId);assert.deepEqual(calls,[threadId]);await present(other);assert.equal(f.location.pathname,target);assert.deepEqual(calls,[threadId,other]);
});

test('a failed IPC leader releases coalesced metadata readers and the next call can reach the host',async()=>{
 const f=fixture();await f.flush();const replies=[],payload=id=>({type:'fetch',url:'vscode://codex/codex-home',body:JSON.stringify({hostId:'local'}),requestId:id}),emit=(_type,p)=>replies.push(p);
 assert.equal(await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',payload('leader'),emit),null);
 assert.equal((await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',payload('follower'),emit)).handled,true);
 f.window.__DSH_IPC_CACHE_FAILURE__(payload('leader'),Error('Gateway WebSocket disconnected'));
 assert.equal(replies.length,1);assert.equal(replies[0].requestId,'follower');assert.equal(replies[0].responseType,'error');
 assert.equal(await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',payload('next'),emit),null,'a rejected leader must not retain the next send preparation');
});

test('only confirmed local host paths survive a same-epoch reconnect, never a host replacement or auth loss',async()=>{
 const f=fixture();await f.flush();let reads=0;const read=()=>{reads++;return Promise.resolve({codexHome:'/fresh'});};
 const request={type:'fetch',url:'vscode://codex/codex-home',body:JSON.stringify({hostId:'local'}),requestId:'home'};
 f.window.__DSH_HOST_METADATA_EPOCH__('front-1');
 await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',request,()=>{});
 f.window.__DSH_IPC_CACHE_RESPONSE__({type:'fetch-response',requestId:'home',responseType:'success',bodyJsonString:JSON.stringify({codexHome:'/host/.codex',worktreesSegment:'/host/worktrees'})});
 f.window.__DSH_IPC_CACHE_RESPONSE__({type:'codex-app-server-connection-changed',state:'disconnected'});
 assert.equal((await f.window.__DSH_READ_CODEX_HOME__('local',read)).codexHome,'/host/.codex');assert.equal(reads,0);
 await f.window.__DSH_READ_CODEX_HOME__('foreign-host',read);assert.equal(reads,1);
 f.window.__DSH_HOST_METADATA_EPOCH__('front-2');await f.window.__DSH_READ_CODEX_HOME__('local',read);assert.equal(reads,2);
 f.window.dispatchEvent(new f.context.CustomEvent('dsh:authentication-required'));await f.window.__DSH_READ_CODEX_HOME__('local',read);assert.equal(reads,3);
});

test('offline official file open and metadata consume a scoped native copy before the remote gate',async()=>{
 const f=fixture();f.context.matchMedia=()=>({matches:false});f.window.__DSH_EXECUTION_CONNECTED__=false;const path='/workspace/example/report.pdf';
 f.window.__DSH_ANDROID_BRIDGE__={resolveDeliverable:async p=>({available:p===path,url:'https://workbench.example.test/__dsh_deliverables/ai/grant/report.pdf',size:123,mtimeMs:42,createdAtMs:1,contentKind:'pdf'})};
 const opened=await f.window.__DSH_IPC_CACHE__('open-file',{path},()=>{});assert.equal(opened.handled,true);assert.match(opened.value.url,/__dsh_deliverables\/ai\//);
 let reply;await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',{type:'fetch',url:'vscode://codex/read-file-metadata',body:JSON.stringify({path}),requestId:'file-1'},(_type,p)=>{reply=p;});
 assert.equal(reply.responseType,'success');assert.equal(JSON.parse(reply.bodyJsonString).sizeBytes,123);assert.equal(f.network.length,0);
 assert.equal((await f.window.__DSH_IPC_CACHE__('open-file',{hostId:'another-host',path},()=>{})).value,null);
});

test('recovery MCP hooks share one IPC request and fan out original result or failure',async()=>{
 for(const failed of [false,true]){
  const f=fixture({connectionJSON:true}),replies=[];await f.flush();
  const request=id=>({type:'mcp-request',request:{id,method:'mcpServerStatus/list',params:{}}});
  const leader=request('first');assert.equal((await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',leader,(type,value)=>replies.push({type,value})))?.handled,undefined);
  assert.equal((await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',request('second'),(type,value)=>replies.push({type,value})))?.handled,true);
  if(failed)f.window.__DSH_IPC_CACHE_FAILURE__(leader,Error('fixture'));
  else f.window.__DSH_IPC_CACHE_RESPONSE__({type:'mcp-response',message:{id:'first',result:{data:[{name:'fixture'}]}}});
  assert.equal(replies.length,1);assert.equal(replies[0].value.message.id,'second');assert.equal(!!replies[0].value.message.error,failed);
  assert.equal((await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',request('third'),()=>{}))?.handled,undefined,'next read must observe new Native state');
 }
});

test('a stalled metadata store does not turn the authenticated bootstrap into a logged-out account',async()=>{
 const f=fixture({stallMeta:true}),account={account:{type:'chatgpt'},requiresOpenaiAuth:true};
 f.window.__CODEX_WEB_CONFIG__={dshReadDefaults:{'account/read':account}};f.window.__DSH_EXECUTION_CONNECTED__=false;
 const replies=[];const result=await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',{type:'mcp-request',request:{id:'account-startup',method:'account/read',params:{}}},(type,payload)=>replies.push({type,payload}));
 assert.equal(result.handled,true);assert.deepEqual(JSON.parse(JSON.stringify(replies[0].payload.message.result)),account);
 const host=await f.window.__DSH_LOCAL_APP_HOST__(Promise.resolve({}));assert.equal((await host.appInfo.get()).buildFlavor,'prod');
});

test('an empty catalog starts background synchronization without holding the renderer',async()=>{
 const f=fixture();await f.flush();f.window.__DSH_CONNECTION_JSON__=()=>new Promise(()=>{});
 const host=await f.window.__DSH_LOCAL_APP_HOST__(Promise.resolve({}));
 const status=await Promise.race([host.localThreadCatalog.requestStartupSync(),new Promise((_,reject)=>setTimeout(()=>reject(Error('catalog sync held startup')),100))]);
 assert.equal(status.isComplete,false,'an empty catalog is still incomplete, never a false ready receipt');await f.window.__DSH_NATIVE_CACHE__.close();
});
test('control host creation does not wait for an unavailable optional cache',async()=>{
 const f=fixture({stallOpen:true}),reads=[];
 const host=await Promise.race([f.window.__DSH_LOCAL_APP_HOST__(Promise.resolve({threadArchive:{archive:async id=>reads.push(id)}})),new Promise((_,reject)=>setTimeout(()=>reject(Error('optional cache blocked AppHost')),100))]);
 await host.threadArchive.archive(threadId);assert.deepEqual(reads,[threadId]);assert.equal(f.abortCount(),0);await f.window.__DSH_NATIVE_CACHE__.close();
});
test('catalog storage timeout degrades to the original host without hiding invalid cursors',async()=>{
 const stalled=fixture({stallMeta:true});await stalled.flush();let reads=0;
 const host=await stalled.window.__DSH_LOCAL_APP_HOST__(Promise.resolve({localThreadCatalog:{readStatus:async()=>{reads++;return {isComplete:true,revision:'native'};}}}));
 assert.equal((await host.localThreadCatalog.readStatus()).revision,'native');assert.equal(reads,1);await stalled.window.__DSH_NATIVE_CACHE__.close();
 const healthy=fixture();await healthy.flush();let unexpected=0;const live=await healthy.window.__DSH_LOCAL_APP_HOST__(Promise.resolve({localThreadCatalog:{readPage:async()=>{unexpected++;return {};}}}));
 await assert.rejects(live.localThreadCatalog.readPage({cursor:'invalid'}),/目录已更新/);assert.equal(unexpected,0);await healthy.window.__DSH_NATIVE_CACHE__.close();
});
test('startup atom restoration never deserializes unrelated attachment view bodies',async()=>{
 const f=fixture();await f.flush();f.rows('drafts').set('atom:composer-text',{key:'atom:composer-text',value:'draft'});
 const attachment={key:'view:large-attachment',get value(){throw Error('startup read an attachment view body');}};f.rows('drafts').set(attachment.key,attachment);
 assert.equal((await f.window.__DSH_NATIVE_CACHE__.restoreAtoms())['composer-text'],'draft');await f.window.__DSH_NATIVE_CACHE__.close();
});


test('online Native account reads do not return an older logged-out cache entry',async()=>{
 const f=fixture();await f.flush();const params={refreshToken:false},account={account:{type:'chatgpt'},requiresOpenaiAuth:true};
 await f.window.__DSH_NATIVE_CACHE__.saveMeta('aux:'+JSON.stringify(['account/read',params]),{account:null,requiresOpenaiAuth:true});
 const client={hostId:'local',requestClient:{sendRequest:async method=>{assert.equal(method,'account/read');return account;}},addNotificationCallback(){}};
 f.window.__DSH_INSTALL_NATIVE_READ_CACHE__(client);
 const result=await client.requestClient.sendRequest('account/read',params);
 assert.deepEqual(JSON.parse(JSON.stringify(result)),account,'the current read must deliver the Native account, not only update storage later');
});

function authClient(f,read){
 const notifications=[],callbacks=new Map();
 const client={hostId:'local',requestClient:{sendRequest:read},addNotificationCallback(method,fn){const set=callbacks.get(method)||new Set();set.add(fn);callbacks.set(method,set);return ()=>set.delete(fn);},onNotification(method,params){notifications.push({method,params});for(const fn of callbacks.get(method)||[])fn({params});}};
 f.window.__DSH_INSTALL_NATIVE_READ_CACHE__(client);
 const state=connected=>{f.window.__DSH_EXECUTION_CONNECTED__=connected;f.window.dispatchEvent(new f.context.CustomEvent('dsh:execution-state'));};
 return {client,notifications,state,callbacks};
}
async function until(check,attempts=100){for(let i=0;i<attempts;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('expected asynchronous state was not reached');}
const accountKey='aux:'+JSON.stringify(['account/read',{refreshToken:false}]);

test('a live signed-out account overrides an old authenticated cache without a fabricated login',async()=>{
 const f=fixture(),signedOut={account:null,requiresOpenaiAuth:true};
 await f.window.__DSH_NATIVE_CACHE__.saveMeta(accountKey,{account:{type:'chatgpt'},requiresOpenaiAuth:true});
 const a=authClient(f,async()=>signedOut);
 const result=await a.client.requestClient.sendRequest('account/read',{refreshToken:false});
 assert.equal(result.account,null);assert.equal(a.notifications.length,0);
});

test('reconnection replaces a cached signed-out snapshot and informs the existing official client once',async()=>{
 const f=fixture();f.window.__DSH_EXECUTION_CONNECTED__=false;
 await f.window.__DSH_NATIVE_CACHE__.saveMeta(accountKey,{account:null,requiresOpenaiAuth:true});
 const calls=[],account={account:{type:'chatgpt'},requiresOpenaiAuth:true};
 const a=authClient(f,async method=>{calls.push(method);return method==='account/read'?account:{authMethod:'chatgpt'};});
 const before=await a.client.requestClient.sendRequest('account/read',{refreshToken:false});assert.equal(before.account,null);
 a.state(true);a.state(true);a.state(true);
 await until(()=>a.notifications.length===1);
 assert.deepEqual(calls.sort(),['account/read','getAuthStatus']);
 assert.deepEqual(JSON.parse(JSON.stringify(a.notifications)),[{method:'account/updated',params:{authMode:'chatgpt'}}]);
 await until(async()=> (await f.window.__DSH_NATIVE_CACHE__.meta(accountKey))?.account?.type==='chatgpt');
 assert.equal((await f.window.__DSH_NATIVE_CACHE__.meta(accountKey)).account.type,'chatgpt');
 a.state(true);await f.flush();assert.equal(a.notifications.length,1,'duplicate connected events do not poll or issue repeated auth transitions');
});

test('a late account read from a disconnected generation cannot replace the new account or notify the renderer',async()=>{
 const f=fixture();f.window.__DSH_EXECUTION_CONNECTED__=false;
 const pending=[],a=authClient(f,method=>new Promise(resolve=>pending.push({method,resolve})));
 a.state(true);await until(()=>pending.length===2);
 a.state(false);a.state(true);await until(()=>pending.length===4);
 for(const request of pending.slice(2))request.resolve(request.method==='account/read'?{account:{type:'chatgpt'},requiresOpenaiAuth:true}:{authMethod:'chatgpt'});
 await until(()=>a.notifications.length===1);
 for(const request of pending.slice(0,2))request.resolve(request.method==='account/read'?{account:null,requiresOpenaiAuth:true}:{authMethod:null});
 await new Promise(resolve=>setTimeout(resolve,15));
 assert.equal(a.notifications.length,1);assert.equal(a.notifications[0].params.authMode,'chatgpt');
 assert.equal((await f.window.__DSH_NATIVE_CACHE__.meta(accountKey)).account.type,'chatgpt');
});

test('a failed live account read stays a read failure and emits no logout or successful authentication',async()=>{
 const f=fixture();await f.window.__DSH_NATIVE_CACHE__.saveMeta(accountKey,{account:{type:'chatgpt'},requiresOpenaiAuth:true});
 const a=authClient(f,async()=>{throw Error('fixture transport failed');});
 await assert.rejects(a.client.requestClient.sendRequest('account/read',{refreshToken:false}),/fixture transport failed/);
 a.state(false);a.state(true);await new Promise(resolve=>setTimeout(resolve,15));assert.equal(a.notifications.length,0);
 assert.equal((await f.window.__DSH_NATIVE_CACHE__.meta(accountKey)).account.type,'chatgpt');
});

test('replacing a renderer detaches the old account recovery listener',async()=>{
 const f=fixture();f.window.__DSH_EXECUTION_CONNECTED__=false;let firstReads=0,secondReads=0;
 const value=method=>method==='account/read'?{account:{type:'chatgpt'},requiresOpenaiAuth:true}:{authMethod:'chatgpt'};
 const first=authClient(f,async method=>{firstReads++;return value(method);});
 const second=authClient(f,async method=>{secondReads++;return value(method);});
 assert.equal(first.callbacks.get('account/updated').size,0,'cleanup uses the disposer returned by the actual pinned renderer API');
 second.state(true);await until(()=>second.notifications.length===1);
 assert.equal(firstReads,0);assert.equal(first.notifications.length,0);assert.equal(secondReads,2);
});

test('a replacement Native client gets its own account read while the previous client is still pending',async()=>{
 const f=fixture(),pending=[];
 const first=authClient(f,method=>new Promise(resolve=>pending.push({method,resolve})));
 const oldRead=first.client.requestClient.sendRequest('account/read',{refreshToken:false});await until(()=>pending.length===1);
 let freshCalls=0;
 const second=authClient(f,async()=>{freshCalls++;return {account:{type:'chatgpt'},requiresOpenaiAuth:true};});
 const fresh=await second.client.requestClient.sendRequest('account/read',{refreshToken:false});
 assert.equal(freshCalls,1);assert.equal(fresh.account.type,'chatgpt');
 pending[0].resolve({account:null,requiresOpenaiAuth:true});await oldRead;
 assert.equal((await f.window.__DSH_NATIVE_CACHE__.meta(accountKey)).account.type,'chatgpt','the detached client cannot replace the current account cache');
});


test('a successful Native account read survives a stalled projection write',async()=>{
 const f=fixture({stallWrite:true}),account={account:{type:'chatgpt'},requiresOpenaiAuth:true};
 const a=authClient(f,async method=>method==='account/read'?account:{authMethod:'chatgpt'});
 const result=await a.client.requestClient.sendRequest('account/read',{refreshToken:false});
 assert.equal(result.account.type,'chatgpt');assert.equal(f.abortCount(),0,'Native success returns before the optional projection times out');
 // Aborting the transaction is earlier than the rejection/catch that reports
 // the optional projection failure. Observe completion, not that intermediate.
 await until(()=>f.abortCount()>0&&f.window.__DSH_NATIVE_CACHE__.diagnostics().authCacheFailures===1,1000);
 assert.equal(f.window.__DSH_NATIVE_CACHE__.diagnostics().authCacheFailures,1);
});

test('a failed projection write cannot suppress successful Native authentication reconciliation',async()=>{
 const f=fixture({stallWrite:true});f.window.__DSH_EXECUTION_CONNECTED__=false;
 const a=authClient(f,async method=>method==='account/read'?{account:{type:'chatgpt'},requiresOpenaiAuth:true}:{authMethod:'chatgpt'});
 a.state(true);await until(()=>a.notifications.length===1,1000);
 assert.equal(a.notifications[0].params.authMode,'chatgpt');
 await until(()=>f.window.__DSH_NATIVE_CACHE__.diagnostics().authCacheFailures===2,1000);
 assert.equal(f.window.__DSH_NATIVE_CACHE__.diagnostics().authCacheFailures,2);
});

test('successful auxiliary Native preparation never waits for or fails with optional disk persistence',async()=>{
 const f=fixture({stallWrite:true}),native={data:[{id:'fixture-skill'}]};
 const a=authClient(f,async method=>{assert.equal(method,'skills/list');return native;});
 const started=Date.now(),result=await a.client.requestClient.sendRequest('skills/list',{cwds:['/fixture']});
 assert.deepEqual(result,native);assert(Date.now()-started<500,'optional storage is not a send preparation dependency');
 assert.equal(f.abortCount(),0);
 await until(()=>f.window.__DSH_NATIVE_CACHE__.diagnostics().auxCacheFailures===1,1000);
 assert(f.abortCount()>0,'the stalled projection is still bounded and retired');
});

const nativeQuota={rateLimits:{limitId:'codex',limitName:'Codex',planType:'plus',primary:{usedPercent:12,windowDurationMins:300}}};

test('a stalled quota projection preserves the Native result and coalesces concurrent refreshes',async()=>{
 const f=fixture({stallWrite:true}),updates=[];let calls=0;
 f.context.addEventListener('dsh:quota-updated',event=>updates.push(event.detail));
 authClient(f,async method=>{assert.equal(method,'account/rateLimits/read');calls++;return nativeQuota;});
 const results=await Promise.all(Array.from({length:3},()=>f.window.__DSH_READ_ACCOUNT_LIMITS__()));
 assert.equal(calls,1);assert.equal(updates.length,1);
 for(const result of results)assert.equal(result.data.buckets[0].primary.usedPercent,12);
 assert.equal(updates[0].data.buckets[0].primary.usedPercent,12);
 assert.equal(f.abortCount(),0,'the Native quota result is visible before the optional disk timeout');
 await until(()=>f.window.__DSH_NATIVE_CACHE__.diagnostics().quotaCacheFailures===1,1000);
 assert(f.abortCount()>0);assert.equal(f.rows('meta').has('account-quota-v1'),false,'an aborted projection cannot be reported as durable');
 await new Promise(resolve=>setTimeout(resolve,25));assert.equal(calls,1,'storage failure does not resubmit the Native read');
});

test('a Native quota failure remains a read failure and retains the prior display snapshot',async()=>{
 const f=fixture(),saved={data:{buckets:[]},checkedAt:123},failure=Error('fixture quota transport failed'),updates=[];
 await f.window.__DSH_NATIVE_CACHE__.saveMeta('account-quota-v1',saved);
 f.context.addEventListener('dsh:quota-updated',event=>updates.push(event.detail));
 authClient(f,async()=>{throw failure;});
 await assert.rejects(f.window.__DSH_READ_ACCOUNT_LIMITS__(),error=>error===failure);
 assert.equal(updates.length,0);assert.equal(f.window.__DSH_NATIVE_CACHE__.diagnostics().quotaCacheFailures||0,0);
 assert.equal((await f.window.__DSH_NATIVE_CACHE__.meta('account-quota-v1')).checkedAt,123);
});

test('a healthy quota projection eventually commits the exact displayed Native result',async()=>{
 const f=fixture(),updates=[];
 f.context.addEventListener('dsh:quota-updated',event=>updates.push({value:event.detail,durable:f.rows('meta').get('account-quota-v1')?.value}));
 authClient(f,async()=>nativeQuota);
 const result=await f.window.__DSH_READ_ACCOUNT_LIMITS__();
 assert.equal(updates.length,1);assert.equal(updates[0].value.checkedAt,result.checkedAt);
 if(f.window.__DSH_NATIVE_CACHE__.diagnostics().displayCacheWrites!==undefined)await until(()=>f.window.__DSH_NATIVE_CACHE__.diagnostics().displayCacheWrites===0,1000);
 assert.equal((await f.window.__DSH_NATIVE_CACHE__.meta('account-quota-v1')).data.buckets[0].primary.usedPercent,12);
 assert.equal(f.window.__DSH_NATIVE_CACHE__.diagnostics().quotaCacheFailures||0,0);
});

test('an online model picker receives the current Native catalog on its first read instead of an older persisted list',async()=>{
 const f=fixture(),params={cursor:null,includeHidden:true,limit:100},old={data:[{id:'gpt-6-sol',model:'gpt-6-sol'}],nextCursor:null},fresh={data:[{id:'gpt-6.1-sol',model:'gpt-6.1-sol'}],nextCursor:null};
 const key='aux:'+JSON.stringify(['model/list',{cursor:null,includeHidden:true,limit:100}]);await f.window.__DSH_NATIVE_CACHE__.saveMeta(key,old);
 const a=authClient(f,async method=>{assert.equal(method,'model/list');return fresh;});
 const visible=await a.client.requestClient.sendRequest('model/list',params);
 assert.equal(visible.data[0].id,'gpt-6.1-sol','the picker must receive the fresh result, not only its background cache write');
});

test('live model catalog reads coalesce without waiting for the offline metadata store',async()=>{
 const f=fixture({stallMeta:true}),params={includeHidden:true},pending=[];
 const a=authClient(f,method=>new Promise(resolve=>{assert.equal(method,'model/list');pending.push(resolve)}));
 const one=a.client.requestClient.sendRequest('model/list',params),two=a.client.requestClient.sendRequest('model/list',params);await until(()=>pending.length===1);
 pending[0]({data:[{id:'gpt-6.1-sol'}],nextCursor:null});
 const result=await Promise.race([Promise.all([one,two]),new Promise((_,reject)=>setTimeout(()=>reject(Error('metadata blocked live models')),200))]);assert(result.every(x=>x.data[0].id==='gpt-6.1-sol'));
});

test('offline model catalog remains available while an online failure is not presented as a successful stale list',async()=>{
 const f=fixture(),params={},old={data:[{id:'gpt-6-sol'}],nextCursor:null};await f.window.__DSH_NATIVE_CACHE__.saveMeta('aux:'+JSON.stringify(['model/list',params]),old);
 const a=authClient(f,async()=>{throw Error('fixture disconnected')});f.window.__DSH_EXECUTION_CONNECTED__=false;
 assert.equal((await a.client.requestClient.sendRequest('model/list',params)).data[0].id,'gpt-6-sol');f.window.__DSH_EXECUTION_CONNECTED__=true;
 await assert.rejects(a.client.requestClient.sendRequest('model/list',params),/fixture disconnected/);
});


test('new chat remembers a saved native model choice across new drafts and document restart',async()=>{
 const stores=new Map(),saved={model:'gpt-6.1-sol',model_reasoning_effort:'xhigh'},writes=[];
 const native=async(method,p)=>{if(method==='config/batchWrite'){writes.push(p);for(const edit of p.edits)saved[edit.keyPath]=edit.value;return {status:'ok',version:'native-v2'};}return {config:{...saved}};};
 const f=fixture({persistedStores:stores}),a=authClient(f,native);a.state(true);
 let c=(await a.client.requestClient.sendRequest('config/read',{})).config;assert.equal(c.model,'gpt-6.1-sol');assert.equal(c.model_reasoning_effort,'xhigh');
 await a.client.requestClient.sendRequest('config/batchWrite',{edits:[{keyPath:'model',value:'gpt-6-luna',mergeStrategy:'upsert'},{keyPath:'model_reasoning_effort',value:'low',mergeStrategy:'upsert'}]});
 f.window.__DSH_RESET_NEW_CHAT_MODEL__();c=(await a.client.requestClient.sendRequest('config/read',{})).config;assert.equal(c.model,'gpt-6-luna');assert.equal(c.model_reasoning_effort,'low');assert.equal(writes.length,1);
 const next=fixture({persistedStores:stores}),b=authClient(next,native);b.state(true);next.window.__DSH_RESET_NEW_CHAT_MODEL__();c=(await b.client.requestClient.sendRequest('config/read',{})).config;assert.equal(c.model,'gpt-6-luna');assert.equal(c.model_reasoning_effort,'low');
});

test('dismissed model introductions survive a document restart and an older remote atom snapshot',async()=>{
 const stores=new Map(),f=fixture({persistedStores:stores});await f.flush();
 assert.equal(await f.window.__DSH_NATIVE_CACHE__.persistAtom({key:'seen-model-upgrade-list',value:['gpt-6.1-sol']}),true);
 const next=fixture({persistedStores:stores});next.window.__DSH_EXECUTION_CONNECTED__=false;await next.flush();
 const atoms=await next.window.__DSH_NATIVE_CACHE__.restoreAtoms();assert.deepEqual(JSON.parse(JSON.stringify(atoms['seen-model-upgrade-list'])),['gpt-6.1-sol']);
 const old={type:'persisted-atom-sync',state:{'seen-model-upgrade-list':[]}};next.window.__DSH_IPC_CACHE_RESPONSE__(old);assert(old.state['seen-model-upgrade-list'].includes('gpt-6.1-sol'));
 const reply={type:'persisted-atom-updated',key:'seen-model-upgrade-list',value:['gpt-6-sol']};next.window.__DSH_IPC_CACHE_RESPONSE__(reply);assert(reply.value.includes('gpt-6.1-sol'));assert(reply.value.includes('gpt-6-sol'));
});


test('the actual model introduction stays dismissed after reopening from the persisted local snapshot',async()=>{
 const hook=await readFile(process.env.DSH_NUX_PRIMARY||new URL('./fixtures/model-announcement-original.js',import.meta.url),'utf8'),i=hook.indexOf('rUe=()=>{'),j=hook.indexOf(',iUe=()=>',i),code=j>i?hook.slice(i,j):hook;
 const stores=new Map(),f=fixture({persistedStores:stores});let seen=[],write;
 const store={set(_key,update){seen=update(seen);write=f.window.__DSH_NATIVE_CACHE__.persistAtom({key:'seen-model-upgrade-list',value:seen});}};
 const context={$O:{c:n=>Array(n).fill(Symbol.for('react.memo_cache_sentinel'))},zx:()=>store,qv:{},QO:()=>true,ee:()=>({authMethod:'chatgpt'}),_T:()=>({modelSettings:{model:'gpt-6-astra',isLoading:false}}),ZS:()=>({data:{models:[{model:'gpt-6.1-sol',availabilityNux:{message:'intro'},defaultReasoningEffort:'max'}]},isLoading:false}),bS:()=>seen,tk:{},vS:()=>[],ek:'seen-model-upgrade-list',ef:(models,model)=>models?.find(x=>x.model===model),eUe:new Set(),QHe:{useEffect:fn=>fn()},ZHe:(owner,model)=>owner.set({},old=>old.includes(model)?old:[...old,model]),nUe:(show,_ignored,content,dismiss)=>({showAnnouncement:show,announcementContent:content,dismissAnnouncement:dismiss})};
 vm.runInNewContext(code,context);let announcement=context.rUe();assert.equal(announcement.showAnnouncement,true);announcement.dismissAnnouncement();await write;
 const next=fixture({persistedStores:stores});seen=(await next.window.__DSH_NATIVE_CACHE__.restoreAtoms())['seen-model-upgrade-list'];announcement=context.rUe();assert.equal(announcement.showAnnouncement,false,'the exact renderer hook must consume the retained dismissal');
});

test('authenticated sidebar preparation seeds the scoped plugin directory before chrome loads',async()=>{
 const f=fixture(),cache=f.window.__DSH_NATIVE_CACHE__,seen=[];await f.flush();
 f.window.__DSH_NATIVE_WORKBENCH__={seedCachedDefinitions:x=>seen.push(x)};await cache.saveMeta('plugin-definitions',[{id:'agenda',label:'日程'}]);await cache.saveMeta('auth-locked',false);
 await cache.prepareSidebarBootstrap({initialSidebarBootstrap:{catalogEntries:[],globalStateEntries:[]}});assert.equal(seen.length,1);assert.equal(seen[0][0].id,'agenda');
 await cache.saveMeta('auth-locked',true);await cache.prepareSidebarBootstrap({initialSidebarBootstrap:{catalogEntries:[],globalStateEntries:[]}});assert.equal(seen.length,1,'a locked login cannot reveal cached private shortcuts');await cache.close();
});

 test('a validated new source replaces a retired source with a numerically higher revision',async()=>{
 const stores=new Map(),key='read:'+JSON.stringify(['thread/read',{includeTurns:false,threadId}]);
 stores.set('meta',new Map([['catalog-generation',{key:'catalog-generation',value:'source-1'}]]));
 stores.set('records',new Map([[key,{key,scope:'ai',kind:'history',threadId,sourceGeneration:'retired-source',generation:'old-body',revision:900000,deleted:false,payload:{method:'thread/read',params:{threadId,includeTurns:false},result:{thread:{id:threadId,status:{type:'idle'}}}}}]]));
 const f=fixture({persistedStores:stores});try{await f.flush();await f.window.__DSH_NATIVE_CACHE__.put({key,scope:'ai',kind:'history',threadId,sourceGeneration:'source-1',generation:'thread-1',revision:1,deleted:false,payload:{method:'thread/read',params:{threadId,includeTurns:false},result:{thread:{id:threadId,name:'saved',status:{type:'idle'}}}}},{expectedGeneration:'source-1'});
 assert.equal(stores.get('records').get(key).sourceGeneration,'source-1');
 assert.equal(stores.get('records').get('thread:'+threadId).payload.displayTitle,'saved');
 const restarted=fixture({persistedStores:stores});try{await restarted.flush();for(let i=0;i<8;i++)assert.equal((await restarted.window.__DSH_NATIVE_CACHE__.catalog.readEntries([{hostId:'local',threadId}])).length,1);assert.equal(restarted.network.length,0,'reopen cannot restart missing-catalog requests');}finally{await restarted.window.__DSH_NATIVE_CACHE__.close();}
 assert.equal(await f.window.__DSH_NATIVE_CACHE__.put({...stores.get('records').get(key),sourceGeneration:'retired-source',revision:9999999},{expectedGeneration:'retired-source'}),false,'a late retired source cannot overwrite this lifetime');
 assert.equal(stores.get('records').get(key).sourceGeneration,'source-1');
 }finally{await f.window.__DSH_NATIVE_CACHE__.close();}
 });


test('acknowledged settings and subscribed live values are not held by a stalled projection',async()=>{
 const f=fixture({stallWrite:true}),updates=[],callbacks=[];let writes=0;
 f.rows('meta').set('settings',{key:'settings',value:{values:{theme:'light'},configuredValues:{theme:'light'}}});
 const host=await f.window.__DSH_LOCAL_APP_HOST__(Promise.resolve({settings:{write:async()=>{writes++;},subscribe:async(_key,callback)=>{callbacks.push(callback);return {dispose(){}};},readAll:async()=>({values:{theme:'light'},configuredValues:{theme:'light'}})}}));
 await host.settings.subscribe('theme',value=>updates.push(value));await f.flush();assert.equal(callbacks.length,1);
 let complete=false;const writing=host.settings.write('theme','dark').then(()=>{complete=true;});await f.flush();
 assert.equal(complete,true,'an accepted Native settings write cannot await display persistence');await writing;assert.equal(writes,1);assert.equal(updates.at(-1).effective,'dark');assert.equal((await host.settings.read('theme')).effective,'dark');assert.equal((await host.settings.readAll()).values.theme,'dark');
 let received=false;const live=callbacks[0]({effective:'system',configured:'system'}).then(()=>{received=true;});await f.flush();assert(received);await live;assert.equal(updates.at(-1).effective,'system');assert.equal((await host.settings.read('theme')).effective,'system');assert.equal(f.abortCount(),0);await f.window.__DSH_NATIVE_CACHE__.close();
});
test('settings Native failures remain failures and a replaced host cannot publish an old acknowledgement',async()=>{
 const f=fixture(),updates=[],error=Error('fixture Native setting rejection');let acknowledge;
 const host=await f.window.__DSH_LOCAL_APP_HOST__(Promise.resolve({settings:{write:async key=>{if(key==='fail')throw error;return new Promise(resolve=>{acknowledge=resolve;});},subscribe:async()=>({dispose(){}})}}));
 await host.settings.subscribe('theme',value=>updates.push(value));await assert.rejects(host.settings.write('fail','dark'),e=>e===error);const prior=updates.length,writing=host.settings.write('theme','dark');await f.flush();assert(acknowledge);f.window.__DSH_RESET_APP_HOST__();acknowledge();await writing;await f.flush();assert.equal(updates.length,prior);await f.window.__DSH_NATIVE_CACHE__.close();
});
test('authentication lock is immediate even when its durable projection stalls',async()=>{
 const f=fixture({stallWrite:true});await f.flush();f.rows('meta').set('auth-locked',{key:'auth-locked',value:false});assert.equal(await f.window.__DSH_NATIVE_CACHE__.meta('auth-locked'),false);f.window.dispatchEvent(new f.context.CustomEvent('dsh:authentication-required'));
 assert.equal(await f.window.__DSH_NATIVE_CACHE__.meta('auth-locked'),true,'login loss must fence cached adoption before disk commit');assert.equal(f.abortCount(),0);await f.window.__DSH_NATIVE_CACHE__.close();
});
test('an older auth metadata read or lock commit cannot undo a newer verified session state',async()=>{
 const f=fixture(),cache=f.window.__DSH_NATIVE_CACHE__;f.rows('meta').set('auth-locked',{key:'auth-locked',value:false});const reading=cache.meta('auth-locked'),locked=cache.saveMeta('auth-locked',true);assert.equal(await reading,true);await locked;
 const oldLock=cache.saveMeta('auth-locked',true),newSession=cache.saveMeta('auth-locked',false);await oldLock;assert.equal(await cache.meta('auth-locked'),false);await newSession;await cache.close();
});
test('an optional local attachment lookup has a cache deadline and late results cannot reopen the old preview',async()=>{
 const f=fixture();let finish;f.window.__DSH_ANDROID_BRIDGE__={resolveDeliverable:()=>new Promise(resolve=>{finish=resolve;})};let done=false;const read=f.window.__DSH_LOCAL_DELIVERABLE__({path:'/fixture/image.png'}).then(result=>{done=true;return result;});await until(()=>done,1000);assert.equal(await read,null);finish({available:true,path:'/fixture/image.png'});await f.flush();assert.equal(await read,null);await f.window.__DSH_NATIVE_CACHE__.close();
});
test('available local attachments preserve their exact cached version without remote guessing',async()=>{
 const f=fixture(),file={available:true,path:'/fixture/image.png',version:'confirmed-version',url:'/fixture/local-image'};f.window.__DSH_ANDROID_BRIDGE__={resolveDeliverable:async()=>file};assert.equal((await f.window.__DSH_LOCAL_DELIVERABLE__({path:file.path})).version,file.version);assert.equal(await f.window.__DSH_LOCAL_DELIVERABLE__({hostId:'other',path:file.path}),null);await f.window.__DSH_NATIVE_CACHE__.close();
});


test('ordinary renderer filesystem home uses the epoch cache through a prototype method and preserves manager identity',async()=>{
 const f=fixture();await f.flush();const initial=await readFile(process.env.DSH_SUBMISSION_INITIAL||new URL('../../../runtime/critical-path-isolation-20261005/pass8/candidate/android-ui/files/official-patched-v1164/assets/app-initial-cadb12d4a15e.js',import.meta.url),'utf8');const at=initial.indexOf('getCodexHome(){'),end=initial.indexOf('ensureDirectory(',at);assert(at>0&&end>at);
 let reads=0;f.context.readHome=()=>{reads++;return Promise.resolve('/fresh/home');};vm.runInContext('globalThis.client=new(class {#brand=42;filesystem={initialization:{readCodexHome:readHome}};'+initial.slice(at,end)+' brand(){return this.#brand}})();',f.context);
 const start=source.indexOf("  if(typeof client.getCodexHome==='function')"),stop=source.indexOf('  const restoreSelectedTier=',start);assert(start>0&&stop>start);vm.runInContext(source.slice(start,stop),f.context);const client=f.context.client;
 f.window.__DSH_HOST_METADATA_EPOCH__('front-1');const request={type:'fetch',url:'vscode://codex/codex-home',body:'{"hostId":"local"}',requestId:'confirmed-home'};await f.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',request,()=>{});f.window.__DSH_IPC_CACHE_RESPONSE__({type:'fetch-response',requestId:request.requestId,responseType:'success',bodyJsonString:'{"codexHome":"/confirmed/home"}'});
 assert.equal(await client.getCodexHome(),'/confirmed/home');assert.equal(reads,0);assert.equal(Object.hasOwn(client,'getCodexHome'),false);assert.equal(client.brand(),42);
 f.window.__DSH_IPC_CACHE_RESPONSE__({type:'codex-app-server-connection-changed',state:'disconnected'});assert.equal(await client.getCodexHome(),'/confirmed/home');assert.equal(reads,0);
 f.window.__DSH_HOST_METADATA_EPOCH__('front-2');assert.equal(await client.getCodexHome(),'/fresh/home');assert.equal(reads,1);
 f.window.dispatchEvent(new f.context.CustomEvent('dsh:authentication-required'));assert.equal(await client.getCodexHome(),'/fresh/home');assert.equal(reads,2);assert.equal(client.brand(),42);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(process.env.DSH_TEST_CACHE_SOURCE||new URL('../public/native-local-cache.js',import.meta.url),'utf8');
const start=source.indexOf(' const hiddenThreads='),end=source.indexOf(' const diagnostics=',start);
assert(start>=0&&end>start);
const parent='11111111-1111-4111-a111-111111111111',child='22222222-2222-4222-a222-222222222222';
const sources=['subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther',{subAgent:'review'},{subagent:{thread_spawn:{parent_thread_id:parent}}},JSON.stringify({subagent:{thread_spawn:{parent_thread_id:parent}}}),{subAgent:{thread_spawn:{parent_thread_id:parent,depth:1,agent_path:'/root/reviewer'}}}];
function fixture(){const window={dispatchEvent(){}},c={window,Event:class{},queueMicrotask:f=>f()};vm.createContext(c);vm.runInContext(source.slice(start,end)+';globalThis.threadVisible=listableThread;globalThis.entryVisible=listableEntry;',c);return c;}
test('parent-bound non-interactive metadata stays out of the main directory even when the source field is omitted',()=>{const f=fixture();assert.equal(f.threadVisible({id:child,parentThreadId:parent,canAcceptDirectInput:false,name:'Synthetic agent'}),false);});
function detailFixture({online=false,head=true,foreign=false}={}){
 const f=fixture(),thread={id:child,cwd:'/fixture',source:{subAgent:{thread_spawn:{parent_thread_id:parent}}},threadSource:'subagent',parentThreadId:parent,canAcceptDirectInput:false,name:'Synthetic child'},header={scope:foreign?'zyy':'ai',kind:'history',payload:{result:{thread}}},calls=[];
 Object.assign(f,{scope:{id:'ai'},volatileCatalog:null,structuredClone,memoryMeta:new Map(),navigator:{onLine:online},get:async key=>key.startsWith('read:')?(head?header:null):{scope:'ai',kind:'catalog',payload:{threadId:child,nativeThread:thread}},meta:async()=>null,readKey:()=> 'read:head',fetchRead:async(method,params)=>{calls.push({method,params});return header;},prepareMissingCatalogEntry:()=>{throw Error('unexpected background warming');},rememberPinnedEntries:async()=>{},ipcReadKey:()=>'',calls});f.window.__DSH_EXECUTION_CONNECTED__=online;
 const a=source.indexOf(' async function cachedCatalogRecord('),b=source.indexOf(' async function catalogPage(',a),c=source.indexOf(' async function readEntries('),d=source.indexOf(' async function rememberPinnedEntries(',c);vm.runInContext(source.slice(a,b)+source.slice(c,d)+';globalThis.lookup=readEntries;',f);return f;
}
test('explicit child ID metadata is readable offline while directory/bootstrap lookups still exclude it',async()=>{const f=detailFixture(),keys=[{hostId:'local',threadId:child}];const rows=await f.lookup(keys);assert.equal(rows.length,1);assert.equal(rows[0].nativeThread.id,child);assert.equal(rows[0].nativeThread.canAcceptDirectInput,false);assert.equal((await f.lookup(keys,{directoryOnly:true})).length,0);assert.equal(f.calls.length,0);assert.equal(f.entryVisible(rows[0]),false);});
test('explicit child metadata uses one scoped head read and never warms the child directory',async()=>{const f=detailFixture({online:true,head:false});const rows=await f.lookup([{hostId:'local',threadId:child}]);assert.equal(rows.length,1);assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),[{method:'thread/read',params:{threadId:child,includeTurns:false}}]);});
test('an explicit child lookup cannot use a head from another workspace',async()=>{const f=detailFixture({foreign:true});assert.equal((await f.lookup([{hostId:'local',threadId:child}])).length,0);});
for(const value of sources)test('Native subagent source never enters a titled active directory: '+JSON.stringify(value),()=>{
 const f=fixture(),t={id:child,name:'A real agent name',preview:'Has work',status:{type:'active'},source:value};
 assert.equal(f.threadVisible(t),false);assert.equal(f.entryVisible({threadId:child,sourceKind:typeof value==='string'?value:'custom',nativeThread:t}),false);
 assert.equal(f.window.__DSH_THREAD_LIST_VISIBILITY__.isHidden(child),true);
});
test('legacy entry sourceKind filters children even without nativeThread',()=>{
 const f=fixture();assert.equal(f.entryVisible({threadId:child,sourceKind:'subAgentThreadSpawn',displayTitle:'Saved child'}),false);
});
test('old pinned/sidebar records cannot resurrect an already classified child',()=>{
 const f=fixture();assert.equal(f.threadVisible({id:child,source:{subAgent:'compact'},name:'Child'}),false);
 assert.equal(f.entryVisible({threadId:child,displayTitle:'Old pin'}),false);
 assert.equal(f.threadVisible({id:child,name:'Partial old metadata',status:{type:'active'}}),false);
});
test('temporary title work is excluded even with an active status and a title',()=>{
 const f=fixture();for(const marker of [{ephemeral:true},{threadSource:'thread_title'}])assert.equal(f.threadVisible({id:child,name:'Internal',...marker}),false);
});
test('interactive exec/appServer/custom threads and ordinary user forks stay visible',()=>{
 for(const value of ['cli','vscode','exec','appServer','unknown',{custom:'user-owned'}]){
  const f=fixture();assert.equal(f.threadVisible({id:parent,source:value,name:'User conversation',forkedFromId:child}),true);
 }
});
test('a hidden unused user thread becomes visible after the first real prompt',()=>{
 const f=fixture();assert.equal(f.threadVisible({id:parent,source:'vscode',status:{type:'idle'}}),false);
 assert.equal(f.threadVisible({id:parent,source:'vscode',preview:'First prompt'}),true);
});
test('old known child pin is neither read again nor retained in the sidebar snapshot',async()=>{
 const f=fixture(),parentEntry={hostId:'local',threadId:parent,nativeThread:{id:parent,name:'User',source:'exec'}},childEntry={hostId:'local',threadId:child,nativeThread:{id:child,name:'Child',source:sources.at(-1)}};
 f.threadVisible(childEntry.nativeThread);
 const saved=new Map([['pins',{threadIds:[child,parent]}],['pinned-sidebar-v1',{scope:'ai',entries:{[child]:childEntry,[parent]:parentEntry}}]]);let heads=0;
 Object.assign(f,{scope:{id:'ai'},pinnedEpoch:0,pinnedEmit:null,broadcast:null,ipcReadKey:()=> 'pins',meta:async key=>saved.get(key),saveMeta:async(key,value)=>saved.set(key,value),withWriter:async(_,work)=>work(),
  cachedCatalogRecord:async id=>({payload:id===child?childEntry:parentEntry}),navigator:{onLine:true},fetchRead:async()=>{heads++;return {payload:{result:{thread:childEntry.nativeThread}}};}});
 f.window.__DSH_EXECUTION_CONNECTED__=true;
 const a=source.indexOf(' const toEntry='),b=source.indexOf(' async function prepareSidebarBootstrap(',a);
 vm.runInContext(source.slice(a,b)+';globalThis.preparePins=preparePinnedSidebar;',f);
 await f.preparePins({threadIds:[child,parent]});assert.equal(heads,0);assert.deepEqual(Object.keys(saved.get('pinned-sidebar-v1').entries),[parent]);
});

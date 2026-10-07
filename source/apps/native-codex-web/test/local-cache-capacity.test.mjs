import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(process.env.DSH_TEST_CACHE_SOURCE||new URL('../public/native-local-cache.js',import.meta.url),'utf8');
if(process.env.DSH_STOP_SCOPE)assert.equal((await readFile(process.env.DSH_STOP_SCOPE,'utf8')).split(source.trim()).length-1,1);
const start=source.indexOf(' function localCacheStoragePolicy('),end=source.indexOf(' async function durableCommitCatalog(',start);
assert(start>=0&&end>start);
const code=source.slice(start,end)+'\nglobalThis.policy=localCacheStoragePolicy;globalThis.run=evict;';
const gb=1024**3;
function fixture({android=true,quota=1024*gb,rows=[],visible=true,dirty=true,pinned=[],override=null}={}){
 const deleted=[],transactions=[],context={androidReader:android,cacheMaintenanceDirty:dirty,document:{visibilityState:visible?'visible':'hidden'},navigator:{storage:{estimate:async()=>quota===null?null:{quota}}},Date,CACHE_IO_TIMEOUT_MS:1200,remaining:()=>1200,location:{pathname:'/local/active'},priorityPinned:new Set(pinned),cacheCompletion:()=>Promise.resolve(),cacheCursor:async(_cursor,_tx,_label,_budget,visit)=>{for(const value of rows)visit({value});},cacheDb:async()=>({transaction(names,mode){transactions.push({names:[...names],mode});return {objectStore(name){assert(['records','usage'].includes(name));return {delete(key){deleted.push({name,key});},index(){return {openCursor(){}};}};}};}})};
 vm.runInNewContext(override||code,context);return {context,deleted,transactions,run:context.run,policy:context.policy};
}
const nine=()=>Array.from({length:3},(_,i)=>({key:'turn:'+i,threadId:'idle-'+i,bytes:3*gb}));
test('9 GB of idle conversation projections remain stored under the new ceiling',async()=>{const f=fixture({rows:nine()});await f.run();assert.equal(f.deleted.length,0);assert.equal(f.policy({quota:1024*gb}).effectiveBudgetBytes,10*gb);});
test('excess projections are bounded while the active conversation and pinned first paint survive',async()=>{
 const pinKey='read:'+JSON.stringify(['thread/read',{threadId:'pinned'}]);const rows=[{key:'turn:active',threadId:'active',bytes:3*gb},{key:pinKey,threadId:'pinned',bytes:3*gb},{key:'turn:old1',threadId:'idle1',bytes:3*gb},{key:'turn:old2',threadId:'idle2',bytes:3*gb}];
 const f=fixture({rows,pinned:['pinned']});await f.run();assert.deepEqual(f.deleted.filter(x=>x.name==='records').map(x=>x.key),['turn:old1','turn:old2']);assert.deepEqual(f.transactions,[{names:['records','usage'],mode:'readwrite'}]);
});
test('system quota and the existing browser ceiling still bound storage; absent Android quota uses the requested capacity',()=>{
 const a=fixture(),p=fixture({android:false});assert.equal(a.policy(null).effectiveBudgetBytes,10*gb);assert.equal(a.policy({quota:gb}).effectiveBudgetBytes,.75*gb);assert.equal(p.policy({quota:1024*gb}).effectiveBudgetBytes,128*1024**2);assert.equal(p.policy(null).effectiveBudgetBytes,512*1024**2*.15);
});
test('capacity increase does not introduce background scans when hidden or unchanged',async()=>{for(const options of [{visible:false},{dirty:false}]){const f=fixture({...options,rows:nine()});await f.run();assert.equal(f.transactions.length,0);}});
if(process.env.DSH_OLD_CACHE_SOURCE){
 const old=await readFile(process.env.DSH_OLD_CACHE_SOURCE,'utf8'),begin=old.indexOf(' async function evict(){'),stop=old.indexOf(' async function durableCommitCatalog(',begin);assert(begin>=0&&stop>begin);
 test('published previous policy reproduces eviction below the new ceiling',async()=>{const f=fixture({rows:nine(),override:old.slice(begin,stop)+'\nglobalThis.run=evict;'});await f.run();assert(f.deleted.some(x=>x.name==='records'),'previous 8 GB policy must evict the 9 GB fixture');});
}

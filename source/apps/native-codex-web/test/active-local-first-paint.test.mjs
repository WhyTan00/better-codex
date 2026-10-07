import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(process.env.DSH_TEST_CACHE_SOURCE||new URL('../public/native-local-cache.js',import.meta.url),'utf8');
const id='11111111-1111-4111-a111-111111111111';
const start=source.indexOf(' function hasVisibleHistory('),end=source.indexOf(' async function refreshCommitted(',start);
function fixture(){
 const turns=[],snapshot={confirmedAt:1,applied:false},ctx={processTurns:client=>client.getConversation().turns,nativeClient:{getConversation:()=>({turns})},recoveryEpoch:new Map(),nativeEventEpoch:new Map([[id,1]]),nativeActivity:new Map([[id,100]])};
 vm.createContext(ctx);assert(start>=0&&end>start,'first-paint guard must exist');vm.runInContext(source.slice(start,end),ctx);
 const guard=ctx.localHistoryGuard(id,snapshot,()=>true,1);return{ctx,turns,snapshot,guard};
}
test('connection replay cannot starve the first local history paint in an empty view',()=>{
 const f=fixture();assert.equal(f.snapshot.initialLocalPaint,true);f.ctx.nativeEventEpoch.set(id,10);assert.equal(f.guard(),true);
 f.turns.push({items:[{id:'cached'}]});f.snapshot.applied=true;assert.equal(f.guard(),true);f.ctx.nativeEventEpoch.set(id,11);assert.equal(f.guard(),false,'normal fence resumes after body adoption');
});
test('a live body arriving during the local process read wins over cached first paint',()=>{
 const f=fixture();f.ctx.nativeEventEpoch.set(id,2);f.turns.push({items:[{id:'live'}]});assert.equal(f.guard(),false);
});
test('existing prompt or process items retain the strict stale-history fence',()=>{
 const f=fixture();f.turns.push({items:[{id:'prompt'}]});const snapshot={confirmedAt:1};const guard=f.ctx.localHistoryGuard(id,snapshot,()=>true,1);assert.equal(snapshot.initialLocalPaint,false);assert.equal(guard(),false);
});
test('rewrite, navigation, source generation and client replacement cannot borrow empty-view permission',()=>{
 for(const change of [f=>f.ctx.recoveryEpoch.set(id,1),f=>f.ctx.nativeClient={},f=>f.ctx.nativeClient.disposed=true]){const f=fixture();change(f);assert.equal(f.guard(),false);}
 const f=fixture();const guard=f.ctx.localHistoryGuard(id,{},()=>false,1);assert.equal(guard(),false);
});
test('saved archive and verified reads keep their original event fences',()=>{
 for(const snapshot of [{savedArchive:true},{verifiedNative:true}]){const f=fixture();const guard=f.ctx.localHistoryGuard(id,snapshot,()=>true,1);assert.equal(snapshot.initialLocalPaint,false);f.ctx.nativeEventEpoch.set(id,2);assert.equal(guard(),false);}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CacheWorker} from '../src/sync-cache-worker.mjs';

async function fixture(t){
 const dir=await mkdtemp(path.join(tmpdir(),'dsh-warm-policy-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const warmed=[],reads=[],frames=[],threads=Array.from({length:40},(_,i)=>({id:String(i),updatedAt:1,status:{type:'idle'}}));
 const a={ready:true,cachePersistence:'disk',storeID:'disk',ack:0,queuedBytes:0,bufferBytes:0,native:{state:'ready'},requests:new Map(),controlQueue:[],readQueue:[],feed:{sequence:0,interests:new Map(),cache:new Map(),catalog:async()=>({data:threads,nextCursor:null}),readSnapshot:async(_scope,id,cursor)=>{assert.equal(cursor,null,'cold pages must be on demand');warmed.push(id);return {thread:{id},nextCursor:'old-page'};},nativeCache:{read:async(_scope,method,params)=>reads.push([method,params.threadId])},publish(value){frames.push(value);a.ack=++this.sequence;return this.sequence;}}};
 const w=new CacheWorker({adapter:a,stateFile:path.join(dir,'progress.json'),scopes:['ai'],now:()=>100000});return {w,a,warmed,reads,frames};
}
test('warm only recent or used heads; old pages are never traversed or republished',async t=>{
 const f=await fixture(t);f.w.hot.set('ai:39',1);await f.w.run();assert.equal(f.warmed.length,21);assert.equal(f.warmed[0],'39');assert(!f.warmed.includes('30'));assert.equal(f.reads.length,42);assert(!f.frames.some(v=>v.event.type==='historyPage'));assert(f.frames.some(v=>v.event.type==='catalogComplete'));
 await f.w.run();assert.equal(f.warmed.length,21,'unchanged warmed heads should be reused');
});
test('volatile cloud cache starts no catalog or history work',async t=>{
 const f=await fixture(t);f.a.cachePersistence='memory';await f.w.run();assert.equal(f.frames.length,0);assert.equal(f.warmed.length,0);await assert.rejects(f.w.ready(),/volatile cache/);
});
test('foreground activity preempts background work, which resumes only after quiet',async t=>{
 const f=await fixture(t);let now=100000,waits=0;f.w.now=()=>now;f.w.wait=async()=>{waits++;now+=500;};f.w.touch('ai','39');await f.w.ready();assert(waits>=3);assert(f.w.hot.has('ai:39'));
 f.a.feed.cache.set('39',{turns:[{status:'inProgress'}]});f.w.wait=async()=>{waits++;f.a.feed.cache.clear();};await f.w.ready();assert(waits>=4);
});

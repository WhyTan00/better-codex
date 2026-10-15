import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {NativeReadCache} from '../src/native-read-cache.mjs';import {CacheService} from '../src/cache-service.mjs';
const live='11111111-1111-4111-a111-111111111111',gone='22222222-2222-4222-a222-222222222222';
async function setup(t){const dir=await mkdtemp(join(tmpdir(),'retirement-busy-'));const boundary={loadedIds:async()=>new Set([live]),call:async()=>({data:[{id:live,cwd:'/workspace/example',name:'synthetic'}],nextCursor:null})};const seed=new NativeReadCache(dir,{boundary});seed.put('ai','thread:'+gone,'catalog',gone,null,{deleted:true});seed.put('ai','catalog-status','catalog-status','',{complete:true});seed.close();const service=await CacheService.create({dir,boundary});t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});return {dir,boundary,service};}
test('busy optional SQLite retains real durable catalog retirement on fresh Native scan after restart',async t=>{
 const f=await setup(t),holder=new DatabaseSync(join(f.dir,'native-read.sqlite'));holder.exec('BEGIN IMMEDIATE');let blocked;
 try{blocked=f.service.rpc('cache.setMeta',['synthetic-lock','1']);await new Promise(r=>setTimeout(r,20));const at=performance.now(),page=await f.service.snapshotCatalog('ai',{fresh:true});assert(performance.now()-at<250);assert.equal(page.hasMore,false);const retired=page.records.find(r=>r.threadId===gone);assert(retired,'known retirement disappeared behind cache budget');assert.equal(retired.deleted,true);assert(retired.revision>page.records.find(r=>r.threadId===live).revision);assert.equal(retired.payload,null);
 }finally{holder.exec('ROLLBACK');holder.close();await blocked;}
});
test('Native revival wins over the startup retirement while cache is busy',async t=>{
 const f=await setup(t);f.boundary.call=async()=>({data:[{id:gone,cwd:'/workspace/example',status:{type:'idle'}}],nextCursor:null});const holder=new DatabaseSync(join(f.dir,'native-read.sqlite'));holder.exec('BEGIN IMMEDIATE');let blocked;
 try{blocked=f.service.rpc('cache.setMeta',['synthetic-lock','1']);await new Promise(r=>setTimeout(r,20));const page=await f.service.snapshotCatalog('ai',{fresh:true});const rows=page.records.filter(r=>r.threadId===gone);assert.equal(rows.length,1);assert.equal(rows[0].deleted,false);
 }finally{holder.exec('ROLLBACK');holder.close();await blocked;}
});

import test from 'node:test';import assert from 'node:assert/strict';import {ReadCache} from '../public/shell/read-cache.mjs';
test('device reads respect workspace keys, expiry and budget without browser storage',async()=>{
 const c=new ReadCache({storage:null,maxBytes:100,ttl:1000});await c.put('ai:list',{rows:['one']});await c.put('secondary:list',{rows:['two']});assert.deepEqual((await c.get('ai:list')).value,{rows:['one']});assert.deepEqual((await c.get('secondary:list')).value,{rows:['two']});assert.equal(await c.put('huge','x'.repeat(200)),false);
 c.memory.get('ai:list').savedAt=1;assert.equal(await c.get('ai:list'),null);await c.clear();assert.equal(await c.get('secondary:list'),null);
});

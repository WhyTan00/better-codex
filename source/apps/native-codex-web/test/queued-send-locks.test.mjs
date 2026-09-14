import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {QueuedSendLocks} from '../src/queued-send-locks.mjs';
const message={conversationId:'thread',messageId:'message',lockId:'lock-1'};
test('only one native queue consumer can acquire; successful send stays deduplicated',()=>{
 const db=new DatabaseSync(':memory:'),locks=new QueuedSendLocks(db);
 assert.equal(locks.acquire('ai',message,'one').acquired,true);assert.equal(locks.acquire('ai',{...message,lockId:'lock-2'},'two').acquired,false);
 assert.throws(()=>locks.release('ai',{...message,sent:false},'two'),e=>e.code===409);
 locks.release('ai',{...message,sent:true},'one');assert.equal(locks.acquire('ai',{...message,lockId:'lock-2'},'two').acquired,false);db.close();
});
test('failed sends release their lease, expired owners cannot release a replacement, scopes stay separate',()=>{
 const db=new DatabaseSync(':memory:');let now=0;const locks=new QueuedSendLocks(db,{now:()=>now,leaseMs:100});
 locks.acquire('ai',message,'one');assert.equal(locks.acquire('secondary',message,'two').acquired,true);
 locks.release('ai',{...message,sent:false},'one');assert.equal(locks.acquire('ai',message,'two').acquired,true);
 now=101;const changed={...message,lockId:'lock-new'};assert.equal(locks.acquire('ai',changed,'three').acquired,true);assert.throws(()=>locks.release('ai',{...message,sent:false},'two'),e=>e.code===409);db.close();
});

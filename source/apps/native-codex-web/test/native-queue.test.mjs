import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Journal} from '../src/journal.mjs';
import {OfficialBoundary} from '../src/official-boundary.mjs';
import {NativeQueue} from '../src/native-queue.mjs';
const threadId='00000000-0000-4000-8000-4ba7215b54d2',otherId='00000000-0000-4000-8000-f82fe242e2a8';
function fixture(t){
 const dir=mkdtempSync(tmpdir()+'/betterCodex-native-queue-'),journal=new Journal(dir),pending=[],calls=[];
 const native={start:async()=>{},rpc:async(method,p)=>{
  calls.push({method,p});
  if(method==='thread/read')return {thread:{id:p.threadId,cwd:p.threadId===threadId?'${BETTER_CODEX_WORKSPACE}':'${BETTER_CODEX_SECONDARY_WORKSPACE}',status:{type:'active'}}};
  if(method==='thread/loaded/list')return {data:[threadId,otherId]};
  if(method==='thread/queue/list')return {data:structuredClone(pending),nextCursor:null};
  if(method==='thread/queue/add'){const item={id:randomUUID(),clientUserMessageId:p.clientUserMessageId,input:p.input};pending.push(item);return {queuedSubmission:item};}
  if(method==='thread/queue/update'){const item=pending.find(i=>i.id===p.queuedSubmissionId);item.input=p.input;return {queuedSubmission:item};}
  if(method==='thread/queue/delete'){const index=pending.findIndex(i=>i.id===p.queuedSubmissionId);if(index<0)return {deleted:false};pending.splice(index,1);return {deleted:true};}
  if(method==='thread/queue/reorder'){pending.sort((a,b)=>p.queuedSubmissionIds.indexOf(a.id)-p.queuedSubmissionIds.indexOf(b.id));return {};}
  if(method==='turn/steer')return {turnId:'active-turn'};
  throw Error(method);
 }};
 const boundary=new OfficialBoundary({native,journal}),queue=new NativeQueue({boundary,journal});
 t.after(()=>{journal.close();rmSync(dir,{recursive:true,force:true});});
 return {queue,boundary,journal,pending,calls};
}
const message=(text='queued')=>({id:randomUUID(),cwd:'${BETTER_CODEX_WORKSPACE}',context:{text}});
async function sync(queue,messages,extra={}){const s=await queue.read('ai',threadId);return queue.command('ai',{commandId:randomUUID(),threadId,operation:'sync',revision:s.revisions[threadId],messages,inputs:Object.fromEntries(messages.map(m=>[m.id,[{type:'text',text:m.context.text}]])),...extra},'test-client');}
test('persistent Native queue retains full UI metadata, deduplicates ACK replay, and reopens',async t=>{
 const {queue,journal,boundary,pending,calls}=fixture(t),m=message();m.context.attachments=[{name:'reference'}];
 const s=await queue.read('ai',threadId),request={commandId:randomUUID(),threadId,operation:'sync',revision:s.revisions[threadId],messages:[m],inputs:{[m.id]:[{type:'text',text:'queued'}]}};
 const first=await queue.command('ai',request,'one');assert.deepEqual(await queue.command('ai',request,'two'),first);
 assert.equal(pending.length,1);assert.equal(calls.filter(c=>c.method==='thread/queue/add').length,1);
 assert.deepEqual((await new NativeQueue({boundary,journal}).read('ai',threadId)).state[threadId],[m]);
});
test('stale tab cannot overwrite another queue edit or a natively consumed message',async t=>{
 const {queue,pending}=fixture(t),a=message(),b=message('next');await sync(queue,[a]);const stale=await queue.read('ai',threadId);await sync(queue,[a,b]);
 await assert.rejects(sync(queue,[a],{revision:stale.revisions[threadId]}),e=>e.code===409);assert.equal(pending.length,2);
 pending.shift();await queue.read('ai',threadId);await assert.rejects(sync(queue,[a,b]),e=>e.code===409);assert.equal(pending.length,1);
});
test('edit, reorder and explicit removal update the authoritative Native queue',async t=>{
 const {queue,pending}=fixture(t),a=message(),b=message('second');await sync(queue,[a,b]);a.context.text='edited';await sync(queue,[b,a]);assert.deepEqual(pending.map(m=>m.input[0].text),['second','edited']);
 await sync(queue,[a]);assert.equal(pending.length,1);assert.equal(pending[0].clientUserMessageId,a.id);
});
test('all attachment paths and workspace membership are checked before queue mutation',async t=>{
 const {queue,pending}=fixture(t),a=message();await sync(queue,[a]);const b=message();
 await assert.rejects(sync(queue,[b],{inputs:{[b.id]:[{type:'localImage',path:'/etc/passwd'}]}}),e=>e.code===403);assert.equal(pending.length,1);
 await assert.rejects(queue.read('ai',otherId),e=>e.code===404);
});
test('manual steer first claims the queued item and cannot send it twice',async t=>{
 const {queue,boundary,pending,calls}=fixture(t),a=message();await sync(queue,[a]);boundary.active.set(threadId,'active-turn');
 const s=await queue.read('ai',threadId),request={commandId:randomUUID(),threadId,operation:'send-now',messageId:a.id,revision:s.revisions[threadId]};
 await queue.command('ai',request,'one');await queue.command('ai',request,'two');assert.equal(pending.length,0);assert.equal(calls.filter(c=>c.method==='turn/steer').length,1);
 assert(calls.findIndex(c=>c.method==='thread/queue/delete')<calls.findIndex(c=>c.method==='turn/steer'));
});
test('lost Native ACK retains unknown identity and never automatically re-adds',async t=>{
 const {queue,boundary,pending,calls}=fixture(t),rpc=boundary.native.rpc,a=message();
 boundary.native.rpc=async(m,p)=>{const r=await rpc(m,p);if(m==='thread/queue/add')throw Object.assign(Error('connection lost'),{code:503});return r;};
 await assert.rejects(sync(queue,[a]),e=>e.code===409);assert.equal(pending.length,1);
 pending.length=0;await queue.read('ai',threadId);await assert.rejects(sync(queue,[a]),e=>e.code===409);assert.equal(calls.filter(c=>c.method==='thread/queue/add').length,1);
});
test('an accepted queue receipt is queryable by its original command identity and scope',async t=>{
 const {queue}=fixture(t),m=message(),before=await queue.read('ai',threadId),id=randomUUID();const result=await queue.command('ai',{commandId:id,threadId,operation:'sync',revision:before.revisions[threadId],messages:[m],inputs:{[m.id]:[{type:'text',text:'queued'}]}},'test');assert.deepEqual(queue.requestStatus('ai',id),{requestId:id,state:'accepted',result});assert.equal(queue.requestStatus('secondary',id).state,'not_found');assert.throws(()=>queue.requestStatus('ai','bad'),e=>e.code===404);
});

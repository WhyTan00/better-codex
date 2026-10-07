import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(process.env.DSH_TEST_CACHE_SOURCE||new URL('../public/native-local-cache.js',import.meta.url),'utf8');
const begin=source.indexOf('  async function ensureSubmissionThreadLoaded('),end=source.indexOf('  target.sendRequest=',begin);
assert(begin>=0&&end>begin);
const id='11111111-1111-4111-a111-111111111111',other='22222222-2222-4222-a222-222222222222';
function fixture({status='idle',readId=id,resumeId=id,error,readGate,resumeGate}={}){
 const calls=[],cursors=[],executionReads=[];
 const context={client:{},Error,Set,original:async(method,params,options)=>{
  calls.push({method,params,options});
  if(method==='thread/read'){await readGate;if(error)throw error;return {thread:{id:readId,status:status==null?undefined:{type:status}}};}
  if(method==='thread/resume'){await resumeGate;return {thread:{id:resumeId,status:{type:'idle'},historyMode:'paginated'}};}
  throw Error('unrelated loaded-thread scan is forbidden');
 },rememberHistoryCursors:(...args)=>cursors.push(args)};
 const rpc=context.original;
 context.executionRead=(method,params,options)=>{executionReads.push(method);return rpc(method,params,options);};
 context.original=(method,params,options)=>{assert.notEqual(method,'thread/read','submission metadata must use the independent execution read path');return rpc(method,params,options);};
 vm.runInNewContext(source.slice(begin,end),context);
 return {calls,cursors,executionReads,prepare:(options={})=>context.ensureSubmissionThreadLoaded(id,options)};
}

for(const status of ['idle','active','systemError'])test(`fresh ${status} runtime status needs no loaded-list scan or implicit resume`,async()=>{
 const f=fixture({status}),options={signal:new AbortController().signal};await f.prepare(options);
 assert.deepEqual(f.calls.map(c=>c.method),['thread/read']);
 assert.deepEqual(f.executionReads,['thread/read']);
 assert.equal(f.calls[0].params.threadId,id);assert.equal(f.calls[0].params.includeTurns,false);assert.equal(f.calls[0].options,options);
 assert.equal(f.cursors.length,0);
});
test('fresh notLoaded resumes the same target once and retains authoritative cursor metadata',async()=>{
 const f=fixture({status:'notLoaded'});await f.prepare();
 assert.deepEqual(f.calls.map(c=>c.method),['thread/read','thread/resume']);
 assert.equal(f.calls[1].params.threadId,id);assert.equal(f.calls[1].params.excludeTurns,true);assert.equal(f.cursors[0][0],id);
});
for(const [name,values] of [['wrong read identity',{readId:other}],['missing status',{status:null}],['unknown future status',{status:'other'}],['wrong resume identity',{status:'notLoaded',resumeId:other}]])test(name+' cannot permit a send',async()=>{
 const f=fixture(values);await assert.rejects(f.prepare());assert.equal(f.cursors.length,0);
});
test('a failed fresh read is surfaced without converting uncertainty into a resume',async()=>{
 const error=Object.assign(Error('fixture read timeout'),{code:504}),f=fixture({error});
 await assert.rejects(f.prepare(),e=>e===error);assert.deepEqual(f.calls.map(c=>c.method),['thread/read']);
});
test('cancellation before or during a metadata read cannot later resume the target',async()=>{
 const before=new AbortController();before.abort();const first=fixture({status:'notLoaded'});
 await assert.rejects(first.prepare({signal:before.signal}),/取消/);assert.equal(first.calls.length,0);
 let release;const readGate=new Promise(r=>release=r),controller=new AbortController(),f=fixture({status:'notLoaded',readGate});
 const pending=f.prepare({signal:controller.signal});controller.abort();release();
 await assert.rejects(pending,/取消/);assert.deepEqual(f.calls.map(c=>c.method),['thread/read']);
});
test('cancellation while resume is pending prevents continuation and does not replay resume',async()=>{
 let release;const resumeGate=new Promise(r=>release=r),controller=new AbortController(),f=fixture({status:'notLoaded',resumeGate});
 const pending=f.prepare({signal:controller.signal});pending.catch(()=>{});
 for(let i=0;i<8;i++)await Promise.resolve();assert.equal(f.calls.length,2);
 controller.abort();release();await assert.rejects(pending,/取消/);assert.equal(f.calls.length,2);assert.equal(f.cursors.length,0);
});

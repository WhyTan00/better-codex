import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

const file=await readFile(new URL('../public/native-local-cache.js',import.meta.url),'utf8');
const dir=process.env.DSH_NOTIFICATION_UI_PACKAGE;
let source=file;
if(dir){const m=JSON.parse(await readFile(path.join(dir,'ui-release.json')));source=await readFile(path.join(dir,'files',m.files.find(f=>f.path.endsWith('/scope.js')).path),'utf8');}
const block=(s,a,b)=>s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)));
const id='11111111-1111-4111-a111-111111111111';
const user={id:'prompt',type:'userMessage',content:[{type:'text',text:'original user input'}]};
const final={id:'final',type:'agentMessage',phase:'final_answer',text:'Final reply\n```js\nconst result = 1;\n```',seeded:true};
const key=(method,params)=>'read:'+JSON.stringify([method,params]);
function fixture(options={},code=source){
 const turn={id:'turn',status:'inProgress',startedAt:100,itemsView:'summary',items:[user,{id:'partial',type:'agentMessage',phase:'commentary',text:'working'}],...options.turn};
 const stream={available:true,scope:'ai',threadId:id,sourceGeneration:'generation',epoch:'event-epoch',seq:75,updatedAt:200000,turns:[{id:'turn',status:'completed',startedAt:100,completedAt:200,items:[final],...options.live}],...options.stream};
 const wrap=(method,params,result)=>({scope:'ai',threadId:id,key:key(method,params),sourceGeneration:'generation',generation:'generation',revision:10,confirmedAt:100000,payload:{result},...options.record});
 const head=wrap('thread/read',{threadId:id,includeTurns:false},{thread:{id,updatedAt:100}});
 const summary=wrap('thread/turns/list',{threadId:id,limit:2,itemsView:'summary',sortDirection:'desc'},{data:[turn],nextCursor:'older-turns'});
 let diskReads=0;const ctx={scope:{id:'ai'},savedReadVersions:new Map(),rememberNativeItemHeads(){},Date,structuredClone,readKey:key,importRecord:r=>r,memoryMeta:new Map([['catalog-generation','generation']]),CACHE_IO_TIMEOUT_MS:1200,remaining:d=>Math.max(1,d-Date.now()),loadFinalRecovery:async()=>null,currentRecovery:()=>null,loadConfirmedUsers:async()=>null,acceptRecoverySnapshot:()=>true,meta:async()=> 'generation',get:async k=>{
  diskReads++;if(options.stalledDisk)return new Promise(()=>{});
  if(k.startsWith('read:["thread/read"'))return head;
  if(k.startsWith('read:["thread/turns/list"'))return summary;
  if(k.startsWith('read:["thread/items/list"'))return wrap('thread/items/list',{}, {data:[{item:user},{item:{id:'tool',type:'commandExecution'}},{item:{...final,text:'Final'}}].reverse(),nextCursor:'older-items'});
  return null;
 },window:{__DSH_FINAL_IDENTITY__:item=>item?.phase==='final_answer'&&item.type==='agentMessage'&&item.text?item.id:null,__DSH_ANDROID_BRIDGE__:{readThreadRecords:async()=>({scope:'ai',threadId:id,generation:'generation',records:[head,summary]}),readStream:async()=>stream}}};
 vm.runInNewContext(block(code,' const firstPaintImage=',' function summaryPagination(')+code.slice(code.indexOf(' const fullNativeUser='),code.indexOf('\n',code.indexOf(' const fullNativeUser=')))+block(code,' async function restoreConfirmedUsers(',' const validated=')+block(code,' function summaryPagination(',' // A compact, read-only replica')+block(code,' function finalFromSnapshot(',' function completesVisibleTurn('),ctx);
 return {ctx,turn,stream,head,summary,read:()=>ctx.window.__DSH_READ_COMMITTED_HISTORY__(id,{preferSummary:true}),get diskReads(){return diskReads;}};
}
test('committed terminal stream recovers full final reply and original input without waiting for IndexedDB or HTTP',async()=>{
 const f=fixture({stalledDisk:true});const snapshot=await Promise.race([f.read(),new Promise((_,reject)=>setTimeout(()=>reject(Error('blocked behind another history read')),100))]);
 assert.equal(f.diskReads,0);assert.equal(snapshot.completedFromStream,true);assert.equal(snapshot.streamCursor,75);
 assert.equal(snapshot.page.data[0].status,'completed');assert.equal(snapshot.page.data[0].completedAt,200);
 assert.deepEqual(Array.from(snapshot.page.data[0].items,i=>i.type),['userMessage','agentMessage']);
 assert.equal(snapshot.page.data[0].items.at(-1).text,final.text,'final Markdown code is preserved');
 assert.equal(f.ctx.finalFromSnapshot(snapshot).turnId,'turn');
 assert.deepEqual(JSON.parse(JSON.stringify(snapshot.itemsPaginationByTurnId.turn.oldestUserInput)),user.content);
 assert.equal(snapshot.itemsPaginationByTurnId.turn.hasLoadedOldest,false);assert.equal(snapshot.page.nextCursor,'older-turns');
 assert.equal(f.turn.status,'inProgress','the source record is not rewritten');
});
test('completed text alone, stream gaps, different turns, workspaces, and rewritten generations cannot create a completion',async()=>{
 for(const options of [{live:{status:'inProgress'}},{live:{items:[{...final,seeded:false}]}},{live:{items:[{...final,phase:'commentary'}]}},{stream:{gap:true}},{live:{id:'other'}},{live:{startedAt:101}},{stream:{scope:'zyy'}},{stream:{sourceGeneration:'old'}},{record:{generation:'rewritten'}},{turn:{items:[{...final}]}}]){
  const f=fixture(options),snapshot=await f.read();
  assert.equal(snapshot.completedFromStream,false,JSON.stringify(options));
  assert.equal(snapshot.page.data[0].status,'inProgress');assert.equal(f.ctx.finalFromSnapshot(snapshot),null);
 }
});
const baseline=process.env.DSH_STREAM_BASELINE_UI_PACKAGE;
test('old renderer replay reproduces final text in a running turn from the same persisted stream',{skip:!baseline},async()=>{
 const oldDir=path.resolve(baseline);
 const m=JSON.parse(await readFile(path.join(oldDir,'ui-release.json')));
 const old=await readFile(path.join(oldDir,'files',m.files.find(f=>f.path.endsWith('/scope.js')).path),'utf8');
 const f=fixture({},old),snapshot=await f.read();
 assert.equal(snapshot.page.data[0].items.at(-1).text,final.text);
 assert.equal(snapshot.page.data[0].status,'inProgress');
 assert.equal(f.ctx.finalFromSnapshot(snapshot),null,'this prevents completed-body anchoring and the final disclosure state');
});

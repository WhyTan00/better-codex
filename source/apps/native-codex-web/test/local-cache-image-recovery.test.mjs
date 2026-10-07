import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(process.env.DSH_TEST_CACHE_SOURCE||new URL('../public/native-local-cache.js',import.meta.url),'utf8');
if(process.env.DSH_STOP_SCOPE)assert((await readFile(process.env.DSH_STOP_SCOPE,'utf8')).includes(source.trim()),'the tested cache is the exact final scope module');
const navigation=await readFile(new URL('../public/native-navigation.js',import.meta.url),'utf8');
const slice=(text,start,end)=>{const a=text.indexOf(start),b=text.indexOf(end,a);assert(a>=0&&b>a,`production section ${start}`);return text.slice(a,b);};
const keyBlock=slice(source,' const canonical=',' const requestValue=');
const userBlock=slice(source,' const confirmedUserMirrors=',' const validated=');
const anchor=' window.__DSH_PREPARE_CACHED_CONVERSATION__=prepareCachedConversation;';
const recoveryBlock=slice(source,anchor,' async function readFinalSummary(').slice(anchor.length);
const identityBlock=slice(navigation,' window.__DSH_FINAL_IDENTITY__=',' const scope=');
const finalBlock=slice(source,' function finalFromSnapshot(',' function completesVisibleTurn(');
const repairBlock=source.includes(' const cachedImageRecovery=')?slice(source,' const cachedImageRecovery=',' function finalFromSnapshot('):'';
const json=value=>JSON.parse(JSON.stringify(value));
const id='11111111-1111-4111-a111-111111111111',turnId='22222222-2222-4222-a222-222222222222';
const opening={id:'native-opening',clientId:'native-opening-client',type:'userMessage',content:[{type:'text',text:'SYNTHETIC_OPENING'},{type:'localImage',path:'/synthetic/original input 图.png'}]};
const steer={id:'native-steer',clientId:'native-steer-client',type:'userMessage',content:[{type:'text',text:'SYNTHETIC_STEER'}]};
// These are Native ThreadItem DTOs, not rendered rows or reconstructed URLs.
const viewed={id:'native-viewed-image',type:'imageView',path:'/synthetic/viewed 原图 ?#%.png'};
const generated={id:'native-generated-image',type:'imageGeneration',status:'completed',result:'SYNTHETIC_BASE64',savedPath:'/synthetic/generated 原图.png',revisedPrompt:'SYNTHETIC_REVISED_PROMPT',transparentBackground:true};
const final={id:'native-final',type:'agentMessage',phase:'final_answer',text:'SYNTHETIC_FINAL'};
const processItem={id:'native-process',type:'commandExecution',command:'synthetic command',commandActions:[],status:'completed',aggregatedOutput:'SYNTHETIC_PROCESS'};
const turn=()=>({id:turnId,status:'completed',itemsView:'full',startedAt:100,completedAt:101,durationMs:1000,error:null,items:structuredClone([opening,viewed,processItem,generated,steer,final])});
const compactItems=[opening,viewed,generated,steer,final];

function fixture({durable=new Map(),records=new Map(),scopeId='ai',sourceGeneration='source-1',getGate=null}={}){
 const memoryMeta=new Map([['catalog-generation',sourceGeneration]]),localReads=[],network=[],paint=[];
 const scoped=key=>scopeId+':'+key;
 const context={Map,Set,Promise,Date,JSON,Math,structuredClone,Symbol,setTimeout,clearTimeout,CACHE_IO_TIMEOUT_MS:1200,
  scope:{id:scopeId},memoryMeta,diagnostics:{},historyViewEpoch:1,nativeClient:{disposed:false},androidReader:true,nativeEventEpoch:new Map(),savedReadVersions:new Map(),
  document:{visibilityState:'visible'},location:{pathname:'/local/'+id},navigator:{onLine:false},window:{__DSH_NATIVE_SIDEBAR__:{isList:false}},
  remaining:deadline=>Math.max(1,deadline-Date.now()),
  meta:async key=>key==='catalog-generation'?memoryMeta.get(key):structuredClone(durable.get(scoped(key))),
  saveMeta:async(key,value)=>{durable.set(scoped(key),structuredClone(value));memoryMeta.set(key,structuredClone(value));},
  get:async key=>{localReads.push(key);const result=structuredClone(records.get(scoped(key)));if(getGate)await getGate(key);return result;},
  fetchRead:async(...args)=>{network.push(args);throw Error('this recovery must not read Native or HTTP');},
  fetch:async(...args)=>{network.push(args);throw Error('this recovery must not fetch');},
  refreshCommitted:async snapshot=>paint.push(structuredClone(snapshot)),scheduleCommitted(){},
 };
 vm.createContext(context);vm.runInContext(identityBlock+source.slice(source.indexOf(' const visibleProcessItem='),source.indexOf(' function captureVisibleProcesses('))+keyBlock+userBlock+recoveryBlock+finalBlock+repairBlock+';globalThis.readKey=readKey;',context);
 const record=(method,result,params={},options={})=>({scope:scopeId,threadId:id,source:'native',sourceGeneration:memoryMeta.get('catalog-generation'),generation:'thread-1',revision:1,confirmedAt:100000,deleted:false,key:context.readKey(method,{threadId:id,...params}),payload:{method,params:{threadId:id,...params},result:structuredClone(result)},...options});
 const pair=(body=turn(),options={})=>({headRecord:record('thread/read',{thread:{id,updatedAt:101,status:{type:'idle'},historyMode:'paginated'}},{includeTurns:false},options),turnRecord:record('thread/turns/list',{data:[body],nextCursor:'native-older-turn-cursor'},{limit:2,sortDirection:'desc',itemsView:body.itemsView},options)});
 const put=record=>records.set(scoped(record.key),structuredClone(record));
 const read=async(body=turn(),options={},preferSummary=false)=>context.window.__DSH_READ_COMMITTED_HISTORY__(id,{...pair(body,options),preferSummary});
 return {context,durable,records,memoryMeta,network,localReads,paint,record,pair,put,read,
  load:()=>context.loadFinalRecovery(id),save:snapshot=>context.saveFinalRecovery(id,snapshot),
  saved:()=>structuredClone(durable.get(scoped('final-recovery-v1:'+id))),
  repair:()=>{assert.equal(typeof context.restoreCachedImages,'function','production repairs old compact caches from existing local Native bodies');return context.restoreCachedImages(id);}};
}
async function seed(f){const snapshot=await f.read();assert(snapshot);await f.save(snapshot);return snapshot;}
const items=snapshot=>json(snapshot.page.data[0].items);
const summary=()=>({...turn(),itemsView:'summary',items:structuredClone([opening,steer,final])});

test('full Native snapshot saves complete image DTOs and original user input in Native order',async()=>{
 const f=fixture(),snapshot=await f.read(),before=structuredClone(snapshot);await f.save(snapshot);
 assert.deepEqual(items(f.saved()),compactItems);assert.deepEqual(json(snapshot),json(before),'saving must not mutate the supplied Native snapshot');
 assert.equal(f.saved().page.nextCursor,'native-older-turn-cursor');assert.equal(f.saved().page.data[0].itemsView,'summary');
 const pagination=f.saved().itemsPaginationByTurnId[turnId];assert.deepEqual(json(pagination.oldestUserInput),opening.content);assert.equal(pagination.openingUserMessageClientId,opening.clientId);assert.equal(pagination.hasLoadedOldest,false);
 assert.deepEqual(f.network,[]);assert.deepEqual(f.localReads,[]);
});

test('actual committed first-paint reader preserves complete Native images without additional reads',async()=>{
 const f=fixture(),snapshot=await f.read(turn(),{},true);assert.deepEqual(items(snapshot),compactItems);
 assert.equal(snapshot.page.nextCursor,'native-older-turn-cursor');assert.deepEqual(f.network,[]);assert.deepEqual(f.localReads,[]);
});

test('cold summary shrink retains only exact same completed turn images and Native order',async()=>{
 const warm=fixture();await seed(warm);const cold=fixture({durable:warm.durable});await cold.load();
 const incoming=await cold.read(summary(),{revision:2},true);assert.deepEqual(items(incoming),compactItems);
 await cold.save(incoming);assert.deepEqual(items(cold.saved()),compactItems);
 assert.deepEqual(cold.network,[]);assert.deepEqual(cold.localReads,[]);
});

test('current same-id Native DTO wins and returned images cannot mutate the saved archive',async()=>{
 const f=fixture();await seed(f);const newer=summary();newer.items.splice(1,0,{...generated,savedPath:'/synthetic/new Native path.png',result:'SYNTHETIC_NEW_RESULT'});
 const snapshot=await f.read(newer,{revision:2},true),expected=structuredClone(compactItems);expected[2]=newer.items[1];assert.deepEqual(items(snapshot),expected);
 snapshot.page.data[0].items.find(item=>item.id===viewed.id).path='/synthetic/mutated consumer.png';assert.equal(f.saved().page.data[0].items.find(item=>item.id===viewed.id).path,viewed.path);
});

for(const [name,change,recordChange]of [
 ['source generation',null,{sourceGeneration:'source-2'}],['thread generation',null,{generation:'thread-2'}],
 ['new completed turn',body=>{body.id='33333333-3333-4333-a333-333333333333';body.startedAt=200;body.completedAt=201;},{}],
 ['turn start',body=>body.startedAt=99,{}],['turn completion',body=>body.completedAt=102,{}],
 ['turn error',body=>body.error={message:'SYNTHETIC_CHANGED_ERROR'},{}],
 ['different final id',body=>body.items.at(-1).id='different-final',{}],
 ['different final text',body=>body.items.at(-1).text='SYNTHETIC_CHANGED_FINAL',{}],
 ['new Native item id',body=>body.items.splice(1,0,{...steer,id:'new-native-input'}),{}],
])test(`summary ${name} cannot borrow an earlier image`,async()=>{
 const f=fixture();await seed(f);const body=summary();change?.(body);const snapshot=await f.read(body,{revision:2,...recordChange},true);assert(snapshot);
 assert.deepEqual(items(snapshot),body.items);assert(snapshot.page.data.every(t=>!t.items.some(item=>item.type==='imageView'||item.type==='imageGeneration')));assert.deepEqual(f.network,[]);
});

test('another workspace or thread cannot read and reuse the saved image archive',async()=>{
 const warm=fixture();await seed(warm);const other=fixture({durable:warm.durable,scopeId:'synthetic-other-scope'});assert.equal(await other.load(),null);
 const snapshot=await other.read(summary(),{revision:2},true);assert.deepEqual(items(snapshot),summary().items);
 const f=fixture({durable:warm.durable});await f.load();const pair=f.pair(summary(),{revision:2});pair.headRecord.payload.result.thread.id='44444444-4444-4444-a444-444444444444';
 assert.equal(await f.context.window.__DSH_READ_COMMITTED_HISTORY__(id,{...pair,preferSummary:true}),null);assert.deepEqual(f.network,[]);
});

test('older completed turns require their own final identity and never borrow the latest turn image',async()=>{
 const f=fixture(),pair=f.pair();const older={...turn(),id:'older-turn',startedAt:90,completedAt:91,items:[{...opening,id:'older-opening'},{...viewed,id:'older-image',path:'/synthetic/older.png'},{...final,id:'older-final',text:'SYNTHETIC_OLDER_FINAL'}]};pair.turnRecord.payload.result.data.push(older);
 const snapshot=await f.context.window.__DSH_READ_COMMITTED_HISTORY__(id,pair);await f.save(snapshot);
 const cold=fixture({durable:f.durable});await cold.load();const next=cold.pair(summary(),{revision:2});next.turnRecord.payload.result.data.push({...older,itemsView:'summary',items:[older.items[0],{...older.items[2],text:'SYNTHETIC_CHANGED_OLDER_FINAL'}]});
 const restored=await cold.context.window.__DSH_READ_COMMITTED_HISTORY__(id,{...next,preferSummary:true});assert.deepEqual(items(restored),compactItems);assert.deepEqual(json(restored.page.data[1].items),next.turnRecord.payload.result.data[1].items);assert.equal(restored.page.nextCursor,'native-older-turn-cursor');
});

test('local paged body repair restores images from an old text-only first paint without HTTP',async()=>{
 const warm=fixture();await seed(warm);const old=warm.saved();old.page.data[0].items=old.page.data[0].items.filter(item=>item.type==='userMessage'||item.type==='agentMessage');warm.durable.set('ai:final-recovery-v1:'+id,old);
 const cold=fixture({durable:warm.durable});const pair=cold.pair(summary(),{revision:2});cold.put(pair.headRecord);cold.put(pair.turnRecord);
 const page=cold.record('thread/items/list',{data:turn().items.slice().reverse().map(item=>({item})),nextCursor:'native-older-item-cursor'},{turnId,limit:48,sortDirection:'desc'},{revision:2});cold.put(page);
 await cold.load();await cold.repair();assert.deepEqual(items(cold.saved()),compactItems);assert.equal(cold.paint.length,1);assert.deepEqual(items(cold.paint[0]),turn().items);assert.deepEqual(cold.network,[]);
 assert(cold.localReads.some(key=>key.includes('thread/items/list')),'repair must use an existing Native item page');assert.equal(cold.saved().page.nextCursor,'native-older-turn-cursor');
});

test('missing cached image bodies do not fetch or invent image items',async()=>{
 const warm=fixture();await seed(warm);const old=warm.saved();old.page.data[0].items=summary().items;warm.durable.set('ai:final-recovery-v1:'+id,old);
 const cold=fixture({durable:warm.durable});const pair=cold.pair(summary(),{revision:2});cold.put(pair.headRecord);cold.put(pair.turnRecord);await cold.load();await cold.repair();
 assert.deepEqual(items(cold.saved()),summary().items);assert.deepEqual(cold.network,[]);assert.deepEqual(cold.paint,[]);
});

test('a delayed local body cannot paint or persist into a different visible conversation',async()=>{
 let release,enteredResolve;const entered=new Promise(resolve=>enteredResolve=resolve),gate=new Promise(resolve=>release=resolve);
 const warm=fixture();await seed(warm);const old=warm.saved();old.page.data[0].items=summary().items;warm.durable.set('ai:final-recovery-v1:'+id,old);
 const cold=fixture({durable:warm.durable,getGate:async()=>{enteredResolve();await gate;}}),pair=cold.pair();cold.put(pair.headRecord);cold.put(pair.turnRecord);await cold.load();
 const work=cold.repair();await entered;cold.context.location.pathname='/local/44444444-4444-4444-a444-444444444444';release();await work;
 assert.deepEqual(items(cold.saved()),summary().items);assert.deepEqual(cold.paint,[]);assert.deepEqual(cold.network,[]);
});

test('a delayed local body cannot overwrite a newer source generation archive',async()=>{
 let release,enteredResolve;const entered=new Promise(resolve=>enteredResolve=resolve),gate=new Promise(resolve=>release=resolve);
 const warm=fixture();await seed(warm);const old=warm.saved();old.page.data[0].items=summary().items;warm.durable.set('ai:final-recovery-v1:'+id,old);
 const cold=fixture({durable:warm.durable,getGate:async()=>{enteredResolve();await gate;}}),pair=cold.pair();cold.put(pair.headRecord);cold.put(pair.turnRecord);await cold.load();
 const work=cold.repair();await entered;cold.memoryMeta.set('catalog-generation','source-2');
 const newer=summary();newer.items.at(-1).text='SYNTHETIC_CURRENT_SOURCE_FINAL';await cold.save(await cold.read(newer,{revision:5,sourceGeneration:'source-2',generation:'thread-2'}));
 const expected=cold.saved();release();await work;assert.deepEqual(json(cold.saved()),json(expected));assert.deepEqual(cold.paint,[]);assert.deepEqual(cold.network,[]);
});

for(const reason of ['hidden','new view epoch'])test(`a delayed local body cannot paint after ${reason}`,async()=>{
 let release,enteredResolve;const entered=new Promise(resolve=>enteredResolve=resolve),gate=new Promise(resolve=>release=resolve);
 const warm=fixture();await seed(warm);const old=warm.saved();old.page.data[0].items=summary().items;warm.durable.set('ai:final-recovery-v1:'+id,old);
 const cold=fixture({durable:warm.durable,getGate:async()=>{enteredResolve();await gate;}}),pair=cold.pair();cold.put(pair.headRecord);cold.put(pair.turnRecord);await cold.load();
 const work=cold.repair();await entered;if(reason==='hidden')cold.context.document.visibilityState='hidden';else cold.context.historyViewEpoch++;release();await work;
 assert.deepEqual(items(cold.saved()),summary().items);assert.deepEqual(cold.paint,[]);assert.deepEqual(cold.network,[]);
});

test('contradictory current Native item order cannot be rewritten using an old image archive',async()=>{
 const f=fixture();await seed(f);const body=summary();body.items=[structuredClone(steer),structuredClone(opening),structuredClone(final)];
 const snapshot=await f.read(body,{revision:2},true);assert.deepEqual(items(snapshot),body.items);assert.deepEqual(f.network,[]);
});

async function olderItemPage({body=turn(),currentSummary=summary(),getGate=null}={}){
 const warm=fixture();await seed(warm);const old=warm.saved();old.page.data[0].items=summary().items;warm.durable.set('ai:final-recovery-v1:'+id,old);
 const cold=fixture({durable:warm.durable,getGate}),pair=cold.pair(currentSummary,{revision:3});cold.put(pair.headRecord);cold.put(pair.turnRecord);
 const itemRecord=cold.record('thread/items/list',{data:body.items.slice().reverse().map(item=>({item})),nextCursor:'native-older-item-cursor'},{turnId,limit:48,sortDirection:'desc'},{revision:1});cold.put(itemRecord);await cold.load();return{cold,itemRecord};
}

test('only local image repair may use an older completed item revision with the exact Native final',async()=>{
 const {cold,itemRecord}=await olderItemPage();const before=structuredClone(itemRecord);
 const ordinary=await cold.context.window.__DSH_READ_COMMITTED_HISTORY__(id,{touch:false,preferSummary:false});assert(!ordinary||ordinary.page.data.every(t=>!t.items.some(i=>i.type==='imageView'||i.type==='imageGeneration')),'the default reader still rejects an older item page');
 await cold.repair();assert.deepEqual(items(cold.saved()),compactItems);assert.equal(cold.paint.length,1);assert.deepEqual(json(itemRecord),json(before),'the Native item page is immutable');assert.deepEqual(cold.network,[]);
});

test('older image page with a same-id changed Native final text is rejected',async()=>{
 const changed=summary();changed.items.at(-1).text='SYNTHETIC_NEW_FINAL';const {cold}=await olderItemPage({currentSummary:changed});const before=cold.saved();await cold.repair();
 assert.deepEqual(json(cold.saved()),json(before));assert.deepEqual(cold.paint,[]);assert.deepEqual(cold.network,[]);
});

test('older descending item pages compare the latest final in Native chronological order',async()=>{
 const body=turn();body.items.splice(1,0,{...final,id:'native-earlier-final',text:'SYNTHETIC_EARLIER_FINAL'});
 const {cold}=await olderItemPage({body});await cold.repair();
 assert.deepEqual(items(cold.saved()),[opening,body.items[1],viewed,generated,steer,final]);assert.equal(cold.paint.length,1);assert.deepEqual(cold.network,[]);
});

test('older image bodies cannot erase a new Native summary item id',async()=>{
 const changed=summary();changed.items.splice(1,0,{...steer,id:'new-native-summary-input'});const {cold}=await olderItemPage({currentSummary:changed});const before=cold.saved();await cold.repair();
 assert.deepEqual(json(cold.saved()),json(before));assert.deepEqual(cold.paint,[]);assert.deepEqual(cold.network,[]);
});

test('older image backfill retains the current same-id Native DTO fields',async()=>{
 const changed=summary(),newOpening={...opening,content:[{type:'text',text:'SYNTHETIC_CURRENT_NATIVE_INPUT'},{type:'localImage',path:'/synthetic/current input.png'}]},newImage={...viewed,path:'/synthetic/current Native image.png'};changed.items=[newOpening,newImage,steer,final];
 const {cold}=await olderItemPage({currentSummary:changed});await cold.repair();assert.deepEqual(items(cold.saved()),[newOpening,newImage,generated,steer,final]);assert.deepEqual(cold.network,[]);
});

test('authentication becoming locked during a local image read forbids save and paint',async()=>{
 let release,enteredResolve;const entered=new Promise(resolve=>enteredResolve=resolve),gate=new Promise(resolve=>release=resolve);
 const {cold}=await olderItemPage({getGate:async()=>{enteredResolve();await gate;}}),before=cold.saved(),work=cold.repair();await entered;cold.memoryMeta.set('auth-locked',true);release();await work;
 assert.deepEqual(json(cold.saved()),json(before));assert.deepEqual(cold.paint,[]);assert.deepEqual(cold.network,[]);
});

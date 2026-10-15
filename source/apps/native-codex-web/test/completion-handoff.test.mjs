import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(process.env.DSH_TEST_CACHE_SOURCE||new URL('../public/native-local-cache.js',import.meta.url),'utf8');
const id='11111111-1111-4111-a111-111111111111',turnId='22222222-2222-4222-a222-222222222222';
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const settle=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};

test('selected history starts while the workspace import and recovery storage are both stalled',async()=>{
 const calls=[];const stalled=new Promise(()=>{});
 const context={queueMicrotask,androidReader:true,location:{pathname:'/local/'+id},window:{__DSH_ANDROID_BRIDGE__:{refresh(){calls.push('import');return stalled;}}},restoreFinalFirst(){calls.push('local');return stalled;},refreshCommitted:async()=>calls.push('committed'),refreshForeground:async()=>calls.push('fresh')};
 vm.runInNewContext(section(' let entryScheduled='," for(const type of ['dsh:native-route'"),context);
 context.refreshEntry(true);await settle();
 assert.deepEqual(calls,['local','import','fresh']);
});

test('only a matching completed latest turn can supersede retained live state',()=>{
 const conversation={turns:[{turnId,status:'inProgress',turnStartedAtMs:10000}]};
 const context={nativeClient:{getConversation:()=>conversation},memoryMeta:new Map([['catalog-generation','source-1']]),window:{__DSH_FINAL_IDENTITY__:item=>item.phase==='final_answer'?'exact-final':null}};
 vm.runInNewContext(section(' function finalFromSnapshot(', ' function finalIsPainted('),context);
 const snapshot={sourceGeneration:'source-1',bodyLoadedTurnIds:[turnId],page:{data:[{id:turnId,status:'completed',startedAt:10,items:[{phase:'final_answer'}]}]}};
 assert.equal(context.completesVisibleTurn(id,snapshot),true);
 conversation.turns[0].status='completed';
 assert.equal(context.completesVisibleTurn(id,snapshot),true,'a replayed completion status is not proof that the final body was adopted');
 conversation.turns[0].status='inProgress';
 conversation.turns.push({turnId:'newer',status:'inProgress',turnStartedAtMs:20000});
 assert.equal(context.completesVisibleTurn(id,snapshot),false);
 conversation.turns.pop();snapshot.sourceGeneration='other';assert.equal(context.completesVisibleTurn(id,snapshot),false);
 snapshot.sourceGeneration='source-1';snapshot.page.data[0].status='inProgress';assert.equal(context.completesVisibleTurn(id,snapshot),false);
 snapshot.page.data[0].status='completed';snapshot.page.data[0].items=[];assert.equal(context.completesVisibleTurn(id,snapshot),false);
});

test('a committed page invalidates the selected conversation before the workspace import finishes',()=>{
 let handler,count=0;const prepared=[];
 vm.runInNewContext(section(" addEventListener('dsh:android-cache-updated'",' // Cache only scoped'),{scope:{id:'ai'},location:{pathname:'/local/'+id},priorityPinned:new Set(),recentWarmed:new Map([[id,10]]),knownRunning:new Set(),queueCachedPreparation:id=>prepared.push(id),scheduleCommitted:()=>count++,addEventListener:(_type,fn)=>handler=fn});
 handler({detail:{scope:'ai',threadIds:[id],hasMore:true}});assert.equal(count,1);
 handler({detail:{scope:'zyy',threadIds:[id]}});handler({detail:{scope:'ai',threadIds:['other']}});assert.equal(count,1);assert.deepEqual(prepared,[id],'only imported entries in the current preload scope need display preparation');
});

test('a resumed idle status reconciles the completed body even when turn/completed was missed',()=>{
 let handler,count=0;
 vm.runInNewContext(section("  client.addNotificationCallback?.('thread/status/changed',({params})=>{",'\n  restoreSelectedAfterClientInstall(client);'),{client:{addNotificationCallback:(_method,fn)=>handler=fn},androidReader:true,location:{pathname:'/local/'+id},refreshEntry:()=>count++});
 handler({params:{threadId:id,status:{type:'idle'}}});assert.equal(count,1);
 handler({params:{threadId:id,status:{type:'active'}}});handler({params:{threadId:'other',status:{type:'idle'}}});assert.equal(count,1);
});

test('replayed live items cannot demote a known final; other turns and history rewrites still pass',()=>{
 let known=true;const log=[];
 const context={compactFinalGuards:new Map(),memoryMeta:new Map(),recoveryEpoch:new Map(),window:{__DSH_CLIENT_LOG__:{event:(_type,fields)=>log.push(fields)}},currentRecovery:()=>known?{}:null,finalFromSnapshot:(snapshot,turn)=>snapshot&&turn===turnId?{identity:'final'}:null};
 vm.runInNewContext(section(' const completedReplayLogged=', ' function acceptRecoverySnapshot('),context);
 const accept=context.window.__DSH_ACCEPT_NATIVE_NOTIFICATION__;
 assert.equal(accept('item/agentMessage/delta',{threadId:id,turnId}),false);
 assert.equal(accept('turn/started',{threadId:id,turn:{id:turnId}}),false);
 assert.equal(log.length,1,'stream replay diagnostics must be coalesced');
 assert.equal(accept('turn/started',{threadId:id,turn:{id:'new-turn'}}),true);
 assert.equal(accept('thread/reverted',{threadId:id,turnId}),true);
 assert.equal(accept('turn/completed',{threadId:id,turn:{id:turnId}}),true);
 known=false;assert.equal(accept('item/started',{threadId:id,turnId}),true);
});

test('an explicit send reads only its target runtime state and resumes before sending, without retrying the turn',async()=>{
 const calls=[],context={client:{},original:async(method,params)=>{calls.push([method,params]);return {thread:{id,status:{type:method==='thread/read'?'notLoaded':'idle'}}};},rememberHistoryCursors(){},Set,Error};
 context.executionRead=(...args)=>context.original(...args);
 vm.runInNewContext(section('  async function ensureSubmissionThreadLoaded(', '  target.sendRequest='),context);
 await context.ensureSubmissionThreadLoaded(id,{});
 assert.deepEqual(calls.map(c=>c[0]),['thread/read','thread/resume']);
 assert.equal(calls[1][1].threadId,id);assert.equal(calls[1][1].excludeTurns,true);
 calls.length=0;context.original=async m=>{calls.push([m]);return {thread:{id,status:{type:'idle'}}};};await context.ensureSubmissionThreadLoaded(id,{});assert.equal(calls.length,1);
 context.original=async m=>{calls.push([m]);if(m==='thread/resume')throw Error('writer locked');return {thread:{id,status:{type:'notLoaded'}}};};
 await assert.rejects(context.ensureSubmissionThreadLoaded(id,{}),/writer locked/);assert(!calls.some(c=>c[0]==='turn/start'));
});

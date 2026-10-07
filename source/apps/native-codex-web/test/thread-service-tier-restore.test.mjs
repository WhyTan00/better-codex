import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
import {patchThreadServiceTierRestore} from '../src/official-model-settings.mjs';
const input=process.env.DSH_FAST_INITIAL?await readFile(process.env.DSH_FAST_INITIAL,'utf8'):await readFile(new URL('../../../acceptance/fast-restore-before/pwa-initial.js',import.meta.url),'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return readFile(new URL('../../../runtime/prepared-progress-reopen-20261003/pwa/native-assets/v1153/app-initial-cadb12d4a15e.js',import.meta.url),'utf8');});
const source=process.env.DSH_FAST_NO_PATCH==='1'?input:patchThreadServiceTierRestore(input);
const cache=await readFile(process.env.DSH_FAST_CACHE||new URL('../public/native-local-cache.js',import.meta.url),'utf8');
const id='11111111-1111-4111-a111-111111111111';
function fn(name){const a=source.indexOf('function '+name+'('),b=source.indexOf('}function ',a),c=source.indexOf('}var ',a);assert(a>=0);return source.slice(a,Math.min(...[b,c].filter(x=>x>a))+1);}
function picker({saved='priority',native,hostId='local',conversationId=id}={}){
 const MI=Symbol(),F0=Symbol(),cro=Symbol(),Q=Symbol(),values=new Map(),updates=[];
 const readModel=projection(new Map());if(saved!==undefined)readModel.rememberThreadTier(id,saved);
 const state={get:()=>null,set:()=>{}},ctx={globalThis:{__DSH_USE_READ_MODEL__:readModel.useReadModel},sro:{c:()=>[]},u1a:{useSyncExternalStore:(_subscribe,getSnapshot)=>getSnapshot()},Db:()=>state,Q,fG:()=>({hostId}),Eb:atom=>atom===MI?native:atom===F0?null:atom===cro?undefined:{},MI,F0,cro,
 x$a:()=>({data:{models:[]},isLoading:false}),GR:()=>({authMethod:'chatgpt'}),KD:Symbol(),ero:()=>({serviceTier:'default',isLoading:false}),tro:()=>async()=>{},_1a:()=>({isServiceTierAllowed:true}),Y$a:()=>({}),Pvr:x=>x??'default',Nvr:(_m,t,allowed)=>allowed?t:null,Mvr:(_m,t)=>({value:t}),jvr:x=>x,Evr:()=>[],Rb:()=>({updateThreadSettingsForNextTurn:async(_id,p)=>updates.push(p)}),T:{error(){}},zw(){},Ygn:Symbol()};
 return {result:vm.runInNewContext('('+fn('aro')+')',ctx)(conversationId,{model:'gpt-6.1-sol',isLoading:false},null,false),updates,values};
}
test('cold official picker restores acknowledged Fast while missing Thread DTO tier is unknown',()=>{assert.equal(picker().result.serviceTierSettings.serviceTierForRequest,'priority');});
test('new chat renders with the real read-model hook and the compiler cache has no React hooks',()=>{assert.equal(picker({conversationId:null}).result.serviceTierSettings.serviceTierForRequest,'default');});
test('Native Standard and explicit clear supersede a cached Fast display',()=>{for(const serviceTier of ['default',null])assert.equal(picker({native:{serviceTier}}).result.serviceTierSettings.serviceTierForRequest,serviceTier);});
test('restored Fast still permits an explicit Standard choice through the real callback',async()=>{const f=picker();await f.result.setServiceTier(null,'user');assert.equal(f.updates.length,1);assert.equal(f.updates[0].serviceTier,null);});
test('local resume inherits Native tier and remote resume retains its requested tier',()=>{
 const a=source.indexOf('let be={threadId:s,history:null,'),b=source.indexOf(',cwd:ue.cwd',a);assert(a>=0&&b>a);
 const fragment=source.slice(a,b)+'};be';
 for(const v of ['local','remote']){const request=vm.runInNewContext(fragment,{s:id,S:null,g:{rolloutPath:''},ue:{modelProvider:'openai',serviceTier:null},ce:null,v});assert.equal(Object.hasOwn(request,'serviceTier'),v!=='local');}
});
test('cold submission uses the restored Native tier instead of a captured Standard picker value',async()=>{
 const parallel=source.indexOf('dshTier=dshTurnRead(async()=>{'),a=parallel>=0?source.indexOf('let Ee=E?.serviceTier===',parallel):source.indexOf('let Ee=E?.serviceTier==='),b=source.indexOf(parallel>=0?'}),W=':',Oe={threadId:t,',a);assert(a>=0&&b>a);const expression=source.slice(a,b)+(parallel>=0?'':';return De');
 for(const cold of [true,false]){const result=await vm.runInNewContext('(async()=>{'+expression+'})()',{E:{serviceTier:'priority'},L:null,s:{serviceTier:null},n:{context:{dshInheritTaskModel:cold}},e:{logger:{},sendRequest:async()=>({requirements:{}})},Zx:65000,jan:async x=>x});assert.equal(result,cold?'priority':null);}
});
test('requirements read failure preserves Fast intent and a real Native prohibition is respected',async()=>{
 const jan=vm.runInNewContext('(async '+fn('jan')+')');const logger={warning(){}};
 await assert.rejects(jan('priority',logger,async()=>{throw Error('requirements unavailable');}),/requirements unavailable/);
 assert.equal(await jan('priority',logger,async()=>({requirements:{featureRequirements:{fast_mode:false}}})),null);
 assert.equal(await jan('priority',logger,async()=>({requirements:{}})),'priority');
});
function projection(store){
 const a=cache.indexOf(' const readModels=new Map()'),b=cache.indexOf(' const composerConfig=',a);assert(a>=0&&b>a);
 const window={},ctx={window,scope:{id:'ai'},meta:async key=>store.get(key),saveMeta:async(key,value)=>store.set(key,structuredClone(value)),Date,Map};vm.createContext(ctx);vm.runInContext(cache.slice(a,b)+';globalThis.helpers={rememberThreadTier,restoreThreadTier,rememberReadModel,readModels,useReadModel:window.__DSH_USE_READ_MODEL__};',ctx);return ctx.helpers;
}
test('acknowledged tier survives process reconstruction and history metadata does not erase it',async()=>{
 const store=new Map(),first=projection(store);first.rememberThreadTier(id,'priority');const second=projection(store);await second.restoreThreadTier(id);second.rememberReadModel(id,{id,model:'gpt-6.1-sol',reasoningEffort:'xhigh'});assert.equal(second.readModels.get(id).serviceTier,'priority');second.rememberThreadTier(id,null);const third=projection(store);await third.restoreThreadTier(id);assert.equal(third.readModels.get(id).serviceTier,null);
});
test('a delayed disk projection cannot overwrite a newer Native settings acknowledgment',async()=>{
 let release;const store={get:()=>new Promise(resolve=>release=resolve),set(){}};const helpers=projection(store);const reading=helpers.restoreThreadTier(id);helpers.rememberThreadTier(id,null);release({scope:'ai',threadId:id,serviceTier:'priority'});await reading;assert.equal(helpers.readModels.get(id).serviceTier,null);
});
test('actual RPC acknowledgment saves the tier, rejection keeps the prior choice and persistence does not block send',async()=>{
 const a=cache.indexOf('  target.sendRequest=async('),b=cache.indexOf('  const disposeCapacity=',a);assert(a>=0&&b>a);
 const block=cache.slice(a,b);for(const rejected of [false,true]){
  const remembered=[],target={},ctx={target,READS:new Set(),AUX:new Set(),protocolReady:Promise.resolve(),diagnostics:{rpc:{}},userStopIntents:new Map(),client:{},navigator:{onLine:true},window:{__DSH_EXECUTION_CONNECTED__:true},isAuthRead:()=>false,original:async()=>{if(rejected)throw Error('native rejected');return {};},invalidateReadChecks(){},rememberThreadTier:(...args)=>{remembered.push(args);return new Promise(()=>{});}};
  vm.runInNewContext(block,ctx);const call=target.sendRequest('thread/settings/update',{threadId:id,serviceTier:'priority'});
  if(rejected){await assert.rejects(call,/native rejected/);assert.equal(remembered.length,0);}else{await call;assert.equal(remembered.length,1);assert.equal(remembered[0][1],'priority');}
 }
});

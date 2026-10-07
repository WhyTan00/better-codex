import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {patchParallelResumePreparation} from '../src/official-submission-readiness.mjs';

const frozenBefore=new URL('../../../acceptance/resume-preparation-before/pwa-initial.js',import.meta.url);
const workspaceBefore=new URL('../../../runtime/send-migration-followup-20260928/ui/pwa/native-assets/v1034/app-initial-cadb12d4a15e.js',import.meta.url);
const input=process.env.DSH_RESUME_PREPARATION_INITIAL?await readFile(process.env.DSH_RESUME_PREPARATION_INITIAL,'utf8'):await readFile(frozenBefore,'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return readFile(workspaceBefore,'utf8');});
const initial=!process.env.DSH_RESUME_PREPARATION_INITIAL||process.env.DSH_RESUME_PREPARATION_APPLY_PATCH==='1'?patchParallelResumePreparation(input):input;
const extract=name=>{const match=new RegExp('(?:async )?function '+name+'\\(').exec(initial);assert(match,name);const tail=initial.slice(match.index),end=/\}(?:async function |function |var )/.exec(tail);assert(end,name+' boundary');return tail.slice(0,end.index+1);};
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
const tools=[{type:'namespace',name:'fixture',tools:[{name:'read_a'},{name:'read_b'}]},{type:'function',name:'read_c'}];
const permission={approvalPolicy:'never',approvalsReviewer:'user',sandboxPolicy:{type:'dangerFullAccess'},runtimeWorkspaceRoots:['/fixture']};

// Only external reads and pure adaptation helpers are fixtures. Nan, Han and
// Rln come from the actual immutable initial asset passed by each UI suite.
function preparation({readConfig=async()=>({fixture_config:true}),readTools=async()=>tools,readRequirements=async()=>({requirements:{}}),readSettings,usesTools=true}={}){
 const calls=[];
 const record=(name,fn)=>async(...args)=>{calls.push(name+':start');try{const value=await fn(...args);calls.push(name+':done');return value}catch(error){calls.push(name+':error');throw error}};
 const requestClient={hostId:'local',getAppServerVersion:()=> '0.0.0',sendRequest:record('requirements',readRequirements)};
 const adapters={requestClient,logger:{warning(){}},fetchProxyConfig:record('proxy',async()=>null),fetchCodexConfig:record('config',readConfig),readShellEnvironment:record('shell',async()=>({shellEnvironment:null})),readDeveloperInstructions:record('instructions',async()=>({instructions:'fixture instructions'}))};
 if(usesTools)adapters.readDynamicTools=record('tools',readTools);
 const params={model:'fixture-model',serviceTier:null,cwd:'/fixture',permissionsConfig:permission,approvalsReviewer:'user',personality:null,defaultFeatureOverrides:{fixture_feature:true},usesDesktopMcp:true,registerDynamicTools:false};
 const ctx={Promise,GOt:(a,features)=>({...a,config:{...a.config,...features}}),WOt:x=>x,Djt:(_selection,p)=>({approvalPolicy:p.approvalPolicy,sandbox:'danger-full-access'}),Fbt:p=>p.runtimeWorkspaceRoots,MOt:'mcp_servers.codex_apps.enabled_tools',Zx:30000,FC:x=>x,Bg:()=>false,aan:({cwd,fallbackCwd})=>cwd??fallbackCwd,san:({sandboxPolicy})=>sandboxPolicy,oan:()=>null,C_:(a,b)=>a===b,X_:()=>false,Sv:x=>x,Yin:x=>x,J8t:()=>({})};
 vm.createContext(ctx);vm.runInContext(['jan','Ejt','Fan','Nan','Pan','Ban','Han'].map(extract).join(';')+';globalThis.prepare=Nan;globalThis.product=Han;',ctx);
 const settings={usesDesktopMcp:usesTools,isBrowserRuntime:false,isTokenBudgetThread:()=>false,readSettings:record('settings',readSettings??(async()=>({personality:null,defaultFeatureOverrides:{fixture_feature:true}}))),fetchProxyConfig:adapters.fetchProxyConfig,readCodexConfig:adapters.fetchCodexConfig,readShellEnvironment:adapters.readShellEnvironment,readDynamicTools:adapters.readDynamicTools,readDeveloperInstructions:adapters.readDeveloperInstructions};
 return {calls,ctx,params,adapters,settings,requestClient,run:()=>ctx.prepare(params,adapters)};
}

function virtualClock(){
 let now=0;const pending=[];
 return {get now(){return now},delay(ms,value){return new Promise(resolve=>pending.push({at:now+ms,resolve,value}))},async drain(){for(let i=0;i<100;i++){await flush();if(!pending.length)return;now=Math.min(...pending.map(t=>t.at));for(const timer of pending.filter(t=>t.at===now)){pending.splice(pending.indexOf(timer),1);timer.resolve(timer.value)}}throw Error('fixture clock did not settle')}};
}

function resumeFixture(options={}){
 const f=preparation(options),id='11111111-1111-4111-a111-111111111111',calls=f.calls;
 let current=true,role=null;
 const conversation={id,cwd:'/fixture',resumeState:'needs_resume',latestModel:'fixture-model',latestReasoningEffort:'max',latestCollaborationMode:{mode:'default',settings:{model:'fixture-model',reasoning_effort:'max'}},currentPermissions:structuredClone(permission),threadRuntimeStatus:{type:'idle'},turns:[],createdAt:1,updatedAt:2};
 const reply={thread:{id,path:'/fixture/source.jsonl',cwd:'/fixture',status:{type:'idle'},historyMode:'legacy',turns:[],createdAt:1,updatedAt:2,threadSource:'user'},cwd:'/fixture',model:'fixture-model',reasoningEffort:'max',approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'},runtimeWorkspaceRoots:['/fixture']};
 const resumes=[];
 const manager={logger:{info(){},warning(){}},getConversation:()=>conversation,getHostId:()=> 'local',getWindowActivity:()=>({visibilityState:'visible',canAcquireThreadStream:true}),getStreamRole:()=>role,setConversationStreamRole:(_id,value)=>{role=value},isConversationStreaming:()=>false,getThreadSummaries:()=>[],useTailHydration:()=>false,readThread:async()=>({thread:structuredClone(reply.thread)}),getThreadWorkspaceState:()=>null,updateConversationState:(_id,fn)=>fn(conversation),readShellEnvironmentPolicy:()=>Promise.resolve(null),sendRequest:async(method,params)=>{calls.push('native:'+method);if(method==='thread/resume'){resumes.push(structuredClone(params));return structuredClone(reply)}if(method==='thread/goal/get')return {goal:null};throw Error('unexpected fixture method '+method)},ensureRecentConversationId(){},acceptConversationHistory(){},beginThreadGoalHydration:()=>null,isCurrentThreadGoalHydration:()=>false,endThreadGoalHydration:()=>false,broadcastConversationSnapshot(){}};
 Object.assign(f.ctx,{Q_:'durable',Uln:async()=>[],Vln:(_g,cwd)=>cwd,Bln:(cwd)=>[cwd],Hln:({resumeWorkspaceRoots})=>resumeWorkspaceRoots,DS:()=>null,CS:c=>c.turns,Pg:()=>permission,RC:(a,b)=>[...new Set([...a,...b])],Fsn:x=>x,pC:t=>({createdAt:t.createdAt,updatedAt:t.updatedAt,recencyAt:t.updatedAt}),mC:({updatedAt})=>updatedAt,fcn:({requestedCwd,responseCwd,threadCwd})=>requestedCwd??responseCwd??threadCwd,Lsn:(_cwd,roots)=>roots,vcn:()=>permission,Kln:{default:(a,b)=>JSON.stringify(a)===JSON.stringify(b)},j9t:(_reply,model,effort,cwd,collaborationMode)=>({model,effort,cwd,collaborationMode}),M9t:()=>({}),vC:(state,fields)=>{state.latestModel=fields.model;state.latestReasoningEffort=fields.effort;state.latestCollaborationMode=fields.collaborationMode},tan:()=>null,Xg:x=>x,Iln:()=>false,gv:e=>e?.message,yS:(a,b)=>[...a,...b],kS:(c,turns)=>{c.turns=turns},Wln:()=>null,Gln:()=>null,Wrn:()=>false});
 vm.runInContext(extract('Rln')+';globalThis.resume=Rln;',f.ctx);
 const product=f.ctx.product(f.settings,f.requestClient,manager.logger,{mapThreadTurns:()=>[]},()=>false);
 const run=()=>f.ctx.resume({manager,workspace:{load:async()=>false},params:{conversationId:id,model:null,serviceTier:null,reasoningEffort:'max',workspaceRoots:['/fixture'],permissions:structuredClone(permission),collaborationMode:conversation.latestCollaborationMode},product,historyPolicy:{turnMergePolicy:null,mapThreadTurns:()=>[]},isCurrentResumeAttempt:()=>current,setHydrationCleanup(){}});
 return {...f,run,resumes,conversation,cancel(){current=false}};
}

test('independent resume tools and configuration wait in parallel instead of adding their delays',async()=>{
 for(const [configDelay,toolDelay] of [[40,60],[60,40]]){
  const clock=virtualClock(),f=preparation({readConfig:()=>clock.delay(configDelay,{fixture_config:true}),readTools:()=>clock.delay(toolDelay,tools)});
  const result=f.run();await clock.drain();const value=await result;
  assert.equal(clock.now,Math.max(configDelay,toolDelay),'independent reads must overlap');
  assert.equal(value.config.fixture_config,true);
  assert.deepEqual(Array.from(value.config['mcp_servers.codex_apps.enabled_tools']),['read_a','read_b','read_c']);
 }
});

test('resume tools remain joined and retain original config, permission and registration policy',async()=>{
 const config=deferred(),catalogue=deferred(),f=preparation({readConfig:()=>config.promise,readTools:()=>catalogue.promise});
 let settled=false;const result=f.run().then(value=>{settled=true;return value});await flush();
 assert(f.calls.includes('tools:start'));assert(f.calls.includes('config:start'));
 config.resolve({mandatory_config:17});await flush();assert.equal(settled,false);assert(!f.calls.includes('instructions:start'));
 catalogue.resolve(tools);const value=await result;
 assert.equal(value.config.mandatory_config,17);assert.equal(value.approvalPolicy,'never');assert.equal(value.sandbox,'danger-full-access');assert.equal(value.dynamicTools,undefined);
 assert(f.calls.indexOf('instructions:start')>f.calls.indexOf('tools:done'));
 const other=preparation();other.params.usesDesktopMcp=false;other.params.registerDynamicTools=true;other.ctx.kOt=x=>x;assert.equal((await other.run()).dynamicTools,tools);
});

test('early tool rejection is handled while a later mandatory config failure retains precedence',async()=>{
 const config=deferred(),toolError=Error('fixture tools'),configError=Error('fixture config'),f=preparation({readConfig:()=>config.promise,readTools:async()=>{throw toolError}});
 const result=f.run();const rejected=assert.rejects(result,error=>error===configError);await flush();
 assert(f.calls.includes('tools:error'));assert(!f.calls.includes('instructions:start'));
 config.reject(configError);await rejected;await flush();
});

test('tool rejection after mandatory config succeeds preserves the original error and prevents later preparation',async()=>{
 const error=Error('fixture tools'),f=preparation({readTools:async()=>{throw error}});
 await assert.rejects(f.run(),value=>value===error);assert(f.calls.includes('config:done'));assert(!f.calls.includes('instructions:start'));
});

test('a synchronous tool exception is handled without an orphan rejection or changed error identity',async()=>{
 const error=Error('fixture synchronous tools'),f=preparation();f.adapters.readDynamicTools=()=>{throw error};
 await assert.rejects(f.run(),value=>value===error);await flush();
});

test('a resume without a tool provider retains the configuration-only path',async()=>{
 const f=preparation({usesTools:false});const result=await f.run();assert.equal(result.config.fixture_config,true);assert(!f.calls.some(x=>x.startsWith('tools:')));assert(f.calls.includes('instructions:done'));
});

test('actual renderer resume sends once only after mandatory settings, configuration and tools are ready',async()=>{
 const config=deferred(),catalogue=deferred(),f=resumeFixture({readConfig:()=>config.promise,readTools:()=>catalogue.promise});
 const result=f.run();await flush();assert(f.calls.includes('settings:done'));assert(f.calls.includes('tools:start'));assert.equal(f.resumes.length,0);
 config.resolve({mandatory_config:17});await flush();assert.equal(f.resumes.length,0);
 catalogue.resolve(tools);assert.equal((await result).status,'ready');assert.equal(f.resumes.length,1);
 assert.equal(f.resumes[0].config.mandatory_config,17);assert.deepEqual(f.resumes[0].config['mcp_servers.codex_apps.enabled_tools'],['read_a','read_b','read_c']);
 assert.equal(f.resumes[0].approvalPolicy,'never');assert(f.calls.indexOf('native:thread/resume')>f.calls.indexOf('instructions:done'));
});

test('actual renderer resume does not submit when mandatory preparation fails after tools finish',async()=>{
 const config=deferred(),error=Error('fixture config'),f=resumeFixture({readConfig:()=>config.promise});
 const result=f.run();const rejected=assert.rejects(result,value=>value===error);await flush();assert(f.calls.includes('tools:done'));config.reject(error);await rejected;assert.equal(f.resumes.length,0);
});

test('actual renderer resume joins tool errors before any Native submission',async()=>{
 const error=Error('fixture tool catalogue'),f=resumeFixture({readTools:async()=>{throw error}});
 await assert.rejects(f.run(),value=>value===error);assert.equal(f.resumes.length,0);assert(f.calls.includes('config:done'));assert(!f.calls.includes('instructions:start'));
});

test('actual renderer settings must be captured before either independent preparation starts',async()=>{
 const settings=deferred(),f=resumeFixture({readSettings:()=>settings.promise});
 const result=f.run();await flush();assert.deepEqual(f.calls,['settings:start']);assert.equal(f.resumes.length,0);
 settings.resolve({status:'not-ready',reason:'execution-config-loading'});assert.equal((await result).status,'not-ready');assert.deepEqual(f.calls,['settings:start','settings:done']);assert.equal(f.resumes.length,0);
});

test('actual renderer resume cancellation after parallel reads prevents Native submission and replay',async()=>{
 const config=deferred(),catalogue=deferred(),f=resumeFixture({readConfig:()=>config.promise,readTools:()=>catalogue.promise});
 const result=f.run();await flush();f.cancel();catalogue.resolve(tools);config.resolve({mandatory_config:true});
 assert.equal((await result).status,'not-ready');assert.equal(f.resumes.length,0);await flush();assert.equal(f.resumes.length,0);
});

test('an already owned ready renderer thread does not enter resume preparation',async()=>{
 const f=resumeFixture();f.conversation.resumeState='resumed';
 // Rln reads these methods at invocation. Its early owner guard must run before
 // any settings/tool/config read, rather than merely making those reads fast.
 const original=f.ctx.resume;let called=false;
 f.ctx.resume=(args)=>{args.manager.getStreamRole=()=>({role:'owner'});called=true;return original(args)};
 assert.equal((await f.run()).status,'ready');assert(called);assert.deepEqual(f.calls,[]);assert.equal(f.resumes.length,0);
});

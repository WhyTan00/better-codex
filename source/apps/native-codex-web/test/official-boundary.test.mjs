import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {OfficialBoundary} from '../src/official-boundary.mjs';
const ai='00000000-0000-4000-8000-4ba7215b54d2',secondary='00000000-0000-4000-8000-f82fe242e2a8';
const threads={[ai]:{id:ai,cwd:'${BETTER_CODEX_WORKSPACE}',status:{type:'idle'}},[secondary]:{id:secondary,cwd:'${BETTER_CODEX_SECONDARY_WORKSPACE}',status:{type:'idle'}}};
function setup(){const calls=[],rows=new Map();const native={start:async()=>{},rpc:async(method,params)=>{calls.push({method,params});if(method==='config/read')return {config:{approval_policy:'never',sandbox_mode:'workspace-write'}};if(method==='thread/read')return {thread:threads[params.threadId]};if(method==='thread/list')return {data:Object.values(threads),nextCursor:'next'};if(method==='turn/start')return {turn:{id:'turn-one',status:'inProgress'}};return {};}};const journal={ownsThread:(ws,id)=>ws==='ai'&&id===ai,run:async(ws,id,p,fn)=>{const key=ws+id;if(rows.has(key))return rows.get(key);const r={state:'accepted',result:await fn()};rows.set(key,r);return r;}};return {boundary:new OfficialBoundary({native,journal}),calls};}
test('official list and guessed ID reads stay in server workspace',async()=>{const {boundary:b}=setup();assert.deepEqual((await b.call('ai',{method:'thread/list'})).data.map(t=>t.id),[ai]);await assert.rejects(b.call('ai',{method:'thread/read',params:{threadId:secondary}}),e=>e.code===404);});
test('concurrent identical lists share one read, separate scopes and subsequent reads stay fresh',async()=>{
 const {boundary:b,calls}=setup(),request={method:'thread/list',params:{limit:50}};
 const [a,c,z]=await Promise.all([b.call('ai',request),b.call('ai',request),b.call('secondary',request)]);
 assert.deepEqual(a,c);assert.deepEqual(a.data.map(t=>t.id),[ai]);assert.deepEqual(z.data.map(t=>t.id),[secondary]);assert.equal(calls.filter(c=>c.method==='thread/list').length,2);
 await b.call('ai',request);assert.equal(calls.filter(c=>c.method==='thread/list').length,3);
});
test('browser permission and workspace overrides cannot be resumed',async()=>{const {boundary:b}=setup();await assert.rejects(b.call('ai',{id:'elevate',method:'thread/start',params:{sandbox:'danger-full-access'}},{clientId:'boundary-test'}),e=>e.code===403);await assert.rejects(b.call('ai',{id:'cross-root',method:'thread/start',params:{cwd:'${BETTER_CODEX_SECONDARY_WORKSPACE}'}},{clientId:'boundary-test'}),e=>e.code===403);});
test('lost ACK with stable user message ID executes only once',async()=>{const {boundary:b,calls}=setup();const request={id:'rpc-one',method:'turn/start',params:{threadId:ai,clientUserMessageId:'00000000-0000-4000-8000-ce3e780abe4a',input:[{type:'text',text:'QA'}]}};const first=await b.call('ai',request,{clientId:'tab1'});const retry=await b.call('ai',{...request,id:'rpc-two'},{clientId:'tab2'});assert.deepEqual(first,retry);assert.equal(calls.filter(x=>x.method==='turn/start').length,1);});
test('native events and global drafts are not sent to another workspace',async()=>{const {boundary:b}=setup();assert.equal(await b.notification('ai',{method:'item/agentMessage/delta',params:{threadId:secondary,delta:'private'}}),null);const c=b.bootstrap('ai',{gatewayBaseUrl:'http://test',gatewayWsUrl:'ws://test/ws',persistedAtomSnapshot:{'prompt-history':['private'],'composer-prompt-drafts-v2':{x:'private'},'sidebar-width':260}});assert.deepEqual(c.persistedAtomSnapshot,{'sidebar-width':260});assert.equal(c.gatewayWsUrl,'ws://test/w/ai/ws');});

test('repeated token events reuse verified thread metadata',async()=>{const {boundary:b,calls}=setup();for(let i=0;i<50;i++)assert.ok(await b.notification('ai',{method:'item/agentMessage/delta',params:{threadId:ai,delta:'x'}}));assert.equal(calls.filter(x=>x.method==='thread/read').length,1);});
test('resume applies only the current authorized host policy',async()=>{const {boundary:b,calls}=setup();await b.call('ai',{id:'resume-matching',method:'thread/resume',params:{threadId:ai,approvalPolicy:'never',sandbox:'workspace-write',approvalsReviewer:null}},{clientId:'boundary-test'});const c=calls.find(x=>x.method==='thread/resume');assert.ok(c);assert.equal(c.params.approvalPolicy,'never');assert.equal(c.params.sandbox,'workspace-write');});

function sharedSetup(){
 const calls=[],native=new EventEmitter();native.loaded=[ai,secondary];native.start=async()=>{};
 native.rpc=async(method,params)=>{calls.push({method,params});if(method==='thread/read')return {thread:threads[params.threadId]};if(method==='thread/loaded/list')return {data:native.loaded,nextCursor:null};return {};};
 native.send=m=>calls.push(m);
 const journal={ownsThread:()=>false,run:async(ws,id,p,fn)=>({state:'accepted',result:await fn()})};
 return {native,calls,boundary:new OfficialBoundary({native,journal})};
}
test('same-host native CLI can resume without a persistent Web ownership grant',async()=>{
 const {boundary:b,calls}=sharedSetup();await b.call('ai',{id:'resume-cli',method:'thread/resume',params:{threadId:ai}},{clientId:'cli-qa'});
 assert.deepEqual(calls.map(x=>x.method),['thread/read','thread/resume']);
});
test('loaded CLI membership cannot bypass scope or survive host removal',async()=>{
 const {boundary:b,native,calls}=sharedSetup();await assert.rejects(b.call('ai',{id:1,method:'thread/resume',params:{threadId:secondary}},{clientId:'qa'}),e=>e.code===404);
 assert(!calls.some(x=>x.method==='thread/resume'));
 await b.writable({id:'ai',root:'${BETTER_CODEX_WORKSPACE}'},ai);native.loaded=[];native.emit('interrupted');
 await assert.rejects(b.writable({id:'ai',root:'${BETTER_CODEX_WORKSPACE}'},ai),e=>e.code===403);
});
test('same-host CLI approval keeps native ID and is answered once',async()=>{
 const {boundary:b,calls}=sharedSetup();const m={id:'native-cli-approval',method:'item/tool/requestUserInput',params:{threadId:ai}};b.observe(m);
 await assert.rejects(b.answer('secondary',{id:m.id,result:{answers:{}}}),e=>e.code===404);
 await b.answer('ai',{id:m.id,result:{answers:{}}});await assert.rejects(b.answer('ai',{id:m.id,result:{answers:{}}}),e=>e.code===409);
 assert.equal(calls.filter(x=>x.id===m.id).length,1);
});
test('loaded membership follows pagination and rejects repeating cursor',async()=>{
 const {boundary:b,native}=sharedSetup();const original=native.rpc;
 native.rpc=async(m,p)=>m==='thread/loaded/list'?(p.cursor?{data:[ai],nextCursor:null}:{data:[],nextCursor:'p2'}):original(m,p);
 await b.writable({id:'ai',root:'${BETTER_CODEX_WORKSPACE}'},ai);
 native.rpc=async(m,p)=>m==='thread/loaded/list'?{data:[],nextCursor:'loop'}:original(m,p);
 await assert.rejects(b.writable({id:'ai',root:'${BETTER_CODEX_WORKSPACE}'},ai),e=>e.code===503);
});
test('an already active CLI turn cannot be silently steered by Web turn/start',async()=>{
 const {boundary:b,native,calls}=sharedSetup(),original=native.rpc;
 native.rpc=async(m,p)=>m==='thread/read'?{thread:{...threads[ai],status:{type:'active',activeFlags:[]}}}:original(m,p);
 await assert.rejects(b.call('ai',{id:'active-cli',method:'turn/start',params:{threadId:ai,input:[{type:'text',text:'QA'}]}},{clientId:'qa'}),e=>e.code===409);
 assert(!calls.some(c=>c.method==='turn/start'));
});
test('runtime roots and environment overrides cannot escape the selected workspace',async()=>{
 const {boundary:b}=setup();for(const extra of [{runtimeWorkspaceRoots:['${BETTER_CODEX_SECONDARY_WORKSPACE}']},{environments:[{id:'other-host'}]}])await assert.rejects(b.call('ai',{id:JSON.stringify(extra),method:'turn/start',params:{threadId:ai,...extra}},{clientId:'qa'}),e=>e.code===403);
});
test('simultaneous browser approval answers send exactly one native response',async()=>{
 const {boundary:b,calls}=sharedSetup();b.observe({id:'race',method:'item/tool/requestUserInput',params:{threadId:ai}});
 const results=await Promise.allSettled([b.answer('ai',{id:'race',result:{answers:{}}}),b.answer('ai',{id:'race',result:{answers:{}}})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(calls.filter(r=>r.id==='race').length,1);
});
test('accepted ACK recovery does not depend on newly materializing native history',async()=>{
 const {boundary:b,calls}=setup(),request={id:'initial',method:'turn/start',params:{threadId:ai,clientUserMessageId:'00000000-0000-4000-8000-065ebedd1a42',input:[{type:'text',text:'QA'}]}};
 const first=await b.call('ai',request,{clientId:'one'}),original=b.native.rpc;
 b.native.rpc=async(m,p)=>{if(m==='thread/read')throw Object.assign(Error('rollout is empty'),{code:502});return original(m,p)};
 const recovered=await b.call('ai',{...request,id:'retry'},{clientId:'two'});assert.deepEqual(recovered,first);assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
});

test('native auth status never returns or refreshes a bearer token requested by a browser',async()=>{
 const {boundary:b,calls}=setup();await b.call('ai',{method:'getAuthStatus',params:{includeToken:true,refreshToken:true}});assert.deepEqual(calls.at(-1),{method:'getAuthStatus',params:{includeToken:false,refreshToken:false}});
});
test('stale resume profiles cannot override the host; new turn escalation remains rejected',async()=>{
 const {boundary:b,calls}=setup();await b.call('ai',{id:'native-profile',method:'thread/resume',params:{threadId:ai,permissions:':workspace',config:{}}},{clientId:'qa'});assert(!('permissions' in calls.at(-1).params));
 await b.call('ai',{id:'stale-profile',method:'thread/resume',params:{threadId:ai,permissions:':danger-full-access',approvalPolicy:'on-request',approvalsReviewer:'guardian_subagent'}},{clientId:'qa'});assert.equal(calls.at(-1).params.sandbox,'workspace-write');assert.equal(calls.at(-1).params.approvalPolicy,'never');assert.equal(calls.at(-1).params.approvalsReviewer,undefined);
 await assert.rejects(b.call('ai',{id:'bad-profile',method:'turn/start',params:{threadId:ai,permissions:':danger-full-access'}},{clientId:'qa'}),e=>e.code===403);
});
test('resume policy rechecks host changes rather than trusting the cached bootstrap',async()=>{
 const {boundary:b,calls}=setup();await b.config();const rpc=b.native.rpc;b.native.rpc=async(m,p)=>m==='config/read'?{config:{approval_policy:'on-request',sandbox_mode:'read-only',approvals_reviewer:'user'}}:rpc(m,p);
 await b.call('ai',{id:'old-ui',method:'thread/resume',params:{threadId:ai,approvalPolicy:'never',sandbox:'danger-full-access'}},{clientId:'qa'});assert.equal(calls.at(-1).params.sandbox,'read-only');assert.equal(calls.at(-1).params.approvalPolicy,'on-request');assert.equal(calls.at(-1).params.approvalsReviewer,'user');
});
test('desktop feature hints never change the native execution host configuration',async()=>{const {boundary:b,calls}=setup();await b.call('ai',{id:'ui-hints',method:'thread/resume',params:{threadId:ai,config:{'features.artifacts':true,'features.remote_control':true}}},{clientId:'qa'});assert.equal('config' in calls.at(-1).params,false);await assert.rejects(b.call('ai',{id:'route-change',method:'thread/resume',params:{threadId:ai,config:{model_provider:'other'}}},{clientId:'qa'}),e=>e.code===403);});

test('official resume accepts a matching native path and empty history, rejects injected or mismatched history',async()=>{
 const {boundary:b,calls}=setup(),native=b.native.rpc;b.native.rpc=async(m,p)=>m==='thread/read'?{thread:{...threads[p.threadId],path:'/native/rollout-'+p.threadId+'.jsonl'}}:native(m,p);
 await b.call('ai',{id:'recorded-resume',method:'thread/resume',params:{threadId:ai,path:'/native/rollout-'+ai+'.jsonl',history:[]}},{clientId:'qa'});assert.equal('path'in calls.at(-1).params,false);assert.equal('history'in calls.at(-1).params,false);
 for(const extra of [{path:'/native/rollout-'+secondary+'.jsonl'},{history:[{role:'system',content:'injected'}]}])await assert.rejects(b.call('ai',{id:'bad-resume',method:'thread/resume',params:{threadId:ai,...extra}},{clientId:'qa'}),e=>e.code===403);
});
test('account metadata requests cannot force a credential refresh',async()=>{const {boundary:b,calls}=setup();await b.call('ai',{method:'account/read',params:{refreshToken:true}});assert.deepEqual(calls.at(-1),{method:'account/read',params:{refreshToken:false}});});

test('native old-thread model picker updates next-turn settings without writing global config',async()=>{
 const {boundary:b,calls}=setup();await b.call('ai',{id:'model-choice',method:'thread/settings/update',params:{threadId:ai,model:'gpt-5.6-luna',effort:'medium',multiAgentMode:'proactive'}},{clientId:'model-picker'});
 assert.deepEqual(calls.at(-1),{method:'thread/settings/update',params:{threadId:ai,model:'gpt-5.6-luna',effort:'medium'}});
 assert(!calls.some(c=>c.method==='config/batchWrite'||c.method==='turn/start'));
 await assert.rejects(b.call('ai',{id:'cross-model',method:'thread/settings/update',params:{threadId:secondary,model:'gpt-5.6-luna'}},{clientId:'model-picker'}),e=>e.code===404);
 for(const extra of [{cwd:'${BETTER_CODEX_WORKSPACE}'},{modelProvider:'unapproved-provider'},{permissions:':danger-full-access'},{collaborationMode:{mode:'plan',settings:{model:'gpt-5.6-luna'}}}])await assert.rejects(b.call('ai',{id:JSON.stringify(extra),method:'thread/settings/update',params:{threadId:ai,model:'gpt-5.6-luna',...extra}},{clientId:'model-picker'}),e=>e.code===403);
});
test('model settings cannot acquire or bypass another native writer',async()=>{
 const {boundary:b,native,calls}=sharedSetup();native.loaded=[];
 await assert.rejects(b.call('ai',{id:'locked-model',method:'thread/settings/update',params:{threadId:ai,model:'gpt-5.6-luna',effort:'low'}},{clientId:'model-picker'}),e=>e.code===403);
 assert(!calls.some(c=>c.method==='thread/settings/update'||c.method==='thread/resume'));
});
test('default-mode questions are an adapter-owned session feature, never a global or client-supplied config write',async()=>{
 const {boundary:b,calls}=setup();b.enableDefaultModeQuestions=true;
 await b.call('ai',{id:'question-session',method:'thread/resume',params:{threadId:ai,config:{'features.default_mode_request_user_input':false,'features.remote_control':true}}},{clientId:'question-ui'});
 assert.deepEqual(calls.at(-1).params.config,{'features.default_mode_request_user_input':true});assert(!calls.some(c=>c.method==='config/batchWrite'));
 await assert.rejects(b.call('ai',{id:'question-route-override',method:'thread/resume',params:{threadId:ai,config:{model_provider:'unapproved'}}},{clientId:'question-ui'}),e=>e.code===403);
});


test('native resume acquires historical writer ownership; rejected acquisition never grants it',async()=>{
 const {boundary:b,native,calls}=sharedSetup();native.loaded=[];const owned=new Set();
 b.journal.ownsThread=(ws,id)=>owned.has(id);b.journal.manageThread=(ws,id)=>owned.add(id);
 const original=native.rpc;let blocked=true;
 native.rpc=async(m,p)=>{if(m==='thread/resume'){calls.push({method:m,params:p});if(blocked)throw Object.assign(Error('thread writer lock already held'),{code:502});native.loaded.push(ai);return {thread:threads[ai]};}return original(m,p);};
 await assert.rejects(b.call('ai',{id:'locked',method:'thread/resume',params:{threadId:ai}},{clientId:'qa'}),e=>e.code===409);
 assert.equal(owned.size,0);assert(!calls.some(c=>c.method==='turn/start'));
 blocked=false;await b.call('ai',{id:'released',method:'thread/resume',params:{threadId:ai}},{clientId:'qa'});
 assert(owned.has(ai));assert((await b.writable({id:'ai',root:'${BETTER_CODEX_WORKSPACE}'},ai)).id===ai);
});
test('pinning scoped historical metadata does not acquire a writer and cannot cross scopes',async()=>{const {boundary:b,native,calls}=sharedSetup();native.loaded=[];await b.call('ai',{id:'pin-history',method:'thread/section/move',params:{threadId:ai,sectionId:'01984de2-8f74-7c91-a3b2-5c5e937cf318',beforeThreadId:null}},{clientId:'pin-test'});assert.equal(calls.filter(c=>c.method==='thread/section/move').length,1);assert(!calls.some(c=>c.method==='thread/resume'));await assert.rejects(b.call('ai',{id:'pin-cross',method:'thread/section/move',params:{threadId:secondary,sectionId:null}},{clientId:'pin-test'}),e=>e.code===404);});

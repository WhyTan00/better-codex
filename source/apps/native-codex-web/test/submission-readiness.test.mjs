import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {patchSubmissionReadiness} from '../src/official-submission-readiness.mjs';

const frozenBaseline=new URL('../../../acceptance/submission-before/pwa-initial.js',import.meta.url);
const workspaceBaseline=new URL('../../../runtime/quant-send-edit-review-20260928/ui/pwa/native-assets/v1033/app-initial-cadb12d4a15e.js',import.meta.url);
const input=process.env.DSH_SUBMISSION_INITIAL?await readFile(process.env.DSH_SUBMISSION_INITIAL,'utf8'):await readFile(frozenBaseline,'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return readFile(workspaceBaseline,'utf8');});
const initial=process.env.DSH_SUBMISSION_APPLY_PATCH==='1'||!process.env.DSH_SUBMISSION_INITIAL?patchSubmissionReadiness(input):input;
const queue=await readFile(process.env.DSH_SUBMISSION_QUEUE||new URL('../public/native-queue-client.js',import.meta.url),'utf8');
const cache=await readFile(process.env.DSH_SUBMISSION_CACHE||new URL('../public/native-local-cache.js',import.meta.url),'utf8');
if(process.env.DSH_SUBMISSION_SCOPE){const scope=await readFile(process.env.DSH_SUBMISSION_SCOPE,'utf8');assert(scope.includes(queue.trim()),'final scope contains the exact queue module');assert(scope.includes(cache.trim()),'final scope contains the exact Native head module');}
const A='11111111-1111-4111-a111-111111111111',B='22222222-2222-4222-a222-222222222222',OLD='33333333-3333-4333-a333-333333333333',NEW='44444444-4444-4444-a444-444444444444';
const cut=(from,to)=>{const a=initial.indexOf(from),b=initial.indexOf(to,a);assert(a>=0&&b>a,from);return initial.slice(a,b);};
const fn=name=>{const a=initial.indexOf('function '+name+'(');assert(a>=0,name);const b=initial.indexOf('}function ',a),c=initial.indexOf('}var ',a);return initial.slice(a,Math.min(...[b,c].filter(n=>n>a))+1);};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});promise.catch(()=>{});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
const mode={mode:'plan',settings:{model:'gpt-6-astra',reasoning_effort:'max',developer_instructions:'fixture instruction'}};
const turn=(id,status='completed',text='old')=>({turnId:id,status,params:{input:[{type:'text',text}],model:'gpt-6-astra',effort:'max'},items:[{id:id+'-item',type:'agentMessage',text}],turnStartedAtMs:1,error:null});

function fixture({canonical=false,paginated=false,hostId='local'}={}){
 const history=deferred(),native=deferred(),writes=[],events=[],roles=new Map(),callbacks=new Map(),pendingSettings=new Map();
 let resultCalls=0,headReads=0,generation=0,currentHead=null;
 const conversation={id:A,cwd:'/fixture',resumeState:'needs_resume',latestModel:'gpt-6-astra',latestReasoningEffort:'max',latestCollaborationMode:structuredClone(mode),threadRuntimeStatus:{type:'notLoaded'},turns:[turn(OLD)],currentPermissions:{approvalPolicy:'never',approvalsReviewer:'user',sandboxPolicy:{type:'dangerFullAccess'}}};
 const conversations=new Map([[A,conversation],[B,{...structuredClone(conversation),id:B}]]);
 const reply={thread:{id:A,path:'/fixture/rollout.jsonl',cwd:'/fixture',status:{type:'idle'},historyMode:paginated?'paginated':'legacy',turns:[],createdAt:1,updatedAt:2,threadSource:'user'},cwd:'/fixture',model:'gpt-6-astra',reasoningEffort:'max',modelProvider:'openai',approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'},runtimeWorkspaceRoots:['/fixture'],turnsBackwardsCursor:'fixture-turn-cursor',itemsBackwardsCursor:'fixture-item-cursor'};
 const product={getRequestOptions:()=>({}),getThreadStartKind:()=>null,workspace:{projectlessPathSentinel:'~',getCwd:({cwd,fallbackCwd})=>cwd??fallbackCwd,getWritableRoot:()=>null,getSandboxPolicy:({sandboxPolicy})=>sandboxPolicy,arePathsEquivalent:(a,b)=>a===b},history:{mapResumeResponse:()=>[]},prepare:async()=>({start:{cwd:'/fixture',modelProvider:'openai',config:{},runtimeWorkspaceRoots:['/fixture']},requestOptions:{},backgroundRequestOptions:{},preserveServerPermissions:true,canInferMissingRuntimeWorkspaceRoots:false,canReuseRunningThread:true,independentHistory:null,useTurnsPageFallback:true,drainRemainingHistory:false,completeRequest:x=>x,getResult:async()=>{resultCalls++;return {model:'gpt-6-astra',collaborationModel:'gpt-6-astra',reasoningEffort:'max',developerInstructions:null};}})};
 const manager={hostId,disposed:false,inFlightConversationResumes:new Map(),pendingThreadSettingsUpdates:pendingSettings,settings:{},requestClient:{getAppServerVersion:()=> '1'},tracing:{},history:{turnMergePolicy:null,mapThreadTurns:({turns})=>turns.map(t=>t.turnId?t:{...t,turnId:t.id,params:{input:[],model:'gpt-6-astra',effort:'max'},items:t.items||[]})},projectlessConversations:{load:async()=>false},logger:{info(){},warning(){},error(){}},
  getHostId:()=>hostId,getConversation:id=>conversations.get(id),getWindowActivity:()=>({visibilityState:'visible',canAcquireThreadStream:true}),getStreamRole:id=>roles.get(id),setConversationStreamRole(id,role){role?roles.set(id,role):roles.delete(id);},isConversationStreaming:id=>roles.has(id),needsResume:id=>conversations.get(id)?.resumeState==='needs_resume'||!roles.has(id),canUsePermissionSelection:()=>false,useTailHydration:()=>true,supportsPaginatedThreadHistory:()=>paginated,getConversationTurnItemLimit:()=>6,getThreadWorkspaceState:()=>null,
  updateConversationState(id,apply){apply(conversations.get(id));},ensureRecentConversationId(){},getThreadSummaries:()=>[],readThread:async()=>({thread:structuredClone(reply.thread)}),readShellEnvironmentPolicy:async()=>({}),listThreadTurns:async()=>({response:await history.promise}),beginResumeNotificationBuffer(){events.push('buffer-begin');},releaseResumeNotificationBuffer(){events.push('buffer-release');},beginThreadGoalHydration:()=>null,isCurrentThreadGoalHydration:()=>false,endThreadGoalHydration:()=>false,acceptConversationHistory(_id,value){events.push({acceptedHistory:value});},broadcastConversationSnapshot(){},getThreadHasUnreadTurn:()=>false,
  async sendRequest(method,params){events.push(method);if(method==='thread/resume')return native.promise;if(method==='thread/goal/get')return {goal:null};throw Error('unexpected real request '+method);},
  waitForPendingThreadSettingsUpdate:async id=>{await pendingSettings.get(id);},
  async startTurn(id,operation){await manager.waitForPendingThreadSettingsUpdate(id);const h=manager.dshSubmissionHead?.(id);if(h&&!h.isCurrent())throw Error('stale submission head');assert.equal(roles.get(id)?.role,'owner');assert.equal(operation.request.threadId,id);writes.push({method:'turn/start',id,operation:structuredClone(operation)});const next=turn(NEW,'inProgress','new');next.params.effort='max';const state=conversations.get(id);state.threadRuntimeStatus={type:'active'};state.latestModel='gpt-6-astra';state.latestReasoningEffort='max';state.latestCollaborationMode=structuredClone(mode);ctx.GS(state,next,()=>webcrypto.randomUUID());return {turn:{id:NEW}};},
  async steerTurn(id,input,restore){writes.push({method:'turn/steer',id,input,restore});return {turnId:OLD};},
  addNotificationCallback(method,callback){callbacks.set(method,callback);},
  dshReadExecutionHead:async id=>{headReads++;const stamp=generation;currentHead={threadId:id,loaded:true,activeFlags:[],activeTurnId:null,threadSource:'user',isCurrent:()=>stamp===generation&&location.pathname==='/local/'+id&&window.__DSH_EXECUTION_CONNECTED__};return currentHead;},
 };
 const location={pathname:'/local/'+A};
 const window={__DSH_SCOPE__:{id:'fixture',token:'fixture'},__DSH_NATIVE_ONLINE__:true,__DSH_EXECUTION_CONNECTED__:true,__DSH_NATIVE_CACHE__:{meta:async()=>null,saveMeta:async()=>{},pendingCommands:async()=>[]},dispatchEvent(){}};
 const ctx={window,location,document:{visibilityState:'hidden',addEventListener(){}},navigator:{onLine:true},crypto:webcrypto,structuredClone,URL,URLSearchParams,Response,CustomEvent,setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},addEventListener(){},removeEventListener(){},fetch:async()=>new Response(JSON.stringify({authority:'mac-native',state:{[A]:[]},revisions:{[A]:'r'}})),
  Q_:'durable',Xg:x=>x,Han:()=>product,Uln:async()=>[],Vln:(_g,cwd)=>cwd,Bln:(cwd,roots)=>[cwd,...roots.filter(x=>x!==cwd)],Hln:({resumeWorkspaceRoots})=>resumeWorkspaceRoots,DS:()=>null,CS:c=>c.turns,sS:x=>structuredClone(x),Vsn:()=>({applied:null}),Pg:()=>conversation.currentPermissions,RC:(a,b)=>[...new Set([...a,...b])],Fsn:x=>x,pC:t=>({updatedAt:t.updatedAt*1000,recencyAt:t.updatedAt*1000}),mC:({updatedAt})=>updatedAt,fcn:({requestedCwd,responseCwd,threadCwd})=>requestedCwd??responseCwd??threadCwd,Lsn:(_cwd,roots)=>roots,vcn:()=>({approvalPolicy:'never',approvalsReviewer:'user',sandboxPolicy:{type:'dangerFullAccess'}}),Kln:{default:(a,b)=>JSON.stringify(a)===JSON.stringify(b)},j9t:(_reply,model,effort,cwd,collaborationMode)=>({model,effort,cwd,collaborationMode}),M9t:()=>({}),vC:(state,values)=>{state.latestModel=values.model;state.latestReasoningEffort=values.effort;state.latestCollaborationMode=values.collaborationMode;},Iln:()=>false,gv:e=>e.message,tan:()=>null,Wrn:()=>false,Wln:()=>null,Gln:()=>null,SC:class extends Error{},Bdn:{default:(rows,fn)=>rows.findLast(fn)},wS:c=>ctx.CS(c),
  jln:r=>({turnsBackwardsCursor:r.turnsBackwardsCursor,itemsBackwardsCursor:r.itemsBackwardsCursor}),Q4t:async()=>({response:await history.promise}),Y2t:{default:(a,b)=>JSON.stringify(a)===JSON.stringify(b)},$xt:()=>null,J2t:()=>false,
  zx:class{},Ddn:[],ES:c=>ctx.CS(c).at(-1),jS:c=>ctx.CS(c).at(-1),fun:()=>false,pun:()=>false,fv:()=>false,X_:()=>false,Edn(){},Adn:()=>false,
  nE:'local',kI:Symbol(),Ybr:Symbol(),kMs:()=>false,nMs:'unavailable',mYn:a=>a||[],aMs:c=>({input:{type:'text',text:c.prompt},responseItems:[]}),uMs:c=>(c.imageAttachments||[]).map(x=>({type:'image',url:x.url})),IA:x=>x,PYn:()=>[],hAt:()=>false,OMs:()=>false,GIn:'explicitRequestOnly',iK:()=>null,yMs:x=>x,KO:()=>null,Rb:()=>manager,
  Vls:async()=>{},DMs:()=>false,
 };
 vm.createContext(ctx);
 const merge=['V2t','z2t','c8t','xS','o8t','GS','q2t','B2t','G2t','W2t','K2t','U2t','yS','K4t','H4t','W4t','U4t','AS','kS','CS','$2t'].map(fn).join(';');
 vm.runInContext(merge+';'+cut('async function Rln(','function zln(')+';globalThis.methods={'+cut('maybeResumeConversation(e,t){','async resumeConversation(e,t){')+','+cut('async resumeConversation(e,t){','assertThreadFollowerOwner(e){')+'};',ctx);
 Object.setPrototypeOf(manager,ctx.methods);
 if(canonical){manager.getConversation(A).canonicalTurnHistory=true;ctx.AS(conversation,[turn(OLD)],true,undefined,null);}
 const attemptHelpers=initial.includes('const dshAttemptConfigs=new WeakMap();')?cut('const dshAttemptConfigs=new WeakMap();','async function TMs('):'';
 vm.runInContext(attemptHelpers+'const Odn='+cut('Odn=class extends zx{','}));function Adn(').slice(4)+';'+cut('function Mdn(','var Ndn=')+';'+cut('async function EMs(','function DMs(')+cut('async function TMs(','async function EMs(')+';globalThis.coordinatorFactory=Mdn;',ctx);
 const q=ctx.coordinatorFactory(manager,{logger:manager.logger,storage:{readQueuedFollowUps:()=>({isLoading:false,value:{}})}},()=>{});manager.turnCoordinator=q;
 q.setMessagePreparation((request,kind)=>{const args={scope:{get:()=>null},manager,hostId,targetConversationId:request.conversationId,cwd:'/fixture',context:request.message.context,activeCollaborationMode:request.message.context.collaborationMode,restoreMessage:request.message,clientUserMessageId:request.message.id};return kind==='start'?ctx.TMs(args):ctx.EMs(args);},async()=> 'send-now');
 vm.runInContext(queue,ctx);window.__DSH_INSTALL_NATIVE_QUEUE__(manager);
 const resume=()=>manager.resumeConversation({conversationId:A,model:null,reasoningEffort:null,workspaceRoots:['/fixture'],collaborationMode:structuredClone(mode)});
 const send=(options={},onMessageAdded)=>q.sendMessage({conversationId:A,message:{id:'55555555-5555-4555-a555-555555555555',text:'fixture',cwd:'/fixture',context:{prompt:'fixture',fileAttachments:[],pastedTextAttachments:[],addedFiles:[],imageAttachments:[{url:'fixture:image'}],collaborationMode:structuredClone(mode)}},...options},onMessageAdded);
 return {manager,q,conversation,conversations,history,native,reply,writes,events,roles,window,location,ctx,pendingSettings,resume,send,get resultCalls(){return resultCalls;},get headReads(){return headReads;},invalidate(){generation++;},get currentHead(){return currentHead;},finishHistory(){history.resolve({data:[turn(OLD)],nextCursor:null});}};
}

test('Native-ready submission does not wait for an unrelated history page',async()=>{
 const f=fixture(),hydrating=f.resume();hydrating.catch(()=>{});await flush();f.native.resolve(f.reply);await flush();
 let result;const sending=f.send().then(x=>result=x);sending.catch(()=>{});await flush();
 try{assert.equal(f.writes.length,1,'the old resume/history promise must not block a prepared send');assert.equal(result?.status,'sent');assert(f.manager.inFlightConversationResumes.has(A),'the original hydration remains owned');assert.equal(f.resultCalls,1);assert.equal(f.writes[0].operation.request.collaborationMode.settings.reasoning_effort,'max');assert.equal(f.writes[0].operation.request.input[1].type,'image');}
 finally{f.finishHistory();await Promise.allSettled([hydrating,sending]);}
 assert.equal(f.manager.inFlightConversationResumes.size,0);assert.equal(f.writes.length,1);assert.equal(f.resultCalls,1);
});

test('connection recovery during the original Native resume refreshes the retired head once before writing',async()=>{
 const f=fixture(),hydrating=f.resume();hydrating.catch(()=>{});await flush();
 const sending=f.send();sending.catch(()=>{});await flush();assert.equal(f.headReads,1);assert.equal(f.writes.length,0);
 f.invalidate();f.native.resolve(f.reply);await flush();f.finishHistory();const [,result]=await Promise.all([hydrating,sending]);
 assert.equal(f.headReads,2);assert.equal(result.status,'sent');assert.equal(f.writes.length,1);assert.equal(f.writes[0].id,A);
});

test('a second connection change rejects the refreshed head without another retry or write',async()=>{
 const f=fixture(),hydrating=f.resume();hydrating.catch(()=>{});await flush();
 const original=f.manager.dshReadExecutionHead;let reads=0;f.manager.dshReadExecutionHead=async id=>{const head=await original(id);if(++reads===2)f.invalidate();return head;};
 const sending=f.send(),failed=assert.rejects(sending,/状态已变化|连接已变化/);await flush();f.invalidate();f.native.resolve(f.reply);f.finishHistory();await Promise.all([hydrating,failed]);
 assert.equal(reads,2);assert.equal(f.writes.length,0);
});

test('a later history failure cannot revoke the Native owner or an accepted send',async()=>{
 const f=fixture(),hydrating=f.resume(),historyFailure=assert.rejects(hydrating,/history fixture failed/);await flush();f.native.resolve(f.reply);await flush();let outcome;const sending=f.send().then(x=>outcome=x);sending.catch(()=>{});await flush();f.history.reject(Error('history fixture failed'));await historyFailure;await Promise.allSettled([sending]);
 assert.equal(outcome?.status,'sent');assert.equal(f.roles.get(A)?.role,'owner');assert.equal(f.conversation.resumeState,'resumed');assert.equal(f.conversation.threadRuntimeStatus.type,'active');assert.equal(f.manager.inFlightConversationResumes.size,0);assert.equal(f.writes.length,1);
});

for(const canonical of [false,true])test('late history preserves a newer live turn and terminal state ('+(canonical?'canonical':'array')+')',async()=>{
 const f=fixture({canonical}),hydrating=f.resume();await flush();f.native.resolve(f.reply);await flush();const sending=f.send();sending.catch(()=>{});await flush();
 const old=f.ctx.CS(f.conversation).find(t=>t.turnId===OLD);old.status='completed';old.items.push({id:'live-final',type:'agentMessage',text:'live final',phase:'final_answer'});
 f.history.resolve({data:[turn(OLD,'inProgress')],nextCursor:null});await Promise.allSettled([hydrating,sending]);
 const turns=f.ctx.CS(f.conversation);assert.equal(turns.find(t=>t.turnId===OLD).status,'completed');assert(turns.find(t=>t.turnId===OLD).items.some(i=>i.id==='live-final'));assert.equal(turns.find(t=>t.turnId===NEW)?.status,'inProgress');assert.equal(f.conversation.threadRuntimeStatus.type,'active');assert.equal(f.resultCalls,1);assert.equal(f.writes.length,1);
});

test('Native resume rejection sends nothing and does not grant renderer ownership',async()=>{
 const f=fixture(),hydrating=f.resume(),failed=assert.rejects(hydrating,/native fixture rejected/);await flush();const sending=f.send(),notSent=assert.rejects(sending);f.native.reject(Error('native fixture rejected'));await Promise.all([failed,notSent]);assert.equal(f.writes.length,0);assert.equal(f.roles.has(A),false);assert.equal(f.manager.inFlightConversationResumes.size,0);
});

test('switching the visible thread during Native preparation retains the captured submission target',async()=>{
 const f=fixture(),native=headFixture({client:f.manager,window:f.window,location:f.location}),before=structuredClone(f.conversations.get(B)),hydrating=f.resume();await flush();const sending=f.send();sending.catch(()=>{});f.location.pathname='/local/'+B;native.emit('dsh:native-route');f.native.resolve(f.reply);await flush();f.finishHistory();await Promise.all([hydrating,sending]);assert.equal(f.writes.length,1);assert.equal(f.writes[0].id,A);assert.deepEqual(f.conversations.get(B),before);
});

test('explicit settings remain a prerequisite and are never replaced by fresh loaded status',async()=>{
 const f=fixture(),hydrating=f.resume();await flush();f.native.resolve(f.reply);await flush();const setting=deferred();f.pendingSettings.set(A,setting.promise);const sending=f.send();sending.catch(()=>{});await flush();assert.equal(f.writes.length,0);setting.resolve();f.pendingSettings.delete(A);f.finishHistory();await Promise.all([hydrating,sending]);assert.equal(f.writes.length,1);
});

test('retired Native readiness cannot be used after the connection generation changes',async()=>{
 const f=fixture(),hydrating=f.resume();await flush();f.native.resolve(f.reply);await flush();const original=f.q.prepareMessage,preparing=deferred();f.q.prepareMessage=async(...args)=>{await preparing.promise;return original(...args);};const sending=f.send(),failed=assert.rejects(sending,/stale submission head|状态已变化|连接已变化/);await flush();f.invalidate();preparing.resolve();f.finishHistory();await Promise.all([hydrating,failed]);assert.equal(f.writes.length,0);
});

for(const canonical of [false,true])test('paginated snapshot keeps a newer live item while refreshing an unchanged cached item ('+(canonical?'canonical':'array')+')',async()=>{
 const f=fixture({canonical,paginated:true}),before=f.ctx.CS(f.conversation)[0];
 before.status='inProgress';before.items=[{id:'live-item',type:'agentMessage',text:'cached partial'},{id:'unchanged-item',type:'agentMessage',text:'cached old'}];before.itemsPagination={hasLoadedOldest:true,olderCursor:null};
 const hydrating=f.resume();await flush();f.native.resolve(f.reply);await flush();const sending=f.send();sending.catch(()=>{});await flush();
 const current=f.ctx.CS(f.conversation).find(t=>t.turnId===OLD);current.status='completed';current.items=current.items.map(item=>item.id==='live-item'?{...item,text:'new live final',phase:'final_answer'}:item);
 const snapshot=turn(OLD,'inProgress');snapshot.items=[{id:'live-item',type:'agentMessage',text:'old snapshot partial'},{id:'unchanged-item',type:'agentMessage',text:'fresh native snapshot'}];snapshot.itemsPagination={hasLoadedOldest:true,olderCursor:null};
 f.history.resolve({data:[snapshot],nextCursor:null});await Promise.all([hydrating,sending]);
 const turns=f.ctx.CS(f.conversation),merged=turns.find(t=>t.turnId===OLD);assert.equal(merged.status,'completed');assert.equal(merged.items.find(i=>i.id==='live-item').text,'new live final');assert.equal(merged.items.find(i=>i.id==='unchanged-item').text,'fresh native snapshot');assert.equal(turns.find(t=>t.turnId===NEW).status,'inProgress');assert.equal(f.conversation.threadRuntimeStatus.type,'active');assert.equal(f.writes.length,1);
});

test('an unchanged paginated item still adopts the Native snapshot',async()=>{
 const f=fixture({canonical:true,paginated:true}),old=f.ctx.CS(f.conversation)[0];old.itemsPagination={hasLoadedOldest:true,olderCursor:null};const hydrating=f.resume();await flush();f.native.resolve(f.reply);await flush();
 const snapshot=turn(OLD,'completed','fresh native');snapshot.itemsPagination={hasLoadedOldest:true,olderCursor:null};f.history.resolve({data:[snapshot],nextCursor:null});await hydrating;assert.equal(f.ctx.CS(f.conversation)[0].items[0].text,'fresh native');assert.equal(f.resultCalls,1);assert.equal(f.writes.length,0);
});

test('submission helper is a prototype method and keeps the original manager chain',()=>{
 const f=fixture();assert.equal(Object.hasOwn(f.manager,'dshResumeForSubmission'),false);assert.equal(typeof Object.getPrototypeOf(f.manager).dshResumeForSubmission,'function');assert.equal(typeof f.manager.resumeConversation,'function');assert.equal(typeof f.manager.maybeResumeConversation,'function');
});

function headFixture(options={}){
 const from=cache.indexOf('  const userStopIntents=new Map();'),to=cache.indexOf('  // Read-only quota facade;',from);assert(from>=0&&to>from);
 const listeners=new Map(),client=options.client||{getConversation:()=>({turns:[]}),onNotification(){},updateTurnState(){}};
 const context={client,nativeClient:client,window:options.window||{__DSH_EXECUTION_CONNECTED__:true},navigator:{onLine:true},location:options.location||{pathname:'/local/'+A},hostPathEpoch:'front-fixture',remoteServices:{},nativeEventEpoch:new Map(),stopNativeAuthRecovery:()=>{},waitForExecution:async()=>{},addEventListener:(event,fn)=>{let set=listeners.get(event);if(!set)listeners.set(event,set=new Set());set.add(fn);},removeEventListener:(event,fn)=>listeners.get(event)?.delete(fn),original:options.original||(async(method,params)=>method==='thread/read'?{thread:{id:params.threadId,status:{type:'idle'}}}:{data:[{id:OLD,status:'completed'}]})};
 const read=context.original;context.original=(method,...args)=>method==='config/read'&&!options.nativeConfig?Promise.resolve({config:{sandbox_mode:'danger-full-access',approval_policy:'never'}}):read(method,...args);
 const helper=cache.slice(cache.indexOf('  const executionRead=async('),cache.indexOf('  // Authentication is a current Native fact.'));vm.createContext(context);vm.runInContext(helper+cache.slice(from,to)+';globalThis.stops=userStopIntents;globalThis.controlEpoch=typeof executionEpoch==="undefined"?nativeEventEpoch:executionEpoch;',context);
 return {client,context,listeners,emit(event){for(const fn of listeners.get(event)||[])fn();}};
}

test('actual Native head is invalidated by a socket lifetime event even if connected stays true',async()=>{
 const f=headFixture(),head=await f.client.dshReadExecutionHead(A);assert.equal(head.isCurrent(),true);f.emit('dsh:execution-state');assert.equal(f.context.window.__DSH_EXECUTION_CONNECTED__,true);assert.equal(head.isCurrent(),false);
});

test('retiring a connection releases the actual zero-timeout read RPCs and pending head consumer',async()=>{
 const begin=initial.indexOf('ACn=class{'),end=initial.indexOf(',jCn=class',begin);assert(begin>0&&end>begin);
 let next=0;const calls=[],log={debug(){},warning(){},error(){}},ctx={DOMException,nRt:()=>null,T:log,Yg:x=>x,cp:()=>String(++next),gCn:(_method,options)=>options?.priority??'interactive',YT:(method,source)=>source??method,$Sn:p=>p?.threadId,kCn:new Set(),F0t:()=>false,_Cn:e=>e,kX(){},mCn:()=>({}),window:{setTimeout,clearTimeout},yCn:{default:(fn,{normalizer})=>{const cache=new Map(),memo=(...args)=>{const key=normalizer(args);if(!cache.has(key))cache.set(key,fn(...args));return cache.get(key);};memo.delete=(...args)=>cache.delete(normalizer(args));return memo;}}};
 vm.createContext(ctx);vm.runInContext('globalThis.RequestClient='+initial.slice(begin+4,end)+';',ctx);
 const target=new ctx.RequestClient('local',(_type,payload)=>calls.push(payload.request),true),client={requestClient:target,getConversation:()=>({turns:[]}),onNotification(){assert.fail('retired read must not adopt state');},updateTurnState(){assert.fail('retired read must not adopt state');}};
 const f=headFixture({client,nativeConfig:true,window:{__DSH_EXECUTION_CONNECTED__:true,__DSH_EXECUTION_METADATA_CONTROL_READY__:()=>true},original:target.sendRequest.bind(target)});
 const reading=f.client.dshReadExecutionHead(A);await flush();assert.deepEqual([...target.requestPromises.values()].map(x=>x.method).sort(),['config/read','thread/read']);assert([...target.requestPromises.values()].every(x=>x.timeoutMs===0));
 f.context.window.__DSH_EXECUTION_CONNECTED__=false;let head;reading.then(value=>head=value);f.emit('dsh:execution-state');await flush();assert(head,'retired head must settle without waiting for the old server');
 assert.equal(head.isCurrent(),false);assert.equal(target.requestPromises.size,0);assert.equal(target.inFlightRequestCount,0);assert.deepEqual(calls.map(x=>x.method),['thread/read','config/read']);
 // All late replies are read results, and cannot resurrect a retired waiter.
 for(const request of calls)target.onResult(request.id,{});assert.equal(head.isCurrent(),false);assert.equal(target.requestPromises.size,0);
});

test('a changed connection ends an unresolved head even when no RPC registry is exposed',async()=>{
 const gate=deferred(),f=headFixture({original:async()=>gate.promise}),reading=f.client.dshReadExecutionHead(A);await flush();let head;reading.then(value=>head=value);f.emit('dsh:execution-state');await flush();try{assert(head,'retired head must settle immediately');assert.equal(head.isCurrent(),false);}finally{gate.resolve({thread:{id:A,status:{type:'idle'}},data:[]});await reading;}
 gate.resolve({thread:{id:A,status:{type:'idle'}},data:[]});await flush();assert.equal(head.isCurrent(),false);
});

test('actual Native head rejects stop, new-turn and execution identity changes',async()=>{
 for(const mutate of [f=>f.context.stops.set(A,{turnId:OLD}),f=>f.context.controlEpoch.set(A,1),f=>f.context.hostPathEpoch='other-front',f=>f.context.remoteServices={},f=>f.client.disposed=true,f=>f.context.nativeClient={}]){const f=headFixture(),head=await f.client.dshReadExecutionHead(A);mutate(f);assert.equal(head.isCurrent(),false);}
});

test('actual Native head belongs to its thread when the visible route changes',async()=>{
 const f=headFixture(),head=await f.client.dshReadExecutionHead(A);f.context.location.pathname='/local/'+B;f.emit('dsh:native-route');assert.equal(head.threadId,A);assert.equal(head.isCurrent(),true);
});

test('a fresh head read may finish for its captured thread after navigation',async()=>{
 const gate=deferred(),f=headFixture({original:async(method,params)=>{await gate.promise;return method==='thread/read'?{thread:{id:params.threadId,status:{type:'idle'}}}:{data:[{id:OLD,status:'completed'}]};}}),reading=f.client.dshReadExecutionHead(A);await flush();f.context.location.pathname='/local/'+B;f.emit('dsh:native-route');gate.resolve();const head=await reading;assert.equal(head.threadId,A);assert.equal(head.isCurrent(),true);
});

test('a delayed explicit submission to A completes in A while B is visible',async()=>{
 const f=fixture(),hydrating=f.resume();await flush();f.native.resolve(f.reply);await flush();
 const native=headFixture({client:f.manager,window:f.window,location:f.location}),before=structuredClone(f.conversations.get(B)),gate=deferred(),prepare=f.q.prepareMessage;
 f.q.prepareMessage=async(...args)=>{await gate.promise;return prepare(...args);};
 const sending=f.send();sending.catch(()=>{});await flush();assert.equal(f.writes.length,0);f.location.pathname='/local/'+B;native.emit('dsh:native-route');gate.resolve();await flush();f.finishHistory();const [,result]=await Promise.all([hydrating,sending]);
 assert.equal(result.status,'sent');assert.equal(f.writes.length,1);assert.equal(f.writes[0].id,A);assert.equal(f.writes[0].operation.request.threadId,A);assert.equal(f.writes[0].operation.request.collaborationMode.settings.reasoning_effort,'max');assert.equal(f.writes[0].operation.request.input[1].type,'image');assert.deepEqual(f.conversations.get(B),before);assert.equal(f.location.pathname,'/local/'+B);
});

// Run the pinned renderer's real start/steer continuations too: these functions
// own optimistic items, callbacks, rejection and unknown-result state. Only the
// Native transport and unrelated capability preparation are isolated fixtures.
async function explicitSubmissionFixture(method,{reject=false,unknown=false}={}){
 const f=fixture(),hydrating=f.resume();await flush();f.native.resolve(f.reply);await flush();f.finishHistory();await hydrating;
 const active=method==='turn/steer';f.conversation.threadRuntimeStatus={type:active?'active':'idle'};f.ctx.CS(f.conversation).at(-1).status=active?'inProgress':'completed';
 const native=headFixture({client:f.manager,window:f.window,location:f.location,original:async(name,params)=>name==='thread/read'?{thread:{id:params.threadId,status:{type:active?'active':'idle'}}}:{data:[{id:OLD,status:active?'inProgress':'completed'}]}});
 const commands=[],presented=[],ctx=f.ctx,makeId=()=>webcrypto.randomUUID();
 Object.assign(ctx,{iun:null,aun:null,oun:null,Zx:Number(initial.match(/Zx=([0-9.e]+)/)[1]),hS:class DeliveryUnknown extends Error{},Den:async()=>null,cRt:request=>request,
  rcn:(_manager,id,operation,clientId)=>({resumeWorkspaceRoots:['/fixture'],request:operation.request,prepare:async()=>({request:operation.request,params:{...operation.request,clientUserMessageId:clientId},model:'gpt-6-astra',reasoningEffort:'max',shouldUpdateReasoningEffort:true,collaborationMode:structuredClone(mode),permissions:f.conversation.currentPermissions,workspaceCommit:{},shouldShowModelChange:()=>false}),didStart:async()=>{presented.push(id);}}),
  nun:(state)=>ctx.CS(state).at(-1),wrn:(id,input,restore,options)=>({id,type:'steeringUserMessage',input,restoreMessage:restore,...options}),xun:async()=>OLD,Ttn:()=>null,
  Y4t:(state,apply)=>{for(const turn of ctx.CS(state))apply(turn);},bun:(_manager,options)=>f.manager.sendRequest('turn/steer',options.request,{clientUserMessageId:options.clientUserMessageId}),
 });
 vm.runInContext(['iun','aun','oun','vun'].map(fn).join(';')+';async '+fn('lun')+';async '+fn('_un'),ctx);
 const begin=cache.indexOf("   if(['turn/start','turn/steer'].includes(method)&&userStopIntents.has(params.threadId))"),end=cache.indexOf("   if(method==='turn/interrupt')",begin);assert(begin>=0&&end>begin);
 f.manager.sendRequest=async(name,params,options)=>{
  // This is the same last cache guard used immediately before original RPC.
  vm.runInNewContext(cache.slice(begin,end),{method:name,params,client:f.manager,userStopIntents:native.context.stops,stoppingError:()=>Error('fixture stopping')});
  commands.push({method:name,params:structuredClone(params),options:{clientUserMessageId:options?.clientUserMessageId,priority:options?.priority}});
  if(unknown){const error=new ctx.hS('fixture outcome unknown');error.delivery={stage:'outcome-unknown',method:name,requestId:'66666666-6666-4666-a666-666666666666'};throw error;}
  if(reject)throw Error('fixture native rejected');
  return name==='turn/start'?{turn:{id:NEW,status:'inProgress'}}:{turnId:OLD};
 };
 f.manager.startTurn=(id,operation,onMessageAdded)=>ctx.lun({manager:f.manager,conversationId:id,operation,capabilities:{},origin:'direct',clientUserMessageId:operation.request.clientUserMessageId,createId:makeId,ownerWindowError:'fixture owner changed',onMessageAdded,onInitialTitleRequested(){},readPersistedValue(){}});
 f.manager.steerTurn=(id,input,restoreMessage,serviceTier,attachments,clientUserMessageId,additionalContext,toolOutput,onMessageAdded)=>ctx._un({manager:f.manager,conversationId:id,input,restoreMessage,serviceTier,attachments,clientUserMessageId,additionalContext,toolOutput,onMessageAdded,createId:makeId,schedule:(_delay,run)=>run(),ownerWindowError:'fixture owner changed'});
 f.manager.emitTurnSteered=id=>presented.push(id);
 const gate=deferred(),prepare=f.q.prepareMessage;f.q.prepareMessage=async(...args)=>{await gate.promise;return prepare(...args);};
 return {...f,native,commands,presented,release:gate.resolve,switchToB(){f.location.pathname='/local/'+B;native.emit('dsh:native-route');}};
}

for(const method of ['turn/start','turn/steer'])test('real '+method+' keeps target, input and callbacks in A after navigation to B',async()=>{
 const f=await explicitSubmissionFixture(method),before=structuredClone(f.conversations.get(B)),callbacks=[],sending=f.send({},()=>callbacks.push(A));sending.catch(()=>{});await flush();f.switchToB();f.release();const result=await sending;
 assert.equal(result.status,'sent');assert.equal(f.commands.length,1);assert.equal(f.commands[0].method,method);assert.equal(f.commands[0].params.threadId,A);assert.equal(f.commands[0].params.input[0].text,'fixture');assert.equal(f.commands[0].params.input[1].type,'image');assert.deepEqual(callbacks,[A]);assert.deepEqual(f.presented,[A]);assert.deepEqual(f.conversations.get(B),before);assert.equal(f.location.pathname,'/local/'+B);
 if(method==='turn/steer'){const item=f.ctx.CS(f.conversation).at(-1).items.find(x=>x.type==='steeringUserMessage');assert.equal(item.restoreMessage.context.collaborationMode.settings.reasoning_effort,'max');assert.equal(item.restoreMessage.context.prompt,'fixture');assert.equal(item.status,'accepted');}
 else assert.equal(f.conversation.latestReasoningEffort,'max');
});

for(const method of ['turn/start','turn/steer'])test('a real rejected '+method+' remains in A and cannot restore content into B',async()=>{
 const f=await explicitSubmissionFixture(method,{reject:true}),before=structuredClone(f.conversations.get(B)),sending=f.send(),failure=assert.rejects(sending,/fixture native rejected/);await flush();f.switchToB();f.release();await failure;assert.equal(f.commands.length,1);assert.equal(f.commands[0].params.threadId,A);assert.deepEqual(f.conversations.get(B),before);assert.equal(f.presented.length,0);
});

for(const method of ['turn/start','turn/steer'])test('an unknown '+method+' after navigation stays attached to A and is never replayed',async()=>{
 const f=await explicitSubmissionFixture(method,{unknown:true}),before=structuredClone(f.conversations.get(B)),sending=f.send(),failure=assert.rejects(sending,/fixture outcome unknown/);await flush();f.switchToB();f.release();await failure;assert.equal(f.conversation.unconfirmedTurnSubmissions?.length,1);await assert.rejects(f.send({queueModeOverride:'send-only'}),/not yet confirmed/);assert.equal(f.commands.length,1);assert.deepEqual(f.conversations.get(B),before);
});

test('navigation never releases stop, settings, owner or socket constraints of A',async()=>{
 for(const kind of ['stop','settings','owner','socket']){
  const f=await explicitSubmissionFixture('turn/start'),before=structuredClone(f.conversations.get(B));let settings;
  const sending=f.send();sending.catch(()=>{});await flush();f.switchToB();
  if(kind==='stop')f.native.context.stops.set(A,{turnId:OLD});
  if(kind==='settings'){settings=deferred();f.pendingSettings.set(A,settings.promise);}
  if(kind==='owner')f.roles.set(A,{role:'follower',clientId:'other-owner'});
  if(kind==='socket')f.native.emit('dsh:execution-state');
  f.release();
  if(settings){await flush();assert.equal(f.commands.length,0);settings.resolve();f.pendingSettings.delete(A);await sending;assert.equal(f.commands.length,1);}
  else {await assert.rejects(sending,/尚未发送|fixture stopping|fixture owner changed/);assert.equal(f.commands.length,0);}
  assert.deepEqual(f.conversations.get(B),before);
 }
});

test('Native-head listeners are removed when the client is retired',async()=>{
 const f=headFixture(),head=await f.client.dshReadExecutionHead(A);assert([...f.listeners.values()].some(set=>set.size));f.client.dshDisposeSubmissionHead();assert([...f.listeners.values()].every(set=>set.size===0));assert.equal(head.isCurrent(),false);f.client.dshDisposeSubmissionHead();assert([...f.listeners.values()].every(set=>set.size===0));
});

test('the actual last pre-dispatch guard rejects a stale head without invoking a write',()=>{
 const begin=cache.indexOf("   if(['turn/start','turn/steer'].includes(method)&&userStopIntents.has(params.threadId))"),end=cache.indexOf("   if(method==='turn/interrupt')",begin);assert(begin>=0&&end>begin);
 const context={method:'turn/start',params:{threadId:A},userStopIntents:new Map(),stoppingError:()=>Error('fixture stopping'),client:{dshSubmissionHead:()=>({isCurrent:()=>false})},writes:0};vm.createContext(context);
 assert.throws(()=>vm.runInContext(cache.slice(begin,end)+';writes++;',context),/尚未发送/);assert.equal(context.writes,0);context.userStopIntents.set(A,{});assert.throws(()=>vm.runInContext(cache.slice(begin,end)+';writes++;',context),/fixture stopping/);assert.equal(context.writes,0);
});

test('send initiating its own Native resume does not wait for that attempt history',async()=>{
 const f=fixture();let result,error;const sending=f.send().then(x=>result=x);sending.catch(e=>error=e);await flush();f.native.resolve(f.reply);await flush();
 try{assert.equal(f.writes.length,1,'a send-created resume must expose execution readiness too: '+(error?.stack||JSON.stringify(f.events)));assert.equal(result?.status,'sent');assert(f.manager.inFlightConversationResumes.has(A));}
 finally{f.finishHistory();await Promise.allSettled([sending]);}
});


test('history item events cannot invalidate a verified execution head',async()=>{
 const f=headFixture(),head=await f.client.dshReadExecutionHead(A);f.context.nativeEventEpoch.set(A,100);assert.equal(head.isCurrent(),true);
});
test('execution head requests only turn identity and status, never history bodies',async()=>{
 const calls=[],f=headFixture({original:async(method,params)=>{calls.push({method,params});return method==='thread/read'?{thread:{id:A,status:{type:'active'}}}:method==='config/read'?{config:{sandbox_mode:'danger-full-access'}}:{data:[{id:OLD,status:'inProgress'}]};}});await f.client.dshReadExecutionHead(A);const page=calls.find(c=>c.method==='thread/turns/list');assert.equal(page.params.itemsView,'notLoaded');assert.equal(page.params.limit,1);assert.equal(page.params.sortDirection,'desc');
});

test('credential renewal and history synchronization do not retire a live execution head',async()=>{
 const f=headFixture(),head=await f.client.dshReadExecutionHead(A);for(const event of ['dsh:session-ready','dsh:history-synchronized','dsh:history-adopted'])f.emit(event);assert.equal(head.isCurrent(),true);
});


test('resume metadata uses the isolated current read while a display cache read remains unresolved',async()=>{
 const f=fixture();let metadataReads=0;f.manager.readThread=()=>new Promise(()=>{});f.manager.dshReadResumeMetadata=async()=>{metadataReads++;return {thread:structuredClone(f.reply.thread)};};
 const resume=f.resume();await flush();f.native.resolve(f.reply);await flush();assert.equal(metadataReads,1);const sent=await f.send();assert.equal(sent.status,'sent');assert.equal(f.writes.length,1);f.finishHistory();await resume;
});


test('critical Fast preparation cannot inherit a background read promise or lose its timeout',async()=>{
 const old=cache.indexOf('   if(AUX.has(method)){'),critical=cache.indexOf("   if(['config/read','configRequirements/read'].includes(method)&&options?.priority==='critical')"),end=cache.indexOf("   if(['thread/start','thread/resume'].includes(method))await waitForExecution",old);assert(old>0&&end>old);
 const start=critical>0?critical:old,helper=cache.slice(cache.indexOf(' function refreshOnce('),cache.indexOf(' const STABLE_IPC='));
 const background=deferred(),calls=[],stored=[],ctx={refreshes:new Map(),checkedReads:new Map(),readEpoch:0,diagnostics:{coalesced:0,refreshSkipped:0,auxRefreshes:0},AUX:new Set(['configRequirements/read']),canonical:x=>x,meta:async()=>undefined,saveMeta:async(key,value)=>stored.push({key,value}),navigator:{onLine:true},window:{__DSH_NATIVE_ONLINE__:true,__DSH_EXECUTION_CONNECTED__:true},composerConfig:x=>x,listResult:(_method,x)=>x};
 ctx.original=(method,params,options)=>{calls.push({method,options});return options?.priority==='critical'?Promise.resolve({requirements:{featureRequirements:{fast_mode:false}}}):background.promise;};ctx.executionRead=ctx.original;
 vm.createContext(ctx);vm.runInContext(helper+';globalThis.run=async(method,params,options)=>{'+cache.slice(start,end)+'};',ctx);
 const refreshing=ctx.run('configRequirements/read',{}, {priority:'background'});await flush();let value;const preparing=ctx.run('configRequirements/read',{}, {priority:'critical',timeoutMs:10000}).then(result=>value=result);preparing.catch(()=>{});await flush();
 try{assert.equal(calls.length,2,'critical preparation must issue its own read while the background one is stalled');assert.equal(calls[1].options.timeoutMs,10000);assert.equal(value.requirements.featureRequirements.fast_mode,false);assert.equal(stored.length,0,'execution preparation is independent of display projection writes');}
 finally{background.resolve({requirements:{featureRequirements:{fast_mode:true}}});await Promise.allSettled([refreshing,preparing]);}
});

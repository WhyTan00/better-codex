import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(process.env.DSH_COMPLETION_PRIMARY||new URL('../public/accepted-native-ui/native-assets/v1121/app-primary-6cd7b8b3f5e3.js',import.meta.url),'utf8');
const begin=source.indexOf('async function gXr('),end=source.indexOf('function ',begin+20);
assert(begin>=0&&end>begin);
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function fixture({retainedAlias=false}={}){
 let resolve,reject,current=A;const sent=new Promise((a,b)=>{resolve=a;reject=b}),calls=[],drafts={a:'submitted',b:'B draft'},noop=()=>{};
 const scope={get:()=>null,set:noop,value:{kind:'local',conversationId:A}},location={pathname:'/local/'+A};
 const ctx={location,window:{},performance,globalThis:{},PC:()=>current,X1t:()=>false,fXr:x=>x,vo:x=>x,Up:()=> 'message',Jf:{start:noop,fail:noop,abort:noop},zqr:async()=>[],dg:x=>x,Sx:noop,Cy:{},nre:noop,Wo:()=>null,Ke:noop,Li:class extends Error{},yXr:noop,vXr:noop,Yie:noop,yw:0,Ee:{warning:noop},Ny:()=>null};
 const run=vm.runInNewContext(source.slice(begin,end)+';gXr',ctx);
 const pending={presented:async()=>{},isCurrent:()=>current===A,sending:noop,added:noop,fail:noop,finish:noop,queued:noop};
 const options={scope,appendPromptToHistory:noop,clearComposerUi:()=>calls.push(['clear',current]),clearStopTurnConfirmation:noop,composerController:{getText:()=>drafts[current===A?'a':'b'],getPersistedText:()=>drafts[current===A?'a':'b'],setPromptText:x=>{drafts[current===A?'a':'b']=x},getPlainText:()=> 'submitted',getComputerUseAppMentions:()=>[],getMentionedBrowserFamilies:()=>[]},conversationId:A,clientThreadId:retainedAlias?B:null,buildLocalContextForPrompt:async()=>({prompt:'submitted',fileAttachments:[]}),defaultFollowUpSubmitAction:'send-now',handleEditedQueuedMessageSubmitted:async()=>calls.push(['edited',current]),handleSubmitError:noop,restoreComposerDraft:()=>{drafts[current===A?'a':'b']='submitted';calls.push(['restore',current]);},retainComposerPrompt:()=>()=>true,invalidateRateLimit:noop,isElectron:false,isResponseInProgress:false,logMessageSent:noop,onLocalTurnStarted:()=>calls.push(['started',current]),pause:{},prepareGoalSubmit:async()=>({status:'continue'}),prompts:[],resetHistorySelection:noop,setIsSubmitting:noop,submitButtonMode:'submit',submitTarget:{type:'local',cwd:'/fixture',submit:async(...args)=>{calls.push(['dispatch',A]);args[7]?.();return sent}},options:{skipGoalSubmit:true,dshInstantSend:{id:'message',pending,release:()=>true,end:noop,plainText:'submitted',mentions:[],apps:[],browserFamilies:[]}}};
 return {run:()=>run(options),resolve,reject,calls,drafts,switch(){current=B;scope.value.conversationId=B;location.pathname='/local/'+B;}};
}
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
test('a rejected A send after navigation cannot restore A prompt into B composer',async()=>{const f=fixture(),p=f.run();await flush();assert(f.calls.some(x=>x[0]==='dispatch'));f.switch();f.reject(Error('rejected'));await p;assert.equal(f.drafts.b,'B draft');assert(!f.calls.some(x=>x[0]==='restore'&&x[1]===B));});
test('an accepted A send after navigation cannot invoke B composer presentation callbacks',async()=>{const f=fixture(),p=f.run();await flush();f.switch();f.resolve({threadId:A,turnId:'turn',messageResult:{status:'sent'}});await p;assert(!f.calls.some(x=>['started','edited','clear'].includes(x[0])&&x[1]===B));});
test('same-page rejection still restores the original retained draft',async()=>{const f=fixture(),p=f.run();await flush();f.reject(Error('rejected'));await p;assert(f.calls.some(x=>x[0]==='restore'&&x[1]===A));});
test('same-page acceptance still finishes the original composer',async()=>{const f=fixture(),p=f.run();await flush();f.resolve({threadId:A,turnId:'turn',messageResult:{status:'sent'}});await p;assert(f.calls.some(x=>x[0]==='started'&&x[1]===A));});

function creationFixture(){const begin=source.indexOf('syncChatGptProjectForLocalTask:O}){')+'syncChatGptProjectForLocalTask:O}){'.length,end=source.indexOf('let k=',begin),calls=[],location={pathname:'/'},window={__DSH_NATIVE_SIDEBAR__:{isList:false}},client='cccccccc-cccc-4ccc-8ccc-cccccccccccc';const ctx={c:null,o:client,location,window,_:()=>calls.push('settled'),y:()=>calls.push('error'),b:()=>calls.push('start'),E:()=>calls.push('mode'),m:()=>calls.push('navigate'),g:()=>calls.push('created')};vm.runInNewContext(source.slice(begin,end)+';globalThis.hooks={settled:_,error:y,start:b,mode:E,navigate:m,created:g}',ctx);return {hooks:ctx.hooks,calls,location,window,client};}
test('new-thread completion cannot navigate, reset or settle a different conversation',()=>{const f=creationFixture();f.location.pathname='/local/'+B;f.hooks.created(A);f.hooks.navigate('/local/'+A);f.hooks.mode(null);f.hooks.settled();f.hooks.error();assert.deepEqual(f.calls,[]);});
test('new-thread creation preserves normal home and temporary-thread navigation',()=>{const f=creationFixture();f.hooks.navigate('/local/'+f.client);f.location.pathname='/local/'+f.client;f.hooks.created(A);f.hooks.navigate('/local/'+A);assert.deepEqual(f.calls,['navigate','created','navigate']);});
test('returning to the list is not permission for a late receipt to open a conversation',()=>{const f=creationFixture();f.location.pathname='/local/'+f.client;f.window.__DSH_NATIVE_SIDEBAR__.isList=true;f.hooks.created(A);f.hooks.navigate('/local/'+A);assert.deepEqual(f.calls,[]);});

function acceptedCreationFixture({metadataRoute=null,homeOrigin=false}={}){
 const a=source.indexOf('syncChatGptProjectForLocalTask:O}){')+'syncChatGptProjectForLocalTask:O}){'.length,b=source.indexOf('let k=',a);
 const ka=source.indexOf('K=(0,P9.default)(async t=>{',b),kb=source.indexOf(',q=(0,P9.default)',ka);assert(ka>b&&kb>ka);
 let selection=1;const calls=[],client='cccccccc-cccc-4ccc-8ccc-cccccccccccc',location={pathname:homeOrigin?'/':'/local/'+client},window={__DSH_NATIVE_SIDEBAR__:{isList:false},__DSH_NAVIGATION__:{selectionRevision:()=>selection}};
 const no=()=>{},ctx={c:null,o:client,location,window,_:no,y:no,b:no,E:no,m:path=>calls.push(path),g:no,P9:{default:x=>x},G:()=>true,td:()=>{location.pathname='/local/'+A},e:{set:no,get:()=>({pathname:metadataRoute??'/local/'+client})},fT:{},M:{},F:true,i:false,S:{projectAssignment:null,config:{}},s:null,Dm:async()=>{},Jf:{bindConversation:no},PFe:no,d$r:no,P:{},z:null,f:()=>true,Mv:id=>'/local/'+id,D_e:{},Ee:{warning:(_msg,error)=>{throw error}}};
 vm.runInNewContext(source.slice(a,b)+';const '+source.slice(ka,kb)+';globalThis.complete=K',ctx);
 return {complete:()=>ctx.complete(A),calls,location,window,newSelection(){selection++;location.pathname="/";}};
}
test('accepted native ID is remembered before creation presentation changes the route',async()=>{const f=acceptedCreationFixture();await f.complete();assert.deepEqual(f.calls,['/local/'+A]);});
test('an accepted creation still cannot reopen a different conversation or the list',async()=>{for(const target of ['other','list']){const f=acceptedCreationFixture();if(target==='other')f.location.pathname='/local/'+B;else f.window.__DSH_NATIVE_SIDEBAR__.isList=true;await f.complete();assert.deepEqual(f.calls,[]);}});

test('accepted new task navigates to its Native ID even after metadata leaves the temporary MemoryRouter route',async()=>{const f=acceptedCreationFixture({metadataRoute:'/'});await f.complete();assert.deepEqual(f.calls,['/local/'+A]);});

test('a second new-chat selection is not permission for an older creation to navigate on the same home path',async()=>{const f=acceptedCreationFixture({homeOrigin:true});f.newSelection();await f.complete();assert.deepEqual(f.calls,[]);});

test('Native A completion cannot own B via a retained client alias after switching conversations',async()=>{for(const rejected of [false,true]){const f=fixture({retainedAlias:true}),p=f.run();await flush();f.switch();if(rejected)f.reject(Error('rejected'));else f.resolve({threadId:A,turnId:'turn',messageResult:{status:'sent'}});await p;assert.equal(f.drafts.b,'B draft');assert(!f.calls.some(x=>['restore','started','edited','clear'].includes(x[0])&&x[1]===B));}});

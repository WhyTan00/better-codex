import test from 'node:test';import assert from 'node:assert/strict';
const {OfficialBoundary}=await import(process.env.DSH_LOCAL_ENV_BOUNDARY||new URL('../src/official-boundary.mjs',import.meta.url));
const {workspace}=await import('../src/registry.mjs');
const root=workspace('ai').root,other=workspace('zyy').root,id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',msg='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function fixture(){const calls=[],owned=new Set(),rows=new Map(),thread={id,cwd:root,status:{type:'idle'},historyMode:'paginated',environments:[{environmentId:'local',cwd:root,runtimeWorkspaceRoots:[root]}]};
 const native={start:async()=>{},rpc:async(method,params)=>{calls.push({method,params});if(method==='config/read')return{config:{approval_policy:'never',sandbox_mode:'danger-full-access',approvals_reviewer:'user'}};if(method==='thread/start')return{thread,approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'},cwd:root,runtimeWorkspaceRoots:[root]};if(method==='thread/read')return{thread};if(method==='thread/loaded/list')return{data:[],nextCursor:null};if(method==='turn/start')return{turn:{id:msg,status:'inProgress'}};return{};}};
 const journal={manageThread:(scope,id)=>owned.add(scope+id),ownsThread:(scope,id)=>owned.has(scope+id),run:async(scope,key,_request,work)=>{if(!rows.has(key))rows.set(key,{state:'accepted',result:await work()});return rows.get(key);}};return{boundary:new OfficialBoundary({native,journal}),calls};}
test('first turn echoes the actual Native local-environment reply without changing execution target',async()=>{
 const f=fixture(),created=await f.boundary.call('ai',{id:'new',method:'thread/start',params:{cwd:root}},{clientId:'client'});
 const params={threadId:created.thread.id,clientUserMessageId:msg,cwd:null,runtimeWorkspaceRoots:null,environments:created.thread.environments,input:[{type:'text',text:'synthetic first prompt'}],sandboxPolicy:created.sandbox,approvalPolicy:created.approvalPolicy,approvalsReviewer:created.approvalsReviewer};
 const first=await f.boundary.call('ai',{id:'first',method:'turn/start',params},{clientId:'client'});assert.equal(first.turn.status,'inProgress');
 const sent=f.calls.find(c=>c.method==='turn/start').params;assert.equal(sent.cwd,root);assert.deepEqual(sent.runtimeWorkspaceRoots,[root]);assert(!('environments'in sent));assert(!('sandboxPolicy'in sent));
 assert.deepEqual(await f.boundary.call('ai',{id:'retry',method:'turn/start',params},{clientId:'client'}),first);assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);
});
for(const [name,environment,extra]of [
 ['remote host',{environmentId:'remote',cwd:root},{}],['foreign cwd',{environmentId:'local',cwd:other},{}],['foreign root',{environmentId:'local',cwd:root,runtimeWorkspaceRoots:[other]},{}],
 ['hidden routing fields',{environmentId:'local',cwd:root,hostId:'remote'},{}],['conflicting cwd',{environmentId:'local',cwd:root},{cwd:other}],['conflicting roots',{environmentId:'local',cwd:root,runtimeWorkspaceRoots:[root]},{runtimeWorkspaceRoots:[]}],
])test('local descriptor still rejects '+name,async()=>{const f=fixture();await assert.rejects(f.boundary.call('ai',{id:name,method:'turn/start',params:{threadId:id,environments:[environment],...extra}},{clientId:'client'}),e=>e.code===403);assert(!f.calls.some(c=>c.method==='turn/start'));});
test('multiple local descriptors cannot select an additional execution environment',async()=>{const f=fixture();await assert.rejects(f.boundary.call('ai',{id:'multiple',method:'turn/start',params:{threadId:id,environments:[{environmentId:'local',cwd:root},{environmentId:'local',cwd:root}]}},{clientId:'client'}),e=>e.code===403);assert(!f.calls.some(c=>c.method==='turn/start'));});

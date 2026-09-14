// 官方 renderer 的服务端边界：固定工作区过滤，不改变家庭共享身份或既有执行权限。
import {createHash} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {workspace,belongs,fail,validateId} from './registry.mjs';
const READS=new Set(['thread/read','thread/turns/list','thread/items/list','thread/queue/list','thread/goal/get']);
const WRITES=new Set(['thread/resume','thread/name/set','thread/archive','thread/unarchive','turn/start','turn/interrupt','thread/stop','turn/steer','thread/fork','thread/section/move','thread/settings/update','thread/queue/add','thread/queue/update','thread/queue/delete','thread/queue/reorder','thread/queue/start','thread/goal/set','thread/goal/clear']);
const GLOBAL=new Set(['model/list','modelProvider/capabilities/read','account/read','account/rateLimits/read','configRequirements/read','experimentalFeature/list','remoteControl/status/read','collaborationMode/list']);
const CONFIG_KEYS=['model','review_model','model_provider','approval_policy','approvals_reviewer','sandbox_mode','sandbox_workspace_write','model_reasoning_effort','model_reasoning_summary','model_verbosity','service_tier','personality','web_search','features'];
const WORKBENCH_NEW_CHAT={model:'provider-default',model_reasoning_effort:'medium'};
const nativeProfile=mode=>({'workspace-write':':workspace','read-only':':read-only','danger-full-access':':danger-full-access'}[mode]);
async function runtimeRootAllowed(root,ws,threadId){if(await belongs(root,ws))return true;if(!threadId||typeof root!=='string')return false;const base='${BETTER_CODEX_HOME}/.codex/visualizations',match=root.match(/^\/Users\/better-codex\/\.codex\/visualizations\/(\d{4}\/\d{2}\/\d{2})\/([0-9a-f-]{36})(?:\/|$)/i);if(match?.[2]!==threadId)return false;try{const expected=(await realpath(base))+'/'+match[1]+'/'+threadId,actual=await realpath(root);return actual===expected||actual.startsWith(expected+'/');}catch{return false;}}
const stableId=v=>{const h=createHash('sha256').update(v).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export class OfficialBoundary {
 constructor({native,journal,onHistoryRead=()=>{},onNativeResponse=()=>{},enableDefaultModeQuestions=false}){Object.assign(this,{native,journal,onHistoryRead,onNativeResponse,enableDefaultModeQuestions});this.threads=new Map();this.checks=new Map();this.lists=new Map();this.queues=new Map();this.active=new Map();this.approvals=new Map();this.unmaterialized=new Set();this.usage=new Map();native.on?.('interrupted',()=>{this.threads.clear();this.lists.clear();this.active.clear();this.approvals.clear();this.unmaterialized.clear();this.defaults=null;});}
 remember(t){if(!t?.id)return;this.threads.delete(t.id);this.threads.set(t.id,{...t,verifiedAt:Date.now()});while(this.threads.size>2048)this.threads.delete(this.threads.keys().next().value);}
 async checked(ws,id,{fresh=false}={}){validateId(id);let t=this.threads.get(id);if(fresh||!t||Date.now()-t.verifiedAt>60000){let p=this.checks.get(id);if(!p){p=this.native.rpc('thread/read',{threadId:id,includeTurns:false}).then(r=>{this.remember(r.thread);return r.thread;}).finally(()=>this.checks.delete(id));this.checks.set(id,p);}t=await p;}if(!t||!await belongs(t.cwd,ws))throw fail(404,'会话不存在或不属于此工作区');return t;}
 async loadedEmptyThread(ws,id){
  if(!this.journal.ownsThread(ws.id,id)||!(await this.loadedIds()).has(id))return null;
  const t=await this.checked(ws,id,{fresh:true});if(t.status?.type!=='idle'||t.preview?.trim())return null;
  const row=this.journal.db?.prepare("SELECT result FROM requests WHERE workspace=? AND state='accepted' AND json_extract(result,'$.thread.id')=? AND json_extract(result,'$.sandbox') IS NOT NULL LIMIT 1").get(ws.id,id);
  if(!row)return null;const created=JSON.parse(row.result);if(created.thread?.turns?.length)return null;
  return {...created,model:t.model??created.model,reasoningEffort:t.reasoningEffort??created.reasoningEffort,thread:{...t,turns:[]}};
 }
 async readNative(ws,method,p){
  try{return await this.native.rpc(method,p);}catch(error){
   const emptyError=/not materialized yet|no rollout found for thread id/i.test(error.message||'');
   if(!emptyError||p.cursor||!(method==='thread/read'&&p.includeTurns||method==='thread/turns/list'))throw error;
   const empty=await this.loadedEmptyThread(ws,p.threadId);if(!empty)throw error;
   this.unmaterialized.add(p.threadId);return method==='thread/read'?{thread:empty.thread}:{data:[],nextCursor:null};
  }
 }
 async loadedIds(){
  // 只查询当前连接的宿主，不能先 resume 再以 loaded 冒充归属证明。
  const ids=new Set(),seen=new Set();let cursor;
  for(let page=0;page<64;page++){
   const r=await this.native.rpc('thread/loaded/list',cursor?{cursor}:{});
   for(const id of r.data||[])ids.add(id);
   cursor=r.nextCursor;if(!cursor)return ids;
   if(seen.has(cursor))throw fail(503,'宿主会话分页异常');seen.add(cursor);
  }
  throw fail(503,'无法完整核实宿主会话归属');
 }
 async writable(ws,id){const owned=this.journal.ownsThread(ws.id,id),t=await this.checked(ws,id,{fresh:!this.unmaterialized.has(id)});if(!owned&&!(await this.loadedIds()).has(id))throw fail(403,'外部线程仅供阅读；请在原宿主续接');return t;}
 async snapshot(scope){
  const ws=workspace(scope),threads=[];
  for(const id of await this.loadedIds())try{const t=await this.checked(ws,id,{fresh:!this.unmaterialized.has(id)});threads.push({id:t.id,status:t.status});}catch(e){if(e.code!==404)throw e;}
  const approvals=[];for(const a of this.approvals.values())if(threads.some(t=>t.id===a.params?.threadId))approvals.push(a);
  return {hostState:this.native.state,threads,activeThreadIds:threads.filter(t=>t.status?.type==='active'||this.active.has(t.id)).map(t=>t.id),approvals};
 }
 async hostActivity(){await this.native.start();const active=new Set(this.active.keys());for(const id of await this.loadedIds()){const t=this.unmaterialized.has(id)?this.threads.get(id):(await this.native.rpc('thread/read',{threadId:id,includeTurns:false})).thread;if(!t)throw fail(503,'无法核实宿主任务状态');if(t.status?.type==='active')active.add(id);}return {activeTurns:active.size,pendingApprovals:this.approvals.size};}
 serial(k,fn){const p=this.queues.get(k)||Promise.resolve(),n=p.catch(()=>{}).then(fn);this.queues.set(k,n);n.finally(()=>{if(this.queues.get(k)===n)this.queues.delete(k);}).catch(()=>{});return n;}
 async config({fresh=false}={}){if(fresh||!this.defaults||Date.now()-(this.defaultsAt||0)>2000){this.defaults=(await this.native.rpc('config/read',{includeLayers:false})).config;this.defaultsAt=Date.now();}return this.defaults;}
 async validateInput(scope,input){if(!Array.isArray(input))throw fail(400,'消息输入无效');for(const item of input){if(item.type==='text')continue;if(['localImage','localAudio','mention'].includes(item.type)&&this.files){await this.files.resolve(scope,item.path);continue;}if(item.type==='image'&&/^data:image\/(png|jpeg|webp|gif);base64,/.test(item.url)&&item.url.length<8*1024*1024)continue;throw fail(403,'输入附件不属于当前工作区或类型尚未支持');}}
 async call(scope,request,{clientId=''}={}){
  const ws=workspace(scope),method=request?.method,p={...(request?.params||{})};let resumePolicy=null;await this.native.start();
  if(method==='config/read'){const c=await this.config({fresh:true});return {config:{...Object.fromEntries(CONFIG_KEYS.filter(k=>k in c).map(k=>[k,c[k]])),...WORKBENCH_NEW_CHAT},origins:{}};}
  if(method==='account/read')return this.native.rpc(method,{refreshToken:false});
  if(method==='getAuthStatus')return this.native.rpc(method,{includeToken:false,refreshToken:false});
  if(method==='permissionProfile/list'){if(p.cwd&&!await belongs(p.cwd,ws))throw fail(403,'工作目录超出当前工作区');const r=await this.native.rpc(method,{...p,cwd:p.cwd||ws.root}),c=await this.config();return {...r,data:(r.data||[]).map(profile=>({...profile,allowed:profile.allowed&&profile.id===nativeProfile(c.sandbox_mode)}))};}
  if(method==='thread/list'){
   const params={...p,limit:Math.min(50,Math.max(1,Number(p.limit)||50)),useStateDbOnly:true},key=JSON.stringify([scope,Object.fromEntries(Object.entries(params).sort(([a],[b])=>a.localeCompare(b)))]);
   if(this.lists.has(key))return this.lists.get(key);
   const pending=(async()=>{const r=await this.native.rpc(method,params),cwds=[...new Set((r.data||[]).map(t=>t.cwd))],allowed=new Map(await Promise.all(cwds.map(async cwd=>[cwd,await belongs(cwd,ws)]))),data=[];
    for(const t of r.data||[])if(allowed.get(t.cwd)){this.remember(t);data.push(t);}return {...r,data};})();
   this.lists.set(key,pending);try{return await pending;}finally{if(this.lists.get(key)===pending)this.lists.delete(key);}
  }
  if(method==='thread/loaded/list'){const r=await this.native.rpc(method,p),data=[];for(const id of r.data||[])try{await this.checked(ws,id);data.push(id);}catch{}return {...r,data};}
  if(READS.has(method)){await this.checked(ws,p.threadId);if(method==='thread/turns/list')p.limit=Math.min(20,Math.max(1,Number(p.limit)||12));if(method==='thread/items/list')p.limit=Math.min(100,Math.max(1,Number(p.limit)||40));const started=Date.now(),result=await this.readNative(ws,method,p);if(method!=='thread/read')try{this.onHistoryRead({scope,method,threadId:p.threadId,turnId:p.turnId??null,hasCursor:!!p.cursor,cursorHash:p.cursor?createHash('sha256').update(String(p.cursor)).digest('hex').slice(0,12):null,sortDirection:p.sortDirection??null,itemsView:p.itemsView??null,limit:p.limit,count:result.data?.length??null,returnedTurnIds:method==='thread/turns/list'?result.data.map(t=>t.id):undefined,hasNextCursor:!!result.nextCursor,durationMs:Date.now()-started,responseBytes:Buffer.byteLength(JSON.stringify(result))});}catch{}return result;}
  if(GLOBAL.has(method))return this.native.rpc(method,p);
  if(method==='skills/list'){const cwds=p.cwds?.length?p.cwds:[ws.root];for(const cwd of cwds)if(!await belongs(cwd,ws))throw fail(403,'技能工作目录超出当前工作区');return this.native.rpc(method,{...p,cwds});}
  if(['app/list','mcpServerStatus/list'].includes(method))return this.native.rpc(method,p);
  if(method!=='thread/start'&&!WRITES.has(method))throw fail(403,'此能力尚未开放于分区工作台');
  if(method==='thread/stop'&&Object.keys(p).some(k=>k!=='threadId'))throw fail(400,'停止请求参数无效');
  if(!clientId||request.id==null)throw fail(400,'写请求缺少稳定客户端身份');
  if(method==='thread/start'){await this.config({fresh:true});if(p.cwd&&!await belongs(p.cwd,ws))throw fail(403,'工作目录超出当前工作区');p.cwd=p.cwd||ws.root;if(p.model==null)p.model=WORKBENCH_NEW_CHAT.model;p.config={...p.config};if(p.config.model_reasoning_effort==null)p.config.model_reasoning_effort=WORKBENCH_NEW_CHAT.model_reasoning_effort;}
  let requestEffort;
  // 原生 renderer 会传 null 与当前默认策略；只规范化完全等价的值，拒绝真正的权限/路由变更。
  for(const k of ['permissions','modelProvider','config','path','history','approvalPolicy','sandbox','sandboxPolicy','approvalsReviewer','cwd','runtimeWorkspaceRoots','environments'])if(p[k]===null)delete p[k];
  // Official desktop defaults include feature hints. The persistent native
  // host owns execution features: ignore browser hints, never apply them.
  if(p.config&&typeof p.config==='object'&&!Array.isArray(p.config)){
   const c=await this.config();p.config=Object.fromEntries(Object.entries(p.config).filter(([key,value])=>{
    if(key==='model_reasoning_effort'&&['thread/start','thread/resume'].includes(method)){if(!['none','minimal','low','medium','high','xhigh','max','ultra','persistent'].includes(value))throw fail(400,'推理强度无效');requestEffort=value;return false;}
    if(key==='features'||key.startsWith('features.')||key==='mcp_servers.codex_app.enabled_tools')return false;
    if(['model_reasoning_effort','model_reasoning_summary','model_verbosity'].includes(key)&&JSON.stringify(c[key])===JSON.stringify(value))return false;
    return true;
   }));if(Object.keys(p.config).length===0)delete p.config;
  }
  // Resuming an old thread is not a request to apply its cached UI policy.
  // Bind it to the already authorized host policy, freshly read server-side.
  // Other mutations retain strict policy validation; browser values never win.
  if(method==='thread/resume'&&['permissions','approvalPolicy','sandbox','sandboxPolicy','approvalsReviewer'].some(k=>k in p)){
   const c=await this.config({fresh:true});if(!nativeProfile(c?.sandbox_mode)||c.approval_policy==null)throw fail(503,'无法核实当前宿主执行策略');
   resumePolicy={approvalPolicy:c.approval_policy,sandbox:c.sandbox_mode,...(c.approvals_reviewer?{approvalsReviewer:c.approvals_reviewer}:{})};
   for(const k of ['permissions','approvalPolicy','sandbox','sandboxPolicy','approvalsReviewer'])delete p[k];
  }
  if(p.permissions||p.modelProvider){const c=await this.config();if(p.permissions){if(p.permissions!==nativeProfile(c.sandbox_mode))throw fail(403,'权限配置与已授权宿主不一致');delete p.permissions;}if(p.modelProvider){if(p.modelProvider!==(c.model_provider||'openai'))throw fail(403,'模型提供方与宿主不一致');delete p.modelProvider;}}
  if(method==='thread/resume'){
   if(Array.isArray(p.history)&&p.history.length===0)delete p.history;
   if(typeof p.path==='string'){const t=await this.checked(ws,p.threadId);if(t.path!==p.path)throw fail(403,'历史路径与原生会话不一致');delete p.path;}
  }
  for(const k of ['config','path','history'])if(k in p)throw fail(403,'不允许覆写宿主、权限或历史路径');
  if(['approvalPolicy','sandbox','sandboxPolicy','approvalsReviewer'].some(k=>k in p)){
   const c=await this.config(),sandbox={"danger-full-access":'dangerFullAccess',"read-only":'readOnly',"workspace-write":'workspaceWrite'}[c.sandbox_mode];
   for(const [k,expected]of [['approvalPolicy',c.approval_policy],['sandbox',c.sandbox_mode],['approvalsReviewer',c.approvals_reviewer]])if(k in p){if(JSON.stringify(p[k])!==JSON.stringify(expected))throw fail(403,'执行策略与已授权宿主不一致');delete p[k];}
   if(p.sandboxPolicy){if(p.sandboxPolicy.type!==sandbox||Object.keys(p.sandboxPolicy).some(k=>k!=='type'))throw fail(403,'沙箱策略与宿主不一致');delete p.sandboxPolicy;}
  }
  if(p.cwd&&!await belongs(p.cwd,ws))throw fail(403,'工作目录超出当前工作区');
  if(p.runtimeWorkspaceRoots&&(!Array.isArray(p.runtimeWorkspaceRoots)||!(await Promise.all(p.runtimeWorkspaceRoots.map(root=>runtimeRootAllowed(root,ws,p.threadId)))).every(Boolean)))throw fail(403,'运行工作区超出当前分区');
  if(p.environments?.length)throw fail(403,'不允许通过分区工作台切换执行环境');
  if(method==='thread/settings/update'){
   // The native picker updates the current thread, not config/batchWrite.
   // Its deprecated delegation hint is ignored by Native; keep host governance.
   delete p.multiAgentMode;
   if(Object.keys(p).some(k=>!['threadId','model','effort'].includes(k)))throw fail(403,'这里只允许更新此会话的模型与推理强度');
   for(const k of ['model','effort'])if(p[k]!=null&&(typeof p[k]!=='string'||!p[k].trim()||p[k].length>256))throw fail(400,'模型或推理强度格式无效');
  }
  if(method==='thread/section/move'){if(p.sectionId!==null&&p.sectionId!=='01984de2-8f74-7c91-a3b2-5c5e937cf318')throw fail(403,'此分区只支持置顶与取消置顶');if(p.beforeThreadId)await this.checked(ws,p.beforeThreadId);}
  if(resumePolicy)Object.assign(p,resumePolicy);
  const id=stableId(`${ws.id}:${method}:${(!method.startsWith('thread/queue/')&&p.clientUserMessageId)||`${clientId}:${request.id}`}`);
  return this.serial(`${ws.id}:${p.threadId||'new'}`,async()=>{
   const r=await this.journal.run(ws.id,id,{method,params:{...p,...(requestEffort===undefined?{}:{config:{model_reasoning_effort:requestEffort}})}},async()=>{
    // Resume is the native atomic writer-lock acquisition. A historical origin
    // is not a reason to deny it; other mutations still require this host.
    const thread=method==='thread/start'?null:['thread/resume','thread/section/move'].includes(method)?await this.checked(ws,p.threadId):await this.writable(ws,p.threadId);
    // 去重在 active 检查之前，ACK 丢失时返回同一已接受 turn。
    if(method==='turn/start'||method==='turn/steer'){if(method==='turn/start'&&thread.status?.type==='active')throw fail(409,'任务正在执行');await this.validateInput(scope,p.input||[]);}
    if(['thread/queue/add','thread/queue/update'].includes(method))await this.validateInput(scope,p.input||[]);
    // A scoped session feature, explicitly owned by this workbench adapter.
    // Do not write config.toml or accept arbitrary browser feature overrides.
    const nativeParams=['thread/start','thread/resume'].includes(method)&&(this.enableDefaultModeQuestions||requestEffort!==undefined)?{...p,config:{...(this.enableDefaultModeQuestions?{'features.default_mode_request_user_input':true}:{}),...(requestEffort===undefined?{}:{model_reasoning_effort:requestEffort})}}:p;
    let value;try{value=await this.native.rpc(method,nativeParams);}catch(e){if(method==='thread/resume'&&/no rollout found for thread id|not materialized yet/i.test(e.message||'')){const empty=await this.loadedEmptyThread(ws,p.threadId);if(empty){if(p.model!=null||requestEffort!==undefined)await this.native.rpc('thread/settings/update',{threadId:p.threadId,...(p.model==null?{}:{model:p.model}),...(requestEffort===undefined?{}:{effort:requestEffort})});value={...empty,...(p.model==null?{}:{model:p.model}),...(requestEffort===undefined?{}:{reasoningEffort:requestEffort}),turnsBackwardsCursor:null,itemsBackwardsCursor:null};this.unmaterialized.add(p.threadId);}else throw e;}else if(method==='thread/resume'&&/writer|already.*(?:use|open|load)|locked|ownership/i.test(e.message))throw fail(409,'此会话仍由另一个 Codex 执行端持有。结束该端任务并关闭该会话后，可在这里原会话续聊。');else throw e;}
    try{this.onNativeResponse(scope,method,p,value);}catch{}
    if(method==='thread/resume'&&value.thread){if(!this.journal.ownsThread(ws.id,value.thread.id))this.journal.manageThread(ws.id,value.thread.id);this.remember(value.thread);}
    if(method==='thread/start'||method==='thread/fork'){this.journal.manageThread(ws.id,value.thread.id);this.remember(value.thread);if(method==='thread/start')this.unmaterialized.add(value.thread.id);}
    if(method==='turn/start'){this.unmaterialized.delete(p.threadId);this.active.set(p.threadId,value.turn.id);}
    return value;
   });
   if(r.state==='accepted')return r.result;
   throw fail(['unknown','pending'].includes(r.state)?409:r.result?.code||400,['unknown','pending'].includes(r.state)?'发送结果待核对；不会重复执行':r.result?.error||'请求未完成');
  });
 }
 observe(m){const p=m.params||{},id=p.threadId||p.thread?.id;if(m.method==='thread/tokenUsage/updated'&&id&&p.turnId&&p.tokenUsage?.last){const key=id+':'+p.turnId;this.usage.delete(key);this.usage.set(key,{threadId:id,turnId:p.turnId,...Object.fromEntries(['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','totalTokens'].filter(k=>Number.isFinite(p.tokenUsage.last[k])).map(k=>[k,p.tokenUsage.last[k]]))});while(this.usage.size>1000)this.usage.delete(this.usage.keys().next().value);}if(p.thread?.cwd)this.remember(p.thread);if(m.method==='turn/started')this.active.set(id,p.turn.id);if(m.method==='turn/completed')this.active.delete(id);if(m.method==='thread/status/changed'&&this.threads.has(id))this.threads.get(id).status=p.status;if(m.method==='thread/closed')this.threads.delete(id);if(m.id!==undefined&&id)this.approvals.set(String(m.id),m);if(m.method==='serverRequest/resolved')this.approvals.delete(String(p.requestId));}
 async notification(scope,m){const ws=workspace(scope),p=m.params||{},id=p.threadId||p.thread?.id;if(!id)return null;try{await this.checked(ws,id);return m;}catch{return null;}}
 async answer(scope,message){return this.serial('approval:'+String(message.id),async()=>{const ws=workspace(scope),key=String(message.id),a=this.approvals.get(key);if(!a)throw fail(409,'审批已处理或失效');await this.writable(ws,a.params.threadId);if(!['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/tool/requestUserInput','item/tool/call'].includes(a.method))throw fail(403,'该审批类型尚未开放');if(this.approvals.get(key)!==a)throw fail(409,'审批已由另一端处理');this.native.send({id:a.id,...('result'in message?{result:message.result}:{error:message.error})});this.approvals.delete(key);return {};});}
 bootstrap(scope,c){const ws=workspace(scope),atoms={};for(const[k,v]of Object.entries(c.persistedAtomSnapshot||{}))if(/^(sidebar-width|app-shell:right-panel-width:v3|has-seen-[a-z-]+|composer-model-picker-menu-view-v1)$/.test(k))atoms[k]=v;
  const project={id:`betterCodex-${ws.id}`,name:ws.id.toUpperCase(),rootPaths:[ws.root],createdAt:0,updatedAt:0};
  const entries=[{key:'pending_worktrees',value:[]},{key:'local-projects',value:{[project.id]:project}},{key:'selected-project',value:{type:'local',projectId:project.id}},{key:'project-order',value:[project.id]}];
  return {gatewayBaseUrl:`${c.gatewayBaseUrl}/w/${ws.id}`,gatewayWsUrl:c.gatewayWsUrl.replace(/\/ws$/,`/w/${ws.id}/ws`),workspaceRoots:[ws.root],homeDir:ws.root,locale:c.locale,localeSource:c.localeSource,localeMode:c.localeMode,messages:c.messages,gatewayPluginConfig:{schemaVersion:3,revision:1,plugins:{'opencodex.smart-model-router':{enabled:false,values:{}}}},debugClientDiagnostics:false,debugWs:false,appServer:{kind:'official-electron-ipc'},sharedObjectSnapshot:{host_config:{id:'local',kind:'local'}},persistedAtomSnapshot:atoms,initialSidebarBootstrap:{catalogEntries:[],catalogHostIds:['local'],globalStateEntries:entries,workspaceRootOptions:{canonicalPathByRoot:{[ws.root]:ws.root},roots:[ws.root],labels:{[ws.root]:ws.id.toUpperCase()}},projectlessWorkspaceRoot:{workspaceRoot:ws.root}}};
 }
}

// 官方 renderer 的服务端边界：固定工作区过滤，不改变家庭共享身份或既有执行权限。
import {createHash} from 'node:crypto';
import {AppCatalogCache} from './app-catalog-cache.mjs';
import {realpath} from 'node:fs/promises';
import path from 'node:path';
import {runtimeProfile} from './runtime-profile.mjs';
import {workspace,belongs,fail,validateId} from './registry.mjs';
import {workspaceProjects} from './workspace-projects.mjs';
import {errorDiagnosticFields,hashDiagnosticId} from './connection-diagnostics.mjs';
const READS=new Set(['thread/read','thread/turns/list','thread/items/list','thread/queue/list','thread/goal/get']);
const HISTORY_WRITES=new Set(['thread/revert']);
const WRITES=new Set(['thread/resume','thread/name/set','thread/archive','thread/unarchive','thread/delete','turn/start','turn/interrupt','thread/stop','turn/steer','thread/fork','thread/section/move','thread/settings/update','thread/queue/add','thread/queue/update','thread/queue/delete','thread/queue/reorder','thread/queue/start','thread/goal/set','thread/goal/clear',...HISTORY_WRITES]);
const GLOBAL=new Set(['model/list','modelProvider/capabilities/read','account/read','account/rateLimits/read','configRequirements/read','experimentalFeature/list','remoteControl/status/read','collaborationMode/list']);
// The shared scoped product does not expose these Desktop-only capabilities.
// Report an unavailable method, not expired credentials; do not forward it or
// fabricate an empty successful result for private/global Native data.
const UNAVAILABLE=new Set(['plugin/list','plugin/installed','externalAgentConfig/import/readHistories','thread/metadata/update','thread/rollback']);
const CONFIG_KEYS=['model','review_model','model_provider','approval_policy','approvals_reviewer','sandbox_mode','sandbox_workspace_write','model_reasoning_effort','model_reasoning_summary','model_verbosity','service_tier','personality','web_search','features'];
const WORKBENCH_NEW_CHAT=runtimeProfile.portable?{}:{model:'gpt-6.1-sol',model_reasoning_effort:'max'};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const canonicalReply=v=>Array.isArray(v)?v.map(canonicalReply):plain(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonicalReply(v[k])])):v;
const sameReply=(a,b)=>JSON.stringify(canonicalReply(a))===JSON.stringify(canonicalReply(b));
function permissionsReply(value,requested){
 if(!plain(value)||Object.keys(value).some(k=>!['permissions','scope','strictAutoReview'].includes(k))||!plain(value.permissions)||Object.keys(value.permissions).some(k=>!['fileSystem','network'].includes(k))||value.scope!=null&&!['turn','session'].includes(value.scope)||value.strictAutoReview!=null&&typeof value.strictAutoReview!=='boolean')throw fail(400,'权限回复无效');
 const network=value.permissions.network,fs=value.permissions.fileSystem;
 if(network!=null&&(!plain(network)||Object.keys(network).some(k=>k!=='enabled')||network.enabled!=null&&typeof network.enabled!=='boolean'||network.enabled===true&&requested?.network?.enabled!==true))throw fail(400,'不能批准原请求之外的网络权限');
 if(fs==null)return;
 if(!plain(fs)||Object.keys(fs).some(k=>!['read','write','entries','globScanMaxDepth'].includes(k)))throw fail(400,'文件权限回复无效');
 for(const key of ['read','write','entries'])if(fs[key]!=null){
  if(!Array.isArray(fs[key])||!Array.isArray(requested?.fileSystem?.[key])||fs[key].some(value=>!requested.fileSystem[key].some(item=>sameReply(item,value))))throw fail(400,'不能批准原请求之外的文件权限');
 }
 if(fs.globScanMaxDepth!=null&&(!Number.isSafeInteger(fs.globScanMaxDepth)||fs.globScanMaxDepth<1||!Number.isSafeInteger(requested?.fileSystem?.globScanMaxDepth)||fs.globScanMaxDepth>requested.fileSystem.globScanMaxDepth))throw fail(400,'文件匹配范围超出原请求');
}
function elicitationValue(value,schema,depth=0){
 if(!plain(schema)||depth>32)return depth<=32;
 if(schema.const!==undefined&&!sameReply(value,schema.const))return false;
 if(Array.isArray(schema.enum)&&!schema.enum.some(v=>sameReply(v,value)))return false;
 if(schema.anyOf&&!schema.anyOf.some(s=>elicitationValue(value,s,depth+1)))return false;
 if(schema.oneOf&&schema.oneOf.filter(s=>elicitationValue(value,s,depth+1)).length!==1)return false;
 const types=Array.isArray(schema.type)?schema.type:[schema.type];
 if(schema.type&&!types.some(t=>t==='null'?value===null:t==='object'?plain(value):t==='array'?Array.isArray(value):t==='integer'?Number.isSafeInteger(value):t==='number'?typeof value==='number'&&Number.isFinite(value):typeof value===t))return false;
 if(typeof value==='string'&&(schema.minLength!=null&&value.length<schema.minLength||schema.maxLength!=null&&value.length>schema.maxLength))return false;
 if(typeof value==='number'&&(schema.minimum!=null&&value<schema.minimum||schema.maximum!=null&&value>schema.maximum))return false;
 if(Array.isArray(value)&&(schema.minItems!=null&&value.length<schema.minItems||schema.maxItems!=null&&value.length>schema.maxItems||schema.items&&!value.every(v=>elicitationValue(v,schema.items,depth+1))))return false;
 if(plain(value)){
  if((schema.required||[]).some(k=>!(k in value)))return false;
  for(const [key,v]of Object.entries(value)){const spec=schema.properties?.[key];if(!spec&&schema.additionalProperties===false||spec&&!elicitationValue(v,spec,depth+1))return false;}
 }
 return true;
}
function elicitationReply(value,params){
 if(!plain(value)||Object.keys(value).some(k=>!['action','content','_meta'].includes(k))||!['accept','decline','cancel'].includes(value.action)||Buffer.byteLength(JSON.stringify(value))>128*1024)throw fail(400,'补充输入回复无效');
 if(value.action!=='accept'){if(value.content!=null)throw fail(400,'拒绝或取消不能提交补充输入');return;}
 if(['form','openai/form','openaiForm'].includes(params.mode)&&(!plain(value.content)||!elicitationValue(value.content,params.requestedSchema)))throw fail(400,'补充输入与原表单不符');
 if(params.mode==='openai/userVerification'&&value.content==null)throw fail(400,'此验证需要设备证明');
 if(!['form','openai/form','openaiForm','url','openai/userVerification'].includes(params.mode))throw fail(400,'补充输入形式无效');
}
const nativeProfile=mode=>({'workspace-write':':workspace','read-only':':read-only','danger-full-access':':danger-full-access'}[mode]);
async function runtimeRootAllowed(root,ws,threadId){if(await belongs(root,ws))return true;if(!threadId||typeof root!=='string')return false;const base=path.join(runtimeProfile.codexHome,'visualizations');if(!root.startsWith(base+path.sep))return false;const match=root.slice(base.length+1).match(/^(\d{4}\/\d{2}\/\d{2})\/([0-9a-f-]{36})(?:\/|$)/i);if(match?.[2]!==threadId)return false;try{const expected=path.join(await realpath(base),match[1],threadId),actual=await realpath(root);return actual===expected||actual.startsWith(expected+path.sep);}catch{return false;}}
const stableId=v=>{const h=createHash('sha256').update(v).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export class OfficialBoundary {
 constructor({native,journal,onHistoryRead=()=>{},onNativeResponse=()=>{},historyUpgradeBeforeResume=null,onHistoryUpgrade=()=>{},historyUpgradeWaitMs=10000,enableDefaultModeQuestions=false}){Object.assign(this,{native,journal,onHistoryRead,onNativeResponse,historyUpgradeBeforeResume,onHistoryUpgrade,enableDefaultModeQuestions});this.historyUpgradeWaitMs=Math.max(1,Math.min(10000,historyUpgradeWaitMs));this.historyPreparations=new Map();this.historyCompatibility=new Map();this.threads=new Map();this.checks=new Map();this.lists=new Map();this.queues=new Map();this.active=new Map();this.activityVersion=0;this.pendingStarts=new Map();this.approvals=new Map();this.unmaterialized=new Set();this.usage=new Map();this.appCatalogCache=new AppCatalogCache({read:(params,diagnostic)=>this.native.rpc('app/list',params,diagnostic)});native.on?.('interrupted',()=>{this.appCatalogCache.invalidate();this.activityVersion++;for(const pending of this.pendingStarts.values())pending.closed=true;this.threads.clear();this.lists.clear();this.auxiliaryReads?.clear();this.active.clear();this.approvals.clear();this.unmaterialized.clear();this.defaults=null;});}
 historyUpgradeEvent(scope,threadId,outcome,startedAt,requestId){
  const statuses=['preparing','pending','verified','already_paginated','loaded','busy','in_progress','unsupported','unavailable','needs_review'];
  const entry={scope,threadId,status:statuses.includes(outcome?.status)?outcome.status:'needs_review',durationMs:Date.now()-startedAt,rpcIdHash:hashDiagnosticId(requestId)};
  if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(outcome?.transactionId||''))entry.transactionId=outcome.transactionId;
  if(outcome?.error)Object.assign(entry,errorDiagnosticFields(outcome.error));
  this.historyCompatibility.set(scope+':'+threadId,entry);
  while(this.historyCompatibility.size>2048){const key=[...this.historyCompatibility.keys()].find(key=>!this.historyPreparations.has(key));if(!key)break;this.historyCompatibility.delete(key);}
  try{this.onHistoryUpgrade(entry);}catch{}
  return entry;
 }
 historyIsPreparing(scope,threadId){const key=scope+':'+threadId;return this.historyPreparations.has(key)||this.historyCompatibility.get(key)?.status==='in_progress';}
 async prepareResumeHistory(scope,threadId,requestId){
  if(!this.historyUpgradeBeforeResume)return;
  const key=scope+':'+threadId,known=this.historyCompatibility.get(key);
  // The read proving workspace membership can yield while the preceding
  // preparation finishes. Reuse that verified transaction even in this gap.
  if(['verified','already_paginated','needs_review'].includes(known?.status))return;
  let running=this.historyPreparations.get(key);
  if(!running){
   const startedAt=Date.now();running={startedAt};this.historyPreparations.set(key,running);
   this.historyUpgradeEvent(scope,threadId,{status:'preparing'},startedAt,requestId);
   running.promise=Promise.resolve().then(()=>this.historyUpgradeBeforeResume({scope,threadId})).catch(error=>({status:'needs_review',error})).then(outcome=>this.historyUpgradeEvent(scope,threadId,outcome,startedAt,requestId)).finally(()=>{if(this.historyPreparations.get(key)===running)this.historyPreparations.delete(key);});
  }
  let timer;const pending=new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'pending'}),this.historyUpgradeWaitMs);});
  let outcome;try{outcome=await Promise.race([running.promise,pending]);}finally{clearTimeout(timer);}
  if(['pending','in_progress'].includes(outcome.status)){
   if(outcome.status==='pending')this.historyUpgradeEvent(scope,threadId,outcome,running.startedAt,requestId);
   throw fail(409,'旧会话历史正在准备，输入已保留；准备完成后可在原会话继续。');
  }
 }
 remember(t){if(!t?.id)return;this.threads.delete(t.id);this.threads.set(t.id,{...t,verifiedAt:Date.now()});while(this.threads.size>2048)this.threads.delete(this.threads.keys().next().value);}
 reconcileActivity(thread,version){
  // Native is authoritative, but an older read must not erase a newer event.
  if(version===this.activityVersion&&['idle','systemError'].includes(thread?.status?.type))this.active.delete(thread.id);
 }
 async activityThread(id){
  const version=this.activityVersion,tracked=this.active.get(id);
  const cached=this.unmaterialized.has(id),thread=cached?this.threads.get(id):(await this.native.rpc('thread/read',{threadId:id,includeTurns:false})).thread;
  if(!thread)throw fail(503,'无法核实宿主任务状态');
  if(!cached)this.reconcileActivity(thread,version);
  if(thread.status?.type==='notLoaded'&&tracked&&version===this.activityVersion){
   const page=await this.native.rpc('thread/turns/list',{threadId:id,limit:1,itemsView:'summary',sortDirection:'desc'}),turn=page.data?.[0];
   if(version===this.activityVersion&&this.active.get(id)===tracked&&turn?.id===tracked&&['completed','failed','interrupted'].includes(turn.status))this.active.delete(id);
  }
  return thread;
 }
 observeActivity(method,p,id){
  if(typeof id!=='string'||!id)return;
  if(!['turn/started','turn/completed','thread/status/changed','thread/closed'].includes(method))return;
  this.activityVersion++;
  const pending=this.pendingStarts.get(id),turnId=p.turn?.id||p.turnId;
  if(method==='turn/started'&&typeof turnId==='string'&&turnId){this.active.set(id,turnId);if(pending)pending.lastStarted=turnId;}
  if(method==='turn/completed'&&typeof turnId==='string'&&turnId){pending?.terminalTurns.add(turnId);if(this.active.get(id)===turnId)this.active.delete(id);}
  if(method==='thread/status/changed'&&['idle','systemError'].includes(p.status?.type)){if(pending&&this.active.has(id))pending.terminalTurns.add(this.active.get(id));this.active.delete(id);}
  if(method==='thread/closed'){if(pending)pending.closed=true;this.active.delete(id);}
 }
 async checked(ws,id,{fresh=false}={}){validateId(id);let t=this.threads.get(id);if(fresh||!t||Date.now()-t.verifiedAt>60000){let p=this.checks.get(id);if(!p){const version=this.activityVersion;p=this.native.rpc('thread/read',{threadId:id,includeTurns:false}).then(r=>{this.remember(r.thread);this.reconcileActivity(r.thread,version);return r.thread;}).finally(()=>this.checks.delete(id));this.checks.set(id,p);}t=await p;}if(!t||!await belongs(t.cwd,ws))throw fail(404,'会话不存在或不属于此工作区');return t;}
 async loadedEmptyThread(ws,id){
  if(!this.journal.ownsThread(ws.id,id)||!(await this.loadedIds()).has(id))return null;
  const t=await this.checked(ws,id,{fresh:true});if(t.status?.type!=='idle'||t.preview?.trim())return null;
  const row=this.journal.db?.prepare("SELECT result FROM requests WHERE workspace=? AND state='accepted' AND json_extract(result,'$.thread.id')=? AND json_extract(result,'$.sandbox') IS NOT NULL LIMIT 1").get(ws.id,id);
  if(!row)return null;const created=JSON.parse(row.result);if(created.thread?.turns?.length)return null;
  return {...created,model:t.model??created.model,reasoningEffort:t.reasoningEffort??created.reasoningEffort,thread:{...t,turns:[]}};
 }
 async readNative(ws,method,p,diagnostic){
  try{return await this.native.rpc(method,p,diagnostic);}catch(error){
   const emptyError=/not materialized yet|no rollout found for thread id/i.test(error.message||'');
   if(!emptyError||p.cursor||!(method==='thread/read'&&p.includeTurns||method==='thread/turns/list'))throw error;
   const empty=await this.loadedEmptyThread(ws,p.threadId);if(!empty)throw error;
   this.unmaterialized.add(p.threadId);return method==='thread/read'?{thread:empty.thread}:{data:[],nextCursor:null};
  }
 }
 async archivedIds(scope){
  const ids=new Set(),seen=new Set();let cursor;
  for(let page=0;page<512;page++){
   const result=await this.call(scope,{method:'thread/list',params:{archived:true,limit:50,...(cursor?{cursor}:{})}});
   for(const t of result.data||[])ids.add(t.id);
   cursor=result.nextCursor;if(!cursor)return ids;
   if(seen.has(cursor))throw fail(503,'归档分页异常');seen.add(cursor);
  }
  throw fail(503,'归档列表尚未完整读取');
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
 async writable(ws,id){if(runtimeProfile.portable&&ws.readOnly)throw fail(403,'Workspace is read-only');const owned=this.journal.ownsThread(ws.id,id),t=await this.checked(ws,id,{fresh:!this.unmaterialized.has(id)});if(!owned&&!(await this.loadedIds()).has(id))throw fail(403,'外部线程仅供阅读；请在原宿主续接');return t;}
 async snapshot(scope){
  const ws=workspace(scope),threads=[];
  for(const id of await this.loadedIds())try{const t=await this.checked(ws,id,{fresh:!this.unmaterialized.has(id)});threads.push({id:t.id,status:t.status});}catch(e){if(e.code!==404)throw e;}
  const approvals=[];for(const a of this.approvals.values())if(threads.some(t=>t.id===a.params?.threadId))approvals.push(a);
  return {hostState:this.native.state,threads,activeThreadIds:threads.filter(t=>t.status?.type==='active'||this.active.has(t.id)).map(t=>t.id),approvals};
 }
 async hostActivity(){await this.native.start();const ids=new Set([...await this.loadedIds(),...this.active.keys()]),observed=new Set();for(const id of ids){const t=await this.activityThread(id);if(t.status?.type==='active')observed.add(id);}const active=new Set([...observed,...this.active.keys()]);return {activeTurns:active.size,pendingApprovals:this.approvals.size,pendingHistoryUpgrades:this.historyPreparations.size};}
 serial(k,fn){const p=this.queues.get(k)||Promise.resolve(),n=p.catch(()=>{}).then(fn);this.queues.set(k,n);n.finally(()=>{if(this.queues.get(k)===n)this.queues.delete(k);}).catch(()=>{});return n;}
 async config({fresh=false}={}){if(fresh||!this.defaults||Date.now()-(this.defaultsAt||0)>2000){this.defaults=(await this.native.rpc('config/read',{includeLayers:false})).config;this.defaultsAt=Date.now();}return this.defaults;}
 async validateInput(scope,input){if(!Array.isArray(input))throw fail(400,'消息输入无效');for(const item of input){if(item.type==='text')continue;if(['localImage','localAudio','mention'].includes(item.type)&&this.files){await this.files.resolve(scope,item.path);continue;}if(item.type==='image'&&/^data:image\/(png|jpeg|webp|gif);base64,/.test(item.url)&&item.url.length<8*1024*1024)continue;throw fail(403,'输入附件不属于当前工作区或类型尚未支持');}}
 async commandStatus(scope,{method,threadId,clientUserMessageId,requestId}){
  const ws=workspace(scope);
  if(!['turn/start','turn/steer'].includes(method))throw fail(400,'此请求类型不支持发送结果核对');
  validateId(threadId);validateId(clientUserMessageId);
  if(typeof requestId!=='string'||!requestId||requestId.length>256)throw fail(400,'原始请求标识无效');
  const id=stableId(`${ws.id}:${method}:${clientUserMessageId}`),row=this.journal.get(ws.id,id);
  const response={requestId,method,threadId,clientUserMessageId,state:row?.state||'not_found',result:null};
  const binding=this.journal.binding(ws.id,id);
  if(row&&binding){
   if(binding.method!==method||binding.threadId!==threadId||binding.clientUserMessageId!==clientUserMessageId)throw fail(404,'发送结果不属于此会话');
   // This identity was committed atomically with the original scoped command.
   // Its durable receipt remains readable while Native or its socket is down;
   // receipt recovery must not require the failed command transport to recover.
  }else{
   await this.native.start();await this.checked(ws,threadId,{fresh:true});
   if(!row)return response;
   // Older ledgers did not store an explicit thread binding. An accepted turn
   // may be recovered only after Native proves that exact turn belongs here.
   // Missing/rejected/unknown rows are never inferred from text or timestamps.
   const turnId=method==='turn/start'?row.result?.turn?.id:row.result?.turnId;
   if(row.state!=='accepted'||typeof turnId!=='string')return {...response,state:'unknown'};
   const turns=await this.native.rpc('thread/turns/list',{threadId,limit:20,sortDirection:'desc',itemsView:'summary'});
   if(!turns.data?.some(turn=>turn.id===turnId))return {...response,state:'unknown'};
  }
  return {...response,result:['accepted','rejected'].includes(row.state)?row.result:null};
 }
 async readAppCatalog(scope,{params={},ifNoneMatch=null,fresh=false,diagnostic}={}){
  const ws=workspace(scope);await this.native.start();
  if(params.threadId!=null)await this.checked(ws,params.threadId);
  return this.appCatalogCache.response(scope,{...params},{ifNoneMatch,fresh,diagnostic});
 }
 async call(scope,request,{clientId='',pageId='',connectionId='',capacityGuard=null}={}){
  const method=request?.method,context={clientId,pageId,connectionId,capacityGuard};
  if(!capacityGuard)this.capacityRetry?.manual(scope,method,request?.params);
  if(method!=='thread/start'&&!WRITES.has(method))return this.#dispatch(scope,request,context);
  const ws=workspace(scope);
  if(!clientId||request.id==null)throw fail(400,'写请求缺少稳定客户端身份');
  // Reserve the conversation's arrival order before any asynchronous policy,
  // path or connection preparation. Otherwise a later stop can overtake a send.
  // New threads have no shared conversation yet: only duplicate delivery of
  // the same creation command shares a lane. Native and Journal still own all
  // execution facts; these lanes only order requests within this adapter.
  const captured={...request,params:{...(request.params||{})}};
  const key=JSON.stringify(method==='thread/start'?[ws.id,'new',stableId(`${ws.id}:${method}:${clientId}:${request.id}`)]:[ws.id,'thread',captured.params.threadId]);
  return this.serial(key,()=>this.#dispatch(scope,captured,context));
 }
 async #dispatch(scope,request,{clientId='',pageId='',connectionId='',capacityGuard=null}={}){
  const ws=workspace(scope),method=request?.method,p={...(request?.params||{})};let resumePolicy=null;
  if(UNAVAILABLE.has(method))throw Object.assign(fail(501,'当前分区工作台暂不提供这项可选能力'),{rpcCode:-32601});
  await this.native.start();
  if(this.capacityRetry&&method==='dsh/capacityRetry/read')return this.capacityRetry.read(scope,p);
  if(this.capacityRetry&&method==='dsh/capacityRetry/cancel')return this.capacityRetry.stop(scope,p);
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
  if(READS.has(method)){await this.checked(ws,p.threadId);if(method==='thread/turns/list')p.limit=Math.min(20,Math.max(1,Number(p.limit)||12));if(method==='thread/items/list')p.limit=Math.min(100,Math.max(1,Number(p.limit)||40));const started=Date.now(),result=await this.readNative(ws,method,p,{id:request.id,scope,pageId,connectionId,params:p});if(method!=='thread/read')try{this.onHistoryRead({scope,method,threadId:p.threadId,turnId:p.turnId??null,hasCursor:!!p.cursor,cursorHash:p.cursor?createHash('sha256').update(String(p.cursor)).digest('hex').slice(0,12):null,sortDirection:p.sortDirection??null,itemsView:p.itemsView??null,limit:p.limit,count:result.data?.length??null,returnedTurnIds:method==='thread/turns/list'?result.data.map(t=>t.id):undefined,hasNextCursor:!!result.nextCursor,durationMs:Date.now()-started,responseBytes:Buffer.byteLength(JSON.stringify(result))});}catch{}return result;}
  if(GLOBAL.has(method))return this.native.rpc(method,p);
  if(method==='skills/list'){const cwds=p.cwds?.length?p.cwds:[ws.root];for(const cwd of cwds)if(!await belongs(cwd,ws))throw fail(403,'技能工作目录超出当前工作区');return this.native.rpc(method,{...p,cwds});}
  if(method==='app/list')return (await this.readAppCatalog(scope,{params:p,diagnostic:{id:request.id,scope,pageId,connectionId,params:p}})).result;
  if(method==='mcpServerStatus/list'){
   // The renderer requests this through multiple hooks during recovery. Share
   // only the in-flight read; subsequent calls still observe current Native state.
   this.auxiliaryReads??=new Map();const key=JSON.stringify([scope,method,Object.fromEntries(Object.entries(p).sort(([a],[b])=>a.localeCompare(b)))]);
   let pending=this.auxiliaryReads.get(key);if(!pending){pending=Promise.resolve().then(()=>this.native.rpc(method,p));this.auxiliaryReads.set(key,pending);pending.finally(()=>{if(this.auxiliaryReads.get(key)===pending)this.auxiliaryReads.delete(key);}).catch(()=>{});}
   return structuredClone(await pending);
  }
  if(method!=='thread/start'&&!WRITES.has(method))throw fail(403,'此能力尚未开放于分区工作台');
  if(runtimeProfile.portable&&ws.readOnly)throw fail(403,'Workspace is read-only');
  if(HISTORY_WRITES.has(method)){
   // The official edit action rewrites history before starting its replacement
   // turn. Keep it on the same scoped, serialized and durable command path.
   if(Object.keys(p).some(k=>k!=='threadId'&&k!=='beforeTurnId'))throw fail(400,'编辑历史消息的参数无效');
   validateId(p.beforeTurnId);
  }
  if(method==='thread/delete'&&Object.keys(p).some(k=>k!=='threadId'))throw fail(400,'删除请求参数无效');
  if(method==='thread/stop'&&Object.keys(p).some(k=>k!=='threadId'))throw fail(400,'停止请求参数无效');
  if(!clientId||request.id==null)throw fail(400,'写请求缺少稳定客户端身份');
  if(method==='thread/start'){await this.config({fresh:true});if(p.cwd&&!await belongs(p.cwd,ws))throw fail(403,'工作目录超出当前工作区');p.cwd=p.cwd||ws.root;p.historyMode='paginated';if(p.model==null&&WORKBENCH_NEW_CHAT.model)p.model=WORKBENCH_NEW_CHAT.model;p.config={...p.config};if(p.config.model_reasoning_effort==null&&WORKBENCH_NEW_CHAT.model_reasoning_effort)p.config.model_reasoning_effort=WORKBENCH_NEW_CHAT.model_reasoning_effort;}
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
   // Native can rotate a rollout while a page still holds its previous path.
   // The scoped thread ID is the only resume selector: never forward a
   // browser path, even a matching one. checked() below validates the current
   // Native thread and workspace before the atomic writer acquisition.
   if(typeof p.path==='string')delete p.path;
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
   const r=await this.journal.run(ws.id,id,{method,params:{...p,...(requestEffort===undefined?{}:{config:{model_reasoning_effort:requestEffort}})}},async()=>{
    // Resume is the native atomic writer-lock acquisition. A historical origin
    // is not a reason to deny it; other mutations still require this host.
    if(['turn/start','turn/steer',...HISTORY_WRITES].includes(method)&&this.historyIsPreparing(scope,p.threadId)){await this.checked(ws,p.threadId,{fresh:true});throw fail(409,'旧会话历史仍在准备，输入已保留；请等待准备完成后再操作。');}
    const thread=method==='thread/start'?null:['thread/resume','thread/section/move','thread/delete'].includes(method)?await this.checked(ws,p.threadId,{fresh:method==='thread/delete'||method==='thread/resume'&&!!this.historyUpgradeBeforeResume}):await this.writable(ws,p.threadId);
    // A successful scope check must precede any official CLI migration. Its
    // independent preparation budget never changes the Native RPC timeout.
    if(method==='thread/resume')await this.prepareResumeHistory(scope,p.threadId,request.id);
    // An interrupt receipt alone does not mean Native has finished stopping.
    // A completed failed turn reports systemError, which is also stopped.
    // Keep this allowlist: Native revert can interrupt a still-active turn.
    if(method==='thread/delete'&&(thread.status?.type==='active'||this.active.has(p.threadId)||!(await this.archivedIds(scope)).has(p.threadId)))throw fail(409,'只能删除当前工作区已归档且未运行的会话');
    if(HISTORY_WRITES.has(method)&&(!['idle','systemError'].includes(thread.status?.type)||this.active.has(p.threadId)))throw fail(409,'任务尚未停止完成，请稍后再编辑消息');
    if(HISTORY_WRITES.has(method)&&this.historyCompatibility.get(scope+':'+p.threadId)?.status==='needs_review')throw fail(409,'这个旧会话的历史升级尚未通过核对，编辑内容已保留。');
    if(HISTORY_WRITES.has(method)&&thread.historyMode==='legacy')throw fail(409,'这个旧会话的历史升级尚未完成，编辑内容已保留。');
    // 去重在 active 检查之前，ACK 丢失时返回同一已接受 turn。
    if(method==='turn/start'||method==='turn/steer'){if(method==='turn/start'&&thread.status?.type==='active')throw fail(409,'任务正在执行');await this.validateInput(scope,p.input||[]);}
    if(['thread/queue/add','thread/queue/update'].includes(method))await this.validateInput(scope,p.input||[]);
    // A scoped session feature, explicitly owned by this workbench adapter.
    // Do not write config.toml or accept arbitrary browser feature overrides.
    if(capacityGuard&&!capacityGuard())throw fail(409,'原回合已变化，自动重试已取消');
    const nativeParams=['thread/start','thread/resume'].includes(method)&&(this.enableDefaultModeQuestions||requestEffort!==undefined)?{...p,config:{...(this.enableDefaultModeQuestions?{'features.default_mode_request_user_input':true}:{}),...(requestEffort===undefined?{}:{model_reasoning_effort:requestEffort})}}:p;
    const diagnostic={id:request.id,scope,pageId,connectionId,params:nativeParams},startObservation=method==='turn/start'?{terminalTurns:new Set(),closed:false,lastStarted:null}:null;if(startObservation)this.pendingStarts.set(p.threadId,startObservation);let value;try{value=await this.native.rpc(method,nativeParams,diagnostic);}catch(e){if(method==='thread/resume'&&/no rollout found for thread id|not materialized yet/i.test(e.message||'')){const empty=await this.loadedEmptyThread(ws,p.threadId);if(empty){if(p.model!=null||requestEffort!==undefined)await this.native.rpc('thread/settings/update',{threadId:p.threadId,...(p.model==null?{}:{model:p.model}),...(requestEffort===undefined?{}:{effort:requestEffort})},{id:request.id,scope,params:{threadId:p.threadId,...(p.model==null?{}:{model:p.model}),...(requestEffort===undefined?{}:{effort:requestEffort})}});value={...empty,...(p.model==null?{}:{model:p.model}),...(requestEffort===undefined?{}:{reasoningEffort:requestEffort}),turnsBackwardsCursor:null,itemsBackwardsCursor:null};this.unmaterialized.add(p.threadId);}else throw e;}else if(![503,504].includes(e.code)&&/writer.*(?:lock|ownership)|thread.*already.*(?:use|open|load)/i.test(e.message||''))throw Object.assign(fail(409,'此会话仍由另一个 Codex 执行端持有；当前操作未执行，输入已保留。'),{rpcCode:e.rpcCode});else throw e;}finally{if(startObservation&&this.pendingStarts.get(p.threadId)===startObservation)this.pendingStarts.delete(p.threadId);}
    try{this.onNativeResponse(scope,method,p,value);}catch{}
    if(HISTORY_WRITES.has(method)&&value.thread){this.remember(value.thread);this.unmaterialized.delete(p.threadId);this.active.delete(p.threadId);}
    if(method==='thread/resume'&&value.thread){if(!this.journal.ownsThread(ws.id,value.thread.id))this.journal.manageThread(ws.id,value.thread.id);this.remember(value.thread);}
    if(method==='thread/start'||method==='thread/fork'){this.journal.manageThread(ws.id,value.thread.id);this.remember(value.thread);if(method==='thread/start')this.unmaterialized.add(value.thread.id);}
    if(method==='thread/delete'){this.threads.delete(p.threadId);this.unmaterialized.delete(p.threadId);this.active.delete(p.threadId);}
    if(method==='turn/start'){this.activityVersion++;this.unmaterialized.delete(p.threadId);const terminal=['completed','failed','interrupted'].includes(value.turn.status);if(terminal&&this.active.get(p.threadId)===value.turn.id)this.active.delete(p.threadId);else if(!terminal&&!startObservation.closed&&!startObservation.terminalTurns.has(value.turn.id)&&(!startObservation.lastStarted||startObservation.lastStarted===value.turn.id))this.active.set(p.threadId,value.turn.id);}
    return value;
   });
   if(r.state==='accepted')return r.result;
   throw Object.assign(fail(['unknown','pending'].includes(r.state)?409:r.result?.code||400,['unknown','pending'].includes(r.state)?'发送结果待核对；不会重复执行':r.result?.error||'请求未完成'),{rpcCode:r.result?.rpcCode});
 }
 observe(m){if(m.method==='app/list/updated')this.appCatalogCache.invalidateCatalog(m.params);else if(['account/updated','account/login/completed'].includes(m.method))this.appCatalogCache.invalidate();const p=m.params||{},id=p.threadId||p.thread?.id;if(m.method==='thread/tokenUsage/updated'&&id&&p.turnId&&p.tokenUsage?.last){const key=id+':'+p.turnId;this.usage.delete(key);this.usage.set(key,{threadId:id,turnId:p.turnId,...Object.fromEntries(['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','totalTokens'].filter(k=>Number.isFinite(p.tokenUsage.last[k])).map(k=>[k,p.tokenUsage.last[k]]))});while(this.usage.size>1000)this.usage.delete(this.usage.keys().next().value);}if(p.thread?.cwd)this.remember(p.thread);this.observeActivity(m.method,p,id);if(m.method==='thread/status/changed'&&this.threads.has(id))this.threads.get(id).status=p.status;if(m.method==='thread/closed')this.threads.delete(id);if(m.id!==undefined&&id)this.approvals.set(String(m.id),m);if(m.method==='serverRequest/resolved')this.approvals.delete(String(p.requestId));this.capacityRetry?.observe(m);}
 async notification(scope,m){const ws=workspace(scope),p=m.params||{},id=p.threadId||p.thread?.id;
  // Both workspaces already have a read-only quota view of this shared account.
  // Forward only invalidation, never Native's account payload or credentials.
  if(!id&&m.id===undefined&&m.method==='account/rateLimits/updated')return {method:m.method,params:{}};
  if(!id)return null;try{await this.checked(ws,id);return m;}catch{return null;}}
 async answer(scope,message){return this.serial('approval:'+String(message.id),async()=>{const ws=workspace(scope),key=String(message.id),a=this.approvals.get(key);if(!a)throw fail(409,'审批已处理或失效');
  if(a.method==='currentTime/read'){
   await this.checked(ws,a.params.threadId);
   const value=message.result;if(!value||Object.keys(value).length!==1||!Number.isSafeInteger(value.currentTimeAt)||value.currentTimeAt<0)throw fail(400,'时钟回复无效');
  }else{
   await this.writable(ws,a.params.threadId);if(!['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/requestUserInput','item/tool/call','mcpServer/elicitation/request'].includes(a.method))throw fail(403,'该审批类型尚未开放');
   if(a.method==='item/permissions/requestApproval')permissionsReply(message.result,a.params.permissions);
   if(a.method==='mcpServer/elicitation/request')elicitationReply(message.result,a.params);
  }
  if(this.approvals.get(key)!==a)throw fail(409,'审批已由另一端处理');this.native.send({id:a.id,...('result'in message?{result:message.result}:{error:message.error})});this.approvals.delete(key);return {};});}
 bootstrap(scope,c,savedGlobals={}){const ws=workspace(scope),atoms={};for(const[k,v]of Object.entries(c.persistedAtomSnapshot||{}))if(/^(sidebar-width|app-shell:right-panel-width:v3|has-seen-[a-z-]+|composer-model-picker-menu-view-v1)$/.test(k))atoms[k]=v;
  const projects=workspaceProjects(ws,savedGlobals),entries=[{key:'pending_worktrees',value:[]},...Object.entries(projects.globals).map(([key,value])=>({key,value}))];
  return {dshCapacityRetry:!!this.capacityRetry&&scope==='ai',gatewayBaseUrl:`${c.gatewayBaseUrl}/w/${ws.id}`,gatewayWsUrl:c.gatewayWsUrl.replace(/\/ws$/,`/w/${ws.id}/ws`),workspaceRoots:projects.workspaceRoots,homeDir:ws.root,locale:c.locale,localeSource:c.localeSource,localeMode:c.localeMode,messages:c.messages,gatewayPluginConfig:{schemaVersion:3,revision:1,plugins:{'opencodex.smart-model-router':{enabled:false,values:{}}}},debugClientDiagnostics:false,debugWs:false,appServer:{kind:'official-electron-ipc'},sharedObjectSnapshot:{host_config:{id:'local',kind:'local'}},persistedAtomSnapshot:atoms,initialSidebarBootstrap:{catalogEntries:[],catalogHostIds:['local'],globalStateEntries:entries,workspaceRootOptions:projects.workspaceRootOptions,projectlessWorkspaceRoot:{workspaceRoot:ws.root}}};
 }
}

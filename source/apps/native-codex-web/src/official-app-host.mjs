import {randomUUID} from 'node:crypto';
import {workspace,fail} from './registry.mjs';
import {createOfficialSettings} from './official-settings.mjs';
import {ThreadTitleGeneration} from './thread-title-generation.mjs';
// AppHost contracts follow the pinned official renderer. Native execution still
// flows through OfficialBoundary; browser-only presentation has no auto-answer.
export function createAppHostFactory({RpcTarget,boundary,state,persist,files,native,clients,send,browserAction,fileUrl,titleDiagnostic=()=>{},titleGenerator=new ThreadTitleGeneration({native,diagnostic:titleDiagnostic}),settings=createOfficialSettings({RpcTarget,state,persist})}){
 class Noop extends RpcTarget {dispose(){}unsubscribe(){}stateChanged(){}update(){}}
 class ConversationPresentation extends RpcTarget {
  constructor(scope,client){super();this.scope=scope;this.client=client;}
  async setConversationPresented(p){return boundary.serial('presentation:'+this.client.pageId,async()=>{
   if(p.hostId!=='local')throw fail(403,'宿主不属于当前工作区');await boundary.checked(workspace(this.scope),p.conversationId);
   // Presentation is a renderer acknowledgement, never a navigation command.
   if(p.presented){this.client.presentedThreadId=p.conversationId;}
   else if(this.client.presentedThreadId===p.conversationId){this.client.presentedThreadId=null;}
  });}
  async recordConversationActivity(p){if(p.hostId!=='local')throw fail(403,'宿主不属于当前工作区');await boundary.checked(workspace(this.scope),p.conversationId);}
 }
 class ThreadMetadataGeneration extends RpcTarget {
  constructor(scope){super();this.scope=scope;}
  generateTitle(p){return titleGenerator.generateTitle(this.scope,p);}
  // Optional metadata functions do not regenerate or overwrite existing names.
  async generateDescription(){return null;}
  async reconsiderTitle(){return null;}
 }
 class ThreadArchive extends RpcTarget {
  constructor(scope,client){super();this.scope=scope;this.client=client;}
  checkHost(p){if(p.hostId!=='local')throw fail(403,'宿主不属于当前工作区');}
  async deleteArchivedThread(p){this.checkHost(p);await boundary.call(this.scope,{id:randomUUID(),method:'thread/delete',params:{threadId:p.threadId}},{clientId:this.client.stableId});return {deletedThreadIds:[p.threadId]};}
  async deleteAllArchivedThreads(p){
   this.checkHost(p);const ids=await boundary.archivedIds(this.scope),deletedThreadIds=[];
   // Enumerate a scoped snapshot before mutating; never call an account-wide delete.
   for(const threadId of ids){await this.deleteArchivedThread({...p,threadId});deletedThreadIds.push(threadId);}
   return {deletedThreadIds};
  }
  async archiveInactiveThread(p){this.checkHost(p);await boundary.call(this.scope,{id:randomUUID(),method:'thread/archive',params:{threadId:p.threadId}},{clientId:this.client.stableId});return {success:true};}
 }
 class HttpFetch extends RpcTarget {
  async fetch(id,request){
   let u;try{u=new URL(request.url);}catch{return {error:'Unsupported request',status:403};}
   // OpenCodex already supplies a local i18n bootstrap via fetch(); current
   // official resources use AppHost.httpFetch instead. Keep the same local
   // language bootstrap, without forwarding credentials or changing routing.
   if(u.hostname==='ab.chatgpt.com'&&u.pathname.replace(/\/+$/,'')==='/v1/initialize'){
    // Pinned renderer gates: async question cards and their inline answer UI.
    // These only expose native questions; they do not auto-answer or change tools.
    const feature_gates=Object.fromEntries(['580984490','3125406982'].map(name=>[name,{name,value:true,rule_id:'local_native_question_ui',secondary_exposures:[]}]));
    const data={has_updates:true,time:Date.now(),hash_used:'djb2',feature_gates,dynamic_configs:{},layer_configs:{'72216192':{name:'72216192',value:{enable_i18n:true,locale_source:'IDE'},rule_id:'local_language',secondary_exposures:[]}},param_stores:{},exposures:{},sdk_flags:{}};
    return {response:new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}})};
   }
   if((u.hostname==='ab.chatgpt.com'&&u.pathname==='/v1/rgstr')||(u.hostname==='chatgpt.com'&&['/ces/v1/rgstr','/ces/v1/log_event'].includes(u.pathname)))return {response:new Response('{}',{headers:{'content-type':'application/json'}})};
   return {error:'此工作台未开放云端 ChatGPT HTTP 通道',status:403};
  }
  cancel(){}
 }
 class Assignments extends RpcTarget {constructor(scope){super();this.scope=scope;}async setAssignment(p){await boundary.writable(workspace(this.scope),p.threadId);const s=await state(this.scope);s.globals['thread-project-assignments']={...s.globals['thread-project-assignments'],[p.threadId]:p.assignment};await persist(this.scope);}async setAssignments(entries){for(const[threadId,assignment]of Object.entries(entries))await this.setAssignment({threadId,assignment});}}

 class Startup extends RpcTarget {async whenReady(){await native.start();}reach(){}}
 class Clipboard extends RpcTarget {constructor(client){super();this.client=client;}writeText(text){if(typeof text!=='string'||text.length>1024*1024)throw fail(400,'复制内容过大');return browserAction(this.client,'clipboard',{text});}}
 class AppInfo extends RpcTarget {get(){return {version:'26.901.51231',buildFlavor:'prod',buildNumber:null};}}
 class WorkspaceFiles extends RpcTarget {
  constructor(scope,client){super();this.scope=scope;this.client=client;}
  read(p){return files.read(this.scope,p);}
  write(p){return files.write(this.scope,p);}
  async saveCopy(p){const target='bytes'in p?(await files.createTemporary(this.scope,p)).path:await files.resolve(this.scope,p.path);await browserAction(this.client,'download',{url:await fileUrl(this.scope,target,true)});return {path:target};}
  async downloadCopy(p){return this.saveCopy(p);}
  createTemporaryFile(p){return files.createTemporary(this.scope,p);}
  releaseTemporaryFile(p){return files.releaseTemporary(this.scope,p.path);}
  createDirectory(p){if(p.hostId!=='local')throw fail(403,'文件宿主不属于当前工作区');return files.directory(this.scope,p.path);}
  async getThumbnailDataUrl(p){await files.resolve(this.scope,p.path);return {dataUrl:null};}
 }
 class FileAttachments extends RpcTarget {
  constructor(scope){super();this.scope=scope;}
  countFolderFiles(p){if(p.hostId!=='local')throw fail(403,'文件宿主不属于当前工作区');return files.count(this.scope,p.folderPath);}
  async persistImageFileToTemp(p){const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'}[p.mimeType];if(!ext)return null;return (await files.createTemporary(this.scope,{bytes:p.bytes,fileName:'image.'+ext})).path;}
 }
 const claimed=new Set();
 class DynamicToolCalls extends RpcTarget {
  constructor(scope){super();this.scope=scope;}
  async tryClaimExecution(p){if(p.hostId!=='local')throw fail(403,'宿主不属于当前工作区');await boundary.writable(workspace(this.scope),p.threadId);const k=JSON.stringify([this.scope,p.threadId,p.turnId,p.callId]);if(claimed.has(k))return false;claimed.add(k);if(claimed.size>1024)claimed.delete(claimed.values().next().value);return true;}
 }
 class Coordination extends RpcTarget {
  constructor(scope,client){super();this.scope=scope;this.client=client;client.ownedThreads??=new Set();}
  async check(p){if(p.hostId&&p.hostId!=='local')throw fail(403,'宿主不属于当前工作区');const id=p.conversationId||p.threadId;if(id)await boundary.checked(workspace(this.scope),id);return id;}
  async setThreadOwnership(p){const id=await this.check(p);if(p.ownsThread){for(const c of clients)if(c!==this.client&&c.scope===this.scope&&c.readyState===1&&c.ownedThreads?.has(id))throw fail(409,'另一页面已持有此会话');this.client.ownedThreads.add(id);}else this.client.ownedThreads.delete(id);}
  async findThreadOwner(p){const id=await this.check(p);return [...clients].find(c=>c.scope===this.scope&&c.readyState===1&&c.ownedThreads?.has(id))?.pageId??null;}
  async broadcast(method,p,targets){await this.check(p);const calls=[];for(const c of clients)if(c!==this.client&&c.scope===this.scope&&c.readyState===1&&(!targets||targets.includes(c.pageId))&&c.viewServices)calls.push(Promise.resolve().then(()=>c.viewServices?.clientCoordination?.[method]?.({sourceClientId:this.client.pageId,params:p})));await Promise.allSettled(calls);}
  threadArchived(p){return this.broadcast('threadArchived',p);}
  threadUnarchived(p){return this.broadcast('threadUnarchived',p);}
  threadQueuedFollowUpsChanged(p){return this.broadcast('threadQueuedFollowUpsChanged',p);}
  threadReadStateChanged(p){return this.broadcast('threadReadStateChanged',p);}
  threadStreamFollowingStatusRequested(p){return this.broadcast('threadStreamFollowingStatusRequested',p);}
  threadStreamStateChanged(p){return this.broadcast('threadStreamStateChanged',p.params,p.targetClientIds);}
  threadStreamFollowingChanged(p){return this.broadcast('threadStreamFollowingChanged',p.params,p.targetClientIds);}
  invalidateQueryCache(p){return this.broadcast('invalidateQueryCache',p);}
  async getIdeContext(p){if(p.workspaceRoot)await files.resolve(this.scope,p.workspaceRoot);return {ideContext:null};}
  async requestThreadFollower(p){const params=p.request?.params||{};const id=await this.check({...params,hostId:p.hostId});const c=[...clients].find(c=>c.scope===this.scope&&c.readyState===1&&(!p.targetClientId||c.pageId===p.targetClientId)&&c.ownedThreads?.has(id));
   if(!c?.viewServices)return {type:'response',resultType:'error',requestId:'',error:'no-client-found'};
   const r=await c.viewServices.clientCoordination.requestThreadFollower({hostId:'local',request:p.request});return {type:'response',resultType:'success',requestId:'',handledByClientId:c.pageId,...r};
  }
 }
 class AppHost extends RpcTarget {
  constructor(scope,client){super();const scopedSettings=settings.forScope(scope);client.cleanup??=new Set();client.cleanup.add(()=>scopedSettings.close());this.value={threadMetadataGeneration:new ThreadMetadataGeneration(scope),threadArchive:new ThreadArchive(scope,client),settings:scopedSettings,httpFetch:new HttpFetch(),requestUserInputAutoResolution:new ConversationPresentation(scope,client),threadProjectAssignments:new Assignments(scope),startup:new Startup(),appInfo:new AppInfo(),clipboard:new Clipboard(client),workspaceFiles:new WorkspaceFiles(scope,client),fileAttachments:new FileAttachments(scope),dynamicToolCalls:new DynamicToolCalls(scope),clientCoordination:new Coordination(scope,client)};}
  get services(){return this.value;}
 }
 return (scope,client)=>new AppHost(scope,client);
}

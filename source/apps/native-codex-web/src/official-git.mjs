import {WebSocket as WS} from './runtime-dependencies.mjs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {workspace,belongs,fail} from './registry.mjs';
const CHANNEL='codex_desktop:worker:git:from-view',OUT='codex_desktop:worker:git:for-view';
const READS=new Set(['availability','base-branch','current-branch','default-branch','review-summary','branch-diff-stats','config-value','stable-metadata','current-branch-snapshot','branch-exists','search-branches','nearest-ancestor-branch','branch-metadata','review-patch','commit-message-diff','index-info','submodule-paths','blame-file','synced-branch','synced-branch-state','untracked-paths','worktree-status','git-availability','watch-repo','unwatch-repo','invalidate-git-read-caches','subscribe-live-query','unsubscribe-live-query','recover-live-queries']);
// Reuse the pinned official Git worker. No shell emulation and no forwarding
// of write/publish operations. Each page has its own correlated IPC requests.
export class OfficialGit {
 constructor({upstream,files,send}){this.upstream=upstream;this.files=files;this.send=send;this.pages=new Map();}
 async validate(scope,method,p,state){
  if(!READS.has(method))throw fail(403,'此 Git 操作请交给会话中的 Codex 执行');
  if(p.hostConfig?.id&&p.hostConfig.id!=='local')throw fail(403,'Git 宿主不属于当前工作区');
  const out={...p,hostConfig:{id:'local',kind:'local'}},ws=workspace(scope);
  if(method==='subscribe-live-query'){if(!p.query||!READS.has(p.query.method))throw fail(403,'Git 查询未开放');out.query={...p.query,params:await this.validate(scope,p.query.method,p.query.params||{},state)};return out;}
  if(method==='unsubscribe-live-query'){if(!state.subscriptions.has(p.subscriptionId))throw fail(403,'Git 订阅不属于此页面');return out;}
  if(method==='recover-live-queries'){if((p.subscriptionIds||[]).some(id=>!state.subscriptions.has(id)))throw fail(403,'Git 订阅不属于此页面');out.cwd=p.cwd||ws.root;}
  if(method==='availability')return out;
  const root=out.cwd||out.root||out.commonDir;if(!root||!await belongs(root,ws))throw fail(403,'Git 目录超出当前工作区');
  for(const key of ['cwd','root','commonDir'])if(out[key]&&!await belongs(out[key],ws))throw fail(403,'Git 目录超出当前工作区');
  for(const key of ['path','filePath'])if(typeof out[key]==='string')await this.files.resolve(scope,path.resolve(root,out[key]),{create:true});
  if(out.paths)for(const file of out.paths)await this.files.resolve(scope,path.resolve(root,file),{create:true});
  return out;
 }
 async page(client){
  if(this.pages.has(client))return this.pages.get(client);
  const state={pending:new Map(),subscriptions:new Set(),roots:new Map(),ready:null,socket:null};this.pages.set(client,state);
  state.ready=new Promise((resolve,reject)=>{
   const socket=state.socket=new WS(this.upstream.replace(/^http/,'ws')+'/ws',{perMessageDeflate:false});let ready=false;
   socket.on('open',()=>socket.send(JSON.stringify({type:'hello',clientId:randomUUID()})));
   socket.on('error',()=>{if(!ready)reject(fail(503,'Git 服务暂不可用'));});
   socket.on('close',()=>{this.pages.delete(client);if(!ready)reject(fail(503,'Git 连接中断'));for(const p of state.pending.values()){clearTimeout(p.timer);this.error(client,p.original,'Git 连接中断，请刷新');}state.pending.clear();});
   socket.on('message',raw=>{Promise.resolve().then(async()=>{
    const m=JSON.parse(raw);if(m.type==='hello-ack'){ready=true;resolve(state);return;}
    if(m.channel!==OUT)return;const frame=m.payload;
    if(frame?.type==='worker-response'){const pending=state.pending.get(frame.response?.id);if(!pending)return;clearTimeout(pending.timer);state.pending.delete(frame.response.id);this.send(client,{channel:OUT,payload:{...frame,response:{...frame.response,id:pending.original.id}}});}
    else if(frame?.type==='worker-event'){const e=frame.event;if(!e||e.hostId&&e.hostId!=='local')return;const root=e.root||e.params?.root,sub=e.subscriptionId;if(sub?state.subscriptions.has(sub):root&&await belongs(root,workspace(client.scope)))this.send(client,{channel:OUT,payload:frame});}
   }).catch(()=>{});});
  });return state;
 }
 error(client,request,message){this.send(client,{channel:OUT,payload:{type:'worker-response',workerId:'git',response:{id:request.id,method:request.method,result:{type:'error',error:message}}}});}
 async invoke(client,frame){
  const state=await this.page(client);await state.ready;
  if(frame.type==='worker-request-cancel'){for(const[id,p]of state.pending)if(p.original.id===frame.id){clearTimeout(p.timer);state.pending.delete(id);this.sendFrame(state,{...frame,id});}return;}
  const original=frame.request;
  try{const params=await this.validate(client.scope,original.method,original.params||{},state),id=randomUUID();
   if(original.method==='watch-repo')state.roots.set(params.root,params);if(original.method==='unwatch-repo')state.roots.delete(params.root);
   if(original.method==='subscribe-live-query')state.subscriptions.add(params.subscriptionId);if(original.method==='unsubscribe-live-query')state.subscriptions.delete(params.subscriptionId);
   const timer=original.method==='subscribe-live-query'?null:setTimeout(()=>{state.pending.delete(id);this.error(client,original,'Git 查询尚未完成，请刷新核对');},30000);state.pending.set(id,{original,timer});this.sendFrame(state,{...frame,request:{...original,id,params}});
  }catch(e){this.error(client,original,e.code?e.message:'Git 查询暂不可用');}
 }
 sendFrame(state,frame){if(state.socket.readyState===1)state.socket.send(JSON.stringify({type:'opencodex:ipc-invoke',requestId:randomUUID(),request:{channel:CHANNEL,args:[frame]}}));}
 close(client){const state=this.pages.get(client);if(!state)return;for(const [root,params]of state.roots)this.sendFrame(state,{type:'worker-request',workerId:'git',request:{id:randomUUID(),method:'unwatch-repo',params}});for(const subscriptionId of state.subscriptions)this.sendFrame(state,{type:'worker-request',workerId:'git',request:{id:randomUUID(),method:'unsubscribe-live-query',params:{hostConfig:{id:'local',kind:'local'},subscriptionId}}});state.socket.close();this.pages.delete(client);}
}

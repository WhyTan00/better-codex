import { EventEmitter } from 'node:events';
import { readFile,mkdir,writeFile,rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { workspace,workspaceFor,fail } from './workspaces.mjs';
const uuid=/^[a-f0-9-]{36}$/i;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export class Gateway extends EventEmitter {
  constructor(rpc,{stateDir='${BETTER_CODEX_HOME}/.better-codex/native-codex'}={}){
    super();this.rpc=rpc;this.generation=rpc.generation;this.stateDir=stateDir;this.state={requests:{},owners:{}};this.loaded=new Set();this.scopes=new Map();this.approvals=new Map();this.active=new Map();this.locks=new Map();this.inflight=new Map();this.seq={ai:0,secondary:0};this.saveQueue=Promise.resolve();
    this.ready=this.init();rpc.on('message',m=>{this.onMessage(m).catch(()=>{})});rpc.on('closed',()=>{this.approvals.clear();for(const w of ['ai','secondary'])this.publish(w,'host/closed',{status:'interrupted'})});
  }
  async init(){await mkdir(this.stateDir,{recursive:true,mode:0o700});try{this.state=JSON.parse(await readFile(join(this.stateDir,'journal.json'),'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}await this.rpc.ready}
  save(){const data=JSON.stringify(this.state);this.saveQueue=this.saveQueue.then(async()=>{const p=join(this.stateDir,'journal.json');await writeFile(p+'.tmp',data,{mode:0o600});await rename(p+'.tmp',p)});return this.saveQueue}
  publish(w,method,params){const e={workspace:w,generation:this.generation,seq:++this.seq[w],method,params};this.emit(w,e);return e}
  async onMessage(m){const p=m.params||{};const id=p.threadId||p.conversationId||p.thread?.id;let w=id&&this.scopes.get(id);
    if(!w&&p.thread?.cwd){w=await workspaceFor(p.thread.cwd);if(w)this.scopes.set(id,w)}
    if(!w){if(m.id!==undefined)this.rpc.write({id:m.id,error:{code:-32601,message:'Unsupported or unscoped server request'}});return}
    if(m.id!==undefined){const key=`${this.generation}:${m.id}`;this.approvals.set(key,{key,workspace:w,threadId:id,method:m.method,params:p,rpcId:m.id});this.publish(w,'approval/requested',this.approvals.get(key));return}
    if(m.method==='turn/started')this.active.set(id,p.turn.id);
    if(m.method==='turn/completed'){this.active.delete(id);for(const [key,a]of this.approvals)if(a.threadId===id)this.approvals.delete(key)}
    this.publish(w,m.method,p);
  }
  async metadata(w,id){workspace(w);if(!uuid.test(id||''))fail('thread_not_found',404);const r=await this.rpc.request('thread/read',{threadId:id,includeTurns:false});if(await workspaceFor(r.thread.cwd)!==w)fail('thread_not_found',404);this.scopes.set(id,w);return r.thread}
  async list(w,{cursor=null,search=''}={}){workspace(w);await this.ready;let data=[],next=cursor;for(let i=0;i<5;i++){const r=await this.rpc.request('thread/list',{limit:100,cursor:next,searchTerm:String(search).slice(0,200)||null,sortKey:'updated_at',useStateDbOnly:true});for(const t of r.data)if(await workspaceFor(t.cwd)===w){this.scopes.set(t.id,w);data.push(this.summary(t))}next=r.nextCursor;if(data.length||!next)break}return {data,nextCursor:next}}
  summary(t){return {id:t.id,name:t.name,preview:t.preview,cwd:t.cwd,updatedAt:t.updatedAt,status:t.status,model:t.model,reasoningEffort:t.reasoningEffort,owned:!!this.state.owners[t.id]}}
  async snapshot(w,id,cursor=null){await this.ready;const t=await this.metadata(w,id);let history;try{history=await this.rpc.request('thread/turns/list',{threadId:id,limit:12,cursor,sortDirection:'desc',itemsView:'full'})}catch(e){if(t.preview)throw e;history={data:[],nextCursor:null}}return {thread:this.summary(t),history,activeTurnId:this.active.get(id)||null,approvals:[...this.approvals.values()].filter(a=>a.workspace===w&&a.threadId===id),generation:this.generation,seq:this.seq[w],hostAlive:this.rpc.alive}}
  serial(key,fn){const p=(this.locks.get(key)||Promise.resolve()).catch(()=>{}).then(fn);this.locks.set(key,p);p.finally(()=>{if(this.locks.get(key)===p)this.locks.delete(key)}).catch(()=>{});return p}
  async mutation(w,key,payload,fn){workspace(w);await this.ready;if(!uuid.test(key||''))fail('request_id_required');const k=w+':'+key;const hash=digest(payload);const prior=this.state.requests[k];if(prior){if(prior.hash!==hash)fail('request_id_conflict',409);if(this.inflight.has(k))return this.inflight.get(k);if(prior.status==='done')return prior.result;fail(prior.status==='failed'?prior.error:'ack_unknown',409)}
    const promise=(async()=>{this.state.requests[k]={hash,status:'pending',at:new Date().toISOString()};await this.save();try{const result=await this.serial(payload.threadId||w,fn);this.state.requests[k]={hash,status:'done',result};await this.save();return result}catch(e){this.state.requests[k]={hash,status:e.code==='ack_unknown'?'unknown':'failed',error:e.code||'native_error'};await this.save();throw e}})();this.inflight.set(k,promise);try{return await promise}finally{this.inflight.delete(k)}}
  async mutate(w,key,p){return this.mutation(w,key,p,async()=>{
    if(p.op==='create'){const r=await this.rpc.request('thread/start',{cwd:workspace(w).root,model:'provider-default',serviceTier:'default',config:{model_reasoning_effort:'high'},developerInstructions:`本会话属于 ${w} 工作区，默认业务范围仅 ${workspace(w).root}。未获用户明确跨工作区授权时，不访问另一工作区的文件或插件。`});this.scopes.set(r.thread.id,w);this.loaded.add(r.thread.id);this.state.owners[r.thread.id]={workspace:w,createdHere:true,model:r.model,effort:r.reasoningEffort,serviceTier:r.serviceTier};await this.save();return {thread:this.summary(r.thread),effective:{model:r.model,reasoningEffort:r.reasoningEffort,serviceTier:r.serviceTier,approvalPolicy:r.approvalPolicy,sandbox:r.sandbox}}}
    const t=await this.metadata(w,p.threadId);
    if(p.op==='send'){
      if(this.active.has(t.id)||t.status?.type==='active')fail('thread_busy',409);
      // Never take control of another live Desktop/Remote executor. Existing foreign
      // threads remain readable; continuation is explicit and only for inactive history.
      if(!this.loaded.has(t.id)){if(!this.state.owners[t.id]&&!p.resumeConfirmed)fail('resume_confirmation_required',409);const r=await this.rpc.request('thread/resume',{threadId:t.id,excludeTurns:true});this.loaded.add(t.id);this.state.owners[t.id]||={workspace:w,createdHere:false,model:r.model,effort:r.reasoningEffort,serviceTier:r.serviceTier};await this.save()}
      const input=[];if(typeof p.text==='string'&&p.text.trim())input.push({type:'text',text:p.text.slice(0,100000)});
      for(const a of p.attachments||[]){if(a.workspace!==w)fail('attachment_workspace_mismatch');if(a.type==='image'&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(a.data)&&a.data.length<8e6)input.push({type:'image',url:a.data});else if(a.type==='text'&&typeof a.text==='string'&&a.text.length<200000)input.push({type:'text',text:`附件 ${String(a.name).slice(0,100)}:\n${a.text}`});else fail('unsupported_attachment')}
      if(!input.length)fail('empty_input');const r=await this.rpc.request('turn/start',{threadId:t.id,input,clientUserMessageId:key});this.active.set(t.id,r.turn.id);return {turn:r.turn};
    }
    if(p.op==='stop'){if(!this.loaded.has(t.id))fail('not_execution_owner',409);const id=this.active.get(t.id);if(!id)return {alreadyStopped:true};return this.rpc.request('turn/interrupt',{threadId:t.id,turnId:id})}
    if(p.op==='approve'){const a=this.approvals.get(p.approvalId);if(!a||a.workspace!==w||a.threadId!==t.id)fail('approval_expired',409);let result;
      if(a.method==='item/tool/requestUserInput'){const answers={};for(const q of a.params.questions){const answer=p.answers?.[q.id];if(!Array.isArray(answer)||!answer.every(s=>typeof s==='string')||!answer.length)fail('answer_required');answers[q.id]={answers:answer}}result={answers}}
      else if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(a.method)){if(!['accept','decline','cancel'].includes(p.decision))fail('invalid_decision');result={decision:p.decision}}
      else fail('unsupported_approval');this.approvals.delete(a.key);this.rpc.respond(a.rpcId,result);this.publish(w,'approval/resolved',{threadId:t.id,key:a.key});return {resolved:true}}
    fail('operation_not_allowed');
  })}
  async plugins(w,id){const conf=workspace(w);if(!id)return {plugins:conf.plugins};const plugin=conf.plugins.find(x=>x.id===id);if(!plugin)fail('plugin_not_found',404);if(id==='project'){const p='${BETTER_CODEX_WORKSPACE}/Assistance/automation/project-actions/registry/projects.json';const raw=JSON.parse(await readFile(p,'utf8'));const rows=raw.projects||[];return {...plugin,projects:rows.filter(x=>['active','sustaining','on_demand'].includes(x.lifecycle||x.status)).map(x=>({id:x.id,name:x.name,lifecycle:x.lifecycle||x.status})),asOf:new Date().toISOString(),readOnly:true}}
    return {...plugin,readOnly:true,mode:'existing-protected-app'};
  }
}

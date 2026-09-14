'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {createInterface} = require('node:readline');
const {randomUUID} = require('node:crypto');
const {createRequire} = require('node:module');
const roots = Object.freeze({
  ai:path.resolve(process.env.BETTER_CODEX_WORKSPACE || process.cwd()),
  secondary:path.resolve(process.env.BETTER_CODEX_SECONDARY_WORKSPACE || path.join(process.cwd(),'secondary'))
});
const READ_GLOBAL = new Set(['initialize','initialized','model/list','experimentalFeature/list','config/read','configRequirements/read','account/read','account/rateLimits/read','account/updated','mcpServerStatus/list','skills/list','app/list','plugin/list','plugin/marketplace/list','thread/list','thread/loaded/list','remoteControl/status/read','remoteControl/status','externalAgentConfig/detect']);
const THREAD_METHODS = new Set(['thread/read','thread/turns/list','thread/items/list','thread/resume','thread/name/set','thread/archive','thread/unarchive','thread/metadata/update','thread/compact/start','thread/backgroundTerminals/clean','thread/fork','thread/unsubscribe','turn/start','turn/interrupt','turn/steer']);
function denied(message='Request is outside this workspace'){return Object.assign(new Error(message),{code:-32003});}
function inside(candidate,root){if(typeof candidate!=='string'||!path.isAbsolute(candidate))return false;try{const a=fs.realpathSync(candidate),b=fs.realpathSync(root);return a===b||a.startsWith(b+path.sep);}catch{return false;}}
function threadIds(value){const result=new Set();function walk(v){if(!v||typeof v!=='object')return;for(const [k,x] of Object.entries(v)){if((k==='threadId'||k==='thread_id'||k==='conversationId')&&typeof x==='string')result.add(x);else if(k==='thread'&&x?.id)result.add(x.id);else if(x&&typeof x==='object')walk(x);}}walk(value);return [...result];}
class ScopedBridge {
 constructor({socket,workspace,WebSocket,output,onFatal=()=>{}}){if(!roots[workspace])throw denied('Unknown workspace');if(!path.isAbsolute(socket)||!fs.statSync(socket).isSocket())throw denied('Shared socket unavailable');this.root=roots[workspace];this.workspace=workspace;this.output=output;this.onFatal=onFatal;this.pending=new Map();this.internal=new Map();this.allowed=new Set();this.owned=new Set();this.ownershipPath=path.join(path.dirname(socket),`bridge-owned-${workspace}.jsonl`);this.approvals=new Map();this.epoch=randomUUID();this.seq=0;this.closed=false;this.chain=Promise.resolve();this.events=Promise.resolve();
  // Unix App Server 拒绝 ws 默认压缩扩展；不重连或重放不确定的写请求。
  this.ws=new WebSocket('ws://localhost/rpc',{createConnection:()=>net.connect(socket),perMessageDeflate:false,maxPayload:64*1024*1024});
  this.ready=new Promise((resolve,reject)=>{this.ws.once('open',resolve);this.ws.once('error',reject)});this.ready.catch(()=>{});
  this.ws.on('message',b=>{let m;try{m=JSON.parse(b.toString())}catch{return this.fatal('Invalid native frame')};this.receive(m).catch(()=>this.fatal('Native scope verification failed'))});this.ws.on('error',()=>this.fatal('Shared host transport failed'));this.ws.on('close',()=>this.fatal('Shared host disconnected'));
 }
 send(m){if(this.closed)throw denied('Shared host disconnected');this.ws.send(JSON.stringify(m));}
 emit(m){this.output(m);}
 fatal(reason){if(this.closed)return;this.closed=true;for(const [id] of this.pending)this.emit({id,error:{code:-32000,message:reason+'; outcome may be unknown; read state before retry'}});for(const p of this.internal.values()){clearTimeout(p.timer);p.reject(denied(reason))}this.pending.clear();this.internal.clear();this.ws.terminate();this.onFatal(reason);}
 close(){this.closed=true;for(const p of this.internal.values()){clearTimeout(p.timer);p.reject(denied('Bridge closed'))}this.internal.clear();this.ws.close();}
 rpc(method,params){const id=`bridge:${this.epoch}:${++this.seq}`;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.internal.delete(id);reject(denied('Scope lookup timed out'))},10000);this.internal.set(id,{resolve,reject,timer});this.send({id,method,params})});}
 owns(id){if(this.owned.has(id))return true;try{for(const line of fs.readFileSync(this.ownershipPath,"utf8").split("\n")){try{const row=JSON.parse(line);if(row.workspace===this.workspace)this.owned.add(row.id)}catch{}}}catch{}return this.owned.has(id);}
 async controls(id){
  // A trusted CLI connected to this exact host is an equal client, not an external
  // owner. Query live membership before attaching; never load an unknown thread
  // merely to manufacture that proof. Do not persist this generation-local grant.
  if(this.owns(id))return true;
  let cursor;const seen=new Set();
  for(let page=0;page<64;page++){
   const result=await this.rpc('thread/loaded/list',cursor?{cursor}:{});
   if((result.data||[]).includes(id))return true;
   cursor=result.nextCursor;if(!cursor)return false;
   if(seen.has(cursor))throw denied('Invalid loaded-thread pagination');seen.add(cursor);
  }
  throw denied('Cannot confirm execution host ownership');
 }
 remember(id){this.owned.add(id);fs.appendFileSync(this.ownershipPath,JSON.stringify({workspace:this.workspace,id})+"\n",{mode:0o600});}
 async check(id){if(typeof id!=='string')throw denied();if(this.allowed.has(id))return true;let r;try{r=await this.rpc('thread/read',{threadId:id,includeTurns:false})}catch(e){if(this.owns(id)){this.allowed.add(id);return true}throw e}if(!inside(r.thread?.cwd,this.root))throw denied();this.allowed.add(id);return true;}
 input(m){this.chain=this.chain.then(()=>this.forward(m)).catch(e=>{if(m.id!==undefined)this.emit({id:m.id,error:{code:e.code||-32003,message:e.code===-32003?e.message:'Workspace validation failed'}})});return this.chain;}
 async forward(m){await this.ready;if(!m||typeof m!=='object')throw denied('Invalid JSON-RPC');if(!m.method){if(!this.approvals.has(m.id))throw denied('Unknown or cross-workspace approval');this.approvals.delete(m.id);return this.send(m)}
  const p=m.params||{}, method=m.method;
  if(method==='thread/start'){if(p.cwd&&!inside(p.cwd,this.root))throw denied();m={...m,params:{...p,cwd:p.cwd||this.root,model:'provider-default',serviceTier:'default',config:{...(p.config||{}),model_reasoning_effort:'high'}}};}
  else if(THREAD_METHODS.has(method)){await this.check(p.threadId);if(p.cwd&&!inside(p.cwd,this.root))throw denied();
   // Unknown independent Desktop history stays read-only. Same-host native CLI
   // threads may attach without copying history or starting another executor.
   if(!['thread/read','thread/turns/list','thread/items/list','thread/unsubscribe'].includes(method)&&!await this.controls(p.threadId))throw denied('External thread is read-only; execution ownership is not granted');
   if(method==='turn/start')m={...m,params:{...p,model:'provider-default',effort:'high',serviceTier:'default'}};
  } else if(!READ_GLOBAL.has(method))throw denied('Unsupported unscoped method: '+method);
  // 所有嵌套线程 ID 和显式 cwd 都在转发前校验，不能利用批量参数绕过范围。
  for(const id of threadIds(p))await this.check(id);
  if(p.cwd&&!inside(p.cwd,this.root))throw denied();if(Array.isArray(p.cwds)&&p.cwds.some(x=>!inside(x,this.root)))throw denied();
  if(method==='skills/list'&&!p.cwds)m={...m,params:{...p,cwds:[this.root]}};
  if(m.id!==undefined){if(this.pending.has(m.id))throw denied('Duplicate in-flight request id');this.pending.set(m.id,{method,params:m.params||{}})}this.send(m);
 }
 async receive(m){const internal=this.internal.get(m.id);if(internal&&!m.method){clearTimeout(internal.timer);this.internal.delete(m.id);return m.error?internal.reject(denied()):internal.resolve(m.result)}
  if(m.method){this.events=this.events.then(async()=>{const ids=threadIds(m.params);if(m.params?.thread?.cwd){if(!inside(m.params.thread.cwd,this.root))return;this.allowed.add(m.params.thread.id)}
    // 无线程的普通账号状态可传递；审批仅转发本桥已拥有线程，并完整保留服务端 id。
    if(ids.length){for(const id of ids){try{await this.check(id)}catch{return}}}
    else if(!['account/updated','account/rateLimits/updated','model/rerouted','serverRequest/resolved'].includes(m.method))return;
    if(m.id!==undefined){if(!ids.length)return;for(const id of ids){if(!await this.controls(id))return}this.approvals.set(m.id,ids)}
    if(m.method==='serverRequest/resolved'){if(!this.approvals.has(m.params?.requestId))return;this.approvals.delete(m.params.requestId)}this.emit(m);
   }).catch(()=>{});return;}
  const request=this.pending.get(m.id);if(!request)return;this.pending.delete(m.id);if(m.error)return this.emit(m);let r=m.result;
  if(request.method==='thread/list'){const data=[];for(const t of r.data||[]){if(inside(t.cwd,this.root)){this.allowed.add(t.id);data.push(t)}}r={...r,data};}
  if(request.method==='thread/loaded/list'){const data=[];for(const id of r.data||[]){try{await this.check(id);data.push(id)}catch{}}r={...r,data};}
  if(r?.thread){if(!inside(r.thread.cwd,this.root))return this.emit({id:m.id,error:{code:-32003,message:'Native response outside workspace'}});this.allowed.add(r.thread.id);if(request.method==='thread/start'||request.method==='thread/fork')this.remember(r.thread.id);}
  this.emit({...m,result:r});
 }
}
module.exports={ScopedBridge,inside,threadIds};
if(require.main===module){
 const [socket,workspace,dependencies]=process.argv.slice(2);const WebSocket=createRequire(path.join(dependencies,'package.json'))('ws');
 const bridge=new ScopedBridge({socket,workspace,WebSocket,output:m=>process.stdout.write(JSON.stringify(m)+'\n'),onFatal:reason=>{process.stderr.write(reason+'\n');process.exitCode=1;process.stdin.destroy()}});
 const input=createInterface({input:process.stdin});input.on('line',line=>{if(Buffer.byteLength(line)>64*1024*1024)return bridge.fatal('Input too large');try{bridge.input(JSON.parse(line))}catch{bridge.fatal('Invalid NDJSON')}});input.on('close',()=>bridge.close());
 process.on('SIGTERM',()=>{bridge.close();input.close()});process.on('SIGINT',()=>{bridge.close();input.close()});
}

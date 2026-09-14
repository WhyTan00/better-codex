import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {SharedNative} from './shared-native.mjs';
import {OfficialBoundary} from './official-boundary.mjs';
import {NativeReadCache} from './native-read-cache.mjs';
import {SyncOutbox} from './sync-outbox.mjs';
import {Journal} from './journal.mjs';
import {CacheWorker} from './sync-cache-worker.mjs';
import {displayDetailPage} from './sync-projection.mjs';
import {SyncFeed} from './sync-feed.mjs';
import {workspace,validateId,fail} from './registry.mjs';
const require=createRequire('${BETTER_CODEX_HOME}/.better-codex/official-runtime-20260908/opencodex-pinned/package.json'),WS=require('ws');

export class SyncAdapter {
 constructor({url,key,native,boundary,journal,feed,statusFile}){Object.assign(this,{url,key,native,boundary,journal,feed,statusFile});this.buffer=feed.outbox?.entries()||[];this.bufferBytes=this.buffer.reduce((n,e)=>n+Buffer.byteLength(e.raw),0);this.closed=false;this.ready=false;this.ack=0;this.attempt=0;this.sentSequence=0;this.requests=new Map();this.controlQueue=[];this.dataQueue=[];this.queuedBytes=0;this.catalogVersions=new Map();
  feed.on('publish',frame=>{const raw=JSON.stringify(frame);this.buffer.push({seq:frame.seq,raw});this.bufferBytes+=Buffer.byteLength(raw);if(!this.feed.outbox)while(this.bufferBytes>8*1024*1024&&this.buffer.length){this.bufferBytes-=Buffer.byteLength(this.buffer.shift().raw);}this.flush();});
 }
 async status(state){if(!this.statusFile)return;this.statusWrite=(this.statusWrite||Promise.resolve()).catch(()=>{}).then(async()=>{const file=this.statusFile+'.next';await writeFile(file,JSON.stringify({at:new Date().toISOString(),state,native:this.native.state,epoch:this.feed.epoch,sequence:this.feed.sequence,ack:this.ack,pendingFrames:this.buffer.length})+'\n',{mode:0o600});await rename(file,this.statusFile);});await this.statusWrite.catch(()=>{});}
 start(){if(this.closed)return;this.controlQueue=[];this.dataQueue=[];this.queuedBytes=0;this.writing=false;const socket=new WS(this.url,{headers:{Authorization:'Bearer '+this.key},perMessageDeflate:false});this.socket=socket;this.ready=false;
  socket.on('message',raw=>{Promise.resolve().then(async()=>{const m=JSON.parse(raw);if(m.type==='hello'){if(m.protocol!==2){socket.close();return;}this.storeID=m.storeID;this.attempt=0;const first=this.buffer[0]?.seq??this.feed.sequence+1;if(m.adapterEpoch===this.feed.epoch&&Number.isSafeInteger(m.ack)&&m.ack>=first-1&&m.ack<=this.feed.sequence){this.feed.outbox?.acknowledge(m.ack);this.ack=m.ack;this.sentSequence=m.ack;this.ready=true;this.flush();this.feed.publish({event:{type:'host',online:this.native.state==='ready'}});}else this.reset();await this.status('connected');this.cacheWorker?.start();this.startNativeCacheSync();return;}
   if(m.type==='ack'){if(m.epoch!==this.feed.epoch||!Number.isSafeInteger(m.seq)||m.seq<this.ack||m.seq>this.feed.sequence)return;this.feed.outbox?.acknowledge(m.seq);this.ack=m.seq;while(this.buffer[0]?.seq<=this.ack){this.bufferBytes-=Buffer.byteLength(this.buffer.shift().raw);}this.flush();if(Date.now()-(this.lastStatusAt||0)>1000){this.lastStatusAt=Date.now();this.status('connected');}return;}
   if(m.type==='resync'){this.reset();return;}
   if(m.type==='request'){await this.handle(m);return;}
  }).catch(()=>this.send({type:'protocol-error'}));});
  socket.on('open',()=>this.status('transport_connected'));socket.on('error',()=>{});socket.on('close',()=>{if(this.socket!==socket)return;this.ready=false;this.status('disconnected');if(!this.closed){clearTimeout(this.reconnectTimer);this.reconnectTimer=setTimeout(()=>this.start(),Math.min(15000,500*2**Math.min(this.attempt++,5)));}});
 }
 reset(){this.ready=true;const base=this.feed.outbox?.ack??this.feed.sequence;this.ack=base;this.sentSequence=base;if(this.feed.outbox){this.buffer=this.feed.outbox.entries();this.bufferBytes=this.buffer.reduce((n,e)=>n+Buffer.byteLength(e.raw),0);}else{this.buffer=[];this.bufferBytes=0;}this.catalogVersions.clear();this.feed.snapshotVersions.clear();this.feed.pinVersions.clear();this.dataQueue=[];this.queuedBytes=this.controlQueue.reduce((n,s)=>n+Buffer.byteLength(s),0);this.send({type:'reset',epoch:this.feed.epoch,baseSeq:base});this.feed.nativeCache?.setMeta('cloud-record-cursor',0);this.feed.publish({event:{type:'host',online:this.native.state==='ready'}});for(const[id,scope]of this.feed.interests)this.feed.snapshot(scope,id).catch(()=>{});}
 startNativeCacheSync(){if(this.nativeCacheTimer||!this.feed.nativeCache)return;const sync=()=>{if(this.closed)return;try{if(this.ready&&this.bufferBytes<1024*1024){const cache=this.feed.nativeCache,page=cache.changes(Number(cache.meta('cloud-record-cursor')||0),50);for(const record of page.records){this.feed.publish({scope:record.scope,threadId:record.threadId||'',event:{type:'nativeRecord'},data:record});cache.setMeta('cloud-record-cursor',record.revision);}}}catch{}this.nativeCacheTimer=setTimeout(()=>{this.nativeCacheTimer=null;sync();},100);};sync();}

 send(value){return this.sendRaw(JSON.stringify(value));}
 sendRaw(raw,forceData=false){if(this.socket?.readyState!==WS.OPEN)return false;const bytes=Buffer.from(raw);if(bytes.length>64*1024*1024)throw fail(413,'历史分页超过传输容量');const control=!forceData&&bytes.length<=48*1024&&JSON.parse(raw).type!=='publish';const queue=control?this.controlQueue:this.dataQueue;if(bytes.length<=48*1024){queue.push(raw);this.queuedBytes+=bytes.length;}else{const messageId=randomUUID(),count=Math.ceil(bytes.length/(48*1024));for(let index=0;index<count;index++){const part=JSON.stringify({type:'chunk',messageId,index,count,payload:bytes.subarray(index*48*1024,(index+1)*48*1024).toString('base64')});queue.push(part);this.queuedBytes+=Buffer.byteLength(part);}}this.pump();return true;}
 pump(){if(this.writing||this.socket?.readyState!==WS.OPEN)return;const raw=this.controlQueue.shift()??this.dataQueue.shift();if(!raw)return;const socket=this.socket;this.queuedBytes-=Buffer.byteLength(raw);this.writing=true;socket.send(raw,()=>{if(this.socket!==socket)return;this.writing=false;setImmediate(()=>this.pump());});}
 flush(){if(!this.ready||this.socket?.readyState!==WS.OPEN)return;if(this.buffer[0]&&this.sentSequence+1<this.buffer[0].seq){this.reset();return;}for(const entry of this.buffer){if(entry.seq<=this.sentSequence)continue;if(this.socket.bufferedAmount+this.queuedBytes>1024*1024){clearTimeout(this.flushTimer);this.flushTimer=setTimeout(()=>this.flush(),50);return;}if(!this.sendRaw(entry.raw))return;this.sentSequence=entry.seq;}}
 async handle(m){if(typeof m.id!=='string'||m.id.length>100)return;let operation=this.requests.get(m.id);if(!operation){operation=this.execute(m.scope,m.op,m.body||{});this.requests.set(m.id,operation);operation.finally(()=>this.requests.delete(m.id)).catch(()=>{});}try{const result=await operation,read=!['command','request-status','approval-details'].includes(m.op),sequence=this.feed.sequence;if(read){const deadline=Date.now()+20000;while(this.sentSequence<sequence&&Date.now()<deadline&&this.socket?.readyState===WS.OPEN){this.flush();await new Promise(resolve=>setTimeout(resolve,20));}if(this.sentSequence<sequence)throw fail(503,'同步结果尚未送达');}this.sendRaw(JSON.stringify({type:'reply',id:m.id,result}),read);}catch(e){this.send({type:'reply',id:m.id,error:e.code?e.message:'请求未完成，请核对原生任务',status:typeof e.code==='number'?e.code:500});}}
 async execute(scope,op,b){workspace(scope);await this.native.start();
  if(op==='native-read'){const result=await this.feed.nativeCache.read(scope,b.method,b.params,{fresh:!!b.fresh});const record=this.feed.nativeCache.get(scope,result.key),sequence=this.feed.publish({scope,threadId:record.threadId,event:{type:'nativeRecord'},data:record});const deadline=Date.now()+20000;while(this.ack<sequence){if(Date.now()>deadline||!this.ready)throw fail(503,'读取结果尚未提交');await new Promise(r=>setTimeout(r,25));}return record;}
  if(op==='native-catalog'){await this.feed.nativeCache.catalog(scope,{fresh:!!b.fresh});return { ...this.feed.nativeCache.changes(Number(b.after)||0,200,scope,'catalog'),status:this.feed.nativeCache.get(scope,'catalog-status')};}
  if(op==='catalog'){if(this.cacheWorker&&!this.cacheWorker.scopes.includes(scope)){this.cacheWorker.scopes.push(scope);this.cacheWorker.start();}const result=await this.feed.catalog(scope,b.cursor||null,typeof b.search==='string'?b.search.slice(0,160):'');if(!b.cursor&&!b.search){const version=JSON.stringify(result);if(this.catalogVersions.get(scope)!==version){this.catalogVersions.set(scope,version);this.feed.publish({scope,threadId:'',event:{type:'catalog'},data:result});}}return result;}
  if(op==='watch'||op==='snapshot'){validateId(b.threadId);if(op==='watch')return this.feed.watch(scope,b.threadId);return this.feed.snapshot(scope,b.threadId,b.cursor||null);}
  if(op==='request-status'){validateId(b.requestId);const r=this.journal.get(scope,b.requestId);return r?{requestId:b.requestId,state:r.state,result:r.result}:{state:'not_found'};}
  if(op==='approval-details'){validateId(b.threadId);await this.boundary.checked(workspace(scope),b.threadId);const a=this.boundary.approvals.get(String(b.approvalId));if(!a||a.params?.threadId!==b.threadId)throw fail(409,'请求已处理或过期');const p=a.params;return {method:a.method,command:p.command,cwd:p.cwd,reason:p.reason,grantRoot:p.grantRoot,changes:p.changes,availableDecisions:p.availableDecisions};}
  if(op==='details'){validateId(b.threadId);validateId(b.turnId);const page=await this.boundary.call(scope,{method:'thread/items/list',params:{threadId:b.threadId,turnId:b.turnId,cursor:b.cursor||null,sortDirection:'desc',limit:30}});return displayDetailPage(page);}
  if(op!=='command')throw fail(400,'不支持的同步请求');validateId(b.requestId);
  if(!['new','send','stop','approval','pin'].includes(b.op))throw fail(400,'不支持的操作');
  if(b.op!=='new'){validateId(b.threadId);await this.boundary.checked(workspace(scope),b.threadId);}
  // Durable command identity is independent of the transport request id.
  // Reconnection asks for this result instead of issuing the command again.
  return this.journal.run(scope,b.requestId,b,async()=>{try{
   const clientId='sync-pwa',request={id:randomUUID(),method:'thread/start',params:{cwd:workspace(scope).root}};
   if(b.op==='new')return this.boundary.call(scope,request,{clientId});
   if(b.op==='pin'){if(typeof b.pinned!=='boolean')throw fail(400,'请指定置顶状态');await this.boundary.call(scope,{id:b.requestId,method:'thread/section/move',params:{threadId:b.threadId,sectionId:b.pinned?'01984de2-8f74-7c91-a3b2-5c5e937cf318':null,beforeThreadId:null}},{clientId});const pins=await this.feed.pins(scope);return {threadId:b.threadId,pinned:b.pinned,pinnedIds:pins.ids};}
   if(b.op==='send'){
    if(typeof b.text!=='string'||!b.text.trim()||b.text.length>60000)throw fail(400,'请输入消息，最多60000字符');
    if((await this.boundary.loadedIds()).has(b.threadId))await this.feed.ensureAttached(scope,b.threadId);else await this.boundary.call(scope,{id:randomUUID(),method:'thread/resume',params:{threadId:b.threadId,excludeTurns:true}},{clientId});this.feed.attachments.add(b.threadId);this.feed.interests.set(b.threadId,scope);
    return this.boundary.call(scope,{id:b.requestId,method:'turn/start',params:{threadId:b.threadId,clientUserMessageId:b.requestId,input:[{type:'text',text:b.text}]}},{clientId});
   }
   if(b.op==='stop'){validateId(b.turnId);return this.boundary.call(scope,{id:b.requestId,method:'turn/interrupt',params:{threadId:b.threadId,turnId:b.turnId}},{clientId});}
   const a=this.boundary.approvals.get(String(b.approvalId));if(!a||a.params?.threadId!==b.threadId)throw fail(409,'请求已处理或过期');let result;
   if(a.method==='item/tool/requestUserInput'){const answers={};for(const q of a.params.questions||[]){const v=b.answers?.[q.id];if(typeof v!=='string'||v.length>4000)throw fail(400,'请完整回答问题');answers[q.id]={answers:[v]};}result={answers};}
   else if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(a.method)){if(!['accept','decline','cancel'].includes(b.decision)||a.params.availableDecisions&&!a.params.availableDecisions.includes(b.decision))throw fail(400,'该决定不可用');result={decision:b.decision};}
   else throw fail(403,'请在原生应用中处理这个请求');return this.boundary.answer(scope,{id:a.id,result});
  }catch(e){if(e.code===409&&e.message==='发送结果待核对；不会重复执行')throw Object.assign(e,{code:503});throw e;}});
 }
 async close(){this.closed=true;this.cacheWorker?.close();clearTimeout(this.reconnectTimer);clearTimeout(this.flushTimer);clearTimeout(this.nativeCacheTimer);this.feed.close();this.socket?.close();this.native.close();this.journal.close();await this.status('stopped');this.feed.nativeCache?.close();}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 const config=JSON.parse(await readFile(process.env.BETTER_CODEX_SYNC_CONFIG||'${BETTER_CODEX_HOME}/.codex/betterCodex-sync/config.json','utf8'));const url=new URL(config.url);if(url.protocol!=='wss:'&&!(url.protocol==='ws:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw Error('TLS or loopback required');
 await mkdir(config.stateDir,{recursive:true,mode:0o700});const key=(await readFile(config.keyFile,'utf8')).trim();if(key.length<32)throw Error('Bridge credential unavailable');
 const native=new SharedNative({name:'betterCodex_persistent_sync',reconnect:true}),journal=new Journal(config.commandJournalDir||config.stateDir),boundary=new OfficialBoundary({native,journal}),nativeCache=new NativeReadCache(config.nativeCacheDir||path.join(config.stateDir,'native-cache'),{boundary}),outbox=new SyncOutbox(nativeCache),feed=new SyncFeed({native,boundary,nativeCache,outbox}),adapter=new SyncAdapter({url:url.href,key,native,boundary,journal,feed,statusFile:path.join(config.stateDir,'status.json')});
 adapter.cacheWorker=new CacheWorker({adapter,stateFile:path.join(config.stateDir,'cache-progress.json'),scopes:config.prefetchScopes||['ai']});await native.start();adapter.start();for(const scope of config.prefetchScopes||['ai'])nativeCache.catalog(scope,{fresh:true}).catch(()=>{});for(const sig of ['SIGTERM','SIGINT'])process.once(sig,async()=>{await adapter.close();process.exit(0);});
}

import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {ConnectionDiagnostics,errorDiagnosticFields} from './connection-diagnostics.mjs';
import {SharedNative} from './shared-native.mjs';
import {OfficialBoundary} from './official-boundary.mjs';
import {Journal} from './journal.mjs';
import {CacheWorker} from './sync-cache-worker.mjs';
import {CacheService} from './cache-service.mjs';
import {displayDetailPage} from './sync-projection.mjs';
import {SyncFeed} from './sync-feed.mjs';
import {sourceReadResult,MAX_SOURCE_READ_BYTES,MAX_SOURCE_TRANSFER_BYTES,readAbort,checkReadInterest,withReadInterest} from './native-read-delivery.mjs';
import {workspace,validateId,fail,SCOPES} from './registry.mjs';
import {WebSocket as WS} from './runtime-dependencies.mjs';
import {portableConfig,runtimeProfile} from './runtime-profile.mjs';
// Match the gateway's existing 45s transport liveness window.
export const BRIDGE_TRANSPORT_TIMEOUT_MS=45000;

export class SyncAdapter {
 constructor({url,key,native,boundary,journal,feed,statusFile,WebSocket=WS}){Object.assign(this,{url,key,native,boundary,journal,feed,statusFile,WebSocket});this.buffer=feed.outbox?.entries()||[];this.bufferBytes=this.buffer.reduce((n,e)=>n+Buffer.byteLength(e.raw),0);this.closed=false;this.ready=false;this.ack=feed.outbox?.ack||0;this.attempt=0;this.sentSequence=0;this.requests=new Map();this.controlQueue=[];this.readQueue=[];this.readQueuedBytes=0;this.dataQueue=[];this.queuedBytes=0;this.catalogVersions=new Map();this.connectionLog=new ConnectionDiagnostics({file:statusFile?path.join(path.dirname(statusFile),'connections.jsonl'):null,maxBytes:16*1024*1024,maxArchives:31});this.connectionLog.event({component:'cloud-bridge',stage:'boot',processId:process.pid});native.on('connection-diagnostic',entry=>this.connectionLog.event(entry));
  if(feed.nativeCache)feed.nativeCache.onSlowTransaction=fields=>this.connectionLog.event({component:'cloud-bridge',stage:'committed',readPhase:'local_commit',...fields});
  feed.on('deferred',({reason})=>{this.projectionPaused=true;if(Date.now()-(this.lastPressureLog||0)>5000){this.lastPressureLog=Date.now();const s=feed.outbox.stats();this.connectionLog.event({component:'cloud-bridge',stage:'pending',reason:'backpressure',failureClass:reason==='storage'?'storage':undefined,pendingFrames:s.frames,outboxBytes:s.bytes,oldestAgeMs:s.oldestAgeMs,freeBytes:s.freeBytes});}});
  feed.on('publish',frame=>{if(this.feed.outbox){this.flush();return;}const raw=JSON.stringify(frame);this.buffer.push({seq:frame.seq,raw});this.bufferBytes+=Buffer.byteLength(raw);if(!this.feed.outbox)while(this.bufferBytes>8*1024*1024&&this.buffer.length){this.bufferBytes-=Buffer.byteLength(this.buffer.shift().raw);}this.flush();});
 }
 async status(state){if(this.lastLoggedState!==state){this.lastLoggedState=state;this.connectionLog.event({component:'cloud-bridge',stage:state==='connected'?'ready':state==='disconnected'?'closed':'open',state,connectionId:this.connectionId,nativeReady:this.native.state==='ready',sequence:this.feed.sequence,ack:this.ack,pendingFrames:this.feed.outbox?this.feed.sequence-this.ack:this.buffer.length});}if(!this.statusFile)return;this.statusWrite=(this.statusWrite||Promise.resolve()).catch(()=>{}).then(async()=>{const file=this.statusFile+'.next';await writeFile(file,JSON.stringify({at:new Date().toISOString(),state,native:this.native.state,epoch:this.feed.epoch,sequence:this.feed.sequence,ack:this.ack,cloudCache:{mode:this.cachePersistence||'unknown',persistent:this.cachePersistence==='disk',commandAuthority:'mac-native'},pendingFrames:this.feed.outbox?this.feed.sequence-this.ack:this.buffer.length,...(this.feed.outbox?{outbox:this.feed.outbox.stats()}: {})})+'\n',{mode:0o600});await rename(file,this.statusFile);});await this.statusWrite.catch(()=>{});}
 observeCacheState(m){
  const changed=typeof m.storeID==='string'&&this.storeID&&this.storeID!==m.storeID;
  if(typeof m.storeID==='string')this.storeID=m.storeID;
  this.cachePersistence=['disk','memory'].includes(m.cachePersistence)?m.cachePersistence:'disk';
  if(changed){this.feed.nativeCache?.setMeta('cloud-record-cursor',0);this.cacheWorker?.start();this.connectionLog.event({component:'cloud-bridge',stage:'received',reason:'cloud_cache_rebuild',cachePersistence:this.cachePersistence,commandAuthority:'mac-native'});}
 }
 start(){if(this.closed||this.socket&&this.socket.readyState!==WS.CLOSED)return;clearTimeout(this.reconnectTimer);this.reconnectTimer=undefined;for(const read of [...this.readQueue])read.finish(readAbort());this.controlQueue=[];this.readQueue=[];this.readQueuedBytes=0;this.dataQueue=[];this.queuedBytes=0;this.writing=false;this.writeStartedAt=0;const connectionId=this.connectionId=randomUUID(),startedAt=Date.now(),monotonicStart=performance.now();let lastMessageAt=0,lastPongAt=0,openedAt=0,lastTickAt=Date.now(),maxTimerLagMs=0,transportPhase='connecting';const phase=next=>{transportPhase=next;this.connectionLog.event({component:'cloud-bridge',stage:'dispatch',connectionId,transportPhase,durationMs:Date.now()-startedAt,monotonicMs:Math.round(performance.now()-monotonicStart),timerLagMs:maxTimerLagMs});};this.connectionLog.event({component:'cloud-bridge',stage:'attempt',connectionId,attempt:this.attempt});const socket=new this.WebSocket(this.url,{handshakeTimeout:BRIDGE_TRANSPORT_TIMEOUT_MS,headers:{Authorization:'Bearer '+this.key,'X-DSH-Diagnostic-ID':connectionId},perMessageDeflate:false,finishRequest:request=>{request.on('socket',wire=>{phase('dns');wire.once('lookup',error=>phase(error?'dns':'tcp'));wire.once('connect',()=>phase(this.url.startsWith('wss:')?'tls':'http_upgrade'));wire.once('secureConnect',()=>phase('http_upgrade'));});request.end();}});this.socket=socket;this.ready=false;
  clearInterval(this.transportTimer);this.transportTimer=setInterval(()=>{if(this.socket!==socket||this.closed)return;const now=Date.now();maxTimerLagMs=Math.max(maxTimerLagMs,Math.max(0,now-lastTickAt-5000));lastTickAt=now;
   const connecting=socket.readyState===WS.CONNECTING&&now-startedAt>=BRIDGE_TRANSPORT_TIMEOUT_MS,lastInbound=Math.max(openedAt,lastMessageAt,lastPongAt),stalled=this.writeStartedAt&&now-this.writeStartedAt>=BRIDGE_TRANSPORT_TIMEOUT_MS;
   if(connecting||socket.readyState===WS.OPEN&&openedAt&&((!this.ready&&now-openedAt>=BRIDGE_TRANSPORT_TIMEOUT_MS)||now-lastInbound>=BRIDGE_TRANSPORT_TIMEOUT_MS||stalled)){this.connectionLog.event({component:'cloud-bridge',stage:'failed',connectionId,reason:connecting?'connect_deadline':stalled?'write_failed':'ping_failed',failureClass:'timeout',transportPhase,durationMs:now-startedAt,monotonicMs:Math.round(performance.now()-monotonicStart),timerLagMs:maxTimerLagMs,handshakeComplete:this.ready,bufferedBytes:this.queuedBytes+socket.bufferedAmount});socket.terminate();}},5000);this.transportTimer.unref?.();
  socket.on('message',raw=>{lastMessageAt=Date.now();Promise.resolve().then(async()=>{if(this.closed||this.socket!==socket)return;const m=JSON.parse(raw);if(m.type==='hello'){if(m.protocol!==2){socket.close();return;}this.observeCacheState(m);this.supportsProjectionRecovery=m.projectionRecoveryVersion===1;this.attempt=0;phase('ready');const first=this.buffer[0]?.seq??this.feed.sequence+1;if(m.adapterEpoch===this.feed.epoch&&Number.isSafeInteger(m.ack)&&m.ack>=first-1&&m.ack<=this.feed.sequence){this.feed.outbox?.acknowledge(m.ack);this.ack=m.ack;this.sentSequence=m.ack;this.ready=true;this.flush();this.feed.publish({event:{type:'host',online:this.native.state==='ready'}});}else this.reset();await this.status('connected');this.cacheWorker?.start();this.startNativeCacheSync();return;}
   if(m.type==='ack'){if(m.epoch!==this.feed.epoch||!Number.isSafeInteger(m.seq)||m.seq<this.ack||m.seq>this.feed.sequence)return;this.observeCacheState(m);this.feed.outbox?.acknowledge(m.seq);this.ack=m.seq;while(this.buffer[0]?.seq<=this.ack){this.bufferBytes-=Buffer.byteLength(this.buffer.shift().raw);}this.flush();if(this.nativeCachePump&&!this.nativeCacheSyncing){clearTimeout(this.nativeCacheTimer);this.nativeCacheTimer=null;this.nativeCachePump();}if(this.projectionPaused&&!this.feed.outbox?.pressure()){this.projectionPaused=false;this.feed.publish({event:{type:'host',online:this.native.state==='ready'}});this.cacheWorker?.start();}if(Date.now()-(this.lastStatusAt||0)>1000){this.lastStatusAt=Date.now();this.status('connected');}return;}
   if(m.type==='resync'){this.reset();return;}
   if(m.type==='cancel-read'){this.cancelRead(m,socket);return;}
   if(m.type==='request'){await this.handle(m,socket);return;}
  }).catch(()=>{if(this.closed||this.socket!==socket)return;this.connectionLog.event({component:'cloud-bridge',stage:'failed',connectionId,reason:'protocol_error'});this.send({type:'protocol-error'});});});
  socket.on('pong',()=>{lastPongAt=Date.now();});socket.on('ping',()=>{lastPongAt=Date.now();});
  socket.on('open',()=>{if(this.socket!==socket)return;openedAt=Date.now();phase('hello');this.status('transport_connected');});socket.on('error',error=>{const handshakeTimeout=error?.message==='Opening handshake has timed out';this.connectionLog.event({component:'cloud-bridge',stage:'failed',connectionId,reason:'socket_error',transportPhase,monotonicMs:Math.round(performance.now()-monotonicStart),timerLagMs:maxTimerLagMs,...errorDiagnosticFields(error),...(handshakeTimeout?{errorCode:'ETIMEDOUT',failureClass:'timeout'}:{}),handshakeComplete:this.ready,durationMs:Date.now()-startedAt});});socket.on('close',(code)=>{if(this.socket!==socket)return;clearInterval(this.transportTimer);for(const entry of this.requests.values())if(entry.socket===socket)entry.controller?.abort(readAbort());this.writeStartedAt=0;this.connectionLog.event({component:'cloud-bridge',stage:'closed',connectionId,reason:'socket_closed',transportPhase,monotonicMs:Math.round(performance.now()-monotonicStart),timerLagMs:maxTimerLagMs,closeCode:code,handshakeComplete:this.ready,durationMs:Date.now()-startedAt,lastMessageAgeMs:lastMessageAt?Date.now()-lastMessageAt:Date.now()-startedAt,lastPongAgeMs:lastPongAt?Date.now()-lastPongAt:Date.now()-startedAt,bufferedBytes:this.queuedBytes+socket.bufferedAmount,pendingFrames:this.feed.outbox?this.feed.sequence-this.ack:this.buffer.length,sequence:this.feed.sequence,ack:this.ack});this.ready=false;this.status('disconnected');if(!this.closed){clearTimeout(this.reconnectTimer);const delay=Math.min(15000,500*2**Math.min(this.attempt++,5));this.connectionLog.event({component:'cloud-bridge',stage:'reconnecting',connectionId,retryDelayMs:delay,attempt:this.attempt});this.reconnectTimer=setTimeout(()=>this.start(),delay);}});
 }
 reset(){this.ready=true;const base=this.feed.outbox?.ack??this.feed.sequence;this.ack=base;this.sentSequence=base;if(this.feed.outbox){this.buffer=this.feed.outbox.entries();this.bufferBytes=this.buffer.reduce((n,e)=>n+Buffer.byteLength(e.raw),0);}else{this.buffer=[];this.bufferBytes=0;}this.catalogVersions.clear();this.feed.snapshotVersions.clear();this.feed.pinVersions.clear();this.dataQueue=[];this.queuedBytes=this.controlQueue.reduce((n,s)=>n+Buffer.byteLength(s),0)+this.readQueue.reduce((n,r)=>n+r.bytes.length-r.offset,0);this.send({type:'reset',epoch:this.feed.epoch,baseSeq:base});this.feed.nativeCache?.setMeta('cloud-record-cursor',0);this.feed.publish({event:{type:'host',online:this.native.state==='ready'}});for(const[id,scope]of this.feed.interests)this.feed.snapshot(scope,id).catch(()=>{});}
 startNativeCacheSync(){
  if(!this.feed.nativeCache)return;if(this.nativeCachePump){clearTimeout(this.nativeCacheTimer);this.nativeCacheTimer=null;this.nativeCachePump();return;}
  const cache=this.feed.nativeCache;
  const arm=delay=>{clearTimeout(this.nativeCacheTimer);if(!this.closed)this.nativeCacheTimer=setTimeout(()=>{this.nativeCacheTimer=null;this.nativeCachePump();},delay);};
  this.nativeCachePump=async()=>{if(this.closed||this.nativeCacheSyncing)return;this.nativeCacheSyncing=true;this.nativeCacheDirty=false;let more=false;
   try{if(this.ready&&!this.feed.outbox?.pressure()&&!this.hasUnloadedFrames&&this.bufferBytes<1024*1024){const after=Number(cache.meta('cloud-record-cursor')||0),page=cache.syncChanges?await cache.syncChanges(after,50,{metadataOnly:this.cachePersistence==='memory'}):await cache.changes(after,50);if(!this.closed){if(page.records.length)this.feed.publishBatch(page.records.map(record=>({scope:record.scope,threadId:record.threadId||'',event:{type:'nativeRecord'},data:record})),()=>cache.setMeta('cloud-record-cursor',page.cursor));else if(page.cursor!==after)cache.setMeta('cloud-record-cursor',page.cursor);more=page.hasMore||page.records.length===50;}}}catch{more=false;}finally{this.nativeCacheSyncing=false;arm(more||this.nativeCacheDirty?100:120000);}
  };
  cache.onRecordsChanged=()=>{this.nativeCacheDirty=true;if(!this.nativeCacheSyncing)arm(0);};this.nativeCachePump();
 }


 send(value){return this.sendRaw(JSON.stringify(value));}
 sendRaw(raw,forceData=false,sourceRead=false){if(this.socket?.readyState!==WS.OPEN)return false;const bytes=Buffer.from(raw);if(bytes.length>64*1024*1024)throw fail(413,'历史分页超过传输容量');const control=!forceData&&(bytes.length<=48*1024||sourceRead&&bytes.length<=MAX_SOURCE_READ_BYTES+256)&&JSON.parse(raw).type!=='publish';const queue=control?this.controlQueue:this.dataQueue;if(bytes.length<=48*1024){queue.push(raw);this.queuedBytes+=bytes.length;}else{const messageId=randomUUID(),count=Math.ceil(bytes.length/(48*1024));for(let index=0;index<count;index++){const part=JSON.stringify({type:'chunk',messageId,index,count,payload:bytes.subarray(index*48*1024,(index+1)*48*1024).toString('base64')});queue.push(part);this.queuedBytes+=Buffer.byteLength(part);}}this.pump();return true;}
 sendSourceRead(raw,m,entry){
  checkReadInterest(entry.controller?.signal);
  if(entry.socket!==this.socket||this.socket?.readyState!==WS.OPEN)throw readAbort();
  const bytes=Buffer.from(raw);
  if(bytes.length>MAX_SOURCE_TRANSFER_BYTES)throw fail(413,'历史分页超过传输容量');
  // Bound live foreground buffers independently of the durable outbox. Chunks
  // are encoded lazily; up to 128 read waiters cannot retain 128 large copies.
  if(this.readQueuedBytes+bytes.length>MAX_SOURCE_TRANSFER_BYTES)throw fail(503,'读取请求较多');
  return new Promise((resolve,reject)=>{
   const signal=entry.controller?.signal;
   const read={bytes,offset:0,index:0,count:Math.ceil(bytes.length/(48*1024)),messageId:randomUUID(),id:m.id,scope:m.scope,socket:entry.socket,settled:false};
   read.finish=(error,notify=true)=>{
    if(read.settled)return;read.settled=true;signal?.removeEventListener('abort',aborted);
    const index=this.readQueue.indexOf(read);if(index>=0)this.readQueue.splice(index,1);
    this.queuedBytes-=bytes.length-read.offset;this.readQueuedBytes-=bytes.length;
    // A scoped cancel frees any half-assembled read on the negotiated v2
    // gateway. It never advances publication ACKs or cancels a command.
    if(error&&notify&&read.index&&read.count>1&&this.socket===read.socket&&read.socket.readyState===WS.OPEN)this.send({type:'cancel-read-chunks',messageId:read.messageId,readId:read.id,scope:read.scope});
    if(error)reject(error);else resolve();
    setImmediate(()=>this.pump());
   };
   const aborted=()=>read.finish(signal.reason||readAbort());
   this.readQueue.push(read);this.readQueuedBytes+=bytes.length;this.queuedBytes+=bytes.length;
   signal?.addEventListener('abort',aborted,{once:true});
   if(signal?.aborted)aborted();else this.pump();
  });
 }
 pump(){
  if(this.writing||this.socket?.readyState!==WS.OPEN)return;
  let raw=this.controlQueue.shift(),read,done=false,bytes;
  if(raw!=null)bytes=Buffer.byteLength(raw);
  else if(this.readQueue.length){
   read=this.readQueue[0];const end=Math.min(read.offset+48*1024,read.bytes.length);
   bytes=end-read.offset;
   raw=read.count===1?read.bytes.toString():JSON.stringify({type:'chunk',messageId:read.messageId,readId:read.id,scope:read.scope,index:read.index,count:read.count,payload:read.bytes.subarray(read.offset,end).toString('base64')});
   read.offset=end;read.index++;done=end===read.bytes.length;
  }else{raw=this.dataQueue.shift();if(raw==null)return;bytes=Buffer.byteLength(raw);}
  const socket=this.socket;this.queuedBytes-=bytes;this.writing=true;this.writeStartedAt=Date.now();
  socket.send(raw,error=>{
   if(this.socket!==socket)return;this.writing=false;this.writeStartedAt=0;
   if(error){read?.finish(readAbort(),false);this.connectionLog.event({component:'cloud-bridge',stage:'failed',connectionId:this.connectionId,reason:'write_failed',...errorDiagnosticFields(error)});socket.terminate();return;}
   if(done)read.finish();setImmediate(()=>this.pump());
  });
 }
 get hasUnloadedFrames(){return !!this.feed?.outbox&&(this.buffer.at(-1)?.seq??this.ack)<this.feed.sequence;}
 refillWindow(){if(!this.feed?.outbox)return;while(this.buffer[0]?.seq<=this.ack){this.bufferBytes-=Buffer.byteLength(this.buffer.shift().raw);}if(!this.buffer.length){this.buffer=this.feed.outbox.entries({after:this.ack});this.bufferBytes=this.buffer.reduce((n,e)=>n+e.bytes,0);}}
 flush(){if(!this.ready||this.socket?.readyState!==WS.OPEN)return;this.refillWindow();if(this.buffer[0]&&this.sentSequence+1<this.buffer[0].seq){this.reset();return;}let inFlightFrames=0,inFlightBytes=0;for(const entry of this.buffer){if(entry.seq<=this.ack)continue;const bytes=Buffer.byteLength(entry.raw);if(entry.seq<=this.sentSequence){inFlightFrames++;inFlightBytes+=bytes;continue;}if(inFlightFrames>=128||(inFlightFrames>0&&inFlightBytes+bytes>8*1024*1024))return;if(this.socket.bufferedAmount+this.queuedBytes>1024*1024){clearTimeout(this.flushTimer);this.flushTimer=setTimeout(()=>this.flush(),50);return;}if(!this.sendRaw(entry.raw))return;this.sentSequence=entry.seq;inFlightFrames++;inFlightBytes+=bytes;}}
 readTrace(m){
  if(m.op!=='native-read'||!['ai','zyy'].includes(m.scope))return null;
  const started=Date.now(),context={scope:m.scope,method:m.body?.method,threadId:m.body?.params?.threadId,turnId:m.body?.params?.turnId,traceId:m.traceId,readIdHash:createHash('sha256').update(m.id).digest('hex').slice(0,16)};
  const trace=(readPhase,stage,fields={})=>{trace.phase=readPhase;this.connectionLog.event({component:'cloud-bridge',routeClass:'native_read',...context,connectionId:this.connectionId,readPhase,stage,durationMs:Date.now()-started,sequence:this.feed.sequence,ack:this.ack,sentSequence:this.sentSequence,pendingFrames:this.feed.outbox?this.feed.sequence-this.ack:this.buffer.length,bufferedBytes:this.queuedBytes+(this.socket?.bufferedAmount||0),...fields});};
  return trace;
 }
 cancelRead(m,socket=this.socket){const entry=this.requests.get(m.id);if(entry?.controller&&entry.socket===socket&&entry.scope===m.scope)entry.controller.abort(readAbort(m.reason));}
 async handle(m,socket=this.socket){
  if(typeof m.id!=='string'||m.id.length>100)return;
  const trace=this.readTrace(m);let entry=this.requests.get(m.id);
  if(entry)return; // A bridge request ID is a single waiter, not a retry command.
  this.cacheWorker?.touch?.(m.scope,m.body?.params?.threadId||m.body?.threadId);
  if(m.op==='native-read'&&this.requests.size>=128){this.send({type:'reply',id:m.id,status:503,error:'读取请求较多'});return;}
  const controller=m.op==='native-read'?new AbortController():null;
  const budget=Number.isFinite(m.readDeadlineMs)?Math.max(0,Math.min(25000,m.readDeadlineMs)):25000;
  const timer=controller?setTimeout(()=>controller.abort(readAbort('deadline')),budget):null;timer?.unref?.();
  entry={controller,socket,scope:m.scope};this.requests.set(m.id,entry);
  if(controller&&budget===0)controller.abort(readAbort('deadline'));
  try{
   const result=await this.execute(m.scope,m.op,m.body||{},trace,controller?.signal),read=!['command','request-status','approval-details'].includes(m.op),sequence=this.feed.sequence;
   checkReadInterest(controller?.signal);if(socket!==this.socket)return;
   // native-read has already waited for its own durable ACK. Its compact
   // receipt must not wait for unrelated later publications or retransmit the
   // entire history page. The gateway still validates and reads its durable DTO.
   if(m.op==='native-read'){
    if(result.readDelivery){
     trace?.('source_reply','received',{recordRevision:result.revision,responseBytes:Buffer.byteLength(JSON.stringify(result)),sourceVerified:true,projectionCommitted:false});
     const raw=JSON.stringify({type:'reply',id:m.id,result});
     if(result.readDelivery.version>=2)await this.sendSourceRead(raw,m,entry);
     else this.sendRaw(raw,false,true);
     return;
    }
    const receipt={scope:result.scope,key:result.key,revision:result.revision,sourceGeneration:result.sourceGeneration,generation:result.generation};
    trace?.('reply_queue','dispatch',{recordRevision:result.revision,responseBytes:Buffer.byteLength(JSON.stringify(receipt))});
    this.send({type:'reply',id:m.id,result:receipt});return;
   }
   if(read&&!['native-catalog','native-bootstrap','native-cursors'].includes(m.op)){const deadline=Date.now()+20000;while(!this.closed&&socket===this.socket&&this.sentSequence<sequence&&Date.now()<deadline&&socket.readyState===WS.OPEN){this.flush();await new Promise(resolve=>setTimeout(resolve,20));}if(this.closed||socket!==this.socket)return;if(this.sentSequence<sequence)throw fail(503,'同步结果尚未送达');}
   this.sendRaw(JSON.stringify({type:'reply',id:m.id,result}),read);
  }catch(e){trace?.(trace.phase||'cache_read','failed',{...errorDiagnosticFields(e),...(e.failureClass?{failureClass:e.failureClass}:{})});if(!controller?.signal.aborted&&socket===this.socket)this.send({type:'reply',id:m.id,error:e.code?e.message:'请求未完成，请核对原生任务',status:typeof e.code==='number'?e.code:500,...(trace?{failureStage:trace.phase}: {})});}
  finally{clearTimeout(timer);if(this.requests.get(m.id)===entry)this.requests.delete(m.id);}
 }
 async execute(scope,op,b,trace,signal){workspace(scope);checkReadInterest(signal);trace?.('native_connect','dispatch');await withReadInterest(this.native.start(),signal);checkReadInterest(signal);
  if(op==='native-read'){
   trace?.('cache_read','dispatch');const record=await withReadInterest(this.feed.nativeCache.read(scope,b.method,b.params,{fresh:!!b.fresh,onReadStage:trace,signal,sourceReadVersion:b.sourceReadVersion}),signal);checkReadInterest(signal);
   trace?.('cache_read','received',{recordRevision:record.revision,responseBytes:record.bytes});
   const immediate=sourceReadResult(scope,b,record);
   // The cache's existing changes cursor owns asynchronous replication. Do not
   // duplicate this record in the global outbox or claim a durable cloud ACK.
   if(immediate)return immediate;
   // This version was supplied by the authenticated gateway from its durable
   // row, not by the HTTP caller. Native was still freshly read above. An
   // unchanged immutable record already has a cloud commit; publishing it
   // again would make a small validation wait behind every unrelated frame.
   const known=b.knownRecord;
   if(known&&typeof known.sourceGeneration==='string'&&known.sourceGeneration&&typeof known.generation==='string'&&known.generation&&known.sourceGeneration===record.sourceGeneration&&known.generation===record.generation&&Number.isSafeInteger(known.revision)&&known.revision===record.revision){trace?.('cloud_reuse','committed',{recordRevision:record.revision,cacheHit:true});return record;}
   this.readPublications??=new Map();const publicationKey=JSON.stringify([scope,record.key,record.sourceGeneration,record.generation,record.revision]);
   for(const[key,seq]of this.readPublications)if(seq<=this.ack)this.readPublications.delete(key);
   let sequence=this.readPublications.get(publicationKey);
   if(sequence==null){sequence=this.feed.publish({scope,threadId:record.threadId,event:{type:'nativeRecord'},data:record});if(!Number.isSafeInteger(sequence)||sequence<1)throw fail(503,'同步积压，读取尚未提交');this.readPublications.set(publicationKey,sequence);while(this.readPublications.size>128)this.readPublications.delete(this.readPublications.keys().next().value);}
   const started=Date.now(),deadline=started+20000;
   trace?.('publish_ack','pending',{targetSequence:sequence});
   while(this.ack<sequence){checkReadInterest(signal);if(Date.now()>deadline||!this.ready)throw fail(503,'读取结果尚未提交');await withReadInterest(new Promise(r=>setTimeout(r,25)),signal);}
   trace?.('publish_ack','committed',{targetSequence:sequence,durationMs:Date.now()-started});return record;
  }
  if(op==='native-catalog'){const cache=this.feed.nativeCache;if(cache.snapshotCatalog)return cache.snapshotCatalog(scope,{fresh:!!b.fresh,after:Number(b.after)||0,generation:b.generation});await cache.catalog(scope,{fresh:!!b.fresh});const after=b.generation&&b.generation!==cache.generation?0:Number(b.after)||0;return {...await cache.changes(after,200,scope,'catalog'),status:await cache.get(scope,'catalog-status')};}
  if(op==='native-bootstrap')return this.feed.nativeCache.get(scope,'bootstrap');
  if(op==='native-cursors'){validateId(b.threadId);await this.boundary.checked(workspace(scope),b.threadId);let cursors=(await this.feed.nativeCache.get(scope,'history-cursors:'+b.threadId))?.payload??null;if(!cursors&&this.feed.nativeCache.readSource){const r=await this.feed.nativeCache.readSource(scope,'thread/read',{threadId:b.threadId,includeTurns:true},{fresh:true,signal}),v=r.payload.result;if(typeof v.itemsBackwardsCursor==='string')cursors={itemsBackwardsCursor:v.itemsBackwardsCursor,turnsBackwardsCursor:v.turnsBackwardsCursor??null};}return {scope,threadId:b.threadId,cursors};}
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
 async close(){this.closed=true;clearInterval(this.transportTimer);this.cacheWorker?.close();clearTimeout(this.reconnectTimer);clearTimeout(this.flushTimer);clearTimeout(this.nativeCacheTimer);await this.feed.close();this.socket?.close();this.native.close();this.journal.close();await this.status('stopped');await this.connectionLog.close();await this.feed.nativeCache?.close();}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 const config=portableConfig?{url:'ws://127.0.0.1:'+portableConfig.relayPort+'/_sync-agent',stateDir:path.join(portableConfig.stateDir,'observer'),keyFile:path.join(portableConfig.stateDir,'bridge.key'),commandJournalDir:path.join(portableConfig.stateDir,'commands'),nativeCacheDir:path.join(portableConfig.stateDir,'native-cache'),prefetchScopes:SCOPES}:JSON.parse(await readFile(process.env.DSH_SYNC_CONFIG||runtimeProfile.syncConfig,'utf8'));const url=new URL(config.url);if(url.protocol!=='wss:'&&!(url.protocol==='ws:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw Error('TLS or loopback required');
 await mkdir(config.stateDir,{recursive:true,mode:0o700});const key=(await readFile(config.keyFile,'utf8')).trim();if(key.length<32)throw Error('Bridge credential unavailable');
 const native=new SharedNative({name:'dsh_persistent_sync',reconnect:true}),journal=new Journal(config.commandJournalDir||config.stateDir),boundary=new OfficialBoundary({native,journal}),nativeCache=await CacheService.create({dir:config.nativeCacheDir||path.join(config.stateDir,'native-cache'),boundary}),outbox=nativeCache.outbox,feed=new SyncFeed({native,boundary,nativeCache,outbox}),adapter=new SyncAdapter({url:url.href,key,native,boundary,journal,feed,statusFile:path.join(config.stateDir,'status.json')});
 adapter.cacheWorker=new CacheWorker({adapter,stateFile:path.join(config.stateDir,'cache-progress.json'),scopes:config.prefetchScopes||['ai']});await native.start();adapter.start();for(const scope of config.prefetchScopes||['ai'])nativeCache.catalog(scope,{fresh:true}).catch(()=>{});for(const sig of ['SIGTERM','SIGINT'])process.once(sig,async()=>{await adapter.close();process.exit(0);});
}

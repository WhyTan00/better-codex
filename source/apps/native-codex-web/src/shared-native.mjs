// 官方 WebSocket/Unix 协议客户端；生命周期与浏览器页面无关，不自动重放写请求。
import {EventEmitter} from 'node:events';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {errorDiagnosticFields,rpcDiagnosticContext} from './connection-diagnostics.mjs';
import {WebSocket} from './runtime-dependencies.mjs';
import {runtimeProfile} from './runtime-profile.mjs';
export class SharedNative extends EventEmitter {
 constructor({url=runtimeProfile.nativeUrl,name='dsh_official_scoped_gateway',reconnect=false,preserveProcessIdentity=true}={}){super();this.isShared=true;this.url=url;this.name=name;this.preserveProcessIdentity=preserveProcessIdentity!==false;this.pending=new Map();this.nextId=0;this.state='disconnected';this.reconnect=reconnect;this.generation=0;this.reconnectAttempt=0;this.closed=false;}
 diagnostic(stage,fields={}){try{this.emit('connection-diagnostic',{component:'native',stage,connectionId:this.connectionId,generation:this.generation,state:this.state,pendingRequests:this.pending.size,...fields});}catch{}}
 async start(){
  if(this.closed)throw Object.assign(new Error('原生连接已关闭'),{code:503});
  if(this.state==='ready')return this;
  if(this.starting)return this.starting;
  this.starting=this.connect().finally(()=>{this.starting=null;});return this.starting;
 }
 async connect(){
  this.state='connecting';this.connectionId=randomUUID();this.diagnostic('attempt',{attempt:this.reconnectAttempt});
  const unix=this.url.startsWith('unix://');
  this.socket=new WebSocket(unix?'ws://localhost/rpc':this.url,{perMessageDeflate:false,handshakeTimeout:30000,...(unix?{createConnection:()=>net.createConnection(this.url.slice(7))}:{})});
  const socket=this.socket,connectionId=this.connectionId,startedAt=Date.now();let lastMessageAt=0;
  socket.on('message',raw=>{if(this.socket!==socket)return;lastMessageAt=Date.now();let m;try{m=JSON.parse(raw);}catch{return socket.close(1002,'invalid JSON');}
   if(m.method){this.emit(m.id===undefined?'notification':'request',m);return;}
   const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);
   const context={...p.context,connectionId,method:p.method,durationMs:Date.now()-p.startedAt};
   if(m.error){const error=Object.assign(new Error(m.error.message),{code:502,rpcCode:m.error.code});this.diagnostic('failed',{...context,reason:'rpc_error',...errorDiagnosticFields(error)});p.reject(error);}
   else{this.diagnostic('received',context);p.resolve(m.result);}
  });
  socket.on('close',(code)=>{if(this.socket!==socket)return;this.diagnostic('closed',{connectionId,closeCode:code,reason:'socket_closed',durationMs:Date.now()-startedAt,lastMessageAgeMs:lastMessageAt?Date.now()-lastMessageAt:Date.now()-startedAt,socketState:socket.readyState,handshakeComplete:this.state==='ready'});this.release(socket);});
  socket.on('error',error=>this.diagnostic('failed',{connectionId,reason:'socket_error',errorCode:error?.code||'unknown'}));
  try{
   await new Promise((resolve,reject)=>{
    const finish=error=>{socket.off('open',opened);socket.off('error',failed);socket.off('close',closed);error?reject(error):resolve();};
    const opened=()=>finish(),failed=error=>finish(error),closed=()=>finish(Object.assign(new Error('原生握手已中断'),{code:503}));
    socket.once('open',opened);socket.once('error',failed);socket.once('close',closed);
   });
   this.diagnostic('open',{connectionId,durationMs:Date.now()-startedAt});
   // Native initialize mutates process-global UA metadata for ordinary client names.
   // Observers use its reserved non-originating identity; only the explicit front owner opts out.
   const initialization=await this.rpc('initialize',{clientInfo:{name:this.preserveProcessIdentity?'codex_app_server_daemon':this.name,version:'1.0.0'},capabilities:{experimentalApi:true}});
   if(this.closed||this.socket!==socket||socket.readyState!==WebSocket.OPEN)throw Object.assign(new Error('原生连接已被替换'),{code:503});
   this.send({method:'initialized',params:{}});this.initialization=initialization;this.state='ready';this.reconnectAttempt=0;this.generation++;this.diagnostic('ready',{connectionId,durationMs:Date.now()-startedAt});this.emit('ready',{generation:this.generation});return this;
  }catch(error){
   // A rejected initialize is a failed connection, even while its socket is OPEN.
   // Detach ownership before terminating: a late close must not clear a replacement.
   this.release(socket);socket.terminate();throw error;
  }
 }
 release(socket){if(this.socket!==socket)return;this.socket=null;this.state='disconnected';for(const p of this.pending.values()){clearTimeout(p.timer);const error=Object.assign(new Error('宿主连接中断，写入结果待核对'),{code:503});this.diagnostic('failed',{...p.context,connectionId:this.connectionId,method:p.method,reason:'native_disconnected',failureClass:'connection',durationMs:Date.now()-p.startedAt});p.reject(error);}this.pending.clear();this.emit('interrupted');this.scheduleReconnect();}
 scheduleReconnect(){if(!this.reconnect||this.closed||this.reconnectTimer)return;const delay=Math.min(5000,500*2**Math.min(this.reconnectAttempt++,4));this.diagnostic('reconnecting',{retryDelayMs:delay,attempt:this.reconnectAttempt});this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;this.start().catch(()=>this.scheduleReconnect());},delay);this.reconnectTimer.unref?.();}
 send(message){if(this.socket?.readyState!==WebSocket.OPEN)throw Object.assign(new Error('原生宿主未连接'),{code:503});if(this.socket.bufferedAmount>1024*1024)throw Object.assign(new Error('原生发送队列已满'),{code:503});this.socket.send(JSON.stringify(message));}
 rpc(method,params={},diagnostic={}){
  const id=++this.nextId,source=diagnostic?.params||diagnostic||{};
  const context=rpcDiagnosticContext({id:diagnostic?.id??id,method,params:source,scope:diagnostic?.scope,connectionId:diagnostic?.connectionId,pageId:diagnostic?.pageId});
  if(/^[a-f0-9]{16}$/.test(diagnostic?.rpcIdHash||''))context.rpcIdHash=diagnostic.rpcIdHash;
  const startedAt=Date.now(),connectionId=this.connectionId;
  this.diagnostic('dispatch',{...context,connectionId,method});
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{const pending=this.pending.get(id);if(!pending)return;this.pending.delete(id);const durationMs=Date.now()-pending.startedAt;this.diagnostic('pending',{...pending.context,connectionId,method,reason:'rpc_timeout',durationMs,timedOut:true,failureClass:'timeout'});this.diagnostic('failed',{...pending.context,connectionId,method,reason:'rpc_timeout',durationMs,timedOut:true,failureClass:'timeout'});reject(Object.assign(new Error('确认未收到；不会自动重发'),{code:504}));},30000);
   this.pending.set(id,{resolve,reject,timer,method,context,startedAt});
   try{this.send({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);this.diagnostic('failed',{...context,connectionId,method,reason:'rpc_send_failed',durationMs:Date.now()-startedAt,...errorDiagnosticFields(error)});reject(error);}
  });
 }
 close(){this.closed=true;clearTimeout(this.reconnectTimer);this.reconnectTimer=null;const socket=this.socket;if(socket){this.release(socket);socket.terminate();}}
}

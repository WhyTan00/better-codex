// 官方 WebSocket/Unix 协议客户端；生命周期与浏览器页面无关，不自动重放写请求。
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import net from 'node:net';
const require=createRequire(process.env.BETTER_CODEX_OPENCODEX_PACKAGE||'${BETTER_CODEX_HOME}/.better-codex/official-runtime-20260908/opencodex-pinned/package.json');
const WebSocket=require('ws');
export class SharedNative extends EventEmitter {
 constructor({url='ws://127.0.0.1:3083',name='betterCodex_official_scoped_gateway',reconnect=false}={}){super();this.isShared=true;this.url=url;this.name=name;this.pending=new Map();this.nextId=0;this.state='disconnected';this.reconnect=reconnect;this.generation=0;this.reconnectAttempt=0;this.closed=false;}
 async start(){
  if(this.closed)throw Object.assign(new Error('原生连接已关闭'),{code:503});
  if(this.state==='ready')return this;
  if(this.starting)return this.starting;
  this.starting=this.connect().finally(()=>{this.starting=null;});return this.starting;
 }
 async connect(){
  this.state='connecting';
  const unix=this.url.startsWith('unix://');
  this.socket=new WebSocket(unix?'ws://localhost/rpc':this.url,{perMessageDeflate:false,...(unix?{createConnection:()=>net.createConnection(this.url.slice(7))}:{})});
  const socket=this.socket;
  socket.on('message',raw=>{if(this.socket!==socket)return;let m;try{m=JSON.parse(raw);}catch{return socket.close(1002,'invalid JSON');}
   if(m.method){this.emit(m.id===undefined?'notification':'request',m);return;}
   const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);
   m.error?p.reject(Object.assign(new Error(m.error.message),{code:502,rpcCode:m.error.code})):p.resolve(m.result);
  });
  socket.on('close',()=>{if(this.socket!==socket)return;this.state='disconnected';for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Object.assign(new Error('宿主连接中断，写入结果待核对'),{code:503}));}this.pending.clear();this.emit('interrupted');this.scheduleReconnect();});
  socket.on('error',()=>{});
  await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  this.initialization=await this.rpc('initialize',{clientInfo:{name:this.name,version:'1.0.0'},capabilities:{experimentalApi:true}});
  this.send({method:'initialized',params:{}});this.state='ready';this.reconnectAttempt=0;this.generation++;this.emit('ready',{generation:this.generation});return this;
 }
 scheduleReconnect(){if(!this.reconnect||this.closed||this.reconnectTimer)return;this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;this.start().catch(()=>this.scheduleReconnect());},Math.min(5000,500*2**Math.min(this.reconnectAttempt++,4)));this.reconnectTimer.unref?.();}
 send(message){if(this.socket?.readyState!==WebSocket.OPEN)throw Object.assign(new Error('原生宿主未连接'),{code:503});if(this.socket.bufferedAmount>1024*1024)throw Object.assign(new Error('原生发送队列已满'),{code:503});this.socket.send(JSON.stringify(message));}
 rpc(method,params={}){const id=++this.nextId;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Object.assign(new Error('确认未收到；不会自动重发'),{code:504}));},30000);this.pending.set(id,{resolve,reject,timer});try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});}
 close(){this.closed=true;clearTimeout(this.reconnectTimer);this.reconnectTimer=null;this.socket?.close();}
}

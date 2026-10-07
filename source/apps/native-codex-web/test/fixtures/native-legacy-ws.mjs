import net from 'node:net';
import {spawnIsolatedNative} from './isolated-native-process.mjs';
import os from 'node:os';
import {nativeLegacyFixture,binary} from './native-legacy.mjs';

// Two independent clients of one temporary, credential-free Native process.
export async function nativeLegacyWebSocketFixture(t){
 const cleanup=[],x=await nativeLegacyFixture({after:f=>cleanup.push(f)});await x.close();
 const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const isolated=spawnIsolatedNative(binary,['app-server','--listen','ws://127.0.0.1:'+port],{cwd:x.dir,env:{PATH:'/opt/homebrew/bin:/usr/bin:/bin',TMPDIR:os.tmpdir(),CODEX_HOME:x.dir},stdio:['ignore','pipe','pipe']}),child=isolated.child;child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
 const clients=[];
 t.after(async()=>{
  for(const c of clients)c.close();
  await isolated.close();
  for(const f of cleanup)await f();
 });
 async function connect(name){
  let socket;
  for(let attempt=0;attempt<100;attempt++){
   socket=new WebSocket('ws://127.0.0.1:'+port);
   const ok=await new Promise(resolve=>{socket.addEventListener('open',()=>resolve(true),{once:true});socket.addEventListener('error',()=>resolve(false),{once:true});});
   if(ok)break;await new Promise(r=>setTimeout(r,20));
  }
  if(socket.readyState!==WebSocket.OPEN)throw Error('Isolated Native WebSocket did not open');
  const waiting=new Map();let sequence=0;
  socket.addEventListener('message',event=>{
   const reply=JSON.parse(event.data),pending=waiting.get(reply.id);if(!pending)return;
   waiting.delete(reply.id);clearTimeout(pending.timer);
   if(reply.error)pending.reject(Object.assign(Error(reply.error.message),{rpcCode:reply.error.code}));else pending.resolve(reply.result);
  });
  const rpc=(method,params={})=>{x.calls.push({client:name,method,params:structuredClone(params)});return new Promise((resolve,reject)=>{
   const id=++sequence,timer=setTimeout(()=>{waiting.delete(id);reject(Error('Isolated Native RPC deadline: '+method));},10000);waiting.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
  });};
  const initialization=await rpc('initialize',{clientInfo:{name:'fixture_'+name,version:'1.0.0'},capabilities:{experimentalApi:true}});socket.send(JSON.stringify({method:'initialized',params:{}}));
  const close=()=>{for(const p of waiting.values()){clearTimeout(p.timer);p.reject(Error('Isolated Native connection closed'));}waiting.clear();socket.close();};
  const client={rpc,initialization,close};clients.push(client);return client;
 }
 return {...x,native:await connect('web'),peer:await connect('desktop')};
}

// Read-only desktop metadata through the existing OpenCodex IPC bridge.
// No token/auth-file access, model calls, host restarts, or arbitrary IPC forwarding.
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
const require=createRequire('${BETTER_CODEX_HOME}/.better-codex/official-runtime-20260908/opencodex-pinned/package.json'),WS=require('ws');
const ALLOWED=new Set(['account-info','os-info','list-pinned-threads','codex-command-keymap-state']);
export class OfficialDesktopMetadata{
 constructor(upstream){this.upstream=upstream;this.cache=new Map();this.pending=new Map();}
 async read(name){
  if(!ALLOWED.has(name))throw Error('Metadata method is not allowlisted');
  const cached=this.cache.get(name);if(cached&&Date.now()-cached.at<60000)return cached.value;
  if(this.pending.has(name))return this.pending.get(name);
  const work=this.fetch(name).then(value=>{this.cache.set(name,{at:Date.now(),value});return value;}).finally(()=>this.pending.delete(name));this.pending.set(name,work);return work;
 }
 fetch(name){return new Promise((resolve,reject)=>{
  const ws=new WS(this.upstream.replace(/^http/,'ws')+'/ws',{perMessageDeflate:false}),clientId=randomUUID(),requestId=randomUUID();let finished=false;
  const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);ws.close();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>finish(Error('Desktop metadata unavailable')),10000);
  ws.on('error',()=>finish(Error('Desktop metadata connection unavailable')));ws.on('close',()=>{if(!finished)finish(Error('Desktop metadata disconnected'));});
  ws.on('open',()=>ws.send(JSON.stringify({type:'hello',clientId})));
  ws.on('message',raw=>{let m;try{m=JSON.parse(raw)}catch{return}if(m.type==='hello-ack')ws.send(JSON.stringify({type:'opencodex:ipc-invoke',clientId,requestId:randomUUID(),request:{channel:'codex_desktop:message-from-view',args:[{type:'fetch',requestId,url:'vscode://codex/'+name,method:'POST',body:'{}'}]}}));
   const p=m.payload;if(p?.type==='fetch-response'&&p.requestId===requestId){if(p.responseType==='error')return finish(Error('Desktop metadata request unavailable'));try{const raw=JSON.parse(p.bodyJsonString),keys={'account-info':['accountId','userId','plan','email','computeResidency','hasChatGptToken'],'os-info':['platform','osVersion','osRelease','isSystemBackdropSupported','isVsCodeRunningInsideWsl','windowsAccountType'],'list-pinned-threads':['threadIds'],'codex-command-keymap-state':['keymap','bindings','version']}[name];const value=Object.fromEntries(keys.filter(k=>Object.hasOwn(raw,k)).map(k=>[k,raw[k]]));finish(null,value);}catch{finish(Error('Invalid metadata response'));}}
  });
 });}
}

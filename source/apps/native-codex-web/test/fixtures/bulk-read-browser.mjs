import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

const modulePath=process.env.DSH_BULK_SCOPE_SOURCE||new URL('../../public/official-scope-bootstrap.js',import.meta.url);
const moduleSource=await readFile(modulePath,'utf8');
let source=moduleSource;
if(process.env.DSH_BULK_SCOPE){
 const bundle=await readFile(process.env.DSH_BULK_SCOPE,'utf8'),index=bundle.indexOf(moduleSource.trim());
 assert(index>=0,'the final scope must contain the exact tested transport source');
 source=bundle.slice(index,index+moduleSource.trim().length);
}
export const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
export function browser(fetchImpl,{origin='https://fixture.invalid',scopeToken='fixture-scope',now=null}={}){
 class Storage{constructor(){this.values=new Map();}getItem(k){return this.values.get(k)||null;}setItem(k,v){this.values.set(k,v);}removeItem(k){this.values.delete(k);}clear(){this.values.clear();}}
 const listeners=new Map(),timers=new Map(),sockets=[],requests=[];let timer=0;
 const clock={now};class ClockDate extends Date{constructor(...args){super(...(args.length?args:[clock.now]));}static now(){return clock.now;}}
 const add=(type,fn)=>{if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);};
 const dispatch=event=>{for(const fn of listeners.get(event.type)||[])fn(event);};
 class Socket{
  constructor(url){this.url=url;this.readyState=1;this.bufferedAmount=0;this.listeners=new Map();this.sent=[];sockets.push(this);}
  addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
  send(raw){this.sent.push(JSON.parse(raw));}
  emit(type,data={}){const event={...data,stopped:false,stopImmediatePropagation(){this.stopped=true;}};for(const fn of this.listeners.get(type)||[]){fn(event);if(event.stopped)break;}}
  close(code=1000){this.readyState=3;this.emit('close',{code,wasClean:code===1000});}
 }
 const location={origin,href:origin+'/',pathname:'/',search:'',replace(){throw Error('unexpected navigation');}};
 const context={Storage,localStorage:new Storage(),sessionStorage:new Storage(),URL,Headers,Request,AbortController,Event,MessageEvent,CustomEvent,Date:Number.isFinite(now)?ClockDate:Date,performance,location,crypto:{randomUUID},navigator:{onLine:true},document:{visibilityState:'visible',addEventListener:add},addEventListener:add,setTimeout(fn,ms){const id=++timer;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}};
 context.window={__DSH_SCOPE__:{id:'ai',token:scopeToken},WebSocket:Socket,fetch:async(url,init)=>{requests.push({url:String(url),init});return fetchImpl(url,init);},dispatchEvent:dispatch};
 vm.runInNewContext(source,context);
 const create=(diagnosticId)=>{const wire=new context.window.WebSocket(origin.replace(/^http/,'ws')+'/w/ai/ws');if(diagnosticId)wire.__dshDiagnosticId=diagnosticId;wire.send(JSON.stringify({type:'hello',clientId:'fixture-page'}));return wire;};
 const message=(wire,value)=>wire.emit('message',{data:JSON.stringify(value)});
 const hello=(wire,{protocol='dsh-bulk-read-v1',epoch='fixture-epoch',generation=1,resumed=false,resumeId='fixture-resume',nativeReady=true}={})=>{message(wire,{type:'hello-ack',clientId:'fixture-page',dshProtocol:'dsh-page-resume-v1',dshResumeId:resumeId,dshResumed:resumed,dshReceivedSeq:0,dshBulkReadProtocol:protocol,dshEpoch:epoch,dshNativeGeneration:generation});if(nativeReady)message(wire,{dshEpoch:epoch,payload:{type:'codex-app-server-connection-changed',hostId:'local',state:'connected',dshNativeGeneration:generation}});};
 return {window:context.window,context,create,message,hello,dispatch,requests,sockets,timers,clock};
}
export function reply(url,init,{status=200,etag='"'+'a'.repeat(64)+'"',result={data:[],nextCursor:null},error,headers:overrides={},body}={}){
 const id=new URL(url).searchParams.get('requestId'),epoch=init.headers['x-dsh-front-epoch'],nativeGeneration=Number(init.headers['x-dsh-native-generation']);
 const headers=new Headers({'x-dsh-read-id':id,'x-dsh-front-epoch':epoch,'x-dsh-native-generation':String(nativeGeneration),...(etag?{etag}:{}),...overrides});
 return {status,ok:status>=200&&status<300,headers,json:body||(async()=>({requestId:id,epoch,nativeGeneration,status:200,...(error?{error}:{result})}))};
}

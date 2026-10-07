import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {createOfficialFront} from '../src/official-front.mjs';
const require=createRequire(process.env.DSH_TEST_HOST_PACKAGE||new URL('../../../../packages/host-cli/package.json',import.meta.url)),WS=require('ws');
const ai='11111111-1111-4111-a111-111111111111',zyy='22222222-2222-4222-a222-222222222222';
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-front-recovery-'));
 const runtime=await readFile(process.env.DSH_TEST_BRIDGE_POLYFILL,'utf8');
 const upstream=http.createServer((req,res)=>{if(req.url==='/opencodex-runtime-bootstrap.js'){res.setHeader('content-type','text/javascript');res.end(runtime);}else if(req.url.endsWith('.css')){res.setHeader('content-type','text/css');res.end('/* auxiliary style fixture */');}else if(req.url==='/codex-web-config.js'){res.setHeader('content-type','text/javascript');res.end('window.__CODEX_WEB_CONFIG__={persistedAtomSnapshot:{}};');}else{res.setHeader('content-type','text/html');res.end('<html><head><meta name="theme-color" content="#ffffff"><meta name="color-scheme" content="light"><link rel="preload" as="script" href="/codex-web-config.js"><script src="/codex-web-config.js"></script><script type="module" src="/official-patched-v8/assets/index-7064d932a767.js"></script></head><body><div id="root"></div></body></html>');}});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const native=new EventEmitter();native.state='ready';native.start=async()=>{};native.close=()=>{};
 native.rpc=async(method,p)=>method==='config/read'?{config:{sandbox_mode:'danger-full-access',approval_policy:'never'}}:method==='thread/start'?{thread:{id:ai,cwd:'/workspace/example',status:{type:'idle'}}}:method==='thread/loaded/list'?{data:[ai,zyy]}:method==='thread/read'?{thread:{id:p.threadId,cwd:p.threadId===ai?'/workspace/example':'/workspace/secondary',status:{type:'active',activeFlags:[]}}}:{};
 const front=await createOfficialFront({port:0,native,stateDir:dir,upstream:'http://127.0.0.1:'+upstream.address().port});await new Promise(r=>front.server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+front.server.address().port,headers={origin:base},clients=[];
 t.after(async()=>{for(const ws of clients)ws.close();await front.close();await new Promise(r=>upstream.close(r));await rm(dir,{recursive:true,force:true});});
 const session=async scope=>(await fetch(base+'/dsh-scope-session?workspace='+scope,{headers})).json();
 async function client(scope){const binding=await session(scope),ws=new WS(base.replace('http','ws')+'/w/'+scope+'/ws?scopeToken='+binding.token,{headers,perMessageDeflate:false}),events=[];clients.push(ws);ws.on('message',b=>events.push(JSON.parse(b)));await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});ws.send(JSON.stringify({type:'hello',clientId:'test-'+clients.length}));return {ws,events,send:p=>ws.send(JSON.stringify({type:'opencodex:ipc-invoke',requestId:String(Math.random()),request:{channel:'codex_desktop:message-from-view',args:[p]}}))};}
 const until=async(fn)=>{const end=Date.now()+2000;while(Date.now()<end){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,5));}throw Error('Expected frame missing');};
 return {front,native,base,headers,session,client,until};
}
test('optional prewarm creates no Native thread and a subsequent actual create still succeeds',async t=>{
 const x=await fixture(t),c=await x.client('ai'),calls=[],rpc=x.native.rpc;x.native.rpc=async(...args)=>{calls.push(args[0]);return rpc(...args);};
 for(let i=0;i<3;i++){c.send({type:'thread-prewarm-start',hostId:'local',request:{id:'prewarm-'+i,method:'thread/start',params:{cwd:'/workspace/example'}}});const r=await x.until(()=>c.events.find(e=>e.payload?.type==='mcp-response'&&e.payload.message?.id==='prewarm-'+i));assert.equal(r.payload.message.error.data.status,409);}
 assert(!calls.includes('thread/start'));assert.equal(x.front.journal.ownsThread('ai',ai),false);
 c.send({type:'mcp-request',hostId:'local',request:{id:'actual-first-send',method:'thread/start',params:{cwd:'/workspace/example'}}});
 const r=await x.until(()=>c.events.find(e=>e.payload?.type==='mcp-response'&&e.payload.message?.id==='actual-first-send'));assert.equal(r.payload.message.result.thread.id,ai);assert.equal(calls.filter(m=>m==='thread/start').length,1);assert.equal(x.front.journal.ownsThread('ai',ai),true);
});

test('actual renderer prewarm rejection becomes a normal empty prewarm and never waits for execution',async()=>{
 const initial=await readFile(process.env.DSH_PREWARM_INITIAL||new URL('../../../runtime/critical-path-isolation-20261005/pass10/candidate/pwa/native-assets/v1163/app-initial-cadb12d4a15e.js',import.meta.url),'utf8');
 const cache=await readFile(process.env.DSH_PREWARM_CACHE||new URL('../public/native-local-cache.js',import.meta.url),'utf8');
 const start=cache.indexOf(' window.__DSH_IPC_CACHE__=');assert(start>=0);const end=cache.indexOf('\n };',start);assert(end>start);
 const ctx={window:{__DSH_EXECUTION_CONNECTED__:false},responses:[]};vm.createContext(ctx);vm.runInContext(cache.slice(start,end+5),ctx);
 const a=initial.indexOf('prewarmConversation(e,t){'),b=initial.indexOf('async createConversation(',a);assert(a>=0&&b>a);
 const warnings=[],inputs={start:{request:{cwd:'/workspace/example'}},permissionsConfig:{},instructionOverrides:{}};let preparedPromise;
 Object.assign(ctx,{Zx:30000,hS:class extends Error{},Sdn:class{async preparePrewarm(){return inputs;}}});
 vm.runInContext('globalThis.ActualPrewarm=class{constructor(params){this.params=params;}getRequestedThreadHistoryMode(){return "paginated";}'+initial.slice(a,b)+'}',ctx);
 const params={logger:{warning:()=>warnings.push(1)},requestClient:{async prewarmThreadStart(request){let message;const receipt=await ctx.window.__DSH_IPC_CACHE__('codex_desktop:message-from-view',{type:'thread-prewarm-start',hostId:'local',request:{id:'speculative',method:'thread/start',params:request}},(_type,value)=>{message=value.message;});assert.equal(receipt.handled,true);assert.equal(message.error.data.notSubmitted,true);throw Object.assign(Error(message.error.message),message.error);}},prewarmedThreadManager:{hasPrewarmedThread:()=>false,setPrewarmedThreadPromise(_cwd,_roots,_service,_history,promise){preparedPromise=promise;}}};
 const actual=new ctx.ActualPrewarm(params);assert.equal(await actual.prewarmConversation({cwd:'/workspace/example'},async()=>({})),null);assert.equal(await preparedPromise,null);assert.equal(warnings.length,1);
});

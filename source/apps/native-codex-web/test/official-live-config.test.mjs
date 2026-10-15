import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {createAppHostFactory} from '../src/official-app-host.mjs';
import {appHostProtocol} from '../src/runtime-dependencies.mjs';
const {RpcSession,RpcTarget}=await appHostProtocol();

function pair(){const sides=[{queue:[],waiters:[]},{queue:[],waiters:[]}];return sides.map((side,i)=>({send:async value=>{const other=sides[1-i];if(other.waiters.length)other.waiters.shift()(value);else other.queue.push(value);},receive:()=>side.queue.length?Promise.resolve(side.queue.shift()):new Promise(resolve=>side.waiters.push(resolve)),abort(){}}));}
async function service(t){
 const make=createAppHostFactory({RpcTarget,boundary:{},state:async()=>({atoms:{},globals:{}}),persist:async()=>{},native:{},clients:new Set(),settings:{forScope:()=>({close(){}})}}),[one,two]=pair();
 const server=new RpcSession(one,make('ai',{scope:'ai',pageId:'fixture'})),browser=new RpcSession(two,{});
 t.after(()=>{server.getRemoteMain()[Symbol.dispose]();browser.getRemoteMain()[Symbol.dispose]();});
 return (await browser.getRemoteMain().services).httpFetch;
}
const url='https://ab.chatgpt.com/v1/initialize';
test('real AppHost Request/Response transport distinguishes bootstrap and encoded live checks',async t=>{
 const http=await service(t),body=JSON.stringify({responseMode:'live_overlay',user:{private:'fixture-do-not-log'}});
 for(const [query,bytes] of [['',body],['?se=1',Buffer.from(body).toString('base64').split('').reverse().join('')],['?se=1&gz=1',gzipSync(Buffer.from(body).toString('base64').split('').reverse().join(''))]]){
  const result=await http.fetch('fixture',new Request(url+query,{method:'POST',body:bytes}));
  assert.equal(result.response.status,204);assert.equal(await result.response.text(),'');
 }
 const init=await http.fetch('fixture',new Request(url,{method:'POST',body:JSON.stringify({user:{private:'fixture'}})}));
 assert.equal(init.response.status,200);const flags=await init.response.json();assert(Object.values(flags.feature_gates).every(g=>g.value===true));assert.equal(flags.layer_configs['72216192'].value.enable_i18n,true);
 assert.equal((await http.fetch('fixture',new Request('https://other.invalid/v1/initialize',{method:'POST',body}))).status,403);
 await assert.rejects(async()=>await http.fetch('fixture',new Request(url+'?se=1',{method:'POST',body:'bad.'})),/配置请求格式无效/);
 await assert.rejects(async()=>await http.fetch('fixture',new Request(url,{method:'POST',body:'x'.repeat(65537)})),/配置请求过大/);
});

test('actual pinned SDK generates encoded compressed live requests and accepts the local unchanged response',{skip:!process.env.DSH_LIVE_SDK&&'Requires DSH_LIVE_SDK bound to the delivered SDK'},async t=>{
 const source=await readFile(process.env.DSH_LIVE_SDK,'utf8');
 const method=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a,'pinned SDK live configuration ABI changed');return source.slice(a,b);};
 const live=method('fetchLiveEvaluations(e,r,o,s,c,l){','_fetchEvaluations(e,n,i,a){');
 const encode=method('_tryEncodeBody(e){','_tryToCompressBody(e){');
 const compress=method('_tryToCompressBody(e){','_getInternalRequestArgs(e,t){');
 let parsed=0;const context={Promise,TextEncoder,CompressionStream,t:(self,...args)=>new Promise((resolve,reject)=>{const it=args.at(-1).apply(self,args[0]||[]);const step=(key,value)=>{let result;try{result=it[key](value);}catch(error){reject(error);return;}if(result.done)resolve(result.value);else Promise.resolve(result.value).then(v=>step('next',v),e=>step('throw',e));};step('next');}),
  n:{_getStatsigGlobalFlag:()=>null,_typedJsonParse:()=>{parsed++;throw Error('unchanged reply must not be parsed');}},l:{_getWindowSafe:()=>({btoa})},i:{Log:{warn(){},error(){}}},a:{NetworkParam:{StatsigEncoded:'se',IsGzipped:'gz'}},w:()=>true};
 // The real live method also uses the lcut header name and its numeric parser.
 // No lcut is sent by the local immutable provider, so those branches stay idle.
 const Client=vm.runInNewContext('class Client{'+encode+compress+live+'};Client',context);
 const http=await service(t),client=new Client();client._options={};client._initializeUrlConfig={};client._option={};let seenMode;
 client.post=async args=>{
  seenMode=args.data.responseMode;const request={...args,body:JSON.stringify(args.data)};
  client._tryEncodeBody(request);await client._tryToCompressBody(request);
  const query=new URLSearchParams(request.params),result=await http.fetch('fixture',new Request(url+'?'+query,{method:'POST',body:request.body}));
  return {code:result.response.status,headers:result.response.headers,body:await result.response.text()};
 };
 // `a` is a numeric parser in the live module; the encoding module's `a` is
 // NetworkParam. A callable object preserves both real compiled references.
 context.a=Object.assign(()=>null,context.a);context.i=Object.assign(context.i,{toString:()=> 'x-statsig-live-overlay-lcut'});
 const reply=await client.fetchLiveEvaluations('fixture',{},1,{},'low',null);
 assert.equal(seenMode,'live_overlay');assert.equal(reply.hasUpdates,false);assert.equal(parsed,0);
});

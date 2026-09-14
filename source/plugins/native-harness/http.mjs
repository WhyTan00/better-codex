import { readFile } from 'node:fs/promises';
import { WORKSPACES,workspace,fail } from './workspaces.mjs';
const files={'/native':'index.html','/native/':'index.html','/native/app.js':'app.js','/native/state.js':'state.js','/native/style.css':'style.css'};
export const routes=[...Object.keys(files),'/native/api','/native/events'];
function json(res,status,value){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value))}
export function handler(gateway){return async(req,res)=>{try{
  const u=new URL(req.url,'http://127.0.0.1');
  const origin=req.headers.origin;const allowed=new Set(['http://localhost:3080','http://127.0.0.1:3080','http://127.0.0.1:3091']);
  if(origin&&!allowed.has(origin))fail('origin_denied',403);
  if(req.headers['sec-fetch-site']==='cross-site')fail('cross_site_denied',403);
  if(files[u.pathname]){if(!['GET','HEAD'].includes(req.method))fail('method_not_allowed',405);const f=files[u.pathname];const body=await readFile(new URL('./public/'+f,import.meta.url));res.writeHead(200,{'content-type':f.endsWith('.js')?'text/javascript; charset=utf-8':f.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",'x-content-type-options':'nosniff'});res.end(req.method==='HEAD'?undefined:body);return}
  const w=u.searchParams.get('workspace');workspace(w);
  if(u.pathname==='/native/events'){
    if(req.method!=='GET')fail('method_not_allowed',405);
    const id=u.searchParams.get('threadId');if(id)await gateway.metadata(w,id);
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive','x-accel-buffering':'no'});
    const send=e=>{if(!id||!e.params.threadId&&!e.params.thread?.id||e.params.threadId===id||e.params.thread?.id===id){if(res.writableLength>1e6){res.end();return}res.write(`id: ${e.generation}:${e.seq}\ndata: ${JSON.stringify(e)}\n\n`)}};
    gateway.on(w,send);res.write(`data: ${JSON.stringify({workspace:w,generation:gateway.generation,seq:gateway.seq[w],method:'connection/snapshot-required',params:{}})}\n\n`);
    const timer=setInterval(()=>res.write(': keepalive\n\n'),15000);res.on('close',()=>{clearInterval(timer);gateway.off(w,send)});return;
  }
  if(u.pathname!=='/native/api')fail('not_found',404);
  if(req.method==='GET'){
    const op=u.searchParams.get('op');let value;
    if(op==='config')value={workspaces:Object.values(WORKSPACES).map(({id,label,root})=>({id,label,root})),workspace:w,generation:gateway.generation,hostAlive:gateway.rpc.alive,defaults:{model:'provider-default',effort:'high',serviceTier:'default'},boundary:'共享家庭登录与 OS 用户；工作区展示/API 范围隔离，不是独立账户或文件保密沙箱。'};
    else if(op==='list')value=await gateway.list(w,{cursor:u.searchParams.get('cursor'),search:u.searchParams.get('search')});
    else if(op==='snapshot')value=await gateway.snapshot(w,u.searchParams.get('threadId'),u.searchParams.get('cursor'));
    else if(op==='plugins')value=await gateway.plugins(w,u.searchParams.get('plugin'));
    else if(op==='request'){const entry=gateway.state.requests[w+':'+u.searchParams.get('requestId')];value=entry?{status:entry.status,result:entry.result,error:entry.error}:{status:'not_found'}}
    else fail('operation_not_allowed');json(res,200,value);return;
  }
  if(req.method!=='POST')fail('method_not_allowed',405);
  if(req.headers['x-native-client']!=='1'||!String(req.headers['content-type']).startsWith('application/json'))fail('client_header_required',403);
  let body='',size=0;for await(const chunk of req){size+=chunk.length;if(size>10e6)fail('request_too_large',413);body+=chunk}let p;try{p=JSON.parse(body)}catch{fail('invalid_json')}
  if(!['create','send','stop','approve'].includes(p.op))fail('operation_not_allowed');
  json(res,200,await gateway.mutate(w,req.headers['idempotency-key'],p));
}catch(e){if(res.headersSent){res.end();return}json(res,e.status||503,{error:e.code||'native_error',message:e.code?e.message:'原生接口暂不可用；请刷新核对状态'})}}}

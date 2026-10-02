import http from 'node:http';
import {readFileSync,lstatSync} from 'node:fs';
import {randomBytes,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {pipeline} from 'node:stream';
import {isWorkspaceNavigation} from './navigation.mjs';
import {endToEndHeaders} from './http-headers.mjs';
import {PortablePlugins} from './portable-plugins.mjs';

const fail=(code,message)=>Object.assign(new Error(message),{code});
const loopback=address=>address==='127.0.0.1'||address==='::1'||address==='::ffff:127.0.0.1';
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
async function body(req){let size=0,parts=[];for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw fail(413,'Request exceeds its limit');parts.push(chunk);}try{return JSON.parse(Buffer.concat(parts));}catch{throw fail(400,'Invalid JSON request');}}
export function authenticatePortableRequest(config,req,{upgrade=false,proxyKey=null}={}){
 if(!loopback(req.socket.remoteAddress))throw fail(403,'Loopback proxy required');
 const origin=new URL(config.origin);
 if(req.headers.host!==origin.host||!req.url.startsWith('/')||req.url.startsWith('//')||req.url.includes('\\'))throw fail(403,'Untrusted request host');
 const navigation=!upgrade&&isWorkspaceNavigation(req);
 if(req.headers.origin&&req.headers.origin!==origin.origin||req.headers['sec-fetch-site']==='cross-site'&&!navigation)throw fail(403,'Cross-origin request rejected');
 if((upgrade||!['GET','HEAD'].includes(req.method))&&req.headers.origin!==origin.origin)throw fail(403,'Same-origin request required');
 let principal='local';
 if(config.access.mode==='tailscale-serve'){
  const user=req.headers['tailscale-user-login'];
  if(typeof user!=='string'||!config.access.users.includes(user))throw fail(401,'This Tailscale user is not allowed');
  principal='tailnet:'+user;
 }
 if(config.access.mode==='cvm-proxy'){
  const key=req.headers['x-better-codex-proxy'],user=req.headers['x-better-codex-user'];
  if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key)||!proxyKey||key.length!==proxyKey.length||!timingSafeEqual(Buffer.from(key),Buffer.from(proxyKey))||typeof user!=='string'||!config.access.users.includes(user))throw fail(401,'Authenticated CVM proxy required');
  principal='cvm:'+user;
 }
 const url=new URL(req.url,config.origin),scope=url.pathname.match(/^\/(?:sync\/v1\/w|api\/w|w|plugins)\/([^/]+)(?:\/|$)/)?.[1]||url.searchParams.get('workspace');
 if(scope&&!Object.hasOwn(config.workspaces,scope))throw fail(403,'Workspace is not available');
 return {url,principal};
}

export async function createPortableEntry(config,{plugins=null}={}){
 let proxyKey=null;
 if(config.access.mode==='cvm-proxy'){
  const stat=lstatSync(config.access.proxyKeyFile);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077))throw Error('CVM proxy key must be a private regular file');
  proxyKey=readFileSync(config.access.proxyKeyFile,'utf8').trim();
  if(!/^[a-f0-9]{64}$/.test(proxyKey))throw Error('Invalid CVM proxy key');
 }
 plugins=plugins??await new PortablePlugins(config).start();
 const secret=randomBytes(32),sockets=new Set(),sign=value=>createHmac('sha256',secret).update(value).digest('base64url');
 const principalHash=value=>createHash('sha256').update(value).digest('hex');
 const token=(scope,principal)=>{const value=Buffer.from(JSON.stringify({scope,principal:principalHash(principal),expiresAt:Date.now()+12*3600*1000})).toString('base64url');return value+'.'+sign(value);};
 function authorize(req,scope,principal){
  const supplied=req.headers['x-better-codex-capability']??(req.headers.authorization??'').replace(/^Bearer /,''),[value,mac,...extra]=supplied.split('.');
  if(!value||!mac||extra.length||mac.length!==43||!timingSafeEqual(Buffer.from(mac),Buffer.from(sign(value))))throw fail(401,'Workspace capability expired');
  let claims;try{claims=JSON.parse(Buffer.from(value,'base64url'));}catch{throw fail(401,'Invalid workspace capability');}
  if(claims.scope!==scope||claims.principal!==principalHash(principal)||!(claims.expiresAt>Date.now()))throw fail(401,'Workspace capability expired');
  return plugins.workspace(scope);
 }
 function headers(req,{upgrade=false}={}){
  const result=endToEndHeaders(req.headers);
  for(const key of Object.keys(result))if(/^(x-dsh-authenticated|x-better-codex-|tailscale-|x-forwarded-|forwarded$)/i.test(key))delete result[key];
  if(config.access.mode==='cvm-proxy')delete result.authorization;
  result.host=new URL(config.origin).host;result['x-dsh-authenticated']='1';
  if(upgrade){result.connection='Upgrade';result.upgrade='websocket';}
  return result;
 }
 const upstream=url=>url.pathname.startsWith('/sync/v1/')?'http://127.0.0.1:'+config.relayPort:'http://127.0.0.1:'+config.frontPort;
 function proxy(req,res,url){
  const request=http.request(new URL(req.url,upstream(url)),{method:req.method,headers:headers(req)},response=>{
   res.writeHead(response.statusCode,endToEndHeaders(response.headers));pipeline(response,res,()=>{});
  });
  request.on('error',()=>{if(!res.headersSent)json(res,503,{error:'Core service is unavailable'});else res.destroy();});
  req.once('aborted',()=>request.destroy());res.once('close',()=>{if(!res.writableEnded)request.destroy();});req.pipe(request);
 }
 const server=http.createServer(async(req,res)=>{
  try{
   if(req.method==='GET'&&req.url==='/__workbench_health'&&loopback(req.socket.remoteAddress)&&!req.headers.origin&&req.headers['sec-fetch-site']!=='cross-site')return json(res,200,{service:'workbench-entry',ready:true,access:config.access.mode});
   const {url,principal}=authenticatePortableRequest(config,req,{proxyKey});
   if(url.pathname==='/_sync-agent'||url.pathname.startsWith('/__'))throw fail(404,'Route is not available');
   if(url.pathname==='/api/context'&&req.method==='POST'){
    const value=await body(req),ws=plugins.workspace(value.workspace);
    return json(res,200,{token:token(ws.id,principal),workspace:ws.id,label:ws.label,workspaces:Object.values(config.workspaces).map(({id,label})=>({id,label})),identity:config.access.mode});
   }
   const plugin=url.pathname.match(/^\/api\/w\/([^/]+)\/plugins(?:\/([a-z][a-z0-9-]{0,63}))?(\/invoke)?$/);
   if(plugin){
    const[,scope,id,operation]=plugin;authorize(req,scope,principal);
    if(req.method==='GET'&&!operation)return json(res,200,id?await plugins.load(scope,id):{data:plugins.list(scope)});
    if(req.method==='POST'&&id&&operation)return json(res,200,await plugins.invoke(scope,id,await body(req)));
    throw fail(405,'Method is not allowed');
   }
   const asset=url.pathname.match(/^\/plugins\/([^/]+)\/([a-z][a-z0-9-]{0,63})\/(.+)$/);
   if(asset&&['GET','HEAD'].includes(req.method)){
    const value=await plugins.asset(asset[1],asset[2],asset[3]);
    res.writeHead(200,{'content-type':value.type,'content-length':value.bytes.length,'cache-control':'no-cache','x-content-type-options':'nosniff','referrer-policy':'same-origin','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"});res.end(req.method==='HEAD'?undefined:value.bytes);return;
   }
   if(url.pathname.startsWith('/api/w/')||url.pathname.startsWith('/plugins/'))throw fail(404,'Plugin route is not available');
   proxy(req,res,url);
  }catch(error){if(!res.headersSent)json(res,error.code>=400&&error.code<600?error.code:500,{error:error.code?error.message:'Workbench request failed'});else res.destroy();}
 });
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 server.on('upgrade',(req,socket,head)=>{
  try{
   const {url}=authenticatePortableRequest(config,req,{upgrade:true,proxyKey});
   if(!(/^\/w\/[^/]+\/ws$/.test(url.pathname)||url.pathname.startsWith('/sync/v1/')))throw fail(404,'WebSocket route is not available');
   const request=http.request(new URL(req.url,upstream(url)),{method:'GET',headers:headers(req,{upgrade:true})});
   request.on('upgrade',(response,upstreamSocket,upstreamHead)=>{
    const responseHeaders=endToEndHeaders(response.headers);responseHeaders.connection='Upgrade';responseHeaders.upgrade='websocket';
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(responseHeaders).flatMap(([key,value])=>(Array.isArray(value)?value:[value]).map(value=>key+': '+value+'\r\n')).join('')+'\r\n');
    if(upstreamHead.length)socket.write(upstreamHead);if(head.length)upstreamSocket.write(head);
    socket.on('error',()=>upstreamSocket.destroy());upstreamSocket.on('error',()=>socket.destroy());socket.once('close',()=>upstreamSocket.destroy());upstreamSocket.once('close',()=>socket.destroy());socket.pipe(upstreamSocket).pipe(socket);
   });
   request.on('response',response=>{response.resume();socket.end('HTTP/1.1 '+(response.statusCode||502)+' Rejected\r\nConnection: close\r\n\r\n');});
   request.on('error',()=>socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n'));socket.once('close',()=>request.destroy());request.end();
  }catch{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');}
 });
 return {server,plugins,async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await plugins.close();}};
}

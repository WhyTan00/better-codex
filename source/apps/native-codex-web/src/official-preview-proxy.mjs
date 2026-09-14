// Explicitly opted-in official UI preview; existing SSO remains the only login gate.
// The cookie selects UI routing, not identity or permission. Legacy APIs stay usable.
import http from 'node:http';
import {endToEndHeaders} from './http-headers.mjs';
const COOKIE='betterCodex_official_preview';
const CANONICAL='localhost:3080';
export function createOfficialPreviewProxy({upstream='http://127.0.0.1:3084',defaultOfficial=true,localOrigin=null}={}) {
 const opted=req=>{const selection=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='));return selection?selection===COOKIE+'=1':defaultOfficial;};
 const localLegacy=p=>p==='/healthz'||p==='/api/context'||p.startsWith('/api/w/')||p.startsWith('/api/video-media/')||['/app.mjs','/state.mjs','/style.css','/manifest.json','/icon.svg','/secondary-workbench-frame','/video-workbench','/video-workbench.js','/video-workbench.css'].includes(p);
 function route(req,res){
  const u=new URL(req.url,'http://localhost');
  const alias=u.pathname.match(/^\/(?:workspaces\/(ai|secondary)|official)\/?$/);
  if(alias){u.pathname='/ui/official';if(alias[1])u.searchParams.set('workspace',alias[1]);req.url=u.pathname+u.search;}
  if(u.pathname==='/workbench'){u.pathname='/';u.searchParams.set('view','workbench');req.url=u.pathname+u.search;return false;}
  if(u.pathname==='/ui/official'||u.pathname==='/ui/legacy'){
   if(req.method!=='GET'){res.writeHead(405);res.end();return true;}
   const enabled=u.pathname==='/ui/official';const scope=u.searchParams.get('workspace')==='secondary'?'secondary':'ai';
   res.writeHead(303,{'location':'/?workspace='+scope,'cache-control':'no-store','set-cookie':COOKIE+'='+(enabled?'1':'0')+'; Path=/; HttpOnly; Secure; SameSite=Lax'});res.end();return true;
  }
  if(!opted(req)||localLegacy(u.pathname))return false;
  const p=http.request(upstream+req.url,{method:req.method,headers:endToEndHeaders(req.headers)},r=>{res.writeHead(r.statusCode,endToEndHeaders(r.headers));r.pipe(res);});
  p.on('error',()=>{if(!res.headersSent)res.writeHead(503,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});res.end('官方界面预览暂不可用。可打开 /ui/legacy 返回原工作台。');});
  req.on('aborted',()=>p.destroy());res.on('close',()=>{if(!res.writableEnded)p.destroy();});req.pipe(p);return true;
 }
 function upgrade(req,socket,head){
  if(!opted(req)||![CANONICAL,...(localOrigin?[new URL(localOrigin).host]:[])].includes(req.headers.host)||req.headers.origin&&!['https://'+CANONICAL,...(localOrigin?[localOrigin]:[])].includes(req.headers.origin)||req.headers['sec-fetch-site']==='cross-site'||!/^\/w\/(ai|secondary)\/ws(?:\?|$)/.test(req.url))return false;
  const p=http.request(upstream+req.url,{method:'GET',headers:{...req.headers}});
  p.once('upgrade',(r,up,extra)=>{socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(r.headers).map(([k,v])=>k+': '+v+'\r\n').join('')+'\r\n');if(extra.length)socket.write(extra);if(head.length)up.write(head);socket.pipe(up);up.pipe(socket);socket.once('error',()=>up.destroy());up.once('error',()=>socket.destroy());socket.once('close',()=>up.destroy());up.once('close',()=>socket.destroy());});
  p.once('response',r=>{socket.end('HTTP/1.1 '+r.statusCode+' Rejected\r\nConnection: close\r\n\r\n');r.resume();});
  p.once('error',()=>socket.destroy());socket.once('error',()=>p.destroy());p.end();return true;
 }
 return {route,upgrade};
}

import http from 'node:http';
import {createOfficialPreviewProxy} from './official-preview-proxy.mjs';
import {isWorkspaceNavigation,navigationDenial} from './navigation.mjs';
import {readFile} from 'node:fs/promises';
import {randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {WORKSPACES,workspace,fail} from './registry.mjs';
import {createVideoWorkbenchHttp} from './video-workbench-http.mjs';
import {secondaryWorkbenchApi,secondaryWorkbenchFrame} from './secondary-workbench-http.mjs';
const PUBLIC=fileURLToPath(new URL('../public/',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.js':'text/javascript; charset=utf-8'};
async function body(req){let size=0,s='';for await(const chunk of req){size+=chunk.length;if(size>9*1024*1024)throw fail(413,'请求过大');s+=chunk;}try{return JSON.parse(s);}catch{throw fail(400,'JSON 格式错误');}}
function json(res,status,value){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));}
export function createServer({hub,journal,attachments,plugins,port=3091}){
 const videoWorkbench=createVideoWorkbenchHttp();
 const preview=createOfficialPreviewProxy({upstream:process.env.NATIVE_WEB_OFFICIAL_UPSTREAM||'http://127.0.0.1:3084',localOrigin:`http://127.0.0.1:${port}`});
 const secret=randomBytes(32);const sign=s=>createHmac('sha256',secret).update(s).digest('base64url');
 const issue=ws=>{const value=Buffer.from(JSON.stringify({workspace:ws.id,principal:'household-sso',exp:Date.now()+12*3600000})).toString('base64url');return value+'.'+sign(value);};
 function authorize(req,id){const token=(req.headers.authorization||'').replace(/^Bearer /,'');const[v,mac]=token.split('.');if(!v||!mac||mac.length!==43||!timingSafeEqual(Buffer.from(mac),Buffer.from(sign(v))))throw fail(401,'工作区连接已失效，请重新连接');let c;try{c=JSON.parse(Buffer.from(v,'base64url'));}catch{throw fail(401,'连接无效');}if(c.exp<Date.now())throw fail(401,'连接已过期');if(c.principal!=='household-sso'||c.workspace!==id)throw fail(403,'工作区连接不匹配');return workspace(c.workspace);}
 const server=http.createServer(async(req,res)=>{try{
  if(req.url==='/healthz'&&req.method==='GET'&&!req.headers.origin)return json(res,200,{status:'ok',service:'native-codex-web',version:'1.0.0',activeTurns:hub.active?.size||0,hosts:[...hub.hosts].map(([workspace,h])=>({workspace,state:h.state,transport:h.isShared?'shared-native':'dedicated'})),generation:hub.generation});
  const host=req.headers.host||'';const allowed=['localhost:3080',`127.0.0.1:${port}`,`localhost:${port}`];if(!allowed.includes(host))throw fail(403,'Host 不受信任');
  // Home-screen launchers may omit document Fetch Metadata. The bare entry
  // contains no data or action: canonicalize it before API-origin enforcement.
  if(req.method==='GET'&&req.url==='/'){res.writeHead(303,{location:'/?workspace=ai','cache-control':'no-store'});res.end();return;}
  const safeNavigation=isWorkspaceNavigation(req);
  const origin=req.headers.origin;if(origin&&!safeNavigation&&!['http://localhost:3080',`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(origin))throw fail(403,'Origin 不受信任');
  if(req.headers['sec-fetch-site']==='cross-site'&&!safeNavigation){navigationDenial(req,'main');throw fail(403,'跨站请求被拒绝');}
  if(preview.route(req,res))return;
  res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','same-origin');res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const u=new URL(req.url,'http://localhost');const route=u.pathname;
  if(secondaryWorkbenchFrame(u,req,res))return;
  if(await videoWorkbench.media(u,req,res))return;
  if(route==='/healthz'&&req.method==='GET')return json(res,200,{status:'ok',service:'native-codex-web',version:'1.0.0',activeTurns:hub.active?.size||0,hosts:[...hub.hosts].map(([workspace,h])=>({workspace,state:h.state,transport:h.isShared?'shared-native':'dedicated'})),generation:hub.generation});
  // Existing Caddy forward_auth remains the identity gate. This capability binds each tab
  // to one fixed workspace; it is not a new login or a claim of separate household identities.
  if(route==='/api/context'&&req.method==='POST'){const b=await body(req);const ws=workspace(b.workspace);return json(res,200,{token:issue(ws),workspace:ws.id,label:ws.label,workspaces:Object.values(WORKSPACES).map(({id,label})=>({id,label})),identity:'家庭共享登录 · 工作区隔离',generation:hub.generation});}
  const m=route.match(/^\/api\/w\/([^/]+)\/(.*)$/);
  if(m){const ws=authorize(req,m[1]);const op=m[2];
   if(await secondaryWorkbenchApi(ws,op,req,res))return;
   if(await videoWorkbench.api(ws,op,u,req,res))return;
   if(op==='threads'&&req.method==='GET')return json(res,200,await hub.list(ws,{cursor:u.searchParams.get('cursor'),search:u.searchParams.get('search')||''}));
   if(op==='snapshot'&&req.method==='GET')return json(res,200,await hub.snapshot(ws,u.searchParams.get('threadId'),u.searchParams.get('cursor')));
   if(op==='items'&&req.method==='GET')return json(res,200,await hub.items(ws,u.searchParams.get('threadId'),u.searchParams.get('turnId'),u.searchParams.get('cursor')));
   if(op==='mutate'&&req.method==='POST'){const b=await body(req);if(['cwd','path','workspaceId','model','sandbox','approvalPolicy','config'].some(k=>k in b))throw fail(400,'不允许浏览器覆写执行配置或路径');return json(res,200,await hub.mutate(ws,b,attachments));}
   if(op==='request'&&req.method==='GET'){const r=journal.get(ws.id,u.searchParams.get('id'));return json(res,200,r?{requestId:r.id,state:r.state,result:r.result}:{state:'notFound'});}
   if(op==='attachments'&&req.method==='POST'){const b=await body(req);await hub.checked(ws,b.threadId);return json(res,200,await attachments.add(ws,b.threadId,b));}
   if(op==='plugins'&&req.method==='GET')return json(res,200,{data:plugins.list(ws)});
   if(op.startsWith('plugins/')&&req.method==='GET')return json(res,200,await plugins.load(ws,op.slice(8)));
   if(op==='events'&&req.method==='GET'){const id=u.searchParams.get('threadId');if(id)await hub.checked(ws,id);else await hub.host(ws);
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store, no-transform','connection':'keep-alive','x-accel-buffering':'no'});res.write(`data: ${JSON.stringify({workspace:ws.id,method:'sync/required',generation:hub.generation,seq:hub.sequence[ws.id],params:{}})}\n\n`);
    const send=e=>{if(e.workspace!==ws.id)return;const tid=e.params.threadId||e.params.thread?.id;if(id&&tid&&tid!==id)return;if(res.writableLength>512*1024){res.end();return;}res.write(`data: ${JSON.stringify(e)}\n\n`);};hub.on('event',send);const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);req.on('close',()=>{clearInterval(heartbeat);hub.off('event',send);});return;
   }
   throw fail(404,'端点不存在');
  }
  if(route.startsWith('/api/'))throw fail(404,'端点不存在');
  if(req.method!=='GET'&&req.method!=='HEAD')throw fail(405,'方法不允许');
  if(route==='/video-workbench'&&u.searchParams.get('workspace')&&u.searchParams.get('workspace')!=='ai')throw fail(403,'视频工作台仅属于 AI 工作区');
  if(route==='/video-workbench')res.setHeader('content-security-policy',String(res.getHeader('content-security-policy')).replace("frame-ancestors 'none'","frame-ancestors 'self'"));
  const files={'/':'index.html','/app.mjs':'app.mjs','/state.mjs':'state.mjs','/style.css':'style.css','/manifest.json':'manifest.json','/icon.svg':'icon.svg','/sw.js':'sw.js','/workbench-sw.js':'sw.js','/manifest.webmanifest':'manifest.json','/video-workbench':'video-workbench.html','/video-workbench.js':'video-workbench.js','/video-workbench.css':'video-workbench.css'};if(!files[route])throw fail(404,'页面不存在');const b=await readFile(path.join(PUBLIC,files[route]));res.writeHead(200,{'content-type':route==='/sw.js'?'text/javascript':types[path.extname(files[route])],'cache-control':'no-store','x-robots-tag':'noindex, nofollow'});res.end(req.method==='HEAD'?undefined:b);
 }catch(e){if(res.headersSent){res.end();return;}json(res,e.code>=400&&e.code<=599?e.code:500,{error:e.code?e.message:'服务暂不可用'});}});
 server.on('upgrade',(req,socket,head)=>{if(preview.upgrade(req,socket,head))return;socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');});
 return server;
}

// Thin HTTP presentation boundary; video-domain facts and feedback stay in VideoWorkbench.
import {randomBytes} from 'node:crypto';
import {stat,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {videoWorkbench} from '${BETTER_CODEX_WORKSPACE}/VideoWorkbench/adapters/video-workbench.mjs';
import {workspace} from './registry.mjs';
const fail=(code,message)=>Object.assign(new Error(message),{code});
async function projectEnabled(){
 const ws=workspace('ai');let registry;
 try{registry=JSON.parse(await readFile(path.join(ws.root,ws.projectRegistry),'utf8'));}catch{throw fail(503,'项目登记暂不可读');}
 const project=registry.projects?.find(p=>p.id==='comfyui-video');
 if(!project||['retired','archived'].includes(project.lifecycle)||project.default_visibility==='hidden')throw fail(403,'视频项目当前不可访问');
 const root=await realpath(path.resolve(ws.root,project.root||''));
 if(root!==await realpath(path.join(ws.root,'VideoWorkbench')))throw fail(403,'视频项目归属已变化，请重新核对适配器');
}

export function byteRange(header,size){
 if(!header)return null;
 const m=/^bytes=(\d*)-(\d*)$/.exec(header);if(!m||(!m[1]&&!m[2]))throw fail(416,'无效媒体范围');
 let start,end;
 if(!m[1]){const tail=Number(m[2]);if(!Number.isSafeInteger(tail)||tail<=0)throw fail(416,'无效媒体范围');start=Math.max(0,size-tail);end=size-1;}
 else{start=Number(m[1]);end=m[2]?Math.min(size-1,Number(m[2])):size-1;}
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)throw fail(416,'无效媒体范围');
 return {start,end};
}
export function createVideoWorkbenchHttp({service=videoWorkbench,checkProject=service===videoWorkbench?projectEnabled:async()=>{}}={}){
 const grants=new Map();
 const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'});res.end(JSON.stringify(value));};
 async function payload(req){let b='',size=0;for await(const c of req){size+=c.length;if(size>12000)throw fail(413,'反馈内容过长');b+=c;}try{return JSON.parse(b);}catch{throw fail(400,'反馈格式错误');}}
 async function api(ws,op,u,req,res){
  if(!op.startsWith('video-workbench'))return false;
  if(ws.id!=='ai'||!ws.plugins.includes('video'))throw fail(403,'视频工作台不属于当前工作区');
  await checkProject();
  if(op==='video-workbench/catalog'&&req.method==='GET'){json(res,200,await service.list(Object.fromEntries(u.searchParams)));return true;}
  if(op==='video-workbench/telemetry'&&req.method==='GET'){json(res,200,await service.telemetry());return true;}
  const group=op.match(/^video-workbench\/groups\/([a-f0-9]{24})$/);
  if(group&&req.method==='GET'){json(res,200,await service.group(group[1],{order:u.searchParams.get('order')}));return true;}
  const compare=op.match(/^video-workbench\/assets\/([a-f0-9]{24})\/compare$/);
  if(compare&&req.method==='GET'){json(res,200,await service.compare(compare[1],u.searchParams.get('with')));return true;}
  const asset=op.match(/^video-workbench\/assets\/([a-f0-9]{24})$/);
  if(asset&&req.method==='GET'){json(res,200,await service.detail(asset[1]));return true;}
  const ticket=op.match(/^video-workbench\/assets\/([a-f0-9]{24})\/ticket$/);
  if(ticket&&req.method==='POST'){
   const record=await service.record(ticket[1]);const id=randomBytes(24).toString('base64url'),expiresAt=Date.now()+3600000;
   grants.set(id,{assetId:record.id,revision:record.revision,expiresAt,scope:ws.id});
   for(const [key,g]of grants)if(g.expiresAt<Date.now())grants.delete(key);
   while(grants.size>2048)grants.delete(grants.keys().next().value);
   json(res,200,{assetId:record.id,revision:record.revision,expiresAt,
    videoUrl:'/api/video-media/'+id+'/video',posterUrl:'/api/video-media/'+id+'/poster',downloadUrl:'/api/video-media/'+id+'/download'});return true;
  }
  if(op==='video-workbench/feedback'&&req.method==='POST'){json(res,200,await service.feedback(await payload(req)));return true;}
  throw fail(404,'视频接口不存在');
 }
 async function media(u,req,res){
  if(!u.pathname.startsWith('/api/video-media/'))return false;
  if(!['GET','HEAD'].includes(req.method))throw fail(405,'只允许读取媒体');
  const m=/^\/api\/video-media\/([A-Za-z0-9_-]{32})\/(video|poster|download)$/.exec(u.pathname),g=m&&grants.get(m[1]);
  if(!g||g.scope!=='ai'||g.expiresAt<Date.now())throw fail(404,'媒体链接已失效，请重新打开素材');
  await checkProject();
  const current=await service.record(g.assetId);if(current.revision!==g.revision)throw fail(409,'素材已更新，请重新打开');
  const asset=await service.media(g.assetId,m[2]==='poster'?'poster':'video');const s=await stat(asset.file);
  let range;try{range=byteRange(req.headers.range,s.size);}catch(e){res.writeHead(416,{'content-range':'bytes */'+s.size,'cache-control':'private, no-store'});res.end();return true;}
  const headers={'content-type':asset.type,'cache-control':'private, no-store','accept-ranges':'bytes','content-length':range?range.end-range.start+1:s.size,
   'x-content-type-options':'nosniff','x-robots-tag':'noindex, nofollow','referrer-policy':'no-referrer'};
  if(range)headers['content-range']=`bytes ${range.start}-${range.end}/${s.size}`;
  if(m[2]==='download')headers['content-disposition']="attachment; filename*=UTF-8''"+encodeURIComponent(asset.fileName);
  res.writeHead(range?206:200,headers);if(req.method==='HEAD'){res.end();return true;}
  try{await pipeline(createReadStream(asset.file,range||{}),res);}catch(e){if(e.code!=='ERR_STREAM_PREMATURE_CLOSE')throw e;}return true;
 }
 return {api,media};
}

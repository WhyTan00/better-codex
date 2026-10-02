import path from 'node:path';
import {mkdir,realpath,open,writeFile,stat,readdir,unlink,rmdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {workspace,fail} from './registry.mjs';
import {runtimeProfile} from './runtime-profile.mjs';
const nativeAttachments=path.join(runtimeProfile.codexHome,'attachments');
const inside=(p,r)=>p===r||p.startsWith(r+path.sep);
const MAX=20*1024*1024;
export const fileMime=p=>({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.zip':'application/zip','.txt':'text/plain','.md':'text/plain','.json':'application/json','.svg':'image/svg+xml','.html':'text/html','.csv':'text/csv','.js':'text/plain','.ts':'text/plain','.py':'text/plain','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav'}[path.extname(p).toLowerCase()]||'application/octet-stream');
const mime=fileMime;
export const fileEtag=s=>'stat:'+createHash('sha256').update(`${s.mtimeMs}:${s.ctimeMs}:${s.size}`).digest('base64url');
const etag=fileEtag;
export class OfficialFiles {
 constructor({stateDir,boundary}){this.root=path.join(stateDir,'uploads');this.boundary=boundary;this.temporary=new Map();this.retained=new Set();this.db=boundary?.journal?.db;this.db?.exec('CREATE TABLE IF NOT EXISTS retained_queue_files(workspace TEXT,path TEXT,PRIMARY KEY(workspace,path))');this.db?.exec('CREATE TABLE IF NOT EXISTS goal_attachment_directories(path TEXT PRIMARY KEY,workspace TEXT NOT NULL)');}
 writable(scope){if(workspace(scope).readOnly)throw fail(403,'Workspace is read-only');}
 goalDirectory(value){
  if(typeof value!=='string')throw fail(400,'无效附件路径');
  const match=value.startsWith(nativeAttachments+path.sep)&&value.slice(nativeAttachments.length+1).match(/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/([^/]+))?$/i);
  if(!match||['.','..'].includes(match[2])||value.includes('\0')||value.includes('\\'))throw fail(403,'仅允许当前工作区创建的目标附件');
  return {directory:path.join(nativeAttachments,match[1]),filename:match[2]};
 }
 ownsGoalDirectory(scope,directory){return !!this.db?.prepare('SELECT 1 FROM goal_attachment_directories WHERE path=? AND workspace=?').get(directory,workspace(scope).id);}
 async nativeAttachmentRequest(scope,method,p){
  this.writable(scope);
  const {directory,filename}=this.goalDirectory(p.path);workspace(scope);
  if(!this.db)throw fail(503,'附件归属记录暂不可用');
  return this.boundary.serial('goal-attachment:'+directory,async()=>{
   if(method==='fs/createDirectory'){
    if(filename||p.recursive!==true)throw fail(400,'无效附件目录请求');
    if(this.ownsGoalDirectory(scope,directory)){await this.resolve(scope,directory);return {};}
    await mkdir(path.dirname(directory),{recursive:true,mode:0o700});
    if(await realpath(path.dirname(directory))!==path.dirname(directory))throw fail(403,'附件目录链接不可用');
    try{await mkdir(directory,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw fail(409,'附件目录已存在，请重新选择附件');throw e;}
    this.db.prepare('INSERT INTO goal_attachment_directories(path,workspace) VALUES(?,?)').run(directory,scope);return {};
   }
   if(!this.ownsGoalDirectory(scope,directory))throw fail(403,'目标附件不属于当前工作区');
   await this.resolve(scope,directory);
   if(method==='fs/writeFile'){
    if(!filename||filename.length>180||typeof p.dataBase64!=='string'||p.dataBase64.length>Math.ceil(MAX/3)*4||p.dataBase64.length%4!==0||! /^[A-Za-z0-9+/]*={0,2}$/.test(p.dataBase64))throw fail(400,'无效目标附件');
    const bytes=Buffer.from(p.dataBase64,'base64');if(bytes.length>MAX)throw fail(413,'附件超过20 MB');
    const target=await this.resolve(scope,p.path,{create:true});
    try{await writeFile(target,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;const existing=await this.bytes(scope,target);if(!existing.bytes.equals(bytes))throw fail(409,'目标附件已存在且内容不同');}return {};
   }
   if(method==='fs/remove'){
    if(filename||p.recursive!==true)throw fail(400,'无效附件清理请求');
    const entries=await readdir(directory,{withFileTypes:true});if(entries.some(e=>!e.isFile()))throw fail(409,'附件目录含其他内容，已保留');
    for(const e of entries)await unlink(path.join(directory,e.name));await rmdir(directory);this.db.prepare('DELETE FROM goal_attachment_directories WHERE path=? AND workspace=?').run(directory,scope);return {};
   }
   throw fail(403,'附件操作未开放');
  });
 }
 async resolve(scope,value,{create=false}={}){
  const ws=workspace(scope);if(typeof value!=='string'||value.includes('\0')||value.length>8192)throw fail(400,'无效文件路径');
  const target=path.resolve(ws.root,value),uploadRoot=path.join(this.root,scope),actualUpload=await realpath(uploadRoot).catch(e=>{if(e.code==='ENOENT')return uploadRoot;throw e;}),visualBase=path.join(runtimeProfile.codexHome,'visualizations');let root=ws.root;
  if(inside(target,uploadRoot))root=uploadRoot;else if(inside(target,actualUpload))root=actualUpload;
  else if(inside(target,nativeAttachments)){const {directory}=this.goalDirectory(target);if(!this.ownsGoalDirectory(scope,directory))throw fail(403,'目标附件不属于当前工作区');if(await realpath(directory)!==directory)throw fail(403,'附件目录链接不可用');root=directory;}
  else if(inside(target,visualBase)){
   const m=target.slice(visualBase.length+1).match(/^(\d{4}\/\d{2}\/\d{2})\/([0-9a-f-]{36})(?:\/|$)/i);
   if(!m)throw fail(403,'产物目录不属于当前会话');await this.boundary.checked(ws,m[2]);root=path.join(visualBase,m[1],m[2]);
  }
  if(!inside(target,root))throw fail(403,'文件超出当前工作区');
  // Walk to the nearest existing ancestor. Compare against the canonical
  // workspace or exact per-thread artifact root, including not-yet-created roots.
  let base=root,missing=[];if(inside(target,visualBase)){base=visualBase;missing=path.relative(visualBase,root).split(path.sep);}while(true){try{base=path.join(await realpath(base),...missing);break;}catch(e){if(e.code!=='ENOENT')throw e;missing.unshift(path.basename(base));base=path.dirname(base);}}
  let ancestor=target,suffix=[];while(true){try{const actual=path.join(await realpath(ancestor),...suffix);if(!inside(actual,base))throw fail(403,'文件链接超出当前工作区');return actual;}catch(e){if(e.code!=='ENOENT'||!create)throw e;suffix.unshift(path.basename(ancestor));ancestor=path.dirname(ancestor);}}
 }
 async directory(scope,value){this.writable(scope);const target=await this.resolve(scope,value,{create:true});await mkdir(target,{recursive:true,mode:0o700});await this.resolve(scope,target);return {success:true};}
 async bytes(scope,value,maxBytes=MAX){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<=0||maxBytes>MAX)maxBytes=MAX;
  const target=await this.resolve(scope,value),f=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const s=await f.stat();if(!s.isFile())throw fail(400,'请选择文件');if(s.size>maxBytes)throw fail(413,'文件超过读取上限');const bytes=Buffer.alloc(Math.min(s.size+1,maxBytes+1));let length=0;
   while(length<bytes.length){const {bytesRead}=await f.read(bytes,length,bytes.length-length,null);if(!bytesRead)break;length+=bytesRead;}if(length>maxBytes)throw fail(413,'文件超过读取上限');return {bytes:bytes.subarray(0,length),etag:etag(s),mime:mime(target),path:target};
  }finally{await f.close();}
 }
 async read(scope,p){if(p.hostId&&p.hostId!=='local')throw fail(403,'文件宿主不属于当前工作区');const r=await this.bytes(scope,p.path,p.maxBytes);let text;
  if(p.representation==='text')text=r.bytes.toString('utf8');else if(p.representation!=='blob')try{text=new TextDecoder('utf-8',{fatal:true}).decode(r.bytes);if(text.includes('\0'))text=undefined;}catch{}
  return {...(text===undefined?{blob:r.bytes.toString('base64')}:{text}),etag:r.etag};
 }
 async upload(scope,files){
  this.writable(scope);
  if(!Array.isArray(files)||files.length>20)throw fail(413,'每次最多选择 20 个文件');let total=0;
  const decoded=files.map(f=>{if(typeof f.name!=='string'||typeof f.contentsBase64!=='string'||f.contentsBase64.length>Math.ceil(MAX/3)*4||f.contentsBase64.length%4!==0||! /^[A-Za-z0-9+/]*={0,2}$/.test(f.contentsBase64))throw fail(400,'附件格式无效');const bytes=Buffer.from(f.contentsBase64,'base64');total+=bytes.length;if(bytes.length>MAX||total>MAX||f.size!=null&&f.size!==bytes.length)throw fail(413,'每次附件总量最多 20 MB');return {...f,bytes};});
  const out=[];for(const f of decoded){const proposed=path.basename(f.name.replaceAll('\\','/')).replace(/[\x00-\x1f]/g,'_').slice(0,180),label=(!proposed||proposed==='.'||proposed==='..')?'attachment':proposed,target=path.join(this.root,workspace(scope).id,randomUUID(),label);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await writeFile(target,f.bytes,{flag:'wx',mode:0o600});out.push({path:target,fsPath:target,filePath:target,label,name:label,size:f.bytes.length,type:f.type||mime(label),lastModified:f.lastModified||Date.now()});}return {files:out};
 }
 async createTemporary(scope,{bytes,fileName}){const b=Buffer.from(bytes),file=(await this.upload(scope,[{name:fileName||'attachment',contentsBase64:b.toString('base64'),size:b.length}])).files[0].path;this.temporary.set(file,scope);return {path:file};}
 async retainQueuedInput(scope,input){for(const item of input){if(!['localImage','localAudio','mention'].includes(item.type))continue;const target=await this.resolve(scope,item.path),root=await realpath(path.join(this.root,scope)).catch(()=>path.join(this.root,scope));if(!inside(target,root))continue;this.db?.prepare('INSERT OR IGNORE INTO retained_queue_files VALUES(?,?)').run(scope,target);this.retained.add(target);}}
 async releaseTemporary(scope,value){if(this.temporary.get(value)!==scope)return;const target=await this.resolve(scope,value);if(this.retained.has(target)||this.db?.prepare('SELECT 1 FROM retained_queue_files WHERE workspace=? AND path=?').get(scope,target))return;await unlink(target);this.temporary.delete(value);await rmdir(path.dirname(target)).catch(e=>{if(e.code!=='ENOTEMPTY')throw e;});}
 async write(scope,p){this.writable(scope);if(p.hostId&&p.hostId!=='local')throw fail(403,'文件宿主不属于当前工作区');const bytes=Buffer.from(p.bytes);if(bytes.length>MAX)return {outcome:'too-large',maxBytes:MAX};const target=await this.resolve(scope,p.path,{create:true});
  return this.boundary.serial('file:'+target,async()=>{let current='missing';try{current=etag(await stat(target));}catch(e){if(e.code!=='ENOENT')throw e;}if(p.ifMatch!=null&&p.ifMatch!==current)return {outcome:'conflict',etag:current};const f=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW,0o600);try{await f.truncate();await f.writeFile(bytes);return {outcome:'saved',etag:etag(await f.stat())};}finally{await f.close();}});
 }
 async entries(scope,p){if(p.hostId&&p.hostId!=='local')throw fail(403,'宿主不属于当前工作区');const root=await this.resolve(scope,p.workspaceRoot||workspace(scope).root),target=await this.resolve(scope,path.resolve(root,p.directoryPath||''));if(!inside(target,root))throw fail(403,'目录超出项目范围');const entries=[];for(const e of await readdir(target,{withFileTypes:true})){if(!p.includeHidden&&e.name.startsWith('.'))continue;const value=path.join(target,e.name);let actual;try{actual=await this.resolve(scope,value);if(!inside(actual,root))continue;}catch{continue;}const type=(e.isSymbolicLink()?await stat(actual):e).isDirectory()?'directory':'file';if(p.directoriesOnly&&type!=='directory')continue;entries.push({isSymlink:e.isSymbolicLink(),name:e.name,path:path.relative(root,value).split(path.sep).join('/'),type});}entries.sort((a,b)=>a.type===b.type?a.name.localeCompare(b.name):a.type==='directory'?-1:1);const directoryPath=path.relative(root,target).split(path.sep).join('/');return {workspaceRoot:root,directoryPath,parentPath:directoryPath?directoryPath.split('/').slice(0,-1).join('/'):null,entries};}
 async version(scope,value){const target=await this.resolve(scope,value),s=await stat(target);return {path:target,etag:etag(s),size:s.size,isFile:s.isFile()};}
 async metadata(scope,p){if(p.hostId&&p.hostId!=='local')throw fail(403,'宿主不属于当前工作区');const target=await this.resolve(scope,p.path),s=await stat(target);let contentKind='binary';const type=mime(target);if(type.startsWith('image/'))contentKind='image';else if(type==='application/pdf')contentKind='pdf';else if(s.isFile()&&(type.startsWith('text/')||type==='application/json'))contentKind='text';else if(s.isFile()&&s.size<=MAX){const f=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);try{const sample=Buffer.alloc(Math.min(8192,s.size)),{bytesRead}=await f.read(sample,0,sample.length,0);try{const text=new TextDecoder('utf-8',{fatal:true}).decode(sample.subarray(0,bytesRead),{stream:true});if(!text.includes('\0'))contentKind='text';}catch{}}finally{await f.close();}}return {isFile:s.isFile(),isDirectory:s.isDirectory(),sizeBytes:s.size,mtimeMs:s.mtimeMs,createdAtMs:s.birthtimeMs,contentKind};}
 async count(scope,value){const target=await this.resolve(scope,value);let count=0,dirs=[target];while(dirs.length){const dir=dirs.pop();for(const e of await readdir(dir,{withFileTypes:true})){if(e.isFile())count++;else if(e.isDirectory()&&!['.git','node_modules'].includes(e.name))dirs.push(path.join(dir,e.name));if(count>=1000)return 1000;if(dirs.length>1000)throw fail(413,'目录过大，请选择更小的目录');}}return count;}
}

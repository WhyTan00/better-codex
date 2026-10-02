import path from 'node:path';
import {mkdir,open,readFile,writeFile,rename,unlink,stat,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {fileEtag,fileMime} from './official-files.mjs';
import {fail,workspace,SCOPES} from './registry.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const MAX_FILE=256*1024*1024,MAX_CACHE=4*1024*1024*1024,MAX_FILES=64;
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

// Read link destinations, including angle-bracket paths and balanced parentheses.
// Text in code fences is not an attachment declaration.
export function finalFilePaths(items,cwd){
 const paths=new Set(),add=value=>{if(typeof value!=='string'||value.length>8192)return;let p=value.trim();
  try{p=decodeURIComponent(p);}catch{return;}
  p=p.replace(/\\([()\[\] ])/g,'$1').replace(/#L\d+(?:C\d+)?(?:-L?\d+)?$/,'').replace(/:\d+(?::\d+)?$/,'');
  if(!p||p.includes('\0')||/^[a-z][a-z\d+.-]*:/i.test(p)||p.startsWith('//'))return;
  if(p.startsWith('#')||p.includes('?'))return;
  paths.add(path.resolve(cwd,p));
 };
 for(const wrapped of items||[]){const item=wrapped?.item||wrapped;
  if(item?.type==='imageView')add(item.path);
  if(item?.type!=='agentMessage'||item.phase!=='final_answer'||typeof item.text!=='string')continue;
  const text=item.text.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm,'');
  for(let start=0;(start=text.indexOf('](',start))>=0;){let i=start+2;while(/\s/.test(text[i]||'')&&i<text.length)i++;
   const angle=text[i]==='<';if(angle)i++;let value='',depth=0,escaped=false,closed=false;
   for(;i<text.length;i++){const c=text[i];if(c==='\n'||c==='\r')break;if(escaped){value+='\\'+c;escaped=false;continue;}if(c==='\\'){escaped=true;continue;}
    if(angle&&c==='>'){closed=true;break;}
    if(!angle){if(c==='(')depth++;else if(c===')'){if(!depth){closed=true;break;}depth--;}else if(/\s/.test(c)&&!depth){closed=true;break;}}
    value+=c;
   }
   if(closed)add(value);start=Math.max(start+2,i+1);
  }
  // Reference-style Markdown links.
  for(const match of text.matchAll(/^\s*\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm))add(match[1]||match[2]);
 }
 return [...paths];
}

/** Immutable, scoped file copies derived only from a verified native turn. */
export class Deliverables {
 constructor({root,files,read,check,fileUrl}){this.root=root;this.files=files;this.read=read;this.check=check;this.fileUrl=fileUrl;this.pending=new Map();this.budget=null;}
 async object(scope,target){
  const version=await this.files.version(scope,target);if(!version.isFile)throw fail(400,'此链接指向目录');
  if(version.size>MAX_FILE)throw fail(413,'文件超过256 MB预载上限');
  const id=sha(scope+'\0'+version.path+'\0'+version.etag),key=scope+':'+id;
  if(this.pending.has(key))return this.pending.get(key);
  const work=this.snapshot(scope,id,version);this.pending.set(key,work);
  try{return await work;}finally{if(this.pending.get(key)===work)this.pending.delete(key);}
 }
 async snapshot(scope,id,source){
  const dir=path.join(this.root,workspace(scope).id),data=path.join(dir,id+'.bin'),metadata=path.join(dir,id+'.json');
  await mkdir(dir,{recursive:true,mode:0o700});
  try{const old=JSON.parse(await readFile(metadata,'utf8')),info=await stat(data);
   if(old.id===id&&old.scope===scope&&old.path===source.path&&old.sourceVersion===source.etag&&old.size===info.size){old.accessedAt=Date.now();await writeFile(metadata,JSON.stringify(old),{mode:0o600});return {...old,internalPath:data};}
  }catch{}
  await this.reserve(source.size);
  const temporary=data+'.'+randomUUID()+'.part';let input,output,length=0;const hash=createHash('sha256');
  try{
   input=await open(source.path,constants.O_RDONLY|constants.O_NOFOLLOW);const before=await input.stat();
   if(!before.isFile()||fileEtag(before)!==source.etag)throw fail(409,'文件正在更新，稍后准备');
   output=await open(temporary,'wx',0o600);
   for await(const chunk of input.createReadStream({autoClose:false})){length+=chunk.length;if(length>MAX_FILE||length>source.size)throw fail(409,'文件在准备中发生变化');hash.update(chunk);await output.writeFile(chunk);}
   if(length!==source.size||fileEtag(await input.stat())!==source.etag)throw fail(409,'文件在准备中发生变化');
   await output.sync();await output.close();output=null;
   const contentHash=hash.digest('hex'),mime=fileMime(source.path);
   const entry={id,scope,path:source.path,name:path.basename(source.path),sourceVersion:source.etag,version:'sha256:'+contentHash,sha256:contentHash,size:length,mime,
    contentKind:mime.startsWith('image/')?'image':mime==='application/pdf'?'pdf':/^(text\/|application\/json)/.test(mime)?'text':'binary',mtimeMs:before.mtimeMs,createdAtMs:before.birthtimeMs,accessedAt:Date.now()};
   await rename(temporary,data);await writeFile(metadata,JSON.stringify(entry),{mode:0o600});
   return {...entry,internalPath:data};
  }finally{await input?.close();await output?.close();await unlink(temporary).catch(()=>{});this.reserved=Math.max(0,(this.reserved||0)-source.size);}
 }
 async reserve(bytes){
  // Serialize cache accounting only, not file copying; never touch project originals.
  const prior=this.budget||Promise.resolve();let release;this.budget=new Promise(r=>{release=r;});await prior;
  try{let used=this.reserved||0;const old=[];
   for(const scope of SCOPES){const dir=path.join(this.root,scope);for(const name of await readdir(dir).catch(()=>[])){
    if(!/^[a-f0-9]{64}\.(?:bin|[a-f0-9-]+\.part)$/.test(name))continue;
    try{const file=path.join(dir,name),info=await stat(file);used+=info.size;let accessed=info.mtimeMs;
     const metadata=path.join(dir,name.slice(0,64)+'.json');try{accessed=JSON.parse(await readFile(metadata,'utf8')).accessedAt||accessed;}catch{}
     old.push({file,metadata,size:info.size,accessed,partial:name.endsWith('.part')});}catch{}
   }}
   old.sort((a,b)=>a.accessed-b.accessed);
   for(const entry of old){if(used+bytes<=MAX_CACHE)break;if(entry.accessed>Date.now()-(entry.partial?24*3600_000:11*60_000))continue;
    try{await unlink(entry.file);used-=entry.size;if(!entry.partial)await unlink(entry.metadata).catch(()=>{});}catch{}
   }
   if(used+bytes>MAX_CACHE)throw fail(507,'交付物缓存空间不足');this.reserved=(this.reserved||0)+bytes;
  }finally{release();}
 }
 async prepare(scope,{threadId,turnId}){
  if(!uuid(threadId)||!uuid(turnId))throw fail(400,'交付物会话或轮次标识无效');
  await this.check(scope,threadId);
  const head=await this.read(scope,'thread/read',{threadId,includeTurns:false});
  const thread=head?.payload?.result?.thread;if(thread?.id!==threadId||head.scope!==scope)throw fail(403,'交付物会话归属不匹配');
  let items,bodyRecord;
  if(thread.historyMode==='legacy'){
   const record=await this.read(scope,'thread/turns/list',{threadId,limit:20,sortDirection:'desc',itemsView:'full'});
   bodyRecord=record;items=record?.payload?.result?.data?.find(t=>t.id===turnId)?.items;
  }else{
   const record=await this.read(scope,'thread/items/list',{threadId,turnId,limit:100,sortDirection:'desc'});
   if(record?.scope!==scope||record?.threadId!==threadId||record?.payload?.params?.turnId!==turnId)throw fail(403,'交付物正文归属不匹配');
   bodyRecord=record;items=record?.payload?.result?.data;
  }
  if(bodyRecord?.scope!==scope||bodyRecord?.threadId!==threadId||bodyRecord?.sourceGeneration!==head.sourceGeneration)throw fail(409,'交付物正文版本正在更新');
  if(!Array.isArray(items)||!items.some(w=>{const i=w?.item||w;return i?.type==='agentMessage'&&i.phase==='final_answer';}))throw fail(409,'目标回复正文尚未准备好');
  const paths=finalFilePaths(items,thread.cwd||workspace(scope).root),entries=[];
  // Bounded sequential copies keep mobile-sized document batches from spiking host I/O.
  for(const [index,target] of paths.entries()){try{
   if(index>=MAX_FILES)throw fail(413,'单次交付物数量超过预载上限');
   const object=await this.object(scope,target),{internalPath,...entry}=object;
   entries.push({...entry,url:await this.fileUrl(scope,object),state:'available'});
  }catch(error){entries.push({path:target,name:path.basename(target),state:'unavailable',status:Number.isInteger(error.code)?error.code:404,reason:Number(error.code)===413?'文件超过预载上限':Number(error.code)===507?'缓存空间不足':'文件暂不可准备'});}}
  return {scope,threadId,turnId,sourceGeneration:head.sourceGeneration,manifestVersion:sha(JSON.stringify(entries.map(e=>[e.path,e.version,e.status]))),entries};
 }
 resolve(scope,entry){
  if(entry.scope!==scope||!entry.artifact||!path.isAbsolute(entry.target))throw fail(403,'交付物归属不匹配');
  const expected=path.join(this.root,workspace(scope).id,path.basename(entry.target));
  if(expected!==entry.target||!/^[a-f0-9]{64}\.bin$/.test(path.basename(expected)))throw fail(403,'交付物路径不匹配');return expected;
 }
}

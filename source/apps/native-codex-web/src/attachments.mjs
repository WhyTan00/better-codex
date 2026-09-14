import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fail} from './registry.mjs';
export class Attachments {
 constructor(root){this.root=root;}
 async add(ws,threadId,{name,mime,data}){if(typeof name!=='string'||name.length>180||typeof data!=='string'||data.length>8*1024*1024)throw fail(400,'附件过大或名称无效');
  if(!['text/plain','text/markdown','image/png','image/jpeg','image/webp'].includes(mime))throw fail(400,'支持 TXT、Markdown、PNG、JPEG、WebP，最多 6 MB');
  const bytes=Buffer.from(data,'base64');if(bytes.length>6*1024*1024)throw fail(413,'附件最多 6 MB');const id=randomUUID(),dir=path.join(this.root,ws.id);await mkdir(dir,{recursive:true,mode:0o700});
  const record={id,threadId,name:path.basename(name),mime,size:bytes.length};await writeFile(path.join(dir,id),bytes,{mode:0o600});await writeFile(path.join(dir,id+'.json'),JSON.stringify(record),{mode:0o600});return record;}
 async read(ws,threadId,id){if(!/^[0-9a-f-]{36}$/i.test(id))throw fail(404,'附件不存在');let record;try{record=JSON.parse(await readFile(path.join(this.root,ws.id,id+'.json'),'utf8'));}catch{throw fail(404,'附件不存在');}if(record.threadId!==threadId)throw fail(404,'附件不属于此会话');return record;}
 async resolve(ws,threadId,ids){if(!Array.isArray(ids)||ids.length>5)throw fail(400,'每条消息最多 5 个附件');const result=[];for(const id of ids){const r=await this.read(ws,threadId,id);const file=path.join(this.root,ws.id,id);if(r.mime.startsWith('image/'))result.push({type:'localImage',path:file});else {const buf=await readFile(file);if(buf.length>100000)throw fail(413,'文本附件最多 100 KB');result.push({type:'text',text:`附件 ${r.name}：\n${buf.toString('utf8')}`});}}return result;}
}

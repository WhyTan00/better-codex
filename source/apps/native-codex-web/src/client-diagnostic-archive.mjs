import{mkdir,open,rename,stat}from'node:fs/promises';
import path from'node:path';
// The query ring is a display projection. A delivery receipt is issued only
// after the sanitized metadata is written and synced in the protected archive.
export class ClientDiagnosticArchive{
 constructor(root,{maxBytes=1024*1024,maxArchives=31}={}){this.root=root;this.maxBytes=maxBytes;this.maxArchives=maxArchives;this.chain=Promise.resolve();}
 append(scope,entries){
  if(!['ai','zyy'].includes(scope))return Promise.reject(Error('invalid diagnostic scope'));
  const work=this.chain.catch(()=>{}).then(async()=>{
   const rows=entries.filter(e=>e.phase==='client_diagnostic');if(!rows.length)return[];
   await mkdir(this.root,{recursive:true,mode:0o700});const file=path.join(this.root,scope+'.jsonl'),raw=rows.map(e=>JSON.stringify({...e,scope,receivedAt:new Date().toISOString()})+'\n').join('');
   const size=await stat(file).then(s=>s.size,error=>{if(error.code==='ENOENT')return 0;throw error;});
   if(size+Buffer.byteLength(raw)>this.maxBytes&&size){
    for(let i=this.maxArchives;i>=1;i--)await rename(i===1?file:file+'.'+(i-1),file+'.'+i).catch(error=>{if(error.code!=='ENOENT')throw error;});
   }
   const handle=await open(file,'a',0o600);try{await handle.writeFile(raw);await handle.sync();}finally{await handle.close();}
   return [...new Set(rows.map(e=>e.eventId).filter(id=>typeof id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)))];
  });this.chain=work;return work;
 }
}
